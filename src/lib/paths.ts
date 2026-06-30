import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
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
 * Returns null if templates are not shipped with this CLI build.
 *
 * Search order:
 *   1. dist/bundled-templates/templates (npm publish / monorepo build)
 *   2. packages/agent-templates/templates (monorepo dev, submodule checkout)
 *   3. dist/src/templates/ (legacy builds — only if template.yaml dirs exist)
 */
export function bundledTemplatesDir(): string | null {
    // dist/bundled-templates/templates (srcRoot = dist/src → .. = dist)
    const fromDist = join(srcRoot, "..", "bundled-templates", "templates");
    if (dirHasTemplateManifests(fromDist)) return fromDist;

    // Monorepo: packages/cli/dist/src/lib → ../../../agent-templates/templates
    const monoRepo = join(
        srcRoot,
        "..",
        "..",
        "..",
        "agent-templates",
        "templates",
    );
    if (dirHasTemplateManifests(monoRepo)) return monoRepo;

    // Legacy: templates copied into dist/src/templates/ (conflicts with compiled TS)
    const legacy = join(srcRoot, "templates");
    if (dirHasTemplateManifests(legacy)) return legacy;

    return null;
}

function dirHasTemplateManifests(root: string): boolean {
    if (!existsSync(root)) return false;
    try {
        return readdirSync(root).some(
            (d) =>
                statSync(join(root, d)).isDirectory() &&
                existsSync(join(root, d, "template.yaml")),
        );
    } catch {
        return false;
    }
}

export function assetExists(path: string): boolean {
    return existsSync(path);
}
