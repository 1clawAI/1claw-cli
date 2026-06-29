import { Command } from "commander";
import {
    createServer,
    type Server,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printKeyValue,
    printTable,
} from "../output.js";
import {
    vaultExists,
    loadVault,
    getSecret,
    listSecrets,
    type LocalVaultData,
} from "../local-vault.js";
import {
    loadPolicy,
    savePolicy,
    isHostAllowed,
    resolveInjection,
    getSecretPolicy,
    setSecretPolicy,
    removeSecretPolicy,
    getPolicyPath,
    policyExists,
    type SecretPolicy,
    type PolicyFile,
} from "../local-policy.js";
import { proxyRequest, type ProxyRequest } from "../secret-proxy.js";

const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
const SOCKET_PATH =
    process.env.ONECLAW_DAEMON_SOCKET || join(CONFIG_DIR, "daemon.sock");
const PID_FILE = join(CONFIG_DIR, "daemon.pid");

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

function jsonResponse(
    res: ServerResponse,
    status: number,
    body: unknown,
): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

export const daemonCommand = new Command("daemon").description(
    "Local daemon — serves secrets over a Unix socket without exposing values",
);

// ── daemon start ─────────────────────────────────────────

daemonCommand
    .command("start")
    .description("Start the local secret daemon on a Unix socket")
    .option("--foreground", "Run in the foreground (don't daemonize)")
    .option("--socket <path>", "Custom socket path")
    .action(async (opts) => {
        try {
            if (!vaultExists()) {
                printError("No local vault. Run `1claw local init` first.");
                process.exit(1);
            }

            const socketPath = opts.socket ?? SOCKET_PATH;

            if (existsSync(socketPath)) {
                try {
                    unlinkSync(socketPath);
                } catch {
                    printError(
                        `Socket ${socketPath} exists and cannot be removed. Is another daemon running?`,
                    );
                    process.exit(1);
                }
            }

            console.log();

            // Non-interactive unlock for automation (e.g. `1claw init` starting
            // the daemon as a detached child). Falls back to a prompt otherwise.
            let passphrase: string;
            if (process.env.ONECLAW_VAULT_PASSPHRASE) {
                passphrase = process.env.ONECLAW_VAULT_PASSPHRASE;
            } else {
                printInfo("Unlocking local vault to start daemon...");
                ({ passphrase } = await inquirer.prompt([
                    {
                        type: "password",
                        name: "passphrase",
                        message: "Vault passphrase:",
                        mask: "*",
                    },
                ]));
            }

            let vault: LocalVaultData;
            try {
                vault = loadVault(passphrase);
            } catch {
                printError("Wrong passphrase or corrupted vault file.");
                printInfo(
                    "Forgot your passphrase? Reset the local vault with `1claw local destroy --force`, then `1claw local init`.",
                );
                process.exit(1);
            }

            const policy = loadPolicy();
            const secretCount = Object.keys(vault.secrets).length;
            const policyCount = Object.keys(policy.secrets).length;

            // Detach stdin so a closed pipe (e.g. from automation) doesn't
            // tear down the event loop once the server is listening.
            try { process.stdin.pause(); } catch { /* ok */ }
            try { process.stdin.unref(); } catch { /* ok */ }

            const server = createDaemonServer(vault, policy);

            server.on("error", (err) => {
                printError(`Daemon server error: ${err.message}`);
                process.exit(1);
            });

            server.listen(socketPath, () => {
                try {
                    chmodSync(socketPath, 0o600);
                } catch {
                    // best-effort
                }

                writeFileSync(PID_FILE, String(process.pid));

                // Keep the event loop alive — without this, Node may exit when
                // stdin closes (piped passphrase) and imported modules drain.
                setInterval(() => {}, 1_000);

                console.log();
                printSuccess(
                    `1Claw daemon running on ${chalk.bold(socketPath)}`,
                );
                printInfo(`Serving ${secretCount} secret(s), ${policyCount} policy rule(s).`);
                printInfo("Press Ctrl+C to stop.");
                console.log();

                printInfo("Configure MCP for local mode:");
                console.log(
                    chalk.dim(
                        `  1claw setup --local\n` +
                        `  # or set ONECLAW_DAEMON_SOCKET=${socketPath}`,
                    ),
                );
                console.log();
            });

            const shutdown = () => {
                console.log();
                printInfo("Shutting down daemon...");
                server.close(() => {
                    try {
                        unlinkSync(socketPath);
                    } catch { /* ok */ }
                    try {
                        unlinkSync(PID_FILE);
                    } catch { /* ok */ }
                    process.exit(0);
                });
                setTimeout(() => process.exit(0), 3000);
            };

            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        } catch (err) {
            if (err instanceof Error) printError(err.message);
            else printError(String(err));
            process.exit(1);
        }
    });

