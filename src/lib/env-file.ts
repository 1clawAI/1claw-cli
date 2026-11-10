/**
 * `.env` files, read and protected without their values ever reaching output.
 *
 * Three things live here because `ignore`, `env import`, `import` and
 * `agent binding create --credential-from-env` all need the same ones:
 *
 *  - `parseEnv` — one parser. `env push` used to split each line on the first
 *    `=` and strip quotes with a regex; `import` had its own, better parser.
 *    Two parsers means a value that imports fine can push wrong.
 *  - the `.1claw` envelope — an encrypted copy of a `.env` file. The key is
 *    random per file and lives in the user's 1Claw vault, so the file is
 *    useless to anything that cannot read that secret, and every decrypt is an
 *    audited vault read. Variable *names* stay in the clear in the envelope:
 *    they are what an agent needs to plan a migration, and they are not secret.
 *  - `findEnvFiles` — which files in a folder are real env files, as opposed to
 *    the `.example` templates that are meant to be read.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface EnvEntry {
    key: string;
    value: string;
    line: number;
}

/** Parse dotenv syntax: `KEY=value`, `export KEY=value`, quotes, `#` comments, escapes in double quotes, multi-line quoted values. */
export function parseEnv(content: string): EnvEntry[] {
    const entries: EnvEntry[] = [];
    const lines = content.replace(/\r\n?/g, "\n").split("\n");

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("export ")) line = line.slice(7).trim();

        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;

        let rest = line.slice(eq + 1).trim();
        const startLine = i + 1;
        const quote = rest[0];

        if (quote === '"' || quote === "'" || quote === "`") {
            // A quoted value may span lines (PEM keys, JSON); read until the closing quote, which is
            // the last quote on its line followed by nothing but a comment. So `'it's here'` keeps
            // its apostrophe, and a quote that never closes is an error rather than a value that
            // swallows every later line: `env import` deletes the source once the import succeeds,
            // so a misparse there loses the variables it swallowed.
            let body = rest.slice(1);
            let close = findClosingQuote(body, quote, 0);
            while (close < 0 && i + 1 < lines.length) {
                i++;
                const from = body.length + 1;
                body += "\n" + lines[i];
                close = findClosingQuote(body, quote, from);
            }
            if (close < 0) {
                throw new Error(`${key} (line ${startLine}) opens a ${quote} quote that never closes; fix the file first. No value was printed.`);
            }
            let value = body.slice(0, close);
            if (quote === '"') value = unescapeDoubleQuoted(value);
            entries.push({ key, value, line: startLine });
            continue;
        }

        // Unquoted: an inline comment starts at whitespace followed by `#`.
        const comment = rest.search(/\s#/);
        if (comment >= 0) rest = rest.slice(0, comment).trim();
        entries.push({ key, value: rest, line: startLine });
    }
    return entries;
}

/** The closing quote on the line starting at `from`: the last one followed only by whitespace or a `#` comment. */
function findClosingQuote(s: string, quote: string, from: number): number {
    const end = s.indexOf("\n", from) < 0 ? s.length : s.indexOf("\n", from);
    let found = -1;
    for (let i = from; i < end; i++) {
        if (s[i] === "\\" && quote === '"') {
            i++;
            continue;
        }
        if (s[i] === quote && /^\s*(#.*)?$/.test(s.slice(i + 1, end))) found = i;
    }
    return found;
}

function unescapeDoubleQuoted(v: string): string {
    return v.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);
}

// --- which files are env files ---------------------------------------------

const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];

/** A real env file (holds values), not a template meant to be committed and read. */
export function isRealEnvFile(name: string): boolean {
    if (name.endsWith(ENVELOPE_SUFFIX)) return false;
    if (TEMPLATE_SUFFIXES.some((s) => name.endsWith(s))) return false;
    return name === ".env" || name.startsWith(".env.") || /^[\w.-]+\.env$/.test(name);
}

/** Real env files directly in `dir` (not recursive: env files live at a project's root or an app's root). */
export function findEnvFiles(dir: string): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => isRealEnvFile(n))
        .filter((n) => {
            try {
                if (!statSync(join(dir, n)).isFile()) return false;
                // Only the app's access key: already migrated, and encrypting it would stop the app starting.
                const entries = parseEnv(readFileSync(join(dir, n), "utf8"));
                return !(entries.length === 1 && entries[0].key === "ONECLAW_AGENT_API_KEY");
            } catch {
                return false;
            }
        })
        .sort();
}

// --- the .1claw envelope ------------------------------------------------------

export const ENVELOPE_SUFFIX = ".1claw";
export const ENVELOPE_FORMAT = "1claw-env/1";

export interface Envelope {
    format: typeof ENVELOPE_FORMAT;
    /** The file this was made from, by name only. */
    source: string;
    /** Variable names, in file order. Not secret; kept so tools can plan without decrypting. */
    names: string[];
    /** Where the data key lives: a secret in the user's vault. */
    key: { vault_id: string; path: string };
    alg: "AES-256-GCM";
    iv: string;
    tag: string;
    ciphertext: string;
    created_at: string;
}

export function envelopePath(file: string): string {
    return file + ENVELOPE_SUFFIX;
}

export function isEnvelopeFile(file: string): boolean {
    return file.endsWith(ENVELOPE_SUFFIX);
}

/** A new random data key and the vault path it will be stored at. */
export function newDataKey(): { key: Buffer; path: string } {
    return { key: randomBytes(32), path: `1claw-ignore/${randomUUID()}` };
}

export function seal(plaintext: string, dataKey: Buffer, source: string, keyRef: { vault_id: string; path: string }): Envelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    // The key reference is bound into the ciphertext, so an envelope cannot be
    // re-pointed at a different key without the decrypt failing.
    cipher.setAAD(Buffer.from(`${ENVELOPE_FORMAT}|${keyRef.vault_id}|${keyRef.path}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
        format: ENVELOPE_FORMAT,
        source: basename(source),
        names: parseEnv(plaintext).map((e) => e.key),
        key: keyRef,
        alg: "AES-256-GCM",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        created_at: new Date().toISOString(),
    };
}

export function open(envelope: Envelope, dataKey: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(`${ENVELOPE_FORMAT}|${envelope.key.vault_id}|${envelope.key.path}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function readEnvelope(file: string): Envelope {
    let parsed: Envelope;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as Envelope;
    } catch {
        // JSON.parse's message quotes the start of the file, which could be a plaintext .env renamed.
        throw new Error(`${file} is not a 1Claw-protected env file (not JSON)`);
    }
    if (parsed.format !== ENVELOPE_FORMAT) {
        throw new Error(`${file} is not a 1Claw-protected env file (format ${String(parsed.format)})`);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(parsed.key?.vault_id))) {
        throw new Error(`${file}: its key's vault_id is not a UUID`);
    }
    return parsed;
}

export function serializeEnvelope(env: Envelope): string {
    return [
        "{",
        `  "_": "Encrypted by \`1claw ignore\`. The key is in your 1Claw vault; values never leave it in the clear. Import with \`1claw env import\`.",`,
        ...Object.entries(env).map(([k, v], i, all) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < all.length - 1 ? "," : ""}`),
        "}",
        "",
    ].join("\n");
}

/** The data key is stored base64 so it survives as a plain secret value. */
export function encodeDataKey(key: Buffer): string {
    return key.toString("base64");
}

export function decodeDataKey(value: string): Buffer {
    const key = Buffer.from(value.trim(), "base64");
    if (key.length !== 32) throw new Error("The vault secret holding this file's key is not a 32-byte key");
    return key;
}
