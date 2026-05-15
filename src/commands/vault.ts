import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { setDefaultVaultId, getDefaultVaultId } from "../config.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printInfo,
    printJson,
    formatDate,
} from "../output.js";

interface Vault {
    id: string;
    name: string;
    description: string;
    created_at: string;
    secret_count?: number;
}

export const vaultCommand = new Command("vault").description("Manage vaults");

vaultCommand
    .command("list")
    .alias("ls")
    .description("List all vaults")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ vaults: Vault[] }>("/vaults");
            const vaults = res.vaults ?? [];

            if (opts.json) {
                printJson(vaults);
                return;
            }

            const defaultId = getDefaultVaultId();
            printTable(
                vaults.map((v) => ({
                    ...v,
                    name:
                        v.id === defaultId
                            ? `${v.name} ${chalk.green("(linked)")}`
                            : v.name,
                    created: formatDate(v.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 30 },
                    { key: "description", header: "Description", width: 30 },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

vaultCommand
    .command("create <name>")
    .description("Create a new vault")
    .option("-d, --description <desc>", "Vault description")
    .action(async (name, opts) => {
        try {
            requireToken();
            const vault = await api<Vault>("/vaults", {
                method: "POST",
                body: { name, description: opts.description ?? "" },
            });
            printSuccess(
                `Vault created: ${chalk.bold(vault.name)} (${vault.id})`,
            );
        } catch (err) {
            handleError(err);
        }
    });

vaultCommand
    .command("get <id>")
    .description("Get vault details")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const vault = await api<Vault>(`/vaults/${id}`);

            if (opts.json) {
                printJson(vault);
                return;
            }

            printKeyValue([
                ["ID", vault.id],
                ["Name", vault.name],
                ["Description", vault.description || chalk.dim("(none)")],
                ["Created", formatDate(vault.created_at, "long")],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

vaultCommand
    .command("delete <id>")
    .description("Delete a vault")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete vault ${id}? This cannot be undone.`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/vaults/${id}`, { method: "DELETE" });
            printSuccess("Vault deleted.");
        } catch (err) {
            handleError(err);
        }
    });

vaultCommand
    .command("link <id>")
    .description(
        "Link current directory to a vault (used as default for other commands)",
    )
    .action(async (id) => {
        try {
            requireToken();
            const vault = await api<Vault>(`/vaults/${id}`);
            setDefaultVaultId(id);
            printSuccess(
                `Linked to vault ${chalk.bold(vault.name)} (${id}). This is now the default vault.`,
            );
        } catch (err) {
            handleError(err);
        }
    });

vaultCommand
    .command("unlink")
    .description("Remove the default vault link")
    .action(() => {
        setDefaultVaultId("");
        printSuccess("Default vault unlinked.");
    });
