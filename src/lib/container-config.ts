import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    unlinkSync,
    chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");

export const CONTAINERS_DIR = join(CONFIG_DIR, "containers");

export interface ContainerState {
    containerName: string;
    containerId: string | null;
    agentId: string | null;
    vaultId: string | null;
    image: string;
    modules: string[];
    port: number;
    createdAt: string;
    /** Local-vault path where the daemon stores the agent key (cloud mode only). */
    localVaultPath: string | null;
    /** Set by `1claw publish` once an image is pushed to a registry. */
    customImage: string | null;
    publishedAt?: string;
    /** "local" (daemon socket) or "cloud" (agent API key direct). */
    mode: "local" | "cloud";
    /** Template name if created via `1claw spawn`. */
    template?: string;
    /**
     * Persisted `docker run` spec so `1claw containers start` can recreate the
     * container if it was removed (only env var names/secret paths are stored —
     * never secret values; the state file is chmod 600).
     */
    runSpec?: {
        image: string;
        /** Container-side port the chat UI listens on (host port is `port`). */
        containerPort: string;
        env: Record<string, string>;
        /** Host path → container mount spec. */
        volumes: Record<string, string>;
        restart?: string;
        labels?: Record<string, string>;
    };
    /** Deployment info, populated by `1claw deploy`. */
    deployment?: {
        provider: string;
        serviceUrl?: string;
        region?: string;
        deployedAt: string;
    };
}

function ensureContainersDir(): void {
    if (!existsSync(CONTAINERS_DIR)) {
        mkdirSync(CONTAINERS_DIR, { recursive: true });
    }
}

function statePath(name: string): string {
    return join(CONTAINERS_DIR, `${sanitizeName(name)}.json`);
}

/** A short, URL/identifier-safe random id (8 hex chars). */
export function shortId(): string {
    return randomBytes(4).toString("hex");
}

/** Generate a default container name: docker-agent-<shortId>. */
export function generateContainerName(prefix?: string): string {
    const base = prefix ? `1claw-${prefix}` : "docker-agent";
    return `${base}-${shortId()}`;
}

/** Restrict names to docker-safe characters. */
export function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isValidContainerName(name: string): boolean {
    // Docker: [a-zA-Z0-9][a-zA-Z0-9_.-]+
    return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

export function saveContainerState(state: ContainerState): void {
    ensureContainersDir();
    const path = statePath(state.containerName);
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
    try {
        chmodSync(path, 0o600);
    } catch {
        // best-effort
    }
}

export function loadContainerState(name: string): ContainerState | null {
    const path = statePath(name);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as ContainerState;
    } catch {
        return null;
    }
}

export function deleteContainerState(name: string): boolean {
    const path = statePath(name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

export function listContainerStates(): ContainerState[] {
    if (!existsSync(CONTAINERS_DIR)) return [];
    const states: ContainerState[] = [];
    for (const file of readdirSync(CONTAINERS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
            states.push(
                JSON.parse(
                    readFileSync(join(CONTAINERS_DIR, file), "utf-8"),
                ) as ContainerState,
            );
        } catch {
            // skip corrupt entries
        }
    }
    return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Check whether a TCP port is free to publish a container on.
 *
 * Binds `0.0.0.0` (all interfaces) to match how Docker publishes ports
 * (`-p host:container` binds `0.0.0.0` by default). Binding `127.0.0.1`
 * here is NOT sufficient: on macOS a loopback-only listen can succeed even
 * while Docker already holds `0.0.0.0:<port>`, which let `findAvailablePort`
 * hand back a port that `docker run` then rejected with
 * "Bind for 0.0.0.0:<port> failed: port is already allocated".
 */
export function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
            server.close(() => resolve(true));
        });
        server.listen(port, "0.0.0.0");
    });
}

/** Find the first available port at or after `start` (bounded search). */
export async function findAvailablePort(start: number): Promise<number> {
    for (let p = start; p < start + 100; p++) {
        if (await isPortAvailable(p)) return p;
    }
    throw new Error(
        `No available port found in range ${start}-${start + 100}.`,
    );
}

/** Label namespace applied to every CLI-managed container. */
export const MANAGED_LABEL = "1claw.managed";
