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
} from "../output.js";

interface ConnectorPreset {
    slug: string;
    display_name: string;
    description: string;
    category: string;
    provider_slug: string | null;
    oauth_scopes: string[];
    required_scopes: string[];
    base_url: string;
    allowed_hosts: string[];
    documentation_url: string;
    requires_oauth: boolean;
}

interface InstalledConnector {
    binding_id: string;
    binding_name: string;
    preset_slug: string;
    display_name?: string | null;
    is_active: boolean;
    connected: boolean;
    needs_reauth: boolean;
    created_at: string;
}

interface InstallResult {
    binding_id: string;
    binding_name: string;
    preset_slug: string;
    authorization_url?: string | null;
    next_step: string;
}

export const connectorCommand = new Command("connector").description(
    "Install pre-built connectors (Gmail, Slack, GitHub, …) onto an agent",
);

connectorCommand
    .command("presets")
    .alias("catalog")
    .description("List available connectors")
    .option("--category <category>", "Filter by category")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            const result = await api<{ presets: ConnectorPreset[] }>(
                "/connectors/presets",
            );
            let presets = result.presets ?? [];
            if (opts.category) {
                presets = presets.filter((p) => p.category === opts.category);
            }
            if (opts.json) {
                printJson({ presets });
                return;
            }
            if (presets.length === 0) {
                printInfo("No connectors found.");
                return;
            }
            printTable(
                presets.map((p) => ({
                    slug: p.slug,
                    name: p.display_name,
                    category: p.category,
                    auth: p.requires_oauth
                        ? `OAuth (${p.provider_slug})`
                        : chalk.dim("API key"),
                    // The hosts are the part worth seeing before installing:
                    // this is everywhere the agent will be able to reach.
                    reaches: p.allowed_hosts.join(", "),
                })),
                [
                    { key: "slug", header: "Slug", width: 18 },
                    { key: "name", header: "Name", width: 18 },
                    { key: "category", header: "Category", width: 15 },
                    { key: "auth", header: "Auth", width: 18 },
                    { key: "reaches", header: "Reaches", width: 40 },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

connectorCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List connectors installed on an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<{ connectors: InstalledConnector[] }>(
                `/agents/${agentId}/connectors`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            if ((result.connectors ?? []).length === 0) {
                printInfo(
                    "No connectors installed. Run `1claw connector presets` to see what is available.",
                );
                return;
            }
            printTable(
                result.connectors.map((c) => ({
                    connector: c.display_name ?? c.preset_slug,
                    binding: c.binding_name,
                    status: statusLabel(c),
                    id: c.binding_id,
                })),
                [
                    { key: "connector", header: "Connector", width: 20 },
                    { key: "binding", header: "Binding", width: 20 },
                    { key: "status", header: "Status", width: 26 },
                    { key: "id", header: "Binding ID", width: 38 },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

connectorCommand
    .command("install <agent-id> <slug>")
    .description("Install a connector onto an agent (human users only)")
    .option("--name <name>", "Binding name (defaults to the connector slug)")
    .option(
        "--scopes <scopes>",
        "Comma-separated subset of the connector's scopes (may narrow, never extend)",
    )
    .option("--host <host>", "api-token connector only: the HTTPS host the binding may call (e.g. api.example.com)")
    .option("--token <token>", "api-token connector only: bearer token to store in the vault on install")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, slug: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.name) body.binding_name = opts.name;
            if (opts.host) body.host = opts.host;
            if (opts.token) body.token = opts.token;
            if (opts.scopes) {
                body.scopes = String(opts.scopes)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
            const result = await api<InstallResult>(
                `/agents/${agentId}/connectors/${slug}/install`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(`Binding '${result.binding_name}' created`);
            printKeyValue([
                ["Binding ID", result.binding_id],
                ["Connector", result.preset_slug],
            ]);
            // The install is not the end of the job, and saying "installed" and
            // stopping is how someone ends up with an agent that has no token.
            if (result.authorization_url) {
                console.log("");
                console.log(chalk.yellow("Not connected yet.") + " Open this to sign in:");
                console.log(chalk.cyan(result.authorization_url));
            } else {
                console.log("");
                printInfo(result.next_step);
            }
        } catch (e) {
            handleError(e);
        }
    });

function statusLabel(c: InstalledConnector): string {
    if (c.needs_reauth) return chalk.yellow("reconnect needed");
    if (!c.connected) return chalk.dim("not signed in");
    if (!c.is_active) return chalk.dim("inactive");
    return chalk.green("connected");
}

// ── Polled event sources → automation events (vault ≥ 0.61.32) ──────

interface EventSubscription {
    id: string;
    binding_id: string;
    event_type: string;
    interval_secs: number;
    is_active: boolean;
    primed: boolean;
    next_poll_at: string;
    last_error?: string | null;
    consecutive_errors: number;
    events_emitted: number;
}

connectorCommand
    .command("subscribe <agent-id> <binding-id> <event-type>")
    .description(
        "Subscribe an installed connector binding to one of its event sources (see `presets`); new items become automation events (human users only)",
    )
    .option("--interval <secs>", "Poll interval in seconds (defaults to the source's minimum)")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, bindingId: string, eventType: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { binding_id: bindingId, event_type: eventType };
            if (opts.interval) body.interval_secs = parseInt(opts.interval, 10);
            const sub = await api<EventSubscription>(`/agents/${agentId}/event-subscriptions`, {
                method: "POST",
                body,
            });
            if (opts.json) {
                printJson(sub);
                return;
            }
            printSuccess(
                `Subscribed ${chalk.bold(sub.event_type)} every ${sub.interval_secs}s (${sub.id}). ` +
                    `The first poll primes it and emits nothing; trigger an automation with event_filter.event_type = "${sub.event_type}".`,
            );
        } catch (e) {
            handleError(e);
        }
    });

