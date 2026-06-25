import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");

export function daemonSocketPath(): string {
    return process.env.ONECLAW_DAEMON_SOCKET || join(CONFIG_DIR, "daemon.sock");
}

/**
 * Stop a running daemon (via its PID file) and wait for the socket to clear.
 * Best-effort — used to reload the daemon after writing new secrets/policies,
 * since the daemon loads the vault into memory once at startup.
 */
export async function stopDaemon(
    socketPath = daemonSocketPath(),
    timeoutMs = 5000,
): Promise<void> {
    const pidFile = join(CONFIG_DIR, "daemon.pid");
    if (existsSync(pidFile)) {
        try {
            const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
            if (pid) {
                try {
                    process.kill(pid, "SIGTERM");
                } catch {
                    /* already gone */
                }
            }
        } catch {
            /* unreadable */
        }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await daemonHealthy(socketPath))) break;
        await sleep(150);
    }
    try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
        /* ok */
    }
}

/** Ping the daemon's /health over its Unix socket. */
export function daemonHealthy(socketPath = daemonSocketPath()): Promise<boolean> {
    return new Promise((resolve) => {
        if (!existsSync(socketPath)) {
            resolve(false);
            return;
        }
        const req = httpRequest(
            { socketPath, path: "/health", method: "GET", timeout: 2000 },
            (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}

/**
 * Start the local daemon as a detached background process. The passphrase is
 * passed via the child's environment (ONECLAW_VAULT_PASSPHRASE) so no
 * interactive prompt is needed. Resolves once the socket answers /health.
 */
export async function startDaemonDetached(
    passphrase: string,
    socketPath = daemonSocketPath(),
    timeoutMs = 10000,
): Promise<boolean> {
    // process.argv[1] is the CLI entry (dist/bin/1claw.js). Re-invoke it so the
    // daemon runs the same code path in both dev and installed environments.
    const cliEntry = process.argv[1];
    const child = spawn(
        process.execPath,
        [cliEntry, "daemon", "start", "--socket", socketPath],
        {
            detached: true,
            stdio: "ignore",
            env: {
                ...process.env,
                ONECLAW_VAULT_PASSPHRASE: passphrase,
            },
        },
    );
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await daemonHealthy(socketPath)) return true;
        await sleep(250);
    }
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
