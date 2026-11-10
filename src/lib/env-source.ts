/**
 * Load the variables of an env file — plain `.env` or a `.1claw` envelope —
 * inside this process, for commands that send values straight to 1Claw.
 *
 * Callers must never print what this returns. The point of `env import` and
 * `--credential-from-env` is that a coding agent can run them: the values go
 * from the file to the vault over TLS and the agent's transcript only ever
 * holds names.
 */
import { existsSync, readFileSync } from "node:fs";
import { api } from "../client.js";
import {
    decodeDataKey,
    envelopePath,
    isEnvelopeFile,
    open,
    parseEnv,
    readEnvelope,
    type EnvEntry,
} from "./env-file.js";

export interface LoadedEnv {
    file: string;
    encrypted: boolean;
    entries: EnvEntry[];
}

/** `.env.1claw` when it exists, else `.env`. */
export function defaultEnvFile(): string {
    return existsSync(envelopePath(".env")) ? envelopePath(".env") : ".env";
}

export async function fetchDataKey(vaultId: string, path: string): Promise<Buffer> {
    const secret = await api<{ value: string }>(`/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`);
    return decodeDataKey(secret.value);
}

export async function loadEnvFile(file: string): Promise<LoadedEnv> {
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    if (isEnvelopeFile(file)) {
        const envelope = readEnvelope(file);
        const key = await fetchDataKey(envelope.key.vault_id, envelope.key.path);
        return { file, encrypted: true, entries: parseEnv(open(envelope, key)) };
    }
    return { file, encrypted: false, entries: parseEnv(readFileSync(file, "utf8")) };
}

/**
 * Coding agents run commands without a terminal on stdin (Claude Code also
 * sets `CLAUDECODE=1`). Commands that would put a secret value on screen or on
 * disk in the clear refuse to run there. This is a speed bump for honest
 * agents, not a boundary: anything running as you, logged in as you, can call
 * the same API.
 */
export function assertHumanTerminal(action: string): void {
    const agent = process.env.CLAUDECODE === "1" || !process.stdin.isTTY || !process.stdout.isTTY;
    if (agent) {
        throw new Error(
            `${action} writes secret values in the clear, so it only runs in your own terminal (not from an agent or a pipe).`,
        );
    }
}
