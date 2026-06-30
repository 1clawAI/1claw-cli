import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { api } from "../client.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printSummaryBox,
    printTable,
} from "../output.js";
import {
    dockerAvailable,
    dockerDaemonError,
    dockerRun,
    dockerContainerStatus,
    dockerLogs,
    dockerLogsFiltered,
} from "../lib/docker-client.js";
import {
    ensureBaseImage,
    buildModuleImage,
    DEFAULT_BASE_IMAGE,
} from "../lib/image-build.js";
import {
    deprecatedSpawnModuleWarning,
} from "../lib/module-deprecation.js";
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
    provisionCloudResources,
    ensureDaemonRunning,
    defaultModelForProvider,
    ensureAuth,
    waitForHealthy,
    type StoreKeySpec,
} from "../lib/provisioning.js";

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
    llmApiKey?: string;
    llmKeyStore?: string;
    llmApiKeySecret?: string;
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
    .option(
        "--llm-api-key <key>",
        "Provider API key for the chat LLM (stored, never passed to the container)",
    )
    .option(
        "--llm-key-store <where>",
        "Where to store --llm-api-key: 'cloud' (1Claw vault, Shroud auto-fetches) or 'local' (CLI vault, daemon injects)",
        "cloud",
    )
    .option(
        "--llm-api-key-secret <name>",
        "Use an existing LOCAL vault secret as the provider key (daemon injects it as X-Shroud-Api-Key)",
    )
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

