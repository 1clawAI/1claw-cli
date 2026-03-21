import { Command } from "commander";
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import chalk from "chalk";
import { apiNoAuth, ApiError } from "../client.js";
import { printError, printInfo, printSuccess } from "../output.js";

const DEFAULT_PORT = 11434;
const DEFAULT_SHROUD_URL = "https://shroud.1claw.xyz";

const PROVIDER_FROM_MODEL: Record<string, string> = {
    "gpt-": "openai",
    "o1": "openai",
    "o3": "openai",
    "o4": "openai",
    "chatgpt-": "openai",
    "claude-": "anthropic",
    "gemini-": "google",
    "mistral-": "mistral",
    "command-": "cohere",
    "openrouter/": "openrouter",
};

/** Build `agent_id:api_key` for Shroud. Accepts full pair or key-only `ocv_...` (Vault resolves agent by prefix). */
async function resolveShroudAgentKey(input: string): Promise<string> {
    const trimmed = input.trim();
    if (trimmed.includes(":")) {
        return trimmed;
    }
    if (!trimmed.startsWith("ocv_")) {
        printError(
            "Pass agent credentials as agent_id:api_key, or a standalone agent API key (ocv_...).",
        );
        process.exit(1);
    }
    try {
        const res = await apiNoAuth<{ agent_id?: string }>("/auth/agent-token", {
            method: "POST",
            body: { api_key: trimmed },
        });
        if (!res.agent_id) {
            printError(
                "Token exchange succeeded but server did not return agent_id. Use agent_id:api_key explicitly.",
            );
            process.exit(1);
        }
        printInfo(
            `Resolved agent ${chalk.bold(res.agent_id)} from API key (key-only auth).`,
        );
        return `${res.agent_id}:${trimmed}`;
    } catch (err) {
        if (err instanceof ApiError) {
            printError(
                `Could not resolve agent from API key (${err.status}): ${err.detail}`,
            );
        } else if (err instanceof Error) {
            printError(err.message);
        } else {
            printError(String(err));
        }
        process.exit(1);
    }
}

function detectProvider(model: string): string {
    const lower = model.toLowerCase();
    for (const [prefix, provider] of Object.entries(PROVIDER_FROM_MODEL)) {
        if (lower.startsWith(prefix)) return provider;
    }
    return "openai";
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

interface ProxyOptions {
    agentKey: string;
    provider?: string;
    shroudUrl: string;
    verbose: boolean;
}

function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    opts: ProxyOptions,
): void {
    let provider = opts.provider ?? "";
    let model = "";

    if (body.length > 0) {
        try {
            const parsed = JSON.parse(body.toString()) as { model?: string };
            if (parsed.model) {
                model = parsed.model;
                if (!provider) provider = detectProvider(model);
            }
        } catch {
            // not JSON — forward as-is
        }
    }

    if (!provider) provider = "openai";

    const upstream = new URL(req.url ?? "/", opts.shroudUrl);

    const headers: Record<string, string> = {
        "X-Shroud-Agent-Key": opts.agentKey,
        "X-Shroud-Provider": provider,
        "Content-Type": "application/json",
    };
    if (model) headers["X-Shroud-Model"] = model;
    if (body.length > 0) headers["Content-Length"] = String(body.length);

    if (opts.verbose) {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(
            chalk.dim(`[${ts}]`),
            chalk.cyan(req.method),
            req.url,
            chalk.dim("→"),
            `${provider}/${model || "?"}`,
        );
    }

    const upstreamReq = httpsRequest(
        upstream,
        {
            method: req.method ?? "POST",
            headers,
        },
        (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);

            if (opts.verbose) {
                const ts = new Date().toISOString().slice(11, 19);
                const status = upstreamRes.statusCode ?? 0;
                const color = status < 400 ? chalk.green : chalk.red;
                console.log(
                    chalk.dim(`[${ts}]`),
                    color(String(status)),
                    req.url,
                );
            }
        },
    );

    upstreamReq.on("error", (err) => {
        console.error(chalk.red("  upstream error:"), err.message);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: { message: `Shroud unreachable: ${err.message}`, type: "proxy_error" } }));
    });

    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
}

