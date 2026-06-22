import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import { printSuccess, printInfo, printWarning, printKeyValue, printError } from "../output.js";
import {
    writeCache,
    readCache,
    clearCache,
    getCacheInfo,
    getCachePath,
    isCacheValid,
} from "../local-cache.js";
import { getToken } from "../config.js";

interface Secret {
    path: string;
    value: string;
    secret_type: string;
}

export const envCommand = new Command("env").description(
    "Environment variable management for CI/CD",
);

envCommand
    .command("pull")
    .description("Pull secrets from a vault as environment variables")
    .option("-v, --vault <id>", "Vault ID")
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

            const spinner = ora("Fetching secrets…").start();
            const query: Record<string, string> = {};
            if (opts.prefix) query.prefix = opts.prefix;

            const secrets = await api<{ path: string; secret_type: string }[]>(
                `/vaults/${vaultId}/secrets`,
                { query },
            );

            const envSecrets = secrets.filter(
                (s) =>
                    s.secret_type === "env_bundle" ||
                    s.secret_type === "api_key" ||
                    s.secret_type === "password",
            );

            const values: Record<string, string> = {};
            for (const s of envSecrets) {
                const detail = await api<Secret>(
                    `/vaults/${vaultId}/secrets/${encodeURIComponent(s.path)}`,
                );

                if (s.secret_type === "env_bundle") {
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

envCommand
    .command("push <file>")
    .description("Push a .env file to vault as an env_bundle secret")
    .option("-v, --vault <id>", "Vault ID")
    .option("-p, --path <path>", "Secret path in vault", "config/env")
    .action(async (file, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            const content = await readFile(file, "utf-8");
            const lineCount = content
                .split("\n")
                .filter((l) => l.trim() && !l.trim().startsWith("#")).length;

            await api(
                `/vaults/${vaultId}/secrets/${encodeURIComponent(opts.path)}`,
                {
                    method: "PUT",
                    body: { value: content, secret_type: "env_bundle" },
                },
            );

            printSuccess(
                `Pushed ${lineCount} variables from ${chalk.bold(file)} to ${chalk.bold(opts.path)}`,
            );
        } catch (err) {
            handleError(err);
        }
    });

envCommand
    .command("run <command...>")
    .description(
        "Run a command with vault secrets injected as environment variables",
    )
    .option("-v, --vault <id>", "Vault ID")
    .option("--prefix <prefix>", "Only inject secrets under this path prefix")
    .option("--no-cache", "Skip local cache, always fetch from API")
    .action(async (commandParts, opts) => {
        try {
            const token = requireToken();
            const vaultId = resolveVaultId(opts);

            let envVars: Record<string, string> | null = null;
            let source = "api";

            // Try local cache first (unless --no-cache)
            if (opts.cache !== false) {
                const cached = readCache(token, vaultId);
                if (cached) {
                    envVars = cached;
                    source = "cache";
                }
            }

            if (!envVars) {
                const spinner = ora("Loading secrets…").start();
                const query: Record<string, string> = {};
                if (opts.prefix) query.prefix = opts.prefix;

                const secrets = await api<{ path: string; secret_type: string }[]>(
                    `/vaults/${vaultId}/secrets`,
                    { query },
                );

                envVars = {};
                for (const s of secrets) {
                    if (
                        !["env_bundle", "api_key", "password"].includes(
                            s.secret_type,
                        )
                    )
                        continue;

                    const detail = await api<Secret>(
                        `/vaults/${vaultId}/secrets/${encodeURIComponent(s.path)}`,
                    );

                    if (s.secret_type === "env_bundle") {
                        for (const line of detail.value.split("\n")) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed.startsWith("#")) continue;
                            const eqIdx = trimmed.indexOf("=");
                            if (eqIdx > 0) {
                                envVars[trimmed.slice(0, eqIdx).trim()] = trimmed
                                    .slice(eqIdx + 1)
                                    .trim()
                                    .replace(/^["']|["']$/g, "");
                            }
                        }
                    } else {
                        envVars[s.path.replace(/[/-]/g, "_").toUpperCase()] =
                            detail.value;
                    }
                }

                spinner.stop();
            }

            const count = Object.keys(envVars).length;
            const sourceLabel = source === "cache" ? chalk.dim("(cached)") : chalk.dim("(api)");
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
            const query: Record<string, string> = {};
            if (opts.prefix) query.prefix = opts.prefix;

            const secrets = await api<{ path: string; secret_type: string }[]>(
                `/vaults/${vaultId}/secrets`,
                { query },
            );

            const envSecrets = secrets.filter(
                (s) =>
                    s.secret_type === "env_bundle" ||
                    s.secret_type === "api_key" ||
                    s.secret_type === "password",
            );

            const values: Record<string, string> = {};
            for (const s of envSecrets) {
                const detail = await api<Secret>(
                    `/vaults/${vaultId}/secrets/${encodeURIComponent(s.path)}`,
                );

                if (s.secret_type === "env_bundle") {
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

function shellEscape(s: string): string {
    if (/^[a-zA-Z0-9._\-/:=@]+$/.test(s)) return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}
