import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// Resolves bundled, non-TypeScript assets (Docker base context + module
// manifests) both when running from compiled `dist/` and from `src/` in dev.
//
// This file compiles to `dist/src/lib/paths.js`, so `../` lands at
// `dist/src/`, alongside the copied `docker/` and `modules/` asset trees.
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");

/** Directory containing the base Docker build context. */
export function dockerBaseContext(): string {
    return join(srcRoot, "docker", "base");
}

/** Path to the modules-aware Dockerfile template. */
export function dockerTemplatePath(): string {
    return join(srcRoot, "docker", "templates", "Dockerfile.tmpl");
}

/** docker-compose template path. */
export function composeTemplatePath(): string {
    return join(srcRoot, "docker", "compose.yaml");
}

/** Root directory holding bundled module manifests. */
export function modulesRoot(): string {
    return join(srcRoot, "modules");
}

/** Directory for a single module's assets. */
export function moduleDir(name: string): string {
    return join(modulesRoot(), name);
}

/** Terraform template directory for a cloud provider. */
export function deployTemplateDir(provider: string): string {
    return join(srcRoot, "deploy", provider);
}

/** Local cache directory for fetched templates. */
export function templatesCacheDir(): string {
    return join(CONFIG_DIR, "templates");
}

/**
 * Directory containing bundled templates from the agent-templates submodule.
 * Returns null if the submodule is not initialized.
 *
 * Searches two locations (dev source tree and monorepo root):
 *   1. <cliRoot>/../../packages/agent-templates/templates (monorepo)
 *   2. <srcRoot>/templates (copied assets in dist/)
 */
export function bundledTemplatesDir(): string | null {
    // srcRoot = dist/src/ (compiled) or src/ (dev). CLI package root = srcRoot/../..
    // Monorepo layout: packages/cli + packages/agent-templates (submodule)
    const monoRepo = join(srcRoot, "..", "..", "..", "agent-templates", "templates");
    if (existsSync(monoRepo)) return monoRepo;

    // Copied into dist during build (npm publish / monorepo build)
    const dist = join(srcRoot, "templates");
    if (existsSync(dist)) return dist;

    return null;
}

export function assetExists(path: string): boolean {
    return existsSync(path);
}
