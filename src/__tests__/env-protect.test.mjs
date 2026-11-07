/**
 * `1claw ignore`, `1claw env import` and `--credential-from-env`: env values
 * go from a file to the vault without ever appearing in output.
 *
 * The end-to-end tests run the real CLI against a mock vault and fail if a
 * sentinel value shows up in anything an agent would see: stdout, stderr, or a
 * file left on disk.
 *
 * Runs against `dist/`, so `npm run build` first.
 * Run: node --test src/__tests__/env-protect.test.mjs
 */
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { parseEnv, seal, open, isRealEnvFile, newDataKey } from "../../dist/src/lib/env-file.js";
import { writeAgent, upsertBlock, agentHasRules, claudeDenyRules } from "../../dist/src/lib/agent-ignore.js";
import { routeImport } from "../../dist/src/commands/env.js";
import { credentialFromValue } from "../../dist/src/commands/binding.js";

const CLI = resolve("dist/bin/1claw.js");

// --- parser ---------------------------------------------------------------------

test("parseEnv reads dotenv syntax", () => {
  const entries = parseEnv(
    [
      "# comment",
      "export A=1",
      'B="two words # not a comment"',
      "C=plain # a comment",
      "D='single $NOT_EXPANDED'",
      'E="line1\\nline2"',
      'PEM="-----BEGIN-----',
      "abc",
      '-----END-----"',
      "lower_case=ok",
      "=nokey",
      "",
    ].join("\n"),
  );
  const m = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(m.A, "1");
  assert.equal(m.B, "two words # not a comment");
  assert.equal(m.C, "plain");
  assert.equal(m.D, "single $NOT_EXPANDED");
  assert.equal(m.E, "line1\nline2");
  assert.equal(m.PEM, "-----BEGIN-----\nabc\n-----END-----");
  assert.equal(m.lower_case, "ok");
  assert.equal(entries.length, 7);
});

test("templates are not real env files; real ones are", () => {
  for (const n of [".env", ".env.local", ".env.production", "app.env"]) assert.ok(isRealEnvFile(n), n);
  for (const n of [".env.example", ".env.local.example", ".env.sample", ".env.template", ".env.1claw", "env.ts"])
    assert.ok(!isRealEnvFile(n), n);
});

// --- envelope -----------------------------------------------------------------------

test("seal/open round-trips and keeps only names in the clear", () => {
  const secret = "sk-" + randomBytes(16).toString("hex");
  const { key, path } = newDataKey();
  const env = seal(`API_KEY=${secret}\nPORT=3000\n`, key, ".env", { vault_id: "v1", path });
  assert.deepEqual(env.names, ["API_KEY", "PORT"]);
  assert.ok(!JSON.stringify(env).includes(secret), "ciphertext must not contain the value");
  assert.equal(open(env, key), `API_KEY=${secret}\nPORT=3000\n`);
});

test("an envelope re-pointed at another key reference does not decrypt", () => {
  const { key, path } = newDataKey();
  const env = seal("A=1\n", key, ".env", { vault_id: "v1", path });
  assert.throws(() => open({ ...env, key: { vault_id: "v2", path } }, key));
});

// --- agent rules ---------------------------------------------------------------------

test("agent rules are written once and re-runs change nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignore-"));
  writeFileSync(join(dir, ".cursorignore"), "node_modules\n");
  writeFileSync(join(dir, ".claude-placeholder"), "");
  for (const a of ["claude", "cursor", "opencode", "gemini"]) {
    assert.equal(writeAgent(dir, a, [".env.mainnet"]).changed, true, a);
    assert.equal(writeAgent(dir, a, [".env.mainnet"]).changed, false, `${a} second run`);
    assert.ok(agentHasRules(dir, a), a);
  }
  assert.ok(readFileSync(join(dir, ".cursorignore"), "utf8").startsWith("node_modules\n"), "existing lines kept");
  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  assert.ok(settings.permissions.deny.includes("Read(**/.env.mainnet)"), "present files are named");
});

