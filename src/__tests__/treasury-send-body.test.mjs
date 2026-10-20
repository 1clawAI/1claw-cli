/**
 * `treasury send` body against the vault's `SendFromWalletRequest`
 * (vault/src/api/dto/treasury_wallets.rs). The amount field is `value_wei`
 * and there is no token field for EVM: an ERC-20 transfer is a call to the
 * token contract with transfer(to, amount) calldata and zero value.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/treasury-send-body.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import { buildTreasurySendBody } from "../../dist/src/commands/treasury.js";

const TO = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("native send puts the amount in value_wei", () => {
    const b = buildTreasurySendBody({ to: TO, amount: "1000" });
    assert.deepStrictEqual(b, { to: TO, value_wei: "1000" });
    assert.ok(!("amount" in b));
});

test("ERC-20 send calls the token with transfer calldata", () => {
    const b = buildTreasurySendBody({ to: TO, amount: "255", token: USDC });
    assert.strictEqual(b.to, USDC);
    assert.strictEqual(b.value_wei, "0");
    assert.strictEqual(
        b.data,
        "0xa9059cbb" + "1".repeat(40).padStart(64, "0") + "ff".padStart(64, "0"),
    );
    assert.ok(!("token_contract" in b));
});

test("ERC-20 send refuses a decimal amount", () => {
    assert.throws(() => buildTreasurySendBody({ to: TO, amount: "1.5", token: USDC }));
});

test("non-EVM token goes in token_mint with decimals", () => {
    const b = buildTreasurySendBody({
        to: "So1anaRecipient",
        amount: "2.5",
        token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        tokenDecimals: "6",
    });
    assert.strictEqual(b.token_mint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.strictEqual(b.token_decimals, 6);
    assert.strictEqual(b.value_wei, "2.5");
});

test("approval id, memo and destination tag pass through", () => {
    const b = buildTreasurySendBody({
        to: "rXrp",
        amount: "1",
        memo: "hi",
        destinationTag: "42",
        approvalId: "6f1c9a52-0000-4000-8000-000000000000",
    });
    assert.strictEqual(b.memo, "hi");
    assert.strictEqual(b.destination_tag, 42);
    assert.strictEqual(b.approval_id, "6f1c9a52-0000-4000-8000-000000000000");
});
