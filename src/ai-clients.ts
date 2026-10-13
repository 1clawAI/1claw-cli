import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    renameSync,
    lstatSync,
    chmodSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * CLIKEYFILE-L1. These files carry the agent key in plaintext, and the write
 * had three problems:
 *
 *  - `writeFileSync` used the default mode, so the key landed at 0644 —
 *    world-readable on a shared machine.
 *  - `renameSync` over a symlink replaces the link rather than following it,
 *    and silently discards a stricter mode the user had set on the original.
 *  - Writing through a symlink at all means the destination is whatever the
 *    link points at, which the caller did not choose.
 *
 * So: refuse to clobber a symlink, create the temp file 0600, and re-apply
 * 0600 after the rename in case the umask or the filesystem disagreed.
 */
export function writeCredentialFile(configPath: string, contents: string): void {
    if (existsSync(configPath)) {
        let st;
        try {
            st = lstatSync(configPath);
        } catch {
            st = null;
        }
        if (st?.isSymbolicLink()) {
            throw new Error(
                `Refusing to write the agent key through a symlink: ${configPath}. ` +
                    `Replace it with a regular file, or configure the client by hand.`,
            );
        }
    }

    const tmpPath = configPath + ".1claw-tmp";
    writeFileSync(tmpPath, contents, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, configPath);
    try {
        chmodSync(configPath, 0o600);
    } catch {
        /* Best effort: some filesystems (e.g. mounted volumes) refuse chmod. */
    }
}

export interface AiClient {
    name: string;
    slug: string;
    configPath: string;
    configFormat: "mcpServers" | "servers" | "zed" | "claude-code" | "opencode" | "codex-toml";
    detected: boolean;
    /** One-line install command shown next to "(not found)" — omitted for GUI apps with no single install command. */
    installHint?: string;
}

function expandHome(p: string): string {
    return p.replace(/^~/, homedir());
}

/**
 * Resolve a binary on PATH, without a shell.
 *
 * `execSync("which X 2>/dev/null")` was used for this in four places. None was
 * injectable -- every command string was a literal -- but a shell was being
 * spawned to do a PATH lookup, and more to the point the presence of ANY
 * `execSync` in `src/` means `no-shell-interpolation.test.mjs` cannot state a
 * blanket rule. A ban with four exceptions is not enforceable; the exceptions
 * are where the next interpolated one goes.
 *
 * `execFileSync` with an argv array never reaches a shell, so there is no
 * metacharacter parsing to reason about. `stdio` replaces the `2>/dev/null`.
 */
