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
    .option("--json", "Output as JSON")
    .action(async (agentId: string, slug: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.name) body.binding_name = opts.name;
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
