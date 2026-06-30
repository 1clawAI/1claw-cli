#!/usr/bin/env node
// Comprehensive tests for `1claw spawn` template loading, registry sync,
// and on-disk template structure. Run after `npm run build`:
//   node --test scripts/test-spawn-templates.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTestSuite, cleanupDockerTestResources } from "./test-helpers.mjs";

const TMP_CONFIG = mkdtempSync(join(tmpdir(), "1claw-spawn-test-"));
process.env.ONECLAW_CONFIG_DIR = TMP_CONFIG;

const templateRegistry = await import("../dist/src/templates/registry.js");
const config = await import("../dist/src/lib/container-config.js");
const paths = await import("../dist/src/lib/paths.js");

const PYTHON_TEMPLATES = [
    "langchain",
    "crewai",
    "openai-agents",
    "agentkit",
    "smolagents",
    "llamaindex",
    "pydantic-ai",
    "agno",
    "coder",
];

const NODE_TEMPLATES = ["typescript-sdk", "mastra", "elizaos"];

const ALL_TEMPLATES = [...PYTHON_TEMPLATES, ...NODE_TEMPLATES];

const SECRET_PATTERN =
    /sk-[a-zA-Z0-9]{20,}|1ck_[a-zA-Z0-9]+|ocv_[a-zA-Z0-9]+|plt_[a-zA-Z0-9]+/;

function bundledRoot() {
    const dir = paths.bundledTemplatesDir();
    assert.ok(dir, "Bundled templates dir must exist (run npm run build)");
    return dir;
}

function requiredFiles(language) {
    const common = [
        "template.yaml",
        "Dockerfile",
        "entrypoint.sh",
        "README.md",
    ];
    if (language === "python") {
        return [...common, "agent.py", "requirements.txt"];
    }
    return [...common, "agent.ts", "package.json"];
}

test("bundled templates directory exists after build", () => {
    const dir = paths.bundledTemplatesDir();
    assert.ok(dir, "Expected dist/bundled-templates/templates or monorepo agent-templates/");
    assert.ok(existsSync(dir));
});

test("listTemplateNames returns all 12 bundled templates", () => {
    const names = templateRegistry.listTemplateNames();
    assert.equal(
        names.length,
        ALL_TEMPLATES.length,
        `Expected ${ALL_TEMPLATES.length} templates, got ${names.length}: ${names.join(", ")}`,
    );
    for (const name of ALL_TEMPLATES) {
        assert.ok(names.includes(name), `Missing template: ${name}`);
    }
});

test("loadBundledRegistry lists every bundled template", () => {
    const reg = templateRegistry.loadBundledRegistry();
    assert.ok(reg, "bundled registry.yaml must be copied to dist/src/");
    assert.equal(
        reg.templates.length,
        ALL_TEMPLATES.length,
        `registry.yaml has ${reg.templates.length} entries, expected ${ALL_TEMPLATES.length}`,
    );
    for (const name of ALL_TEMPLATES) {
        assert.ok(
            reg.templates.some((t) => t.name === name),
            `registry.yaml missing entry: ${name}`,
        );
    }
});

test("registry entries match on-disk template directories", () => {
    const root = bundledRoot();
    const reg = templateRegistry.loadBundledRegistry();
    assert.ok(reg);

    const diskNames = readdirSync(root)
        .filter((d) => existsSync(join(root, d, "template.yaml")))
        .sort();
    const registryNames = reg.templates.map((t) => t.name).sort();

    assert.deepEqual(
        diskNames,
        registryNames,
        "registry.yaml and templates/ directories must be in sync",
    );
});

