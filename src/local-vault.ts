import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    chmodSync,
    statSync,
    unlinkSync,
    renameSync,
} from "node:fs";
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    pbkdf2Sync,
    createHash,
} from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");

const VAULT_FILE =
    process.env.ONECLAW_LOCAL_VAULT || join(CONFIG_DIR, "local-vault.enc");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const FILE_VERSION = 1;

export interface LocalSecret {
    value: string;
    type: string;
    created_at: string;
    updated_at: string;
    synced_to_cloud: boolean;
    cloud_vault_id: string | null;
    cloud_path: string | null;
}

export interface LocalVaultData {
    version: number;
    created_at: string;
    updated_at: string;
    secrets: Record<string, LocalSecret>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
}

function encrypt(plaintext: string, passphrase: string): Buffer {
    const salt = randomBytes(SALT_LENGTH);
    const key = deriveKey(passphrase, salt);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf-8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Wire format: [version:1][salt:16][iv:12][tag:16][ciphertext]
    return Buffer.concat([
        Buffer.from([FILE_VERSION]),
        salt,
        iv,
        tag,
        encrypted,
    ]);
}

function decrypt(data: Buffer, passphrase: string): string {
    const version = data[0];
    if (version !== FILE_VERSION) {
        throw new Error(`Unsupported vault file version: ${version}`);
    }

    let offset = 1;
    const salt = data.subarray(offset, offset + SALT_LENGTH);
    offset += SALT_LENGTH;
    const iv = data.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const tag = data.subarray(offset, offset + TAG_LENGTH);
    offset += TAG_LENGTH;
    const encrypted = data.subarray(offset);

    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
    ]);

    return decrypted.toString("utf-8");
}

export function getVaultPath(): string {
    return VAULT_FILE;
}

export function vaultExists(): boolean {
    return existsSync(VAULT_FILE);
}

export function createVault(passphrase: string): LocalVaultData {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const now = new Date().toISOString();
    const vault: LocalVaultData = {
        version: FILE_VERSION,
        created_at: now,
        updated_at: now,
        secrets: {},
    };

    saveVault(vault, passphrase);
    return vault;
}

export function loadVault(passphrase: string): LocalVaultData {
    if (!existsSync(VAULT_FILE)) {
        throw new Error(
            "No local vault found. Run `1claw local init` first.",
        );
    }

    const data = readFileSync(VAULT_FILE);
    const json = decrypt(data, passphrase);
    return JSON.parse(json) as LocalVaultData;
}

export function saveVault(vault: LocalVaultData, passphrase: string): void {
    vault.updated_at = new Date().toISOString();
    const json = JSON.stringify(vault);
    const encrypted = encrypt(json, passphrase);

    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const tmpPath = VAULT_FILE + ".tmp";
    writeFileSync(tmpPath, encrypted);
    try {
        chmodSync(tmpPath, 0o600);
    } catch {
        // best-effort
    }

    renameSync(tmpPath, VAULT_FILE);
}

export function addSecret(
    vault: LocalVaultData,
    name: string,
    value: string,
    type: string = "api_key",
): void {
    const now = new Date().toISOString();
    vault.secrets[name] = {
        value,
        type,
        created_at: vault.secrets[name]?.created_at ?? now,
        updated_at: now,
        synced_to_cloud: false,
        cloud_vault_id: null,
        cloud_path: null,
    };
}

export function removeSecret(vault: LocalVaultData, name: string): boolean {
    if (!(name in vault.secrets)) return false;
    delete vault.secrets[name];
    return true;
}

export function getSecret(
    vault: LocalVaultData,
    name: string,
): LocalSecret | null {
    return vault.secrets[name] ?? null;
}

export function listSecrets(
    vault: LocalVaultData,
): Array<{ name: string; type: string; synced: boolean; updated_at: string }> {
    return Object.entries(vault.secrets).map(([name, s]) => ({
        name,
        type: s.type,
        synced: s.synced_to_cloud,
        updated_at: s.updated_at,
    }));
}

export function markSynced(
    vault: LocalVaultData,
    name: string,
    cloudVaultId: string,
    cloudPath: string,
): void {
    const secret = vault.secrets[name];
    if (!secret) return;
    secret.synced_to_cloud = true;
    secret.cloud_vault_id = cloudVaultId;
    secret.cloud_path = cloudPath;
}

export function getVaultInfo(): {
    exists: boolean;
    sizeBytes?: number;
    path: string;
} {
    if (!existsSync(VAULT_FILE)) {
        return { exists: false, path: VAULT_FILE };
    }
    const stat = statSync(VAULT_FILE);
    return { exists: true, sizeBytes: stat.size, path: VAULT_FILE };
}

export function deleteVault(): boolean {
    if (!existsSync(VAULT_FILE)) return false;
    unlinkSync(VAULT_FILE);
    return true;
}

export function exportAsEnv(vault: LocalVaultData): string {
    return Object.entries(vault.secrets)
        .map(([name, s]) => {
            const val = s.value.includes(" ") ? `"${s.value}"` : s.value;
            return `${name}=${val}`;
        })
        .join("\n") + "\n";
}

export function fingerprintPassphrase(passphrase: string): string {
    return createHash("sha256")
        .update(passphrase)
        .digest("hex")
        .slice(0, 8);
}
