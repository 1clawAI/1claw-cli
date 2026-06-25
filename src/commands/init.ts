import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { api } from "../client.js";
import { getToken } from "../config.js";
import { loginWithDevice } from "../auth.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printKeyValue,
    printTable,
} from "../output.js";
import {
    vaultExists,
    createVault,
    loadVault,
    saveVault,
    addSecret,
} from "../local-vault.js";
import {
    loadPolicy,
    savePolicy,
    setSecretPolicy,
} from "../local-policy.js";
import {
    dockerAvailable,
    dockerDaemonError,
    dockerRun,
    dockerContainerStatus,
    dockerLogs,
} from "../lib/docker-client.js";
import {
    ensureBaseImage,
    buildModuleImage,
    DEFAULT_BASE_IMAGE,
} from "../lib/image-build.js";
import {
    listModules,
    resolveModules,
    type ModuleManifest,
} from "../modules/registry.js";
import {
    generateContainerName,
    isValidContainerName,
    sanitizeName,
    loadContainerState,
    saveContainerState,
    findAvailablePort,
    MANAGED_LABEL,
    type ContainerState,
} from "../lib/container-config.js";
import {
    daemonSocketPath,
    daemonHealthy,
    startDaemonDetached,
} from "../lib/daemon-control.js";

interface InitOptions {
    docker?: string | boolean;
    module?: string[];
    listModules?: boolean;
    port: string;
    name?: string;
    local?: boolean;
    agentKey?: string;
    detach?: boolean;
}

