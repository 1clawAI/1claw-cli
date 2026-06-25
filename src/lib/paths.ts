import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Resolves bundled, non-TypeScript assets (Docker base context + module
// manifests) both when running from compiled `dist/` and from `src/` in dev.
//
// This file compiles to `dist/src/lib/paths.js`, so `../` lands at
// `dist/src/`, alongside the copied `docker/` and `modules/` asset trees.
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

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

export function assetExists(path: string): boolean {
    return existsSync(path);
}
