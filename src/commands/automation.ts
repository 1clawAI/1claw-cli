import { readFileSync } from "node:fs";
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

interface Automation {
    id: string;
    org_id: string;
    agent_id: string;
    name: string;
    trigger_type: string;
    cron_expr: string | null;
    timezone: string;
    event_filter: Record<string, unknown> | null;
    workflow_spec: Record<string, unknown>;
    is_active: boolean;
    last_run_at: string | null;
    next_run_at: string | null;
    created_at: string;
}

interface AutomationRun {
    id: string;
    automation_id: string;
    agent_id: string;
    status: string;
    trigger_source: string;
    step_results: unknown;
    error: string | null;
    tokens_used: number;
    cost_cents: number;
    started_at: string;
    finished_at: string | null;
}

export const automationCommand = new Command("automation")
    .alias("auto")
    .description("Manage automations");

automationCommand
    .command("list")
    .alias("ls")
    .description("List all automations in your org")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ automations: Automation[] }>("/automations");
            const items = res.automations ?? [];

            if (opts.json) {
                printJson(items);
                return;
            }

            if (items.length === 0) {
                console.log(chalk.dim("No automations found."));
                return;
            }

            printTable(
                items.map((a) => ({
                    id: a.id,
                    name: a.name,
                    trigger: a.trigger_type,
                    cron: a.cron_expr ?? chalk.dim("—"),
                    active: a.is_active ? chalk.green("✓") : chalk.red("✗"),
                    agent: a.agent_id.slice(0, 8) + "…",
                    last_run: a.last_run_at ? formatDate(a.last_run_at) : chalk.dim("never"),
                    next_run: a.next_run_at ? formatDate(a.next_run_at) : chalk.dim("—"),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 24 },
                    { key: "trigger", header: "Trigger", width: 10 },
                    { key: "cron", header: "Cron", width: 16 },
                    { key: "active", header: "Active", width: 8 },
                    { key: "agent", header: "Agent", width: 12 },
                    { key: "last_run", header: "Last Run" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("get <automation-id>")
    .description("Get automation details")
    .option("--json", "Output as JSON")
    .action(async (automationId, opts) => {
        try {
            requireToken();
            const a = await api<Automation>(`/automations/${automationId}`);

            if (opts.json) {
                printJson(a);
                return;
            }

            printKeyValue([
                ["ID", a.id],
                ["Name", a.name],
                ["Trigger Type", a.trigger_type],
                ["Cron", a.cron_expr ?? "—"],
                ["Timezone", a.timezone],
                ["Active", a.is_active ? chalk.green("Yes") : chalk.red("No")],
                ["Agent ID", a.agent_id],
                ["Last Run", a.last_run_at ? formatDate(a.last_run_at) : "Never"],
                ["Next Run", a.next_run_at ? formatDate(a.next_run_at) : "—"],
                ["Created", formatDate(a.created_at)],
            ]);

            if (a.workflow_spec) {
                console.log(chalk.bold("\nWorkflow Spec:"));
                console.log(JSON.stringify(a.workflow_spec, null, 2));
            }
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("create <name>")
    .description("Create a new automation")
    .requiredOption("--agent-id <id>", "Agent ID to run the automation")
    .requiredOption("--trigger <type>", "Trigger type: cron, event, or webhook")
    .option("--cron <expr>", "Cron expression (required for cron trigger)")
    .option("--timezone <tz>", "IANA timezone", "UTC")
    .option("--event-filter <json>", "Event filter JSON (for event trigger)")
    .option("--workflow <json-or-file>", "Workflow spec JSON or @file path", "[]")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
        try {
            requireToken();

            let workflowSpec: unknown;
            if (opts.workflow.startsWith("@")) {
                const content = readFileSync(opts.workflow.slice(1), "utf8");
                workflowSpec = JSON.parse(content);
            } else {
                workflowSpec = JSON.parse(opts.workflow);
            }

            let eventFilter: unknown = undefined;
            if (opts.eventFilter) {
                eventFilter = JSON.parse(opts.eventFilter);
            }

            const body: Record<string, unknown> = {
                name,
                agent_id: opts.agentId,
                trigger_type: opts.trigger,
                timezone: opts.timezone,
                workflow_spec: workflowSpec,
            };
            if (opts.cron) body.cron_expr = opts.cron;
            if (eventFilter) body.event_filter = eventFilter;

            const a = await api<Automation>("/automations", {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(a);
                return;
            }

            printSuccess(`Automation created: ${chalk.bold(a.name)} (${a.id})`);
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("update <automation-id>")
    .description("Update an automation")
    .option("--name <name>", "New name")
    .option("--cron <expr>", "New cron expression")
    .option("--timezone <tz>", "New timezone")
    .option("--workflow <json-or-file>", "New workflow spec JSON or @file path")
    .option("--active <bool>", "Enable or disable")
    .option("--json", "Output as JSON")
    .action(async (automationId, opts) => {
        try {
            requireToken();

            const body: Record<string, unknown> = {};
            if (opts.name) body.name = opts.name;
            if (opts.cron) body.cron_expr = opts.cron;
            if (opts.timezone) body.timezone = opts.timezone;
            if (opts.active !== undefined) body.is_active = opts.active === "true";

            if (opts.workflow) {
                if (opts.workflow.startsWith("@")) {
                    body.workflow_spec = JSON.parse(readFileSync(opts.workflow.slice(1), "utf8"));
                } else {
                    body.workflow_spec = JSON.parse(opts.workflow);
                }
            }

            const a = await api<Automation>(`/automations/${automationId}`, {
                method: "PATCH",
                body,
            });

            if (opts.json) {
                printJson(a);
                return;
            }

            printSuccess(`Automation updated: ${chalk.bold(a.name)}`);
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("delete <automation-id>")
    .description("Delete an automation")
    .action(async (automationId) => {
        try {
            requireToken();
            await api(`/automations/${automationId}`, { method: "DELETE" });
            printSuccess("Automation deleted.");
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("trigger <automation-id>")
    .description("Manually trigger an automation run")
    .option("--json", "Output as JSON")
    .action(async (automationId, opts) => {
        try {
            requireToken();
            const run = await api<AutomationRun>(`/automations/${automationId}/trigger`, {
                method: "POST",
            });

            if (opts.json) {
                printJson(run);
                return;
            }

            printSuccess(`Run started: ${run.id} (status: ${run.status})`);
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("rotate-webhook <automation-id>")
    .description("Rotate the webhook token for a webhook-triggered automation")
    .option("--json", "Output as JSON")
    .action(async (automationId, opts) => {
        try {
            requireToken();
            const res = await api<{ webhook_url: string; webhook_token: string }>(
                `/automations/${automationId}/rotate-webhook-token`,
                { method: "POST" },
            );

            if (opts.json) {
                printJson(res);
                return;
            }

            printSuccess("Webhook token rotated.");
            printKeyValue([
                ["Webhook URL", res.webhook_url],
                ["Webhook token", res.webhook_token],
            ]);
            console.log(chalk.yellow("Store the token now — it is shown only once."));
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("runs <automation-id>")
    .description("List runs for an automation")
    .option("--limit <n>", "Max results", "20")
    .option("--json", "Output as JSON")
    .action(async (automationId, opts) => {
        try {
            requireToken();
            const res = await api<{ runs: AutomationRun[] }>(
                `/automations/${automationId}/runs`,
                { query: { limit: parseInt(opts.limit, 10) } },
            );
            const runs = res.runs ?? [];

            if (opts.json) {
                printJson(runs);
                return;
            }

            if (runs.length === 0) {
                console.log(chalk.dim("No runs found."));
                return;
            }

            printTable(
                runs.map((r) => ({
                    id: r.id,
                    status: r.status === "success"
                        ? chalk.green(r.status)
                        : r.status === "failed"
                            ? chalk.red(r.status)
                            : chalk.yellow(r.status),
                    trigger: r.trigger_source,
                    tokens: r.tokens_used,
                    cost: `${(r.cost_cents / 100).toFixed(2)}`,
                    started: formatDate(r.started_at),
                    finished: r.finished_at ? formatDate(r.finished_at) : chalk.dim("—"),
                })),
                [
                    { key: "id", header: "Run ID", width: 36 },
                    { key: "status", header: "Status", width: 10 },
                    { key: "trigger", header: "Trigger", width: 12 },
                    { key: "tokens", header: "Tokens", width: 8 },
                    { key: "cost", header: "Cost ($)", width: 10 },
                    { key: "started", header: "Started" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("cancel-run <automation-id> <run-id>")
    .description("Cancel a running or awaiting_approval automation run")
    .option("--json", "Output as JSON")
    .action(async (automationId, runId, opts) => {
        try {
            requireToken();
            const run = await api<AutomationRun>(
                `/automations/${automationId}/runs/${runId}/cancel`,
                { method: "POST" },
            );

            if (opts.json) {
                printJson(run);
                return;
            }

            printSuccess(`Run cancelled: ${run.id} (status: ${run.status})`);
        } catch (err) {
            handleError(err);
        }
    });

automationCommand
    .command("presets")
    .description("List available automation presets")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            const res = await api<{ presets: Array<{ id: string; name: string; description?: string; trigger_type: string }> }>(
                "/automations/presets",
            );
            const presets = res.presets ?? [];

            if (opts.json) {
                printJson(presets);
                return;
            }

            if (presets.length === 0) {
                console.log(chalk.dim("No presets available."));
                return;
            }

            printTable(
                presets.map((p) => ({
                    id: p.id,
                    name: p.name,
                    trigger: p.trigger_type,
                    description: p.description ?? chalk.dim("—"),
                })),
                [
                    { key: "id", header: "ID", width: 28 },
                    { key: "name", header: "Name", width: 28 },
                    { key: "trigger", header: "Trigger", width: 10 },
                    { key: "description", header: "Description" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });
