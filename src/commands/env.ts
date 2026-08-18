import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printSuccess,
    printInfo,
    printWarning,
    printError,
    printKeyValue,
    printTable,
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
    variables: Record<string, string>;
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
    const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
    });
    return new Promise((resolve) => {
        const origWrite = process.stderr.write;
        let masking = false;
        // Suppress echo so typed characters aren't visible
        process.stderr.write = function (
            this: NodeJS.WriteStream,
            ...args: Parameters<typeof origWrite>
        ): boolean {
            if (masking && typeof args[0] === "string") {
                return origWrite.call(this, "*" as never) as boolean;
            }
            return origWrite.apply(this, args as never) as boolean;
        } as typeof origWrite;
        process.stderr.write(prompt);
        masking = true;
        rl.question("", (answer) => {
            masking = false;
            process.stderr.write = origWrite;
            process.stderr.write("\n");
            rl.close();
            resolve(answer);
        });
    });
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
                values = response.variables;
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
            const lines = content
                .split("\n")
                .filter((l) => l.trim() && !l.trim().startsWith("#"));

            if (env) {
                const spinner = ora("Pushing env vars…").start();
                let count = 0;
                const sensitive = opts.sensitive ?? (env === "production" || env === "preview");

                for (const line of lines) {
                    const eqIdx = line.indexOf("=");
                    if (eqIdx <= 0) continue;
                    const key = line.slice(0, eqIdx).trim();
                    const value = line
                        .slice(eqIdx + 1)
                        .trim()
                        .replace(/^["']|["']$/g, "");

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
                    `Pushed ${lines.length} variables from ${chalk.bold(file)} to ${chalk.bold(opts.path)}`,
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

// --- env run ---

envCommand
    .command("run <command...>")
    .description(
        "Run a command with vault secrets injected as environment variables",
    )
    .option("-v, --vault <id>", "Vault ID")
    .option("-e, --environment <env>", "Target environment (production, preview, development)")
    .option("--prefix <prefix>", "Only inject secrets under this path prefix")
    .option("--no-cache", "Skip local cache, always fetch from API")
    .action(async (commandParts, opts) => {
        try {
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
                    envVars = response.variables;
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
    .option("--sensitive", "Mark as sensitive (write-only)")
    .option("--no-sensitive", "Explicitly not sensitive")
    .action(async (key, environment, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const env = validateEnvironment(environment);

            const environments = env ? [env] : DEFAULT_ENVIRONMENTS;

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
