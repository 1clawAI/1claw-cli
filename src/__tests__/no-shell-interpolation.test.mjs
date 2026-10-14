/**
 * Nothing variable may be interpolated into a shell string.
 *
 * Aikido flagged `execSync(cmdParts.join(" "))` in `configureClaudeCode` as
 * critical OS command injection. The finding was legitimate even though the
 * realistic exposure was small: the joined parts include `-e KEY=VALUE` pairs
 * carrying an agent API key that comes from a `--agent-key` flag or from an API
 * response, plus a socket path derived from the user-settable
 * `ONECLAW_CONFIG_DIR`. Our keys happen to be `ocv_` + base64url and our paths
 * happen to have no metacharacters — but that made the client's shell safety a
 * property of the server's output format, which is the wrong place for it.
 *
 * Two tests. The first is behavioural: build an entry whose env value is a
 * command substitution and prove it arrives as a single argv element, against
 * a stub `claude` on PATH rather than the real one. The second is structural: no
 * `execSync` anywhere in the CLI may take an argument that is not a literal
 * string, because that is the shape of the original defect.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/no-shell-interpolation.test.mjs
 */
import test from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, rmSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configureClient, buildMcpEntry } from "../../dist/src/ai-clients.js";

/** A value that would execute if it reached a shell. */
const CANARY = join(tmpdir(), `oneclaw-injection-canary-${process.pid}`);
const MALICIOUS = `x; touch ${CANARY}`;

test("a shell metacharacter in an env value reaches argv, not a shell", () => {
  rmSync(CANARY, { force: true });

  // A fake `claude` on PATH, so this never touches the real one.
  //
  // The previous version called whatever `claude` was installed and asserted
  // that a canary file did not appear. That is wrong in both directions. On a
  // machine without Claude Code -- CI, for instance -- `execFileSync` throws
  // ENOENT before any argument is examined, so the test passed while proving
  // nothing: it would have passed identically against `execSync` with a joined
  // string. On a machine with Claude Code, which is most developer machines
  // and is where this suite actually runs, it invoked the real binary and
  // rewrote the user's user-scope MCP configuration as a side effect, and the
  // canary did fire -- through the external tool's own handling of the value,
  // not through anything in this repository.
  //
  // So it was simultaneously vacuous where it ran clean and destructive where
  // it ran red, and in neither case was it measuring our code.
  //
  // What we actually care about is one property: the value is handed over as a
  // single argv element and never assembled into a command string. A stub that
  // records its own argv states that directly, needs nothing installed, and
  // cannot touch anything outside its temp directory.
  const binDir = mkdtempSync(join(tmpdir(), "oneclaw-fake-claude-"));
  const argvLog = join(binDir, "argv.json");
  writeFileSync(
    join(binDir, "claude"),
    `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    { mode: 0o755 },
  );

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;
  try {
    const entry = buildMcpEntry({ ONECLAW_AGENT_API_KEY: MALICIOUS });
    try {
      configureClient(
        { slug: "claude-code", name: "Claude Code", configFormat: "claude-code" },
        entry,
      );
    } catch {
      // ignore: the assertions are on the recorded argv and the filesystem
    }
  } finally {
    process.env.PATH = prevPath;
  }

  assert.ok(
    !existsSync(CANARY),
    `the injected command ran — ${CANARY} was created, so the value reached a shell`,
  );

  // The stub must actually have been called, or the assertion above is the
  // vacuous one all over again.
  assert.ok(
    existsSync(argvLog),
    "the fake claude was never invoked, so this test proved nothing about how arguments are passed",
  );

  const calls = readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const addCall = calls.find((c) => c.includes("add"));
  assert.ok(addCall, `no 'mcp add' call was recorded; got ${JSON.stringify(calls)}`);
  assert.ok(
    addCall.includes(`ONECLAW_AGENT_API_KEY=${MALICIOUS}`),
    "the env pair must arrive as ONE argv element with the metacharacters intact — " +
      "if it were split or quoted away, the value had been through a shell. " +
      `Got: ${JSON.stringify(addCall)}`,
  );
});

test("the CLI does not call execSync at all", () => {
  const srcDir = new URL("../", import.meta.url).pathname;
  const offenders = [];

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".ts")) {
        // Comments stripped first. The fix for this very defect explains itself
        // by quoting the old `execSync(cmdParts.join(" "))` call, and without
        // this the guard matches that prose and reports the thing it describes
        // as still present. Three guards wrote themselves this way today.
        const src = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "");
        // ANY `execSync` now, literal or not.
        //
        // This used to allow `execSync("literal")` on the reasoning that a
        // constant command cannot carry injected input, which is true. The
        // problem is enforceability: there were five such calls (four
        // `which X 2>/dev/null` plus a `git init`), so the rule a reader saw
        // was "execSync is allowed, sometimes" -- and the sometimes is exactly
        // where the next interpolated one lands, because it looks like the
        // neighbours.
        //
        // All five moved to `execFileSync` with an argv array, which never
        // reaches a shell, so the rule can now be absolute: no execSync in
        // src/, full stop. An absolute rule needs no judgement at the call
        // site and cannot be satisfied by a call that merely looks constant.
        for (const m of src.matchAll(/\bexecSync\s*\(/g)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${p.split("/").slice(-2).join("/")}:${line}: execSync(`);
        }
      }
    }
  };
  walk(srcDir);

  assert.deepStrictEqual(
    offenders,
    [],
    `execSync runs a shell. Use execFileSync(cmd, argv[]) instead, which does ` +
      `not. This ban is absolute rather than "no non-literal arguments": the ` +
      `allowed-literal version of this rule left five call sites that the next ` +
      `interpolated one would have blended into.\n${offenders.join("\n")}`,
  );
});
