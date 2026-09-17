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
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
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

/** What a forwarder returns: either the upstream answer, or a refusal/failure. */
export type Forwarded =
    | { kind: "upstream"; status: number; headers?: Record<string, string>; body: unknown }
    | { kind: "refused"; detail: string | null; extra?: Record<string, unknown> }
    | { kind: "vault_error"; status: number; detail: string }
    | { kind: "unreachable"; detail: string };

export interface ProxyRequestShape {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
}

export type Forwarder = (r: ProxyRequestShape) => Promise<Forwarded>;

/** Cloud: one execute call per request against the named binding. */
export function cloudBindingForwarder(agentId: string, agentToken: string, binding: string): Forwarder {
    return async ({ method, path, headers, body }) => {
        const params: Record<string, unknown> = { method, path, headers };
        if (body !== undefined) params.body = body;
        try {
            const result = await api<ExecuteHttpResult>(`/agents/${agentId}/execute`, {
                method: "POST",
                token: agentToken,
                body: { binding, intent_type: "http", execution_mode: "vault", params },
            });
            if (result.status !== "completed" || !result.result) {
                // A policy denial or a pending approval is not an upstream answer.
                return {
                    kind: "refused",
                    detail: result.error ?? null,
                    extra: { status: result.status, execution_id: result.execution_id ?? null },
                };
            }
            const u = result.result;
            return { kind: "upstream", status: u.status ?? 200, headers: u.headers, body: u.body };
        } catch (err) {
            if (err instanceof ApiError) return { kind: "vault_error", status: err.status, detail: err.detail };
            return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
        }
    };
}

/**
 * Local: the running `1claw daemon` does the host allowlist and the injection
 * from the local vault, over its Unix socket (`POST /proxy`). Same shape as
 * the cloud path; the policy is `1claw daemon policy add <secret> --hosts ...`.
 */
export function localDaemonForwarder(socketPath: string, secretName: string, baseUrl: string): Forwarder {
    const base = baseUrl.replace(/\/+$/, "");
    return async ({ method, path, headers, body }) => {
        const payload: Record<string, unknown> = { secretName, url: `${base}${path}`, method, headers };
        if (body !== undefined) payload.body = typeof body === "string" ? body : JSON.stringify(body);
        let answer: { status: number; text: string };
        try {
            answer = await unixSocketPost(socketPath, "/proxy", JSON.stringify(payload));
        } catch (err) {
            return { kind: "unreachable", detail: `daemon: ${err instanceof Error ? err.message : String(err)}` };
        }
        let parsed: { status?: number; headers?: Record<string, string>; body?: unknown; error?: string };
        try {
            parsed = JSON.parse(answer.text);
        } catch {
            return { kind: "vault_error", status: answer.status, detail: answer.text.slice(0, 200) };
        }
        if (answer.status === 403) return { kind: "refused", detail: parsed.error ?? null };
        if (answer.status !== 200) return { kind: "vault_error", status: answer.status, detail: parsed.error ?? answer.text.slice(0, 200) };
        return { kind: "upstream", status: parsed.status ?? 200, headers: parsed.headers, body: parsed.body };
    };
}

function unixSocketPost(socketPath: string, path: string, body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            { socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.end(body);
    });
}

interface ProxyDeps {
    forward: Forwarder;
    verbose: boolean;
    /**
     * Per-run bearer the tool must present (as `Authorization: Bearer` or
     * `X-API-Key`, i.e. wherever it would have put its real key). Undefined
     * only under `--no-auth`. Without it, anything on the host that can
     * reach the port can drive the binding (BINDPROXY-M1).
     */
    token?: string;
}

/** A fresh, unguessable proxy token for this run. */
export function newProxyToken(): string {
    return `1cp_${randomBytes(24).toString("base64url")}`;
}

/** Read the credential the tool presented, from whichever header it used. */
export function presentedCredential(headers: IncomingMessage["headers"]): string | undefined {
    const auth = headers["authorization"];
    if (typeof auth === "string") {
        const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
        if (m) return m[1].trim();
    }
    const pa = headers["proxy-authorization"];
    if (typeof pa === "string") {
        const m = /^Bearer\s+(.+)$/i.exec(pa.trim());
        if (m) return m[1].trim();
    }
    const key = headers["x-api-key"];
    if (typeof key === "string" && key.trim()) return key.trim();
    return undefined;
}

