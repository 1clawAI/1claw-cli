import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { api } from "../client.js";
import { parseEnv } from "../lib/env-file.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printTable,
} from "../output.js";

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

    const entries = parseEnv(content);

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
            length: `${e.value.length} chars`,
        })),
        [
            { key: "key", header: "Variable" },
            { key: "path", header: "Vault Path" },
            // Never a preview: the first and last characters of a key are
            // exactly what an agent running this command should not see.
            { key: "length", header: "Value" },
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
        const res = await api<{ secrets: { path: string }[] }>(
            `/vaults/${vaultId}/secrets`,
        );
        existingPaths = new Set((res.secrets ?? []).map((s) => s.path));
    } catch {
        existingPaths = new Set();
    }
    spinner.stop();

    const toImport: typeof entries = [];
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
                        type: opts.type ?? "api_key",
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