test("Claude deny rules never cover .env.example (deny beats allow there)", () => {
  for (const r of claudeDenyRules([".env.local"])) assert.ok(!r.includes("example") && !r.includes(".env.*"), r);
});

test("OpenCode: denies come after existing rules, template allow after the denies", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignore-"));
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "x", permission: { read: { "*.env.example": "allow", "*": "ask" } } }));
  writeAgent(dir, "opencode", []);
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.model, "x");
  assert.deepEqual(Object.keys(cfg.permission.read), ["*", "*.env", "*.env.*", "*.env.example", "*.1claw"]);
  assert.equal(cfg.permission.read["*.env"], "deny");
});

test("the marked block is replaced, not duplicated", () => {
  const dir = mkdtempSync(join(tmpdir(), "ignore-"));
  const f = join(dir, ".geminiignore");
  upsertBlock(f, ["a"]);
  upsertBlock(f, ["b"]);
  const text = readFileSync(f, "utf8");
  assert.equal(text.match(/>>> 1claw ignore >>>/g).length, 1);
  assert.ok(text.includes("\nb\n") && !text.includes("\na\n"));
});

// --- routing and credentials -----------------------------------------------------------

test("routeImport: env by default, secrets on request, plan wins, bad names skipped", () => {
  const routes = routeImport(["DATABASE_URL", "STRIPE_KEY", "lower", "DEBUG", "X"], {
    environments: ["production"],
    secrets: ["STRIPE_KEY"],
    secretPrefix: "bindings/",
    skip: ["DEBUG"],
    only: [],
    plan: { vars: { X: { to: "secret", path: "custom/x" } } },
  });
  const by = Object.fromEntries(routes.map((r) => [r.key, r]));
  assert.equal(by.DATABASE_URL.to, "env");
  assert.equal(by.DATABASE_URL.sensitive, true);
  assert.equal(by.STRIPE_KEY.path, "bindings/STRIPE_KEY");
  assert.equal(by.lower.to, "skip");
  assert.equal(by.DEBUG.to, "skip");
  assert.equal(by.X.path, "custom/x");
});

test("development-only env vars are not marked sensitive (the API refuses that)", () => {
  const [r] = routeImport(["A"], { environments: ["development"], secrets: [], secretPrefix: "b", skip: [], only: [] });
  assert.equal(r.sensitive, false);
});

test("credentialFromValue follows the vault's injection shapes", () => {
  assert.deepEqual(credentialFromValue("t", "http", undefined), { token: "t" });
  assert.deepEqual(credentialFromValue("t", "http", { auth_type: "header", auth_header: "X-Key" }), { value: "t" });
  assert.throws(() => credentialFromValue("t", "postgres", undefined));
  assert.throws(() => credentialFromValue("t", "http", { auth_type: "basic" }));
});

// --- end to end against a mock vault ----------------------------------------------------

const AGENT_KEY = "ocv_appkey_SENTINEL";
const AGENT_JWT = "agent-jwt";

