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
 * command substitution and prove nothing runs. The second is structural: no
 * `execSync` anywhere in the CLI may take an argument that is not a literal
 * string, because that is the shape of the original defect.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/no-shell-interpolation.test.mjs
 */
import test from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { configureClient, buildMcpEntry } from "../../dist/src/ai-clients.js";

/** A value that would execute if it reached a shell. */
const CANARY = join(tmpdir(), `oneclaw-injection-canary-${process.pid}`);
const MALICIOUS = `x; touch ${CANARY}`;

test("a shell metacharacter in an env value does not execute", () => {
  rmSync(CANARY, { force: true });

  const entry = buildMcpEntry({ ONECLAW_AGENT_API_KEY: MALICIOUS });
  // `claude` is almost certainly not installed here, and that is fine: the
  // point is that the attempt does not run the canary either way. A thrown
  // ENOENT is a pass; a created file is the vulnerability.
  try {
    configureClient(
      { slug: "claude-code", name: "Claude Code", configFormat: "claude-code" },
      entry,
    );
  } catch {
    // ignore: we are asserting on the filesystem, not the return value
  }

  assert.ok(
    !existsSync(CANARY),
    `the injected command ran — ${CANARY} was created, so the value reached a shell`,
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
