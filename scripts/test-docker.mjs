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
const templateRegistry = await import("../dist/src/templates/registry.js");
const templateFetcher = await import("../dist/src/templates/fetcher.js");

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

// ── Template system tests ────────────────────────────────────────────

test("listTemplateNames returns bundled templates", () => {
    const names = templateRegistry.listTemplateNames();
    assert.ok(names.length >= 3, `Expected >= 3 templates, got ${names.length}`);
    assert.ok(names.includes("langchain"));
    assert.ok(names.includes("crewai"));
    assert.ok(names.includes("openai-agents"));
});

test("loadTemplate parses a manifest (langchain)", () => {
    const m = templateRegistry.loadTemplate("langchain");
    assert.equal(m.name, "langchain");
    assert.equal(m.language, "python");
    assert.ok(m.display_name.includes("LangChain"));
    assert.ok(m.docker.base_image.includes("python"));
    assert.ok(m.docker.context_files.includes("Dockerfile"));
    assert.ok(m.docker.context_files.includes("agent.py"));
    assert.equal(m.docker.health_endpoint, "/health");
    assert.equal(m.docker.health_port, 3000);
});

test("loadTemplate parses a manifest (crewai)", () => {
    const m = templateRegistry.loadTemplate("crewai");
    assert.equal(m.name, "crewai");
    assert.equal(m.language, "python");
    assert.ok(m.display_name.includes("CrewAI"));
});

test("loadTemplate parses a manifest (openai-agents)", () => {
    const m = templateRegistry.loadTemplate("openai-agents");
    assert.equal(m.name, "openai-agents");
    assert.equal(m.language, "python");
    assert.ok(m.display_name.includes("OpenAI"));
});

test("loadTemplate parses a manifest (mastra — TypeScript)", () => {
    const m = templateRegistry.loadTemplate("mastra");
    assert.equal(m.name, "mastra");
    assert.equal(m.language, "node");
    assert.ok(m.display_name.includes("Mastra"));
});

test("loadTemplate parses a manifest (elizaos — TypeScript)", () => {
    const m = templateRegistry.loadTemplate("elizaos");
    assert.equal(m.name, "elizaos");
    assert.equal(m.language, "node");
    assert.ok(m.display_name.includes("ElizaOS"));
});

test("loadTemplate parses a manifest (typescript-sdk)", () => {
    const m = templateRegistry.loadTemplate("typescript-sdk");
    assert.equal(m.name, "typescript-sdk");
    assert.equal(m.language, "node");
    assert.ok(m.display_name.includes("TypeScript"));
});

test("loadTemplate throws on unknown template", () => {
    assert.throws(
        () => templateRegistry.loadTemplate("does-not-exist"),
        /Unknown template/,
    );
});

test("getTemplateDir returns a valid directory", () => {
    const dir = templateRegistry.getTemplateDir("langchain");
    assert.ok(dir.includes("langchain"));
});

test("getTemplateDir throws on unknown template", () => {
    assert.throws(
        () => templateRegistry.getTemplateDir("does-not-exist"),
        /not found/,
    );
});

test("findTemplateDir returns null for unknown template", () => {
    const dir = templateRegistry.findTemplateDir("does-not-exist");
    assert.equal(dir, null);
});

test("listTemplates returns full manifest objects", () => {
    const templates = templateRegistry.listTemplates();
    assert.ok(templates.length >= 3);
    for (const t of templates) {
        assert.ok(t.name);
        assert.ok(t.display_name);
        assert.ok(t.version);
        assert.ok(t.description);
        assert.ok(t.language === "python" || t.language === "node");
        assert.ok(t.docker);
        assert.ok(t.docker.base_image);
    }
});

test("parseRegistryIndex parses valid YAML", () => {
    const yaml = `
version: 1
templates:
  - name: test-template
    display_name: "Test"
    version: 1.0.0
    language: python
    description: "A test template"
`;
    const idx = templateRegistry.parseRegistryIndex(yaml);
    assert.equal(idx.version, 1);
    assert.equal(idx.templates.length, 1);
    assert.equal(idx.templates[0].name, "test-template");
});

test("loadBundledRegistry returns a valid registry", () => {
    const reg = templateRegistry.loadBundledRegistry();
    assert.ok(reg !== null, "Expected bundled registry to exist");
    assert.ok(reg.templates.length >= 3);
    assert.ok(reg.templates.some((t) => t.name === "langchain"));
});

test("isCacheFresh returns false when no cache exists", () => {
    assert.equal(templateFetcher.isCacheFresh(), false);
});

test("container name generation with prefix", () => {
    const name = config.generateContainerName("langchain");
    assert.match(name, /^1claw-langchain-[0-9a-f]{8}$/);
    assert.ok(config.isValidContainerName(name));
});

test("container name generation without prefix (backward compat)", () => {
    const name = config.generateContainerName();
    assert.match(name, /^docker-agent-[0-9a-f]{8}$/);
});

test("container state with template field round-trips", () => {
    const state = {
        containerName: "test-template-agent",
        containerId: "def456",
        agentId: "agent-uuid-2",
        vaultId: "vault-uuid-2",
        image: "1claw/langchain:1.0.0",
        modules: [],
        port: 3001,
        createdAt: new Date().toISOString(),
        localVaultPath: null,
        customImage: null,
        mode: "cloud",
        template: "langchain",
    };
    config.saveContainerState(state);
    const loaded = config.loadContainerState("test-template-agent");
    assert.deepEqual(loaded, state);
    assert.equal(loaded.template, "langchain");
    config.deleteContainerState("test-template-agent");
});

test.after(() => {
    rmSync(TMP_CONFIG, { recursive: true, force: true });
});
