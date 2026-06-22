import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

export interface AiClient {
    name: string;
    slug: string;
    configPath: string;
    configFormat: "mcpServers" | "servers" | "zed" | "claude-code";
    detected: boolean;
}

function expandHome(p: string): string {
    return p.replace(/^~/, homedir());
}

function resolveGlobalMcpBinary(): string {
    try {
        const resolved = execSync("which 1claw-mcp 2>/dev/null", {
            encoding: "utf-8",
        }).trim();
        if (resolved) return resolved;
    } catch {
        // not found globally
    }
    return "";
}

export function detectAiClients(): AiClient[] {
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
        },
        {
            name: "Cursor",
            slug: "cursor",
            configPath: "~/.cursor/mcp.json",
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
            configPath: "~/.vscode/mcp.json",
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
                execSync("which claude 2>/dev/null", { encoding: "utf-8" });
                client.detected = true;
            } catch {
                client.detected = false;
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
    }

    const tmpPath = configPath + ".1claw-tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const { renameSync } = require("node:fs");
    renameSync(tmpPath, configPath);

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

    const cmdParts = [
        "claude", "mcp", "add",
        "-s", "user",
        ...envArgs,
        "1claw",
        "--",
        entry.command,
        ...entry.args,
    ];

    try {
        execSync(cmdParts.join(" "), {
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
