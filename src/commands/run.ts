/**
 * `1claw run <agent> [-- args...]` — start the Shroud proxy, point a coding
 * agent at it, and run it. One command instead of "start the proxy in one
 * terminal, copy four export lines into another".
 *
 * The proxy is embedded (`createProxyServer` from ./proxy.ts), not shelled
 * out to, so there is exactly one implementation of the routing and both
 * commands stay in step. It binds an OS-assigned port by default: nothing
 * else needs to know the number, and it cannot collide with Ollama or a
 * `1claw proxy` the user already has running.
 *
 * Every agent here is one the compatibility suite actually covers — see
 * `verifiedClients()` in ./proxy.ts and shroud/tests/fixtures/clients/.
 * Codex is deliberately absent: it reads a TOML config file rather than the
 * environment, so `1claw run codex` would have to write to the user's
 * ~/.codex/config.toml behind their back. It gets told what to do instead.
 */
import { Command } from "commander";
import { spawn } from "node:child_process";
import chalk from "chalk";
import {
    createProxyServer,
    listenProxyServer,
    resolveShroudAgentKey,
    getAgentKeyFromOptsOrEnv,
    DEFAULT_SHROUD_URL,
    type ProxyOptions,
} from "./proxy.js";
import { printError, printInfo, printSuccess } from "../output.js";

type AgentSpec = {
    /** Executable to spawn; must be on PATH. */
    bin: string;
    /** Args always passed, before the user's own. */
    defaultArgs: string[];
    /**
     * Environment pointing this agent at the local proxy.
     * `base` is http://127.0.0.1:<port>, `v1` is that plus /v1 — the
     * difference matters: Goose wants the host with no /v1, most others want
     * /v1, and Anthropic-shaped clients want the bare base.
     */
    env: (base: string, v1: string) => Record<string, string>;
    /** Env var this agent reads for its model, when it has one. */
    modelEnv?: string;
    /** Shown after launch when the agent needs something we cannot set. */
    note?: string;
};

const AGENTS: Record<string, AgentSpec> = {
    claude: {
        bin: "claude",
        defaultArgs: [],
        env: (base) => ({
            ANTHROPIC_BASE_URL: base,
            ANTHROPIC_API_KEY: "1claw",
        }),
        modelEnv: "ANTHROPIC_MODEL",
    },
    opencode: {
        bin: "opencode",
        defaultArgs: [],
        env: (_base, v1) => ({
            OPENAI_BASE_URL: v1,
            OPENAI_API_KEY: "1claw",
        }),
    },
    openclaude: {
        bin: "openclaude",
        defaultArgs: ["--provider", "openai"],
        env: (_base, v1) => ({
            OPENAI_BASE_URL: v1,
            OPENAI_API_KEY: "1claw",
        }),
    },
    goose: {
        bin: "goose",
        defaultArgs: [],
        // OPENAI_HOST, not OPENAI_BASE_URL, and the host with no /v1 — Goose
        // appends the path itself. Getting this wrong 404s every request.
        env: (base) => ({
            GOOSE_PROVIDER: "openai",
            OPENAI_HOST: base,
            OPENAI_API_KEY: "1claw",
        }),
        modelEnv: "GOOSE_MODEL",
    },
    gemini: {
        bin: "gemini",
        defaultArgs: [],
        env: (base) => ({
            GOOGLE_GEMINI_BASE_URL: base,
            GEMINI_API_KEY: "1claw",
        }),
        note:
            'Headless runs also need security.auth.selectedType: "gemini-api-key" in ~/.gemini/settings.json.',
    },
};

/** Agents that cannot be configured through the environment. */
const CONFIG_FILE_AGENTS: Record<string, string> = {
    codex:
        "Codex reads ~/.codex/config.toml, not environment variables, so it cannot be\n" +
        "  launched this way without editing your config file. Run `1claw proxy` and use\n" +
        "  the Codex block it prints — note `model_provider` must come BEFORE the\n" +
        "  [model_providers.oneclaw] table or TOML parses it as a key on that table.",
};

