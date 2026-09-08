import { api } from "../../client.js";

/**
 * Everything the pay command needs from the vault, behind one interface.
 *
 * The seam exists so the flow can be exercised without a funded agent and a
 * live paywall — CI needs to know the refetch loop and the retry semantics are
 * right, and neither of those is about signing. The production path is always
 * Vault-backed; the dev signer never produces anything a paywall would accept.
 */
export interface PrepareResult {
    session_id: string;
    payment_digest: string;
    sign_idempotency_key: string;
    quote: Record<string, unknown>;
    valid_before: string | null;
    expires_at: string;
    authorization: string;
    short_window: boolean;
}

export interface SignResult {
    payment_id: string;
    payment_header: string;
    amount_usd: string;
    pay_to: string;
    grant_id: string | null;
}

export interface PaySigner {
    prepare(
        agentId: string,
        body: {
            challenge_b64: string;
            method: string;
            resource_url: string;
            idempotency_key?: string;
            mode?: string;
        },
    ): Promise<PrepareResult>;

    sign(
        agentId: string,
        body: { session_id: string; mode?: string; grant_id?: string },
    ): Promise<SignResult>;

    /** Poll a session until a human has authorized it, or the deadline passes. */
    waitForAuthorization(sessionId: string, deadlineMs: number): Promise<boolean>;

    reportResult(
        agentId: string,
        paymentId: string,
        body: { http_status?: number; settled?: boolean; error?: string | null },
    ): Promise<void>;
}

export class VaultPaySigner implements PaySigner {
    async prepare(agentId: string, body: Parameters<PaySigner["prepare"]>[1]) {
        return api<PrepareResult>(`/agents/${agentId}/pay/prepare`, {
            method: "POST",
            body,
        });
    }

    async sign(agentId: string, body: Parameters<PaySigner["sign"]>[1]) {
        return api<SignResult>(`/agents/${agentId}/pay/sign`, {
            method: "POST",
            body,
        });
    }

    async waitForAuthorization(sessionId: string, deadlineMs: number) {
        // Fixed 2s cadence: the poll draws on the auth rate limiter, and a
        // tighter loop drains a shared bucket for every other suite and session
        // on the same address.
        while (Date.now() < deadlineMs) {
            const s = await api<{ status: string }>(
                `/pay-sessions/${sessionId}`,
            );
            if (s.status === "authorized") return true;
            if (s.status === "expired" || s.status === "failed") return false;
            await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
    }

    async reportResult(
        agentId: string,
        paymentId: string,
        body: Parameters<PaySigner["reportResult"]>[2],
    ) {
        await api(`/agents/${agentId}/pay/${paymentId}/result`, {
            method: "POST",
            body,
        });
    }
}

/**
 * A signer for tests. Produces a syntactically shaped header that no paywall
 * will honour, which is the point: it exercises the flow without ever being
 * mistakable for a real payment.
 *
 * Only reachable with ONECLAW_PAY_DEV=1.
 */
export class DevPaySigner implements PaySigner {
    private counter = 0;
    /**
     * Simulate a paywall whose challenge window keeps closing.
     *
     * The refetch cap is a real behaviour with a real failure mode — an endless
     * authorize prompt — and it cannot be exercised against a signer that always
     * succeeds. ONECLAW_PAY_DEV_EXPIRE=n makes the first n prepares expire.
     */
    private expiriesLeft = Number(process.env.ONECLAW_PAY_DEV_EXPIRE ?? 0);

    async prepare(_agentId: string, body: Parameters<PaySigner["prepare"]>[1]) {
        if (this.expiriesLeft > 0) {
            this.expiriesLeft -= 1;
            const err = new Error("ChallengeExpired: re-fetch the resource") as Error & {
                status?: number;
            };
            err.status = 409;
            throw err;
        }
        this.counter += 1;
        return {
            session_id: `dev-session-${this.counter}`,
            payment_digest: "0".repeat(64),
            sign_idempotency_key: body.idempotency_key ?? `dev-idem-${this.counter}`,
            quote: { amount_usd: "0.001", pay_to: "0xDEV", resource_url: body.resource_url },
            valid_before: new Date(Date.now() + 60_000).toISOString(),
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            authorization: "allow",
            short_window: false,
        };
    }

    async sign(_agentId: string, body: Parameters<PaySigner["sign"]>[1]) {
        return {
            payment_id: body.session_id,
            payment_header: "dev-not-a-real-payment",
            amount_usd: "0.001",
            pay_to: "0xDEV",
            grant_id: null,
        };
    }

    async waitForAuthorization() {
        return true;
    }

    async reportResult() {
        /* nothing to record */
    }
}

export function resolveSigner(): PaySigner {
    return process.env.ONECLAW_PAY_DEV === "1"
        ? new DevPaySigner()
        : new VaultPaySigner();
}

/** Whether this signer talks to the vault at all. */
export function isDevSigner(s: PaySigner): boolean {
    return s instanceof DevPaySigner;
}
