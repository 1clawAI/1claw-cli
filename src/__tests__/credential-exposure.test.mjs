/**
 * RUNENV-L1 and SHROUDHTTP-L1. Both are about the agent key reaching somewhere
 * it should not: the child agent's own environment, and the wire in cleartext.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/credential-exposure.test.mjs
 */
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import { assertShroudUrlIsSafe } from "../../dist/src/commands/proxy.js";
import { CREDENTIALS_WITHHELD_FROM_AGENT } from "../../dist/src/commands/run.js";

test("plain HTTP to a non-loopback Shroud is refused", () => {
  for (const url of [
    "http://shroud.example.com",
    "http://10.0.0.5:8080",
    "http://evil.example/v1",
    "http://169.254.169.254",
  ]) {
    assert.throws(
      () => assertShroudUrlIsSafe(url),
      /plain HTTP/,
      `${url} would put the agent key on the wire in cleartext`,
    );
  }
});

test("https anywhere, and http to loopback, still work", () => {
  for (const url of [
    "https://shroud.1claw.co",
    "https://shroud.example.com",
    "http://127.0.0.1:8787",
    "http://127.3.2.1:8787",
    "http://localhost:3000",
    "http://[::1]:9000",
  ]) {
    assert.doesNotThrow(() => assertShroudUrlIsSafe(url), `${url} should be allowed`);
  }
});

test("a non-http scheme is refused rather than ignored", () => {
  for (const url of ["ftp://x/", "file:///etc/passwd", "not a url"]) {
    assert.throws(() => assertShroudUrlIsSafe(url));
  }
});

test("the agent credential is withheld from the child process", () => {
  // The names matter: missing one means that variable still reaches an agent
  // that can run `env`.
  for (const name of [
    "ONECLAW_AGENT_API_KEY",
    "ONECLAW_AGENT_ID",
    "ONECLAW_AGENT_TOKEN",
  ]) {
    assert.ok(
      CREDENTIALS_WITHHELD_FROM_AGENT.includes(name),
      `${name} must be stripped from the child environment`,
    );
  }
});

/**
 * The list being right is not the same as it being applied — deleting the
 * `for (... ) delete childEnv[k]` loop leaves the test above passing.
 */
test("run.ts actually deletes them from childEnv", () => {
  const src = readFileSync(new URL("../commands/run.ts", import.meta.url), "utf8");
  const spawnIdx = src.indexOf("const child = spawn(");
  const envIdx = src.indexOf("CREDENTIALS_WITHHELD_FROM_AGENT) delete childEnv");
  assert.ok(
    envIdx !== -1 && envIdx < spawnIdx,
    "childEnv must have the credentials deleted before the child is spawned",
  );
});