export const runCommand = new Command("run")
    .description(
        `Run a coding agent through the Shroud proxy (${Object.keys(AGENTS).join(", ")})`,
    )
    // Everything after the agent name belongs to the agent, so `1claw run
    // claude --resume` forwards --resume rather than erroring on it. The
    // trade-off is that 1claw's own flags must come first.
    .usage("[1claw options] <agent> [agent args...]")
    .addHelpText(
        "after",
        `
Options for 1claw go BEFORE the agent name; everything after it is passed
straight to the agent.

  1claw run claude                          # simplest form
  1claw run goose --model claude-sonnet-5   # wrong: --model goes to goose
  1claw run --model claude-sonnet-5 goose   # right
  1claw run claude --resume                 # --resume is forwarded to claude

Credentials come from ONECLAW_AGENT_API_KEY unless --agent-key is given.
`,
    )
    .argument("<agent>", `One of: ${Object.keys(AGENTS).join(", ")}`)
    .argument("[args...]", "Arguments passed through to the agent")
    .option(
        "--agent-key <key>",
        "agent_id:api_key or key-only ocv_... (else ONECLAW_AGENT_API_KEY env)",
    )
    .option("--model <model>", "Model to ask for, where the agent reads one from the environment")
    .option("--shroud-url <url>", "Shroud endpoint", process.env.ONECLAW_SHROUD_URL ?? DEFAULT_SHROUD_URL)
    .option("-p, --port <port>", "Local proxy port (default: an OS-assigned free port)", "0")
    .option("-v, --verbose", "Log each proxied request", false)
    .option(
        "--capture-dir <path>",
        "Write every outgoing request (redacted) to this directory as JSON",
        process.env.ONECLAW_PROXY_CAPTURE_DIR,
    )
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (agentName: string, passthrough: string[], opts) => {
        const key = agentName.toLowerCase();

        if (CONFIG_FILE_AGENTS[key]) {
            printError(`\`1claw run ${key}\` is not supported.`);
            console.log();
            console.log(`  ${CONFIG_FILE_AGENTS[key]}`);
            console.log();
            process.exit(1);
        }

        const spec = AGENTS[key];
        if (!spec) {
            printError(
                `Unknown agent "${agentName}". Supported: ${Object.keys(AGENTS).join(", ")}.`,
            );
            process.exit(1);
        }

        const preferredPort = parseInt(opts.port, 10);
        if (isNaN(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
            printError("Invalid port (use 0–65535).");
            process.exit(1);
        }

        const rawAgentInput = getAgentKeyFromOptsOrEnv(opts.agentKey);
        const agentKey = await resolveShroudAgentKey(rawAgentInput);

        const proxyOpts: ProxyOptions = {
            agentKey,
            provider: undefined,
            shroudUrl: opts.shroudUrl,
            verbose: opts.verbose,
            captureDir: opts.captureDir,
        };

        const server = createProxyServer(proxyOpts);
        let port: number;
        try {
            ({ port } = await listenProxyServer(server, preferredPort));
        } catch (err) {
            printError((err as Error).message);
            process.exit(1);
        }

        const base = `http://127.0.0.1:${port}`;
        const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            ...spec.env(base, `${base}/v1`),
        };
        if (opts.model && spec.modelEnv) childEnv[spec.modelEnv] = opts.model;

        printSuccess(`Proxy on ${chalk.cyan(base)} → ${chalk.dim(opts.shroudUrl)}`);
        if (opts.model && !spec.modelEnv) {
            printInfo(
                `${key} has no model environment variable — ignoring --model; select the model inside the agent.`,
            );
        }
        if (spec.note) printInfo(spec.note);
        console.log();

        const args = [...spec.defaultArgs, ...passthrough];
        const child = spawn(spec.bin, args, { stdio: "inherit", env: childEnv });

        let shuttingDown = false;
        const shutdown = () => {
            if (shuttingDown) return;
            shuttingDown = true;
            server.close();
        };

        child.on("error", (err: NodeJS.ErrnoException) => {
            shutdown();
            if (err.code === "ENOENT") {
                printError(
                    `\`${spec.bin}\` is not on your PATH. Install it first, then re-run.`,
                );
            } else {
                printError(`Failed to start ${spec.bin}: ${err.message}`);
            }
            process.exit(1);
        });

        // Forward signals so Ctrl+C reaches the agent rather than orphaning it.
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
            process.on(sig, () => {
                child.kill(sig);
            });
        }

        child.on("exit", (code, signal) => {
            shutdown();
            process.exit(signal ? 1 : (code ?? 0));
        });
    });
