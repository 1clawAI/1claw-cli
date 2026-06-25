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
import { existsSync } from "node:fs";
import {
    dockerStop,
    dockerStart,
    dockerRestart,
    dockerRun,
    dockerRm,
    dockerContainerStatus,
    dockerLogs,
} from "../lib/docker-client.js";
import {
    listContainerStates,
    loadContainerState,
    saveContainerState,
    deleteContainerState,
    isPortAvailable,
    findAvailablePort,
    type ContainerState,
} from "../lib/container-config.js";

/**
 * Recreate a container that no longer exists in Docker (status "absent") from
 * its saved run spec. Re-checks the host port and updates persisted state.
 */
async function recreateFromSpec(state: ContainerState): Promise<void> {
    if (!state.runSpec) {
        printError(
            `Cannot recreate "${state.containerName}" — no saved run spec ` +
                `(it was created by an older CLI).`,
        );
        printInfo("Re-create it with:  1claw init --docker");
        process.exit(1);
    }
    const socketHost = Object.keys(state.runSpec.volumes).find((h) =>
        h.endsWith(".sock"),
    );
    if (socketHost && !existsSync(socketHost)) {
        printWarning(
            `Daemon socket not found at ${socketHost}. The container needs it for ` +
                `credentials — start it first:  1claw daemon start`,
        );
    }
    let port = state.port;
    if (!(await isPortAvailable(port))) {
        const next = await findAvailablePort(port + 1);
        printWarning(`Port ${port} busy — using ${next}.`);
        port = next;
    }
    const id = await dockerRun({
        image: state.runSpec.image,
        name: state.containerName,
        ports: { [String(port)]: state.runSpec.containerPort },
        volumes: state.runSpec.volumes,
        env: state.runSpec.env,
        detach: true,
        restart: state.runSpec.restart,
        labels: state.runSpec.labels,
    });
    state.containerId = id;
    state.port = port;
    saveContainerState(state);
    printSuccess(`Recreated and started ${state.containerName} (${id.slice(0, 12)}).`);
    printInfo(`Chat UI: http://localhost:${port}`);
}

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
    .command("start <name>")
    .description("Start a stopped container (recreates it if it was removed)")
    .action(async (name: string) => {
        const state = loadContainerState(name);
        if (!state) {
            printError(`No container state for "${name}".`);
            process.exit(1);
        }
        const status = await dockerContainerStatus(state.containerName);
        try {
            if (status.running) {
                printInfo(`${name} is already running.`);
                printInfo(`Chat UI: http://localhost:${state.port}`);
                return;
            }
            if (status.exists) {
                await dockerStart(state.containerName);
                printSuccess(`Started ${name}.`);
                printInfo(`Chat UI: http://localhost:${state.port}`);
                return;
            }
            // Absent — recreate from the saved run spec.
            await recreateFromSpec(state);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

containersCommand
    .command("restart <name>")
    .description("Restart a container (recreates it if it was removed)")
    .action(async (name: string) => {
        const state = loadContainerState(name);
        if (!state) {
            printError(`No container state for "${name}".`);
            process.exit(1);
        }
        const status = await dockerContainerStatus(state.containerName);
        try {
            if (status.exists) {
                await dockerRestart(state.containerName);
                printSuccess(`Restarted ${name}.`);
                printInfo(`Chat UI: http://localhost:${state.port}`);
                return;
            }
            await recreateFromSpec(state);
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
