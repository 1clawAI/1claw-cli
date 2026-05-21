import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
} from "../output.js";

interface PlatformApp {
    id: string;
    name: string;
    slug: string;
    description: string;
    logo_url?: string;
    api_key_prefix: string;
    oidc_audience?: string;
    is_active: boolean;
    billing_model: string;
    auth_mode: string;
    max_connected_users?: number;
    connected_users: number;
    created_at: string;
    updated_at: string;
}

interface Template {
    id: string;
    platform_app_id: string;
    name: string;
    description: string;
    version: number;
    spec: Record<string, unknown>;
    is_active: boolean;
    created_at: string;
}

interface ConnectedUser {
    connection_id: string;
    user_id: string;
    external_subject: string;
    status: string;
    vault_ids: string[];
    agent_ids: string[];
    created_at: string;
    claimed_at?: string;
}

interface ConnectedApp {
    connection_id: string;
    app_name: string;
    app_slug: string;
    status: string;
    created_at: string;
}

export const platformCommand = new Command("platform").description(
    "Manage platform apps (multi-tenant)",
);

platformCommand
    .command("create <name> <slug>")
    .description("Create a new platform app")
    .option(
        "--billing-model <model>",
        "Billing model (platform_pays, user_pays, or hybrid)",
        "platform_pays",
    )
    .option(
        "--auth-mode <mode>",
        "Auth mode (silent, user_signin, or configurable)",
        "silent",
    )
    .option("--oidc-jwks-url <url>", "OIDC JWKS URL for token validation")
    .option("--oidc-issuer <url>", "OIDC issuer URL")
    .option("--oidc-audience <audience>", "OIDC audience for token validation")
    .option("--json", "Output as JSON")
    .action(async (name, slug, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                name,
                slug,
                billing_model: opts.billingModel,
                auth_mode: opts.authMode,
            };
            if (opts.oidcJwksUrl) body.oidc_jwks_url = opts.oidcJwksUrl;
            if (opts.oidcIssuer) body.oidc_issuer = opts.oidcIssuer;
            if (opts.oidcAudience) body.oidc_audience = opts.oidcAudience;

            const app = await api<PlatformApp & { api_key?: string }>(
                "/platform/apps",
                { method: "POST", body },
            );

            if (opts.json) {
                printJson(app);
                return;
            }

            printSuccess(`Platform app ${chalk.bold(app.name)} created.`);
            printKeyValue([
                ["ID", app.id],
                ["Name", app.name],
                ["Slug", app.slug],
                ["Billing", app.billing_model],
                ["Auth mode", app.auth_mode],
            ]);

            if (app.api_key) {
                console.log();
                console.log(
                    chalk.yellow(
                        "  Save this API key — it won't be shown again:",
                    ),
                );
                console.log(`  ${chalk.bold(app.api_key)}`);
                console.log();
            }
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("list")
    .alias("ls")
    .description("List all platform apps")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ apps: PlatformApp[] }>("/platform/apps");
            const apps = res.apps ?? [];

            if (opts.json) {
                printJson(apps);
                return;
            }

            if (!apps.length) {
                console.log(chalk.dim("No platform apps found."));
                return;
            }

            printTable(
                apps.map((a) => ({
                    id: a.id,
                    name: a.name,
                    slug: a.slug,
                    billing: a.billing_model,
                    users: String(a.connected_users),
                    active: a.is_active ? chalk.green("✓") : chalk.dim("✗"),
                    created: new Date(a.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 20 },
                    { key: "slug", header: "Slug", width: 16 },
                    { key: "billing", header: "Billing", width: 14 },
                    { key: "users", header: "Users" },
                    { key: "active", header: "Active" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("get <appId>")
    .description("Get platform app details")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const app = await api<PlatformApp>(`/platform/apps/${appId}`);

            if (opts.json) {
                printJson(app);
                return;
            }

            printKeyValue([
                ["ID", app.id],
                ["Name", app.name],
                ["Slug", app.slug],
                ["Description", app.description || chalk.dim("none")],
                ["Billing model", app.billing_model],
                ["Auth mode", app.auth_mode],
                ["Active", app.is_active ? "yes" : "no"],
                ["Connected users", String(app.connected_users)],
                [
                    "Max users",
                    app.max_connected_users != null
                        ? String(app.max_connected_users)
                        : chalk.dim("unlimited"),
                ],
                ["API key prefix", app.api_key_prefix],
                ["Created", new Date(app.created_at).toLocaleString()],
                ["Updated", new Date(app.updated_at).toLocaleString()],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("delete <appId>")
    .description("Delete a platform app")
    .option("-y, --yes", "Skip confirmation")
    .action(async (appId, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete platform app ${appId}? This is irreversible.`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/platform/apps/${appId}`, { method: "DELETE" });
            printSuccess("Platform app deleted.");
        } catch (err) {
            handleError(err);
        }
    });

// ── Templates ───────────────────────────────────────────────────────────

const templatesCommand = platformCommand
    .command("templates")
    .description("Manage platform app templates");

templatesCommand
    .command("list <appId>")
    .alias("ls")
    .description("List templates for a platform app")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const res = await api<{ templates: Template[] }>(
                `/platform/apps/${appId}/templates`,
            );
            const templates = res.templates ?? [];

            if (opts.json) {
                printJson(templates);
                return;
            }

            if (!templates.length) {
                console.log(chalk.dim("No templates found."));
                return;
            }

            printTable(
                templates.map((t) => ({
                    id: t.id,
                    name: t.name,
                    version: String(t.version),
                    active: t.is_active ? chalk.green("✓") : chalk.dim("✗"),
                    created: new Date(t.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 24 },
                    { key: "version", header: "Ver" },
                    { key: "active", header: "Active" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

templatesCommand
    .command("create <appId> <name>")
    .description("Create a template for a platform app")
    .requiredOption("--spec <file>", "Path to JSON file with template spec")
    .option("--description <desc>", "Template description")
    .option("--json", "Output as JSON")
    .action(async (appId, name, opts) => {
        try {
            requireToken();

            const specPath = opts.spec as string;
            if (!existsSync(specPath)) {
                throw new Error(`Spec file not found: ${specPath}`);
            }
            const spec = JSON.parse(readFileSync(specPath, "utf8"));

            const body: Record<string, unknown> = { name, spec };
            if (opts.description) body.description = opts.description;

            const template = await api<Template>(
                `/platform/apps/${appId}/templates`,
                { method: "POST", body },
            );

            if (opts.json) {
                printJson(template);
                return;
            }

            printSuccess(`Template ${chalk.bold(template.name)} created.`);
            printKeyValue([
                ["ID", template.id],
                ["Name", template.name],
                ["Version", String(template.version)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// ── Users ───────────────────────────────────────────────────────────────

const usersCommand = platformCommand
    .command("users")
    .description("Manage platform connected users");

usersCommand
    .command("list <appId>")
    .alias("ls")
    .description("List connected users for a platform app")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const res = await api<{ users: ConnectedUser[] }>(
                `/platform/apps/${appId}/users`,
            );
            const users = res.users ?? [];

            if (opts.json) {
                printJson(users);
                return;
            }

            if (!users.length) {
                console.log(chalk.dim("No connected users found."));
                return;
            }

            printTable(
                users.map((u) => ({
                    connection_id: u.connection_id.slice(0, 8) + "…",
                    user_id: u.user_id.slice(0, 8) + "…",
                    status: u.status,
                    vaults: String(u.vault_ids.length),
                    agents: String(u.agent_ids.length),
                    created: new Date(u.created_at).toLocaleDateString(),
                })),
                [
                    { key: "connection_id", header: "Connection" },
                    { key: "user_id", header: "User" },
                    { key: "status", header: "Status" },
                    { key: "vaults", header: "Vaults" },
                    { key: "agents", header: "Agents" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

// ── Connected Apps (user-side) ──────────────────────────────────────────

platformCommand
    .command("connected-apps")
    .description("List apps connected to your account (user side)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ apps: ConnectedApp[] }>(
                "/platform/connected-apps",
            );
            const apps = res.apps ?? [];

            if (opts.json) {
                printJson(apps);
                return;
            }

            if (!apps.length) {
                console.log(chalk.dim("No connected apps."));
                return;
            }

            printTable(
                apps.map((a) => ({
                    connection_id: a.connection_id.slice(0, 8) + "…",
                    name: a.app_name,
                    slug: a.app_slug,
                    status: a.status,
                    created: new Date(a.created_at).toLocaleDateString(),
                })),
                [
                    { key: "connection_id", header: "Connection" },
                    { key: "name", header: "App Name", width: 20 },
                    { key: "slug", header: "Slug", width: 16 },
                    { key: "status", header: "Status" },
                    { key: "created", header: "Connected" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

// ── Reissue claim ───────────────────────────────────────────────────────

platformCommand
    .command("reissue-claim <connectionId>")
    .description(
        "Reissue a claim URL for a bootstrapped connection (no re-provisioning)",
    )
    .option("--return-to <url>", "Redirect URL after claim")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.returnTo) body.return_to = opts.returnTo;

            const result = await api<{
                claim_url: string;
                claim_token: string;
                expires_in: number;
                connection_id: string;
            }>(`/platform/connections/${connectionId}/reissue-claim`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess("Claim URL reissued.");
            printKeyValue([
                ["Connection", result.connection_id],
                ["Claim URL", result.claim_url],
                ["Token", result.claim_token],
                ["Expires in", `${result.expires_in}s`],
            ]);
        } catch (err) {
            handleError(err);
        }
    });
