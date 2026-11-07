/**
 * `.1claw/project.json`: which vault and agent this folder uses. It holds ids and
 * names only, no secrets, and can be committed. It wins over the global default
 * vault, so two projects on one machine can't silently share a vault.
 *
 * The app's one credential, its agent key, lives in the project's `.env`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "./env-file.js";

export interface ProjectBinding {
    name: string;
    /** The app's variable for the API's base URL; `env run` points it at a local proxy. */
    url_env?: string;
    /** The app's variable for the API key; `env run` sets it to a per-run proxy token. */
    key_env?: string;
}

export interface ProjectFile {
    vault_id?: string;
    vault_name?: string;
    agent_id?: string;
    agent_name?: string;
    environment?: string;
    bindings?: ProjectBinding[];
}

const projectPath = (root: string) => join(root, ".1claw", "project.json");

export function findProjectRoot(start = process.cwd()): string | null {
    const home = homedir();
    let dir = start;
    for (;;) {
        if (existsSync(projectPath(dir))) return dir;
        const parent = dirname(dir);
        if (dir === home || parent === dir) return null;
        dir = parent;
    }
}

export function readProject(start = process.cwd()): { root: string; data: ProjectFile } | null {
    const root = findProjectRoot(start);
    if (!root) return null;
    try {
        return { root, data: JSON.parse(readFileSync(projectPath(root), "utf8")) as ProjectFile };
    } catch {
        throw new Error(`${projectPath(root)} is not valid JSON`);
    }
}

export function writeProject(root: string, patch: Partial<ProjectFile>): void {
    const current = existsSync(projectPath(root)) ? (JSON.parse(readFileSync(projectPath(root), "utf8")) as ProjectFile) : {};
    mkdirSync(join(root, ".1claw"), { recursive: true });
    writeFileSync(projectPath(root), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

/** From the environment, else the project's `.env`. */
export function readAgentKey(root: string): string | undefined {
    if (process.env.ONECLAW_AGENT_API_KEY?.trim()) return process.env.ONECLAW_AGENT_API_KEY.trim();
    const file = join(root, ".env");
    if (!existsSync(file)) return undefined;
    return parseEnv(readFileSync(file, "utf8")).find((e) => e.key === "ONECLAW_AGENT_API_KEY")?.value || undefined;
}

/** Write the access key as the project's `.env`, readable only by this user. Never printed. */
export function writeAgentKey(root: string, key: string): void {
    const file = join(root, ".env");
    if (existsSync(file)) throw new Error(`${file} already exists; move it aside first (run 1claw ignore to encrypt it)`);
    writeFileSync(file, `ONECLAW_AGENT_API_KEY=${key}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
}
