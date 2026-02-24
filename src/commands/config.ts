import { Command } from "commander";
import chalk from "chalk";
import {
    getApiUrl,
    setApiUrl,
    getOutputFormat,
    setOutputFormat,
    getDefaultVaultId,
    setDefaultVaultId,
    getConfigPath,
} from "../config.js";
import { printKeyValue, printSuccess, printError } from "../output.js";

const KEYS: Record<
    string,
    { get: () => string | null; set: (v: string) => void; desc: string }
> = {
    "api-url": {
        get: getApiUrl,
        set: setApiUrl,
        desc: "API base URL",
    },
    "output-format": {
        get: getOutputFormat,
        set: (v) => {
            if (!["table", "json", "plain"].includes(v)) {
                printError("Must be one of: table, json, plain");
                process.exit(1);
            }
            setOutputFormat(v as "table" | "json" | "plain");
        },
        desc: "Default output format (table, json, plain)",
    },
    "default-vault": {
        get: getDefaultVaultId,
        set: setDefaultVaultId,
        desc: "Default vault ID",
    },
};

export const configCommand = new Command("config").description(
    "View and update CLI configuration",
);

configCommand
    .command("list")
    .alias("ls")
    .description("Show all configuration values")
    .action(() => {
        printKeyValue([
            ["Config file", getConfigPath()],
            ["api-url", getApiUrl()],
            ["output-format", getOutputFormat()],
            ["default-vault", getDefaultVaultId() ?? chalk.dim("(none)")],
        ]);
    });

configCommand
    .command("get <key>")
    .description("Get a configuration value")
    .action((key) => {
        const entry = KEYS[key];
        if (!entry) {
            printError(
                `Unknown key: ${key}. Valid keys: ${Object.keys(KEYS).join(", ")}`,
            );
            process.exit(1);
        }
        const value = entry.get();
        console.log(value ?? "");
    });

configCommand
    .command("set <key> <value>")
    .description("Set a configuration value")
    .action((key, value) => {
        const entry = KEYS[key];
        if (!entry) {
            printError(
                `Unknown key: ${key}. Valid keys: ${Object.keys(KEYS).join(", ")}`,
            );
            process.exit(1);
        }
        entry.set(value);
        printSuccess(`${key} = ${value}`);
    });
