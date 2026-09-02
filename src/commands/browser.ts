import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue, printInfo, printError } from "../output.js";

/**
 * The browser bridge, hosted and local, under one command.
 *
 * There used to be a second binary — `1claw-vault`, shipped with
 * `@1claw/browser-bridge` — because the bridge's local file backend needed
 * managing and the main CLI had no commands for any of this. Two CLIs whose
 * names differ by a hyphen, one of which shares a word with an unrelated
 * subcommand (`1claw vault` manages *hosted* vaults), is a naming problem
 * nobody can hold in their head.
 *
 * So: `1claw browser` for the hosted side, `1claw browser vault` for the local
 * file. The split that matters is visible in the command itself.
 *
 * The local-file subcommands deliberately do **not** call `requireToken()`.
 * The whole reason that backend exists is that someone can run the bridge with
 * no 1Claw account, and folding it into this CLI must not quietly take that
 * away.
 */
export const browserCommand = new Command("browser")
    .description("Browser bridge — pair devices, define bindings, run the bridge");

/**
 * The vault refuses a bridge it will not speak to, and the check is on the
 * pairing route as well as the fill routes — server-side, so a known-vulnerable
 * build can be turned away without waiting for anyone to upgrade.
 *
 * The CLI is not a bridge, but it pairs *on behalf of* one, so it has to name a
 * version. This is the protocol version it writes, not the CLI's own.
 */
const BRIDGE_PROTOCOL_VERSION = "0.1.0";

// ── Hosted: devices ─────────────────────────────────────────────────────────

browserCommand
    .command("pair <label>")
    .description("Pair this machine and mint its bridge credential (shown once)")
    .requiredOption("--public-key <pin>", "The bridge's public key, pinned on first use")
    .option("--bridge-version <v>", "Bridge version reported to the vault")
    .option("-p, --password <password>", "Account password for the step-up re-auth")
    .option("--json", "Output as JSON")
    .action(async (label, opts) => {
        try {
            requireToken();
            const res = await api<{ device_id: string; label: string; credential: string }>(
                "/browser/devices",
                {
                    method: "POST",
                    headers: {
                        "x-1claw-bridge-version": opts.bridgeVersion ?? BRIDGE_PROTOCOL_VERSION,
                        // Pairing is behind a step-up re-auth, deliberately: the
                        // device being paired is the one that will type secrets
                        // into pages, so a stolen session must not be enough.
                        ...(opts.password ? { "X-Auth-Confirm": opts.password } : {}),
                    },
                    body: {
                        label,
                        public_key_pin: opts.publicKey,
                        bridge_version: opts.bridgeVersion ?? BRIDGE_PROTOCOL_VERSION,
                    },
                },
            );
            if (opts.json) return printJson(res);
            printSuccess(`Paired "${res.label}".`);
            printKeyValue([
                ["Device", res.device_id],
                ["Credential", res.credential],
            ]);
            printInfo("Shown once. There is no endpoint that returns it again.");
        } catch (err) {
            handleError(err);
        }
    });

