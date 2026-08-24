import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { join, resolve } from "node:path";
import { existsSync, cpSync, mkdirSync, readdirSync } from "node:fs";
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
    dockerBuild,
    dockerLogsFiltered,
    DockerError,
} from "../lib/docker-client.js";
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
import {
    listTemplates,
    loadTemplate,
    getTemplateDir,
    type TemplateManifest,
} from "../templates/registry.js";
import { ensureTemplates } from "../templates/fetcher.js";
import { resolveAgentKeyFromInput } from "../lib/agent-key.js";

interface SpawnOptions {
    list?: boolean;
    refresh?: boolean;
    port: string;
    name?: string;
    output?: string;
    noCopy?: boolean;
    local?: boolean;
    agentKey?: string;
    detach?: boolean;
    llmProvider?: string;
    llmModel?: string;
    llmApiKey?: string;
    llmKeyStore?: string;
    llmApiKeySecret?: string;
}

export const spawnCommand = new Command("spawn")
    .description(
        "Create and run a framework-specific AI agent from a template",
    )
    .argument("[template]", "Template name (e.g. langchain, crewai, openai-agents)")
    .option("--list", "List all available templates and exit")
    .option("--refresh", "Force-refresh the template registry from GitHub")
    .option("--output <dir>", "Project directory to copy template into (default: ./<template>)")
    .option("--no-copy", "Skip copying template files locally (container-only)")
    .option("--port <port>", "Chat UI port", "3000")
    .option("--name <name>", "Container name (default: auto-generated)")
    .option("--local", "Fully offline — no cloud provisioning")
    .option("--agent-key <key>", "Use an existing agent key (skip provisioning)")
    .option("--detach", "Run the container in the background")
    .option(
        "--llm-provider <provider>",
        "LLM provider via Shroud (openai, anthropic, google, ...)",
        "openai",
    )
    .option(
        "--llm-model <model>",
        "LLM model via Shroud (e.g. gpt-4o-mini, claude-3-5-haiku-latest)",
    )
    .option(
        "--llm-api-key <key>",
        "Provider API key (stored in vault, never passed to the container)",
    )
    .option(
        "--llm-key-store <where>",
        "'cloud' (1Claw vault) or 'local' (CLI vault, daemon injects)",
        "cloud",
    )
    .option(
        "--llm-api-key-secret <name>",
        "Use an existing LOCAL vault secret as the provider key",
    )
    .action(async (templateArg: string | undefined, opts: SpawnOptions) => {
        try {
            await spawnAction(templateArg, opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function printTemplateList(templates: TemplateManifest[]): void {
    console.log();
    console.log(chalk.bold("  Available templates:"));
    console.log();
    if (templates.length === 0) {
        printInfo(
            "No templates found. Run `1claw spawn --refresh` or initialize the submodule.",
        );
        return;
    }
    printTable(
        templates.map((t) => ({
            name: t.name,
            display: t.display_name,
            lang: t.language,
            description: t.description.slice(0, 60),
        })),
        [
            { key: "name", header: "Template", width: 18 },
            { key: "display", header: "Framework", width: 26 },
            { key: "lang", header: "Lang", width: 8 },
            { key: "description", header: "Description", width: 60 },
        ],
    );
    console.log();
    console.log(
        chalk.dim(
            "  Usage: 1claw spawn <template>\n" +
                "     eg: 1claw spawn langchain --llm-api-key sk-...\n" +
                "     eg: 1claw spawn crewai --local",
        ),
    );
    console.log();
}

async function spawnAction(
    templateArg: string | undefined,
    opts: SpawnOptions,
): Promise<void> {
    // ── Ensure templates are available ────────────────────────────────
    await ensureTemplates({
        force: opts.refresh,
        onProgress: (msg) => printInfo(msg),
    });

    if (opts.list || !templateArg) {
        printTemplateList(listTemplates());
        if (!templateArg && !opts.list) {
            printWarning("Specify a template: 1claw spawn <template>");
        }
        return;
    }

    console.log();
    console.log(chalk.bold("  1Claw — Spawn Agent from Template"));
    console.log();

    // ── Load template manifest ───────────────────────────────────────
    const manifest = loadTemplate(templateArg);
    const templateDir = getTemplateDir(templateArg);
    printInfo(`Template: ${manifest.display_name} (${manifest.name} v${manifest.version})`);

    // ── Preflight: Docker ────────────────────────────────────────────
    if (!(await dockerAvailable())) {
        const reason = await dockerDaemonError();
        throw new Error(
            reason ??
                "Docker is required. Install Docker Desktop: https://docs.docker.com/get-docker/",
        );
    }

    // ── Container identity ───────────────────────────────────────────
    const containerName = opts.name ?? generateContainerName(manifest.name);
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

    // ── Auth + provisioning ──────────────────────────────────────────
    let agentId: string | null = null;
    let vaultId: string | null = null;
    let agentApiKey: string | null = opts.agentKey ?? null;
    let localVaultPath: string | null = null;

    if (opts.local) {
        printInfo("Local mode — no cloud account or provisioning.");
    } else if (agentApiKey) {
        printInfo("Using provided --agent-key (skipping provisioning).");
        const resolved = await resolveAgentKeyFromInput(agentApiKey);
        agentId = resolved.agentId;
        agentApiKey = resolved.apiKey;
        if (resolved.vaultIds?.length) vaultId = resolved.vaultIds[0];
        if (!opts.agentKey?.includes(":")) {
            printInfo(
                `Resolved agent ${agentId.slice(0, 8)}… from key-only ocv_ auth.`,
            );
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

    // ── Store keys + start daemon ────────────────────────────────────
    const sid = sanitizeName(containerName);
    const storeKeys: StoreKeySpec[] = [];

    let shroudAgentKey: string | null = null;
    if (agentId && agentApiKey) {
        shroudAgentKey = `${agentId}:${agentApiKey}`;
    }

    if (agentApiKey) {
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

    // LLM provider key (BYOK)
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
            cloudKeyToStore = opts.llmApiKey;
        }
    }

    const socketPath = await ensureDaemonRunning({
        storeKeys: storeKeys.length ? storeKeys : undefined,
    });

    // Store provider key in cloud vault if needed
    if (cloudKeyToStore && vaultId && !opts.local) {
        const keySpinner = ora(
            `Storing ${llmProvider} key in 1Claw vault...`,
        ).start();
        try {
            await api(
                `/vaults/${vaultId}/secrets/${encodeURIComponent(`providers/${llmProvider}/api-key`)}`,
                {
                    method: "PUT",
                    body: { type: "api_key", value: cloudKeyToStore },
                },
            );
            keySpinner.succeed(
                `Provider key stored at providers/${llmProvider}/api-key (1Claw vault).`,
            );
        } catch (err) {
            keySpinner.fail("Failed to store provider key in the vault.");
            throw err;
        }
    }

    // ── Copy template to project directory (default behavior) ──────
    // By default, spawn copies the template into a local project folder
    // so you can edit the source. Use --no-copy to skip this step.
    let projectDir: string | null = null;
    const shouldCopy = opts.noCopy !== true;

    if (shouldCopy) {
        const targetDir = opts.output
            ? resolve(opts.output)
            : resolve(process.cwd(), manifest.name);

        if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
            throw new Error(
                `Directory "${targetDir}" already exists and is not empty. ` +
                    `Use --output to specify a different path, or --no-copy to skip.`,
            );
        }

        mkdirSync(targetDir, { recursive: true });
        cpSync(templateDir, targetDir, { recursive: true });
        projectDir = targetDir;

        // Initialize a fresh git repo so the user can track changes
        try {
            const { execSync } = await import("node:child_process");
            execSync("git init", { cwd: targetDir, stdio: "ignore" });
        } catch {
            // git not installed — non-fatal
        }

        printSuccess(`Project scaffolded → ${projectDir}`);
    }

    // Use the local project dir as build context when available
    const buildContext = projectDir ?? templateDir;

    // ── Build template image ─────────────────────────────────────────
    const imageTag = `1claw/${manifest.name}:${manifest.version}`;
    const dockerfilePath = join(buildContext, "Dockerfile");

    const buildSpinner = ora(
        `Building ${manifest.display_name} image...`,
    ).start();
    try {
        await dockerBuild({
            context: buildContext,
            dockerfile: dockerfilePath,
            tag: imageTag,
            onProgress: (line) => {
                buildSpinner.text = chalk.dim(line.slice(0, 70));
            },
        });
        buildSpinner.succeed(`Image built: ${imageTag}`);
    } catch (err) {
        buildSpinner.fail("Image build failed.");
        if (err instanceof DockerError && err.stderr?.trim()) {
            const tail = err.stderr.trim().split("\n").slice(-20).join("\n");
            console.error(chalk.dim("\n" + tail + "\n"));
        }
        throw err;
    }

    // ── Run container ────────────────────────────────────────────────
    const requestedPort = parseInt(opts.port, 10) || 3000;
    let port = await findAvailablePort(requestedPort);
    if (port !== requestedPort) {
        printWarning(`Port ${requestedPort} busy — using ${port}.`);
    }

    const containerMode = opts.local ? "local" : "cloud";
    const env: Record<string, string> = {
        ONECLAW_MODE: containerMode,
        ONECLAW_DAEMON_SOCKET: "/run/1claw/daemon.sock",
        ONECLAW_SECRET_PREFIX: `__docker/${sid}/`,
        ONECLAW_FRAMEWORK: manifest.name,
    };
    if (manifest.docker.env) {
        Object.assign(env, manifest.docker.env);
    }
    if (opts.local) env.ONECLAW_LOCAL_VAULT = "true";
    if (agentId) env.ONECLAW_AGENT_ID = agentId;

    const llmWired = !!shroudSecretPath;
    if (llmWired) {
        const model =
            opts.llmModel || defaultModelForProvider(llmProvider);
        env.ONECLAW_LLM_VIA_SHROUD = "true";
        env.ONECLAW_SHROUD_URL =
            process.env.ONECLAW_SHROUD_URL || "https://shroud.1claw.xyz";
        env.ONECLAW_SHROUD_SECRET = shroudSecretPath!;
        env.ONECLAW_SHROUD_PROVIDER = llmProvider;
        env.ONECLAW_SHROUD_MODEL = model;
        if (shroudApiKeySecretPath) {
            env.ONECLAW_SHROUD_API_KEY_SECRET = shroudApiKeySecretPath;
        }
    }

    const healthPort = String(manifest.docker.health_port ?? 3000);
    const containerPort = healthPort;

    const runSpinner = ora(`Starting container ${containerName}...`).start();
    const userPinnedPort = opts.port !== undefined && opts.port !== "3000";
    const MAX_PORT_RETRIES = 5;
    let containerId: string | undefined;
    for (let attempt = 0; ; attempt++) {
        try {
            containerId = await dockerRun({
                image: imageTag,
                name: containerName,
                ports: { [String(port)]: containerPort },
                volumes: { [socketPath]: "/run/1claw/daemon.sock:ro" },
                env,
                detach: true,
                restart: "unless-stopped",
                labels: {
                    [MANAGED_LABEL]: "true",
                    "1claw.name": containerName,
                    "1claw.template": manifest.name,
                },
            });
            runSpinner.succeed(
                `Container started (${containerId.slice(0, 12)})`,
            );
            break;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const portConflict =
                /port is already allocated|address already in use|Bind for [^ ]+ failed/i.test(
                    msg,
                );
            if (
                portConflict &&
                !userPinnedPort &&
                attempt < MAX_PORT_RETRIES
            ) {
                const nextPort = await findAvailablePort(port + 1);
                runSpinner.text = `Port ${port} already allocated — retrying on ${nextPort}...`;
                port = nextPort;
                continue;
            }
            runSpinner.fail("Failed to start container.");
            throw err;
        }
    }
    if (!containerId) throw new Error("Failed to start container.");

    // ── Wait healthy + summary ───────────────────────────────────────
    const healthEndpoint = manifest.docker.health_endpoint ?? "/health";
    const healthSpinner = ora(
        "Waiting for the agent to become healthy...",
    ).start();
    const healthy = await waitForHealthy(port, healthEndpoint);
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
        image: imageTag,
        modules: [],
        port,
        createdAt: new Date().toISOString(),
        localVaultPath,
        customImage: null,
        mode: containerMode,
        template: manifest.name,
        runSpec: {
            image: imageTag,
            containerPort,
            env,
            volumes: { [socketPath]: "/run/1claw/daemon.sock:ro" },
            restart: "unless-stopped",
            labels: {
                [MANAGED_LABEL]: "true",
                "1claw.name": containerName,
                "1claw.template": manifest.name,
            },
        },
    };
    saveContainerState(state);

    console.log();
    if (healthy) {
        printSuccess(
            `${manifest.display_name} agent is up → ${chalk.cyan(`http://localhost:${port}`)}`,
        );
    } else {
        printWarning(
            `${manifest.display_name} container started but localhost:${port} is not responding yet.`,
        );
        printInfo(`Check logs: 1claw containers logs ${containerName}`);
    }
    console.log();

    const llmLabel = llmWired
        ? chalk.green(
              `${env.ONECLAW_SHROUD_PROVIDER}/${env.ONECLAW_SHROUD_MODEL}`,
          )
        : undefined;

    const keySourceLabel = !llmWired
        ? undefined
        : shroudApiKeySecretPath
          ? chalk.green("local vault (daemon)")
          : cloudKeyToStore
            ? chalk.green("1Claw vault")
            : chalk.cyan("1Claw vault or token billing");

    printSummaryBox([
        ["Template", `${manifest.display_name} (${manifest.name})`],
        ["Project", projectDir ?? chalk.dim("(not copied — --no-copy)")],
        ["Container", containerName],
        ["Agent", agentId ?? chalk.dim("local")],
        ["Vault", vaultId ?? undefined],
        ["Shroud", agentId ? chalk.green("enabled") : undefined],
        ["LLM", llmLabel],
        ["Key source", keySourceLabel],
        [
            "Security",
            chalk.green("daemon injection (container never sees keys)"),
        ],
    ]);
    console.log();

    if (manifest.post_spawn_message) {
        console.log(chalk.dim(`  ${manifest.post_spawn_message}`));
        console.log();
    }

    if (projectDir) {
        console.log(chalk.dim(`  edit:  cd ${projectDir}`));
    }
    console.log(chalk.dim(`  logs:  1claw containers logs ${containerName}`));
    console.log(
        chalk.dim(`  stop:  1claw containers stop ${containerName}`),
    );
    console.log();

    try {
        if (healthy) {
            const open = (await import("open")).default;
            await open(`http://localhost:${port}`);
        }
    } catch {
        // headless or no browser
    }

    if (!opts.detach) {
        printInfo("Streaming logs (Ctrl+C to detach)...");
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
