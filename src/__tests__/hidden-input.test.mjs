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

test("hidden prompts do not echo and restore raw mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "1claw-hidden-input-"));
  const harness = join(dir, "prompt.mjs");
  const transcript = join(dir, "terminal.log");
  const fake = "FAKE_PASSWORD_FOR_PTY_TEST";

  try {
    writeFileSync(
      harness,
      `import { promptHiddenValue } from ${JSON.stringify(hiddenInput.href)};\n` +
        "await promptHiddenValue('Password:');\n" +
        "process.stderr.write(`RAW:${process.stdin.isRaw === true}\\n`);\n",
    );
    const command =
      `(sleep 0.2; printf ${shellQuote(fake)}; sleep 0.1; printf '\\r') | ` +
      `script -q -e -E never -c ${shellQuote(`node ${harness}`)} ${shellQuote(transcript)}`;
    try {
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" });
    } catch (error) {
      // The sandbox reports EPERM for a completed nested child process. The
      // transcript is still authoritative when it has a successful status.
      if (error?.status !== 0) throw error;
    }

    const output = readFileSync(transcript, "utf8");
    assert.ok(!output.includes(fake), "the typed value was echoed to the terminal");
    assert.match(output, /RAW:false/, "the prompt did not restore raw mode");
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
    const command =
      "(sleep 0.2; printf '\\003') | " +
      `script -q -e -E never -c ${shellQuote(`node ${harness}`)} ${shellQuote(transcript)}`;
    try {
      execFileSync("bash", ["-c", command], { cwd: root, stdio: "pipe" });
    } catch (error) {
      if (error?.status !== 0) throw error;
    }

    assert.match(readFileSync(transcript, "utf8"), /RAW:false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
