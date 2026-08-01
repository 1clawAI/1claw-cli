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

interface Runtime {
    id: string;
    org_id: string;
    agent_id: string;
    name: string;
    template: string;
    preset: string;
    provider: string;
    status: string;
    image: string | null;
    env_public: Record<string, string> | null;
    idle_timeout_secs: number;
    monthly_hours_used: number;
    egress_bytes_month: number;
    last_activity_at: string | null;
    created_at: string;
}

const VALID_PRESETS = ["micro", "small", "medium", "large", "xlarge", "xxlarge", "cc_small", "cc_medium", "cc_large"];

export const runtimeCommand = new Command("runtime")
    .alias("rt")
    .description("Manage agent runtimes");

runtimeCommand
    .command("list")
    .alias("ls")
    .description("List all runtimes in your org")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ runtimes: Runtime[] }>("/runtimes");
            const items = res.runtimes ?? [];

            if (opts.json) {
                printJson(items);
                return;
            }

            if (items.length === 0) {
                console.log(chalk.dim("No runtimes found."));
                return;
            }

            printTable(
                items.map((r) => ({
                    id: r.id,
                    name: r.name,
                    preset: r.preset,
                    status: statusColor(r.status),
                    agent: r.agent_id.slice(0, 8) + "…",
                    hours: `${r.monthly_hours_used.toFixed(1)}h`,
                    created: formatDate(r.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 24 },
                    { key: "preset", header: "Preset", width: 12 },
                    { key: "status", header: "Status", width: 12 },
                    { key: "agent", header: "Agent", width: 12 },
                    { key: "hours", header: "Hours", width: 10 },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("get <runtime-id>")
    .description("Get runtime details")
    .option("--json", "Output as JSON")
    .action(async (runtimeId, opts) => {
        try {
            requireToken();
            const r = await api<Runtime>(`/runtimes/${runtimeId}`);

            if (opts.json) {
                printJson(r);
                return;
            }

            printKeyValue([
                ["ID", r.id],
                ["Name", r.name],
                ["Template", r.template],
                ["Preset", r.preset],
                ["Provider", r.provider],
                ["Status", statusColor(r.status)],
                ["Agent ID", r.agent_id],
                ["Image", r.image ?? "—"],
                ["Idle Timeout", `${r.idle_timeout_secs}s`],
                ["Monthly Hours", `${r.monthly_hours_used.toFixed(1)}h`],
                ["Egress (bytes)", r.egress_bytes_month.toString()],
                ["Last Activity", r.last_activity_at ? formatDate(r.last_activity_at) : "—"],
                ["Created", formatDate(r.created_at)],
            ]);

            if (r.env_public && Object.keys(r.env_public).length > 0) {
                console.log(chalk.bold("\nEnvironment:"));
                for (const [k, v] of Object.entries(r.env_public)) {
                    console.log(`  ${chalk.cyan(k)}=${v}`);
                }
            }
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("create <name>")
    .description("Create a new runtime")
    .requiredOption("--agent-id <id>", "Agent ID")
    .option("--template <tpl>", "Runtime template", "base")
    .option("--preset <preset>", `Preset: ${VALID_PRESETS.join(", ")}`, "small")
    .option("--image <image>", "Custom Docker image")
    .option("--idle-timeout <secs>", "Idle timeout in seconds", "1800")
    .option("--env <key=value...>", "Environment variables (repeatable)")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
        try {
            requireToken();

            let envPublic: Record<string, string> | undefined;
            if (opts.env) {
                envPublic = {};
                const envArgs = Array.isArray(opts.env) ? opts.env : [opts.env];
                for (const pair of envArgs) {
                    const idx = pair.indexOf("=");
                    if (idx > 0) {
                        envPublic[pair.slice(0, idx)] = pair.slice(idx + 1);
                    }
                }
            }

            const body: Record<string, unknown> = {
                name,
                agent_id: opts.agentId,
                template: opts.template,
                preset: opts.preset,
                idle_timeout_secs: parseInt(opts.idleTimeout, 10),
            };
            if (opts.image) body.image = opts.image;
            if (envPublic) body.env_public = envPublic;

            const r = await api<Runtime>("/runtimes", {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(r);
                return;
            }

            printSuccess(`Runtime created: ${chalk.bold(r.name)} (${r.id}) — ${statusColor(r.status)}`);
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("update <runtime-id>")
    .description("Update a runtime")
    .option("--name <name>", "New name")
    .option("--preset <preset>", "New preset")
    .option("--idle-timeout <secs>", "New idle timeout")
    .option("--json", "Output as JSON")
    .action(async (runtimeId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.name) body.name = opts.name;
            if (opts.preset) body.preset = opts.preset;
            if (opts.idleTimeout) body.idle_timeout_secs = parseInt(opts.idleTimeout, 10);

            const r = await api<Runtime>(`/runtimes/${runtimeId}`, {
                method: "PATCH",
                body,
            });

            if (opts.json) {
                printJson(r);
                return;
            }

            printSuccess(`Runtime updated: ${chalk.bold(r.name)}`);
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("start <runtime-id>")
    .description("Start a runtime")
    .action(async (runtimeId) => {
        try {
            requireToken();
            const r = await api<Runtime>(`/runtimes/${runtimeId}/start`, { method: "POST" });
            printSuccess(`Runtime starting: ${chalk.bold(r.name)} — ${statusColor(r.status)}`);
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("stop <runtime-id>")
    .description("Stop a runtime")
    .action(async (runtimeId) => {
        try {
            requireToken();
            const r = await api<Runtime>(`/runtimes/${runtimeId}/stop`, { method: "POST" });
            printSuccess(`Runtime stopping: ${chalk.bold(r.name)} — ${statusColor(r.status)}`);
        } catch (err) {
            handleError(err);
        }
    });

runtimeCommand
    .command("delete <runtime-id>")
    .alias("rm")
    .description("Delete a runtime")
    .action(async (runtimeId) => {
        try {
            requireToken();
            await api(`/runtimes/${runtimeId}`, { method: "DELETE" });
            printSuccess("Runtime deleted.");
        } catch (err) {
            handleError(err);
        }
    });

function statusColor(status: string): string {
    switch (status) {
        case "running":
            return chalk.green(status);
        case "starting":
        case "stopping":
            return chalk.yellow(status);
        case "stopped":
        case "created":
            return chalk.dim(status);
        case "error":
            return chalk.red(status);
        default:
            return status;
    }
}
