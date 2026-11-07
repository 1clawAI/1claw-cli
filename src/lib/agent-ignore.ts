/**
 * Rules that tell coding agents not to read a project's env files.
 *
 * Each agent has its own mechanism, and they differ in what they block:
 *
 * | Agent        | Where                         | Blocks its file tools | Blocks `cat .env` in a shell        |
 * |--------------|-------------------------------|-----------------------|-------------------------------------|
 * | Claude Code  | `.claude/settings.json` deny  | yes (Read/Grep/Glob/@) | when the command names the file     |
 * | Cursor       | `.cursorignore`               | yes (Agent, Tab, @)    | no (documented)                     |
 * | OpenCode     | `opencode.json` permission    | yes                    | not documented                      |
 * | Windsurf     | `.devinignore`/`.codeiumignore` | yes                  | not documented                      |
 * | Gemini CLI   | `.geminiignore`               | tools and @            | not documented                      |
 * | Aider        | `.aiderignore`                | context                | n/a                                 |
 * | Cline        | `.clineignore`                | context and listing    | no                                  |
 * | JetBrains AI | `.aiexclude`                  | context                | n/a                                 |
 *
 * Claude Code does not read `.claudeignore` ("it has no effect", per its
 * permissions docs), so these rules go in settings instead. Codex has no
 * project-level ignore file; its read-deny lives in the user's own
 * `~/.codex/config.toml`, which this does not edit.
 *
 * None of these is a lock, which is why `1claw ignore` also encrypts the file:
 * an agent that gets past a rule reads ciphertext.
 *
 * Every writer is idempotent. Line-based files get one marked block that is
 * replaced on each run; JSON files get exactly the rules added, nothing else
 * touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AgentId = "claude" | "cursor" | "opencode" | "windsurf" | "gemini" | "aider" | "cline" | "jetbrains";

export const AGENTS: Record<AgentId, { label: string; file: string; shellCovered: string }> = {
    claude: { label: "Claude Code", file: ".claude/settings.json", shellCovered: "partly (commands that name the file)" },
    cursor: { label: "Cursor", file: ".cursorignore", shellCovered: "no" },
    opencode: { label: "OpenCode", file: "opencode.json", shellCovered: "not documented" },
    windsurf: { label: "Windsurf / Devin", file: ".devinignore", shellCovered: "not documented" },
    gemini: { label: "Gemini CLI", file: ".geminiignore", shellCovered: "not documented" },
    aider: { label: "Aider", file: ".aiderignore", shellCovered: "n/a" },
    cline: { label: "Cline", file: ".clineignore", shellCovered: "no" },
    jetbrains: { label: "JetBrains AI", file: ".aiexclude", shellCovered: "n/a" },
};

/** The three most teams use get rules by default; the rest when the project shows signs of them. */
const ALWAYS: AgentId[] = ["claude", "cursor", "opencode"];

const DETECT: Record<AgentId, string[]> = {
    claude: [".claude", "CLAUDE.md"],
    cursor: [".cursor", ".cursorignore", ".cursorrules"],
    opencode: ["opencode.json", ".opencode", "AGENTS.md"],
    windsurf: [".windsurf", ".windsurfrules", ".devinignore", ".codeiumignore", ".windsurfignore"],
    gemini: [".gemini", ".geminiignore", "GEMINI.md"],
    aider: [".aiderignore", ".aider.conf.yml", ".aider.chat.history.md"],
    cline: [".clinerules", ".clineignore"],
    jetbrains: [".idea", ".aiexclude"],
};

export function detectAgents(dir: string): AgentId[] {
    const found = (Object.keys(DETECT) as AgentId[]).filter((a) => DETECT[a].some((f) => existsSync(join(dir, f))));
    return [...new Set([...ALWAYS, ...found])];
}

