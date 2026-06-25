#!/usr/bin/env node
// 1Claw agent chat UI — a tiny, zero-dependency HTTP server.
//
// It serves a single-page chat interface and bridges browser requests to the
// host daemon over the mounted Unix socket. Secret VALUES never transit this
// process: the daemon injects them into outbound requests and returns only the
// upstream response. This server only ever sees secret NAMES and metadata.
"use strict";

const http = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PORT = parseInt(process.env.CHAT_UI_PORT || "3000", 10);
const SOCKET = process.env.ONECLAW_DAEMON_SOCKET || "/run/1claw/daemon.sock";
const AGENT_ID = process.env.ONECLAW_AGENT_ID || "";
const MODULES = (process.env.ONECLAW_CONTAINER_MODULES || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
const MODE = process.env.ONECLAW_LOCAL_VAULT === "true" ? "local" : "cloud";

let INDEX_HTML = "<h1>1Claw Agent Running</h1>";
try {
    INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf-8");
} catch {
    /* fall back to placeholder */
}

/** Call the host daemon over the Unix socket. */
function daemonRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request(
            {
                socketPath: SOCKET,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(payload
                        ? { "Content-Length": Buffer.byteLength(payload) }
                        : {}),
                },
                timeout: 10000,
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf-8");
                    let parsed = null;
                    try {
                        parsed = text ? JSON.parse(text) : null;
                    } catch {
                        parsed = { raw: text };
                    }
                    resolve({ status: res.statusCode || 0, body: parsed });
                });
            },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("daemon timeout")));
        if (payload) req.write(payload);
        req.end();
    });
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > 1024 * 1024) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

async function daemonReachable() {
    if (MODE !== "local") return false;
    try {
        const r = await daemonRequest("GET", "/health");
        return r.status === 200;
    } catch {
        return false;
    }
}

// A minimal, LLM-optional assistant. Demonstrates the daemon trust boundary
// with slash commands; if an LLM provider is wired in later it replaces this.
async function handleChat(message) {
    const text = (message || "").trim();

    if (text === "/help" || text === "") {
        return {
            reply:
                "1Claw agent ready. Commands:\n" +
                "  /secrets        — list secret names available via the daemon\n" +
                "  /info           — show this agent's runtime info\n" +
                "  /proxy <name> <url> — make a request with the secret injected by the daemon\n" +
                "Secret values never enter this container.",
            tool: null,
        };
    }

    if (text === "/info") {
        return {
            reply: `Agent ${AGENT_ID || "(local)"} · mode=${MODE} · modules=${MODULES.join(", ") || "none"}`,
            tool: "info",
        };
    }

    if (text === "/secrets") {
        try {
            const r = await daemonRequest("GET", "/secrets");
            if (r.status !== 200) {
                return { reply: `Daemon returned ${r.status}`, tool: "list_secrets" };
            }
            const names = (r.body.secrets || []).map((s) => s.name);
            return {
                reply: names.length
                    ? "Available secrets:\n" + names.map((n) => "  • " + n).join("\n")
                    : "No secrets available to this agent.",
                tool: "list_secrets",
            };
        } catch (err) {
            return { reply: `Could not reach daemon: ${err.message}`, tool: "list_secrets" };
        }
    }

    if (text.startsWith("/proxy ")) {
        const parts = text.split(/\s+/);
        const secretName = parts[1];
        const url = parts[2];
        if (!secretName || !url) {
            return { reply: "Usage: /proxy <secret-name> <url>", tool: null };
        }
        try {
            const r = await daemonRequest("POST", "/proxy", {
                secretName,
                url,
                method: "GET",
            });
            return {
                reply:
                    r.status === 200
                        ? `Proxied request (secret injected by daemon). Upstream status: ${r.body.status}`
                        : `Daemon denied request (${r.status}): ${r.body && r.body.error}`,
                tool: "proxy_request",
            };
        } catch (err) {
            return { reply: `Proxy error: ${err.message}`, tool: "proxy_request" };
        }
    }

    return {
        reply:
            "No LLM provider is configured in this container yet. " +
            "Try /help, /secrets, /info, or /proxy. " +
            "Wire a model via a module to enable conversational replies.",
        tool: null,
    };
}

const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    if (url === "/health") {
        return json(res, 200, { status: "ok", agent: AGENT_ID || null, mode: MODE });
    }

    if (url === "/api/info" && method === "GET") {
        return json(res, 200, {
            agentId: AGENT_ID || null,
            modules: MODULES,
            mode: MODE,
            daemonReachable: await daemonReachable(),
        });
    }

    if (url === "/api/secrets" && method === "GET") {
        try {
            const r = await daemonRequest("GET", "/secrets");
            return json(res, r.status, r.body || { secrets: [] });
        } catch (err) {
            return json(res, 502, { error: `daemon unreachable: ${err.message}` });
        }
    }

    if (url === "/api/chat" && method === "POST") {
        let body;
        try {
            body = JSON.parse((await readBody(req)) || "{}");
        } catch {
            return json(res, 400, { error: "invalid JSON" });
        }
        const result = await handleChat(body.message);
        return json(res, 200, result);
    }

    if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(INDEX_HTML);
    }

    json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[chat-ui] listening on :${PORT} (mode=${MODE})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
}
