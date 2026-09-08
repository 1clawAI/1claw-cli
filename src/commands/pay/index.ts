import { Command } from "commander";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import open from "open";
import ora from "ora";

import { handleError, requireToken } from "../../middleware.js";
import { fetchResource } from "./challenge.js";
import {
    MAX_REFETCH_CYCLES,
    challengeExpiredMessage,
    isChallengeExpired,
} from "./expiry.js";
import {
    isDevSigner,
    resolveSigner,
    type PaySigner,
    type PrepareResult,
} from "./signer.js";

function authorizeUrl(sessionId: string): string {
    const base =
        process.env.ONECLAW_DASHBOARD_URL?.replace(/\/$/, "") ??
        "https://1claw.co";
    return `${base}/cli/pay-authorize?session=${sessionId}`;
}

function describeQuote(q: Record<string, unknown>): string {
    const amount = q.amount_usd ? `$${q.amount_usd}` : "unknown amount";
    const to = typeof q.pay_to === "string" ? q.pay_to : "?";
    const short = to.length > 12 ? `${to.slice(0, 6)}…${to.slice(-4)}` : to;
    return `${amount} ${q.asset ?? ""} → ${short}`.replace(/\s+/g, " ").trim();
}

/**
 * One attempt: prepare, get whatever authorization is required, sign.
 *
 * Returns null when the paywall's challenge expired, which the caller answers by
 * fetching the resource again rather than retrying this (D6).
 */
async function authorizeAndSign(
    signer: PaySigner,
    agentId: string,
    challengeB64: string,
    method: string,
    url: string,
    mode: string,
    idempotencyKey: string,
): Promise<{ header: string; paymentId: string; amount: string } | null> {
    let prepared: PrepareResult;
    try {
        prepared = await signer.prepare(agentId, {
            challenge_b64: challengeB64,
            method,
            resource_url: url,
            idempotency_key: idempotencyKey,
            mode,
        });
    } catch (err) {
        if (isChallengeExpired(err)) return null;
        throw err;
    }

    console.log(chalk.dim(`  402 │ ${describeQuote(prepared.quote)}`));
    if (prepared.authorization.startsWith("deny:")) {
        throw new Error(
            `The vault refused this payment — ${prepared.authorization.slice(5).trim()}`,
        );
    }
    if (prepared.short_window) {
        console.log(
            chalk.yellow(
                "  ⚠ This paywall's window is under 30s and may close while you authorize.",
            ),
        );
    }

    if (prepared.authorization === "require_grant") {
        throw new Error(
            "This payment needs a spending grant. Create one with:\n" +
                `  1claw pay grant --agent ${agentId} --cap 5.00 --ttl 15m`,
        );
    }

    if (prepared.authorization === "require_passkey") {
        const url = authorizeUrl(prepared.session_id);
        console.log(`  Authorize: ${chalk.cyan(url)}`);
        try {
            await open(url);
        } catch {
            /* headless: the printed URL is the fallback */
        }
        const spinner = ora("Waiting for you to authorize…").start();
        // Bounded by the session, not by a number picked here — the vault
        // already decided how long this payment may stay pending.
        const deadline = new Date(prepared.expires_at).getTime();
        const ok = await signer.waitForAuthorization(prepared.session_id, deadline);
        if (!ok) {
            spinner.fail("Not authorized.");
            throw new Error("The payment was not authorized before the session expired.");
        }
        spinner.succeed("Authorized");
    }

    try {
        const signed = await signer.sign(agentId, {
            session_id: prepared.session_id,
            mode,
        });
        return {
            header: signed.payment_header,
            paymentId: signed.payment_id,
            amount: signed.amount_usd,
        };
    } catch (err) {
        if (isChallengeExpired(err)) return null;
        throw err;
    }
}

export const payCommand = new Command("pay")
    .description("Pay for an x402-gated resource")
    .argument("<url>", "the resource to fetch")
    .requiredOption("--agent <id>", "agent whose key signs the payment")
    .option("--method <verb>", "HTTP method", "GET")
    .option("--body <json>", "request body (buffered and replayed on the paid retry)")
    .option(
        "--mode <mode>",
        "strict | session | auto — a request; the vault decides what is permitted",
        "strict",
    )
    .action(async (url: string, opts) => {
        try {
            const signer = resolveSigner();
            // The dev signer never calls the vault, so it needs no session.
            // Everything else does, and finding that out before fetching a
            // paywall is kinder than finding out after.
            if (!isDevSigner(signer)) requireToken();

            // One key for the whole attempt, including refetch cycles: a crash
            // mid-sign must not become a second payment for the same resource.
            const idempotencyKey = randomUUID();

            let paid: Awaited<ReturnType<typeof authorizeAndSign>> = null;
            let cycles = 0;

            while (cycles <= MAX_REFETCH_CYCLES) {
                const first = await fetchResource(url, {
                    method: opts.method,
                    body: opts.body,
                });

                if (first.status !== 402) {
                    // Nothing to pay for. Say so rather than inventing a payment.
                    console.log(
                        chalk.dim(`  ${first.status} │ no payment required`),
                    );
                    process.stdout.write(first.bodyText);
                    return;
                }

                paid = await authorizeAndSign(
                    signer,
                    opts.agent,
                    first.challengeB64!,
                    opts.method,
                    url,
                    opts.mode,
                    idempotencyKey,
                );
                if (paid) break;

                cycles += 1;
                if (cycles > MAX_REFETCH_CYCLES) break;
                console.log(
                    chalk.yellow(
                        `  Challenge expired — fetching a fresh one (${cycles}/${MAX_REFETCH_CYCLES})`,
                    ),
                );
            }

            if (!paid) throw new Error(challengeExpiredMessage(MAX_REFETCH_CYCLES));

            console.log(chalk.dim(`  signed │ $${paid.amount}`));

            const retry = await fetchResource(url, {
                method: opts.method,
                body: opts.body,
                paymentHeader: paid.header,
            });

            // Advisory only. It moves the audit trail; it never returns limit
            // headroom, so there is nothing to gain by shading it.
            await signer
                .reportResult(opts.agent, paid.paymentId, {
                    http_status: retry.status,
                    settled: retry.status < 400,
                })
                .catch(() => {
                    /* reporting is best-effort by design */
                });

            console.log(chalk.dim(`  ${retry.status} │ paid`));
            process.stdout.write(retry.bodyText);
        } catch (err) {
            handleError(err);
        }
    });
