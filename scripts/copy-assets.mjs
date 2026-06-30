#!/usr/bin/env node
// Copies non-TypeScript assets (Docker build context, module manifests,
// Terraform templates) into dist/ so they ship with the published package and
// resolve at runtime alongside the compiled JS.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distSrc = join(root, "dist", "src");

const assetDirs = ["docker", "modules", "deploy"];

for (const dir of assetDirs) {
    const from = join(srcDir, dir);
    if (!existsSync(from)) continue;
    const to = join(distSrc, dir);
    mkdirSync(dirname(to), { recursive: true });
    // Copy everything except compiled TS outputs (those are emitted by tsc).
    cpSync(from, to, {
        recursive: true,
        filter: (src) =>
            !src.endsWith(".ts") &&
            !src.endsWith(".js.map") &&
            !src.endsWith(".d.ts"),
    });
    console.log(`copied ${dir}/ → dist/src/${dir}/`);
}

// Agent templates submodule → dist/bundled-templates/ (NOT dist/src/templates/,
// which is reserved for compiled registry.ts + fetcher.ts).
const agentTemplatesRoot = join(root, "..", "agent-templates");
const templatesFrom = join(agentTemplatesRoot, "templates");
const bundledRoot = join(root, "dist", "bundled-templates");
const templatesTo = join(bundledRoot, "templates");
if (existsSync(templatesFrom)) {
    mkdirSync(templatesTo, { recursive: true });
    cpSync(templatesFrom, templatesTo, { recursive: true });
    console.log(`copied agent-templates/templates/ → dist/bundled-templates/templates/`);
} else {
    console.warn(
        "WARN: packages/agent-templates not initialized — npm publish will rely on GitHub fetch.\n" +
            "  Run: git submodule update --init packages/agent-templates",
    );
}
const registryFrom = join(agentTemplatesRoot, "registry.yaml");
const registryTo = join(bundledRoot, "registry.yaml");
if (existsSync(registryFrom)) {
    mkdirSync(bundledRoot, { recursive: true });
    cpSync(registryFrom, registryTo);
    console.log(`copied agent-templates/registry.yaml → dist/bundled-templates/registry.yaml`);
}

// Fail the build if templates are missing (prevents empty npm publishes).
const manifestCount = existsSync(templatesTo)
    ? readdirSync(templatesTo).filter((d) =>
          existsSync(join(templatesTo, d, "template.yaml")),
      ).length
    : 0;
if (manifestCount < 12) {
    console.error(
        `ERROR: expected 12 bundled agent templates, found ${manifestCount}.\n` +
            "Initialize the agent-templates submodule before building/publishing.",
    );
    process.exit(1);
}
