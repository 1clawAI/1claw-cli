import Conf from "conf";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredAuth {
    token: string;
    email: string;
    userId: string;
    orgId: string;
    expiresAt?: string;
}

export interface ProjectLink {
    vaultId: string;
    apiUrl: string;
}

interface ConfigSchema {
    auth: StoredAuth | null;
    apiUrl: string;
    projectLinks: Record<string, ProjectLink>;
    defaultVaultId: string | null;
    outputFormat: "table" | "json" | "plain";
}

const configDir =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
const config = new Conf<ConfigSchema>({
    projectName: "1claw",
    cwd: configDir,
    defaults: {
        auth: null,
        apiUrl: "https://api.1claw.xyz",
        projectLinks: {},
        defaultVaultId: null,
        outputFormat: "table",
    },
});

export function getAuth(): StoredAuth | null {
    if (process.env.ONECLAW_TOKEN) {
        return {
            token: process.env.ONECLAW_TOKEN,
            email: "env",
            userId: "env",
            orgId: "env",
        };
    }
    return config.get("auth");
}

export function setAuth(auth: StoredAuth): void {
    config.set("auth", auth);
}

export function clearAuth(): void {
    config.set("auth", null);
}

export function getToken(): string | null {
    if (process.env.ONECLAW_TOKEN) return process.env.ONECLAW_TOKEN;
    if (process.env.ONECLAW_API_KEY) return process.env.ONECLAW_API_KEY;
    return config.get("auth")?.token ?? null;
}

export function getApiUrl(): string {
    return process.env.ONECLAW_API_URL ?? config.get("apiUrl");
}

export function setApiUrl(url: string): void {
    config.set("apiUrl", url);
}

export function getDefaultVaultId(): string | null {
    return process.env.ONECLAW_VAULT_ID ?? config.get("defaultVaultId");
}

export function setDefaultVaultId(id: string): void {
    config.set("defaultVaultId", id);
}

export function getOutputFormat(): "table" | "json" | "plain" {
    return config.get("outputFormat");
}

export function setOutputFormat(format: "table" | "json" | "plain"): void {
    config.set("outputFormat", format);
}

export function getProjectLink(dir: string): ProjectLink | null {
    return config.get("projectLinks")[dir] ?? null;
}

export function setProjectLink(dir: string, link: ProjectLink): void {
    const links = config.get("projectLinks");
    links[dir] = link;
    config.set("projectLinks", links);
}

export function getConfigPath(): string {
    return config.path;
}
