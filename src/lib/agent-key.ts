import { apiNoAuth, ApiError } from "../client.js";
import { createInterface } from "node:readline";

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
/**
 * ONBOARDKEY-L1. Read the key from stdin instead of argv.
 *
 * `ONECLAW_AGENT_API_KEY=ocv_… npx @1claw/cli proxy` puts a live agent key
 * into the shell's history file and into the process environment, where any
 * other process owned by the user can read it out of /proc. `--agent-key -`
 * takes it from stdin instead: piped (`pbpaste | … --agent-key -`) or typed
 * at the prompt, and in neither case does it reach argv or history.
 */
async function readAgentKeyFromStdin(): Promise<string> {
    if (process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
            return await new Promise<string>((resolve) => {
                rl.question("Agent key (ocv_…): ", (answer) => resolve(answer));
            });
        } finally {
            rl.close();
        }
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
}

export async function resolveAgentKeyFromInput(
    input: string,
): Promise<ResolvedAgentKey> {
    // `-` is the conventional "read it from stdin" spelling.
    const raw = input.trim() === "-" ? await readAgentKeyFromStdin() : input;
    const trimmed = raw.trim();
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
