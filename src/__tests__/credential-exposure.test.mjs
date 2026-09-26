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

import { mkdtempSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentialFile } from "../../dist/src/ai-clients.js";
import { CAPTURE_SECRET_PATTERN } from "../../dist/src/commands/proxy.js";

/**
 * CLIKEYFILE-L1. These files hold the agent key in plaintext. They were
 * written with the default mode (0644 under a typical umask), and the
 * temp-file + `renameSync` dance replaces a symlink rather than following it
 * — silently discarding a stricter mode the user had set.
 */
test("a credential file is written 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-keyfile-"));
  const p = join(dir, "config.json");
  writeCredentialFile(p, '{"ok":true}\n');

  const mode = statSync(p).mode & 0o777;
  assert.strictEqual(
    mode.toString(8),
    "600",
    `the agent key must not be group- or world-readable, got 0${mode.toString(8)}`,
  );
  assert.strictEqual(readFileSync(p, "utf8"), '{"ok":true}\n');
});

test("an existing file's permissions are tightened, not inherited", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-keyfile-"));
  const p = join(dir, "config.json");
  writeFileSync(p, "{}", { mode: 0o644 });

  writeCredentialFile(p, '{"new":true}\n');
  assert.strictEqual((statSync(p).mode & 0o777).toString(8), "600");
});

test("writing the key through a symlink is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-keyfile-"));
  const real = join(dir, "elsewhere.json");
  const link = join(dir, "config.json");
  writeFileSync(real, "{}");
  symlinkSync(real, link);

  assert.throws(
    () => writeCredentialFile(link, '{"pwned":true}\n'),
    /symlink/i,
    "a symlinked config must not be written through",
  );
  assert.strictEqual(readFileSync(real, "utf8"), "{}", "the target must be untouched");
});

/**
 * CLIREDACT-L1. `--capture-dir` wrote "(redacted)" captures that become
 * committed fixtures, while the pattern missed most real key shapes: the
 * charset excluded `-`, so `sk-ant-…`, `sk-proj-…` and `sk-shroud-v1-…` never
 * matched, `AIza…` was absent entirely, and `ocv_abc-def` was truncated at
 * the hyphen — leaving the tail in the file.
 */
test("every real key shape is redacted, and redacted whole", () => {
  for (const key of [
    "sk-ant-api03-AbCdEf0123456789XyZ_-abcdef",
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    "sk-shroud-v1-abcdefghijklmnop0123456789",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
    "ocv_abc-def_ghi123456",
    "1ck_live-abcdef123456",
    "plt_abc_def-123",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
  ]) {
    CAPTURE_SECRET_PATTERN.lastIndex = 0;
    const out = `prefix ${key} suffix`.replace(CAPTURE_SECRET_PATTERN, "[REDACTED]");
    assert.strictEqual(
      out,
      "prefix [REDACTED] suffix",
      `${key} must be redacted in full — a partial redaction still leaks the tail`,
    );
  }
});

test("ordinary text is not mangled by the redactor", () => {
  for (const text of [
    "model: claude-opus-5",
    "please summarise this-document_now",
    "sk-short",
    "",
  ]) {
    CAPTURE_SECRET_PATTERN.lastIndex = 0;
    assert.strictEqual(text.replace(CAPTURE_SECRET_PATTERN, "[REDACTED]"), text, text);
  }
});
