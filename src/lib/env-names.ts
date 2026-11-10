/**
 * List the environment variables a project uses, by NAME, without reading a real env file.
 *
 * Sources: templates (.env.example and friends; values are dropped as each line is parsed, since a
 * "template" sometimes holds a real key), code, and the names an encrypted `.env.1claw` lists in the clear.
 * Real env files are never opened, only listed. Long string literals in reported code are masked, so a
 * hardcoded fallback secret is flagged, not printed. "Signals" say what a value is for, from nearby calls.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { isEnvelopeFile, readEnvelope } from "./env-file.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", ".turbo", ".vercel", ".svelte-kit",
    "coverage", "vendor", "venv", ".venv", "__pycache__", "target", ".cache", "out", ".wrangler"]);
const KEEP_DOT_DIRS = new Set([".github", ".claude"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".py", ".go", ".rs", ".rb", ".php", ".svelte",
    ".vue", ".astro", ".sh", ".toml", ".yaml", ".yml"]);
const MAX_FILE = 1_500_000;
const TEMPLATE = /^(\.env\.(example|sample|template|dist|defaults)|example\.env|\.env\.[\w.-]+\.(example|sample|template)|env\.example)$/i;
const REAL_ENV = /^\.env(\.[\w.-]+)?$|^[\w.-]+\.env$/i;

const NAME = "([A-Z][A-Z0-9_]{1,80})";
const USES = [
    `process\\.env\\.${NAME}`,
    `process\\.env\\[\\s*['"\`]${NAME}['"\`]\\s*\\]`,
    `import\\.meta\\.env\\.${NAME}`,
    `Bun\\.env\\.${NAME}`,
    `Deno\\.env\\.get\\(\\s*['"]${NAME}['"]`,
    `os\\.environ\\[\\s*['"]${NAME}['"]\\s*\\]`,
    `os\\.environ\\.get\\(\\s*['"]${NAME}['"]`,
    `\\bgetenv\\(\\s*['"]${NAME}['"]`,
    `os\\.Getenv\\(\\s*"${NAME}"`,
    `env::var\\(\\s*"${NAME}"`,
    `\\bENV\\[\\s*['"]${NAME}['"]\\s*\\]`,
    `\\$\\{\\{?\\s*env\\.${NAME}`,
].map((p) => new RegExp(p, "g"));
const COMMON_HELPERS = ["required", "requireEnv", "getEnv", "mustGetEnv", "mustEnv", "envOrThrow", "getRequiredEnv", "need", "must",
    "readEnv", "env", "optional", "optionalEnv", "getenv_required", "require_env", "env_required"];
const HELPER_DEF = /(?:function\s+(\w+)\s*\(\s*(\w+)|(?:const|let)\s+(\w+)\s*=\s*\(?\s*(\w+)[^=]*=>|def\s+(\w+)\s*\(\s*(\w+))/g;
const DESTRUCTURE = /\{([^{}]{1,600})\}\s*=\s*(?:process\.env|import\.meta\.env|Bun\.env)/g;

const SIGNALS: [string, RegExp][] = [
    ["signs transactions", /new\s+(ethers\.)?Wallet\(|privateKeyToAccount\(|mnemonicToAccount\(|Keypair\.fromSecretKey|fromSecretKey\(|Ed25519Keypair|Wallet\.fromPhrase|HDNodeWallet|signTransaction|sendTransaction|writeContract\(|createWalletClient\(/],
    ["model provider client", /new\s+OpenAI\(|new\s+Anthropic\(|createOpenAI\(|createAnthropic\(|GoogleGenerativeAI\(|new\s+Groq\(|Replicate\(|fal\.config|OpenRouter|baseURL/],
    ["database connection", /new\s+Pool\(|new\s+Client\(|postgres\(|drizzle\(|PrismaClient|createPool\(|mysql\.create|mongoose\.connect|MongoClient\(|neon\(/],
    ["cache/queue connection", /new\s+Redis\(|createClient\(\s*\{?\s*url|ioredis|new\s+Queue\(|Upstash/],
    ["signs or verifies app tokens", /jwt\.sign\(|jwt\.verify\(|jose\.|SignJWT|createHmac\(|crypto\.createCipheriv|iron-session|nextauth|NEXTAUTH/],
    ["third-party API", /new\s+Stripe\(|stripe\(|new\s+Telegraf\(|TelegramBot\(|new\s+Bot\(|discord\.js|new\s+Client\(\s*\{\s*intents|TwitterApi\(|Resend\(|sgMail|twilio\(|S3Client\(|Pinata|Alchemy\(|Authorization['"]?\s*:\s*`?Bearer/],
    ["rpc endpoint", /JsonRpcProvider\(|http\(\s*process|createPublicClient\(|new\s+Connection\(|WebSocketProvider\(/],
];
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_)/;
// Any quoted literal of 8 or more characters. Passwords and connection strings carry `@ ? & ! % $` and
// spaces, and short ones are still secrets; what is left visible is decided in maskLiterals.
const SECRETISH_LITERAL = /(['"`])((?:(?!\1)[^\\\n]|\\.){8,})\1/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Names read by destructuring, by line, including `const {\n  A = "x", // note\n  B,\n} = process.env` across lines.
 * Comments and string values are blanked first, so their capitals aren't taken for names; line numbers survive.
 */
