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
    formatDate,
    resolveExpiresAt,
} from "../output.js";

interface PlatformApp {
    id: string;
    name: string;
    slug: string;
    description: string;
    logo_url?: string;
    api_key_prefix: string;
    api_key_expires_at?: string | null;
    api_key_rotated_at?: string | null;
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

export const platformCommand = new Command("platform")
    .description("Manage platform apps (multi-tenant)")
    // Required by nested `platform exec` (.passThroughOptions) under Commander 13+
    .enablePositionalOptions();

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
    .option(
        "--api-key-expires-at <date>",
        "API key expiration (ISO 8601 or relative: 30d, 90d, 6m, 1y)",
    )
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
            if (opts.apiKeyExpiresAt)
                body.api_key_expires_at = resolveExpiresAt(opts.apiKeyExpiresAt);

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
                [
                    "API key expires",
                    app.api_key_expires_at
                        ? formatDate(app.api_key_expires_at, "long")
                        : chalk.dim("never"),
                ],
                ...(app.api_key_rotated_at
                    ? [["API key rotated", formatDate(app.api_key_rotated_at, "long")] as [string, string]]
                    : []),
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

            const result = await api<{
                id: string;
                slug: string;
                deleted_at: string;
                slug_released?: boolean;
            }>(`/platform/apps/${appId}`, { method: "DELETE" });
            printSuccess(
                `Platform app deleted (slug ${result.slug} released).`,
            );
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("update <appId>")
    .description("Update a platform app")
    .option("--name <name>", "App name")
    .option(
        "--billing-model <model>",
        "Billing model (platform_pays, user_pays, or hybrid)",
    )
    .option(
        "--auth-mode <mode>",
        "Auth mode (silent, user_signin, or configurable)",
    )
    .option("--oidc-jwks-url <url>", "OIDC JWKS URL for token validation")
    .option("--oidc-issuer <url>", "OIDC issuer URL")
    .option("--oidc-audience <audience>", "OIDC audience for token validation")
    .option(
        "--api-key-expires-at <date>",
        'API key expiration (ISO 8601, relative: 30d/90d/6m/1y, or "" to clear)',
    )
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};

            if (opts.name) body.name = opts.name;
            if (opts.billingModel) body.billing_model = opts.billingModel;
            if (opts.authMode) body.auth_mode = opts.authMode;
            if (opts.oidcJwksUrl) body.oidc_jwks_url = opts.oidcJwksUrl;
            if (opts.oidcIssuer) body.oidc_issuer = opts.oidcIssuer;
            if (opts.oidcAudience) body.oidc_audience = opts.oidcAudience;
            if (opts.apiKeyExpiresAt !== undefined) {
                body.api_key_expires_at =
                    opts.apiKeyExpiresAt === ""
                        ? null
                        : resolveExpiresAt(opts.apiKeyExpiresAt);
            }

            if (Object.keys(body).length === 0) {
                console.log(
                    chalk.yellow(
                        "No update options provided. Use --help for available flags.",
                    ),
                );
                return;
            }

            const app = await api<PlatformApp>(`/platform/apps/${appId}`, {
                method: "PATCH",
                body,
            });

            if (opts.json) {
                printJson(app);
                return;
            }

            printSuccess(`Platform app ${chalk.bold(app.name)} updated.`);
            printKeyValue([
                ["ID", app.id],
                ["Name", app.name],
                ["Slug", app.slug],
                ["Billing", app.billing_model],
                ["Auth mode", app.auth_mode],
                [
                    "API key expires",
                    app.api_key_expires_at
                        ? formatDate(app.api_key_expires_at, "long")
                        : chalk.dim("never"),
                ],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("rotate-key <appId>")
    .description("Rotate the API key for a platform app")
    .option(
        "--api-key-expires-at <date>",
        "New key expiration (ISO 8601 or relative: 30d, 90d, 6m, 1y)",
    )
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.apiKeyExpiresAt)
                body.api_key_expires_at = resolveExpiresAt(opts.apiKeyExpiresAt);

            const result = await api<{
                api_key: string;
                api_key_prefix: string;
                api_key_expires_at?: string | null;
            }>(`/platform/apps/${appId}/rotate-key`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess("Platform app API key rotated.");
            console.log();
            console.log(
                chalk.yellow(
                    "  Save this API key — it won't be shown again:",
                ),
            );
            console.log(`  ${chalk.bold(result.api_key)}`);
            console.log();
            printKeyValue([
                ["Prefix", result.api_key_prefix],
                [
                    "Expires",
                    result.api_key_expires_at
                        ? formatDate(result.api_key_expires_at, "long")
                        : chalk.dim("never"),
                ],
            ]);
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
    .command("get <appId> <templateId>")
    .description("Get a platform app template by ID")
    .option("--json", "Output as JSON")
    .action(async (appId, templateId, opts) => {
        try {
            requireToken();
            const template = await api<Template>(
                `/platform/apps/${appId}/templates/${templateId}`,
            );
            if (opts.json) {
                printJson(template);
                return;
            }
            printKeyValue([
                ["ID", template.id],
                ["Name", template.name],
                ["Version", String(template.version)],
                ["Active", template.is_active ? "yes" : "no"],
            ]);
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

templatesCommand
    .command("update <appId> <templateId>")
    .description("Update a platform app template")
    .option("--spec <file>", "Path to JSON file with updated template spec")
    .option("--name <name>", "Updated template name")
    .option("--description <desc>", "Updated template description")
    .option("--json", "Output as JSON")
    .action(async (appId, templateId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};

            if (opts.spec) {
                if (!existsSync(opts.spec)) {
                    throw new Error(`Spec file not found: ${opts.spec}`);
                }
                body.spec = JSON.parse(readFileSync(opts.spec, "utf8"));
            }
            if (opts.name) body.name = opts.name;
            if (opts.description) body.description = opts.description;

            if (Object.keys(body).length === 0) {
                console.log(
                    chalk.yellow(
                        "No update options provided. Use --help for available flags.",
                    ),
                );
                return;
            }

            const template = await api<Template>(
                `/platform/apps/${appId}/templates/${templateId}`,
                { method: "PATCH", body },
            );

            if (opts.json) {
                printJson(template);
                return;
            }

            printSuccess(`Template ${chalk.bold(template.name)} updated.`);
            printKeyValue([
                ["ID", template.id],
                ["Name", template.name],
                ["Version", String(template.version)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

templatesCommand
    .command("delete <appId> <templateId>")
    .description("Delete a platform app template")
    .option("-y, --yes", "Skip confirmation")
    .action(async (appId, templateId, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete template ${templateId}? This cannot be undone.`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/platform/apps/${appId}/templates/${templateId}`, {
                method: "DELETE",
            });
            printSuccess("Template deleted.");
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

platformCommand
    .command("upsert-user")
    .description("Provision or find a user for a platform app")
    .option("--email <email>", "User email to provision")
    .option("--subject-token <jwt>", "OIDC subject token (JWT) for token-based provisioning")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();

            if (!opts.email && !opts.subjectToken) {
                console.error(
                    chalk.red("Either --email or --subject-token is required."),
                );
                process.exit(1);
            }

            const body: Record<string, unknown> = {};
            if (opts.email) body.email = opts.email;
            if (opts.subjectToken) body.subject_token = opts.subjectToken;

            const result = await api<{
                user_handle: string;
                connection_id: string;
                is_new: boolean;
            }>("/platform/users/upsert", { method: "POST", body });

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess(
                result.is_new
                    ? "New user provisioned."
                    : "Existing user found.",
            );
            printKeyValue([
                ["User handle", result.user_handle],
                ["Connection ID", result.connection_id],
                ["New user", result.is_new ? "yes" : "no"],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("bootstrap <connectionId>")
    .description("Bootstrap a connected user with resources from a template")
    .option("--template <id>", "Template ID (uses app default if omitted)")
    .option("--return-to <url>", "Redirect URL after claim")
    .option("--parameters <json>", "Template parameters JSON (substituted as {{params.*}})")
    .option("--idempotency-key <key>", "Idempotency-Key header for params-aware replay")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.template) body.template_id = opts.template;
            if (opts.returnTo) body.return_to = opts.returnTo;
            if (opts.parameters) {
                body.parameters = JSON.parse(opts.parameters);
            }

            const headers: Record<string, string> = {};
            if (opts.idempotencyKey) {
                headers["Idempotency-Key"] = opts.idempotencyKey;
            }

            const result = await api<{
                claim_url: string;
                claim_token: string;
                connection_id: string;
                summary: Record<string, unknown>;
            }>(`/platform/connections/${connectionId}/bootstrap`, {
                method: "POST",
                body,
                headers: Object.keys(headers).length ? headers : undefined,
            });

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess("User bootstrapped successfully.");
            printKeyValue([
                ["Connection", result.connection_id],
                ["Claim URL", result.claim_url],
            ]);
            if (result.summary) {
                console.log();
                console.log(chalk.dim("Summary:"));
                console.log(JSON.stringify(result.summary, null, 2));
            }
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("siwe-challenge")
    .description("Issue a SIWE nonce for wallet-native user provisioning")
    .option("--domain <domain>", "SIWE domain override")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.domain) body.domain = opts.domain;
            const result = await api<{
                nonce: string;
                expires_in: number;
                domain: string;
            }>("/platform/siwe/challenge", { method: "POST", body });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("SIWE nonce issued.");
            printKeyValue([
                ["Domain", result.domain],
                ["Nonce", result.nonce],
                ["Expires in", `${result.expires_in}s`],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection")
    .description("Connection detail, usage, and entitlements")
    .argument("<connectionId>", "Platform connection UUID")
    .option("--usage", "Show per-connection inference usage")
    .option("--entitlements", "List entitlement evaluations")
    .option("--refresh-entitlements", "Trigger entitlement monitor refresh")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            if (opts.refreshEntitlements) {
                await api(
                    `/platform/connections/${connectionId}/entitlements/refresh`,
                    { method: "POST" },
                );
                printSuccess("Entitlement refresh accepted (202).");
                return;
            }
            if (opts.usage) {
                const result = await api<{
                    connection_id: string;
                    period: string;
                    inference_spent_usd: string;
                }>(`/platform/connections/${connectionId}/usage`);
                if (opts.json) {
                    printJson(result);
                    return;
                }
                printKeyValue([
                    ["Connection", result.connection_id],
                    ["Period", result.period],
                    ["Inference spent (USD)", result.inference_spent_usd],
                ]);
                return;
            }
            if (opts.entitlements) {
                const result = await api<{ evaluations: unknown[] }>(
                    `/platform/connections/${connectionId}/entitlements`,
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                printJson(result.evaluations);
                return;
            }
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-approvals <connectionId>")
    .description("List approvals for a platform connection (plt_ auth)")
    .option("--status <status>", "Filter by status (pending, approved, rejected)")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const query: Record<string, string> = {};
            if (opts.status) query.status = opts.status;
            const result = await api<{ approvals: unknown[]; total: number }>(
                `/platform/connections/${connectionId}/approvals`,
                { query },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([["Total", String(result.total)]]);
            printJson(result.approvals);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-spend-policy <connectionId>")
    .description("Get effective spend policy for a connection (plt_ auth)")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/spend-policy`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-pending-approvals <connectionId>")
    .description("List consensus pending approvals for a connection (plt_ auth)")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const result = await api<{
                pending_approvals: unknown[];
                total: number;
            }>(`/platform/connections/${connectionId}/pending-approvals`);
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([["Total", String(result.total)]]);
            printJson(result.pending_approvals);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-spend-policy-set <connectionId>")
    .description("Set spend policy for a platform connection (plt_ auth)")
    .requiredOption("--policy <file>", "Path to JSON spend policy file")
    .option("--idempotency-key <key>", "Optional Idempotency-Key header")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const policyPath = opts.policy as string;
            if (!existsSync(policyPath)) {
                throw new Error(`Policy file not found: ${policyPath}`);
            }
            const body = JSON.parse(readFileSync(policyPath, "utf8"));
            const headers: Record<string, string> = {};
            if (opts.idempotencyKey) {
                headers["Idempotency-Key"] = opts.idempotencyKey;
            }
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/spend-policy`,
                { method: "PUT", body, headers },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Spend policy updated.");
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-runtime-create <connectionId>")
    .description("Create a runtime for a connection agent (plt_ auth)")
    .requiredOption("--name <name>", "Runtime name")
    .option("--agent-id <uuid>", "Agent UUID (defaults to first connection agent)")
    .option("--preset <preset>", "Runtime preset", "small")
    .option("--template <template>", "Runtime template", "openclaw")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                name: opts.name,
                preset: opts.preset,
                template: opts.template,
            };
            if (opts.agentId) body.agent_id = opts.agentId;
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/runtimes`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Runtime created.");
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-agent-chat <connectionId> <agentId>")
    .description("Chat with an agent on a platform connection (plt_ auth)")
    .requiredOption("--message <text>", "Chat message")
    .option("--conversation-id <uuid>", "Existing conversation ID")
    .option("--model <model>", "LLM model override")
    .option("--provider <provider>", "LLM provider override")
    .option("--json", "Output as JSON")
    .action(async (connectionId, agentId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { message: opts.message };
            if (opts.conversationId) body.conversation_id = opts.conversationId;
            if (opts.model) body.model = opts.model;
            if (opts.provider) body.provider = opts.provider;
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/agents/${agentId}/chat`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-pending-approval-decide <connectionId> <approvalId>")
    .description("Vote on a consensus pending approval (plt_ auth)")
    .requiredOption("--decision <decision>", "approve|reject|approved|rejected")
    .requiredOption("--payload-hash <hash>", "payload_hash from pending approval")
    .option("--reason <text>", "Optional reason")
    .option("--credential-type <type>", "Credential type (e.g. wallet_mandate)")
    .option("--json", "Output as JSON")
    .action(async (connectionId, approvalId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                decision: opts.decision,
                payload_hash: opts.payloadHash,
            };
            if (opts.reason) body.reason = opts.reason;
            if (opts.credentialType) body.credential_type = opts.credentialType;
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/pending-approvals/${approvalId}/decide`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-approval-decide <connectionId> <approvalId>")
    .description("Decide a mobile approval for a connection (plt_ auth)")
    .requiredOption("--decision <decision>", "approved|rejected|approve|reject")
    .option("--reason <text>", "Optional reason")
    .option("--json", "Output as JSON")
    .action(async (connectionId, approvalId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { decision: opts.decision };
            if (opts.reason) body.reason = opts.reason;
            const result = await api<Record<string, unknown>>(
                `/platform/connections/${connectionId}/approvals/${approvalId}/decide`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("connection-signing-key-deactivate <connectionId> <chain>")
    .description("Deactivate a signing key for a connection agent (plt_ auth)")
    .option("--agent-id <uuid>", "Agent UUID when connection has multiple agents")
    .option("--json", "Output as JSON")
    .action(async (connectionId, chain, opts) => {
        try {
            requireToken();
            const query: Record<string, string> = {};
            if (opts.agentId) query.agent_id = opts.agentId;
            await api<void>(
                `/platform/connections/${connectionId}/signing-keys/${encodeURIComponent(chain)}`,
                { method: "DELETE", query },
            );
            if (opts.json) {
                printJson({ status: "deactivated", chain });
                return;
            }
            printSuccess(`Signing key deactivated for chain ${chain}.`);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("transfer-ownership <appId>")
    .description("Transfer platform app to another org (step-up auth required)")
    .requiredOption("--target-org-id <uuid>", "Destination organization UUID")
    .option("--confirm-token <token>", "X-Auth-Confirm re-auth token")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const headers: Record<string, string> = {};
            if (opts.confirmToken) {
                headers["X-Auth-Confirm"] = opts.confirmToken;
            }
            const result = await api<{
                app_id: string;
                former_org_id: string;
                new_org_id: string;
            }>(`/platform/apps/${appId}/transfer-ownership`, {
                method: "POST",
                body: { target_org_id: opts.targetOrgId },
                headers,
            });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(`App ${appId} transferred to org ${result.new_org_id}.`);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("template-preview <appId> <templateId>")
    .description("Preview resolved template spec with parameters")
    .option("--parameters <json>", "Template parameters object")
    .option("--subject <json>", "Subject context for {{subject.*}} placeholders")
    .option("--json", "Output as JSON")
    .action(async (appId, templateId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.parameters) body.parameters = JSON.parse(opts.parameters);
            if (opts.subject) body.subject = JSON.parse(opts.subject);
            const result = await api<{ resolved_spec: Record<string, unknown> }>(
                `/platform/apps/${appId}/templates/${templateId}/preview`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printJson(result.resolved_spec);
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

platformCommand
    .command("audit <appId>")
    .description("View platform audit events for an app")
    .option("--limit <n>", "Max events to show", "20")
    .option("--offset <n>", "Skip events", "0")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const result = await api<{
                events: Array<{
                    id: string;
                    action: string;
                    actor_id: string;
                    resource_type?: string;
                    resource_id?: string;
                    created_at: string;
                }>;
                total: number;
            }>(
                `/platform/apps/${appId}/audit?limit=${opts.limit}&offset=${opts.offset}`,
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            if (result.events.length === 0) {
                console.log(chalk.dim("No audit events found."));
                return;
            }

            printTable(
                result.events.map((e) => ({
                    action: e.action,
                    actor: e.actor_id.slice(0, 8) + "…",
                    resource: e.resource_type
                        ? `${e.resource_type}/${(e.resource_id ?? "").slice(0, 8)}…`
                        : "—",
                    date: formatDate(e.created_at),
                })),
                [
                    { key: "action", header: "Action", width: 28 },
                    { key: "actor", header: "Actor" },
                    { key: "resource", header: "Resource", width: 24 },
                    { key: "date", header: "Date", width: 20 },
                ],
            );
            console.log(chalk.dim(`Total: ${result.total}`));
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

// ── Grants ──────────────────────────────────────────────────────────────

interface PlatformGrant {
    id: string;
    connection_id: string;
    platform_app_id: string;
    user_id: string;
    vault_id: string;
    allowed_paths: string[];
    permissions: string[];
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
}

platformCommand
    .command("grant <connectionId>")
    .description("Grant platform access to vaults and/or agents for a connection")
    .option("--vault-ids <ids...>", "Vault IDs to grant access to")
    .option("--agent-ids <ids...>", "Agent IDs to grant access to")
    .option("--permissions <perms>", "Comma-separated permissions (e.g. read,write)")
    .option("--allowed-paths <paths>", "Comma-separated allowed secret paths")
    .option(
        "--expires-at <date>",
        "Grant expiration (ISO 8601 or relative: 30d, 90d, 6m, 1y)",
    )
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();

            if (!opts.vaultIds?.length && !opts.agentIds?.length) {
                console.error(
                    chalk.red("At least one of --vault-ids or --agent-ids is required."),
                );
                process.exit(1);
            }

            const body: Record<string, unknown> = {};
            if (opts.vaultIds?.length) body.vault_ids = opts.vaultIds;
            if (opts.agentIds?.length) body.agent_ids = opts.agentIds;
            if (opts.permissions)
                body.permissions = opts.permissions.split(",").map((s: string) => s.trim());
            if (opts.allowedPaths)
                body.allowed_paths = opts.allowedPaths.split(",").map((s: string) => s.trim());
            if (opts.expiresAt)
                body.expires_at = resolveExpiresAt(opts.expiresAt);

            const result = await api<{
                connection_id: string;
                grants: PlatformGrant[];
                vault_ids: string[];
                agent_ids: string[];
            }>(`/platform/connections/${connectionId}/grant`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess("Access granted.");
            printKeyValue([
                ["Connection", result.connection_id],
                ["Vaults", result.vault_ids.length ? result.vault_ids.join(", ") : chalk.dim("none")],
                ["Agents", result.agent_ids.length ? result.agent_ids.join(", ") : chalk.dim("none")],
                ["Grants created", String(result.grants.length)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("list-grants <connectionId>")
    .description("List active resource grants for a connection")
    .option("--json", "Output as JSON")
    .action(async (connectionId, opts) => {
        try {
            requireToken();
            const res = await api<{ grants: PlatformGrant[] }>(
                `/platform/connections/${connectionId}/grants`,
            );
            const grants = res.grants ?? [];

            if (opts.json) {
                printJson(grants);
                return;
            }

            if (!grants.length) {
                console.log(chalk.dim("No active grants for this connection."));
                return;
            }

            printTable(
                grants.map((g) => ({
                    id: g.id,
                    vault_id: g.vault_id.slice(0, 8) + "…",
                    permissions: g.permissions.join(", ") || chalk.dim("—"),
                    paths: g.allowed_paths.length
                        ? g.allowed_paths.join(", ")
                        : chalk.dim("all"),
                    expires: g.expires_at
                        ? formatDate(g.expires_at)
                        : chalk.dim("never"),
                    created: formatDate(g.created_at),
                })),
                [
                    { key: "id", header: "Grant ID", width: 36 },
                    { key: "vault_id", header: "Vault" },
                    { key: "permissions", header: "Permissions", width: 14 },
                    { key: "paths", header: "Paths", width: 20 },
                    { key: "expires", header: "Expires" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("revoke-grant <connectionId> <grantId>")
    .description("Revoke a resource grant for a connection")
    .option("--json", "Output as JSON")
    .action(async (connectionId, grantId, opts) => {
        try {
            requireToken();
            await api(
                `/platform/connections/${connectionId}/grants/${grantId}`,
                { method: "DELETE" },
            );

            if (opts.json) {
                printJson({ status: "revoked", grant_id: grantId });
                return;
            }

            printSuccess(`Grant ${grantId} revoked.`);
        } catch (err) {
            handleError(err);
        }
    });

// ── Marketplace ─────────────────────────────────────────────────────────

platformCommand
    .command("marketplace")
    .description("List platform apps in the public marketplace")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            const res = await api<{
                apps: Array<{
                    id: string;
                    name: string;
                    slug: string;
                    description: string;
                    logo_url?: string;
                    category?: string;
                    listing_tags?: string[];
                    pricing_summary?: string;
                }>;
            }>("/platform/marketplace");
            const apps = res.apps ?? [];

            if (opts.json) {
                printJson(apps);
                return;
            }

            if (!apps.length) {
                console.log(chalk.dim("No marketplace apps found."));
                return;
            }

            printTable(
                apps.map((a) => ({
                    name: a.name,
                    slug: a.slug,
                    category: a.category || chalk.dim("—"),
                    tags: a.listing_tags?.join(", ") || chalk.dim("—"),
                    pricing: a.pricing_summary || chalk.dim("—"),
                })),
                [
                    { key: "name", header: "Name", width: 20 },
                    { key: "slug", header: "Slug", width: 16 },
                    { key: "category", header: "Category", width: 14 },
                    { key: "tags", header: "Tags", width: 24 },
                    { key: "pricing", header: "Pricing", width: 16 },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

// ── App stats ───────────────────────────────────────────────────────────

platformCommand
    .command("app-stats <appId>")
    .description("Get usage statistics for a platform app")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const stats = await api<{
                total_connections: number;
                active_connections: number;
                claimed_connections: number;
                total_bootstraps: number;
                total_grants: number;
            }>(`/platform/apps/${appId}/stats`);

            if (opts.json) {
                printJson(stats);
                return;
            }

            printKeyValue([
                ["Total connections", String(stats.total_connections)],
                ["Active connections", String(stats.active_connections)],
                ["Claimed connections", String(stats.claimed_connections)],
                ["Total bootstraps", String(stats.total_bootstraps)],
                ["Total grants", String(stats.total_grants)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// ── Webhook secret rotation ─────────────────────────────────────────────

platformCommand
    .command("rotate-webhook-secret <appId>")
    .description("Rotate the webhook secret for a platform app")
    .option("--json", "Output as JSON")
    .action(async (appId, opts) => {
        try {
            requireToken();
            const result = await api<{ webhook_secret: string }>(
                `/platform/apps/${appId}/rotate-webhook-secret`,
                { method: "POST" },
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess("Webhook secret rotated.");
            console.log();
            console.log(
                chalk.yellow(
                    "  Save this webhook secret — it won't be shown again:",
                ),
            );
            console.log(`  ${chalk.bold(result.webhook_secret)}`);
            console.log();
        } catch (err) {
            handleError(err);
        }
    });

// ── Platform delegation commands ────────────────────────────────────────

platformCommand
    .command("resources <connectionId>")
    .description("List all platform-managed resources for a connection")
    .option("--json", "Output raw JSON")
    .hook("preAction", () => { requireToken(); })
    .action(async (connectionId: string, opts: { json?: boolean }) => {
        try {
            const result = await api<Record<string, unknown[]>>(
                `/platform/connections/${connectionId}/resources`,
                { headers: { "X-Platform-Connection": connectionId } },
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            for (const [type, items] of Object.entries(result)) {
                if (Array.isArray(items) && items.length > 0) {
                    console.log(chalk.bold(`\n${type} (${items.length})`));
                    for (const item of items) {
                        const rec = item as Record<string, unknown>;
                        console.log(
                            `  ${rec.id}${rec.name ? ` — ${rec.name}` : ""}`,
                        );
                    }
                }
            }
        } catch (err) {
            handleError(err);
        }
    });

platformCommand
    .command("delegation-log <connectionId>")
    .description("View the delegation audit log for a connection")
    .option("--limit <n>", "Max entries", "20")
    .option("--offset <n>", "Skip entries", "0")
    .option("--json", "Output raw JSON")
    .hook("preAction", () => { requireToken(); })
    .action(
        async (
            connectionId: string,
            opts: { limit: string; offset: string; json?: boolean },
        ) => {
            try {
                const result = await api<{
                    entries: Array<{
                        id: string;
                        action: string;
                        resource_type?: string;
                        resource_id?: string;
                        success: boolean;
                        created_at: string;
                    }>;
                    total: number;
                }>(
                    `/platform/connections/${connectionId}/delegation-log?limit=${opts.limit}&offset=${opts.offset}`,
                );

                if (opts.json) {
                    printJson(result);
                    return;
                }

                if (result.entries.length === 0) {
                    console.log("No delegation log entries.");
                    return;
                }

                printTable(
                    result.entries.map((e) => ({
                        action: e.action,
                        resource: e.resource_type
                            ? `${e.resource_type}/${e.resource_id ?? ""}`
                            : "—",
                        success: e.success ? "✓" : "✗",
                        date: formatDate(e.created_at),
                    })),
                    [
                        { key: "action", header: "Action", width: 24 },
                        { key: "resource", header: "Resource", width: 30 },
                        { key: "success", header: "Success", width: 8 },
                        { key: "date", header: "Date", width: 20 },
                    ],
                );
                console.log(chalk.dim(`Total: ${result.total}`));
            } catch (err) {
                handleError(err);
            }
        },
    );

platformCommand
    .command("exec")
    .description(
        "Execute a CLI command in the delegated context of a platform connection",
    )
    .requiredOption("--connection <id>", "Connection ID to delegate through")
    .argument(
        "[command...]",
        "CLI subcommand to run (e.g. agent create --name bot)",
    )
    .allowUnknownOption(true)
    .passThroughOptions()
    .action(async (commandParts: string[], opts: { connection: string }) => {
        try {
            requireToken();
            const parts =
                commandParts[0] === "--" ? commandParts.slice(1) : commandParts;
            if (parts.length === 0) {
                console.error(
                    chalk.red(
                        "Usage: 1claw platform exec --connection <id> -- <command> [args...]\n" +
                            'Example: 1claw platform exec --connection abc -- agent list',
                    ),
                );
                process.exit(1);
            }

            const { spawn } = await import("node:child_process");
            const cliEntry = process.argv[1];
            const child = spawn(
                process.execPath,
                [cliEntry, ...parts],
                {
                    stdio: "inherit",
                    env: {
                        ...process.env,
                        ONECLAW_PLATFORM_CONNECTION: opts.connection,
                    },
                },
            );

            child.on("exit", (code, signal) => {
                if (signal) {
                    process.kill(process.pid, signal);
                    return;
                }
                process.exit(code ?? 1);
            });
            child.on("error", (err) => {
                console.error(chalk.red(`Failed to spawn command: ${err.message}`));
                process.exit(1);
            });
        } catch (err) {
            handleError(err);
        }
    });