connectorCommand
    .command("subscriptions <agent-id>")
    .description("List an agent's event subscriptions")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<{ subscriptions: EventSubscription[] }>(
                `/agents/${agentId}/event-subscriptions`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            const subs = result.subscriptions ?? [];
            if (subs.length === 0) {
                printInfo("No event subscriptions. Run `1claw connector subscribe` after installing a connector.");
                return;
            }
            printTable(
                subs.map((s) => ({
                    id: s.id,
                    event: s.event_type,
                    every: `${s.interval_secs}s`,
                    state: !s.is_active ? chalk.red("off") : s.primed ? chalk.green("live") : chalk.yellow("priming"),
                    emitted: String(s.events_emitted),
                    errors: s.consecutive_errors ? chalk.yellow(`${s.consecutive_errors}: ${(s.last_error ?? "").slice(0, 40)}`) : chalk.dim("0"),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "event", header: "Event", width: 30 },
                    { key: "every", header: "Every", width: 8 },
                    { key: "state", header: "State", width: 9 },
                    { key: "emitted", header: "Emitted", width: 8 },
                    { key: "errors", header: "Errors" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

connectorCommand
    .command("poll <agent-id> <subscription-id>")
    .description("Poll an event subscription now instead of waiting for its interval (human users only)")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, subId: string, opts) => {
        try {
            requireToken();
            const r = await api<{ emitted: number; subscription: EventSubscription }>(
                `/agents/${agentId}/event-subscriptions/${subId}/poll`,
                { method: "POST" },
            );
            if (opts.json) {
                printJson(r);
                return;
            }
            printSuccess(`Polled: ${r.emitted} event(s) emitted; ${r.subscription.primed ? "primed" : "not primed"}, next at ${r.subscription.next_poll_at}`);
        } catch (e) {
            handleError(e);
        }
    });

connectorCommand
    .command("unsubscribe <agent-id> <subscription-id>")
    .description("Delete an event subscription (human users only)")
    .action(async (agentId: string, subId: string) => {
        try {
            requireToken();
            await api(`/agents/${agentId}/event-subscriptions/${subId}`, { method: "DELETE" });
            printSuccess("Unsubscribed.");
        } catch (e) {
            handleError(e);
        }
    });
