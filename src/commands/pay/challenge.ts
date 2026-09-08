/**
 * Fetching a resource and capturing a 402 exactly as served.
 *
 * The raw bytes matter. The vault computes the digest a person authorizes from
 * this preimage, so anything reinterpreted here — re-encoded JSON, a header
 * parsed into fields — would fall outside what they approved.
 */
export interface FetchOutcome {
    status: number;
    /** Present only on a 402. The challenge, byte-for-byte, base64. */
    challengeB64?: string;
    bodyText: string;
    headers: Headers;
}

/**
 * Whether the session token may travel to this resource.
 *
 * True only for the configured 1claw API's own origin. Paying an org's overage
 * means calling that API, which authenticates as usual — a payment clears the
 * paywall, it does not stand in for a login, so a paid retry without the token
 * earns a 401. Every other origin is a stranger's paywall, and a bearer token
 * that opens the caller's vault has no business being sent there.
 *
 * Compared by parsed origin, not `startsWith`: `https://api.1claw.co.evil.test`
 * has the API's URL as a prefix and must not receive the token.
 */
export function mayForwardToken(url: string, apiUrl: string): boolean {
    try {
        return new URL(url).origin === new URL(apiUrl).origin;
    } catch {
        return false; // unparseable target: never forward
    }
}

export async function fetchResource(
    url: string,
    opts: {
        method: string;
        body?: string;
        paymentHeader?: string;
        authToken?: string;
    },
): Promise<FetchOutcome> {
    const headers: Record<string, string> = {};
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.paymentHeader) headers["X-PAYMENT"] = opts.paymentHeader;
    // Sent on the unpaid probe too: the 402 an authenticated caller is served
    // is the one their payment must satisfy.
    if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

    const res = await fetch(url, {
        method: opts.method,
        headers,
        // Buffered by the caller and replayed verbatim on the paid retry (D8).
        body: opts.body,
    });

    const buf = new Uint8Array(await res.arrayBuffer());
    const bodyText = new TextDecoder().decode(buf);

    if (res.status !== 402) {
        return { status: res.status, bodyText, headers: res.headers };
    }

    // x402 v2 carries the challenge in a header; v1 in the body. Whichever the
    // origin used is what gets sent on, unmodified.
    const headerChallenge = res.headers.get("payment-required");
    const challengeB64 = headerChallenge
        ? headerChallenge.trim()
        : Buffer.from(buf).toString("base64");

    return { status: 402, challengeB64, bodyText, headers: res.headers };
}