export function parseAgentList(value: string): AgentId[] {
    if (value === "all") return Object.keys(AGENTS) as AgentId[];
    const ids = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = ids.filter((id) => !(id in AGENTS));
    if (unknown.length) {
        throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${Object.keys(AGENTS).join(", ")}, all`);
    }
    return ids as AgentId[];
}

// --- what to block -----------------------------------------------------------

/** gitignore-style patterns: real env files, with templates let back in. */
export function ignorePatterns(): string[] {
    return [
        ".env",
        ".env.*",
        "*.env",
        "!.env.example",
        "!.env.*.example",
        "!.env.sample",
        "!.env.template",
        "!*.1claw",
    ];
}

/**
 * Claude Code deny rules. Deny beats allow there, so `.env.*` cannot be denied
 * with `.env.example` let back in; instead the common variants and the files
 * actually present are named one by one, at any depth.
 */
export function claudeDenyRules(presentFiles: string[]): string[] {
    const variants = [
        ".env", ".env.local", ".env.development", ".env.development.local", ".env.production",
        ".env.production.local", ".env.test", ".env.test.local", ".env.staging", ".env.preview",
    ];
    const names = [...new Set([...variants, ...presentFiles])];
    return [...names.map((n) => `Read(**/${n})`), "Read(**/*.env)"];
}

// --- writers -------------------------------------------------------------------

const BEGIN = "# >>> 1claw ignore >>>";
const END = "# <<< 1claw ignore <<<";

function blockFor(lines: string[]): string {
    return [
        BEGIN,
        "# Real env files: AI agents must not read these. Values live in 1Claw;",
        "# templates (.env.example) stay readable. Managed by `1claw ignore`.",
        ...lines,
        END,
    ].join("\n");
}

/** Insert or replace the marked block in a line-based ignore file. Returns whether the file changed. */
export function upsertBlock(file: string, lines: string[]): boolean {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const block = blockFor(lines);
    const re = new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`);
    const after = re.test(before)
        ? before.replace(re, block)
        : (before && !before.endsWith("\n") ? before + "\n" : before) + (before ? "\n" : "") + block + "\n";
    if (after === before) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    return true;
}

export function hasBlock(file: string): boolean {
    return existsSync(file) && readFileSync(file, "utf8").includes(BEGIN);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJson(file: string): Record<string, unknown> {
    if (!existsSync(file)) return {};
    const text = readFileSync(file, "utf8").trim();
    if (!text) return {};
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(`${file} is not plain JSON (comments?), so it was left alone. Add the rules by hand: see \`1claw ignore --help\`.`);
    }
}

function writeJson(file: string, data: unknown, before: string): boolean {
    const after = JSON.stringify(data, null, 2) + "\n";
    if (after === before) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
    return true;
}

export function writeClaude(dir: string, presentFiles: string[]): boolean {
    const file = join(dir, AGENTS.claude.file);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const settings = readJson(file);
    const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
    const deny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
    const rules = claudeDenyRules(presentFiles);
    permissions.deny = [...deny, ...rules.filter((r) => !deny.includes(r))];
    settings.permissions = permissions;
    return writeJson(file, settings, before);
}

export function writeOpencode(dir: string): boolean {
    const file = join(dir, AGENTS.opencode.file);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const config = readJson(file);
    if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
    const permission = (config.permission ?? {}) as Record<string, unknown>;
    let read = permission.read;
    // `read: "allow"` (a single action) becomes the `*` default of a pattern map.
    if (typeof read === "string") read = { "*": read };
    const rules = (read ?? { "*": "allow" }) as Record<string, string>;
    // OpenCode applies the LAST matching pattern, so the deny rules go after
    // whatever is there, and the template allow goes after the denies.
    for (const k of ["*.env", "*.env.*", "*.env.example", "*.1claw"]) delete rules[k];
    permission.read = { ...rules, "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow", "*.1claw": "allow" };
    config.permission = permission;
    return writeJson(file, config, before);
}

/** Write rules for one agent. Returns the file written and whether it changed. */
export function writeAgent(dir: string, agent: AgentId, presentFiles: string[]): { file: string; changed: boolean } {
    if (agent === "claude") return { file: AGENTS.claude.file, changed: writeClaude(dir, presentFiles) };
    if (agent === "opencode") return { file: AGENTS.opencode.file, changed: writeOpencode(dir) };
    let name = AGENTS[agent].file;
    if (agent === "windsurf") {
        // Use whichever name the project already has; `.devinignore` is the current one.
        name = [".devinignore", ".windsurfignore", ".codeiumignore"].find((f) => existsSync(join(dir, f))) ?? ".devinignore";
    }
    return { file: name, changed: upsertBlock(join(dir, name), ignorePatterns()) };
}

export function agentHasRules(dir: string, agent: AgentId): boolean {
    if (agent === "claude") {
        try {
            const deny = ((readJson(join(dir, AGENTS.claude.file)).permissions ?? {}) as { deny?: string[] }).deny ?? [];
            return deny.includes("Read(**/.env)");
        } catch {
            return false;
        }
    }
    if (agent === "opencode") {
        try {
            const read = ((readJson(join(dir, AGENTS.opencode.file)).permission ?? {}) as { read?: Record<string, string> }).read;
            return typeof read === "object" && read?.["*.env"] === "deny";
        } catch {
            return false;
        }
    }
    const names = agent === "windsurf" ? [".devinignore", ".windsurfignore", ".codeiumignore"] : [AGENTS[agent].file];
    return names.some((n) => hasBlock(join(dir, n)));
}

/** Keep real env files (and their encrypted copies) out of git too. */
export function writeGitignore(dir: string): boolean {
    return upsertBlock(join(dir, ".gitignore"), [".env", ".env.*", "*.env", "!.env.example", "!.env.*.example", "!.env.sample", "!.env.template"]);
}
