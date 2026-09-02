#!/usr/bin/env node
// Copyright (C) 2026 1Claw
//
// The local vault's key derivation, and the upgrade path off the weak one.
//
// v1 used PBKDF2-SHA256 at 100k iterations. This file sits on a laptop and its
// whole security is the passphrase, so the cost of one guess is the only thing
// between someone holding the file and every secret in it — and 100k SHA-256
// rounds is a few milliseconds on a GPU. v2 uses scrypt at N=2^17, which is
// memory-hard and takes that advantage away.
//
// Two things have to stay true, and they pull in opposite directions:
//   1. A v1 file still opens. Refusing would lock people out of their own
//      secrets to fix a strength problem, which is worse than the problem.
//   2. Nothing is ever written as v1 again, so a file in use upgrades itself
//      without anyone being asked to do anything.
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "1claw-kdf-test-"));
const file = join(dir, "local-vault.enc");
process.env.ONECLAW_CONFIG_DIR = dir;
process.env.ONECLAW_LOCAL_VAULT = file;

const PASS = "a-long-enough-passphrase";
const SECRET = "hunter2-correct-horse";
let failed = 0;
const ok = (cond, label) => {
    console.log(`  ${cond ? "[PASS]" : "[FAIL]"} ${label}`);
    if (!cond) failed++;
};

/** A v1 file, built exactly as the old code built one. */
function writeV1() {
    const payload = JSON.stringify({
        version: 1,
        created_at: "x",
        updated_at: "x",
        secrets: {
            "db/password": {
                value: SECRET, type: "password", created_at: "x", updated_at: "x",
                synced_to_cloud: false, cloud_vault_id: null, cloud_path: null,
            },
        },
    });
    const salt = randomBytes(16);
    const key = pbkdf2Sync(PASS, salt, 100_000, 32, "sha256");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(payload, "utf-8"), c.final()]);
    writeFileSync(file, Buffer.concat([Buffer.from([1]), salt, iv, c.getAuthTag(), enc]), { mode: 0o600 });
}

const mod = new URL("../dist/src/local-vault.js", import.meta.url).href;
const { loadVault, saveVault, createVault } = await import(mod);

writeV1();
ok(readFileSync(file)[0] === 1, "the fixture really is a v1 file");

let v1;
try {
    v1 = loadVault(PASS);
} catch (e) {
    // Reported, not thrown. Refusing v1 is a plausible "tighten it" change, and
    // the failure it causes — everyone locked out of their own secrets — should
    // read as a sentence, not a stack trace.
    ok(false, `a v1 file still opens — it was refused instead: ${e.message}`);
    console.log("\n  1 failed");
    process.exit(1);
}
ok(v1.secrets["db/password"]?.value === SECRET, "a v1 file still opens, with its secret intact");

saveVault(v1, PASS);
ok(readFileSync(file)[0] === 2, "saving a v1 file rewrites it as v2 — it upgrades in place");
ok(loadVault(PASS).secrets["db/password"]?.value === SECRET, "the upgraded file reopens, secret intact");

rmSync(file, { force: true });
const fresh = createVault(PASS);
saveVault(fresh, PASS);
ok(readFileSync(file)[0] === 2, "a brand-new vault is written as v2, never v1");

// The wrong passphrase must fail, not silently return an empty vault.
let refused = false;
try { loadVault("the-wrong-passphrase"); } catch { refused = true; }
ok(refused, "the wrong passphrase is refused rather than returning nothing");

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n  ${failed} failed` : "\n  all passed");
process.exit(failed ? 1 : 0);
