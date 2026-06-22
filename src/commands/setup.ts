import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { getAuth, getToken } from "../config.js";
import { loginWithDevice } from "../auth.js";
import {
    detectAiClients,
    buildMcpEntry,
    configureClient,
    type AiClient,
} from "../ai-clients.js";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
} from "../output.js";
import { api } from "../client.js";

export const setupCommand = new Command("setup")
    .description(
        "Auto-configure AI clients (Claude, Cursor, etc.) to use 1Claw MCP",
    )
    .option("--global", "Configure global/user-level MCP settings (default)")
    .option("--project", "Configure project-level MCP settings in current directory")
    .option("--client <name>", "Configure only a specific client (e.g. cursor, claude-desktop)")
    .option("--agent-key <key>", "Use a specific agent API key instead of prompting")
    .option("--skip-auth", "Skip authentication check (use existing credentials)")
    .option("--local", "Configure MCP to use the local daemon instead of cloud API")
    .action(async (opts) => {
        try {
            await runSetup(opts);
        } catch (err) {
            if (err instanceof Error) {
                printError(err.message);
            } else {
                printError(String(err));
            }
            process.exit(1);
        }
    });

async function runSetup(opts: {
    global?: boolean;
    project?: boolean;
    client?: string;
    agentKey?: string;
    skipAuth?: boolean;
    local?: boolean;
}): Promise<void> {
    console.log();
    console.log(chalk.bold("  1Claw Setup"));
    console.log(
        chalk.dim(
            opts.local
                ? "  Configure AI clients for local daemon mode (offline, secrets never leave machine)"
                : "  Auto-configure your AI clients for secret management",
        ),
    );
    console.log();

    // Local daemon mode — no auth needed, just configure MCP to point at daemon socket
    if (opts.local) {
        await runLocalSetup(opts);
        return;
    }

    // Step 1: Ensure authentication
    let agentApiKey = opts.agentKey || "";

    if (!agentApiKey && !opts.skipAuth) {
        const token = getToken();
        if (!token) {
            printInfo("You need to be logged in to set up MCP connections.");
            console.log();

            const { shouldLogin } = await inquirer.prompt([
                {
                    type: "confirm",
                    name: "shouldLogin",
                    message: "Would you like to log in now?",
                    default: true,
                },
            ]);

            if (shouldLogin) {
                const auth = await loginWithDevice();
                if (!auth) {
                    printError("Login failed. Run `1claw login` manually, then try `1claw setup` again.");
                    return;
                }
            } else {
                printWarning("Skipping authentication. You can provide --agent-key directly.");
                return;
            }
        }

        if (!agentApiKey) {
            agentApiKey = await resolveAgentKey();
        }
    }

    if (!agentApiKey) {
        printError("No agent API key available. Create an agent first: `1claw agent create <name>`");
        return;
    }

    // Step 2: Detect AI clients
    const spinner = ora("Detecting installed AI clients...").start();
    const allClients = detectAiClients();
    spinner.stop();

    let candidates: AiClient[];

    if (opts.client) {
        const match = allClients.find(
            (c) => c.slug === opts.client || c.name.toLowerCase() === opts.client!.toLowerCase(),
        );
        if (!match) {
            printError(
                `Unknown client: ${opts.client}. Available: ${allClients.map((c) => c.slug).join(", ")}`,
            );
            return;
        }
        candidates = [match];
    } else {
        const detected = allClients.filter((c) => c.detected);
        if (detected.length === 0) {
            printWarning("No AI clients detected on this machine.");
            printInfo(
                "Supported clients: " +
                    allClients.map((c) => c.name).join(", "),
            );
            printInfo("You can manually configure MCP — see https://docs.1claw.xyz/mcp");
            return;
        }

        console.log(
            chalk.bold("  Detected AI clients:"),
        );
        for (const c of detected) {
            console.log(`    ${chalk.green("●")} ${c.name}`);
        }
        const notDetected = allClients.filter((c) => !c.detected);
        for (const c of notDetected) {
            console.log(`    ${chalk.dim("○")} ${chalk.dim(c.name)} ${chalk.dim("(not found)")}`);
        }
        console.log();

        const { selected } = await inquirer.prompt([
            {
                type: "checkbox",
                name: "selected",
                message: "Which clients would you like to configure?",
                choices: detected.map((c) => ({
                    name: c.name,
                    value: c.slug,
                    checked: true,
                })),
            },
        ]);

        candidates = detected.filter((c) => selected.includes(c.slug));
    }

    if (candidates.length === 0) {
        printInfo("No clients selected. Setup cancelled.");
        return;
    }

    // Step 3: Build MCP server entry
    const envVars: Record<string, string> = {
        ONECLAW_AGENT_API_KEY: agentApiKey,
    };

    const entry = buildMcpEntry(envVars);

    // Step 4: Configure each client
    console.log();
    let successCount = 0;
    for (const client of candidates) {
        const result = configureClient(client, entry);
        if (result.success) {
            printSuccess(result.message);
            successCount++;
        } else {
            printError(result.message);
        }
    }

    // Step 5: Summary
    console.log();
    if (successCount > 0) {
        printSuccess(
            `Configured ${successCount} client${successCount > 1 ? "s" : ""}. ` +
            "Restart your AI client to activate 1Claw MCP.",
        );
        console.log();
        printInfo("Your agent can now access secrets in your vault.");
        printInfo("Try asking your AI: \"List my secrets in 1Claw\"");
    } else {
        printWarning("No clients were configured. Check the errors above.");
    }
    console.log();
}

