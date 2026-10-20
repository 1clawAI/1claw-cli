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
    display_name: string;
    default_scopes?: string[];
    requires_app_credentials?: boolean;
    documentation_url?: string | null;
}

interface OAuthConnection {
    binding_id: string;
    provider_slug: string;
    provider_name?: string;
    status: string;
    needs_reauth?: boolean;
    scopes?: string[];
    created_at: string;
}

interface OAuthConnectResponse {
    authorization_url: string;
}

interface OAuthCredential {
    id: string;
    provider_slug: string;
    client_id: string;
    redirect_uri?: string | null;
    created_at: string;
    updated_at?: string;
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
                    name: p.display_name,
                    app_creds: p.requires_app_credentials
                        ? "required"
                        : chalk.dim("optional"),
                    scopes: p.default_scopes?.length
                        ? p.default_scopes.join(", ")
                        : chalk.dim("—"),
                })),
                [
                    { key: "slug", header: "Slug", width: 16 },
                    { key: "name", header: "Name", width: 20 },
                    { key: "app_creds", header: "App credentials", width: 16 },
                    { key: "scopes", header: "Default scopes", width: 40 },
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
                    id: c.binding_id,
                    provider: c.provider_slug,
                    scopes: c.scopes?.length ? c.scopes.join(", ") : chalk.dim("—"),
                    status: c.status,
                    created: formatDate(c.created_at),
                })),
                [
                    { key: "id", header: "Binding ID", width: 36 },
                    { key: "provider", header: "Provider", width: 16 },
                    { key: "scopes", header: "Scopes", width: 24 },
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
    .option("--scopes <scopes>", "Comma-separated scopes (default: the provider's default scopes)")
    .option("--no-open", "Print the URL instead of opening it")
    .action(async (agentId: string, providerSlug: string, opts) => {
        try {
            requireToken();
            const result = await api<OAuthConnectResponse>(
                `/agents/${agentId}/oauth/connect`,
                {
                    method: "POST",
                    body: {
                        provider_slug: providerSlug,
                        ...(opts.scopes
                            ? {
                                  scopes: String(opts.scopes)
                                      .split(",")
                                      .map((x: string) => x.trim())
                                      .filter(Boolean),
                              }
                            : {}),
                    },
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

            await api(`/agents/${agentId}/oauth/disconnect/${bindingId}`, {
                method: "POST",
            });
            printSuccess("OAuth connection disconnected.");
        } catch (err) {
            handleError(err);
        }
    });

// ── Credentials subcommands ─────────────────────────────────────────

const credentialsCommand = oauthCommand
    .command("credentials")
    .description(
        "Manage OAuth app credentials (client ID/secret). Credentials are stored per organization; the agent id only scopes the request.",
    );

credentialsCommand
    .command("save <agent-id>")
    .description("Save OAuth app credentials for a provider")
    .requiredOption("--provider <slug>", "Provider slug (e.g. google, github, slack)")
    .requiredOption("--client-id <id>", "OAuth client ID")
    .requiredOption("--client-secret <secret>", "OAuth client secret")
    .option("--redirect-uri <uri>", "Redirect URI registered with the provider (HTTPS in production)")
    .option("--approval-id <id>", "Approved consensus request, when the org requires one for credential.create")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts) => {
        try {
            requireToken();
            const result = await api<OAuthCredential>(
                `/agents/${agentId}/oauth/app-credentials`,
                {
                    method: "POST",
                    body: {
                        provider_slug: opts.provider,
                        client_id: opts.clientId,
                        client_secret: opts.clientSecret,
                        ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
                        ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
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
            const result = await api<{
                credentials: OAuthCredential[];
                platform_defaults?: string[];
            }>(`/agents/${agentId}/oauth/app-credentials`);
            const credentials = result.credentials ?? [];

            if (opts.json) {
                printJson(result);
                return;
            }

            const defaults = result.platform_defaults ?? [];
            if (credentials.length === 0) {
                printInfo("No OAuth app credentials saved for this organization.");
                if (defaults.length > 0) {
                    printInfo(`1Claw's own app is used for: ${defaults.join(", ")}`);
                }
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
    .option("--approval-id <id>", "Approved consensus request, when the org requires one for credential.delete")
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
                `/agents/${agentId}/oauth/app-credentials/${encodeURIComponent(providerSlug)}`,
                { method: "DELETE", query: { approval_id: opts.approvalId } },
            );
            printSuccess(
                `OAuth credentials for ${chalk.bold(providerSlug)} deleted.`,
            );
        } catch (err) {
            handleError(err);
        }
    });
