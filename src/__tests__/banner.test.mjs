/**
 * The banner above `1claw --help`: the mark keeps its shape, and the banner never reaches pipes, scripts or JSON.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/banner.test.mjs
 */
import test from "node:test";
import assert from "node:assert";

import { banner, markLines, shouldShowBanner } from "../../dist/src/banner.js";

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the mark is 10 rows of 20 columns", () => {
  const rows = markLines().map(visible);
  assert.strictEqual(rows.length, 10);
  for (const row of rows) assert.strictEqual([...row].length, 20);
});

test("narrow terminals get a single line", () => {
  const out = visible(banner("v0.0.0", 40)).trim();
  assert.strictEqual(out.split("\n").length, 1);
  assert.match(out, /1Claw/);
});

test("wide terminals get the mark and the wordmark", () => {
  const out = visible(banner("v0.0.0", 120));
  assert.match(out, /██╗/);
  assert.match(out, /v0\.0\.0/);
});

test("no banner for --json, or when output is not a terminal", () => {
  assert.strictEqual(shouldShowBanner(["node", "1claw", "--json", "--help"]), false);
  const tty = process.stdout.isTTY;
  try {
    process.stdout.isTTY = false;
    assert.strictEqual(shouldShowBanner(["node", "1claw", "--help"]), false);
  } finally {
    process.stdout.isTTY = tty;
  }
});
