import { apiNoAuth, ApiError } from "../client.js";

export interface ResolvedAgentKey {
    agentId: string;
    apiKey: string;
    /** Shroud-ready `agent_id:api_key` header value. */
    shroudAgentKey: string;
    vaultIds?: string[];
}

/**
 * Normalize `--agent-key` input for Shroud and spawn flows.
 * Accepts `agent_id:ocv_...` or key-only `ocv_...` (Vault resolves agent by prefix).
 */
export async function resolveAgentKeyFromInput(
    input: string,
): Promise<ResolvedAgentKey> {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("Agent key is empty.");
    }

    if (trimmed.includes(":")) {
        const colon = trimmed.indexOf(":");
        const agentId = trimmed.slice(0, colon).trim();
        const apiKey = trimmed.slice(colon + 1).trim();
        if (!agentId || !apiKey) {
            throw new Error(
                "Invalid agent key format. Use agent_id:ocv_... or a standalone ocv_ key.",
            );
        }
        return { agentId, apiKey, shroudAgentKey: `${agentId}:${apiKey}` };
    }

    if (!trimmed.startsWith("ocv_")) {
        throw new Error(
            "Pass agent credentials as agent_id:api_key, or a standalone agent API key (ocv_...).",
        );
    }

    try {
        const res = await apiNoAuth<{
            agent_id?: string;
            vault_ids?: string[];
        }>("/auth/agent-token", {
            method: "POST",
            body: { api_key: trimmed },
        });
        if (!res.agent_id) {
            throw new Error(
                "Token exchange succeeded but server did not return agent_id. Use agent_id:api_key explicitly.",
            );
        }
        return {
            agentId: res.agent_id,
            apiKey: trimmed,
            shroudAgentKey: `${res.agent_id}:${trimmed}`,
            vaultIds: res.vault_ids,
        };
    } catch (err) {
        if (err instanceof ApiError) {
            throw new Error(
                `Could not resolve agent from API key (${err.status}): ${err.detail}`,
            );
        }
        throw err;
    }
}