function mockVault() {
  const secrets = new Map();
  const envVars = new Map();
  const bindings = [];
  const vaults = [{ id: "v0", name: "someone-elses" }];
  const policies = [];
  const agents = [];
  const revoked = { value: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const json = body ? JSON.parse(body) : {};
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj ?? {}));
      };
      let m;
      if ((m = url.pathname.match(/^\/v1\/vaults\/([^/]+)\/secrets\/(.+)$/))) {
        const path = decodeURIComponent(m[2]);
        if (req.method === "PUT") {
          secrets.set(path, json);
          return send(200, { path });
        }
        if (req.method === "DELETE") { secrets.delete(path); return send(200, {}); }
        if (req.method === "GET") return secrets.has(path) ? send(200, { path, ...secrets.get(path) }) : send(404, { detail: "nf" });
      }
      if (url.pathname.match(/^\/v1\/vaults\/[^/]+\/secrets$/)) return send(200, { secrets: [...secrets.keys()].map((path) => ({ path })) });
      if (url.pathname.match(/^\/v1\/vaults\/[^/]+\/env-vars$/)) {
        if (req.method === "GET") return send(200, { env_vars: [...envVars.values()] });
        envVars.set(json.key, json);
        return send(201, json);
      }
      if (url.pathname === "/v1/vaults") {
        if (req.method === "POST") { vaults.push({ id: `v${vaults.length + 1}`, name: json.name }); return send(201, vaults.at(-1)); }
        return send(200, { vaults });
      }
      if (url.pathname.match(/^\/v1\/vaults\/[^/]+\/policies$/)) {
        if (req.method === "POST") { policies.push(json); return send(201, json); }
        return send(200, { policies });
      }
      if (url.pathname === "/v1/agents") {
        if (req.method === "POST") { agents.push({ id: "a1", name: json.name, body: json }); return send(201, { agent: { id: "a1", name: json.name }, api_key: AGENT_KEY }); }
        return send(200, { agents });
      }
      if (url.pathname === "/v1/auth/agent-token") {
        return json.api_key === AGENT_KEY && !revoked.value ? send(200, { access_token: AGENT_JWT, expires_in: 900 }) : send(401, { detail: "bad key" });
      }
      if ((m = url.pathname.match(/^\/v1\/vaults\/[^/]+\/env-vars\/([^/]+)$/)) && m[1] !== "resolve") {
        const key = decodeURIComponent(m[1]);
        if (req.method === "DELETE") { envVars.delete(key); return send(200, {}); }
        if (req.method === "PATCH") {
          if (envVars.get(key)?.sensitive && json.sensitive === false) return send(400, { detail: "cannot make a sensitive var readable" });
          envVars.set(key, { ...envVars.get(key), ...json });
          return send(200, envVars.get(key));
        }
      }
      if (url.pathname.match(/^\/v1\/vaults\/[^/]+\/env-vars\/resolve$/)) {
        if (req.headers.authorization !== `Bearer ${AGENT_JWT}`) return send(403, { detail: "not the agent" });
        return send(200, { vars: Object.fromEntries([...envVars.values()].map((v) => [v.key, v.value])) });
      }
      if (url.pathname.match(/^\/v1\/agents\/[^/]+$/) && req.method === "PATCH") { revoked.value = json.is_active === false; return send(200, {}); }
      if (url.pathname.match(/^\/v1\/agents\/[^/]+\/bindings$/) && req.method === "GET") return send(200, { bindings });
      if ((m = url.pathname.match(/^\/v1\/vaults\/([^/]+)\/secrets\/(.+)$/)) && req.method === "DELETE") { secrets.delete(decodeURIComponent(m[2])); return send(200, {}); }
      if ((m = url.pathname.match(/^\/v1\/agents\/([^/]+)\/bindings$/)) && req.method === "POST") {
        bindings.push(json);
        return send(201, { id: "b1", name: json.name, binding_type: json.binding_type, credential_set: true });
      }
      send(404, { detail: `mock: ${req.method} ${url.pathname}` });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, secrets, envVars, bindings, vaults, policies, agents, revoked, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(args, cwd, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env, CLAUDECODE: "1", NO_COLOR: "1" } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, out: stdout + stderr }),
    );
  });
}

