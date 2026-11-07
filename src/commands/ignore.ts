import { Command } from "commander";
import { banner, shouldShowBanner } from "../banner.js";
import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { canAsk, chooseProjectVault } from "../lib/project-setup.js";
import { installSkill, skillStatus } from "../lib/skill-install.js";
import inquirer from "inquirer";
import { printInfo, printJson, printSuccess, printTable, printWarning } from "../output.js";
import {
    encodeDataKey,
    envelopePath,
    findEnvFiles,
    isEnvelopeFile,
    newDataKey,
    open,
    readEnvelope,
    seal,
    serializeEnvelope,
} from "../lib/env-file.js";
import { assertHumanTerminal, fetchDataKey } from "../lib/env-source.js";
import {
    AGENTS,
    agentHasRules,
    detectAgents,
    parseAgentList,
    writeAgent,
    writeGitignore,
    type AgentId,
} from "../lib/agent-ignore.js";

/**
 * `1claw ignore`: take a project's env files away from coding agents.
 *
 * 1. Writes ignore rules for the agents in use (Claude Code, Cursor, OpenCode,
 *    and others it finds), and keeps env files out of git.
 * 2. Encrypts each env file to `<file>.1claw` with a fresh key stored in your
 *    vault, checks the copy decrypts, then deletes the plaintext.
 *
 * Only names are ever printed. Getting the values into 1Claw proper is the next
 * step, `1claw env import`, which an agent may run because it prints no values.
 */
export const ignoreCommand = new Command("ignore")
    .description("Protect env files from AI coding agents: write their ignore rules and encrypt the files with a key held in 1Claw")
    .argument("[files...]", "Env files to protect (default: every real env file here, e.g. .env, .env.local; not .env.example)")
    .option("-v, --vault <id>", "Vault that holds the encryption keys")
    .option("--agents <list>", `Agents to write rules for: ${Object.keys(AGENTS).join(",")} or all (default: Claude Code, Cursor, OpenCode, plus any found here)`)
    .option("--no-encrypt", "Only write ignore rules; leave env files as they are")
    .option("--keep-plaintext", "Keep the original file next to the encrypted copy")
    .option("--no-gitignore", "Do not add env files to .gitignore")
    .option("--force", "Re-encrypt even if an encrypted copy already exists")
    .option("--no-skill", "Don't offer to install the env-to-1claw skill")
    .option("-y, --yes", "If this project has no vault, use one named after the folder without asking")
    .option("--json", "Output as JSON")
    .addHelpText(
        "after",
        `
What each agent's rules block (from each tool's docs):
  Claude Code   .claude/settings.json deny rules: Read/Grep/Glob/@ and shell commands that name the file
  Cursor        .cursorignore: Agent, Tab, @ — not its terminal
  OpenCode      opencode.json permission.read — shell not documented
  Others        .devinignore, .geminiignore, .aiderignore, .clineignore, .aiexclude
  Codex         no project-level file; deny reads in ~/.codex/config.toml yourself

No ignore rule is a lock, which is why the file is also encrypted.

Next: 1claw env import            send the values to your vault (prints names only)
      1claw ignore status         see what is protected
      1claw ignore restore        decrypt back to a plain file (your terminal only)`,
    )
    .action(async (files: string[], opts) => {
        try {
            await runIgnore(files, opts);
        } catch (err) {
            handleError(err);
        }
    });

interface IgnoreOpts {
    vault?: string;
    agents?: string;
    encrypt: boolean;
    keepPlaintext?: boolean;
    gitignore: boolean;
    force?: boolean;
    yes?: boolean;
    skill: boolean;
    json?: boolean;
}

