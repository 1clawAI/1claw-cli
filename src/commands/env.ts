import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { api, ApiError } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printSuccess,
    printInfo,
    printWarning,
    printError,
    printKeyValue,
    printTable,
    printJson,
    formatDate,
} from "../output.js";
import {
    writeCache,
    readCache,
    clearCache,
    getCacheInfo,
    getCachePath,
    isCacheValid,
} from "../local-cache.js";
import { getToken } from "../config.js";
import { promptHiddenValue } from "../lib/hidden-input.js";
import { parseEnv } from "../lib/env-file.js";
import { defaultEnvFile, loadEnvFile } from "../lib/env-source.js";
import { readEnvelope } from "../lib/env-file.js";
import { formatEnvNames, scanEnvNames, writeEnvNamesJson } from "../lib/env-names.js";
import { readAgentKey, readProject, writeProject, type ProjectBinding, type ProjectFile } from "../lib/project.js";
import { ensureAppAgent, type AppSpec } from "../lib/project-setup.js";
import { credentialFromValue } from "./binding.js";
import { agentJwtSource, cloudBindingForwarder, listenProxy, newProxyToken } from "./binding-proxy.js";

interface SecretMetadata {
    path: string;
    type: string;
}

interface Secret {
    path: string;
    value: string;
    type: string;
}

interface SecretListResponse {
    secrets: SecretMetadata[];
}

interface EnvVar {
    key: string;
    value?: string;
    environments: string[];
    sensitive: boolean;
    updated_at?: string;
}

interface EnvVarListResponse {
    env_vars: EnvVar[];
}

interface EnvResolveResponse {
    vars: Record<string, string>;
    sources?: Record<string, string>;
    environment?: string;
}

const DEFAULT_ENVIRONMENTS = ["production", "preview", "development"];

function validateEnvironment(env: string | undefined): string | undefined {
    if (!env) return undefined;
    return env;
}

async function readStdinIfPiped(): Promise<string | null> {
    if (process.stdin.isTTY) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8").trimEnd();
}

async function promptMaskedValue(prompt: string): Promise<string> {
    return promptHiddenValue(prompt);
}