test("ignore → env import → binding: no value ever reaches output or disk in the clear", async () => {
  const vault = await mockVault();
  const dir = mkdtempSync(join(tmpdir(), "e2e-"));
  const STRIPE = "sk_live_" + randomBytes(12).toString("hex");
  const DB = "postgres://u:" + randomBytes(12).toString("hex") + "@db/x";
  writeFileSync(join(dir, ".env"), `STRIPE_KEY=${STRIPE}\nDATABASE_URL="${DB}"\nPORT=3000\n`);
  writeFileSync(join(dir, ".env.example"), "STRIPE_KEY=\nDATABASE_URL=\nPORT=3000\n");
  const env = { ONECLAW_API_URL: vault.url, ONECLAW_TOKEN: "test-token", ONECLAW_VAULT_ID: "vault-1", HOME: dir };
  const leaks = (text) => text.includes(STRIPE) || text.includes(DB);

  try {
    const ignored = await run(["ignore"], dir, env);
    assert.equal(ignored.code, 0, ignored.out);
    assert.ok(!leaks(ignored.out), "ignore printed a value");
    assert.ok(!existsSync(join(dir, ".env")), "plaintext removed");
    assert.ok(existsSync(join(dir, ".env.example")), "template left alone");
    assert.ok(!leaks(readFileSync(join(dir, ".env.1claw"), "utf8")), "envelope holds ciphertext only");
    assert.ok(readFileSync(join(dir, ".cursorignore"), "utf8").includes(".env.*"));
    assert.ok(JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")).permissions.deny.includes("Read(**/.env)"));

    const imported = await run(["env", "import", "--secrets", "STRIPE_KEY"], dir, env);
    assert.equal(imported.code, 0, imported.out);
    assert.ok(!leaks(imported.out), "import printed a value");
    assert.equal(vault.envVars.get("DATABASE_URL").value, DB, "env var reached the vault intact");
    assert.equal(vault.envVars.get("DATABASE_URL").sensitive, true);
    assert.equal(vault.secrets.get("bindings/STRIPE_KEY").value, STRIPE, "binding secret reached the vault");
    assert.ok(!vault.envVars.has("STRIPE_KEY"), "secret-routed key is not also an env var");

    const bound = await run(
      ["agent", "binding", "create", "agent-1", "--name", "stripe", "--type", "http",
       "--config", '{"base_url":"https://api.stripe.com"}', "--guardrails", '{"allowed_hosts":["api.stripe.com"]}',
       "--credential-from-env", "STRIPE_KEY"],
      dir, env,
    );
    assert.equal(bound.code, 0, bound.out);
    assert.ok(!leaks(bound.out), "binding create printed a value");
    assert.deepEqual(vault.bindings[0].credential, { token: STRIPE });

    const restore = await run(["ignore", "restore", "--yes"], dir, env);
    assert.notEqual(restore.code, 0, "restore must refuse to run for an agent");
    assert.ok(!existsSync(join(dir, ".env")));
  } finally {
    vault.server.close();
  }
});

// --- binding proxy: the vault's execute route wants the agent JWT, not the ocv_ key ---

import { agentJwtSource, acceptProxyToken } from "../../dist/src/commands/binding-proxy.js";

test("the binding proxy exchanges the agent key once and reuses the JWT until near expiry", async () => {
  const calls = [];
  const jwt = agentJwtSource("agent-1", "ocv_test", async (id, key) => {
    calls.push([id, key]);
    return { access_token: `jwt-${calls.length}`, expires_in: 900 };
  });
  assert.equal(await jwt(), "jwt-1");
  assert.equal(await jwt(), "jwt-1");
  assert.deepEqual(calls, [["agent-1", "ocv_test"]]);
});

test("a JWT about to expire is renewed", async () => {
  let n = 0;
  const jwt = agentJwtSource("a", "k", async () => ({ access_token: `jwt-${++n}`, expires_in: 0 }));
  assert.equal(await jwt(), "jwt-1");
  assert.equal(await jwt(), "jwt-2");
});

test("the whole app: ignore makes the vault, the plan does the rest, env run starts on the agent key alone", async () => {
  const vault = await mockVault();
  const dir = mkdtempSync(join(tmpdir(), "oracle-"));
  const cfg = mkdtempSync(join(tmpdir(), "cfg-"));
  const API = "sk_live_APP_SENTINEL", DB = "postgres://SENTINEL_DB";
  writeFileSync(join(dir, ".env"), `PORT=3000\nX_URL=https://api.example.com\nX_KEY=${API}\nDATABASE_URL=${DB}\n`);
  const human = { ONECLAW_API_URL: vault.url, ONECLAW_TOKEN: "human", ONECLAW_CONFIG_DIR: cfg };
  try {
    // No vault and no terminal: it stops, says what to do, and changes nothing.
    const stopped = await run(["ignore"], dir, human);
    assert.notStrictEqual(stopped.code, 0);
    assert.match(stopped.out, /--yes/);
    assert.ok(existsSync(join(dir, ".env")) && !existsSync(join(dir, ".claude")), "changed the project before failing");

    const ignored = await run(["ignore", "--yes"], dir, human);
    assert.strictEqual(ignored.code, 0, ignored.out);
    const project = JSON.parse(readFileSync(join(dir, ".1claw/project.json"), "utf8"));
    assert.strictEqual(vault.vaults.at(-1).id, project.vault_id);
    assert.strictEqual(vault.vaults.at(-1).name, dir.split("/").at(-1));

    writeFileSync(join(dir, "plan.json"), JSON.stringify({
      app: { name: "oracle" },
      vars: {
        PORT: { to: "env", sensitive: false },
        X_KEY: { to: "binding", binding: { name: "x", base_url: "https://api.example.com", url_env: "X_URL" } },
      },
    }));
    const applied = await run(["env", "import", "--plan", "plan.json"], dir, human);
    assert.strictEqual(applied.code, 0, applied.out);
    for (const leak of [API, DB, AGENT_KEY]) assert.ok(!applied.out.includes(leak), `printed ${leak}`);

    // One line of access, readable only by this user; the encrypted file and its key are gone.
    assert.strictEqual(readFileSync(join(dir, ".env"), "utf8"), `ONECLAW_AGENT_API_KEY=${AGENT_KEY}\n`);
    assert.strictEqual(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    assert.ok(!existsSync(join(dir, ".env.1claw")));
    assert.strictEqual(vault.secrets.size, 0);
    assert.deepStrictEqual([...vault.envVars.keys()].sort(), ["DATABASE_URL", "PORT"]);
    assert.strictEqual(vault.bindings[0].name, "x");
    assert.deepStrictEqual(vault.bindings[0].guardrails.allowed_hosts, ["api.example.com"]);
    assert.deepStrictEqual(vault.bindings[0].credential, { token: API });
    assert.strictEqual(vault.policies[0].secret_path_pattern, "**");

    // Running ignore again must leave the access key alone: encrypting it would stop the app starting.
    const again = await run(["ignore"], dir, human);
    assert.strictEqual(again.code, 0, again.out);
    assert.ok(existsSync(join(dir, ".env")) && !existsSync(join(dir, ".env.1claw")));

    // No personal login at all: only the agent key in .env.
    const noLogin = { ONECLAW_API_URL: vault.url, ONECLAW_CONFIG_DIR: mkdtempSync(join(tmpdir(), "empty-")), ONECLAW_TOKEN: "" };
    const child = 'const e=process.env;console.log(JSON.stringify({db:e.DATABASE_URL===process.argv[1],url:e.X_URL,key:e.X_KEY,agent:!!e.ONECLAW_AGENT_API_KEY,token:!!e.ONECLAW_TOKEN}))';
    const started = await run(["env", "run", "--", process.execPath, "-e", child, DB], dir, noLogin);
    assert.strictEqual(started.code, 0, started.out);
    const seen = JSON.parse(started.out.split("\n").find((l) => l.startsWith("{")));
    assert.strictEqual(seen.db, true);
    assert.match(seen.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(seen.key && seen.key !== API, "the app got the real API key");
    assert.strictEqual(seen.agent, false);
    assert.strictEqual(seen.token, false);

    // Revoke cuts it off; restore brings it back.
    assert.strictEqual((await run(["revoke"], dir, human)).code, 0);
    const refused = await run(["env", "run", "--", process.execPath, "-e", "console.log('RAN')"], dir, noLogin);
    assert.notStrictEqual(refused.code, 0);
    assert.match(refused.out, /refused/);
    assert.ok(!refused.out.includes("RAN"));
    assert.strictEqual((await run(["restore"], dir, human)).code, 0);
    assert.strictEqual((await run(["env", "run", "--", process.execPath, "-e", "0"], dir, noLogin)).code, 0);
  } finally {
    vault.server.close();
  }
});

test("a variable the plan leaves out keeps the encrypted file", async () => {
  const vault = await mockVault();
  const dir = mkdtempSync(join(tmpdir(), "keep-"));
  const cfg = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, ".env"), "A=1\nB=2\n");
  const human = { ONECLAW_API_URL: vault.url, ONECLAW_TOKEN: "human", ONECLAW_CONFIG_DIR: cfg };
  try {
    await run(["ignore", "--yes"], dir, human);
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ app: { name: "keep" }, vars: { B: { to: "skip" } } }));
    const out = await run(["env", "import", "--plan", "plan.json"], dir, human);
    assert.strictEqual(out.code, 0, out.out);
    assert.ok(existsSync(join(dir, ".env.1claw")), "deleted a file that still held B");
    assert.match(out.out, /still holds B/);
  } finally {
    vault.server.close();
  }
});