for (const name of ALL_TEMPLATES) {
    const language = PYTHON_TEMPLATES.includes(name) ? "python" : "node";

    test(`loadTemplate(${name}) parses manifest`, () => {
        const m = templateRegistry.loadTemplate(name);
        assert.equal(m.name, name);
        assert.equal(m.language, language);
        assert.ok(m.display_name.length > 0);
        assert.ok(m.version.length > 0);
        assert.ok(m.description.length > 0);
        assert.ok(m.author.length > 0);
        assert.equal(m.docker.health_endpoint, "/health");
        assert.equal(m.docker.health_port, 3000);
        assert.ok(m.docker.base_image.length > 0);
        assert.ok(m.docker.context_files.includes("Dockerfile"));
        assert.ok(m.docker.context_files.includes("entrypoint.sh"));
    });

    test(`getTemplateDir(${name}) resolves bundled path`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        assert.ok(dir.includes(name));
        assert.ok(existsSync(join(dir, "template.yaml")));
    });

    test(`${name} has required files on disk`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        for (const file of requiredFiles(language)) {
            assert.ok(
                existsSync(join(dir, file)),
                `${name} missing required file: ${file}`,
            );
        }
    });

    test(`${name} manifest name matches directory`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        const raw = readFileSync(join(dir, "template.yaml"), "utf-8");
        assert.ok(raw.includes(`name: ${name}`));
    });

    test(`${name} Dockerfile declares health check`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
        assert.ok(dockerfile.includes("HEALTHCHECK"));
        assert.ok(dockerfile.includes("/health"));
        assert.ok(dockerfile.includes("EXPOSE 3000"));
        assert.ok(dockerfile.includes("ONECLAW_DAEMON_SOCKET"));
    });

    test(`${name} entrypoint routes LLM via Shroud when enabled`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        const entrypoint = readFileSync(join(dir, "entrypoint.sh"), "utf-8");
        assert.ok(entrypoint.includes("ONECLAW_LLM_VIA_SHROUD"));
        assert.ok(entrypoint.includes("ONECLAW_SHROUD_URL"));
        assert.match(entrypoint, /exec (python|npx tsx|node|npm)/);
    });

    test(`${name} agent source exposes /health endpoint`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        const agentFile = language === "python" ? "agent.py" : "agent.ts";
        const source = readFileSync(join(dir, agentFile), "utf-8");
        assert.ok(
            source.includes("/health"),
            `${name}/${agentFile} must define a /health route`,
        );
        assert.ok(
            source.includes("/chat") || source.includes("chat"),
            `${name}/${agentFile} must define chat handling`,
        );
    });

    test(`${name} contains no hardcoded secrets`, () => {
        const dir = templateRegistry.getTemplateDir(name);
        const scanFiles = [
            language === "python" ? "agent.py" : "agent.ts",
            "Dockerfile",
            "entrypoint.sh",
            "template.yaml",
            ...(language === "python" ? ["requirements.txt"] : ["package.json"]),
        ];
        for (const file of scanFiles) {
            const content = readFileSync(join(dir, file), "utf-8");
            assert.ok(
                !SECRET_PATTERN.test(content),
                `${name}/${file} may contain a hardcoded secret`,
            );
        }
    });
}

test("listTemplates returns manifests for every template", () => {
    const templates = templateRegistry.listTemplates();
    assert.equal(templates.length, ALL_TEMPLATES.length);
    const names = templates.map((t) => t.name).sort();
    assert.deepEqual(names, [...ALL_TEMPLATES].sort());
});

test("loadTemplate throws helpful error for unknown template", () => {
    assert.throws(
        () => templateRegistry.loadTemplate("not-a-real-framework"),
        /Unknown template/,
    );
    assert.throws(
        () => templateRegistry.loadTemplate("not-a-real-framework"),
        /1claw spawn --list/,
    );
});

test("registry language tags match manifest languages", () => {
    const reg = templateRegistry.loadBundledRegistry();
    assert.ok(reg);
    for (const entry of reg.templates) {
        const expected = PYTHON_TEMPLATES.includes(entry.name)
            ? "python"
            : "node";
        assert.equal(
            entry.language,
            expected,
            `registry.yaml language mismatch for ${entry.name}`,
        );
        const manifest = templateRegistry.loadTemplate(entry.name);
        assert.equal(manifest.language, expected);
    }
});

test("deprecatedSpawnModuleWarning flags langchain and elizaos", async () => {
    const mod = await import("../dist/src/lib/module-deprecation.js");
    assert.equal(
        mod.deprecatedSpawnModuleWarning(["langchain"]),
        "--module langchain is deprecated. Use `1claw spawn langchain` instead.",
    );
    assert.equal(
        mod.deprecatedSpawnModuleWarning(["elizaos", "onchain"]),
        "--module elizaos is deprecated. Use `1claw spawn elizaos` instead.",
    );
    assert.equal(mod.deprecatedSpawnModuleWarning(["onchain"]), null);
    assert.deepEqual(
        mod.deprecatedSpawnModuleNames(["langchain", "elizaos", "onchain"]),
        ["langchain", "elizaos"],
    );
});

test.before(async () => {
    await cleanupDockerTestResources();
});

test.after(async () => {
    await cleanupTestSuite(config, TMP_CONFIG);
});
