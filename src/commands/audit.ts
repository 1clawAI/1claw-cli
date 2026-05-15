import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, formatDate } from "../output.js";

interface AuditEntry {
    id: string;
    action: string;
    resource_type: string;
    resource_id: string;
    actor_type: string;
    actor_id: string;
    ip_address?: string;
    details?: string;
    created_at: string;
}

export const auditCommand = new Command("audit").description("View audit logs");

auditCommand
    .command("list")
    .alias("ls")
    .description("List recent audit log entries")
    .option("-v, --vault <id>", "Filter by vault ID")
    .option("--action <action>", "Filter by action (e.g. secret.read)")
    .option("--limit <n>", "Number of entries", "25")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const query: Record<string, string | number> = {
                limit: opts.limit,
            };
            if (opts.vault) query.resource_id = opts.vault;
            if (opts.action) query.action = opts.action;

            const res = await api<{ events: AuditEntry[] }>("/audit/events", {
                query,
            });
            const entries = res.events ?? [];

            if (opts.json) {
                printJson(entries);
                return;
            }

            printTable(
                entries.map((e) => ({
                    ...e,
                    time: formatDate(e.created_at, "long"),
                    actor: `${e.actor_type}:${e.actor_id.slice(0, 8)}…`,
                    resource: `${e.resource_type}:${e.resource_id.slice(0, 8)}…`,
                    action: colorAction(e.action),
                })),
                [
                    { key: "time", header: "Time", width: 22 },
                    { key: "action", header: "Action", width: 22 },
                    { key: "actor", header: "Actor", width: 18 },
                    { key: "resource", header: "Resource", width: 18 },
                    { key: "ip_address", header: "IP" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

function colorAction(action: string): string {
    if (action.includes("delete")) return chalk.red(action);
    if (action.includes("create") || action.includes("write"))
        return chalk.green(action);
    if (action.includes("read")) return chalk.blue(action);
    return action;
}
