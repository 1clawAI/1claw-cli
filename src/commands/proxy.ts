/**
 * `1claw proxy` — a local OpenAI-compatible endpoint that forwards to Shroud
 * with the agent's key injected, so IDE/CLI clients never hold it directly.
 *
 * Flags mirror these env vars (flag wins when both are set):
 *   --agent-key <key>       ONECLAW_AGENT_API_KEY (+ optional ONECLAW_AGENT_ID)
 *   --shroud-url <url>      ONECLAW_SHROUD_URL (default https://shroud.1claw.co)
 *   --capture-dir <path>    ONECLAW_PROXY_CAPTURE_DIR — write every outgoing
 *                           request (redacted) to this directory as JSON, to
 *                           turn a real client failure into a permanent
 *                           regression fixture (see
 *                           shroud/tests/fixtures/clients/) without having to
 *                           hand-reconstruct what the client actually sent.
 */
import { Command } from "commander";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import chalk from "chalk";
import { resolveAgentKeyFromInput } from "../lib/agent-key.js";
import { printError, printInfo, printSuccess } from "../output.js";

const DEFAULT_PORT = 11434;
const DEFAULT_SHROUD_URL = "https://shroud.1claw.co";
/** If the preferred port is busy (e.g. Ollama on 11434), try this many consecutive ports. */
const MAX_PORT_TRIES = 32;

/**
 * Bind the server: uses `preferredPort`, or scans upward on EADDRINUSE.
 * `preferredPort === 0` lets the OS pick a free port.
 */
function listenProxyServer(
    server: Server,
    preferredPort: number,
): Promise<{ port: number; usedFallbackPort: boolean }> {
    if (preferredPort === 0) {
        return new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.removeAllListeners("error");
                const addr = server.address();
                const p =
                    addr && typeof addr === "object" ? addr.port : 0;
                resolve({ port: p, usedFallbackPort: false });
            });
        });
    }

    return new Promise((resolve, reject) => {
        let offset = 0;

        const tryPort = (p: number) => {
            const onListen = () => {
                server.off("error", onErr);
                resolve({
                    port: p,
                    usedFallbackPort: p !== preferredPort,
                });
            };
            const onErr = (err: NodeJS.ErrnoException) => {
                server.off("listening", onListen);
                if (
                    err.code === "EADDRINUSE" &&
                    offset < MAX_PORT_TRIES - 1
                ) {
                    offset += 1;
                    tryPort(preferredPort + offset);
                } else if (err.code === "EADDRINUSE") {
                    reject(
                        new Error(
                            `Ports ${preferredPort}–${preferredPort + MAX_PORT_TRIES - 1} are all in use. Stop the other process (e.g. another \`1claw proxy\`, Ollama) or pass --port.`,
                        ),
                    );
                } else {
                    reject(err);
                }
            };
            server.once("listening", onListen);
            server.once("error", onErr);
            server.listen(p, "127.0.0.1");
        };

        tryPort(preferredPort);
    });
}

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

/** Build `agent_id:api_key` for Shroud. Accepts full pair or key-only `ocv_...`. */
async function resolveShroudAgentKey(input: string): Promise<string> {
    try {
        const resolved = await resolveAgentKeyFromInput(input);
        if (!input.includes(":")) {
            printInfo(
                `Resolved agent ${chalk.bold(resolved.agentId)} from API key (key-only auth).`,
            );
        }
        return resolved.shroudAgentKey;
    } catch (err) {
        if (err instanceof Error) {
            printError(err.message);
        } else {
            printError(String(err));
        }
        process.exit(1);
    }
}

/** Only used when the live fetch below fails entirely (network error, Shroud
 * unreachable) — deliberately tiny so there's no temptation to hand-maintain
 * it as a real catalog; that's exactly the drift this replaced. */