async function confirm(message: string): Promise<boolean> {
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
    });
    return new Promise((resolve) => {
        rl.question(`${message} (y/N) `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}

async function fetchLegacyEnvVars(
    vaultId: string,
    prefix?: string,
): Promise<Record<string, string>> {
    const query: Record<string, string> = {};
    if (prefix) query.prefix = prefix;

    const response = await api<SecretListResponse>(
        `/vaults/${vaultId}/secrets`,
        { query },
    );

    const secrets = response.secrets;
    const envSecrets = secrets.filter(
        (s) =>
            s.type === "env_bundle" ||
            s.type === "api_key" ||
            s.type === "password",
    );

    const values: Record<string, string> = {};
    for (const s of envSecrets) {
        const detail = await api<Secret>(
            `/vaults/${vaultId}/secrets/${encodeURIComponent(s.path)}`,
        );

        if (s.type === "env_bundle") {
            for (const line of detail.value.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eqIdx = trimmed.indexOf("=");
                if (eqIdx > 0) {
                    values[trimmed.slice(0, eqIdx).trim()] = trimmed
                        .slice(eqIdx + 1)
                        .trim()
                        .replace(/^["']|["']$/g, "");
                }
            }
        } else {
            const envKey = s.path.replace(/[/-]/g, "_").toUpperCase();
            values[envKey] = detail.value;
        }
    }
    return values;
}

export const envCommand = new Command("env").description(
    "Environment variable management for CI/CD",
);

// --- env pull ---

envCommand
    .command("pull")
    .description("Pull secrets from a vault as environment variables")
    .option("-v, --vault <id>", "Vault ID")
    .option("-e, --environment <env>", "Target environment (production, preview, development)")
    .option("--prefix <prefix>", "Only pull secrets under this path prefix")
    .option(
        "-f, --format <format>",
        "Output format: dotenv, json, shell",
        "dotenv",
    )
    .option("-o, --output <file>", "Write to file instead of stdout")
    .action(async (opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(opts.environment);

            const spinner = ora("Fetching secrets…").start();

            let values: Record<string, string>;

            if (env) {
                const response = await api<EnvResolveResponse>(
                    `/vaults/${vaultId}/env-vars/resolve`,
                    { query: { environment: env } },
                );
                values = response.vars;
            } else {
                values = await fetchLegacyEnvVars(vaultId, opts.prefix);
            }

            spinner.stop();

            let output: string;
            switch (opts.format) {
                case "json":
                    output = JSON.stringify(values, null, 2) + "\n";
                    break;
                case "shell":
                    output =
                        Object.entries(values)
                            .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
                            .join("\n") + "\n";
                    break;
                case "dotenv":
                default:
                    output =
                        Object.entries(values)
                            .map(
                                ([k, v]) =>
                                    `${k}=${v.includes(" ") ? `"${v}"` : v}`,
                            )
                            .join("\n") + "\n";
                    break;
            }

            if (opts.output) {
                await writeFile(opts.output, output);
                printSuccess(
                    `Wrote ${Object.keys(values).length} variables to ${opts.output}`,
                );
            } else {
                process.stdout.write(output);
            }
        } catch (err) {
            handleError(err);
        }
    });

// --- env push ---

envCommand
    .command("push <file>")
    .description("Push a .env file to vault as env vars or an env_bundle secret")
    .option("-v, --vault <id>", "Vault ID")
    .option("-p, --path <path>", "Secret path in vault (legacy mode)", "config/env")
    .option("-e, --environment <env>", "Target environment (production, preview, development)")
    .option("--sensitive", "Mark all vars as sensitive")
    .option("--no-sensitive", "Mark all vars as not sensitive")
    .action(async (file, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(opts.environment);

            const content = await readFile(file, "utf-8");
            const entries = parseEnv(content);

            if (env) {
                const spinner = ora("Pushing env vars…").start();
                let count = 0;
                const sensitive = opts.sensitive ?? (env === "production" || env === "preview");

                for (const { key, value } of entries) {
                    await api(`/vaults/${vaultId}/env-vars`, {
                        method: "POST",
                        body: {
                            key,
                            value,
                            environments: [env],
                            sensitive,
                        },
                    });
                    count++;
                }

                spinner.stop();
                printSuccess(
                    `Pushed ${count} env vars from ${chalk.bold(file)} to ${chalk.bold(env)}`,
                );
            } else {
                await api(
                    `/vaults/${vaultId}/secrets/${encodeURIComponent(opts.path)}`,
                    {
                        method: "PUT",
                        body: { value: content, type: "env_bundle" },
                    },
                );

                printSuccess(
                    `Pushed ${entries.length} variables from ${chalk.bold(file)} to ${chalk.bold(opts.path)}`,
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

// --- env import ---

export interface PlannedBinding {
    name: string;
    base_url: string;
    allowed_hosts?: string[];
    /** The app's variable holding the API's URL; `env run` points it at the local proxy. */
    url_env?: string;
    auth_type?: "bearer" | "header" | "query" | "oauth2";
    auth_header?: string;
    auth_param?: string;
}

/** Per-variable routing, as written by an agent that has only seen the names. */
interface ImportPlan {
    /** Set up the whole app: create its agent, write `.env`, and remove the encrypted file when done. */
    app?: AppSpec;
    vars?: Record<
        string,
        {
            to?: "env" | "secret" | "binding" | "skip";
            /** For `to: "binding"`: the API this key calls. 1Claw adds the key, only for these hosts. */
            binding?: PlannedBinding;
            environments?: string[];
            sensitive?: boolean;
            /** For `to: "secret"`: the vault path (default `<secret-prefix>/<KEY>`). */
            path?: string;
            comment?: string;
        }
    >;
}

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,255}$/;

export interface ImportRoute {
    key: string;
    to: "env" | "secret" | "binding" | "skip";
    binding?: PlannedBinding;
    environments: string[];
    sensitive: boolean;
    path?: string;
    comment?: string;
    why?: string;
}

/** Decide where each name goes. Pure, so it can be tested and shown in --dry-run. */
export function routeImport(
    names: string[],
    opts: { environments: string[]; sensitive?: boolean; secrets: string[]; secretPrefix: string; skip: string[]; only: string[]; plan?: ImportPlan },
): ImportRoute[] {
    const bindingUrlVars = new Set(Object.values(opts.plan?.vars ?? {}).map((v) => v.binding?.url_env).filter(Boolean));
    return names.map((key) => {
        const planned = opts.plan?.vars?.[key] ?? {};
        if (bindingUrlVars.has(key)) {
            return { key, to: "skip" as const, environments: [], sensitive: false, why: "binding URL" };
        }
        let to: ImportRoute["to"] = planned.to ?? (opts.secrets.includes(key) ? "secret" : "env");
        let why: string | undefined;
        if (opts.only.length && !opts.only.includes(key)) {
            to = "skip";
            why = "not in --only";
        } else if (opts.skip.includes(key)) {
            to = "skip";
            why = "--skip";
        } else if (planned.to === "skip") {
            why = "plan";
        }
        const environments = planned.environments ?? opts.environments;
        // Sensitive (write-only) by default, except where the API refuses it: a development-only var.
        const devOnly = environments.length === 1 && environments[0] === "development";
        const sensitive = planned.sensitive ?? opts.sensitive ?? !devOnly;
        if (to === "env" && !ENV_KEY_RE.test(key)) {
            to = "skip";
            why = "env var names must be UPPER_SNAKE_CASE; route it with to: secret in a --plan";
        }
        const path = to === "secret" ? planned.path ?? `${opts.secretPrefix.replace(/\/$/, "")}/${key}` : undefined;
        if (to === "binding" && !planned.binding?.name) throw new Error(`${key}: to "binding" needs binding.name and binding.base_url in the plan`);
        return { key, to, binding: planned.binding, environments, sensitive, path, comment: planned.comment, why };
    });
}

/** The binding's host allowlist: what the plan says, else just the host of its base URL. */
const hostsOf = (b: PlannedBinding): string[] => (b.allowed_hosts?.length ? b.allowed_hosts : [new URL(b.base_url).hostname]);

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

envCommand
    .command("names [dir]")
    .description("List the env vars a project uses, by name, without reading any value (safe for an agent to run)")
    .option("--json [file]", "Write the report as JSON to a file, or print it")
    .action((dir: string | undefined, opts: { json?: string | boolean }) => {
        try {
            const report = scanEnvNames(dir ?? ".");
            if (typeof opts.json === "string") writeEnvNamesJson(report, opts.json);
            if (opts.json === true) printJson(report);
            else console.log(formatEnvNames(report));
        } catch (err) {
            handleError(err);
        }
    });

envCommand
    .command("import [file]")
    .description("Send an env file's values to your vault without printing them (safe for an agent to run)")
    .option("-v, --vault <id>", "Vault ID")
    .option("-e, --environment <envs>", "Environments for env vars, comma-separated", "production")
    .option("--readable", "Store env vars readable (default: write-only, except development-only vars)")
    .option("--secrets <keys>", "Store these keys as vault secrets instead of env vars, for bindings to point at")
    .option("--secret-prefix <prefix>", "Vault path prefix for --secrets", "bindings")
    .option("--skip <keys>", "Leave these keys out")
    .option("--only <keys>", "Import only these keys")
    .option("--plan <file>", "JSON routing per key: {\"vars\": {\"KEY\": {\"to\": \"env\"|\"secret\"|\"skip\", \"environments\": [...], \"path\": \"...\"}}}")
    .option("--overwrite", "Replace values that already exist in the vault")
    .option("--keep-encrypted", "With \"app\" in the plan: keep the encrypted file and its key afterwards")
    .option("--dry-run", "Show where each name would go; send nothing")
    .option("--json", "Output as JSON")
    .addHelpText(
        "after",
        `
Reads .env.1claw (made by \`1claw ignore\`) when present, else .env. Values go
from the file to the vault inside this process; output has names only.

Env vars are what your app reads at startup (\`1claw env run -e production -- <cmd>\`).
Secrets are what bindings point at, so an agent can call an API without the key:
  1claw env import --secrets STRIPE_KEY,TELEGRAM_TOKEN
  1claw agent binding create <agent> --name stripe --type http \\
      --config '{"base_url":"https://api.stripe.com"}' \\
      --guardrails '{"allowed_hosts":["api.stripe.com"]}' \\
      --credential-from-env STRIPE_KEY`,
    )
    .action(async (file: string | undefined, opts) => {
        try {
            const source = file ?? defaultEnvFile();
            if (!opts.dryRun) requireToken();
            let plan: ImportPlan | undefined;
            if (opts.plan) plan = JSON.parse(await readFile(opts.plan, "utf-8")) as ImportPlan;

            const loaded = await loadEnvFile(source);
            const routes = routeImport(
                loaded.entries.map((e) => e.key),
                {
                    environments: list(opts.environment),
                    sensitive: opts.readable ? false : undefined,
                    secrets: list(opts.secrets),
                    secretPrefix: opts.secretPrefix,
                    skip: list(opts.skip),
                    only: list(opts.only),
                    plan,
                },
            );
            const values = new Map(loaded.entries.map((e) => [e.key, e.value]));
            const results: { key: string; destination: string; result: string }[] = [];

            const vaultId = opts.dryRun ? undefined : resolveVaultId(opts);
            const app = plan?.app;
            if (app && !opts.dryRun && !loaded.encrypted) {
                throw new Error(`${loaded.file} is not encrypted. Run 1claw ignore first.`);
            }
            const agent = app && vaultId ? await ensureAppAgent(vaultId, app) : undefined;
            const existingBindings = agent
                ? new Set((await api<{ bindings?: { name: string }[] }>(`/agents/${agent.id}/bindings`)).bindings?.map((b) => b.name))
                : new Set<string>();
            const madeBindings: ProjectBinding[] = [];
            // With "app" the file is the source of truth, so a re-run finishes the job instead of stopping at "exists".
            const overwrite = Boolean(opts.overwrite || agent);
            let existingEnv = new Map<string, boolean>();
            let existingSecrets = new Set<string>();
            if (vaultId) {
                const vars = await api<EnvVarListResponse>(`/vaults/${vaultId}/env-vars`);
                existingEnv = new Map(vars.env_vars.map((v) => [v.key, v.sensitive]));
                if (routes.some((r) => r.to === "secret")) {
                    const secrets = await api<SecretListResponse>(`/vaults/${vaultId}/secrets`);
                    existingSecrets = new Set(secrets.secrets.map((s) => s.path));
                }
            }

            const spinner = opts.dryRun || opts.json || !process.stderr.isTTY ? null : ora("Importing…").start();
            for (const r of routes) {
                const destination =
                    r.to === "binding" ? `binding ${r.binding!.name} (${hostsOf(r.binding!).join(", ")} only)` :
                    r.to === "env" ? `env var (${r.environments.join(", ")}${r.sensitive ? ", sensitive" : ""})` : r.to === "secret" ? `secret ${r.path}` : "—";
                if (r.to === "skip") {
                    results.push({ key: r.key, destination, result: `skipped (${r.why})` });
                    continue;
                }
                if (opts.dryRun || !vaultId) {
                    results.push({ key: r.key, destination, result: "would import" });
                    continue;
                }
                const value = values.get(r.key) ?? "";
                try {
                    if (r.to === "binding") {
                        const b = r.binding!;
                        if (!agent) throw new Error(`a binding needs "app" in the plan`);
                        madeBindings.push({ name: b.name, url_env: b.url_env, key_env: r.key });
                        // A copy of the key left as an env var would hand the app the very key the binding hides.
                        const dropOldCopies = async () => {
                            for (const old of [r.key, b.url_env]) {
                                if (old && existingEnv.has(old)) await api(`/vaults/${vaultId}/env-vars/${encodeURIComponent(old)}`, { method: "DELETE" });
                            }
                        };
                        if (existingBindings.has(b.name)) {
                            await dropOldCopies();
                            results.push({ key: r.key, destination, result: "exists" });
                            continue;
                        }
                        const config: Record<string, unknown> = { base_url: b.base_url };
                        if (b.auth_type) config.auth_type = b.auth_type;
                        if (b.auth_header) config.auth_header = b.auth_header;
                        if (b.auth_param) config.auth_param = b.auth_param;
                        await api(`/agents/${agent.id}/bindings`, {
                            method: "POST",
                            body: {
                                name: b.name,
                                binding_type: "http",
                                config,
                                guardrails: { allowed_hosts: hostsOf(b) },
                                credential: credentialFromValue(value, "http", config),
                            },
                        });
                        await dropOldCopies();
                        results.push({ key: r.key, destination, result: "created" });
                    } else if (r.to === "secret") {
                        if (existingSecrets.has(r.path!) && !overwrite) {
                            results.push({ key: r.key, destination, result: "exists (use --overwrite)" });
                            continue;
                        }
                        await api(`/vaults/${vaultId}/secrets/${encodeURIComponent(r.path!)}`, {
                            method: "PUT",
                            body: { type: "api_key", value, metadata: { source: loaded.file, env_key: r.key } },
                        });
                        results.push({ key: r.key, destination, result: existingSecrets.has(r.path!) ? "updated" : "created" });
                    } else if (existingEnv.has(r.key)) {
                        if (!overwrite) {
                            results.push({ key: r.key, destination, result: "exists (use --overwrite)" });
                            continue;
                        }
                        await api(`/vaults/${vaultId}/env-vars/${encodeURIComponent(r.key)}`, {
                            method: "PATCH",
                            // The API refuses to make a sensitive var readable again, so it stays sensitive.
                            body: { value, environments: r.environments, sensitive: r.sensitive || existingEnv.get(r.key), ...(r.comment ? { comment: r.comment } : {}) },
                        });
                        results.push({ key: r.key, destination, result: "updated" });
                    } else {
                        await api(`/vaults/${vaultId}/env-vars`, {
                            method: "POST",
                            body: { key: r.key, value, environments: r.environments, sensitive: r.sensitive, ...(r.comment ? { comment: r.comment } : {}) },
                        });
                        results.push({ key: r.key, destination, result: "created" });
                    }
                } catch (err) {
                    // The API's message, never the value.
                    results.push({ key: r.key, destination, result: `failed: ${(err as Error).message}` });
                }
            }
            spinner?.stop();
            values.clear();

            // The whole app: remember its bindings, and retire the encrypted file once nothing depends on it.
            let retired = false;
            const failed = results.some((r) => r.result.startsWith("failed"));
            const leftOut = routes.filter((r) => r.to === "skip" && r.why !== "binding URL").map((r) => r.key);
            if (agent && vaultId) {
                const root = readProject()?.root ?? process.cwd();
                writeProject(root, { bindings: madeBindings });
                if (!failed && !leftOut.length && !opts.keepEncrypted) {
                    const envelope = readEnvelope(loaded.file);
                    await api(`/vaults/${envelope.key.vault_id}/secrets/${encodeURIComponent(envelope.key.path)}`, { method: "DELETE" });
                    unlinkSync(loaded.file);
                    retired = true;
                }
            }

            if (opts.json) {
                printJson({ file: loaded.file, encrypted: loaded.encrypted, results });
                return;
            }
            console.log();
            printInfo(`${chalk.bold(loaded.file)}${loaded.encrypted ? " (encrypted)" : ""}: ${loaded.entries.length} variables`);
            console.log();
            printTable(results, [
                { key: "key", header: "Name" },
                { key: "destination", header: "To" },
                { key: "result", header: "Result" },
            ]);
            console.log();
            if (opts.dryRun) printInfo("Dry run: nothing was sent.");
            else if (results.some((r) => r.result.startsWith("failed"))) printWarning("Some variables failed; the rest were imported.");
            else printSuccess("Done. No values were printed.");
            if (agent && !opts.dryRun) {
                if (agent.created) printSuccess(`Agent ${chalk.bold(agent.name)} created, with access to this vault`);
                if (retired) printSuccess(`${chalk.bold(loaded.file)} and its key removed`);
                else if (leftOut.length) printWarning(`Kept ${loaded.file}: it still holds ${leftOut.join(", ")}, which the plan left out.`);
                printSuccess(`${chalk.bold(".env")} now holds only this app's access key`);
                printInfo(`Run your app: ${chalk.bold("1claw env run -- <start command>")}`);
            }
        } catch (err) {
            handleError(err);
        }
    });

// --- env run ---

/**
 * Start the app as itself: its agent key gets a short-lived token, the token gets
 * the vault's env vars, and each binding gets a local proxy. The child gets the
 * values and the proxy URLs, not the key or the token, and no personal login is used.
 */
async function runAsApp(project: ProjectFile, agentKey: string, commandParts: string[], environment?: string): Promise<void> {
    const agentId = project.agent_id!;
    const jwt = agentJwtSource(agentId, agentKey);
    let token: string;
    try {
        token = await jwt();
    } catch (err) {
        if (err instanceof ApiError && err.status < 500) throw new Error("1Claw refused this app's key: it was revoked or is wrong.");
        throw err;
    }
    const env = environment ?? project.environment ?? "production";
    const { vars } = await api<EnvResolveResponse>(`/vaults/${project.vault_id}/env-vars/resolve`, { query: { environment: env }, token });

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...vars };
    for (const name of ["ONECLAW_AGENT_API_KEY", "ONECLAW_AGENT_ID", "ONECLAW_TOKEN", "ONECLAW_API_KEY"]) delete childEnv[name];
    const proxied: string[] = [];
    for (const b of project.bindings ?? []) {
        const proxyToken = newProxyToken();
        const base = await new Promise<string>((resolve) =>
            listenProxy({ forward: cloudBindingForwarder(agentId, agentKey, b.name, jwt), verbose: false, token: proxyToken }, "127.0.0.1", 0, resolve),
        );
        if (b.url_env) childEnv[b.url_env] = base;
        if (b.key_env) childEnv[b.key_env] = proxyToken;
        proxied.push(b.name);
    }
    const names = Object.keys(vars).length;
    printSuccess(
        `Running as ${chalk.bold(project.agent_name ?? agentId)}: ${names} env var${names === 1 ? "" : "s"} from the vault` +
            (proxied.length ? `, binding${proxied.length === 1 ? "" : "s"} ${proxied.join(", ")}` : ""),
    );
    const [cmd, ...args] = commandParts;
    const child = spawn(cmd, args, { stdio: "inherit", env: childEnv });
    child.on("exit", (code) => process.exit(code ?? 1));
}

envCommand
    .command("run <command...>")
    .description(
        "Run a command with vault secrets injected as environment variables; in a project set up by env import, runs as its agent and starts its binding proxies",
    )
    .option("-v, --vault <id>", "Vault ID")
    .option("-e, --environment <env>", "Target environment (production, preview, development)")
    .option("--prefix <prefix>", "Only inject secrets under this path prefix")
    .option("--no-cache", "Skip local cache, always fetch from API")
    .action(async (commandParts, opts) => {
        try {
            const project = readProject();
            if (project?.data.agent_id && !opts.vault) {
                const agentKey = readAgentKey(project.root);
                if (agentKey) return await runAsApp(project.data, agentKey, commandParts, opts.environment);
                if (project.data.bindings?.length) throw new Error("No ONECLAW_AGENT_API_KEY in .env");
            }
            const token = requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(opts.environment);

            let envVars: Record<string, string> | null = null;
            let source = "api";

            if (!env && opts.cache !== false) {
                const cached = readCache(token, vaultId);
                if (cached) {
                    envVars = cached;
                    source = "cache";
                }
            }

            if (!envVars) {
                const spinner = ora("Loading secrets…").start();

                if (env) {
                    const response = await api<EnvResolveResponse>(
                        `/vaults/${vaultId}/env-vars/resolve`,
                        { query: { environment: env } },
                    );
                    envVars = response.vars;
                } else {
                    envVars = await fetchLegacyEnvVars(vaultId, opts.prefix);
                }

                spinner.stop();
            }

            const count = Object.keys(envVars).length;
            const sourceLabel =
                source === "cache" ? chalk.dim("(cached)") : chalk.dim("(api)");
            printSuccess(
                `Loaded ${count} secrets ${sourceLabel}. Running command…`,
            );

            const [cmd, ...args] = commandParts;
            const child = spawn(cmd, args, {
                stdio: "inherit",
                env: { ...process.env, ...envVars },
            });

            child.on("exit", (code) => {
                process.exit(code ?? 1);
            });
        } catch (err) {
            handleError(err);
        }
    });

// --- env ls ---

envCommand
    .command("ls [environment]")
    .description("List env vars for the vault")
    .option("-v, --vault <id>", "Vault ID")
    .action(async (environment, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(environment);

            const spinner = ora("Fetching env vars…").start();
            const query: Record<string, string> = {};
            if (env) query.environment = env;

            const response = await api<EnvVarListResponse>(
                `/vaults/${vaultId}/env-vars`,
                { query },
            );
            spinner.stop();

            const vars = response.env_vars;
            if (vars.length === 0) {
                printInfo(
                    env
                        ? `No env vars found for ${chalk.bold(env)}.`
                        : "No env vars found.",
                );
                return;
            }

            const rows = vars.map((v) => ({
                key: v.key,
                environments: v.environments.join(", "),
                sensitive: v.sensitive ? "Yes" : "No",
                updated: formatDate(v.updated_at),
            }));

            printTable(rows, [
                { key: "key", header: "KEY", width: 24 },
                { key: "environments", header: "ENVIRONMENTS", width: 22 },
                { key: "sensitive", header: "SENSITIVE", width: 10 },
                { key: "updated", header: "UPDATED" },
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// --- env add ---

envCommand
    .command("add <key> [environment]")
    .description("Add an env var to the vault")
    .option("-v, --vault <id>", "Vault ID")
    .option("--all", "Write to production, preview and development at once")
    .option("--sensitive", "Mark as sensitive (write-only)")
    .option("--no-sensitive", "Explicitly not sensitive")
    .action(async (key, environment, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(environment);

            // Without -e this used to write to production, preview and
            // development at once — the same default that put local .env values
            // into production from the dashboard importer. Ask instead of
            // guessing wide; --all is there for the case where that is meant.
            let environments: string[];
            if (env) {
                environments = [env];
            } else if (opts.all) {
                environments = [...DEFAULT_ENVIRONMENTS];
            } else {
                throw new Error(
                    "Specify an environment (e.g. `1claw env add KEY development`), or pass --all " +
                        "to write to production, preview and development at once.",
                );
            }

            let sensitive: boolean;
            if (opts.sensitive === true) {
                sensitive = true;
            } else if (opts.sensitive === false) {
                sensitive = false;
            } else {
                sensitive = env === "production" || env === "preview";
            }

            const piped = await readStdinIfPiped();
            let value: string;
            if (piped !== null) {
                value = piped;
            } else {
                value = await promptMaskedValue(
                    `Enter value for ${chalk.bold(key)}: `,
                );
                if (!value) {
                    printError("Value cannot be empty.");
                    process.exit(1);
                }
            }

            const spinner = ora("Adding env var…").start();
            await api(`/vaults/${vaultId}/env-vars`, {
                method: "POST",
                body: {
                    key,
                    value,
                    environments,
                    sensitive,
                },
            });
            spinner.stop();

            printSuccess(
                `Added ${chalk.bold(key)} → ${chalk.dim(environments.join(", "))}` +
                    (sensitive ? chalk.dim(" (sensitive)") : ""),
            );
        } catch (err) {
            handleError(err);
        }
    });

// --- env rm ---

envCommand
    .command("set <key>")
    .description("Change which environments an existing env var applies to")
    .option("-v, --vault <id>", "Vault ID")
    .requiredOption(
        "-e, --environments <list>",
        "Comma-separated environments the variable should apply to (e.g. production,preview)",
    )
    .option("--branch <name>", "Git branch scope (only valid alongside preview)")
    .option("--no-branch", "Clear the git branch scope")
    .option("--comment <text>", "Update the comment")
    .option("--json", "Output as JSON")
    .action(async (key, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            const environments = String(opts.environments)
                .split(",")
                .map((e: string) => e.trim())
                .filter(Boolean);
            if (environments.length === 0) {
                throw new Error(
                    "At least one environment is required — a variable in none of them cannot be read by anything.",
                );
            }

            // git_branch only means something alongside preview. Send null to
            // clear it rather than omitting the field, which would leave the old
            // branch in place and make the next write fail validation.
            const body: Record<string, unknown> = { environments };
            if (opts.branch === false) {
                body.git_branch = null;
            } else if (typeof opts.branch === "string") {
                if (!environments.includes("preview")) {
                    throw new Error("--branch is only valid when environments includes 'preview'.");
                }
                body.git_branch = opts.branch;
            } else if (!environments.includes("preview")) {
                // Dropping preview drops the branch with it.
                body.git_branch = null;
            }
            if (opts.comment !== undefined) body.comment = opts.comment;

            const spinner = ora("Updating env var…").start();
            const updated = await api(`/vaults/${vaultId}/env-vars/${encodeURIComponent(key)}`, {
                method: "PATCH",
                body,
            });
            spinner.stop();

            if (opts.json) {
                console.log(JSON.stringify(updated, null, 2));
                return;
            }
            printSuccess(`${key} now applies to ${chalk.bold(environments.join(", "))}`);
        } catch (err) {
            handleError(err);
        }
    });

envCommand
    .command("rm <key> [environment]")
    .description("Remove an env var from the vault")
    .option("-v, --vault <id>", "Vault ID")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (key, environment, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(environment);

            const target = env ?? "all environments";
            if (!opts.yes) {
                const ok = await confirm(
                    `Remove ${chalk.bold(key)} from ${chalk.bold(target)}?`,
                );
                if (!ok) {
                    printInfo("Cancelled.");
                    return;
                }
            }

            const spinner = ora("Removing env var…").start();
            const query: Record<string, string> = {};
            if (env) query.environment = env;

            await api(`/vaults/${vaultId}/env-vars/${encodeURIComponent(key)}`, {
                method: "DELETE",
                query,
            });
            spinner.stop();

            printSuccess(`Removed ${chalk.bold(key)} from ${chalk.bold(target)}.`);
        } catch (err) {
            handleError(err);
        }
    });

// --- Cache subcommands ---

envCommand
    .command("cache")
    .description(
        "Download vault secrets into an encrypted local cache for offline use",
    )
    .option("-v, --vault <id>", "Vault ID")
    .option("--prefix <prefix>", "Only cache secrets under this path prefix")
    .option("--ttl <seconds>", "Cache time-to-live in seconds", "3600")
    .action(async (opts) => {
        try {
            const token = requireToken();
            const vaultId = resolveVaultId(opts);

            const spinner = ora("Fetching secrets for local cache…").start();

            const values = await fetchLegacyEnvVars(vaultId, opts.prefix);

            const ttl = parseInt(opts.ttl, 10) || 3600;
            writeCache(token, vaultId, values, ttl);

            spinner.succeed(
                `Cached ${Object.keys(values).length} secrets locally (TTL: ${ttl}s)`,
            );
            printInfo(`Cache file: ${chalk.dim(getCachePath())}`);
        } catch (err) {
            handleError(err);
        }
    });

envCommand
    .command("cache-clear")
    .description("Clear the local secret cache")
    .action(() => {
        const cleared = clearCache();
        if (cleared) {
            printSuccess("Local secret cache cleared.");
        } else {
            printInfo("No cache to clear.");
        }
    });

envCommand
    .command("cache-status")
    .description("Show local cache status")
    .action(() => {
        const info = getCacheInfo();
        if (!info.exists) {
            printInfo("No local cache found. Run `1claw env cache` to create one.");
            return;
        }
        printKeyValue([
            ["Cache file", getCachePath()],
            ["Vault ID", info.meta?.vaultId ?? "unknown"],
            ["Cached at", info.meta?.cachedAt ?? "unknown"],
            ["TTL", `${info.meta?.ttlSeconds ?? 0}s`],
            ["Secrets", String(info.meta?.secretCount ?? 0)],
            ["Size", info.sizeBytes ? `${info.sizeBytes} bytes` : "unknown"],
            [
                "Status",
                info.expired
                    ? chalk.yellow("expired")
                    : chalk.green("valid"),
            ],
        ]);
    });

// --- env environments ---

interface VaultEnvironment {
    id: string;
    slug: string;
    description?: string;
    is_builtin: boolean;
    copied_from?: string;
    is_detached: boolean;
    created_at: string;
}

interface VaultEnvironmentListResponse {
    environments: VaultEnvironment[];
}

const environmentsCmd = envCommand
    .command("environments")
    .description("Manage vault environments");

environmentsCmd
    .command("ls")
    .description("List environments for the vault")
    .option("-v, --vault <id>", "Vault ID")
    .action(async (opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            const spinner = ora("Fetching environments…").start();
            const response = await api<VaultEnvironmentListResponse>(
                `/vaults/${vaultId}/environments`,
            );
            spinner.stop();

            const envs = response.environments;
            if (envs.length === 0) {
                printInfo("No environments found.");
                return;
            }

            const rows = envs.map((e) => ({
                slug: e.slug,
                type: e.is_builtin ? "built-in" : "custom",
                copied_from: e.copied_from ?? "-",
                created: formatDate(e.created_at),
            }));

            printTable(rows, [
                { key: "slug", header: "SLUG", width: 20 },
                { key: "type", header: "TYPE", width: 10 },
                { key: "copied_from", header: "COPIED FROM", width: 16 },
                { key: "created", header: "CREATED" },
            ]);
        } catch (err) {
            handleError(err);
        }
    });

environmentsCmd
    .command("add <slug>")
    .description("Create a custom environment")
    .option("-v, --vault <id>", "Vault ID")
    .option("-d, --description <desc>", "Environment description")
    .option("--copy-from <env>", "Copy env vars from an existing environment")
    .action(async (slug, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            const spinner = ora(`Creating environment "${slug}"…`).start();
            await api(`/vaults/${vaultId}/environments`, {
                method: "POST",
                body: {
                    slug,
                    description: opts.description,
                    copy_from: opts.copyFrom,
                },
            });
            spinner.stop();

            printSuccess(
                `Environment ${chalk.bold(slug)} created.` +
                    (opts.copyFrom
                        ? ` Variables copied from ${chalk.bold(opts.copyFrom)}.`
                        : ""),
            );
        } catch (err) {
            handleError(err);
        }
    });

environmentsCmd
    .command("rm <slug>")
    .description("Delete a custom environment")
    .option("-v, --vault <id>", "Vault ID")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (slug, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            if (!opts.yes) {
                const ok = await confirm(
                    `Delete environment ${chalk.bold(slug)}? This cannot be undone.`,
                );
                if (!ok) {
                    printInfo("Cancelled.");
                    return;
                }
            }

            const spinner = ora(`Deleting environment "${slug}"…`).start();
            await api(
                `/vaults/${vaultId}/environments/${encodeURIComponent(slug)}`,
                { method: "DELETE" },
            );
            spinner.stop();

            printSuccess(`Environment ${chalk.bold(slug)} deleted.`);
        } catch (err) {
            handleError(err);
        }
    });

function shellEscape(s: string): string {
    if (/^[a-zA-Z0-9._\-/:=@]+$/.test(s)) return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
