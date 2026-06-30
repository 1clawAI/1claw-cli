#!/usr/bin/env node
// Copies non-TypeScript assets (Docker build context, module manifests,
// Terraform templates) into dist/ so they ship with the published package and
// resolve at runtime alongside the compiled JS.
import { cpSync, existsSync, mkdirSync } from "node:fs";
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

// Agent templates submodule (monorepo: packages/agent-templates → dist/src/templates)
const agentTemplatesRoot = join(root, "..", "agent-templates");
const templatesFrom = join(agentTemplatesRoot, "templates");
const templatesTo = join(distSrc, "templates");
if (existsSync(templatesFrom)) {
    mkdirSync(dirname(templatesTo), { recursive: true });
    cpSync(templatesFrom, templatesTo, { recursive: true });
    console.log(`copied agent-templates/templates/ → dist/src/templates/`);
}
const registryFrom = join(agentTemplatesRoot, "registry.yaml");
const registryTo = join(distSrc, "registry.yaml");
if (existsSync(registryFrom)) {
    cpSync(registryFrom, registryTo);
    console.log(`copied agent-templates/registry.yaml → dist/src/registry.yaml`);
}