test("a vault that already has these vars: the run still finishes, and no copy of the binding's key stays behind", async () => {
  const vault = await mockVault();
  const dir = mkdtempSync(join(tmpdir(), "again-"));
  const cfg = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, ".env"), "PORT=3000\nX_URL=https://api.example.com\nX_KEY=NEWKEY\n");
  const human = { ONECLAW_API_URL: vault.url, ONECLAW_TOKEN: "human", ONECLAW_CONFIG_DIR: cfg };
  try {
    await run(["ignore", "--yes"], dir, human);
    for (const key of ["PORT", "X_URL", "X_KEY"]) vault.envVars.set(key, { key, value: "old", environments: ["production"], sensitive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify({
      app: { name: "again" },
      vars: {
        PORT: { to: "env", sensitive: false },
        X_KEY: { to: "binding", binding: { name: "x", base_url: "https://api.example.com", url_env: "X_URL" } },
      },
    }));
    const out = await run(["env", "import", "--plan", "plan.json"], dir, human);
    assert.strictEqual(out.code, 0, out.out);
    assert.ok(!out.out.includes("failed"), out.out);
    assert.deepStrictEqual([...vault.envVars.keys()], ["PORT"]);
    assert.strictEqual(vault.envVars.get("PORT").value, "3000");
    assert.ok(!existsSync(join(dir, ".env.1claw")), "the encrypted file should be gone");
  } finally {
    vault.server.close();
  }
});