export function credentialMatches(presented: string | undefined, expected: string): boolean {
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Handle one request. Exported for the test harness. */
export async function handleProxyRequest(
    deps: ProxyDeps,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const path = req.url ?? "/";
    if (deps.token !== undefined && !credentialMatches(presentedCredential(req.headers), deps.token)) {
        if (deps.verbose) console.log(chalk.yellow(`  ${method} ${path} → 401 (proxy token missing or wrong)`));
        send(res, 401, { "www-authenticate": "Bearer realm=\"1claw-proxy\"" }, JSON.stringify({
            error: "proxy_unauthorized",
            detail: "Send the proxy token printed at startup as the tool's API key (Authorization: Bearer or X-API-Key).",
        }));
        return;
    }
    const raw = await readBody(req);
    const shape: ProxyRequestShape = { method, path, headers: relayableHeaders(req.headers), body: parseBody(raw) };
    const f = await deps.forward(shape);
    switch (f.kind) {
        case "upstream": {
            const headers: Record<string, string> = {};
            const ct = f.headers?.["content-type"] ?? f.headers?.["Content-Type"];
            if (ct) headers["content-type"] = ct;
            const out = typeof f.body === "string" ? f.body : JSON.stringify(f.body ?? null);
            if (deps.verbose) console.log(chalk.dim(`  ${method} ${path} → ${f.status}`));
            send(res, f.status, headers, out);
            return;
        }
        case "refused":
            // 403 tells the tool it was refused; the detail says by what.
            if (deps.verbose) console.log(chalk.yellow(`  ${method} ${path} → refused: ${f.detail ?? ""}`));
            send(res, 403, {}, JSON.stringify({ error: "refused_by_1claw", detail: f.detail, ...(f.extra ?? {}) }));
            return;
        case "vault_error":
            if (deps.verbose) console.log(chalk.red(`  ${method} ${path} → vault ${f.status}: ${f.detail}`));
            send(res, f.status === 401 || f.status === 403 ? f.status : 502, {}, JSON.stringify({ error: "vault_error", status: f.status, detail: f.detail }));
            return;
        case "unreachable":
            if (deps.verbose) console.log(chalk.red(`  ${method} ${path} → unreachable: ${f.detail}`));
            send(res, 502, {}, JSON.stringify({ error: "vault_unreachable", detail: f.detail }));
            return;
    }
}


/** `--no-auth` → undefined; else `--token`, `ONECLAW_PROXY_TOKEN`, or a fresh one. */
function proxyTokenFor(opts: { auth?: boolean; token?: string }): string | undefined {
    if (opts.auth === false) return undefined;
    const pinned = opts.token?.trim() || process.env.ONECLAW_PROXY_TOKEN?.trim();
    return pinned || newProxyToken();
}

function announceToken(token: string | undefined): void {
    if (token === undefined) {
        printInfo(chalk.yellow("--no-auth: any local process that can reach this port can use the binding."));
        return;
    }
    printInfo(`Proxy token (give it to the tool as its API key): ${chalk.bold(token)}`);
}

/** Bind and announce. Shared by the cloud and local commands. */
export function listenProxy(deps: ProxyDeps, host: string, port: number, banner: (base: string) => void): void {
    const server = createServer((req, res) => {
        void handleProxyRequest(deps, req, res);
    });
    server.listen(port, host, () => {
        const addr = server.address();
        const bound = typeof addr === "object" && addr ? addr.port : port;
        banner(`http://${host}:${bound}`);
    });
    server.on("error", (err) => {
        printError(`Could not bind ${host}:${port}: ${err.message}`);
        process.exit(1);
    });
}

export function registerBindingProxyCommand(bindingCommand: Command): void {
    bindingCommand
        .command("proxy <binding>")
        .description("Run a local HTTP proxy that routes a vendor CLI/SDK through one binding (no key on this machine)")
        .option("--agent-key <key>", "agent_id:ocv_... or key-only ocv_... (else ONECLAW_AGENT_API_KEY / ONECLAW_AGENT_ID)")
        .option("-p, --port <port>", `Local port (default ${DEFAULT_PORT}; 0 for OS-assigned)`, String(DEFAULT_PORT))
        .option("--host <host>", "Bind address", "127.0.0.1")
        .option("--token <token>", "Proxy token the tool must present (default: generated per run; env ONECLAW_PROXY_TOKEN)")
        .option("--no-auth", "Accept requests from anything that can reach the port (not recommended)")
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
                forward: cloudBindingForwarder(resolved.agentId, resolved.apiKey, binding),
                verbose: Boolean(opts.verbose),
                token: proxyTokenFor(opts),
            };
            listenProxy(deps, opts.host, port, (base) => {
                printSuccess(`Binding proxy for ${chalk.bold(binding)} listening on ${base}`);
                announceToken(deps.token);
                printInfo(`Agent ${resolved.agentId}. Credentials sent by the tool are dropped here; the vault injects the binding's.`);
                console.log();
                console.log(chalk.bold("  Point the vendor tool at it, with a placeholder key:"));
                console.log(chalk.dim(`    export BANKR_API_URL=${base}`));
                console.log(chalk.dim(`    export BANKR_API_KEY=managed-by-1claw   # any non-empty value; never forwarded`));
                console.log(chalk.dim(`    rm -f ~/.bankr/config.json`));
                console.log();
            });
        });
}

