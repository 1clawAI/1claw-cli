import { Command } from "commander";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printTable,
    printKeyValue,
} from "../output.js";
import {
    vaultExists,
    createVault,
    loadVault,
    saveVault,
    addSecret,
    removeSecret,
    getSecret,
    listSecrets,
    markSynced,
    getVaultPath,
    getVaultInfo,
    deleteVault,
    exportAsEnv,
    fingerprintPassphrase,
    type LocalVaultData,
} from "../local-vault.js";

const MIN_PASSPHRASE_LENGTH = 8;

async function promptPassphrase(confirm = false): Promise<string> {
    const { passphrase } = await inquirer.prompt([
        {
            type: "password",
            name: "passphrase",
            message: "Vault passphrase:",
            mask: "*",
            validate: (v: string) =>
                v.length >= MIN_PASSPHRASE_LENGTH
                    ? true
                    : `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        },
    ]);

    if (confirm) {
        const { confirmed } = await inquirer.prompt([
            {
                type: "password",
                name: "confirmed",
                message: "Confirm passphrase:",
                mask: "*",
            },
        ]);
        if (passphrase !== confirmed) {
            printError("Passphrases do not match.");
            process.exit(1);
        }
    }

    return passphrase;
}

async function promptUnlock(): Promise<{ vault: LocalVaultData; passphrase: string }> {
    const passphrase = await promptPassphrase();
    try {
        const vault = loadVault(passphrase);
        return { vault, passphrase };
    } catch (err) {
        if (
            err instanceof Error &&
            (err.message.includes("Unsupported") || err.message.includes("bad decrypt") ||
             err.message.includes("unable to authenticate") || err.message.includes("auth"))
        ) {
            printError("Wrong passphrase or corrupted vault file.");
        } else if (err instanceof Error) {
            printError(err.message);
        }
        process.exit(1);
    }
}

function maskValue(value: string): string {
    if (value.length <= 4) return "****";
    if (value.length <= 8) return value.slice(0, 2) + "****";
    return value.slice(0, 4) + "****" + value.slice(-2);
}

export const localCommand = new Command("local").description(
    "Local encrypted vault — store secrets offline, optionally sync to cloud",
);

// ── init ─────────────────────────────────────────────────

localCommand
    .command("init")
    .description("Create a new local encrypted vault")
    .option("--force", "Overwrite existing vault")
    .action(async (opts) => {
        try {
            if (vaultExists() && !opts.force) {
                printWarning(
                    "Local vault already exists. Use --force to reinitialize (destroys existing secrets).",
                );
                return;
            }

            console.log();
            printInfo("Creating a new local vault.");
            printInfo("Choose a strong passphrase — it encrypts your secrets at rest.");
            console.log();

            const passphrase = await promptPassphrase(true);
            createVault(passphrase);

            const fp = fingerprintPassphrase(passphrase);
            printSuccess(`Local vault created at ${chalk.dim(getVaultPath())}`);
            printInfo(`Passphrase fingerprint: ${chalk.cyan(fp)}`);
            printInfo("Store your passphrase safely — it cannot be recovered.");
            console.log();
        } catch (err) {
            if (err instanceof Error) printError(err.message);
            else printError(String(err));
            process.exit(1);
        }
    });

// ── add ──────────────────────────────────────────────────

localCommand
    .command("add <name>")
    .description("Add or update a secret in the local vault")
    .option("-t, --type <type>", "Secret type", "api_key")
    .action(async (name, opts) => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault, passphrase } = await promptUnlock();

            const { value } = await inquirer.prompt([
                {
                    type: "password",
                    name: "value",
                    message: `Value for ${chalk.bold(name)}:`,
                    mask: "*",
                    validate: (v: string) => (v.length > 0 ? true : "Value cannot be empty"),
                },
            ]);

            const existed = !!vault.secrets[name];
            addSecret(vault, name, value, opts.type);
            saveVault(vault, passphrase);

            printSuccess(
                existed
                    ? `Updated ${chalk.bold(name)} in local vault.`
                    : `Added ${chalk.bold(name)} to local vault.`,
            );
        } catch (err) {
            handleError(err);
        }
    });

// ── list ─────────────────────────────────────────────────

localCommand
    .command("list")
    .alias("ls")
    .description("List secrets in the local vault (names only)")
    .action(async () => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault } = await promptUnlock();
            const secrets = listSecrets(vault);

            if (secrets.length === 0) {
                printInfo("Local vault is empty. Add secrets with `1claw local add <name>`.");
                return;
            }

            printTable(
                secrets.map((s) => ({
                    name: s.name,
                    type: s.type,
                    synced: s.synced ? chalk.green("yes") : chalk.dim("no"),
                    updated: s.updated_at.slice(0, 19).replace("T", " "),
                })),
                [
                    { key: "name", header: "Name" },
                    { key: "type", header: "Type" },
                    { key: "synced", header: "Synced" },
                    { key: "updated", header: "Updated" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

// ── get ──────────────────────────────────────────────────

localCommand
    .command("get <name>")
    .description("Retrieve a secret value from the local vault")
    .option("--masked", "Show masked value instead of raw")
    .action(async (name, opts) => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault } = await promptUnlock();
            const secret = getSecret(vault, name);

            if (!secret) {
                printError(`Secret "${name}" not found in local vault.`);
                process.exit(1);
            }

            if (opts.masked) {
                console.log(maskValue(secret.value));
            } else {
                process.stdout.write(secret.value);
                if (process.stdout.isTTY) process.stdout.write("\n");
            }
        } catch (err) {
            handleError(err);
        }
    });

// ── rm ───────────────────────────────────────────────────

localCommand
    .command("rm <name>")
    .alias("remove")
    .description("Remove a secret from the local vault")
    .action(async (name) => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault, passphrase } = await promptUnlock();
            const removed = removeSecret(vault, name);

            if (!removed) {
                printWarning(`Secret "${name}" not found.`);
                return;
            }

            saveVault(vault, passphrase);
            printSuccess(`Removed ${chalk.bold(name)} from local vault.`);
        } catch (err) {
            handleError(err);
        }
    });

// ── import ───────────────────────────────────────────────

localCommand
    .command("import <file>")
    .description("Import secrets from a .env file into the local vault")
    .option("-t, --type <type>", "Secret type for imported entries", "api_key")
    .option("--force", "Overwrite existing secrets")
    .option("--dry-run", "Show what would be imported without writing")
    .action(async (file, opts) => {
        try {
            let content: string;
            try {
                content = readFileSync(file, "utf-8");
            } catch {
                printError(`Cannot read file: ${file}`);
                process.exit(1);
            }

            const entries = parseEnvFile(content);
            if (entries.length === 0) {
                printWarning(`No valid environment variables found in ${file}`);
                return;
            }

            printInfo(
                `Found ${chalk.bold(String(entries.length))} variable${entries.length > 1 ? "s" : ""} in ${chalk.bold(file)}`,
            );

            printTable(
                entries.map((e) => ({
                    key: e.key,
                    preview: maskValue(e.value),
                })),
                [
                    { key: "key", header: "Variable" },
                    { key: "preview", header: "Value Preview" },
                ],
            );
            console.log();

            if (opts.dryRun) {
                printInfo("Dry run — no secrets were written.");
                return;
            }

            if (!vaultExists()) {
                printInfo("No local vault found — creating one now.");
                const passphrase = await promptPassphrase(true);
                createVault(passphrase);
                const vault = loadVault(passphrase);

                let imported = 0;
                let skipped = 0;
                for (const e of entries) {
                    if (vault.secrets[e.key] && !opts.force) {
                        skipped++;
                        continue;
                    }
                    addSecret(vault, e.key, e.value, opts.type);
                    imported++;
                }
                saveVault(vault, passphrase);
                printSuccess(`Imported ${imported} secret${imported > 1 ? "s" : ""} to local vault.`);
                if (skipped > 0) {
                    printWarning(`Skipped ${skipped} existing (use --force to overwrite).`);
                }
                return;
            }

            const { vault, passphrase } = await promptUnlock();

            let imported = 0;
            let skipped = 0;
            for (const e of entries) {
                if (vault.secrets[e.key] && !opts.force) {
                    skipped++;
                    continue;
                }
                addSecret(vault, e.key, e.value, opts.type);
                imported++;
            }

            saveVault(vault, passphrase);
            printSuccess(`Imported ${imported} secret${imported > 1 ? "s" : ""} to local vault.`);
            if (skipped > 0) {
                printWarning(`Skipped ${skipped} existing (use --force to overwrite).`);
            }
        } catch (err) {
            handleError(err);
        }
    });

// ── export ───────────────────────────────────────────────

localCommand
    .command("export")
    .description("Export local vault secrets as .env format")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .action(async (opts) => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault } = await promptUnlock();
            const output = exportAsEnv(vault);

            if (opts.output) {
                const { writeFileSync: wfs } = await import("node:fs");
                wfs(opts.output, output);
                printSuccess(`Exported ${Object.keys(vault.secrets).length} secrets to ${opts.output}`);
            } else {
                process.stdout.write(output);
            }
        } catch (err) {
            handleError(err);
        }
    });

// ── sync ─────────────────────────────────────────────────

localCommand
    .command("sync")
    .description("Sync local secrets to/from a cloud vault")
    .option("-v, --vault <id>", "Cloud vault ID")
    .option("--pull", "Pull cloud secrets into local vault (default: push)")
    .option("--force", "Overwrite on conflict instead of skipping")
    .action(async (opts) => {
        try {
            requireToken();

            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const { vault, passphrase } = await promptUnlock();
            const vaultId = resolveVaultId(opts);

            if (opts.pull) {
                await syncPull(vault, passphrase, vaultId, !!opts.force);
            } else {
                await syncPush(vault, passphrase, vaultId, !!opts.force);
            }
        } catch (err) {
            handleError(err);
        }
    });

async function syncPush(
    vault: LocalVaultData,
    passphrase: string,
    cloudVaultId: string,
    force: boolean,
): Promise<void> {
    const secrets = Object.entries(vault.secrets);
    if (secrets.length === 0) {
        printInfo("Local vault is empty — nothing to push.");
        return;
    }

    const toPush = force
        ? secrets
        : secrets.filter(([, s]) => !s.synced_to_cloud);

    if (toPush.length === 0) {
        printInfo("All local secrets are already synced.");
        return;
    }

    const spinner = ora(`Pushing ${toPush.length} secret(s) to cloud...`).start();
    let pushed = 0;
    let failed = 0;

    for (const [name, secret] of toPush) {
        try {
            await api(
                `/vaults/${cloudVaultId}/secrets/${encodeURIComponent(name)}`,
                {
                    method: "PUT",
                    body: { value: secret.value, secret_type: secret.type },
                },
            );
            markSynced(vault, name, cloudVaultId, name);
            pushed++;
        } catch (err) {
            failed++;
            spinner.stop();
            printError(`Failed to push ${name}: ${(err as Error).message}`);
            spinner.start();
        }
    }

    saveVault(vault, passphrase);
    spinner.stop();

    if (pushed > 0) {
        printSuccess(`Pushed ${pushed} secret(s) to vault ${chalk.dim(cloudVaultId)}`);
    }
    if (failed > 0) {
        printWarning(`${failed} secret(s) failed to push.`);
    }
}

async function syncPull(
    vault: LocalVaultData,
    passphrase: string,
    cloudVaultId: string,
    force: boolean,
): Promise<void> {
    const spinner = ora("Fetching secrets from cloud...").start();

    const cloudSecrets = await api<{ path: string; secret_type: string }[]>(
        `/vaults/${cloudVaultId}/secrets`,
    );

    let pulled = 0;
    let skipped = 0;

    for (const cs of cloudSecrets) {
        if (vault.secrets[cs.path] && !force) {
            skipped++;
            continue;
        }

        const detail = await api<{ value: string }>(
            `/vaults/${cloudVaultId}/secrets/${encodeURIComponent(cs.path)}`,
        );

        addSecret(vault, cs.path, detail.value, cs.secret_type);
        markSynced(vault, cs.path, cloudVaultId, cs.path);
        pulled++;
    }

    saveVault(vault, passphrase);
    spinner.stop();

    if (pulled > 0) {
        printSuccess(`Pulled ${pulled} secret(s) from cloud.`);
    }
    if (skipped > 0) {
        printInfo(`Skipped ${skipped} existing local secret(s) (use --force to overwrite).`);
    }
    if (pulled === 0 && skipped === 0) {
        printInfo("Cloud vault is empty.");
    }
}

// ── status ───────────────────────────────────────────────

localCommand
    .command("status")
    .description("Show local vault status")
    .action(async () => {
        try {
            const info = getVaultInfo();
            if (!info.exists) {
                printInfo("No local vault. Run `1claw local init` to create one.");
                return;
            }

            const { vault } = await promptUnlock();
            const secrets = listSecrets(vault);
            const synced = secrets.filter((s) => s.synced).length;

            printKeyValue([
                ["Vault file", info.path],
                ["File size", info.sizeBytes ? `${info.sizeBytes} bytes` : "unknown"],
                ["Created", vault.created_at.slice(0, 19).replace("T", " ")],
                ["Updated", vault.updated_at.slice(0, 19).replace("T", " ")],
                ["Secrets", String(secrets.length)],
                [
                    "Synced to cloud",
                    synced > 0
                        ? chalk.green(`${synced}/${secrets.length}`)
                        : chalk.dim("0"),
                ],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// ── destroy ──────────────────────────────────────────────

/**
 * Best-effort: stop a running local daemon and clean up its socket/PID so a
 * stale process isn't left holding the vault we're about to delete. Does NOT
 * require the passphrase — this is the recovery path for a forgotten one.
 */
function stopDaemonForReset(): void {
    const configDir =
        process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
    const pidFile = join(configDir, "daemon.pid");
    const socketPath =
        process.env.ONECLAW_DAEMON_SOCKET || join(configDir, "daemon.sock");

    if (existsSync(pidFile)) {
        try {
            const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
            if (pid) {
                try {
                    process.kill(pid, "SIGTERM");
                    printInfo(`Stopped running daemon (PID ${pid}).`);
                } catch {
                    /* already gone */
                }
            }
        } catch {
            /* unreadable pid file */
        }
        try { unlinkSync(pidFile); } catch { /* ok */ }
    }
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ok */ }
}

localCommand
    .command("destroy")
    .alias("reset")
    .description(
        "Permanently delete the local vault (recovery for a forgotten passphrase — no passphrase required)",
    )
    .option("-f, --force", "Skip the confirmation prompt")
    .action(async (opts) => {
        try {
            if (!vaultExists()) {
                printInfo("No local vault to destroy.");
                // Still clean up any stale daemon socket/PID.
                stopDaemonForReset();
                return;
            }

            if (!opts.force) {
                const { confirm } = await inquirer.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: chalk.red(
                            "This will permanently delete your local vault and ALL secrets in it. This cannot be undone. Continue?",
                        ),
                        default: false,
                    },
                ]);

                if (!confirm) {
                    printInfo("Cancelled.");
                    return;
                }
            }

            // Stop any daemon holding the old vault before deleting it.
            stopDaemonForReset();

            deleteVault();
            printSuccess("Local vault destroyed.");
            printInfo(
                "Create a fresh one with `1claw local init`, or just re-run `1claw init --docker --local`.",
            );
        } catch (err) {
            if (err instanceof Error) printError(err.message);
            else printError(String(err));
            process.exit(1);
        }
    });

// ── .env parser (shared with import.ts) ──────────────────

interface EnvEntry {
    key: string;
    value: string;
}

function parseEnvFile(content: string): EnvEntry[] {
    const entries: EnvEntry[] = [];
    const lines = content.split("\n");

    for (const rawLine of lines) {
        const raw = rawLine.trim();
        if (!raw || raw.startsWith("#")) continue;

        let line = raw;
        if (line.startsWith("export ")) {
            line = line.slice(7).trim();
        }

        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;

        const key = line.slice(0, eqIdx).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        let value = line.slice(eqIdx + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        entries.push({ key, value });
    }

    return entries;
}
