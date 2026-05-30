import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printInfo,
    printJson,
    formatDate,
} from "../output.js";

interface Webhook {
    id: string;
    url: string;
    events: string[];
    is_active: boolean;
    secret_configured: boolean;
    created_at: string;
    updated_at: string;
}

export const webhookCommand = new Command("webhook").description(
    "Manage event webhooks",
);

webhookCommand
    .command("create")
    .description("Register a new webhook")
    .requiredOption("--url <url>", "Webhook delivery URL")
    .requiredOption("--events <events>", "Comma-separated event names")
    .option("--secret <secret>", "HMAC secret for signature verification")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                url: opts.url,
                events: opts.events.split(",").map((e: string) => e.trim()),
            };
            if (opts.secret) body.secret = opts.secret;
            const result = await api<Webhook>("/webhooks", {
                method: "POST",
                body,
            });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(`Webhook created: ${result.id}`);
            printKeyValue([
                ["ID", result.id],
                ["URL", result.url],
                ["Events", result.events.join(", ")],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

webhookCommand
    .command("list")
    .alias("ls")
    .description("List all webhooks for this org")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const result = await api<{ webhooks: Webhook[] }>("/webhooks");
            if (opts.json) {
                printJson(result);
                return;
            }
            if (result.webhooks.length === 0) {
                printInfo("No webhooks configured.");
                return;
            }
            printTable(
                result.webhooks.map((w) => ({
                    id: w.id.slice(0, 8) + "…",
                    url: w.url,
                    events: w.events.join(", "),
                    active: w.is_active ? chalk.green("Yes") : chalk.red("No"),
                    created: formatDate(w.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 10 },
                    { key: "url", header: "URL", width: 40 },
                    { key: "events", header: "Events", width: 30 },
                    { key: "active", header: "Active" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

webhookCommand
    .command("get <id>")
    .description("Get webhook details")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts) => {
        try {
            requireToken();
            const result = await api<Webhook>(`/webhooks/${id}`);
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([
                ["ID", result.id],
                ["URL", result.url],
                ["Events", result.events.join(", ")],
                ["Active", result.is_active ? "Yes" : "No"],
                ["Secret", result.secret_configured ? "Configured" : "None"],
                ["Created", formatDate(result.created_at)],
                ["Updated", formatDate(result.updated_at)],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

webhookCommand
    .command("update <id>")
    .description("Update a webhook")
    .option("--url <url>", "New delivery URL")
    .option("--events <events>", "New comma-separated event list")
    .option("--active <bool>", "Enable or disable (true/false)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.url) body.url = opts.url;
            if (opts.events) body.events = opts.events.split(",").map((e: string) => e.trim());
            if (opts.active !== undefined) body.is_active = opts.active === "true";
            const result = await api<Webhook>(`/webhooks/${id}`, {
                method: "PATCH",
                body,
            });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Webhook updated");
            printKeyValue([
                ["ID", result.id],
                ["URL", result.url],
                ["Events", result.events.join(", ")],
                ["Active", result.is_active ? "Yes" : "No"],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

webhookCommand
    .command("delete <id>")
    .description("Delete a webhook")
    .action(async (id: string) => {
        try {
            requireToken();
            await api(`/webhooks/${id}`, { method: "DELETE" });
            printSuccess("Webhook deleted");
        } catch (e) {
            handleError(e);
        }
    });
