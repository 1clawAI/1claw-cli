import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const hiddenInput = new URL("../../dist/src/lib/hidden-input.js", import.meta.url);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

/**
 * Run `inner` (a shell command) under a real pseudo-terminal, recording what
 * the terminal displays to `transcript`.
 *
 * `script` takes different arguments on util-linux and BSD/macOS, and these
 * tests run on both: CI is Linux, and maintainers run them on macOS, where the
 * util-linux spelling (`-c`, `-e`, `-E never`) is a usage error and the test
 * failed before it looked at anything.
 */
function underPty(keys, inner, transcript) {
  const scriptCmd =
    process.platform === "linux"
      ? `script -q -e -E never -c ${shellQuote(inner)} ${shellQuote(transcript)}`
      : `script -q ${shellQuote(transcript)} sh -c ${shellQuote(inner)}`;
  try {
    execFileSync("bash", ["-c", `${keys} | ${scriptCmd}`], { cwd: root, stdio: "pipe" });
  } catch (error) {
    // The sandbox reports EPERM for a completed nested child process. The
    // transcript is still authoritative when it has a successful status.
    if (error?.status !== 0) throw error;
  }
}

test("hidden prompts do not echo, keep stdout clean, and restore raw mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-hidden-input-"));
  const harness = join(dir, "prompt.mjs");
  const transcript = join(dir, "terminal.log");
  const stdoutFile = join(dir, "stdout.txt");
  const fake = "FAKE_PASSWORD_FOR_PTY_TEST";

  try {
    writeFileSync(
      harness,
      `import { promptHiddenValue } from ${JSON.stringify(hiddenInput.href)};\n` +
        "const v = await promptHiddenValue('Password:');\n" +
        "process.stdout.write(`LEN:${v.length}\\n`);\n" +
        "process.stderr.write(`RAW:${process.stdin.isRaw === true}\\n`);\n",
    );
    underPty(
      `(sleep 1; printf ${shellQuote(fake)}; sleep 0.3; printf '\\r')`,
      `node ${harness} > ${stdoutFile}`,
      transcript,
    );

    const screen = readFileSync(transcript, "utf8");
    assert.ok(!screen.includes(fake), "the typed value was echoed to the terminal");
    assert.match(screen, /Password:/, "the prompt must be visible on the terminal");
    assert.match(screen, /RAW:false/, "the prompt did not restore raw mode");

    // Stdout is data. `KEY=$(1claw …)` and `1claw … | jq` capture it, so the
    // prompt, its mask and its redraw codes must not be there; on stdout they
    // corrupt the captured value and hide the question from the person typing.
    const out = readFileSync(stdoutFile, "utf8");
    assert.equal(out, `LEN:${fake.length}\n`, `stdout carried prompt output: ${JSON.stringify(out)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("step-up fails closed without a terminal", async () => {
  const { resolveStepUp } = await import("../../dist/src/lib/step-up.js");
  await assert.rejects(
    resolveStepUp({ action: "change a guardrail" }),
    /no terminal to ask on[\s\S]*--password-stdin/,
  );
});

test("hidden prompts restore raw mode after Ctrl+C", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-hidden-input-cancel-"));
  const harness = join(dir, "cancel.mjs");
  const transcript = join(dir, "terminal.log");

  try {
    writeFileSync(
      harness,
      `import { promptHiddenValue } from ${JSON.stringify(hiddenInput.href)};\n` +
        "try { await promptHiddenValue('Password:'); } catch {}\n" +
        "process.stderr.write(`RAW:${process.stdin.isRaw === true}\\n`);\n",
    );
    underPty("(sleep 1; printf '\\003')", `node ${harness}`, transcript);

    assert.match(readFileSync(transcript, "utf8"), /RAW:false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret set --stdin reads the stream even on a terminal", () => {
  // A password prompt ends at the first newline. Routing an explicit --stdin
  // through it would store the first line of a pasted PEM key and nothing
  // else, silently.
  const src = readFileSync(new URL("../commands/secret.ts", import.meta.url), "utf8");
  assert.match(src, /process\.stdin\.isTTY && !explicitStdin/);
  assert.equal(
    (src.match(/readSecretValue\(Boolean\(opts\.stdin\)\)/g) ?? []).length,
    2,
    "both secret commands must pass the flag through",
  );
});