/** Offer the skill to a person using Claude Code. It's never installed unasked, or by an agent. */
async function offerSkill(dir: string, agents: AgentId[], opts: IgnoreOpts): Promise<boolean> {
    if (!agents.includes("claude") || !opts.skill || opts.json) return false;
    const status = skillStatus(dir);
    if (status === "current") return true;
    if (!canAsk()) return false;
    const { install } = await inquirer.prompt<{ install: boolean }>([
        {
            type: "confirm",
            name: "install",
            message: `${status === "outdated" ? "Update" : "Install"} the env-to-1claw skill for Claude Code?`,
            default: true,
        },
    ]);
    if (!install) return false;
    printSuccess(`Skill added to ${chalk.bold(installSkill(dir))}`);
    return true;
}

async function runIgnore(args: string[], opts: IgnoreOpts): Promise<void> {
    if (!opts.json && shouldShowBanner()) console.log(banner("Protect this project's env files"));
    const dir = process.cwd();
    const files = args.length ? args : findEnvFiles(dir);
    for (const f of files) {
        if (isEnvelopeFile(f)) throw new Error(`${f} is already encrypted`);
        if (!existsSync(f)) throw new Error(`No such file: ${f}`);
    }

    // 1. Agent rules and .gitignore, whether or not there is anything to encrypt yet.
    const agents: AgentId[] = opts.agents ? parseAgentList(opts.agents) : detectAgents(dir);
    // Check the vault first, so a missing login or vault changes nothing on disk.
    if (opts.encrypt && files.length) requireToken();
    const vaultId = opts.encrypt && files.length ? await chooseProjectVault({ vault: opts.vault, yes: opts.yes, quiet: opts.json }) : "";

    const rules = agents.map((a) => ({ agent: a, ...writeAgent(dir, a, files) }));
    const gitignoreChanged = opts.gitignore ? writeGitignore(dir) : false;

    // 2. Encrypt.
    const sealed: { file: string; envelope: string; names: number; plaintext: "deleted" | "kept" }[] = [];
    if (opts.encrypt && files.length) {
        for (const file of files) {
            const target = envelopePath(file);
            if (existsSync(target) && !opts.force) {
                throw new Error(`${target} already exists. Use --force to re-encrypt ${file} with a new key.`);
            }
            const plaintext = readFileSync(file, "utf8");
            const { key, path } = newDataKey();

            // Key first: an envelope whose key never reached the vault would be unrecoverable.
            await api(`/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`, {
                method: "PUT",
                body: {
                    type: "password",
                    value: encodeDataKey(key),
                    metadata: { purpose: "1claw ignore: key for an encrypted env file", source: file },
                },
            });
            const envelope = seal(plaintext, key, file, { vault_id: vaultId, path });
            if (open(envelope, key) !== plaintext) throw new Error(`Encrypting ${file} did not round-trip; nothing was deleted.`);
            writeFileSync(target, serializeEnvelope(envelope), { mode: 0o600 });
            chmodSync(target, 0o600);

            if (!opts.keepPlaintext) unlinkSync(file);
            sealed.push({ file, envelope: target, names: envelope.names.length, plaintext: opts.keepPlaintext ? "kept" : "deleted" });
        }
    }

    if (opts.json) {
        printJson({ rules, gitignore: gitignoreChanged, encrypted: sealed });
        return;
    }

    console.log();
    printTable(
        rules.map((r) => ({
            agent: AGENTS[r.agent].label,
            file: r.file,
            status: r.changed ? chalk.green("written") : chalk.dim("already set"),
            shell: AGENTS[r.agent].shellCovered,
        })),
        [
            { key: "agent", header: "Agent" },
            { key: "file", header: "Rules in" },
            { key: "status", header: "" },
            { key: "shell", header: "Also blocks shell reads" },
        ],
    );
    if (opts.gitignore) printInfo(`.gitignore ${gitignoreChanged ? "updated" : "already covers env files"}`);
    console.log();

    if (!files.length) {
        printInfo("No env files here to encrypt (templates like .env.example are left readable on purpose).");
    } else if (!opts.encrypt) {
        printWarning("Rules only (--no-encrypt). An agent with a shell can still read the files in the clear.");
    } else {
        for (const s of sealed) {
            printSuccess(
                `${chalk.bold(s.file)} → ${chalk.bold(s.envelope)} (${s.names} variable${s.names === 1 ? "" : "s"}, key in your vault; plaintext ${s.plaintext})`,
            );
        }
        console.log();
        if (await offerSkill(dir, agents, opts)) {
            printInfo(`Next: ask Claude Code to use the ${chalk.bold("env-to-1claw")} skill to move your secrets into 1Claw.`);
        } else {
            printInfo(`Next: ${chalk.bold("1claw ignore install-skill")} adds the skill that plans the move, or ${chalk.bold("1claw env import")} sends the values as env vars.`);
        }
    }
    console.log();
}

