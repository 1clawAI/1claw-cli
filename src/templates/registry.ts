import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { templatesCacheDir, bundledTemplatesDir } from "../lib/paths.js";

export interface TemplateDocker {
    base_image: string;
    context_files: string[];
    env: Record<string, string>;
    health_endpoint: string;
    health_port: number;
}

export interface TemplateManifest {
    name: string;
    display_name: string;
    version: string;
    description: string;
    author: string;
    language: "python" | "node";
    homepage?: string;
    docker: TemplateDocker;
    post_spawn_message?: string;
}

export interface RegistryEntry {
    name: string;
    display_name: string;
    version: string;
    language: string;
    description: string;
}

export interface RegistryIndex {
    version: number;
    templates: RegistryEntry[];
}

const REQUIRED_FIELDS = [
    "name",
    "display_name",
    "version",
    "description",
    "author",
    "language",
] as const;

function normalizeManifest(
    raw: Record<string, unknown>,
    name: string,
): TemplateManifest {
    for (const f of REQUIRED_FIELDS) {
        if (!raw[f]) {
            throw new Error(
                `Template "${name}" manifest is missing required field "${f}".`,
            );
        }
    }

    const lang = String(raw.language);
    if (lang !== "python" && lang !== "node") {
        throw new Error(
            `Template "${name}" has invalid language "${lang}". Must be "python" or "node".`,
        );
    }

    const docker = (raw.docker ?? {}) as Record<string, unknown>;
    return {
        name: String(raw.name),
        display_name: String(raw.display_name),
        version: String(raw.version),
        description: String(raw.description).trim(),
        author: String(raw.author ?? "unknown"),
        language: lang,
        homepage: raw.homepage ? String(raw.homepage) : undefined,
        docker: {
            base_image: String(docker.base_image ?? "python:3.12-slim"),
            context_files: asStringArray(docker.context_files),
            env: asStringRecord(docker.env),
            health_endpoint: String(docker.health_endpoint ?? "/health"),
            health_port: Number(docker.health_port ?? 3000),
        },
        post_spawn_message: raw.post_spawn_message
            ? String(raw.post_spawn_message).trim()
            : undefined,
    };
}

function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x));
}

function asStringRecord(v: unknown): Record<string, string> {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = String(val);
    }
    return out;
}

/**
 * Try to find a template directory, checking (in order):
 *   1. Local cache (~/.config/1claw/templates/<name>/)
 *   2. Bundled templates (packages/agent-templates/templates/<name>/ via submodule)
 */
export function findTemplateDir(name: string): string | null {
    const cached = join(templatesCacheDir(), name);
    if (existsSync(join(cached, "template.yaml"))) return cached;

    const bundled = bundledTemplatesDir();
    if (bundled) {
        const dir = join(bundled, name);
        if (existsSync(join(dir, "template.yaml"))) return dir;
    }

    return null;
}

/** Load and validate a single template manifest by name. */
export function loadTemplate(name: string): TemplateManifest {
    const dir = findTemplateDir(name);
    if (!dir) {
        const available = listTemplateNames();
        throw new Error(
            `Unknown template "${name}". Available templates: ${available.join(", ") || "(none)"}.\n` +
                `  Run \`1claw spawn --list\` to see all templates, or \`1claw spawn --refresh\` to update.`,
        );
    }
    const manifestPath = join(dir, "template.yaml");
    const raw = parseYaml(
        readFileSync(manifestPath, "utf-8"),
    ) as Record<string, unknown>;
    const manifest = normalizeManifest(raw, name);
    if (manifest.name !== name) {
        manifest.name = name;
    }
    return manifest;
}

/** Get the resolved directory path for a template. */
export function getTemplateDir(name: string): string {
    const dir = findTemplateDir(name);
    if (!dir) {
        throw new Error(`Template "${name}" not found.`);
    }
    return dir;
}

function scanDir(root: string): string[] {
    if (!existsSync(root)) return [];
    try {
        return readdirSync(root)
            .filter((d) => {
                try {
                    return (
                        statSync(join(root, d)).isDirectory() &&
                        existsSync(join(root, d, "template.yaml"))
                    );
                } catch {
                    return false;
                }
            })
            .sort();
    } catch {
        return [];
    }
}

/** List all available template names (cached + bundled, deduplicated). */
export function listTemplateNames(): string[] {
    const names = new Set<string>();
    for (const n of scanDir(templatesCacheDir())) names.add(n);
    const bundled = bundledTemplatesDir();
    if (bundled) {
        for (const n of scanDir(bundled)) names.add(n);
    }
    return [...names].sort();
}

/** List all available templates as manifests. */
export function listTemplates(): TemplateManifest[] {
    return listTemplateNames().map((n) => loadTemplate(n));
}

/** Parse the registry.yaml index (from bundled or fetched). */
export function parseRegistryIndex(content: string): RegistryIndex {
    const raw = parseYaml(content) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
        throw new Error("Invalid registry.yaml format.");
    }
    const version = Number(raw.version ?? 1);
    const templates = Array.isArray(raw.templates)
        ? (raw.templates as Record<string, unknown>[]).map((t) => ({
              name: String(t.name ?? ""),
              display_name: String(t.display_name ?? t.name ?? ""),
              version: String(t.version ?? "0.0.0"),
              language: String(t.language ?? "python"),
              description: String(t.description ?? ""),
          }))
        : [];
    return { version, templates };
}

/** Load the bundled registry.yaml if available. */
export function loadBundledRegistry(): RegistryIndex | null {
    const bundled = bundledTemplatesDir();
    if (!bundled) return null;
    const registryPath = join(bundled, "..", "registry.yaml");
    if (!existsSync(registryPath)) return null;
    try {
        return parseRegistryIndex(readFileSync(registryPath, "utf-8"));
    } catch {
        return null;
    }
}