test("env names: lists names and where they're used, masks hardcoded secrets, never reads a real env file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "names-"));
  const SENTINEL = "REAL_VALUE_SENTINEL_12345678", LITERAL = "abcdefghij0123456789abcdefghij";
  writeFileSync(join(dir, ".env"), `DB=${SENTINEL}\nONLY_IN_REAL_ENV=${SENTINEL}\n`);
  writeFileSync(join(dir, ".env.example"), `# Where the sessions live\nDB=${SENTINEL}\n`);
  writeFileSync(join(dir, "a.js"), `const k = process.env.API_KEY || "${LITERAL}";\nconst { DB, PORT } = process.env;\nnew Pool({ url: DB });\nfunction need2(n) { return process.env[n]; }\nneed2("HELPED");\n`);
  const out = await run(["env", "names", "--json", join(dir, "r.json")], dir, {});
  assert.strictEqual(out.code, 0, out.out);
  assert.ok(!out.out.includes(SENTINEL) && !out.out.includes(LITERAL), "printed a value");
  assert.ok(!readFileSync(join(dir, "r.json"), "utf8").includes(SENTINEL));
  const r = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(r.names), ["API_KEY", "DB", "HELPED", "PORT"]);
  assert.strictEqual(r.names.API_KEY.hardcoded_fallback, true);
  assert.ok(r.names.DB.signals.includes("database connection"));
  assert.strictEqual(r.names.DB.hint, "Where the sessions live");
  assert.deepStrictEqual(r.real_env_files_not_read, [".env"]);
});

