/**
 * `approval decide` must send the vault's spelling: ApprovalDecideRequest
 * accepts only "approved" or "rejected" (vault/src/api/handlers/approvals.rs).
 * The CLI used to send "approve"/"reject", which always answered 400.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/approval-decision.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import { normalizeApprovalDecision } from "../../dist/src/commands/approval.js";

test("verbs map to the server's spelling", () => {
    assert.strictEqual(normalizeApprovalDecision("approve"), "approved");
    assert.strictEqual(normalizeApprovalDecision("reject"), "rejected");
});

test("the server's spelling passes through, any case", () => {
    assert.strictEqual(normalizeApprovalDecision("approved"), "approved");
    assert.strictEqual(normalizeApprovalDecision("REJECTED"), "rejected");
});

test("anything else is refused", () => {
    assert.strictEqual(normalizeApprovalDecision("yes"), undefined);
    assert.strictEqual(normalizeApprovalDecision(""), undefined);
});