export const proxyCommand = new Command("proxy")
    .description(
        "Start a local OpenAI-compatible proxy that routes through Shroud",
    )
    .requiredOption(
        "--agent-key <key>",
        "agent_id:api_key or key-only ocv_... (resolved via POST /v1/auth/agent-token)",
    )
    .option("-p, --port <port>", "Local port to listen on", String(DEFAULT_PORT))
    .option(
        "--provider <name>",
        "Force a provider (openai, anthropic, google, etc.) instead of auto-detecting from model",
    )
    .option(
        "--shroud-url <url>",
        "Shroud endpoint",
        process.env.ONECLAW_SHROUD_URL ?? DEFAULT_SHROUD_URL,
    )
    .option("-v, --verbose", "Log each proxied request", false)
    .action(async (opts) => {
        const port = parseInt(opts.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
            printError("Invalid port number.");
            process.exit(1);
        }

        const agentKey = await resolveShroudAgentKey(opts.agentKey);

        const proxyOpts: ProxyOptions = {
            agentKey,
            provider: opts.provider,
            shroudUrl: opts.shroudUrl,
            verbose: opts.verbose,
        };

        const server = createServer(async (req, res) => {
            // CORS preflight
            if (req.method === "OPTIONS") {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                });
                res.end();
                return;
            }

            // Health check for tooling that probes the proxy
            if (req.url === "/health" || req.url === "/v1/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", proxy: "1claw" }));
                return;
            }

            // Models endpoint — many clients probe this on startup
            if (req.url === "/v1/models" || req.url === "/models") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    object: "list",
                    data: [
                        { id: "gpt-4o", object: "model", owned_by: "openai" },
                        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
                        { id: "gpt-4.1", object: "model", owned_by: "openai" },
                        { id: "gpt-4.1-mini", object: "model", owned_by: "openai" },
                        { id: "o3-mini", object: "model", owned_by: "openai" },
                        { id: "claude-sonnet-4-20250514", object: "model", owned_by: "anthropic" },
                        { id: "claude-3.5-sonnet-20241022", object: "model", owned_by: "anthropic" },
                        { id: "gemini-2.5-flash", object: "model", owned_by: "google" },
                        { id: "gemini-2.5-pro", object: "model", owned_by: "google" },
                    ],
                }));
                return;
            }

            try {
                const body = await readBody(req);
                forwardRequest(req, res, body, proxyOpts);
            } catch (err) {
                console.error(chalk.red("  request error:"), (err as Error).message);
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                }
                res.end(JSON.stringify({ error: { message: "proxy internal error", type: "proxy_error" } }));
            }
        });

        server.listen(port, "127.0.0.1", () => {
            console.log();
            printSuccess(
                `1Claw LLM proxy running on ${chalk.bold(`http://127.0.0.1:${port}`)}`,
            );
            console.log(
                `  ${chalk.dim("→")} Forwarding to ${chalk.cyan(proxyOpts.shroudUrl)}`,
            );
            console.log(
                `  ${chalk.dim("→")} Provider: ${proxyOpts.provider ? chalk.cyan(proxyOpts.provider) : chalk.dim("auto-detect from model name")}`,
            );
            console.log();
            console.log(chalk.bold("  Configure your editor:"));
            console.log();
            console.log(
                `  ${chalk.bold("Cursor / VS Code (OpenAI override):")}`,
            );
            console.log(
                `    Base URL:  ${chalk.cyan(`http://127.0.0.1:${port}/v1`)}`,
            );
            console.log(
                `    API Key:   ${chalk.dim("any value (e.g. \"1claw\")")}`,
            );
            console.log();
            console.log(`  ${chalk.bold("Continue (~/.continue/config.json):")}`);
            console.log(
                chalk.dim(`    {
      "models": [{
        "title": "1Claw Shroud",
        "provider": "openai",
        "model": "gpt-4o",
        "apiBase": "http://127.0.0.1:${port}/v1",
        "apiKey": "1claw"
      }]
    }`),
            );
            console.log();
            console.log(`  ${chalk.bold("curl:")}`);
            console.log(
                chalk.dim(
                    `    curl http://127.0.0.1:${port}/v1/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'`,
                ),
            );
            console.log();
            printInfo("Press Ctrl+C to stop.");
            console.log();
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                printError(
                    `Port ${port} is already in use. Try --port ${port + 1}`,
                );
            } else {
                printError(`Server error: ${err.message}`);
            }
            process.exit(1);
        });

        const shutdown = () => {
            console.log();
            printInfo("Shutting down proxy…");
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    });
