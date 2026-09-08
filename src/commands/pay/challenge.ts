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

export async function fetchResource(
    url: string,
    opts: { method: string; body?: string; paymentHeader?: string },
): Promise<FetchOutcome> {
    const headers: Record<string, string> = {};
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.paymentHeader) headers["X-PAYMENT"] = opts.paymentHeader;

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
