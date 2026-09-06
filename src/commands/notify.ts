import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printSuccess, printInfo, printJson } from "../output.js";

interface NotificationTarget {
    id: string;
    target_type: string;
    config: Record<string, unknown>;
    events: string[];
    is_active: boolean;
    verified: boolean;
    created_at: string;
}

export const notifyCommand = new Command("notify").description(
    "Manage where approvals reach you — SMS, webhook, email, push",
);

notifyCommand
    .command("list")
    .alias("ls")
    .description("List your notification targets")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const result = await api<{ targets: NotificationTarget[] }>(
                "/notification-targets",
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            if ((result.targets ?? []).length === 0) {
                printInfo("No notification targets. Add one with `1claw notify add`.");
                return;
            }
            printTable(
                result.targets.map((t) => ({
                    id: t.id,
                    type: t.target_type,
                    destination: destinationOf(t),
                    status: statusOf(t),
                    events: t.events.length === 0 ? chalk.dim("all") : t.events.join(", "),
                })),
                [
                    { key: "id", header: "ID", width: 38 },
                    { key: "type", header: "Type", width: 10 },
                    { key: "destination", header: "Destination", width: 30 },
                    { key: "status", header: "Status", width: 22 },
                    { key: "events", header: "Events", width: 24 },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

notifyCommand
    .command("add <type> <destination>")
    .description("Add a target: sms +14155550123 | webhook https://… | email a@b.co")
    .option("--agent <agent-id>", "Agent whose SMS channel sends to this number")
    .option("--events <events>", "Comma-separated event names (default: all)")
    .option("--json", "Output as JSON")
    .action(async (type: string, destination: string, opts) => {
        try {
            requireToken();
            const config: Record<string, string> = {};
            switch (type) {
                case "sms":
                    config.phone_number = destination;
                    break;
                case "webhook":
                    config.url = destination;
                    break;
                case "email":
                    config.email = destination;
                    break;
                case "expo":
                    config.push_token = destination;
                    break;
                default:
                    console.error(
                        chalk.red("Type must be one of: sms, webhook, email, expo"),
                    );
                    process.exit(1);
            }

            const body: Record<string, unknown> = { target_type: type, config };
            if (opts.agent) body.agent_id = opts.agent;
            if (opts.events) {
                body.events = String(opts.events)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }

            const target = await api<NotificationTarget>("/notification-targets", {
                method: "POST",
                body,
            });
            if (opts.json) {
                printJson(target);
                return;
            }
            printSuccess(`Added ${type} target ${target.id}`);
            // Saying "added" and stopping would imply it can already approve
            // things. It cannot until the number is proved.
            if (type === "sms") {
                console.log("");
                printInfo(
                    "It will receive notifications now, but cannot approve anything until verified:",
                );
                console.log(chalk.cyan(`  1claw notify verify ${target.id}`));
            }
        } catch (e) {
            handleError(e);
        }
    });

notifyCommand
    .command("verify <id>")
    .description("Verify an SMS target (texts a code, then asks for it)")
    .option("--code <code>", "Submit a code you already received")
    .action(async (id: string, opts) => {
        try {
            requireToken();
            if (opts.code) {
                await api(`/notification-targets/${id}/verify`, {
                    method: "POST",
                    body: { code: String(opts.code).trim() },
                });
                printSuccess("Verified — this number can now approve tier-1 requests by reply.");
                return;
            }
            const started = await api<{ expires_in_seconds: number }>(
                `/notification-targets/${id}/verify/start`,
                { method: "POST", body: {} },
            );
            printSuccess(
                `Code sent. It expires in ${Math.round((started.expires_in_seconds ?? 600) / 60)} minutes.`,
            );
            console.log("");
            printInfo("Then run:");
            console.log(chalk.cyan(`  1claw notify verify ${id} --code 123456`));
        } catch (e) {
            handleError(e);
        }
    });

notifyCommand
    .command("remove <id>")
    .alias("rm")
    .description("Remove a notification target")
    .action(async (id: string) => {
        try {
            requireToken();
            await api(`/notification-targets/${id}`, { method: "DELETE" });
            printSuccess(`Removed ${id}`);
        } catch (e) {
            handleError(e);
        }
    });

function destinationOf(t: NotificationTarget): string {
    const c = t.config ?? {};
    return String(
        c.phone_number ?? c.url ?? c.email ?? c.push_token ?? chalk.dim("—"),
    );
}

/**
 * Verified and unverified are genuinely different states for SMS, and the
 * difference is what the number is allowed to do.
 */
function statusOf(t: NotificationTarget): string {
    if (!t.is_active) return chalk.dim("inactive");
    if (t.target_type !== "sms") return chalk.green("active");
    return t.verified
        ? chalk.green("verified")
        : chalk.yellow("unverified (cannot approve)");
}
