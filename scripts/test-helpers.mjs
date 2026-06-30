/**
 * Shared helpers for CLI test suites — tracks and removes container state
 * files and Docker resources created during tests (including after failures).
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Fixed container names used by unit tests. */
export const TEST_CONTAINER_STATE_NAMES = [
    "test-agent",
    "test-template-agent",
];

/** Docker container name for optional spawn smoke integration test. */
export const SPAWN_SMOKE_CONTAINER = "1claw-test-spawn-smoke";
export const SPAWN_SMOKE_IMAGE = "1claw-test-spawn-smoke:ci";

/** Image tags produced by agent-templates CI docker-build matrix. */
export const CI_TEMPLATE_IMAGE_TAGS = [
    "langchain",
    "crewai",
    "openai-agents",
    "agentkit",
    "smolagents",
    "llamaindex",
    "pydantic-ai",
    "agno",
    "coder",
    "typescript-sdk",
    "mastra",
    "elizaos",
].map((t) => `test-${t}`);

const trackedStateNames = new Set(TEST_CONTAINER_STATE_NAMES);
const trackedContainerNames = new Set([
    ...TEST_CONTAINER_STATE_NAMES,
    SPAWN_SMOKE_CONTAINER,
]);
const trackedImageTags = new Set([SPAWN_SMOKE_IMAGE, ...CI_TEMPLATE_IMAGE_TAGS]);
const trackedConfigDirs = new Set();

export function trackTestContainerState(name) {
    trackedStateNames.add(name);
}

export function trackDockerContainer(name) {
    trackedContainerNames.add(name);
}

export function trackDockerImage(tag) {
    trackedImageTags.add(tag);
}

export function trackTestConfigDir(dir) {
    if (dir) trackedConfigDirs.add(dir);
}

export async function dockerRmSafe(name) {
    try {
        await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
        // Container may not exist — that is fine.
    }
}

export async function dockerRmiSafe(tag) {
    try {
        await execFileAsync("docker", ["rmi", "-f", tag]);
    } catch {
        // Image may not exist — that is fine.
    }
}

export async function dockerAvailable() {
    try {
        await execFileAsync("docker", ["info"], {
            timeout: 5000,
        });
        return true;
    } catch {
        return false;
    }
}

/** Remove persisted CLI container state files written during tests. */
export function cleanupTrackedContainerState(configModule) {
    for (const name of trackedStateNames) {
        try {
            configModule.deleteContainerState(name);
        } catch {
            // ignore
        }
    }

    const containersDir = configModule.CONTAINERS_DIR;
    if (!existsSync(containersDir)) return;

    for (const file of readdirSync(containersDir)) {
        if (!file.endsWith(".json")) continue;
        const base = file.replace(/\.json$/, "");
        if (
            base.startsWith("test-") ||
            base === "test-agent" ||
            base === "test-template-agent" ||
            base.startsWith("1claw-test-")
        ) {
            try {
                configModule.deleteContainerState(base);
            } catch {
                // ignore
            }
        }
    }
}

export async function cleanupDockerTestResources(extra = {}) {
    const containers = new Set([
        ...trackedContainerNames,
        ...(extra.containers ?? []),
    ]);
    const images = new Set([...trackedImageTags, ...(extra.images ?? [])]);

    for (const name of containers) {
        await dockerRmSafe(name);
    }
    for (const tag of images) {
        await dockerRmiSafe(tag);
    }
}

export function cleanupTestConfigDirs() {
    for (const dir of trackedConfigDirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
}

/** Full teardown for a test suite's isolated ONECLAW_CONFIG_DIR. */
export async function cleanupTestSuite(configModule, configDir) {
    cleanupTrackedContainerState(configModule);
    await cleanupDockerTestResources();
    if (configDir) {
        try {
            rmSync(configDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
    cleanupTestConfigDirs();
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll an HTTP URL until it returns the expected status or times out. */
export async function waitForHttpOk(
    url,
    { expectedStatus = 200, timeoutMs = 60_000, intervalMs = 1000 } = {},
) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "timed out";

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.status === expectedStatus) return res;
            lastError = `HTTP ${res.status}`;
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        await sleep(intervalMs);
    }

    throw new Error(`GET ${url} failed: ${lastError}`);
}