// ── daemon stop ──────────────────────────────────────────

daemonCommand
    .command("stop")
    .description("Stop the running daemon")
    .action(() => {
        if (!existsSync(PID_FILE)) {
            printInfo("No daemon PID file found. The daemon may not be running.");
            return;
        }

        try {
            const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
            process.kill(pid, "SIGTERM");
            printSuccess(`Sent SIGTERM to daemon (PID ${pid}).`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                printWarning("Daemon process not found. Cleaning up PID file.");
            } else {
                printError(`Failed to stop daemon: ${(err as Error).message}`);
            }
        }

        try {
            unlinkSync(PID_FILE);
        } catch { /* ok */ }
    });

// ── daemon status ────────────────────────────────────────

daemonCommand
    .command("status")
    .description("Show daemon status")
    .action(() => {
        const socketExists = existsSync(
            process.env.ONECLAW_DAEMON_SOCKET || SOCKET_PATH,
        );
        let pidRunning = false;
        let pid = "";

        if (existsSync(PID_FILE)) {
            pid = readFileSync(PID_FILE, "utf-8").trim();
            try {
                process.kill(parseInt(pid, 10), 0);
                pidRunning = true;
            } catch {
                pidRunning = false;
            }
        }

        printKeyValue([
            [
                "Daemon",
                pidRunning
                    ? chalk.green("running") + ` (PID ${pid})`
                    : chalk.dim("stopped"),
            ],
            [
                "Socket",
                socketExists
                    ? chalk.green(SOCKET_PATH)
                    : chalk.dim("not found"),
            ],
            [
                "Policy",
                policyExists()
                    ? chalk.green(getPolicyPath())
                    : chalk.dim("none (using defaults)"),
            ],
        ]);
    });

// ── daemon policy ────────────────────────────────────────

const policyCmd = daemonCommand
    .command("policy")
    .description("Manage per-secret host allowlist policies");

policyCmd
    .command("add <secret>")
    .description("Add or update a policy for a secret")
    .requiredOption(
        "--hosts <hosts>",
        "Comma-separated allowed hosts (e.g. api.stripe.com,*.openai.com)",
    )
    .option(
        "--inject-as <method>",
        "Injection method: bearer, header, basic, query",
        "bearer",
    )
    .option("--header-name <name>", "Header name (for inject-as=header)")
    .option("--query-param <param>", "Query parameter name (for inject-as=query)")
    .action((secret, opts) => {
        const policy = loadPolicy();
        const sp: SecretPolicy = {
            allowed_hosts: opts.hosts.split(",").map((h: string) => h.trim()),
            inject_as: opts.injectAs as SecretPolicy["inject_as"],
        };
        if (opts.headerName) sp.header_name = opts.headerName;
        if (opts.queryParam) sp.query_param = opts.queryParam;

        setSecretPolicy(policy, secret, sp);
        savePolicy(policy);
        printSuccess(
            `Policy set for ${chalk.bold(secret)}: allowed hosts = [${sp.allowed_hosts.join(", ")}]`,
        );
    });

policyCmd
    .command("remove <secret>")
    .description("Remove a policy for a secret")
    .action((secret) => {
        const policy = loadPolicy();
        if (removeSecretPolicy(policy, secret)) {
            savePolicy(policy);
            printSuccess(`Policy removed for ${chalk.bold(secret)}.`);
        } else {
            printWarning(`No policy found for "${secret}".`);
        }
    });

policyCmd
    .command("list")
    .alias("ls")
    .description("List all secret policies")
    .action(() => {
        const policy = loadPolicy();
        const entries = Object.entries(policy.secrets);

        if (entries.length === 0) {
            printInfo("No policies configured. Add one with: 1claw daemon policy add <secret> --hosts <hosts>");
            return;
        }

        printTable(
            entries.map(([name, sp]) => ({
                secret: name,
                hosts: sp.allowed_hosts.join(", "),
                inject: sp.inject_as,
            })),
            [
                { key: "secret", header: "Secret" },
                { key: "hosts", header: "Allowed Hosts" },
                { key: "inject", header: "Inject As" },
            ],
        );
    });