const FALLBACK_MODELS_BODY = JSON.stringify({
    object: "list",
    data: [
        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
        { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
        { id: "gemini-2.5-flash", object: "model", owned_by: "google" },
    ],
});

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache: { body: string; fetchedAt: number } | null = null;

/** Fetch Shroud's live GET /v1/models (ProviderRegistry::client_facing_models
 * — the real per-provider TOML allowlists merged with Stripe's own
 * hourly-refreshed catalog), cached briefly so a client that polls this on
 * every keystroke doesn't hammer Shroud. Never throws — falls back to a tiny
 * static list on any failure so a client's startup probe never hard-fails. */
function fetchLiveModels(shroudUrl: string): Promise<string> {
    return new Promise((resolve) => {
        // Everything here is inside try/catch, not just the URL parse.
        // `httpsRequest` throws ERR_INVALID_PROTOCOL *synchronously* for an
        // http: URL — that is outside any 'error' handler, so it escaped this
        // promise entirely and took the whole proxy process down on the first
        // client startup probe whenever --shroud-url was plain HTTP (a local
        // or self-hosted Shroud). Pick the module by protocol, and keep the
        // catch as a backstop so this function's "never throws" contract is
        // actually true.
        try {
            const url = new URL("/v1/models", shroudUrl);
            const request = url.protocol === "http:" ? httpRequest : httpsRequest;
            const req = request(url, { method: "GET" }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const status = res.statusCode ?? 0;
                    if (status >= 200 && status < 300) {
                        resolve(Buffer.concat(chunks).toString("utf-8"));
                    } else {
                        resolve(FALLBACK_MODELS_BODY);
                    }
                });
            });
            req.on("error", () => resolve(FALLBACK_MODELS_BODY));
            req.setTimeout(5000, () => {
                req.destroy();
                resolve(FALLBACK_MODELS_BODY);
            });
            req.end();
        } catch {
            resolve(FALLBACK_MODELS_BODY);
        }
    });
}

async function getModelsList(shroudUrl: string): Promise<string> {
    const now = Date.now();
    if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
        return modelsCache.body;
    }
    const body = await fetchLiveModels(shroudUrl);
    modelsCache = { body, fetchedAt: now };
    return body;
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
    /** When set, every outgoing request body is written here (redacted) before forwarding. */
    captureDir?: string;
}

/**
 * 1claw-shaped API keys this CLI ever handles: agent keys (ocv_), user keys
 * (1ck_), platform keys (plt_), and provider keys under the sk- prefix
 * (OpenAI-style). Same pattern already used to keep these out of generated
 * template code — see packages/cli/scripts/test-spawn-templates.mjs's
 * SECRET_PATTERN.
 */
const CAPTURE_SECRET_PATTERN = /sk-[a-zA-Z0-9]{20,}|1ck_[a-zA-Z0-9]+|ocv_[a-zA-Z0-9]+|plt_[a-zA-Z0-9]+/g;

/** Headers whose value is never written to a capture file, only that it was present. */
const CAPTURE_REDACTED_HEADERS = new Set(["authorization", "x-shroud-agent-key"]);

function redactCaptureText(text: string): string {
    return text.replace(CAPTURE_SECRET_PATTERN, "[REDACTED]");
}

/**
 * Writes one outgoing request to `<dir>/<timestamp>-<random>.json`, headers
 * and body redacted, for turning a real-world failure into a permanent
 * fixture (see shroud/tests/fixtures/clients/) without hand-reconstructing
 * what a client actually sent. Never throws — a capture failure must not
 * break the proxy itself.
 */