browserCommand
    .command("devices")
    .description("List paired devices (revoked ones included)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ devices: Array<Record<string, string | null>> }>(
                "/browser/devices",
            );
            if (opts.json) return printJson(res);
            // Revoked devices are listed rather than hidden: "was this machine
            // ever paired" is the question people ask after a laptop goes missing.
            printTable(
                (res.devices ?? []).map((d) => ({
                    id: String(d.id ?? ""),
                    label: String(d.label ?? ""),
                    platform: String(d.platform ?? "—"),
                    last_seen: String(d.last_seen_at ?? "never"),
                    revoked: d.revoked_at ? String(d.revoked_at) : "—",
                })),
                [
                    { key: "id", header: "ID" },
                    { key: "label", header: "Label" },
                    { key: "platform", header: "Platform" },
                    { key: "last_seen", header: "Last seen" },
                    { key: "revoked", header: "Revoked" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

browserCommand
    .command("revoke <device-id>")
    .description("Revoke a paired device — this is what makes a leaked credential stop working")
    .action(async (deviceId) => {
        try {
            requireToken();
            await api(`/browser/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
            printSuccess(`Revoked ${deviceId}. It opens no sessions and authorises no fills.`);
        } catch (err) {
            handleError(err);
        }
    });

// ── Hosted: bindings ────────────────────────────────────────────────────────

const binding = browserCommand
    .command("binding")
    .description("Which secret may be typed, and into which hosts");

binding
    .command("create <name>")
    .description("Define a binding (human only)")
    .requiredOption("--vault <id>", "Vault holding the secret")
    .requiredOption("--path <path>", "Secret path within the vault")
    .requiredOption("--login-url <url>", "The page the bridge navigates to")
    .requiredOption("--hosts <hosts>", "Comma-separated allowed hosts (exact match, no wildcards)")
    .option("--sso-hosts <hosts>", "Comma-separated hosts a login may redirect through")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
        try {
            requireToken();
            const res = await api("/browser/credentials", {
                method: "POST",
                body: {
                    name,
                    vault_id: opts.vault,
                    secret_path: opts.path,
                    login_url: opts.loginUrl,
                    allowed_hosts: String(opts.hosts).split(",").map((h) => h.trim()).filter(Boolean),
                    ...(opts.ssoHosts
                        ? { sso_hosts: String(opts.ssoHosts).split(",").map((h) => h.trim()).filter(Boolean) }
                        : {}),
                },
            });
            if (opts.json) return printJson(res);
            printSuccess(`Created binding "${name}".`);
        } catch (err) {
            handleError(err);
        }
    });

binding
    .command("list")
    .description("List bindings")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ credentials: Array<Record<string, unknown>> }>(
                "/browser/credentials",
            );
            if (opts.json) return printJson(res);
            printTable(
                (res.credentials ?? []).map((c) => ({
                    id: String(c.id ?? ""),
                    name: String(c.name ?? ""),
                    login_url: String(c.login_url ?? ""),
                    hosts: Array.isArray(c.allowed_hosts) ? c.allowed_hosts.join(",") : "",
                })),
                [
                    { key: "id", header: "ID" },
                    { key: "name", header: "Name" },
                    { key: "login_url", header: "Login URL" },
                    { key: "hosts", header: "Allowed hosts" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

binding
    .command("rm <binding-id>")
    .description("Delete a binding")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/browser/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
            printSuccess(`Deleted binding ${id}.`);
        } catch (err) {
            handleError(err);
        }
    });

// ── Local file: no account required ─────────────────────────────────────────

/**
 * The passphrase, from the environment only.
 *
 * Never a flag: argv is world-readable in `ps` and lands in shell history.
 */
function passphrase(): string {
    const p = process.env.ONECLAW_BRIDGE_VAULT_PASSPHRASE;
    if (!p) {
        printError("Set ONECLAW_BRIDGE_VAULT_PASSPHRASE — the passphrase is never taken as a flag.");
        process.exit(1);
    }
    return p;
}

/** Read stdin to the end, for a secret that must not appear in argv. */
async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString("utf-8");
}

/**
 * The bridge package, loaded only when a local-file command is actually run.
 *
 * It is an optional dependency: the hosted commands above need nothing, and a
 * hosted user should not be made to install a browser automation package to
 * pair a device. Someone using the local-file backend already has the bridge —
 * that is what reads the file.
 *
 * The format is emphatically not reimplemented here. Two encrypted local files
 * with different key derivations is precisely what this consolidation exists to
 * end; a third copy would be the same mistake with better intentions.
 */
type LocalVaultDoc = {
    entries: Array<{ id: string; loginUrl: string; allowedHosts: string[] }>;
    registrations?: Array<{ id: string; signupUrl: string; username: string }>;
    captures?: Array<{ id: string; captureUrl: string; allowedHosts: string[] }>;
};

async function bridgeVaultApi(): Promise<{
    openVault: (file: unknown, pass: string) => Promise<LocalVaultDoc>;
    sealVault: (doc: unknown, pass: string) => Promise<unknown>;
}> {
    try {
        // Resolved at run time, not build time: it is an optional dependency,
        // so the type checker must not require it to be installed here.
        const spec = "@1claw/browser-bridge";
        return (await import(spec)) as never;
    } catch {
        printError(
            "The local-file commands need @1claw/browser-bridge, which is not installed.\n" +
                "  Install it alongside the CLI, or use `1claw browser` without `vault` for the hosted side.",
        );
        process.exit(1);
    }
}

async function loadFile(path: string) {
    const { openVault } = await bridgeVaultApi();
    return openVault(JSON.parse(await readFile(path, "utf-8")), passphrase());
}

async function saveFile(path: string, doc: unknown) {
    const { sealVault } = await bridgeVaultApi();
    // 0600: this file is the whole security boundary for a local backend.
    await writeFile(path, JSON.stringify(await sealVault(doc, passphrase()), null, 2), {
        mode: 0o600,
    });
}

const localVault = browserCommand
    .command("vault")
    .description("The bridge's local encrypted file — no 1Claw account needed");

localVault
    .command("init <file>")
    .description("Create an empty vault file")
    .action(async (file) => {
        try {
            await saveFile(file, { entries: [], registrations: [], captures: [] });
            printSuccess(`Created ${file}`);
        } catch (err) {
            handleError(err);
        }
    });

localVault
    .command("add <file>")
    .description("Add a credential. The secret comes from stdin, never from a flag.")
    .requiredOption("--id <id>", "Binding id the agent will name")
    .requiredOption("--url <url>", "Login URL the bridge navigates to")
    .requiredOption("--hosts <hosts>", "Comma-separated allowed hosts")
    .option("--sso <hosts>", "Comma-separated SSO hosts a login may redirect through")
    .action(async (file, opts) => {
        try {
            const secret = (await readStdin()).replace(/\n$/, "");
            if (!secret) {
                printError("No secret on stdin. Pipe it: printf '%s' 'the-password' | 1claw browser vault add …");
                process.exit(1);
            }
            const doc = await loadFile(file);
            const entries = [...doc.entries.filter((e) => e.id !== opts.id), {
                id: opts.id,
                secret,
                loginUrl: opts.url,
                allowedHosts: String(opts.hosts).split(",").map((h) => h.trim()).filter(Boolean),
                ...(opts.sso
                    ? { ssoHosts: String(opts.sso).split(",").map((h) => h.trim()).filter(Boolean) }
                    : {}),
            }];
            await saveFile(file, { ...doc, entries });
            printSuccess(`Added ${opts.id}`);
        } catch (err) {
            handleError(err);
        }
    });

localVault
    .command("list <file>")
    .description("List what the vault authorises — ids and rules, never a secret")
    .action(async (file) => {
        try {
            const doc = await loadFile(file);
            const rows: Record<string, unknown>[] = [];
            for (const e of doc.entries) {
                rows.push({ kind: "credential", id: e.id, url: e.loginUrl, detail: e.allowedHosts.join(",") });
            }
            for (const r of doc.registrations ?? []) {
                rows.push({ kind: "signup", id: r.id, url: r.signupUrl, detail: r.username });
            }
            for (const c of doc.captures ?? []) {
                rows.push({ kind: "capture", id: c.id, url: c.captureUrl, detail: c.allowedHosts.join(",") });
            }
            printTable(rows, [
                { key: "kind", header: "Kind" },
                { key: "id", header: "ID" },
                { key: "url", header: "URL" },
                { key: "detail", header: "Hosts / user" },
            ]);
        } catch (err) {
            handleError(err);
        }
    });

localVault
    .command("rm <file> <id>")
    .description("Remove a credential, signup policy or capture policy by id")
    .action(async (file, id) => {
        try {
            const doc = await loadFile(file);
            await saveFile(file, {
                ...doc,
                entries: doc.entries.filter((e) => e.id !== id),
                registrations: (doc.registrations ?? []).filter((r) => r.id !== id),
                captures: (doc.captures ?? []).filter((c) => c.id !== id),
            });
            printSuccess(`Removed ${id}`);
        } catch (err) {
            handleError(err);
        }
    });

// ── Running the bridge ──────────────────────────────────────────────────────

browserCommand
    .command("start")
    .description("Run the bridge against a vault (hosted or local file)")
    .option("--vault <file>", "Local vault file. Omit to use the hosted vault.")
    .option("--chrome <path>", "Path to a Chromium binary")
    .option("--port <port>", "Port for the gated CDP socket")
    .allowUnknownOption(true)
    .action(async (opts, cmd) => {
        // Delegated rather than reimplemented. The bridge owns its own argument
        // handling, and a second parser here would drift from it — the same way
        // a second copy of the vault format did.
        const args: string[] = [];
        if (opts.vault) args.push("--vault", opts.vault);
        if (opts.chrome) args.push("--chrome", opts.chrome);
        if (opts.port) args.push("--port", String(opts.port));
        args.push(...(cmd.args ?? []));

        const child = spawn("1claw-browser-bridge", args, { stdio: "inherit" });
        child.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") {
                printError(
                    "1claw-browser-bridge is not on PATH.\n" +
                        "  Install @1claw/browser-bridge, or run it from a checkout of the bridge repo.",
                );
                process.exit(1);
            }
            printError(String(e.message));
            process.exit(1);
        });
        child.on("exit", (code) => process.exit(code ?? 0));
    });
