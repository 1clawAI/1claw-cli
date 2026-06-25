#!/usr/bin/env node
// Unit tests for the `init --docker` / module system feature.
// Run after `npm run build`:  node --test scripts/test-docker.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated config dir BEFORE importing modules that read it at load time.
const TMP_CONFIG = mkdtempSync(join(tmpdir(), "1claw-test-cfg-"));
process.env.ONECLAW_CONFIG_DIR = TMP_CONFIG;

const registry = await import("../dist/src/modules/registry.js");
const config = await import("../dist/src/lib/container-config.js");
const imageBuild = await import("../dist/src/lib/image-build.js");

test("listModuleNames returns the five bundled modules", () => {
    const names = registry.listModuleNames();
    assert.deepEqual(
        names,
        ["ampersend", "elizaos", "langchain", "onchain", "scaffold-agent"],
    );
});

test("loadModule parses a manifest", () => {
    const m = registry.loadModule("ampersend");
    assert.equal(m.name, "ampersend");
    assert.ok(m.docker.packages.includes("@ampersend/sdk@latest"));
    assert.equal(m.docker.env.AMPERSEND_ENABLED, "true");
});

test("loadModule throws on unknown module", () => {
    assert.throws(() => registry.loadModule("does-not-exist"), /Unknown module/);
});

test("resolveModules pulls in dependencies in topological order", () => {
    const resolved = registry.resolveModules(["scaffold-agent"]);
    const order = resolved.map((m) => m.name);
    // onchain is a dependency of scaffold-agent and must precede it.
    assert.ok(order.includes("onchain"));
    assert.ok(order.includes("scaffold-agent"));
    assert.ok(order.indexOf("onchain") < order.indexOf("scaffold-agent"));
});

test("resolveModules dedupes repeated names", () => {
    const resolved = registry.resolveModules(["onchain", "onchain"]);
    assert.equal(resolved.filter((m) => m.name === "onchain").length, 1);
});

test("moduleSetHash is deterministic and order-independent of input set", () => {
    const a = registry.moduleSetHash(registry.resolveModules(["onchain"]));
    const b = registry.moduleSetHash(registry.resolveModules(["onchain"]));
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
});

test("generateDockerLayers emits FROM-free module layers", () => {
    const layers = registry.generateDockerLayers(
        registry.resolveModules(["ampersend"]),
    );
    assert.ok(layers.includes("# --- Module: ampersend"));
    assert.ok(layers.includes("RUN npm install -g @ampersend/sdk@latest"));
    assert.ok(layers.includes("ENV AMPERSEND_ENABLED=true"));
    assert.ok(!layers.includes("FROM "));
});

test("generateDockerfile includes base image and module layers", () => {
    const df = imageBuild.generateDockerfile(
        "1claw/agent:stable",
        registry.resolveModules(["onchain"]),
    );
    assert.ok(df.startsWith("# Generated"));
    assert.ok(df.includes("FROM 1claw/agent:stable"));
    assert.ok(df.includes("# --- Module: onchain"));
});

test("generateDockerfile with no modules is just the FROM line", () => {
    const df = imageBuild.generateDockerfile("1claw/agent:stable", []);
    assert.ok(df.includes("FROM 1claw/agent:stable"));
    assert.ok(!df.includes("# --- Module"));
});

test("container name generation + validation", () => {
    const name = config.generateContainerName();
    assert.match(name, /^docker-agent-[0-9a-f]{8}$/);
    assert.ok(config.isValidContainerName(name));
    assert.ok(!config.isValidContainerName("bad/name"));
    assert.equal(config.sanitizeName("a b/c"), "a-b-c");
});

test("container state round-trips through disk", () => {
    const state = {
        containerName: "test-agent",
        containerId: "abc123",
        agentId: "agent-uuid",
        vaultId: "vault-uuid",
        image: "1claw/agent:stable",
        modules: ["onchain"],
        port: 3000,
        createdAt: new Date().toISOString(),
        localVaultPath: "__docker/test-agent/agent-key",
        customImage: null,
        mode: "local",
    };
    config.saveContainerState(state);
    const loaded = config.loadContainerState("test-agent");
    assert.deepEqual(loaded, state);

    const all = config.listContainerStates();
    assert.ok(all.some((s) => s.containerName === "test-agent"));

    assert.equal(config.deleteContainerState("test-agent"), true);
    assert.equal(config.loadContainerState("test-agent"), null);
});

test("findAvailablePort returns a bindable port", async () => {
    const p = await config.findAvailablePort(34567);
    assert.ok(p >= 34567 && p < 34567 + 100);
});

test.after(() => {
    rmSync(TMP_CONFIG, { recursive: true, force: true });
});
