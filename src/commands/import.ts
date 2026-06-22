import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printTable,
} from "../output.js";

interface EnvEntry {
    key: string;
    value: string;
    line: number;
}

function parseEnvFile(content: string): EnvEntry[] {
    const entries: EnvEntry[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();

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

        // Handle inline comments (only for unquoted values)
        if (!raw.slice(eqIdx + 1).trim().startsWith('"') && !raw.slice(eqIdx + 1).trim().startsWith("'")) {
            const commentIdx = value.indexOf(" #");
            if (commentIdx >= 0) {
                value = value.slice(0, commentIdx).trim();
            }
        }

        if (value.startsWith('"')) {
            value = value
                .replace(/\\n/g, "\n")
                .replace(/\\r/g, "\r")
                .replace(/\\t/g, "\t")
                .replace(/\\\\/g, "\\");
        }

        entries.push({ key, value, line: i + 1 });
    }

    return entries;
}

export const importCommand = new Command("import")
    .description("Import secrets from a .env file into a 1Claw vault")
    .argument("<file>", "Path to .env file to import")
    .option("-v, --vault <id>", "Vault ID")
    .option(
        "-p, --prefix <prefix>",
        "Path prefix for imported secrets (e.g. project/)",
    )
    .option("--dry-run", "Show what would be imported without writing")
    .option("--force", "Overwrite existing secrets")
    .option(
        "-t, --type <type>",
        "Secret type for imported entries",
        "api_key",
    )
    .action(async (file, opts) => {
        try {
            await runImport(file, opts);
        } catch (err) {
            handleError(err);
        }
    });

async function runImport(
    file: string,
    opts: {
        vault?: string;
        prefix?: string;
        dryRun?: boolean;
        force?: boolean;
        type?: string;
    },
): Promise<void> {
    if (!opts.dryRun) {
        requireToken();
    }

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

    const prefix = opts.prefix
        ? opts.prefix.endsWith("/")
            ? opts.prefix
            : opts.prefix + "/"
        : "";

    console.log();
    printInfo(
        `Found ${chalk.bold(String(entries.length))} variable${entries.length > 1 ? "s" : ""} in ${chalk.bold(file)}`,
    );
    console.log();

    printTable(
        entries.map((e) => ({
            key: e.key,
            path: prefix + e.key,
            preview: maskValue(e.value),
        })),
        [
            { key: "key", header: "Variable" },
            { key: "path", header: "Vault Path" },
            { key: "preview", header: "Value Preview" },
        ],
    );
    console.log();

    if (opts.dryRun) {
        printInfo("Dry run — no secrets were written.");
        return;
    }

    const vaultId = resolveVaultId(opts);

    // Check for existing secrets
    const spinner = ora("Checking for existing secrets...").start();
    let existingPaths: Set<string>;
    try {
        const secrets = await api<{ path: string }[]>(
            `/vaults/${vaultId}/secrets`,
        );
        existingPaths = new Set(secrets.map((s) => s.path));
    } catch {
        existingPaths = new Set();
    }
    spinner.stop();

    const toImport: EnvEntry[] = [];
    const skipped: string[] = [];

    for (const entry of entries) {
        const path = prefix + entry.key;
        if (existingPaths.has(path) && !opts.force) {
            skipped.push(path);
        } else {
            toImport.push(entry);
        }
    }

    if (skipped.length > 0) {
        printWarning(
            `Skipping ${skipped.length} existing secret${skipped.length > 1 ? "s" : ""} (use --force to overwrite):`,
        );
        for (const p of skipped) {
            console.log(`  ${chalk.dim("○")} ${p}`);
        }
        console.log();
    }

    if (toImport.length === 0) {
        printInfo("No new secrets to import.");
        return;
    }

    const importSpinner = ora(
        `Importing ${toImport.length} secret${toImport.length > 1 ? "s" : ""}...`,
    ).start();

    let imported = 0;
    let failed = 0;

    for (const entry of toImport) {
        const path = prefix + entry.key;
        try {
            await api(
                `/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`,
                {
                    method: "PUT",
                    body: {
                        value: entry.value,
                        secret_type: opts.type ?? "api_key",
                    },
                },
            );
            imported++;
        } catch (err) {
            failed++;
            importSpinner.stop();
            printError(
                `Failed to import ${path}: ${(err as Error).message}`,
            );
            importSpinner.start();
        }
    }

    importSpinner.stop();

    if (imported > 0) {
        printSuccess(
            `Imported ${imported} secret${imported > 1 ? "s" : ""} to vault ${chalk.dim(vaultId)}`,
        );
    }
    if (failed > 0) {
        printWarning(`${failed} secret${failed > 1 ? "s" : ""} failed to import.`);
    }
    console.log();
}

function maskValue(value: string): string {
    if (value.length <= 4) return "****";
    if (value.length <= 8) return value.slice(0, 2) + "****";
    return value.slice(0, 4) + "****" + value.slice(-2);
}
