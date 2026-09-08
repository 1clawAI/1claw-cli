/**
 * Paywall challenge windows, and how many times to chase one.
 *
 * A challenge that expires cannot be re-prepared from the bytes already held:
 * the same expired window comes back, and many challenges carry a single-use
 * nonce. The only way forward is to fetch the resource again for a fresh 402
 * (D6).
 *
 * Capped at two full cycles. A paywall with a ten-second window will always
 * expire while a person reads the authorize page, and retrying forever turns
 * that into an endless prompt rather than an error anyone can act on.
 */
export const MAX_REFETCH_CYCLES = 2;

export function challengeExpiredMessage(cycles: number): string {
    return (
        `The paywall's challenge window closed ${cycles} times before the payment ` +
        `could be authorized.\n` +
        `Its window is likely too short for a per-payment approval. Try again, or ` +
        `use a spending grant (--mode session) so payments inside the window need ` +
        `no prompt.`
    );
}

/** True when the vault told us the challenge expired rather than something else. */
export function isChallengeExpired(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    return e?.status === 409 || /ChallengeExpired/i.test(e?.message ?? "");
}
