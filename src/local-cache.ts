import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    chmodSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CACHE_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
const CACHE_FILE = join(CACHE_DIR, "env-cache.enc");
const CACHE_META_FILE = join(CACHE_DIR, "env-cache.meta.json");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEFAULT_TTL_SECONDS = 3600; // 1 hour

interface CacheMeta {
    vaultId: string;
    cachedAt: string;
    ttlSeconds: number;
    secretCount: number;
}

function deriveKey(token: string, salt: Buffer): Buffer {
    return createHash("sha256")
        .update(Buffer.concat([Buffer.from(token, "utf-8"), salt]))
        .digest();
}

export function getCachePath(): string {
    return CACHE_FILE;
}

export function isCacheValid(vaultId: string, ttlSeconds?: number): boolean {
    if (!existsSync(CACHE_META_FILE) || !existsSync(CACHE_FILE)) {
        return false;
    }

    try {
        const meta: CacheMeta = JSON.parse(
            readFileSync(CACHE_META_FILE, "utf-8"),
        );

        if (meta.vaultId !== vaultId) return false;

        const ttl = ttlSeconds ?? meta.ttlSeconds ?? DEFAULT_TTL_SECONDS;
        const cachedAt = new Date(meta.cachedAt).getTime();
        const expiresAt = cachedAt + ttl * 1000;

        return Date.now() < expiresAt;
    } catch {
        return false;
    }
}

export function writeCache(
    token: string,
    vaultId: string,
    secrets: Record<string, string>,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
): void {
    if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
    }

    const salt = randomBytes(16);
    const key = deriveKey(token, salt);
    const iv = randomBytes(IV_LENGTH);

    const plaintext = JSON.stringify(secrets);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf-8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // File format: [salt:16][iv:12][tag:16][ciphertext]
    const output = Buffer.concat([salt, iv, tag, encrypted]);
    writeFileSync(CACHE_FILE, output);
    try {
        chmodSync(CACHE_FILE, 0o600);
    } catch {
        // best-effort
    }

    const meta: CacheMeta = {
        vaultId,
        cachedAt: new Date().toISOString(),
        ttlSeconds,
        secretCount: Object.keys(secrets).length,
    };
    writeFileSync(CACHE_META_FILE, JSON.stringify(meta, null, 2), "utf-8");
    try {
        chmodSync(CACHE_META_FILE, 0o600);
    } catch {
        // best-effort
    }
}

export function readCache(
    token: string,
    vaultId: string,
    ttlSeconds?: number,
): Record<string, string> | null {
    if (!isCacheValid(vaultId, ttlSeconds)) {
        return null;
    }

    try {
        const data = readFileSync(CACHE_FILE);

        const salt = data.subarray(0, 16);
        const iv = data.subarray(16, 16 + IV_LENGTH);
        const tag = data.subarray(16 + IV_LENGTH, 16 + IV_LENGTH + TAG_LENGTH);
        const encrypted = data.subarray(16 + IV_LENGTH + TAG_LENGTH);

        const key = deriveKey(token, salt);
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final(),
        ]);

        return JSON.parse(decrypted.toString("utf-8"));
    } catch {
        return null;
    }
}

export function clearCache(): boolean {
    let cleared = false;
    if (existsSync(CACHE_FILE)) {
        unlinkSync(CACHE_FILE);
        cleared = true;
    }
    if (existsSync(CACHE_META_FILE)) {
        unlinkSync(CACHE_META_FILE);
        cleared = true;
    }
    return cleared;
}

export function getCacheInfo(): {
    exists: boolean;
    meta?: CacheMeta;
    sizeBytes?: number;
    expired?: boolean;
} {
    if (!existsSync(CACHE_META_FILE)) {
        return { exists: false };
    }

    try {
        const meta: CacheMeta = JSON.parse(
            readFileSync(CACHE_META_FILE, "utf-8"),
        );
        const stat = existsSync(CACHE_FILE)
            ? statSync(CACHE_FILE)
            : undefined;
        const cachedAt = new Date(meta.cachedAt).getTime();
        const expiresAt = cachedAt + meta.ttlSeconds * 1000;

        return {
            exists: true,
            meta,
            sizeBytes: stat?.size,
            expired: Date.now() >= expiresAt,
        };
    } catch {
        return { exists: false };
    }
}