function whichBinary(name: string): string {
    try {
        return execFileSync("which", [name], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        // `which` exits non-zero when the binary is absent, which execFileSync
        // raises. Absent is not an error here.
        return "";
    }
}

function resolveGlobalMcpBinary(): string {
    const resolved = whichBinary("1claw-mcp");
    if (resolved) return resolved;
    return "";
}

export function detectAiClients(projectDir?: string): AiClient[] {
    const isMac = platform() === "darwin";

    const clients: AiClient[] = [
        {
            name: "Claude Desktop",
            slug: "claude-desktop",
            configPath: isMac
                ? "~/Library/Application Support/Claude/claude_desktop_config.json"
                : "~/.config/claude/claude_desktop_config.json",
            configFormat: "mcpServers",
            detected: false,
        },
        {
            name: "Claude Code",
            slug: "claude-code",
            configPath: "",
            configFormat: "claude-code",
            detected: false,
            installHint: "npm install -g @anthropic-ai/claude-code",
        },
        {
            name: "Codex",
            slug: "codex",
            configPath: "~/.codex/config.toml",
            configFormat: "codex-toml",
            detected: false,
            installHint: "npm install -g @openai/codex",
        },
        {
            name: "OpenCode",
            slug: "opencode",
            configPath: projectDir
                ? join(projectDir, "opencode.json")
                : "~/.config/opencode/opencode.json",
            configFormat: "opencode",
            detected: false,
            installHint: "curl -fsSL https://opencode.ai/v2/install | bash",
        },
        {
            name: "Cursor",
            slug: "cursor",
            configPath: projectDir
                ? join(projectDir, ".cursor", "mcp.json")
                : "~/.cursor/mcp.json",
            configFormat: "mcpServers",
            detected: false,
        },
        {
            name: "Windsurf",
            slug: "windsurf",
            configPath: "~/.codeium/windsurf/mcp_config.json",
            configFormat: "mcpServers",
            detected: false,
        },
        {
            name: "VS Code",
            slug: "vscode",
            configPath: projectDir
                ? join(projectDir, ".vscode", "mcp.json")
                : "~/.vscode/mcp.json",
            configFormat: "servers",
            detected: false,
        },
        {
            name: "Zed",
            slug: "zed",
            configPath: "~/.config/zed/settings.json",
            configFormat: "zed",
            detected: false,
        },
        {
            name: "Continue.dev",
            slug: "continue",
            configPath: "~/.continue/config.json",
            configFormat: "mcpServers",
            detected: false,
        },
    ];

    for (const client of clients) {
        if (client.slug === "claude-code") {
            try {
                if (!whichBinary("claude")) throw new Error("claude not on PATH");
                client.detected = true;
            } catch {
                client.detected = false;
            }
            continue;
        }

        // A binary install (curl script / npm -g) puts nothing on disk until
        // the tool is actually run once, so config-path existence alone would
        // miss a client someone just installed — check `which` first, same as
        // Claude Code above, and only fall back to the config file/dir.
        if (client.slug === "codex") {
            try {
                if (!whichBinary("codex")) throw new Error("codex not on PATH");
                client.detected = true;
            } catch {
                client.detected = existsSync(expandHome(client.configPath));
            }
            continue;
        }
        if (client.slug === "opencode") {
            try {
                if (!whichBinary("opencode")) throw new Error("opencode not on PATH");
                client.detected = true;
            } catch {
                const expanded = expandHome(client.configPath);
                client.detected = existsSync(expanded) || existsSync(dirname(expanded));
            }
            continue;
        }

        const expanded = expandHome(client.configPath);
        if (client.slug === "cursor") {
            client.detected =
                existsSync(expandHome("~/.cursor")) ||
                existsSync(expanded);
        } else if (client.slug === "vscode") {
            client.detected =
                existsSync(expandHome("~/.vscode")) ||
                existsSync(expanded);
        } else {
            client.detected =
                existsSync(expanded) ||
                existsSync(dirname(expanded));
        }
    }

    return clients;
}

export interface McpServerEntry {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export function buildMcpEntry(envVars: Record<string, string>): McpServerEntry {
    const globalBin = resolveGlobalMcpBinary();

    if (globalBin) {
        return {
            command: globalBin,
            args: [],
            env: envVars,
        };
    }

    return {
        command: "npx",
        args: ["-y", "@1claw/mcp"],
        env: envVars,
    };
}

export function configureClient(
    client: AiClient,
    entry: McpServerEntry,
): { success: boolean; message: string } {
    if (client.configFormat === "claude-code") {
        return configureClaudeCode(entry);
    }
    if (client.configFormat === "codex-toml") {
        return configureCodexToml(client, entry);
    }

    const configPath = expandHome(client.configPath);

    const dir = dirname(configPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
        try {
            config = JSON.parse(readFileSync(configPath, "utf-8"));
        } catch {
            return {
                success: false,
                message: `Failed to parse ${configPath}`,
            };
        }
    }

    const serverStanza = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
    };

    switch (client.configFormat) {
        case "mcpServers": {
            if (!config.mcpServers || typeof config.mcpServers !== "object") {
                config.mcpServers = {};
            }
            (config.mcpServers as Record<string, unknown>)["1claw"] =
                serverStanza;
            break;
        }
        case "servers": {
            if (!config.servers || typeof config.servers !== "object") {
                config.servers = {};
            }
            (config.servers as Record<string, unknown>)["1claw"] =
                serverStanza;
            break;
        }
        case "zed": {
            if (
                !config.context_servers ||
                typeof config.context_servers !== "object"
            ) {
                config.context_servers = {};
            }
            (config.context_servers as Record<string, unknown>)["1claw"] = {
                command: {
                    path: entry.command,
                    args: entry.args,
                    env: entry.env,
                },
                settings: {},
            };
            break;
        }
        case "opencode": {
            if (!config.mcp || typeof config.mcp !== "object") {
                config.mcp = {};
            }
            (config.mcp as Record<string, unknown>)["1claw"] = {
                type: "local",
                command: [entry.command, ...entry.args],
                environment: entry.env,
            };
            break;
        }
    }

    writeCredentialFile(configPath, JSON.stringify(config, null, 2) + "\n");

    return {
        success: true,
        message: `Configured ${client.name} at ${configPath}`,
    };
}

function configureClaudeCode(
    entry: McpServerEntry,
): { success: boolean; message: string } {
    const envArgs = Object.entries(entry.env)
        .flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    // Remove existing entry first (ignore errors if it doesn't exist)
    try {
        execFileSync("claude", ["mcp", "remove", "1claw", "-s", "user"], {
            encoding: "utf-8",
            stdio: "pipe",
        });
    } catch {
        // fine — entry didn't exist
    }

    // `execFileSync` with an argv array, not `execSync` with a joined string.
    //
    // This used to be `execSync(cmdParts.join(" "))`, which hands the whole
    // thing to a shell, and the parts are not all constants: the `-e KEY=VALUE`
    // pairs carry an agent API key that comes either from a `--agent-key` flag
    // or straight out of an API response, and the daemon variant carries a
    // socket path derived from `ONECLAW_CONFIG_DIR`. A value containing `;`,
    // `$(…)` or a backtick would have executed.
    //
    // Our own keys are `ocv_` plus base64url and our own paths have no
    // metacharacters, so the realistic exposure was small — but that safety
    // came from the *server's* output shape and the user's environment, which
    // is not where a client should look for its shell safety.
    //
    // It was also a plain correctness bug: joining on spaces breaks any value
    // that contains one, and `ONECLAW_CONFIG_DIR` is user-settable, so a config
    // path like `~/Library/Application Support/1claw` produced a mangled
    // command. `daemon.ts` already did this correctly; this is the same shape.
    const cmdArgs = [
        "mcp", "add",
        "1claw",
        "-s", "user",
        ...envArgs,
        "--",
        entry.command,
        ...entry.args,
    ];

    try {
        execFileSync("claude", cmdArgs, {
            encoding: "utf-8",
            stdio: "pipe",
        });
        return {
            success: true,
            message: "Configured Claude Code via `claude mcp add`",
        };
    } catch (err) {
        return {
            success: false,
            message: `Failed to configure Claude Code: ${(err as Error).message}`,
        };
    }
}

function configureCodexToml(
    client: AiClient,
    entry: McpServerEntry,
): { success: boolean; message: string } {
    const configPath = expandHome(client.configPath);

    const dir = dirname(configPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
        try {
            config = parseToml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        } catch {
            return {
                success: false,
                message: `Failed to parse ${configPath}`,
            };
        }
    }

    if (!config.mcp_servers || typeof config.mcp_servers !== "object") {
        config.mcp_servers = {};
    }
    (config.mcp_servers as Record<string, unknown>)["1claw"] = {
        command: entry.command,
        args: entry.args,
        env: entry.env,
    };

    // Round-trips every other table in the file (e.g. a hand-added
    // [model_providers.*] section) correctly, but re-serializes it —
    // comments and original key ordering are not preserved.
    writeCredentialFile(configPath, stringifyToml(config));

    return {
        success: true,
        message: `Configured ${client.name} at ${configPath}`,
    };
}