/**
 * `1claw daemon proxy <secret> --base-url <url>` — the same proxy in front of
 * the local daemon: policy and injection come from the local vault, nothing
 * leaves the machine except the upstream call.
 */
export function registerDaemonProxyCommand(daemonCommand: Command, defaultSocket: string): void {
    daemonCommand
        .command("proxy <secret>")
        .description("Run a local HTTP proxy that injects a local-vault secret via the running daemon (host allowlist from `daemon policy`)")
        .requiredOption("--base-url <url>", "Upstream base URL the tool's relative paths are joined to (e.g. https://api.bankr.bot)")
        .option("-p, --port <port>", `Local port (default ${DEFAULT_PORT}; 0 for OS-assigned)`, String(DEFAULT_PORT))
        .option("--host <host>", "Bind address", "127.0.0.1")
        .option("--socket <path>", "Daemon socket path", process.env.ONECLAW_DAEMON_SOCKET || defaultSocket)
        .option("--token <token>", "Proxy token the tool must present (default: generated per run; env ONECLAW_PROXY_TOKEN)")
        .option("--no-auth", "Accept requests from anything that can reach the port (not recommended)")
        .option("-v, --verbose", "Log each proxied request", false)
        .action((secret: string, opts) => {
            const port = parseInt(opts.port, 10);
            if (Number.isNaN(port) || port < 0 || port > 65535) {
                printError("Invalid port (use 0–65535).");
                process.exit(1);
            }
            let baseUrl: URL;
            try {
                baseUrl = new URL(opts.baseUrl);
            } catch {
                printError("--base-url must be an absolute URL, e.g. https://api.bankr.bot");
                process.exit(1);
            }
            const deps: ProxyDeps = {
                forward: localDaemonForwarder(opts.socket, secret, baseUrl.toString()),
                verbose: Boolean(opts.verbose),
                token: proxyTokenFor(opts),
            };
            listenProxy(deps, opts.host, port, (base) => {
                printSuccess(`Daemon proxy for ${chalk.bold(secret)} → ${baseUrl.origin} listening on ${base}`);
                announceToken(deps.token);
                printInfo(`Policy: 1claw daemon policy add ${secret} --hosts ${baseUrl.hostname} --inject-as header --header-name X-API-Key`);
                console.log();
                console.log(chalk.bold("  Point the vendor tool at it, with a placeholder key:"));
                console.log(chalk.dim(`    export BANKR_API_URL=${base}`));
                console.log(chalk.dim(`    export BANKR_API_KEY=managed-by-1claw   # any non-empty value; never forwarded`));
                console.log();
            });
        });
}
