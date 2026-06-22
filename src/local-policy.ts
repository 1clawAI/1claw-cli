import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");

export const POLICY_FILE = join(CONFIG_DIR, "policy.json");

export interface SecretPolicy {
    allowed_hosts: string[];
    inject_as: "header" | "query" | "bearer" | "basic";
    header_name?: string;
    query_param?: string;
}

export interface PolicyFile {
    version: number;
    defaults: {
        inject_as: "header" | "bearer";
        header_name: string;
    };
    secrets: Record<string, SecretPolicy>;
}

const DEFAULT_POLICY: PolicyFile = {
    version: 1,
    defaults: {
        inject_as: "bearer",
        header_name: "Authorization",
    },
    secrets: {},
};

export function loadPolicy(): PolicyFile {
    if (!existsSync(POLICY_FILE)) {
        return { ...DEFAULT_POLICY, secrets: {} };
    }
    try {
        return JSON.parse(readFileSync(POLICY_FILE, "utf-8")) as PolicyFile;
    } catch {
        return { ...DEFAULT_POLICY, secrets: {} };
    }
}

export function savePolicy(policy: PolicyFile): void {
    writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2) + "\n", "utf-8");
}

export function policyExists(): boolean {
    return existsSync(POLICY_FILE);
}

export function getPolicyPath(): string {
    return POLICY_FILE;
}

export function getSecretPolicy(
    policy: PolicyFile,
    secretName: string,
): SecretPolicy | null {
    return policy.secrets[secretName] ?? null;
}

export function setSecretPolicy(
    policy: PolicyFile,
    secretName: string,
    sp: SecretPolicy,
): void {
    policy.secrets[secretName] = sp;
}

export function removeSecretPolicy(
    policy: PolicyFile,
    secretName: string,
): boolean {
    if (!(secretName in policy.secrets)) return false;
    delete policy.secrets[secretName];
    return true;
}

/**
 * Check if a request URL is allowed by the secret's policy.
 * When no policy exists for a secret, all hosts are denied by default
 * (fail-closed — the daemon won't inject a secret without a policy).
 */
export function isHostAllowed(
    policy: PolicyFile,
    secretName: string,
    targetUrl: string,
): { allowed: boolean; reason: string } {
    const sp = policy.secrets[secretName];
    if (!sp) {
        return {
            allowed: false,
            reason: `No policy defined for secret "${secretName}". Add one with: 1claw daemon policy add ${secretName} --hosts <host1,host2>`,
        };
    }

    if (sp.allowed_hosts.length === 0) {
        return {
            allowed: false,
            reason: `Secret "${secretName}" has an empty allowed_hosts list.`,
        };
    }

    let hostname: string;
    try {
        hostname = new URL(targetUrl).hostname;
    } catch {
        return {
            allowed: false,
            reason: `Invalid URL: "${targetUrl}"`,
        };
    }

    for (const pattern of sp.allowed_hosts) {
        if (pattern === "*") {
            return { allowed: true, reason: "Wildcard policy" };
        }
        if (pattern.startsWith("*.")) {
            const suffix = pattern.slice(2);
            if (hostname === suffix || hostname.endsWith("." + suffix)) {
                return { allowed: true, reason: `Matches *.${suffix}` };
            }
        } else if (hostname === pattern) {
            return { allowed: true, reason: `Matches ${pattern}` };
        }
    }

    return {
        allowed: false,
        reason: `Host "${hostname}" is not in the allowed list for "${secretName}": [${sp.allowed_hosts.join(", ")}]`,
    };
}

/**
 * Resolve how to inject a secret into a request.
 */
export function resolveInjection(
    policy: PolicyFile,
    secretName: string,
    secretValue: string,
): { headers: Record<string, string>; queryParams: Record<string, string> } {
    const sp = policy.secrets[secretName];
    const injectAs = sp?.inject_as ?? policy.defaults.inject_as;
    const headers: Record<string, string> = {};
    const queryParams: Record<string, string> = {};

    switch (injectAs) {
        case "bearer":
            headers["Authorization"] = `Bearer ${secretValue}`;
            break;
        case "basic":
            headers["Authorization"] =
                `Basic ${Buffer.from(secretValue).toString("base64")}`;
            break;
        case "header": {
            const headerName =
                sp?.header_name ?? policy.defaults.header_name ?? "Authorization";
            headers[headerName] = secretValue;
            break;
        }
        case "query": {
            const param = sp?.query_param ?? secretName;
            queryParams[param] = secretValue;
            break;
        }
    }

    return { headers, queryParams };
}
