import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
    formatDate,
} from "../output.js";

interface MemoryEntry {
    id: string;
    agent_id: string;
    namespace: string;
    key: string;
    value: string;
    ttl_expires_at: string | null;
    created_at: string;
    updated_at: string;
}

export const memoryCommand = new Command("memory")
    .alias("mem")
    .description("Manage agent memory");

memoryCommand
    .command("namespaces <agent-id>")
    .description("List memory namespaces for an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const res = await api<{ namespaces: string[] }>(
                `/agents/${agentId}/memory/namespaces`,
            );
            const ns = res.namespaces ?? [];

            if (opts.json) {
                printJson(ns);
                return;
            }

            if (ns.length === 0) {
                console.log(chalk.dim("No namespaces found."));
                return;
            }

            ns.forEach((n) => console.log(`  ${chalk.cyan(n)}`));
        } catch (err) {
            handleError(err);
        }
    });

memoryCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List memory entries for an agent")
    .option("-n, --namespace <ns>", "Filter by namespace", "default")
    .option("--limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const res = await api<{ entries: MemoryEntry[] }>(
                `/agents/${agentId}/memory`,
                { query: { namespace: opts.namespace, limit: parseInt(opts.limit, 10) } },
            );
            const entries = res.entries ?? [];

            if (opts.json) {
                printJson(entries);
                return;
            }

            if (entries.length === 0) {
                console.log(chalk.dim("No entries found."));
                return;
            }

            printTable(
                entries.map((e) => ({
                    namespace: e.namespace,
                    key: e.key,
                    value: e.value.length > 40 ? e.value.slice(0, 40) + "…" : e.value,
                    ttl: e.ttl_expires_at ? formatDate(e.ttl_expires_at) : chalk.dim("—"),
                    updated: formatDate(e.updated_at),
                })),
                [
                    { key: "namespace", header: "Namespace", width: 16 },
                    { key: "key", header: "Key", width: 24 },
                    { key: "value", header: "Value", width: 42 },
                    { key: "ttl", header: "TTL Expires" },
                    { key: "updated", header: "Updated" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

memoryCommand
    .command("get <agent-id> <key>")
    .description("Get a memory entry")
    .option("-n, --namespace <ns>", "Namespace", "default")
    .option("--json", "Output as JSON")
    .action(async (agentId, key, opts) => {
        try {
            requireToken();
            const entry = await api<MemoryEntry>(
                `/agents/${agentId}/memory/${encodeURIComponent(key)}`,
                { query: { namespace: opts.namespace } },
            );

            if (opts.json) {
                printJson(entry);
                return;
            }

            printKeyValue([
                ["Namespace", entry.namespace],
                ["Key", entry.key],
                ["Value", entry.value],
                ["TTL Expires", entry.ttl_expires_at ? formatDate(entry.ttl_expires_at) : "—"],
                ["Created", formatDate(entry.created_at)],
                ["Updated", formatDate(entry.updated_at)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

memoryCommand
    .command("put <agent-id> <key> <value>")
    .description("Store a memory entry")
    .option("-n, --namespace <ns>", "Namespace", "default")
    .option("--ttl <seconds>", "Time-to-live in seconds")
    .option("--json", "Output as JSON")
    .action(async (agentId, key, value, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                namespace: opts.namespace,
                key,
                value,
            };
            if (opts.ttl) body.ttl_seconds = parseInt(opts.ttl, 10);

            const entry = await api<MemoryEntry>(
                `/agents/${agentId}/memory`,
                { method: "PUT", body },
            );

            if (opts.json) {
                printJson(entry);
                return;
            }

            printSuccess(`Memory entry stored: ${chalk.bold(key)} in ${chalk.cyan(entry.namespace)}`);
        } catch (err) {
            handleError(err);
        }
    });

memoryCommand
    .command("delete <agent-id> <key>")
    .alias("rm")
    .description("Delete a memory entry")
    .option("-n, --namespace <ns>", "Namespace", "default")
    .action(async (agentId, key, opts) => {
        try {
            requireToken();
            await api(
                `/agents/${agentId}/memory/${encodeURIComponent(key)}`,
                { method: "DELETE", query: { namespace: opts.namespace } },
            );
            printSuccess(`Memory entry deleted: ${chalk.bold(key)}`);
        } catch (err) {
            handleError(err);
        }
    });

memoryCommand
    .command("delete-namespace <agent-id> <namespace>")
    .alias("rmns")
    .description("Delete all entries in a namespace")
    .action(async (agentId, namespace) => {
        try {
            requireToken();
            const res = await api<{ deleted: number }>(
                `/agents/${agentId}/memory/namespaces/${encodeURIComponent(namespace)}`,
                { method: "DELETE" },
            );
            printSuccess(`Deleted ${res.deleted} entries from namespace ${chalk.cyan(namespace)}`);
        } catch (err) {
            handleError(err);
        }
    });