function captureOutgoingRequest(
    dir: string,
    info: { method: string; url: string; headers: Record<string, string>; body: Buffer },
): void {
    try {
        const redactedHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(info.headers)) {
            redactedHeaders[key] = CAPTURE_REDACTED_HEADERS.has(key.toLowerCase())
                ? "[REDACTED]"
                : redactCaptureText(value);
        }

        let bodyField: unknown = redactCaptureText(info.body.toString("utf-8"));
        try {
            // Pretty-print when it's JSON, same redaction pass either way.
            bodyField = JSON.parse(bodyField as string);
        } catch {
            // not JSON — keep as a redacted string
        }

        const record = {
            captured_at: new Date().toISOString(),
            method: info.method,
            url: info.url,
            headers: redactedHeaders,
            body: bodyField,
        };

        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
        writeFileSync(join(dir, filename), JSON.stringify(record, null, 2) + "\n", "utf-8");
    } catch (err) {
        console.error(
            chalk.yellow("  capture failed (proxy continues normally):"),
            (err as Error).message,
        );
    }
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

    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    if (!provider && (pathOnly.includes("/v1/messages") || pathOnly.endsWith("/messages"))) {
        provider = "anthropic";
    }

    // A native Google client (Gemini CLI's own `GOOGLE_GEMINI_BASE_URL` override
    // points its unmodified REST client straight at this proxy) sends
    // `contents`/`systemInstruction` — no top-level `model` field at all, since
    // the model is a URL path segment instead. Without this, provider silently
    // defaulted to "openai" below, and Shroud — expecting an OpenAI-shaped body
    // for that provider — couldn't parse `req.messages` from it, fell back to
    // scanning the raw body, and false-positive-blocked on ordinary shell
    // syntax in Gemini CLI's own system instructions (the same false-positive
    // shape fixed for OpenCode, here caused by a provider mislabel instead of a
    // scan-scope bug).
    if (!provider) {
        const geminiMatch = pathOnly.match(
            /^\/v1beta\/models\/([^/:]+):(?:generateContent|streamGenerateContent|countTokens)$/,
        );
        if (geminiMatch) {
            provider = "google";
            if (!model) model = geminiMatch[1] ?? "";
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

    if (opts.captureDir) {
        captureOutgoingRequest(opts.captureDir, {
            method: req.method ?? "POST",
            url: req.url ?? "/",
            headers,
            body,
        });
    }

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

/** CLI flag or ONECLAW_AGENT_API_KEY (+ optional ONECLAW_AGENT_ID), same as MCP examples. */
function getAgentKeyFromOptsOrEnv(agentKeyFlag: string | undefined): string {
    const flag = agentKeyFlag?.trim();
    if (flag) return flag;
    const envKey = process.env.ONECLAW_AGENT_API_KEY?.trim();
    const envId = process.env.ONECLAW_AGENT_ID?.trim();
    if (envId && envKey) return `${envId}:${envKey}`;
    if (envKey) return envKey;
    printError(
        "Missing agent credentials: use --agent-key, or set ONECLAW_AGENT_API_KEY (and optionally ONECLAW_AGENT_ID for non-ocv flows).",
    );
    process.exit(1);
}

type ClientSetup = {
    /** How the tool names itself. */
    name: string;
    /** Body lines, already indented. `chalk.cyan` the URL, `chalk.dim` the rest. */
    lines: string[];
};

/**
 * Setup for every client we have actually run traffic through.
 *
 * "Verified" means this repo carries a real wire fixture for the client
 * (`shroud/tests/fixtures/clients/`) and/or a routing row in
 * `popular_client_and_model_combinations_resolve_correctly` in
 * `shroud/src/router.rs`. Keep this list and
 * `docs/docs/agents/shroud/ide-setup.md` in step — that page is the long form
 * of the same content, and the guided onboarding page renders one entry of it
 * at a time (`dashboard/src/app/onboarding/guided/page.tsx`).
 */
function verifiedClients(base: string, openaiV1: string): ClientSetup[] {
    const d = chalk.dim;
    return [
        {
            name: "Claude Code",
            lines: [
                d(`    export ANTHROPIC_BASE_URL="${base}"`),
                d(`    export ANTHROPIC_API_KEY="1claw"`),
                d(`    # Optional if MCP tool search matters: ENABLE_TOOL_SEARCH=true`),
                d(`    claude`),
            ],
        },
        {
            name: "Codex",
            lines: [
                d(`    ~/.codex/config.toml — model_provider must come BEFORE the table,`),
                d(`    or TOML reads it as a key on the table instead of a top-level key:`),
                d(``),
                d(`      model_provider = "oneclaw"`),
                d(``),
                d(`      [model_providers.oneclaw]`),
                d(`      name = "1claw"`),
                `      ${d("base_url = ")}${chalk.cyan(`"${openaiV1}"`)}`,
                d(`      env_key = "ONECLAW_PROXY_KEY"`),
                d(``),
                d(`    Any value works for ONECLAW_PROXY_KEY — the proxy handles real auth.`),
            ],
        },
        {
            name: "OpenCode",
            lines: [
                d(`    export OPENAI_BASE_URL="${openaiV1}"`),
                d(`    export OPENAI_API_KEY="1claw"`),
                d(`    opencode`),
                d(`    (or set the same base URL in opencode.json's provider config)`),
            ],
        },
        {
            name: "OpenClaude",
            lines: [
                d(`    export OPENAI_BASE_URL="${openaiV1}"`),
                d(`    export OPENAI_API_KEY="1claw"`),
                d(`    openclaude --provider openai`),
            ],
        },
        {
            name: "Goose",
            lines: [
                d(`    export GOOSE_PROVIDER=openai`),
                d(`    export GOOSE_MODEL=claude-sonnet-5   # any model the proxy should route`),
                `    ${d('export OPENAI_HOST="')}${chalk.cyan(base)}${d('"')}   ${d("# host, NOT /v1")}`,
                d(`    export OPENAI_API_KEY="1claw"`),
                d(`    goose run -t "your prompt"`),
            ],
        },
        {
            name: "Gemini CLI",
            lines: [
                `    ${d('export GOOGLE_GEMINI_BASE_URL="')}${chalk.cyan(base)}${d('"')}`,
                d(`    export GEMINI_API_KEY="1claw"`),
                d(`    gemini --skip-trust -p "your prompt"`),
                d(`    # headless also needs security.auth.selectedType: "gemini-api-key"`),
                d(`    # in ~/.gemini/settings.json`),
            ],
        },
        {
            name: "Cursor",
            lines: [
                `    ${d("Settings → Models → OpenAI (override)")} → Base URL: ${chalk.cyan(openaiV1)} → API key: ${d("1claw (any value)")}`,
            ],
        },
    ];
}

/**
 * Clients we document and expect to work, but do not exercise in the client
 * test suite. Listed separately so the output never implies more coverage
 * than exists.
 */
function untestedClients(openaiV1: string): ClientSetup[] {
    const d = chalk.dim;
    return [
        {
            name: "VS Code + GitHub Copilot",
            lines: [
                `    ${d("Chat → model picker → Manage models → add OpenAI-compatible → Base URL:")} ${chalk.cyan(openaiV1)}`,
                d("    (May require VS Code Insiders; BYOK not on all Copilot org plans — see docs.)"),
            ],
        },
        {
            name: "Continue / other OpenAI-compatible extensions",
            lines: [d(`    "apiBase": "${openaiV1}"`)],
        },
    ];
}

function printClient(c: ClientSetup): void {
    console.log(chalk.bold(`  ${c.name}`));
    for (const line of c.lines) console.log(line);
    console.log();
}

function printIdeSetupBlock(boundPort: number): void {
    const base = `http://127.0.0.1:${boundPort}`;
    const openaiV1 = `${base}/v1`;

    for (const c of verifiedClients(base, openaiV1)) printClient(c);

    console.log(chalk.dim("  Also OpenAI-compatible (not in our client test matrix)"));
    console.log();
    for (const c of untestedClients(openaiV1)) printClient(c);

    console.log(chalk.bold("  curl (OpenAI-style)"));
    console.log(
        chalk.dim(
            `    curl ${openaiV1}/chat/completions \\
      -H "Content-Type: application/json" \\
      -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'`,
        ),
    );
    console.log();
    console.log(
        chalk.dim(`  Full setup notes: https://docs.1claw.co/docs/agents/shroud/ide-setup`),
    );
    console.log();
}

export const proxyCommand = new Command("proxy")
    .description(
        "Start a local OpenAI-compatible proxy that routes through Shroud",
    )
    .option(
        "--agent-key <key>",
        "agent_id:api_key or key-only ocv_... (else ONECLAW_AGENT_API_KEY env)",
    )
    .option(
        "-p, --port <port>",
        `Local port (default ${DEFAULT_PORT}). If busy, tries up to ${MAX_PORT_TRIES} higher ports. Use 0 for OS-assigned.`,
        String(DEFAULT_PORT),
    )
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
    .option(
        "--capture-dir <path>",
        "Write every outgoing request (redacted) to this directory as JSON — for building a permanent fixture from a real failure (else ONECLAW_PROXY_CAPTURE_DIR env)",
        process.env.ONECLAW_PROXY_CAPTURE_DIR,
    )
    .action(async (opts) => {
        const preferredPort = parseInt(opts.port, 10);
        if (
            isNaN(preferredPort) ||
            preferredPort < 0 ||
            preferredPort > 65535
        ) {
            printError("Invalid port (use 0–65535).");
            process.exit(1);
        }

        const rawAgentInput = getAgentKeyFromOptsOrEnv(opts.agentKey);
        if (!opts.agentKey?.trim() && process.env.ONECLAW_AGENT_API_KEY) {
            printInfo("Using agent credentials from ONECLAW_AGENT_API_KEY.");
            console.log();
        }
        const agentKey = await resolveShroudAgentKey(rawAgentInput);

        const proxyOpts: ProxyOptions = {
            agentKey,
            provider: opts.provider,
            shroudUrl: opts.shroudUrl,
            verbose: opts.verbose,
            captureDir: opts.captureDir,
        };

        if (proxyOpts.captureDir) {
            printInfo(`Capturing outgoing requests (redacted) to ${chalk.bold(proxyOpts.captureDir)}`);
            console.log();
        }

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

            // Path without the query string. Clients append one more often
            // than you would think (model pickers send /v1/models?limit=…),
            // and an exact === match on req.url silently proxied those
            // upstream instead of answering locally — the symptom is a model
            // dropdown that comes back empty for no visible reason.
            const routePath = (req.url ?? "").split("?")[0] ?? "";

            // Health check for tooling that probes the proxy
            if (routePath === "/health" || routePath === "/v1/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", proxy: "1claw" }));
                return;
            }

            // Models endpoint — many clients probe this on startup. Fetched
            // live from Shroud's own GET /v1/models (see
            // ProviderRegistry::client_facing_models in shroud/src/proxy/
            // provider_registry.rs), not hand-maintained here — a real
            // Stripe LLM Token Billing rate card runs 100+ models across a
            // dozen providers, versioned independently of anything in this
            // repo, and a hand-copied list drifted (wrong/stale model IDs,
            // e.g. a missing "-1" suffix, or a deprecated dated snapshot)
            // until a real "Please provide a supported model" report caught
            // it. FALLBACK_MODELS below is deliberately tiny — it's a safety
            // net for when Shroud is unreachable, not a list to maintain.
            if (routePath === "/v1/models" || routePath === "/models") {
                const body = await getModelsList(proxyOpts.shroudUrl);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(body);
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

        let boundPort: number;
        try {
            const { port, usedFallbackPort } = await listenProxyServer(
                server,
                preferredPort,
            );
            boundPort = port;
            if (usedFallbackPort) {
                printInfo(
                    `Port ${chalk.bold(String(preferredPort))} was in use (e.g. Ollama or another proxy); using ${chalk.bold(String(port))} instead.`,
                );
                console.log();
            }
        } catch (err) {
            if (err instanceof Error) {
                printError(err.message);
            } else {
                printError(String(err));
            }
            process.exit(1);
        }

        console.log();
        printSuccess(
            `1Claw LLM proxy running on ${chalk.bold(`http://127.0.0.1:${boundPort}`)}`,
        );
        console.log(
            `  ${chalk.dim("→")} Forwarding to ${chalk.cyan(proxyOpts.shroudUrl)}`,
        );
        console.log(
            `  ${chalk.dim("→")} Provider: ${proxyOpts.provider ? chalk.cyan(proxyOpts.provider) : chalk.dim("auto-detect from model name")}`,
        );
        console.log();
        console.log(chalk.bold("  Configure your tools (copy-paste)"));
        console.log();
        printIdeSetupBlock(boundPort);
        printInfo("Press Ctrl+C to stop.");
        console.log();

        const shutdown = () => {
            console.log();
            printInfo("Shutting down proxy…");
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    });
