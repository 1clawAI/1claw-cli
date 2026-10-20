/**
 * The proxy prints how to point a vendor tool at it. With auth on (the
 * default) it refuses any request whose Authorization / X-API-Key is not the
 * per-run proxy token, so the printed BANKR_API_KEY must be that token. It
 * used to print a fixed placeholder the proxy then answered 401 to.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/binding-proxy-hint.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import {
    vendorKeyHint,
    presentedCredential,
    credentialMatches,
} from "../../dist/src/commands/binding-proxy.js";

function exportedValue(line) {
    const m = /export BANKR_API_KEY=(\S+)/.exec(line);
    assert.ok(m, line);
    return m[1];
}

test("with a proxy token, the printed key is accepted by the proxy's own check", () => {
    const token = "ptok_abc123";
    const value = exportedValue(vendorKeyHint(token));
    assert.ok(credentialMatches(presentedCredential({ "x-api-key": value }), token));
    assert.ok(credentialMatches(presentedCredential({ authorization: `Bearer ${value}` }), token));
});

test("--no-auth prints a placeholder", () => {
    const value = exportedValue(vendorKeyHint(undefined));
    assert.ok(value.length > 0);
});
