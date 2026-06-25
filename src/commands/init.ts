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
    type SecretPolicy,
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
    stopDaemon,
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
    llmProvider?: string;
    llmModel?: string;
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
    .option(
        "--llm-provider <provider>",
        "LLM provider for the chat UI via Shroud (openai, anthropic, google, ...)",
        "openai",
    )
    .option(
        "--llm-model <model>",
        "LLM model for the chat UI via Shroud (e.g. gpt-4o-mini, claude-3-5-haiku-latest)",
    )
    .action(async (opts: InitOptions) => {
        try {
            await initAction(opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function defaultModelForProvider(provider: string): string {
    switch (provider.toLowerCase()) {
        case "anthropic":
            return "claude-3-5-haiku-latest";
        case "google":
        case "gemini":
            return "gemini-2.5-flash";
        case "mistral":
            return "mistral-small-latest";
        case "openai":
        default:
            return "gpt-4o-mini";
    }
}

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

interface StoreKeySpec {
    /** Vault path / secret name. */
    path: string;
    /** Secret value to store. */
    value: string;
    /** Secret type label. */
    type?: string;
    /** Daemon injection policy for this secret. */
    policy: SecretPolicy;
}

/**
 * Ensure a local vault exists, optionally store one or more secrets (each with
 * its daemon injection policy), and make sure the daemon is running so the
 * container can reach it. If the daemon is already running and we wrote new
 * secrets, it is reloaded (the daemon loads the vault into memory at startup).
 */
async function ensureDaemonRunning(opts: {
    storeKeys?: StoreKeySpec[];
}): Promise<string> {
    const socketPath = daemonSocketPath();
    const alreadyRunning = await daemonHealthy(socketPath);

    const storeKeys = opts.storeKeys ?? [];
    const needVaultWrite = storeKeys.length > 0;
    const needStart = !alreadyRunning;
    // If we're writing secrets but the daemon is already up, it must be
    // reloaded — otherwise the container can't reach the freshly stored keys.
    const needReload = needVaultWrite && alreadyRunning;

    if (!needVaultWrite && !needStart) {
        return socketPath;
    }

    const creatingVault = !vaultExists();
    let passphrase: string | undefined;

    if (creatingVault) {
        printInfo("No local vault found — creating one for the daemon.");
        passphrase = await resolvePassphrase(true);
        createVault(passphrase);
    } else {
        passphrase = await resolvePassphrase(false);
        // Verify the passphrase up front so we fail with a clear message
        // instead of an opaque "daemon did not become ready in time".
        try {
            loadVault(passphrase);
        } catch {
            throw new Error(
                "Wrong passphrase for the existing local vault.\n" +
                    "  • If you mistyped it, re-run and enter the correct passphrase.\n" +
                    "  • If you've forgotten it, reset the vault with: 1claw local destroy --force\n" +
                    "    (this permanently deletes the old local vault and its secrets), then re-run.",
            );
        }
    }

    if (needVaultWrite && passphrase) {
        let vault;
        try {
            vault = loadVault(passphrase);
        } catch {
            throw new Error("Wrong passphrase or corrupted local vault.");
        }
        const policy = loadPolicy();
        for (const spec of storeKeys) {
            addSecret(vault, spec.path, spec.value, spec.type ?? "api_key");
            setSecretPolicy(policy, spec.path, spec.policy);
        }
        saveVault(vault, passphrase);
        savePolicy(policy);
    }

    if (needReload) {
        const spinner = ora("Reloading daemon to pick up new secrets...").start();
        await stopDaemon(socketPath);
        const ok = await startDaemonDetached(passphrase!, socketPath);
        if (!ok) {
            spinner.fail("Daemon did not come back up.");
            throw new Error(
                "Failed to reload the daemon.\n" +
                    "  • Check status:  1claw daemon status\n" +
                    "  • Start it manually (shows errors):  1claw daemon start",
            );
        }
        spinner.succeed(`Daemon reloaded on ${socketPath}`);
    } else if (needStart) {
        if (!passphrase) passphrase = await resolvePassphrase(false);
        const spinner = ora("Starting local daemon...").start();
        const ok = await startDaemonDetached(passphrase, socketPath);
        if (!ok) {
            spinner.fail("Daemon did not become ready in time.");
            throw new Error(
                "Failed to start the daemon.\n" +
                    "  • Check status:  1claw daemon status\n" +
                    "  • Start it manually (shows errors):  1claw daemon start\n" +
                    "  • Stop a stuck daemon:  1claw daemon stop\n" +
                    "  • Forgot the vault passphrase? Reset it:  1claw local destroy --force",
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

    // ── Step 4/5: Store key(s) + start daemon ────────────────────────────
    // Shroud authenticates via the X-Shroud-Agent-Key header in `agent_id:key`
    // form. We have a clean id+key only on the provisioned path; for --agent-key
    // the user can pass `agent_id:key` directly.
    const sid = sanitizeName(containerName);
    const storeKeys: StoreKeySpec[] = [];

    let shroudAgentKey: string | null = null;
    if (agentId && agentApiKey) {
        shroudAgentKey = `${agentId}:${agentApiKey}`;
    } else if (agentApiKey && agentApiKey.includes(":")) {
        shroudAgentKey = agentApiKey;
    }

    if (agentApiKey) {
        // Generic bearer key toward the 1Claw API (used by /proxy demos).
        localVaultPath = `__docker/${sid}/agent-key`;
        storeKeys.push({
            path: localVaultPath,
            value: agentApiKey,
            type: "api_key",
            policy: {
                allowed_hosts: ["api.1claw.xyz", "*.1claw.xyz"],
                inject_as: "bearer",
            },
        });
    }

    // Shroud LLM key: injected as the X-Shroud-Agent-Key header toward Shroud.
    let shroudSecretPath: string | null = null;
    if (shroudAgentKey && !opts.local) {
        shroudSecretPath = `__docker/${sid}/shroud-key`;
        storeKeys.push({
            path: shroudSecretPath,
            value: shroudAgentKey,
            type: "api_key",
            policy: {
                allowed_hosts: ["shroud.1claw.xyz", "*.1claw.xyz"],
                inject_as: "header",
                header_name: "X-Shroud-Agent-Key",
            },
        });
    }

    const socketPath = await ensureDaemonRunning({
        storeKeys: storeKeys.length ? storeKeys : undefined,
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

    const containerMode = opts.local ? "local" : "cloud";
    const env: Record<string, string> = {
        ONECLAW_MODE: containerMode,
        ONECLAW_DAEMON_SOCKET: "/run/1claw/daemon.sock",
        ONECLAW_CONTAINER_MODULES: modules.map((m) => m.name).join(","),
    };
    if (opts.local) env.ONECLAW_LOCAL_VAULT = "true";
    if (agentId) env.ONECLAW_AGENT_ID = agentId;

    // Wire the chat UI to an LLM through Shroud (key stays in the host daemon).
    const llmWired = !!shroudSecretPath;
    if (llmWired) {
        const provider = opts.llmProvider || "openai";
        const model = opts.llmModel || defaultModelForProvider(provider);
        env.ONECLAW_LLM_VIA_SHROUD = "true";
        env.ONECLAW_SHROUD_URL =
            process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.xyz";
        env.ONECLAW_SHROUD_SECRET = shroudSecretPath!;
        env.ONECLAW_SHROUD_PROVIDER = provider;
        env.ONECLAW_SHROUD_MODEL = model;
    }

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
        mode: containerMode,
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
        [
            "Chat LLM",
            llmWired
                ? chalk.green(
                      `via Shroud (${env.ONECLAW_SHROUD_PROVIDER}/${env.ONECLAW_SHROUD_MODEL})`,
                  )
                : chalk.dim("none — slash commands only"),
        ],
        ["Key injection", chalk.green("daemon (container never sees the key)")],
    ]);
    console.log();

    if (llmWired) {
        printInfo(
            "Chat replies route through Shroud. To bill model usage to 1Claw " +
                "(no provider key needed), enable LLM Token Billing for your org:",
        );
        console.log(
            chalk.dim(
                "  Dashboard → Billing → LLM Token Billing, or\n" +
                    "  POST /v1/billing/llm-token-billing/subscribe\n" +
                    "  (otherwise Shroud needs a provider key configured for the org).",
            ),
        );
        console.log();
    }

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