export function destructuredNames(text: string): Map<number, Set<string>> {
    const byLine = new Map<number, Set<string>>();
    for (const m of text.matchAll(DESTRUCTURE)) {
        const start = m.index + m[0].indexOf(m[1]);
        // One pass, left to right, so the `//` in a "https://..." default isn't taken for a comment.
        const code = m[1].replace(/(['"`])(?:\\.|(?!\1)[^\n])*\1|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
        for (const n of code.matchAll(/(?<![\w:]\s*)\b([A-Z][A-Z0-9_]{1,80})\b/g)) {
            const line = text.slice(0, start + n.index).split(/\r\n|\n|\r/).length - 1;
            if (!byLine.has(line)) byLine.set(line, new Set());
            byLine.get(line)!.add(n[1]);
        }
    }
    return byLine;
}

/** Mask long string literals (possible hardcoded secrets); report what kind were masked. */
export function maskLiterals(line: string): { shown: string; hits: ("url" | "token")[] } {
    const hits: ("url" | "token")[] = [];
    const shown = line.replace(SECRETISH_LITERAL, (whole, quote: string, v: string) => {
        if (/^[A-Z][A-Z0-9_]+$/.test(v)) return whole; // an env var name, not a value
        if (/^[a-z]+(?:[ -][a-z]+)*$/.test(v) && v.length <= 24) return whole; // plain lowercase words: a label, not a key
        if (/^0x[0-9a-fA-F]{40}$/.test(v)) return whole; // a public address
        const kind = /^(https?|wss?):\/\//.test(v) ? "url" : "token";
        hits.push(kind);
        const what = kind === "url" ? "URL " : /^(0x)?[0-9a-fA-F]{64}$/.test(v) ? "hex key-sized " : "";
        return `${quote}<${v.length}-char ${what}literal masked>${quote}`;
    });
    return { shown, hits };
}

function* walk(dir: string): Generator<string> {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    if (entries.some((e) => e.name === "pyvenv.cfg") || basename(dir) === "site-packages") return; // third-party code
    for (const e of entries) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
            if (KEEP_DOT_DIRS.has(e.name) || (!SKIP_DIRS.has(e.name) && !e.name.startsWith("."))) yield* walk(path);
        } else if (e.isFile()) {
            yield path;
        } else if (e.isSymbolicLink()) {
            try {
                if (statSync(path).isFile()) yield path;
            } catch {
                // a broken link
            }
        }
    }
}

function templateNames(path: string): Record<string, string> {
    const names: Record<string, string> = {};
    let comments: string[] = [];
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("#")) {
            comments.push(line.replace(/^[# ]+/, "").trim());
            continue;
        }
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (m) names[m[1]] = comments.slice(-2).filter(Boolean).join(" / ").slice(0, 160); // the value is never kept
        comments = [];
    }
    return names;
}

export interface NameEntry {
    uses: string[];
    signals: string[];
    in_code: boolean;
    hardcoded_fallback: boolean;
    default_literal: boolean;
    url_fallback?: boolean;
    templates?: string[];
    hint?: string;
    /** Listed by an encrypted env file, so it holds a value even if the code doesn't show it. */
    encrypted_in?: string[];
}

export interface EnvNamesReport {
    root: string;
    templates: string[];
    real_env_files_not_read: string[];
    names: Record<string, NameEntry>;
}

export function scanEnvNames(rootArg: string): EnvNamesReport {
    const root = resolve(rootArg);
    const isCode = (p: string) => CODE_EXT.has(extname(p)) && statSync(p).size <= MAX_FILE;

    // Helpers that read the environment by a name passed in, e.g. function required(name) { process.env[name] }
    const helpers = new Set(COMMON_HELPERS);
    for (const p of walk(root)) {
        const file = basename(p);
        if (!isCode(p) || TEMPLATE.test(file) || REAL_ENV.test(file)) continue;
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(HELPER_DEF)) {
            const [fn, arg] = m[1] ? [m[1], m[2]] : m[3] ? [m[3], m[4]] : [m[5], m[6]];
            const a = escapeRe(arg);
            const body = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
            if (new RegExp(`(process\\.env|import\\.meta\\.env|Bun\\.env|os\\.environ)\\s*\\[\\s*${a}\\s*\\]|getenv\\(\\s*${a}\\b|environ\\.get\\(\\s*${a}\\b`).test(body)) helpers.add(fn);
        }
    }
    const helperUse = new RegExp(`\\b(?:${[...helpers].sort().map(escapeRe).join("|")})\\(\\s*['"\`]${NAME}['"\`]`, "g");

    type Draft = Omit<NameEntry, "signals" | "in_code"> & { signals: Set<string> };
    const names = new Map<string, Draft>();
    const entry = (n: string): Draft => {
        if (!names.has(n)) names.set(n, { uses: [], signals: new Set(), hardcoded_fallback: false, default_literal: false });
        return names.get(n)!;
    };
    const templates: Record<string, Record<string, string>> = {};
    const realEnv: string[] = [];

    for (const p of walk(root)) {
        const rel = relative(root, p);
        const file = basename(p);
        if (TEMPLATE.test(file)) {
            templates[rel] = templateNames(p);
            continue;
        }
        if (isEnvelopeFile(file)) {
            realEnv.push(rel);
            try {
                for (const n of readEnvelope(p).names) (entry(n).encrypted_in ??= []).push(rel);
            } catch {
                // not one of ours; never read further
            }
            continue;
        }
        if (REAL_ENV.test(file)) {
            realEnv.push(rel); // never opened
            continue;
        }
        if (!isCode(p)) continue;
        const text = readFileSync(p, "utf8");
        const lines = text.split(/\r\n|\n|\r/);
        const destructured = destructuredNames(text);
        lines.forEach((line, i) => {
            const found = new Set<string>();
            for (const rx of [...USES, helperUse]) for (const m of line.matchAll(rx)) found.add(m[1]);
            for (const n of destructured.get(i) ?? []) found.add(n);
            if (!found.size) return;
            const windowText = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
            // Mask, then cut: cutting first can split a literal and print its prefix unmasked.
            const masked = maskLiterals(line.trim());
            const hits = masked.hits;
            const shown = masked.shown.length > 220 ? `${masked.shown.slice(0, 220)}…` : masked.shown;
            for (const n of found) {
                const e = entry(n);
                if (e.uses.length < 12) e.uses.push(`${rel}:${i + 1}  ${shown}`);
                for (const [label, rx] of SIGNALS) if (rx.test(windowText)) e.signals.add(label);
                if (PUBLIC_PREFIX.test(n)) e.signals.add("public by design (shipped to browsers)");
                // A literal used when the variable is unset: the app runs with a value nobody configured.
                const assignsDefault = destructured.get(i)?.has(n) && new RegExp(`\\b${escapeRe(n)}\\s*=\\s*['"\`]`).test(line);
                if (assignsDefault || new RegExp(`${escapeRe(n)}[^\\n]{0,40}?(\\|\\||\\?\\?|\\bor\\b|,)\\s*['"\`]`).test(line)) {
                    e.default_literal = true;
                    if (hits.includes("token")) e.hardcoded_fallback = true;
                    else if (hits.includes("url")) e.url_fallback = true;
                }
            }
        });
    }
    for (const [tpl, found] of Object.entries(templates)) {
        for (const [n, hint] of Object.entries(found)) {
            const e = entry(n);
            (e.templates ??= []).push(tpl);
            if (hint) e.hint = hint;
        }
    }
    const report: EnvNamesReport = { root, templates: Object.keys(templates).sort(), real_env_files_not_read: realEnv.sort(), names: {} };
    for (const n of [...names.keys()].sort()) {
        const e = names.get(n)!;
        report.names[n] = { ...e, signals: [...e.signals].sort(), in_code: e.uses.length > 0 };
    }
    return report;
}

export function formatEnvNames(r: EnvNamesReport): string {
    const out = [`# Env names in ${r.root}`, "",
        `Templates read (names only): ${r.templates.join(", ") || "none"}`,
        `Real env files present, NOT read: ${r.real_env_files_not_read.join(", ") || "none"}`, ""];
    for (const [n, e] of Object.entries(r.names)) {
        const where = e.in_code ? "code" : e.encrypted_in && !e.templates ? "encrypted file only" : "template only (unused in code?)";
        const warn = e.hardcoded_fallback ? "  ⚠ HARDCODED FALLBACK (long literal, masked): treat as a leaked secret"
            : e.url_fallback ? "  · falls back to a hardcoded URL: check it doesn't embed an API key"
            : e.default_literal ? "  · falls back to a default literal when unset" : "";
        out.push(`## ${n}  [${where}; ${e.signals.join(", ") || "no signal"}]${warn}`);
        if (e.hint) out.push(`   template comment: ${e.hint}`);
        for (const u of e.uses.slice(0, 6)) out.push(`   ${u}`);
        if (e.uses.length > 6) out.push(`   … ${e.uses.length - 6} more`);
    }
    out.push("", `${Object.keys(r.names).length} names.`);
    return out.join("\n");
}

export function writeEnvNamesJson(r: EnvNamesReport, file: string): void {
    writeFileSync(file, JSON.stringify(r, null, 1));
}