// ── Daemon HTTP server on Unix socket ────────────────────

function createDaemonServer(
    vault: LocalVaultData,
    policy: PolicyFile,
): Server {
    return createServer(async (req, res) => {
        const path = req.url ?? "/";
        const method = req.method ?? "GET";

        // Health check
        if (path === "/health") {
            jsonResponse(res, 200, {
                status: "ok",
                daemon: "1claw",
                secrets: Object.keys(vault.secrets).length,
                policies: Object.keys(policy.secrets).length,
            });
            return;
        }

        // List secret names (never values).
        // When ?prefix= is provided, only return secrets under that path.
        // Docker containers MUST pass their agent prefix to enforce isolation.
        if ((path === "/secrets" || path.startsWith("/secrets?")) && method === "GET") {
            const url = new URL(path, "http://localhost");
            const prefix = url.searchParams.get("prefix") || "";
            const secrets = listSecrets(vault)
                .filter((s) => !prefix || s.name.startsWith(prefix))
                .map((s) => ({
                    name: s.name,
                    type: s.type,
                    synced: s.synced,
                }));
            jsonResponse(res, 200, { secrets });
            return;
        }

        // Check if a secret exists + get metadata
        if (path.startsWith("/secrets/") && method === "GET") {
            const name = decodeURIComponent(path.slice("/secrets/".length));
            const secret = getSecret(vault, name);
            if (!secret) {
                jsonResponse(res, 404, { error: `Secret "${name}" not found` });
                return;
            }
            jsonResponse(res, 200, {
                name,
                type: secret.type,
                synced: secret.synced_to_cloud,
                created_at: secret.created_at,
                updated_at: secret.updated_at,
                has_policy: !!policy.secrets[name],
            });
            return;
        }

        // Proxy request — inject secret without exposing value.
        // When X-Secret-Prefix header is set, the requested secret must fall
        // under that prefix (container isolation for Docker agents).
        if (path === "/proxy" && method === "POST") {
            let body: string;
            try {
                body = await readBody(req);
            } catch {
                jsonResponse(res, 400, { error: "Failed to read request body" });
                return;
            }

            let proxyReq: ProxyRequest;
            try {
                proxyReq = JSON.parse(body) as ProxyRequest;
            } catch {
                jsonResponse(res, 400, { error: "Invalid JSON body" });
                return;
            }

            if (!proxyReq.secretName || !proxyReq.url) {
                jsonResponse(res, 400, {
                    error: "Missing required fields: secretName, url",
                });
                return;
            }

            const callerPrefix = req.headers["x-secret-prefix"] as string | undefined;
            if (callerPrefix) {
                const allNames = [proxyReq.secretName, ...(proxyReq.injectSecrets ?? [])];
                const denied = allNames.find((n) => !n.startsWith(callerPrefix));
                if (denied) {
                    jsonResponse(res, 403, {
                        error: `Access denied: secret "${denied}" is outside your namespace`,
                    });
                    return;
                }
            }

            const result = await proxyRequest(proxyReq, vault, policy);
            if (!result.success) {
                jsonResponse(res, 403, { error: result.error });
                return;
            }

            jsonResponse(res, 200, {
                status: result.response!.status,
                headers: result.response!.headers,
                body: result.response!.body,
            });
            return;
        }

        // Check policy for a secret + host
        if (path === "/check-policy" && method === "POST") {
            let body: string;
            try {
                body = await readBody(req);
            } catch {
                jsonResponse(res, 400, { error: "Failed to read request body" });
                return;
            }

            let parsed: { secretName: string; url: string };
            try {
                parsed = JSON.parse(body);
            } catch {
                jsonResponse(res, 400, { error: "Invalid JSON body" });
                return;
            }

            const check = isHostAllowed(policy, parsed.secretName, parsed.url);
            jsonResponse(res, check.allowed ? 200 : 403, check);
            return;
        }

        jsonResponse(res, 404, { error: "Not found" });
    });
}
