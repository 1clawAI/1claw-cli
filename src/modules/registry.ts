import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { modulesRoot, moduleDir } from "../lib/paths.js";

export interface ModuleCopy {
    src: string;
    dest: string;
}

export interface ModuleManifest {
    name: string;
    version: string;
    description: string;
    author: string;
    homepage?: string;
    docker: {
        packages: string[];
        apk: string[];
        copy: ModuleCopy[];
        env: Record<string, string>;
        ports: string[];
    };
    required_secrets: { path: string; description: string; optional: boolean }[];
    tools: string[];
    conflicts: string[];
    depends: string[];
}

const REQUIRED_FIELDS = ["name", "version", "description"] as const;

function normalizeManifest(raw: Record<string, unknown>, name: string): ModuleManifest {
    for (const f of REQUIRED_FIELDS) {
        if (!raw[f]) {
            throw new Error(`Module "${name}" manifest is missing required field "${f}".`);
        }
    }
    const docker = (raw.docker ?? {}) as Record<string, unknown>;
    return {
        name: String(raw.name),
        version: String(raw.version),
        description: String(raw.description).trim(),
        author: String(raw.author ?? "unknown"),
        homepage: raw.homepage ? String(raw.homepage) : undefined,
        docker: {
            packages: asStringArray(docker.packages),
            apk: asStringArray(docker.apk),
            copy: asCopyArray(docker.copy),
            env: asStringRecord(docker.env),
            ports: asStringArray(docker.ports),
        },
        required_secrets: Array.isArray(raw.required_secrets)
            ? (raw.required_secrets as Record<string, unknown>[]).map((s) => ({
                  path: String(s.path ?? ""),
                  description: String(s.description ?? ""),
                  optional: s.optional !== false,
              }))
            : [],
        tools: asStringArray(raw.tools),
        conflicts: asStringArray(raw.conflicts),
        depends: asStringArray(raw.depends),
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

function asCopyArray(v: unknown): ModuleCopy[] {
    if (!Array.isArray(v)) return [];
    return v
        .map((x) => x as Record<string, unknown>)
        .filter((x) => x && x.src && x.dest)
        .map((x) => ({ src: String(x.src), dest: String(x.dest) }));
}

/** Load and validate a single module manifest by name. */
export function loadModule(name: string): ModuleManifest {
    const dir = moduleDir(name);
    const manifestPath = join(dir, "module.yaml");
    if (!existsSync(manifestPath)) {
        const available = listModuleNames();
        throw new Error(
            `Unknown module "${name}". Available modules: ${available.join(", ") || "(none)"}.`,
        );
    }
    const raw = parseYaml(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    const manifest = normalizeManifest(raw, name);
    if (manifest.name !== name) {
        // The directory name is canonical.
        manifest.name = name;
    }
    return manifest;
}

export function listModuleNames(): string[] {
    const root = modulesRoot();
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .filter((d) => {
            try {
                return (
                    statSync(join(root, d)).isDirectory() &&
                    existsSync(join(root, d, "module.yaml"))
                );
            } catch {
                return false;
            }
        })
        .sort();
}

export function listModules(): ModuleManifest[] {
    return listModuleNames().map((n) => loadModule(n));
}

/**
 * Resolve a list of requested module names into a fully-ordered list:
 *   - recursively pulls in `depends`
 *   - rejects mutual conflicts
 *   - topologically sorts so dependencies precede dependents
 *   - detects dependency cycles
 */
export function resolveModules(names: string[]): ModuleManifest[] {
    const requested = dedupe(names.map((n) => n.trim()).filter(Boolean));

    // Load all reachable modules (requested + transitive deps).
    const loaded = new Map<string, ModuleManifest>();
    const stack = [...requested];
    while (stack.length) {
        const name = stack.pop() as string;
        if (loaded.has(name)) continue;
        const m = loadModule(name);
        loaded.set(name, m);
        for (const dep of m.depends) {
            if (!loaded.has(dep)) stack.push(dep);
        }
    }

    // Conflict detection across the full set.
    const present = new Set(loaded.keys());
    for (const m of loaded.values()) {
        for (const c of m.conflicts) {
            if (present.has(c)) {
                throw new Error(
                    `Module conflict: "${m.name}" conflicts with "${c}". Remove one of them.`,
                );
            }
        }
    }

    // Topological sort (DFS) with cycle detection.
    const sorted: ModuleManifest[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (name: string, trail: string[]): void => {
        if (visited.has(name)) return;
        if (visiting.has(name)) {
            throw new Error(
                `Circular module dependency: ${[...trail, name].join(" → ")}.`,
            );
        }
        visiting.add(name);
        const m = loaded.get(name);
        if (!m) throw new Error(`Module "${name}" failed to load.`);
        for (const dep of m.depends) {
            visit(dep, [...trail, name]);
        }
        visiting.delete(name);
        visited.add(name);
        sorted.push(m);
    };

    // Visit requested in stable order so output is deterministic.
    for (const name of [...loaded.keys()].sort()) {
        visit(name, []);
    }

    return sorted;
}

function dedupe(arr: string[]): string[] {
    return [...new Set(arr)];
}

/**
 * Generate the Dockerfile layer fragment for the resolved modules. The result
 * is appended after a `FROM <base>` line by the caller.
 */
export function generateDockerLayers(modules: ModuleManifest[]): string {
    const lines: string[] = [];
    for (const m of modules) {
        lines.push("");
        lines.push(`# --- Module: ${m.name} (v${m.version}) ---`);
        if (m.docker.apk.length) {
            lines.push(`RUN apk add --no-cache ${m.docker.apk.join(" ")}`);
        }
        if (m.docker.packages.length) {
            lines.push(`RUN npm install -g ${m.docker.packages.join(" ")}`);
        }
        for (const c of m.docker.copy) {
            // Module copy sources are staged under modules/<name>/ in the build context.
            lines.push(`COPY modules/${m.name}/${c.src} ${c.dest}`);
            if (c.dest.endsWith(".sh")) {
                lines.push(`RUN chmod +x ${c.dest}`);
            }
        }
        for (const [k, v] of Object.entries(m.docker.env)) {
            lines.push(`ENV ${k}=${dockerEnvValue(v)}`);
        }
    }
    return lines.join("\n") + "\n";
}

function dockerEnvValue(v: string): string {
    // Quote values containing whitespace; ENV supports JSON-ish quoting.
    return /\s/.test(v) ? JSON.stringify(v) : v;
}

/** Stable content hash for a module set — used to name custom images. */
export function moduleSetHash(modules: ModuleManifest[]): string {
    // Lightweight, dependency-free FNV-1a hash of the ordered name@version list.
    const key = modules.map((m) => `${m.name}@${m.version}`).join("|");
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export { moduleDir };