async function resolveAgentKey(): Promise<string> {
    const { source } = await inquirer.prompt([
        {
            type: "list",
            name: "source",
            message: "How would you like to provide an agent API key?",
            choices: [
                { name: "Create a new agent now", value: "create" },
                { name: "Enter an existing agent API key", value: "enter" },
                { name: "Use from environment (ONECLAW_AGENT_API_KEY)", value: "env" },
            ],
        },
    ]);

    if (source === "env") {
        const key = process.env.ONECLAW_AGENT_API_KEY;
        if (!key) {
            printError("ONECLAW_AGENT_API_KEY is not set in the environment.");
            process.exit(1);
        }
        return key;
    }

    if (source === "enter") {
        const { key } = await inquirer.prompt([
            {
                type: "password",
                name: "key",
                message: "Agent API key (ocv_...):",
                mask: "*",
                validate: (v: string) =>
                    v.startsWith("ocv_") ? true : "Agent API keys start with ocv_",
            },
        ]);
        return key;
    }

    // Create a new agent
    const { agentName } = await inquirer.prompt([
        {
            type: "input",
            name: "agentName",
            message: "Name for the new agent:",
            default: "mcp-agent",
            validate: (v: string) =>
                v.trim().length > 0 ? true : "Agent name is required",
        },
    ]);

    const spinner = ora("Creating agent...").start();
    try {
        const result = await api<{ id: string; api_key?: string }>(
            "/agents",
            {
                method: "POST",
                body: {
                    name: agentName.trim(),
                    description: "Auto-created by 1claw setup for MCP integration",
                },
            },
        );

        spinner.succeed(`Agent "${agentName}" created`);

        if (result.api_key) {
            printInfo(
                `Agent API key: ${chalk.cyan(result.api_key)} ${chalk.dim("(save this — shown only once)")}`,
            );
            return result.api_key;
        }

        printError("Agent created but no API key returned. Use `1claw agent create` manually.");
        process.exit(1);
    } catch (err) {
        spinner.fail("Failed to create agent");
        throw err;
    }
}

async function runLocalSetup(opts: {
    client?: string;
}): Promise<void> {
    const { vaultExists } = await import("../local-vault.js");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");

    if (!vaultExists()) {
        printWarning("No local vault found.");
        printInfo("Run `1claw local init` to create one, then try `1claw setup --local` again.");
        return;
    }

    const configDir =
        process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
    const socketPath =
        process.env.ONECLAW_DAEMON_SOCKET || join(configDir, "daemon.sock");

    // Detect AI clients
    const spinner = ora("Detecting installed AI clients...").start();
    const allClients = detectAiClients();
    spinner.stop();

    let candidates: AiClient[];

    if (opts.client) {
        const match = allClients.find(
            (c) => c.slug === opts.client || c.name.toLowerCase() === opts.client!.toLowerCase(),
        );
        if (!match) {
            printError(
                `Unknown client: ${opts.client}. Available: ${allClients.map((c) => c.slug).join(", ")}`,
            );
            return;
        }
        candidates = [match];
    } else {
        const detected = allClients.filter((c) => c.detected);
        if (detected.length === 0) {
            printWarning("No AI clients detected.");
            return;
        }

        console.log(chalk.bold("  Detected AI clients:"));
        for (const c of detected) {
            console.log(`    ${chalk.green("●")} ${c.name}`);
        }
        console.log();

        const { selected } = await inquirer.prompt([
            {
                type: "checkbox",
                name: "selected",
                message: "Which clients to configure for local daemon mode?",
                choices: detected.map((c) => ({
                    name: c.name,
                    value: c.slug,
                    checked: true,
                })),
            },
        ]);

        candidates = detected.filter((c) => selected.includes(c.slug));
    }

    if (candidates.length === 0) {
        printInfo("No clients selected.");
        return;
    }

    const envVars: Record<string, string> = {
        ONECLAW_DAEMON_SOCKET: socketPath,
        ONECLAW_LOCAL_VAULT: "true",
    };
    const entry = buildMcpEntry(envVars);

    console.log();
    let successCount = 0;
    for (const client of candidates) {
        const result = configureClient(client, entry);
        if (result.success) {
            printSuccess(result.message);
            successCount++;
        } else {
            printError(result.message);
        }
    }

    console.log();
    if (successCount > 0) {
        printSuccess(
            `Configured ${successCount} client${successCount > 1 ? "s" : ""} for local daemon mode.`,
        );
        console.log();
        printInfo("Start the daemon: `1claw daemon start`");
        printInfo("Then restart your AI client to activate local MCP.");
    }
    console.log();
}