test("the skill: an agent running ignore never installs it; install-skill does; it ships complete", async () => {
  const vault = await mockVault();
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  writeFileSync(join(dir, ".env"), "A=1\n");
  const human = { ONECLAW_API_URL: vault.url, ONECLAW_TOKEN: "human", ONECLAW_CONFIG_DIR: mkdtempSync(join(tmpdir(), "cfg-")) };
  try {
    const ignored = await run(["ignore", "--yes"], dir, human);
    assert.strictEqual(ignored.code, 0, ignored.out);
    assert.ok(!existsSync(join(dir, ".claude/skills")), "installed without asking");
    assert.match(ignored.out, /install-skill/);
    assert.strictEqual((await run(["ignore", "install-skill"], dir, human)).code, 0);
    const skill = join(dir, ".claude/skills/env-to-1claw");
    assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /^---\nname: env-to-1claw/);
    assert.ok(existsSync(join(skill, "reference/classify.md")) && existsSync(join(skill, "templates/proposal.md")));
    assert.ok(!readFileSync(join(skill, "SKILL.md"), "utf8").includes("env_names.py"));
    assert.ok(existsSync(join(dir, ".claude/settings.json")), "kept the agent rules");
  } finally {
    vault.server.close();
  }
});

test("env names: a destructure across lines counts as code, with its lines, and comments and defaults aren't names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multi-"));
  writeFileSync(join(dir, "a.js"), [
    "// header",
    "const {",
    '  PORT = "3000",',
    '  SOCK_URL = "https://example.com/some/path",',
    "  API_KEY, // the API key NEVER_A_NAME",
    '  RENAMED: localName,',
    '  TOKEN = "abcdefghij0123456789abcdefghij",',
    "  /* BLOCK_COMMENT */ DB_URL,",
    "} = process.env;",
    "new Pool({ url: DB_URL });",
    "",
  ].join("\n"));
  const out = await run(["env", "names", "--json", join(dir, "r.json")], dir, {});
  assert.strictEqual(out.code, 0, out.out);
  const r = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(r.names), ["API_KEY", "DB_URL", "PORT", "RENAMED", "SOCK_URL", "TOKEN"]);
  assert.ok(r.names.API_KEY.in_code);
  assert.match(r.names.API_KEY.uses[0], /^a\.js:5 /);
  assert.ok(r.names.DB_URL.signals.includes("database connection"));
  assert.strictEqual(r.names.PORT.default_literal, true);
  assert.strictEqual(r.names.SOCK_URL.url_fallback, true);
  assert.strictEqual(r.names.TOKEN.hardcoded_fallback, true);
  assert.ok(!JSON.stringify(r).includes("abcdefghij0123456789"), "printed a literal");
});

test("the proxy token works as a bearer, any vendor header or a query parameter, and never travels upstream", () => {
  const T = "proxy-abc123";
  assert.strictEqual(acceptProxyToken({ authorization: `Bearer ${T}` }, "/a?x=1", T), "/a?x=1");
  assert.strictEqual(acceptProxyToken({ "x-index-key": T }, "/price", T), "/price");
  assert.strictEqual(acceptProxyToken({}, "/geocode?q=Lisbon&key=" + T, T), "/geocode?q=Lisbon");
  assert.strictEqual(acceptProxyToken({ "x-index-key": "wrong" }, "/price?key=nope", T), null);
  assert.strictEqual(acceptProxyToken({}, "/price", T), null);
});
