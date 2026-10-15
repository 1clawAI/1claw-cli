import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

/**
 * Step-up from the CLI: 1claw-cli#4.
 *
 * `agent update` carried 51 guardrail flags and no way to satisfy the
 * re-authentication the server requires for any of them, so every guardrail
 * edit failed with a 403 naming a header the CLI could not send. Two other
 * commands did support it, which made it read as an oversight rather than a
 * policy.
 */

const stepUp = readFileSync(new URL("../lib/step-up.ts", import.meta.url), "utf8");
const agent = readFileSync(new URL("../commands/agent.ts", import.meta.url), "utf8");
const middleware = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");

test("agent update can satisfy the step-up its flags require", () => {
  const start = agent.indexOf('.command("update <id>")');
  const end = agent.indexOf(".command(", start + 10);
  const block = agent.slice(start, end);
  assert.match(block, /--password-stdin/, "no way to supply the credential");
  assert.match(block, /resolveStepUp/, "the credential is never resolved");
  assert.match(block, /stepUpHeaders/, "the credential never reaches X-Auth-Confirm");
});

test("it asks the server first and only prompts when told to", () => {
  // Prompting whenever a guardrail flag appears would demand a password for
  // changes that do not need one, and train people to type it on reflex.
  const start = agent.indexOf('.command("update <id>")');
  const end = agent.indexOf(".command(", start + 10);
  const block = agent.slice(start, end);
  assert.match(block, /isStepUpRequired/, "must branch on the server's answer");
  const guardAt = block.indexOf("isStepUpRequired");
  const promptAt = block.indexOf("resolveStepUp({");
  assert.ok(guardAt > -1 && promptAt > guardAt, "the prompt must follow the 403, not precede it");
});

test("no command takes the password as a required argv flag", () => {
  // A password in argv is readable by every user on the machine via `ps` and
  // is written to shell history. `signing-keys import` used requiredOption,
  // so there was no way to avoid it.
  assert.ok(
    !/requiredOption\(\s*"--password/.test(agent),
    "a required --password flag forces the secret into the process list",
  );
});

test("every command that still accepts --password warns and offers stdin", () => {
  const occurrences = agent.match(/\.option\("--password <password>"[^)]*\)/g) ?? [];
  for (const o of occurrences) {
    assert.match(o, /DEPRECATED/, `--password should be marked deprecated: ${o}`);
  }
  const stdinFlags = (agent.match(/--password-stdin/g) ?? []).length;
  assert.ok(
    stdinFlags >= occurrences.length,
    `every --password command needs a --password-stdin alternative (${occurrences.length} vs ${stdinFlags})`,
  );
});

test("it fails closed with no TTY instead of hanging or downgrading", () => {
  // In CI there is nobody to prompt. Blocking on a question nobody answers is
  // worse than failing, and quietly proceeding without the credential would
  // be worse still.
  // The specific guard, not merely the substring: `isTTY` also appears in the
  // setRawMode calls, so grepping for it passed even with the CI branch
  // deleted. Caught by falsifying this test rather than by reading it.
  assert.match(
    stepUp,
    /if\s*\(!process\.stdin\.isTTY\)\s*{/,
    "must refuse rather than prompt when there is no terminal",
  );
  assert.match(
    stepUp,
    /no terminal to ask on/,
    "the CI failure must say what to do, not just refuse",
  );
  assert.match(stepUp, /--password-stdin/, "the CI message must name the alternative");
});

test("the step-up prompt uses the shared hidden-input helper", () => {
  assert.match(stepUp, /promptHiddenValue\(label\)/);
});

test("a plain permission 403 is not mistaken for a step-up", () => {
  // Telling someone to re-enter their password for an ordinary authorization
  // failure sends them on a wild goose chase.
  assert.match(stepUp, /status !== 403/);
  assert.match(stepUp, /requires re-authentication|x-auth-confirm/i);
});

test("an unhandled step-up 403 still tells the reader what to do", () => {
  assert.match(middleware, /isStepUpRequired/, "handleError must recognise it");
  assert.match(middleware, /password-stdin/, "and name the way to satisfy it");
});
