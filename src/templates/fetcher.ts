import {
    existsSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    statSync,
    cpSync,
} from "node:fs";
import { join } from "node:path";
import { templatesCacheDir, bundledTemplatesDir } from "../lib/paths.js";

const REPO_OWNER = "1clawAI";
const REPO_NAME = "agent-templates";
const BRANCH = "main";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheMeta {
    fetchedAt: string;
    etag?: string;
}

function cacheMetaPath(): string {
    return join(templatesCacheDir(), ".cache-meta.json");
}

function readCacheMeta(): CacheMeta | null {
    const p = cacheMetaPath();
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, "utf-8")) as CacheMeta;
    } catch {
        return null;
    }
}

function writeCacheMeta(meta: CacheMeta): void {
    const dir = templatesCacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cacheMetaPath(), JSON.stringify(meta, null, 2));
}

/** Check if the local cache is fresh enough to skip a fetch. */
export function isCacheFresh(): boolean {
    const meta = readCacheMeta();
    if (!meta) return false;
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    return age < CACHE_MAX_AGE_MS;
}

/**
 * Ensure templates are available locally. Tries (in order):
 *   1. Bundled templates (from the agent-templates submodule)
 *   2. Local cache (~/.config/1claw/templates/)
 *   3. GitHub fetch (if online and cache is stale)
 *
 * Returns the directory containing the templates.
 */
export async function ensureTemplates(opts?: {
    force?: boolean;
    onProgress?: (msg: string) => void;
}): Promise<string> {
    const force = opts?.force ?? false;
    const onProgress = opts?.onProgress;

    // Bundled templates always take priority (submodule is the source of truth)
    const bundled = bundledTemplatesDir();
    if (bundled && existsSync(bundled)) {
        const hasTemplates = readdirSync(bundled).some(
            (d) =>
                statSync(join(bundled, d)).isDirectory() &&
                existsSync(join(bundled, d, "template.yaml")),
        );
        if (hasTemplates) {
            // Copy to cache so everything resolves from one place
            syncBundledToCache(bundled);
            return bundled;
        }
    }

    const cacheDir = templatesCacheDir();

    if (!force && isCacheFresh()) {
        return cacheDir;
    }

    // Try fetching from GitHub
    try {
        onProgress?.("Fetching templates from GitHub...");
        await fetchFromGitHub(cacheDir, onProgress);
        return cacheDir;
    } catch (err) {
        // Offline or rate-limited — fall back to cache if anything is there
        if (existsSync(cacheDir) && readdirSync(cacheDir).length > 0) {
            onProgress?.(
                "GitHub unreachable — using cached templates.",
            );
            return cacheDir;
        }
        throw new Error(
            `Cannot fetch templates and no local cache exists.\n` +
                `  Error: ${err instanceof Error ? err.message : String(err)}\n` +
                `  • Check your internet connection\n` +
                `  • Or initialize the agent-templates submodule: git submodule update --init packages/agent-templates`,
        );
    }
}

/** Fetch registry.yaml and individual templates from GitHub. */
async function fetchFromGitHub(
    cacheDir: string,
    onProgress?: (msg: string) => void,
): Promise<void> {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

    // Fetch registry.yaml
    const registryUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/registry.yaml`;
    const registryRes = await fetch(registryUrl);
    if (!registryRes.ok) {
        throw new Error(
            `Failed to fetch registry.yaml: ${registryRes.status} ${registryRes.statusText}`,
        );
    }
    const registryContent = await registryRes.text();
    writeFileSync(join(cacheDir, "..", "registry.yaml"), registryContent);

    // Parse to get template list
    const { parse } = await import("yaml");
    const registry = parse(registryContent) as {
        templates?: { name: string }[];
    };
    const templateNames =
        registry.templates?.map((t) => t.name) ?? [];

    // Fetch each template's files via the GitHub Contents API
    for (const name of templateNames) {
        onProgress?.(`Fetching template: ${name}`);
        await fetchTemplate(cacheDir, name);
    }

    writeCacheMeta({
        fetchedAt: new Date().toISOString(),
        etag: registryRes.headers.get("etag") ?? undefined,
    });
}

/** Fetch a single template's files from GitHub into the cache. */
async function fetchTemplate(
    cacheDir: string,
    name: string,
): Promise<void> {
    const templateDir = join(cacheDir, name);
    if (!existsSync(templateDir)) mkdirSync(templateDir, { recursive: true });

    const contentsUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/templates/${name}?ref=${BRANCH}`;
    const res = await fetch(contentsUrl, {
        headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return; // skip if not found

    const files = (await res.json()) as {
        name: string;
        download_url: string | null;
        type: string;
    }[];

    for (const file of files) {
        if (file.type !== "file" || !file.download_url) continue;
        try {
            const fileRes = await fetch(file.download_url);
            if (fileRes.ok) {
                writeFileSync(
                    join(templateDir, file.name),
                    await fileRes.text(),
                );
            }
        } catch {
            // best-effort per file
        }
    }
}

/** Copy bundled templates (from submodule) into the cache directory. */
function syncBundledToCache(bundledDir: string): void {
    const cacheDir = templatesCacheDir();
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

    for (const name of readdirSync(bundledDir)) {
        const src = join(bundledDir, name);
        if (!statSync(src).isDirectory()) continue;
        if (!existsSync(join(src, "template.yaml"))) continue;

        const dest = join(cacheDir, name);
        try {
            cpSync(src, dest, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }

    writeCacheMeta({ fetchedAt: new Date().toISOString() });
}

/**
 * Fetch a single template on demand (for `1claw spawn <name>` when the
 * template isn't cached or bundled).
 */
export async function fetchSingleTemplate(
    name: string,
    onProgress?: (msg: string) => void,
): Promise<string> {
    const cacheDir = templatesCacheDir();
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

    onProgress?.(`Fetching template: ${name}`);
    await fetchTemplate(cacheDir, name);

    const dir = join(cacheDir, name);
    if (!existsSync(join(dir, "template.yaml"))) {
        throw new Error(
            `Template "${name}" not found in the template registry.\n` +
                `  Run \`1claw spawn --list\` to see available templates.`,
        );
    }
    return dir;
}
