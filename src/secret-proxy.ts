import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { URL } from "node:url";
import {
    type PolicyFile,
    isHostAllowed,
    resolveInjection,
} from "./local-policy.js";
import type { LocalVaultData } from "./local-vault.js";

export interface ProxyRequest {
    secretName: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /**
     * Additional secrets to inject into the same request (each resolved and
     * host-checked against its own policy, then merged). Enables e.g. injecting
     * both an auth header and a provider API-key header without exposing either
     * value to the caller.
     */
    injectSecrets?: string[];
}

export interface ProxyResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface ProxyResult {
    success: boolean;
    response?: ProxyResponse;
    error?: string;
}

/**
 * Execute an HTTP request with a secret injected, without exposing
 * the secret value to the caller. The secret is resolved from the
 * local vault, checked against the policy, and injected into the
 * request per the policy rules.
 */
export async function proxyRequest(
    req: ProxyRequest,
    vault: LocalVaultData,
    policy: PolicyFile,
): Promise<ProxyResult> {
    // Resolve every secret to inject: the primary plus any additional ones.
    // Each is independently host-checked against its own policy and merged.
    const names = [req.secretName, ...(req.injectSecrets ?? [])];
    const seen = new Set<string>();
    const url = new URL(req.url);
    const mergedHeaders: Record<string, string> = { ...(req.headers ?? {}) };

    for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);

        const secret = vault.secrets[name];
        if (!secret) {
            return {
                success: false,
                error: `Secret "${name}" not found in local vault.`,
            };
        }

        const hostCheck = isHostAllowed(policy, name, req.url);
        if (!hostCheck.allowed) {
            return { success: false, error: hostCheck.reason };
        }

        const injection = resolveInjection(policy, name, secret.value);
        for (const [k, v] of Object.entries(injection.queryParams)) {
            url.searchParams.set(k, v);
        }
        Object.assign(mergedHeaders, injection.headers);
    }

    const method = req.method ?? "GET";

    return new Promise((resolve) => {
        const isHttps = url.protocol === "https:";
        const requestFn = isHttps ? httpsRequest : httpRequest;

        const upstreamReq = requestFn(
            url,
            { method, headers: mergedHeaders },
            (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf-8");
                    const responseHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                        if (typeof v === "string") responseHeaders[k] = v;
                        else if (Array.isArray(v)) responseHeaders[k] = v.join(", ");
                    }
                    resolve({
                        success: true,
                        response: {
                            status: res.statusCode ?? 502,
                            headers: responseHeaders,
                            body,
                        },
                    });
                });
            },
        );

        upstreamReq.on("error", (err) => {
            resolve({
                success: false,
                error: `Upstream request failed: ${err.message}`,
            });
        });

        upstreamReq.setTimeout(30_000, () => {
            upstreamReq.destroy(new Error("Request timed out (30s)"));
        });

        if (req.body) {
            upstreamReq.write(req.body);
        }
        upstreamReq.end();
    });
}