export const initCommand = new Command("init")
    .description("Initialize a secure agent runtime in a Docker container")
    .option("--docker [image]", "Run in Docker container (default: 1claw/agent:stable)")
    .option(
        "--module <names...>",
        "Add modules (comma-separated or repeated): ampersend, onchain, langchain, elizaos, scaffold-agent",
    )
    .option("--list-modules", "List all available modules and exit")
    .option("--port <port>", "Chat UI port", "3000")
    .option("--name <name>", "Container name (default: auto-generated)")
    .option("--local", "Fully offline — no cloud provisioning")
    .option("--agent-key <key>", "Use an existing agent key (skip provisioning)")
    .option("--detach", "Run the container in the background")
    .action(async (opts: InitOptions) => {
        try {
            await initAction(opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function parseModuleNames(input: string[] | undefined): string[] {
    if (!input) return [];
    const names: string[] = [];
    for (const entry of input) {
        for (const part of entry.split(",")) {
            const trimmed = part.trim();
            if (trimmed) names.push(trimmed);
        }
    }
    return [...new Set(names)];
}

function printModuleList(): void {
    const modules = listModules();
    console.log();
    console.log(chalk.bold("  Available modules:"));
    console.log();
    if (modules.length === 0) {
        printInfo("No modules bundled.");
        return;
    }
    printTable(
        modules.map((m) => ({
            name: m.name,
            description: m.description.replace(/\s+/g, " ").slice(0, 60),
            author: m.author,
        })),
        [
            { key: "name", header: "Module", width: 16 },
            { key: "description", header: "Description", width: 62 },
            { key: "author", header: "Author" },
        ],
    );
    console.log();
    console.log(
        chalk.dim(
            "  Usage: 1claw init --docker --module=ampersend --module=onchain\n" +
                "     or: 1claw init --docker --module=ampersend,onchain",
        ),
    );
    console.log();
}

interface ProvisionResult {
    agentId: string;
    apiKey: string;
    vaultId: string;
    vaultName: string;
}

async function provisionCloudResources(
    containerName: string,
): Promise<ProvisionResult> {
    const sid = sanitizeName(containerName);

    const agentSpinner = ora("Provisioning agent...").start();
    let agentId: string;
    let apiKey: string;
    try {
        const res = await api<
            | { id: string; api_key?: string }
            | { agent: { id: string }; api_key?: string }
        >("/agents", {
            method: "POST",
            body: {
                name: `docker-agent-${sid}`.slice(0, 60),
                description: "Created by `1claw init --docker`",
                shroud_enabled: true,
                intents_api_enabled: true,
                auth_method: "api_key",
            },
        });
        agentId = "agent" in res ? res.agent.id : res.id;
        if (!res.api_key) {
            agentSpinner.fail("Agent created but no API key returned.");
            throw new Error("No agent API key returned by the API.");
        }
        apiKey = res.api_key;
        agentSpinner.succeed(`Agent provisioned (${agentId.slice(0, 8)}…)`);
    } catch (err) {
        agentSpinner.fail("Failed to provision agent.");
        throw err;
    }

    const vaultSpinner = ora("Creating vault...").start();
    let vaultId: string;
    let vaultName: string;
    try {
        const vault = await api<{ id: string; name: string }>("/vaults", {
            method: "POST",
            body: {
                name: `docker-vault-${sid}`.slice(0, 60),
                description: "Created by `1claw init --docker`",
            },
        });
        vaultId = vault.id;
        vaultName = vault.name;
        vaultSpinner.succeed(`Vault created (${vaultName})`);
    } catch (err) {
        vaultSpinner.fail("Failed to create vault.");
        throw err;
    }

    const policySpinner = ora("Binding vault and granting read policy...").start();
    try {
        await api(`/agents/${agentId}`, {
            method: "PATCH",
            body: { vault_ids: [vaultId] },
        });
        await api(`/vaults/${vaultId}/policies`, {
            method: "POST",
            body: {
                principal_type: "agent",
                principal_id: agentId,
                secret_path_pattern: "secrets/*",
                permissions: ["read"],
            },
        });
        policySpinner.succeed("Vault bound; read policy on secrets/* granted.");
    } catch (err) {
        policySpinner.fail("Failed to bind vault / create policy.");
        throw err;
    }

    return { agentId, apiKey, vaultId, vaultName };
}

async function resolvePassphrase(confirm: boolean): Promise<string> {
    if (process.env.ONECLAW_VAULT_PASSPHRASE) {
        return process.env.ONECLAW_VAULT_PASSPHRASE;
    }
    const { passphrase } = await inquirer.prompt([
        {
            type: "password",
            name: "passphrase",
            message: "Local vault passphrase:",
            mask: "*",
            validate: (v: string) =>
                v.length >= 8 ? true : "Passphrase must be at least 8 characters",
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
            throw new Error("Passphrases do not match.");
        }
    }
    return passphrase;
}

/**
 * Ensure a local vault exists, optionally store the agent key + daemon policy,
 * and make sure the daemon is running so the container can reach it.
 */
async function ensureDaemonRunning(opts: {
    storeKey?: { localVaultPath: string; apiKey: string };
}): Promise<string> {
    const socketPath = daemonSocketPath();
    const alreadyRunning = await daemonHealthy(socketPath);

    // We need the passphrase to create/unlock the vault for key storage and/or
    // to start the daemon. If the daemon is already running and we have nothing
    // to store, we can skip vault work entirely.
    const needVaultWrite = !!opts.storeKey;
    const needStart = !alreadyRunning;

    if (!needVaultWrite && !needStart) {
        return socketPath;
    }

    const creatingVault = !vaultExists();
    let passphrase: string | undefined;

    if (needVaultWrite || needStart) {
        if (creatingVault) {
            printInfo("No local vault found — creating one for the daemon.");
            passphrase = await resolvePassphrase(true);
            createVault(passphrase);
        } else {
            passphrase = await resolvePassphrase(false);
        }
    }

    if (needVaultWrite && passphrase) {
        let vault;
        try {
            vault = loadVault(passphrase);
        } catch {
            throw new Error("Wrong passphrase or corrupted local vault.");
        }
        addSecret(
            vault,
            opts.storeKey!.localVaultPath,
            opts.storeKey!.apiKey,
            "api_key",
        );
        saveVault(vault, passphrase);

        // Allow the daemon to inject this key toward the 1Claw API only.
        const policy = loadPolicy();
        setSecretPolicy(policy, opts.storeKey!.localVaultPath, {
            allowed_hosts: ["api.1claw.xyz", "*.1claw.xyz"],
            inject_as: "bearer",
        });
        savePolicy(policy);
    }

    if (needStart) {
        if (!passphrase) passphrase = await resolvePassphrase(false);
        const spinner = ora("Starting local daemon...").start();
        const ok = await startDaemonDetached(passphrase, socketPath);
        if (!ok) {
            spinner.fail("Daemon did not become ready in time.");
            throw new Error(
                "Failed to start the daemon. Try `1claw daemon start` manually.",
            );
        }
        spinner.succeed(`Daemon running on ${socketPath}`);
    } else {
        printInfo(`Reusing running daemon at ${socketPath}`);
    }

    return socketPath;
}

async function waitForHealthy(port: number, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://localhost:${port}/health`;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

async function initAction(opts: InitOptions): Promise<void> {
    if (opts.listModules) {
        printModuleList();
        return;
    }

    console.log();
    console.log(chalk.bold("  1Claw — Secure Agent Runtime"));
    console.log();

    // ── Step 1: Preflight ────────────────────────────────────────────────
    if (!(await dockerAvailable())) {
        const reason = await dockerDaemonError();
        throw new Error(
            reason ??
                "Docker is required. Install Docker Desktop: https://docs.docker.com/get-docker/",
        );
    }

    // ── Modules ──────────────────────────────────────────────────────────
    const moduleNames = parseModuleNames(opts.module);
    let modules: ModuleManifest[] = [];
    if (moduleNames.length) {
        modules = resolveModules(moduleNames);
        printInfo(
            `Modules: ${modules.map((m) => m.name).join(", ")}` +
                (modules.length > moduleNames.length
                    ? chalk.dim("  (incl. dependencies)")
                    : ""),
        );
    }

    // ── Container identity ───────────────────────────────────────────────
    const containerName = opts.name ?? generateContainerName();
    if (!isValidContainerName(containerName)) {
        throw new Error(
            `Invalid container name "${containerName}". Use letters, digits, _, ., -.`,
        );
    }
    if (loadContainerState(containerName)) {
        throw new Error(
            `A container named "${containerName}" already exists in state. ` +
                `Use --name to choose another, or remove it with \`1claw containers rm ${containerName}\`.`,
        );
    }
    const existing = await dockerContainerStatus(containerName);
    if (existing.exists) {
        throw new Error(
            `A Docker container named "${containerName}" already exists. ` +
                `Remove it (\`docker rm -f ${containerName}\`) or choose --name.`,
        );
    }

    // ── Step 2/3: Auth + provisioning ────────────────────────────────────
    let agentId: string | null = null;
    let vaultId: string | null = null;
    let agentApiKey: string | null = opts.agentKey ?? null;
    let localVaultPath: string | null = null;

    if (opts.local) {
        printInfo("Local mode — no cloud account or provisioning.");
    } else if (agentApiKey) {
        printInfo("Using provided --agent-key (skipping provisioning).");
    } else {
        if (!getToken()) {
            printInfo("You need to log in to provision cloud resources.");
            const { shouldLogin } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "shouldLogin",
                    message: "Log in now? (choose No to run offline with --local)",
                    default: true,
                },
            ]);
            if (!shouldLogin) {
                throw new Error(
                    "Not authenticated. Re-run with --local for offline mode, or `1claw login`.",
                );
            }
            const auth = await loginWithDevice();
            if (!auth) throw new Error("Login failed.");
        }
        const result = await provisionCloudResources(containerName);
        agentId = result.agentId;
        vaultId = result.vaultId;
        agentApiKey = result.apiKey;
    }

    // ── Step 4/5: Store key + start daemon ───────────────────────────────
    if (agentApiKey && !opts.local) {
        localVaultPath = `__docker/${sanitizeName(containerName)}/agent-key`;
    } else if (agentApiKey && opts.local) {
        // Even in local mode, an explicitly provided key is stored for the daemon.
        localVaultPath = `__docker/${sanitizeName(containerName)}/agent-key`;
    }

    const socketPath = await ensureDaemonRunning({
        storeKey:
            agentApiKey && localVaultPath
                ? { localVaultPath, apiKey: agentApiKey }
                : undefined,
    });

    // ── Step 6/7: Build or pull image ────────────────────────────────────
    const baseImage =
        typeof opts.docker === "string" && opts.docker.length
            ? opts.docker
            : DEFAULT_BASE_IMAGE;

    let imageToRun = baseImage;
    if (modules.length === 0) {
        const spinner = ora(`Preparing image ${baseImage}...`).start();
        try {
            await ensureBaseImage(baseImage, (line) => {
                spinner.text = chalk.dim(line.slice(0, 70));
            });
            spinner.succeed(`Image ready: ${baseImage}`);
        } catch (err) {
            spinner.fail("Failed to prepare image.");
            throw err;
        }
    } else {
        const baseSpinner = ora("Ensuring base image...").start();
        try {
            await ensureBaseImage(baseImage, (line) => {
                baseSpinner.text = chalk.dim(line.slice(0, 70));
            });
            baseSpinner.succeed("Base image ready.");
        } catch (err) {
            baseSpinner.fail("Failed to prepare base image.");
            throw err;
        }
        const buildSpinner = ora("Building module image...").start();
        try {
            const { tag } = await buildModuleImage(baseImage, modules, (line) => {
                buildSpinner.text = chalk.dim(line.slice(0, 70));
            });
            imageToRun = tag;
            buildSpinner.succeed(`Built ${tag}`);
        } catch (err) {
            buildSpinner.fail("Module image build failed.");
            throw err;
        }
    }

    // ── Step 8: Run container ────────────────────────────────────────────
    const requestedPort = parseInt(opts.port, 10) || 3000;
    const port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
        printWarning(`Port ${requestedPort} busy — using ${port}.`);
    }

    const env: Record<string, string> = {
        ONECLAW_LOCAL_VAULT: "true",
        ONECLAW_DAEMON_SOCKET: "/run/1claw/daemon.sock",
        ONECLAW_CONTAINER_MODULES: modules.map((m) => m.name).join(","),
    };
    if (agentId) env.ONECLAW_AGENT_ID = agentId;

    const runSpinner = ora(`Starting container ${containerName}...`).start();
    let containerId: string;
    try {
        containerId = await dockerRun({
            image: imageToRun,
            name: containerName,
            ports: { [String(port)]: "3000" },
            volumes: { [socketPath]: "/run/1claw/daemon.sock:ro" },
            env,
            detach: true,
            restart: "unless-stopped",
            labels: { [MANAGED_LABEL]: "true", "1claw.name": containerName },
        });
        runSpinner.succeed(`Container started (${containerId.slice(0, 12)})`);
    } catch (err) {
        runSpinner.fail("Failed to start container.");
        throw err;
    }

    // ── Step 9: Wait healthy + summary ───────────────────────────────────
    const healthSpinner = ora("Waiting for the agent to become healthy...").start();
    const healthy = await waitForHealthy(port);
    if (healthy) {
        healthSpinner.succeed("Agent is healthy.");
    } else {
        healthSpinner.warn(
            "Health check timed out (the container may still be starting).",
        );
    }

    const state: ContainerState = {
        containerName,
        containerId,
        agentId,
        vaultId,
        image: baseImage,
        modules: modules.map((m) => m.name),
        port,
        createdAt: new Date().toISOString(),
        localVaultPath,
        customImage: null,
        mode: "local",
    };
    saveContainerState(state);

    console.log();
    printSuccess("Agent runtime is up.");
    printKeyValue([
        ["Chat UI", chalk.cyan(`http://localhost:${port}`)],
        ["Container", containerName],
        ["Agent ID", agentId ?? chalk.dim("none (local)")],
        ["Vault", vaultId ?? chalk.dim("none (local)")],
        ["Modules", modules.map((m) => m.name).join(", ") || chalk.dim("none")],
        ["Image", imageToRun],
        ["Shroud", agentId ? "enabled" : chalk.dim("n/a")],
        ["Key injection", chalk.green("daemon (container never sees the key)")],
    ]);
    console.log();

    if (modules.some((m) => m.required_secrets.length)) {
        printInfo("Some modules expect secrets in your vault:");
        for (const m of modules) {
            for (const s of m.required_secrets) {
                console.log(
                    `  ${chalk.dim("•")} ${s.path} ${chalk.dim(
                        s.optional ? "(optional)" : "(required)",
                    )} — ${s.description}`,
                );
            }
        }
        console.log();
    }

    printInfo(`Manage it: 1claw containers logs ${containerName}  |  1claw containers stop ${containerName}`);
    console.log();

    // Open the browser (best-effort) unless detached/headless.
    try {
        const open = (await import("open")).default;
        await open(`http://localhost:${port}`);
    } catch {
        // ignore — headless or no browser
    }

    if (!opts.detach) {
        printInfo("Streaming container logs (Ctrl+C to detach; container keeps running).");
        console.log();
        const logs = dockerLogs(containerName, true);
        await new Promise<void>((resolve) => {
            const stop = () => {
                logs.kill();
                resolve();
            };
            process.on("SIGINT", stop);
            logs.on("close", () => resolve());
        });
    }
}
