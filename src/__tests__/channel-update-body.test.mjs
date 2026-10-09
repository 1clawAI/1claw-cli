/**
 * `channel update` has to keep three states apart for every clearable field:
 * set, clear, and untouched. Collapsing clear into untouched is how this
 * command was reported broken in the first place — `--sender-allowlist <id>`
 * answered 200, bumped `updated_at`, and changed nothing.
 *
 * The vault distinguishes them with `double_option`, so an omitted key is
 * "leave it alone" and only an explicit `null` revokes an admin. A body built
 * with `undefined` would serialise to an absent key and be silently ignored —
 * indistinguishable, from the CLI's side, from success.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/channel-update-body.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import { buildChannelUpdateBody } from "../../dist/src/commands/channel.js";

test("--admin <id> names an admin", () => {
  const body = buildChannelUpdateBody({ admin: "123456789" });
  assert.strictEqual(body.owner_sender_id, "123456789");
});

test('--admin "" revokes with an explicit null, not an absent key', () => {
  const body = buildChannelUpdateBody({ admin: "" });
  assert.ok(
    "owner_sender_id" in body,
    "the key must be present — an absent key means 'leave the admin alone'",
  );
  assert.strictEqual(
    body.owner_sender_id,
    null,
    "only an explicit null revokes; undefined would serialise away and the " +
      "command would report success having done nothing",
  );
});

test("omitting --admin leaves the current admin alone", () => {
  const body = buildChannelUpdateBody({ active: "false" });
  assert.ok(
    !("owner_sender_id" in body),
    "pausing a channel must not touch its admin",
  );
  assert.strictEqual(body.is_active, false);
});

test("the two grants are independent", () => {
  // Naming an admin must not restrict who can message the agent, and setting
  // an allowlist must not clear the named admin. A non-empty allowlist also
  // gates auto-respond, so conflating them would cut off the channel.
  const named = buildChannelUpdateBody({ admin: "111" });
  assert.ok(!("sender_allowlist" in named));

  const restricted = buildChannelUpdateBody({ senderAllowlist: ["111", "222"] });
  assert.ok(!("owner_sender_id" in restricted));
  assert.deepStrictEqual(restricted.sender_allowlist, ["111", "222"]);
});

test('--sender-allowlist "" still clears with an empty array', () => {
  const body = buildChannelUpdateBody({ senderAllowlist: "" });
  assert.deepStrictEqual(body.sender_allowlist, []);
});

test("an empty update sends an empty body rather than nulls", () => {
  // Every field is omitted, so nothing is cleared by accident. This is the
  // property that makes the three-state handling safe to rely on.
  assert.deepStrictEqual(buildChannelUpdateBody({}), {});
});