ignoreCommand
    .command("install-skill")
    .description("Add the env-to-1claw skill to this project (.claude/skills)")
    .action(() => {
        try {
            printSuccess(`Skill added to ${chalk.bold(installSkill(process.cwd()))}`);
        } catch (err) {
            handleError(err);
        }
    });

// --- status ------------------------------------------------------------------

ignoreCommand
    .command("status")
    .description("Show which env files are protected and which agents have rules")
    .option("--json", "Output as JSON")
    .action((opts) => {
        try {
            const dir = process.cwd();
            const plain = findEnvFiles(dir);
            const envelopes = listEnvelopes(dir);
            const agents = (Object.keys(AGENTS) as AgentId[]).map((a) => ({
                agent: AGENTS[a].label,
                file: AGENTS[a].file,
                rules: agentHasRules(dir, a),
            }));
            if (opts.json) {
                printJson({ plaintext: plain, encrypted: envelopes, agents });
                return;
            }
            console.log();
            if (plain.length) printWarning(`Readable env files: ${plain.join(", ")} — run ${chalk.bold("1claw ignore")}`);
            else printSuccess("No readable env files here.");
            for (const e of envelopes) printInfo(`${e.file}: ${e.names} variables, encrypted`);
            console.log();
            printTable(
                agents.map((a) => ({ ...a, rules: a.rules ? chalk.green("yes") : chalk.dim("no") })),
                [
                    { key: "agent", header: "Agent" },
                    { key: "file", header: "Rules in" },
                    { key: "rules", header: "Has 1claw rules" },
                ],
            );
            console.log();
        } catch (err) {
            handleError(err);
        }
    });

function listEnvelopes(dir: string): { file: string; names: number }[] {
    const out: { file: string; names: number }[] = [];
    for (const name of readdirSync(dir).filter(isEnvelopeFile).sort()) {
        try {
            out.push({ file: name, names: readEnvelope(name).names.length });
        } catch {
            // a .1claw file that is not an env envelope: not ours to report
        }
    }
    return out;
}

// --- restore -----------------------------------------------------------------

ignoreCommand
    .command("restore [file]")
    .description("Decrypt a .1claw file back to a plain env file (your own terminal only)")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (file: string | undefined, opts) => {
        try {
            assertHumanTerminal("`1claw ignore restore`");
            requireToken();
            const source = file ?? envelopePath(".env");
            const envelope = readEnvelope(source);
            const target = source.slice(0, -".1claw".length);
            if (existsSync(target)) throw new Error(`${target} already exists; move it first.`);
            if (!opts.yes && !(await confirm(`Write ${envelope.names.length} secret values to ${target} in the clear?`))) return;
            const key = await fetchDataKey(envelope.key.vault_id, envelope.key.path);
            writeFileSync(target, open(envelope, key), { mode: 0o600 });
            printSuccess(`Restored ${chalk.bold(target)}. Agents' ignore rules still apply; the encrypted copy is untouched.`);
        } catch (err) {
            handleError(err);
        }
    });

async function confirm(message: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    return new Promise((resolve) => {
        rl.question(`${message} (y/N) `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
