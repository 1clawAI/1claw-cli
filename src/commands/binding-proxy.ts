/**
 * `1claw agent binding proxy` — a local HTTP front for one execution binding.
 *
 * Vendor CLIs and SDKs almost all accept a base-URL override (Bankr's is
 * `BANKR_API_URL`). Point that at this proxy and the tool keeps working with
 * no key on the machine: every request becomes `POST /v1/agents/{id}/execute`
 * for the named binding, the vault checks the host and path allowlists and
 * the agent's policies, injects the credential, and returns the upstream
 * response. Whatever the tool sends as its own credential is discarded here,
 * never forwarded, so a placeholder like `BANKR_API_KEY=managed-by-1claw`
 * satisfies the tool's "must be non-empty" check without being anything.
 *
 * If the vault is unreachable the proxy answers 502 and the tool stops. That
 * is the point.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Command } from "commander";
import chalk from "chalk";
import { api, ApiError } from "../client.js";
import { printError, printInfo, printSuccess } from "../output.js";
import { resolveAgentKeyFromInput } from "../lib/agent-key.js";

const DEFAULT_PORT = 8787;

/**
 * Request headers the proxy is willing to relay. Everything else — and above
 * all anything that looks like a credential — is dropped before the vault
 * sees it. The vault applies its own allowlist on top of this one.
 */
const RELAYED_HEADERS = new Set(["content-type", "accept", "user-agent", "idempotency-key"]);

/** Header names that must never be relayed, even if a binding allowlists them. */
export const NEVER_RELAY = ["authorization", "x-api-key", "cookie", "proxy-authorization", "host"];

export interface ExecuteHttpResult {
    execution_id?: string;
    status: string;
    result?: { status?: number; headers?: Record<string, string>; body?: unknown };
    error?: string;
}

/** Pick the headers to relay from an incoming request. Pure, so it is testable. */
export function relayableHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (NEVER_RELAY.includes(lower)) continue;
        if (!RELAYED_HEADERS.has(lower)) continue;
        if (typeof value === "string") out[lower] = value;
        else if (Array.isArray(value)) out[lower] = value.join(", ");
    }
    return out;
}

/** The vault's http executor sends `body` as JSON; a non-JSON body is passed as a string. */
export function parseBody(raw: Buffer): unknown {
    if (raw.length === 0) return undefined;
    const text = raw.toString("utf8");
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body);
}

interface ProxyDeps {
    agentId: string;
    agentToken: string;
    binding: string;
    verbose: boolean;
}

/** Handle one request. Exported for the test harness. */
export async function handleProxyRequest(
    deps: ProxyDeps,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = req.url ?? "/";
    const raw = await readBody(req);
    const params: Record<string, unknown> = {
        method,
        path,
        headers: relayableHeaders(req.headers),
    };
    const body = parseBody(raw);
    if (body !== undefined) params.body = body;

    try {
        const result = await api<ExecuteHttpResult>(`/agents/${deps.agentId}/execute`, {
            method: "POST",
            token: deps.agentToken,
            body: {
                binding: deps.binding,
                intent_type: "http",
                execution_mode: "vault",
                params,
            },
        });
        if (result.status !== "completed" || !result.result) {
            // A policy denial or a pending approval is not an upstream answer.
            // 403 tells the tool it was refused; the detail says by what.
            if (deps.verbose) console.log(chalk.yellow(`  ${method} ${path} → refused: ${result.error ?? result.status}`));
            send(res, 403, {}, JSON.stringify({ error: "refused_by_1claw", status: result.status, detail: result.error ?? null, execution_id: result.execution_id ?? null }));
            return;
        }
        const upstream = result.result;
        const status = upstream.status ?? 200;
        const headers: Record<string, string> = {};
        const ct = upstream.headers?.["content-type"] ?? upstream.headers?.["Content-Type"];
        if (ct) headers["content-type"] = ct;
        const out = typeof upstream.body === "string" ? upstream.body : JSON.stringify(upstream.body ?? null);
        if (deps.verbose) console.log(chalk.dim(`  ${method} ${path} → ${status}`));
        send(res, status, headers, out);
    } catch (err) {
        if (err instanceof ApiError) {
            if (deps.verbose) console.log(chalk.red(`  ${method} ${path} → vault ${err.status}: ${err.detail}`));
            send(res, err.status === 401 || err.status === 403 ? err.status : 502, {}, JSON.stringify({ error: "vault_error", status: err.status, detail: err.detail }));
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (deps.verbose) console.log(chalk.red(`  ${method} ${path} → unreachable: ${msg}`));
        send(res, 502, {}, JSON.stringify({ error: "vault_unreachable", detail: msg }));
    }
}

export function registerBindingProxyCommand(bindingCommand: Command): void {
    bindingCommand
        .command("proxy <binding>")
        .description("Run a local HTTP proxy that routes a vendor CLI/SDK through one binding (no key on this machine)")
        .option("--agent-key <key>", "agent_id:ocv_... or key-only ocv_... (else ONECLAW_AGENT_API_KEY / ONECLAW_AGENT_ID)")
        .option("-p, --port <port>", `Local port (default ${DEFAULT_PORT}; 0 for OS-assigned)`, String(DEFAULT_PORT))
        .option("--host <host>", "Bind address", "127.0.0.1")
        .option("-v, --verbose", "Log each proxied request", false)
        .action(async (binding: string, opts) => {
            const port = parseInt(opts.port, 10);
            if (Number.isNaN(port) || port < 0 || port > 65535) {
                printError("Invalid port (use 0–65535).");
                process.exit(1);
            }
            const input: string | undefined =
                opts.agentKey?.trim() ||
                (process.env.ONECLAW_AGENT_ID && process.env.ONECLAW_AGENT_API_KEY
                    ? `${process.env.ONECLAW_AGENT_ID.trim()}:${process.env.ONECLAW_AGENT_API_KEY.trim()}`
                    : process.env.ONECLAW_AGENT_API_KEY?.trim());
            if (!input) {
                printError("Missing agent credentials: use --agent-key, or set ONECLAW_AGENT_API_KEY (and optionally ONECLAW_AGENT_ID).");
                process.exit(1);
            }
            let resolved;
            try {
                resolved = await resolveAgentKeyFromInput(input);
            } catch (err) {
                printError(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
            const deps: ProxyDeps = {
                agentId: resolved.agentId,
                agentToken: resolved.apiKey,
                binding,
                verbose: Boolean(opts.verbose),
            };
            const server = createServer((req, res) => {
                void handleProxyRequest(deps, req, res);
            });
            server.listen(port, opts.host, () => {
                const addr = server.address();
                const bound = typeof addr === "object" && addr ? addr.port : port;
                const base = `http://${opts.host}:${bound}`;
                printSuccess(`Binding proxy for ${chalk.bold(binding)} listening on ${base}`);
                printInfo(`Agent ${resolved.agentId}. Credentials sent by the tool are dropped here; the vault injects the binding's.`);
                console.log();
                console.log(chalk.bold("  Point the vendor tool at it, with a placeholder key:"));
                console.log(chalk.dim(`    export BANKR_API_URL=${base}`));
                console.log(chalk.dim(`    export BANKR_API_KEY=managed-by-1claw   # any non-empty value; never forwarded`));
                console.log(chalk.dim(`    rm -f ~/.bankr/config.json`));
                console.log();
            });
            server.on("error", (err) => {
                printError(`Could not bind ${opts.host}:${port}: ${err.message}`);
                process.exit(1);
            });
        });
}
