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

interface OAuthProvider {
    slug: string;
    name: string;
    description?: string;
    scopes?: string[];
    is_enabled: boolean;
}

interface OAuthConnection {
    id: string;
    provider_slug: string;
    provider_name?: string;
    account_label?: string;
    status: string;
    scopes?: string[];
    created_at: string;
    expires_at?: string;
}

interface OAuthConnectResponse {
    authorization_url: string;
    state?: string;
}

interface OAuthCredential {
    id: string;
    provider_slug: string;
    client_id: string;
    created_at: string;
}

export const oauthCommand = new Command("oauth").description(
    "Manage OAuth connected accounts for agents",
);

oauthCommand
    .command("providers")
    .alias("ls-providers")
    .description("List available OAuth providers")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const result = await api<{ providers: OAuthProvider[] }>(
                "/oauth/providers",
            );
            const providers = result.providers ?? [];

            if (opts.json) {
                printJson(providers);
                return;
            }

            if (providers.length === 0) {
                printInfo("No OAuth providers available.");
                return;
            }

            printTable(
                providers.map((p) => ({
                    slug: p.slug,
                    name: p.name,
                    description: p.description ?? chalk.dim("—"),
                    enabled: p.is_enabled
                        ? chalk.green("yes")
                        : chalk.dim("no"),
                    scopes: p.scopes?.join(", ") ?? chalk.dim("—"),
                })),
                [
                    { key: "slug", header: "Slug", width: 16 },
                    { key: "name", header: "Name", width: 20 },
                    { key: "description", header: "Description", width: 30 },
                    { key: "enabled", header: "Enabled" },
                    { key: "scopes", header: "Scopes", width: 30 },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

oauthCommand
    .command("connections <agent-id>")
    .alias("ls")
    .description("List OAuth connections for an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<{ connections: OAuthConnection[] }>(
                `/agents/${agentId}/oauth/connections`,
            );
            const connections = result.connections ?? [];

            if (opts.json) {
                printJson(connections);
                return;
            }

            if (connections.length === 0) {
                printInfo("No OAuth connections found for this agent.");
                return;
            }

            printTable(
                connections.map((c) => ({
                    id: c.id,
                    provider: c.provider_slug,
                    account: c.account_label ?? chalk.dim("—"),
                    status: c.status,
                    created: formatDate(c.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "provider", header: "Provider", width: 16 },
                    { key: "account", header: "Account", width: 24 },
                    { key: "status", header: "Status", width: 12 },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

oauthCommand
    .command("connect <agent-id> <provider-slug>")
    .description("Initiate OAuth connection (opens authorization URL in browser)")
    .option("--no-open", "Print the URL instead of opening it")
    .action(async (agentId: string, providerSlug: string, opts) => {
        try {
            requireToken();
            const result = await api<OAuthConnectResponse>(
                `/agents/${agentId}/oauth/connect`,
                {
                    method: "POST",
                    body: { provider_slug: providerSlug },
                },
            );

            const url = result.authorization_url;

            if (opts.open !== false) {
                const open = await import("open");
                await open.default(url);
                printSuccess("Opened authorization URL in browser.");
                console.log(chalk.dim(`  ${url}`));
            } else {
                printSuccess("Authorization URL:");
                console.log(`  ${url}`);
            }
        } catch (err) {
            handleError(err);
        }
    });

oauthCommand
    .command("disconnect <agent-id> <binding-id>")
    .description("Disconnect an OAuth binding")
    .option("-y, --yes", "Skip confirmation")
    .action(async (agentId: string, bindingId: string, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Disconnect OAuth binding ${bindingId}?`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/agents/${agentId}/oauth/connections/${bindingId}`, {
                method: "DELETE",
            });
            printSuccess("OAuth connection disconnected.");
        } catch (err) {
            handleError(err);
        }
    });

// ── Credentials subcommands ─────────────────────────────────────────

const credentialsCommand = oauthCommand
    .command("credentials")
    .description("Manage OAuth app credentials (client ID/secret)");

credentialsCommand
    .command("save <agent-id>")
    .description("Save OAuth app credentials for a provider")
    .requiredOption("--provider <slug>", "Provider slug (e.g. google, github, slack)")
    .requiredOption("--client-id <id>", "OAuth client ID")
    .requiredOption("--client-secret <secret>", "OAuth client secret")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<OAuthCredential>(
                `/agents/${agentId}/oauth/credentials`,
                {
                    method: "POST",
                    body: {
                        provider_slug: opts.provider,
                        client_id: opts.clientId,
                        client_secret: opts.clientSecret,
                    },
                },
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess(
                `OAuth credentials saved for ${chalk.bold(opts.provider)}.`,
            );
            printKeyValue([
                ["ID", result.id],
                ["Provider", result.provider_slug],
                ["Client ID", result.client_id],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

credentialsCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List saved OAuth app credentials")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<{ credentials: OAuthCredential[] }>(
                `/agents/${agentId}/oauth/credentials`,
            );
            const credentials = result.credentials ?? [];

            if (opts.json) {
                printJson(credentials);
                return;
            }

            if (credentials.length === 0) {
                printInfo("No OAuth credentials saved for this agent.");
                return;
            }

            printTable(
                credentials.map((c) => ({
                    id: c.id,
                    provider: c.provider_slug,
                    client_id: c.client_id,
                    created: formatDate(c.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "provider", header: "Provider", width: 16 },
                    { key: "client_id", header: "Client ID", width: 30 },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

credentialsCommand
    .command("delete <agent-id> <provider-slug>")
    .description("Delete OAuth app credentials for a provider")
    .option("-y, --yes", "Skip confirmation")
    .action(async (agentId: string, providerSlug: string, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete OAuth credentials for ${providerSlug}?`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(
                `/agents/${agentId}/oauth/credentials/${encodeURIComponent(providerSlug)}`,
                { method: "DELETE" },
            );
            printSuccess(
                `OAuth credentials for ${chalk.bold(providerSlug)} deleted.`,
            );
        } catch (err) {
            handleError(err);
        }
    });
