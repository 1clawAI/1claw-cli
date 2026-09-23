#!/usr/bin/env node
// Detection + config-writing tests for `1claw setup`'s AI-client support.
// Run after `npm run build`:
//   node --test scripts/test-ai-clients.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REAL_PATH = process.env.PATH;
const REAL_HOME = process.env.HOME;

function fakeHome() {
    return mkdtempSync(join(tmpdir(), "1claw-ai-clients-home-"));
}

function withFakeBinary(name) {
    const dir = mkdtempSync(join(tmpdir(), "1claw-ai-clients-bin-"));
    const binPath = join(dir, name);
    writeFileSync(binPath, "#!/bin/sh\necho fake\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = `${dir}:${REAL_PATH}`;
}

function resetEnv() {
    process.env.PATH = REAL_PATH;
    process.env.HOME = REAL_HOME;
}

test("codex is detected via PATH before its config file exists", async () => {
    process.env.HOME = fakeHome();
    withFakeBinary("codex");
    try {
        const { detectAiClients } = await import("../dist/src/ai-clients.js?t=" + Date.now());
        const codex = detectAiClients().find((c) => c.slug === "codex");
        assert.ok(codex, "codex must be a known client");
        assert.equal(codex.detected, true, "a fresh install with no config.toml yet must still be detected via `which codex`");
    } finally {
        resetEnv();
    }
});

test("opencode is detected via PATH before its config file exists", async () => {
    process.env.HOME = fakeHome();
    withFakeBinary("opencode");
    try {
        const { detectAiClients } = await import("../dist/src/ai-clients.js?t=" + Date.now());
        const opencode = detectAiClients().find((c) => c.slug === "opencode");
        assert.ok(opencode, "opencode must be a known client");
        assert.equal(opencode.detected, true, "a fresh install with no opencode.json yet must still be detected via `which opencode`");
    } finally {
        resetEnv();
    }
});

test("codex and opencode are not detected when neither the binary nor a config file exists", async () => {
    process.env.HOME = fakeHome();
    process.env.PATH = "/nonexistent-1claw-test-path";
    try {
        const { detectAiClients } = await import("../dist/src/ai-clients.js?t=" + Date.now());
        const clients = detectAiClients();
        assert.equal(clients.find((c) => c.slug === "codex").detected, false);
        assert.equal(clients.find((c) => c.slug === "opencode").detected, false);
    } finally {
        resetEnv();
    }
});

test("configuring Codex writes a well-formed [mcp_servers.1claw] table and preserves other tables", async () => {
    process.env.HOME = fakeHome();
    mkdirSync(join(process.env.HOME, ".codex"), { recursive: true });
    const configPath = join(process.env.HOME, ".codex", "config.toml");
    writeFileSync(
        configPath,
        [
            'model_provider = "oneclaw"',
            "",
            "[model_providers.oneclaw]",
            'base_url = "http://127.0.0.1:11434/v1"',
            "",
            "[mcp_servers.other-tool]",
            'command = "npx"',
        ].join("\n"),
    );
    try {
        const { detectAiClients, buildMcpEntry, configureClient } = await import(
            "../dist/src/ai-clients.js?t=" + Date.now()
        );
        const codex = detectAiClients().find((c) => c.slug === "codex");
        const entry = buildMcpEntry({ ONECLAW_AGENT_API_KEY: "ocv_test" });

        const first = configureClient(codex, entry);
        assert.equal(first.success, true);
        // Re-running (key rotation, re-setup) must not duplicate the table or
        // touch anything else in the file.
        const second = configureClient(codex, entry);
        assert.equal(second.success, true);

        const { parse } = await import("smol-toml");
        const written = parse(readFileSync(configPath, "utf-8"));
        assert.equal(written.model_provider, "oneclaw", "unrelated top-level key must survive the rewrite");
        assert.equal(written.model_providers.oneclaw.base_url, "http://127.0.0.1:11434/v1");
        assert.equal(written.mcp_servers["other-tool"].command, "npx", "a different server's table must survive the rewrite");
        assert.deepEqual(written.mcp_servers["1claw"].args, entry.args);
        assert.equal(written.mcp_servers["1claw"].env.ONECLAW_AGENT_API_KEY, "ocv_test");
    } finally {
        resetEnv();
    }
});

test("configuring OpenCode writes the mcp.1claw stanza in its documented shape", async () => {
    process.env.HOME = fakeHome();
    try {
        const { detectAiClients, buildMcpEntry, configureClient } = await import(
            "../dist/src/ai-clients.js?t=" + Date.now()
        );
        const opencode = detectAiClients().find((c) => c.slug === "opencode");
        const entry = buildMcpEntry({ ONECLAW_AGENT_API_KEY: "ocv_test" });

        const result = configureClient(opencode, entry);
        assert.equal(result.success, true);

        const written = JSON.parse(
            readFileSync(join(process.env.HOME, ".config", "opencode", "opencode.json"), "utf-8"),
        );
        assert.equal(written.mcp["1claw"].type, "local");
        assert.deepEqual(written.mcp["1claw"].command, [entry.command, ...entry.args]);
        assert.equal(written.mcp["1claw"].environment.ONECLAW_AGENT_API_KEY, "ocv_test");
    } finally {
        resetEnv();
    }
});
