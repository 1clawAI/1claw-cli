import { Command } from "commander";
import chalk from "chalk";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printTable,
    printKeyValue,
    formatDate,
} from "../output.js";
import {
    dockerStop,
    dockerRm,
    dockerContainerStatus,
    dockerLogs,
} from "../lib/docker-client.js";
import {
    listContainerStates,
    loadContainerState,
    deleteContainerState,
} from "../lib/container-config.js";

export const containersCommand = new Command("containers").description(
    "Manage agent containers created by `1claw init`",
);

containersCommand
    .command("list")
    .alias("ls")
    .description("List managed agent containers")
    .action(async () => {
        const states = listContainerStates();
        if (states.length === 0) {
            printInfo("No managed containers. Create one with `1claw init --docker`.");
            return;
        }
        const rows = [];
        for (const s of states) {
            const status = await dockerContainerStatus(s.containerName);
            rows.push({
                name: s.containerName,
                status: status.running
                    ? chalk.green(status.health ?? "running")
                    : status.exists
                      ? chalk.yellow(status.status ?? "stopped")
                      : chalk.dim("absent"),
                port: String(s.port),
                modules: s.modules.join(",") || chalk.dim("none"),
                image: s.customImage ?? s.image,
                created: formatDate(s.createdAt),
            });
        }
        printTable(rows, [
            { key: "name", header: "Name", width: 22 },
            { key: "status", header: "Status" },
            { key: "port", header: "Port" },
            { key: "modules", header: "Modules", width: 20 },
            { key: "image", header: "Image", width: 26 },
            { key: "created", header: "Created" },
        ]);
    });

containersCommand
    .command("info <name>")
    .description("Show details for a managed container")
    .action(async (name: string) => {
        const state = loadContainerState(name);
        if (!state) {
            printError(`No container state for "${name}".`);
            process.exit(1);
        }
        const status = await dockerContainerStatus(name);
        printKeyValue([
            ["Name", state.containerName],
            ["Status", status.running ? "running" : status.exists ? (status.status ?? "stopped") : "absent"],
            ["Health", status.health ?? "—"],
            ["Chat UI", `http://localhost:${state.port}`],
            ["Agent ID", state.agentId ?? "—"],
            ["Vault ID", state.vaultId ?? "—"],
            ["Modules", state.modules.join(", ") || "none"],
            ["Image", state.customImage ?? state.image],
            ["Published", state.publishedAt ? formatDate(state.publishedAt, "long") : "—"],
            ["Created", formatDate(state.createdAt, "long")],
        ]);
    });

containersCommand
    .command("stop <name>")
    .description("Stop a running container")
    .action(async (name: string) => {
        const state = loadContainerState(name);
        if (!state) {
            printError(`No container state for "${name}".`);
            process.exit(1);
        }
        try {
            await dockerStop(state.containerName);
            printSuccess(`Stopped ${name}.`);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

containersCommand
    .command("rm <name>")
    .description("Remove a container and its local state")
    .option("-f, --force", "Force-remove a running container")
    .action(async (name: string, opts: { force?: boolean }) => {
        const state = loadContainerState(name);
        if (!state) {
            printWarning(`No state for "${name}" — nothing to remove.`);
            return;
        }
        try {
            const status = await dockerContainerStatus(state.containerName);
            if (status.exists) {
                await dockerRm(state.containerName, !!opts.force);
            }
        } catch (err) {
            printError(
                `Could not remove container (use -f to force): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            process.exit(1);
        }
        deleteContainerState(name);
        printSuccess(`Removed ${name} and its state.`);
    });

containersCommand
    .command("logs <name>")
    .description("Tail a container's logs")
    .option("--no-follow", "Print current logs and exit")
    .action(async (name: string, opts: { follow?: boolean }) => {
        const state = loadContainerState(name);
        if (!state) {
            printError(`No container state for "${name}".`);
            process.exit(1);
        }
        const status = await dockerContainerStatus(state.containerName);
        if (!status.exists) {
            printError(`Container "${name}" does not exist.`);
            process.exit(1);
        }
        const child = dockerLogs(state.containerName, opts.follow !== false);
        await new Promise<void>((resolve) => {
            process.on("SIGINT", () => {
                child.kill();
                resolve();
            });
            child.on("close", () => resolve());
        });
    });