async function initAction(opts: InitOptions): Promise<void> {
    if (opts.listModules) {
        printModuleList();
        return;
    }

    console.log();
    console.log(chalk.bold("  1Claw — Secure Agent Runtime"));
    console.log();

    const moduleNames = parseModuleNames(opts.module);
    const deprecationWarning = deprecatedSpawnModuleWarning(moduleNames);
    if (deprecationWarning) {
        printWarning(deprecationWarning);
    }

    // ── Step 1: Preflight ────────────────────────────────────────────────
    if (!(await dockerAvailable())) {
        const reason = await dockerDaemonError();
        throw new Error(
            reason ??
                "Docker is required. Install Docker Desktop: https://docs.docker.com/get-docker/",
        );
    }

    // ── Modules ──────────────────────────────────────────────────────────
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
        // Resolve agent ID + vault via token exchange (key-only auth).
        try {
            const exchangeRes = await api<{
                token: string;
                agent_id?: string;
                vault_ids?: string[];
            }>("/auth/agent-token", {
                method: "POST",
                body: { api_key: agentApiKey },
                token: "",
            });
            if (exchangeRes.agent_id) agentId = exchangeRes.agent_id;
            if (exchangeRes.vault_ids?.length) vaultId = exchangeRes.vault_ids[0];
        } catch {
            // Non-fatal — continue with local-only mode if exchange fails.
        }
    } else {
        const authed = await ensureAuth();
        if (!authed) {
            throw new Error(
                "Not authenticated. Re-run with --local for offline mode, or `1claw login`.",
            );
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

    // ── LLM provider key (BYOK) — three storage options ──────────────────
    // 1) Cloud (1Claw vault): Shroud auto-fetches providers/{provider}/api-key.
    // 2) Local (CLI vault): the daemon injects it as X-Shroud-Api-Key.
    // 3) Existing local secret by name: same as (2) but reuse a stored secret.
    const llmProvider = opts.llmProvider || "openai";
    const keyStore = (opts.llmKeyStore || "cloud").toLowerCase();
    const byokPolicy = {
        allowed_hosts: ["shroud.1claw.xyz", "*.1claw.xyz"],
        inject_as: "header" as const,
        header_name: "X-Shroud-Api-Key",
    };
    let shroudApiKeySecretPath: string | null = null;
    let cloudKeyToStore: string | null = null;

    if (opts.llmApiKeySecret) {
        // Reference an existing LOCAL vault secret as the provider key. No value
        // → ensureDaemonRunning only sets the policy and verifies it exists.
        shroudApiKeySecretPath = opts.llmApiKeySecret;
        storeKeys.push({ path: shroudApiKeySecretPath, policy: byokPolicy });
    } else if (opts.llmApiKey) {
        if (keyStore === "local" || opts.local) {
            shroudApiKeySecretPath = `__docker/${sid}/llm-api-key`;
            storeKeys.push({
                path: shroudApiKeySecretPath,
                value: opts.llmApiKey,
                type: "api_key",
                policy: byokPolicy,
            });
        } else {
            // cloud (default): stored in the 1Claw vault after provisioning.
            cloudKeyToStore = opts.llmApiKey;
        }
    }

    const socketPath = await ensureDaemonRunning({
        storeKeys: storeKeys.length ? storeKeys : undefined,
    });

    // Store the provider key in the 1Claw cloud vault (Shroud auto-fetches it).
    if (cloudKeyToStore && vaultId && !opts.local) {
        const keySpinner = ora(
            `Storing ${llmProvider} key in 1Claw vault...`,
        ).start();
        try {
            await api(
                `/vaults/${vaultId}/secrets/${encodeURIComponent(`providers/${llmProvider}/api-key`)}`,
                { method: "PUT", body: { type: "api_key", value: cloudKeyToStore } },
            );
            keySpinner.succeed(
                `Provider key stored at providers/${llmProvider}/api-key (1Claw vault).`,
            );
        } catch (err) {
            keySpinner.fail("Failed to store provider key in the vault.");
            throw err;
        }
    }

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
    let port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
        printWarning(`Port ${requestedPort} busy — using ${port}.`);
    }

    const containerMode = opts.local ? "local" : "cloud";
    const env: Record<string, string> = {
        ONECLAW_MODE: containerMode,
        ONECLAW_DAEMON_SOCKET: "/run/1claw/daemon.sock",
        ONECLAW_CONTAINER_MODULES: modules.map((m) => m.name).join(","),
        ONECLAW_SECRET_PREFIX: `__docker/${sid}/`,
    };
    if (opts.local) env.ONECLAW_LOCAL_VAULT = "true";
    if (agentId) env.ONECLAW_AGENT_ID = agentId;

    // Wire the chat UI to an LLM through Shroud (key stays in the host daemon).
    const llmWired = !!shroudSecretPath;
    if (llmWired) {
        const model = opts.llmModel || defaultModelForProvider(llmProvider);
        env.ONECLAW_LLM_VIA_SHROUD = "true";
        env.ONECLAW_SHROUD_URL =
            process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.xyz";
        env.ONECLAW_SHROUD_SECRET = shroudSecretPath!;
        env.ONECLAW_SHROUD_PROVIDER = llmProvider;
        env.ONECLAW_SHROUD_MODEL = model;
        // BYOK: the daemon also injects this secret as the X-Shroud-Api-Key
        // header so the container never sees the provider key.
        if (shroudApiKeySecretPath) {
            env.ONECLAW_SHROUD_API_KEY_SECRET = shroudApiKeySecretPath;
        }
    } else if (shroudApiKeySecretPath || cloudKeyToStore) {
        printWarning(
            "An LLM provider key was supplied but there's no cloud agent to authenticate to Shroud " +
                "(this is --local or no provisioning). The chat UI can't reach Shroud without an agent key.",
        );
    }

    const runSpinner = ora(`Starting container ${containerName}...`).start();
    const userPinnedPort = opts.port !== undefined && opts.port !== "3000";
    const MAX_PORT_RETRIES = 5;
    let containerId: string | undefined;
    for (let attempt = 0; ; attempt++) {
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
            break;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const portConflict =
                /port is already allocated|address already in use|Bind for [^ ]+ failed/i.test(
                    msg,
                );
            // The bind pre-check can miss ports held only inside the Docker VM,
            // and a race can let another process grab the port first. Auto-retry
            // on the next free port unless the user explicitly pinned --port.
            if (portConflict && !userPinnedPort && attempt < MAX_PORT_RETRIES) {
                const nextPort = await findAvailablePort(port + 1);
                runSpinner.text = `Port ${port} already allocated — retrying on ${nextPort}...`;
                port = nextPort;
                continue;
            }
            runSpinner.fail("Failed to start container.");
            if (portConflict) {
                printError(`Port ${port} is already in use by another process or container.`);
                printInfo("Fix it with one of:");
                printInfo(`  • Pick a free port:   1claw init --docker --port <port>`);
                printInfo(`  • See what's running: 1claw containers list`);
                printInfo(`  • Stop a 1claw agent: 1claw containers stop <name>`);
                printInfo(`  • Find the holder:    docker ps --filter publish=${port}`);
            }
            throw err;
        }
    }
    if (!containerId) throw new Error("Failed to start container.");

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
        runSpec: {
            image: imageToRun,
            containerPort: "3000",
            env,
            volumes: { [socketPath]: "/run/1claw/daemon.sock:ro" },
            restart: "unless-stopped",
            labels: { [MANAGED_LABEL]: "true", "1claw.name": containerName },
        },
    };
    saveContainerState(state);

    console.log();
    printSuccess(`Agent runtime is up → ${chalk.cyan(`http://localhost:${port}`)}`);
    console.log();

    const llmLabel = llmWired
        ? chalk.green(`${env.ONECLAW_SHROUD_PROVIDER}/${env.ONECLAW_SHROUD_MODEL}`)
        : undefined;

    const keySourceLabel = !llmWired
        ? undefined
        : shroudApiKeySecretPath
          ? chalk.green("local vault (daemon)")
          : cloudKeyToStore
            ? chalk.green(`1Claw vault`)
            : chalk.cyan("1Claw vault or token billing");

    printSummaryBox([
        ["Container", containerName],
        ["Agent", agentId ?? chalk.dim("local")],
        ["Vault", vaultId ?? undefined],
        ["Modules", modules.length ? modules.map((m) => m.name).join(", ") : undefined],
        ["Shroud", agentId ? chalk.green("enabled") : undefined],
        ["LLM", llmLabel],
        ["Key source", keySourceLabel],
        ["Security", chalk.green("daemon injection (container never sees keys)")],
    ]);
    console.log();

    if (llmWired && !shroudApiKeySecretPath && !cloudKeyToStore) {
        console.log(
            chalk.dim(
                "  No provider key supplied — Shroud will resolve from:\n" +
                    `  • 1Claw vault (providers/${llmProvider}/api-key)\n` +
                    "  • LLM Token Billing (Dashboard → Billing)",
            ),
        );
        console.log();
    }

    if (modules.some((m) => m.required_secrets.length)) {
        console.log(chalk.dim("  Module secrets needed:"));
        for (const m of modules) {
            for (const s of m.required_secrets) {
                console.log(
                    chalk.dim(`  • ${s.path} ${s.optional ? "(optional)" : "(required)"} — ${s.description}`),
                );
            }
        }
        console.log();
    }

    console.log(chalk.dim(`  logs:  1claw containers logs ${containerName}`));
    console.log(chalk.dim(`  stop:  1claw containers stop ${containerName}`));
    console.log();

    // Open the browser (best-effort) unless detached/headless.
    try {
        const open = (await import("open")).default;
        await open(`http://localhost:${port}`);
    } catch {
        // ignore — headless or no browser
    }

    if (!opts.detach) {
        printInfo("Streaming logs (Ctrl+C to detach)…");
        console.log();
        const logs = dockerLogsFiltered(containerName);
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
