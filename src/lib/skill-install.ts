/** The env-to-1claw skill ships with the CLI, so the skill and the plan format it writes always match. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // dist/src/lib
const distRoot = join(here, "..", "..");
const SKILL = "env-to-1claw";

const cliVersion = () => (JSON.parse(readFileSync(join(distRoot, "..", "package.json"), "utf8")) as { version: string }).version;
const target = (projectRoot: string) => join(projectRoot, ".claude", "skills", SKILL);

export function bundledSkillDir(): string {
    return join(distRoot, "bundled-skills", SKILL);
}

export function skillStatus(projectRoot: string): "missing" | "outdated" | "current" {
    const version = join(target(projectRoot), ".cli-version");
    if (!existsSync(join(target(projectRoot), "SKILL.md"))) return "missing";
    return existsSync(version) && readFileSync(version, "utf8").trim() === cliVersion() ? "current" : "outdated";
}

export function installSkill(projectRoot: string): string {
    const to = target(projectRoot);
    if (!existsSync(join(bundledSkillDir(), "SKILL.md"))) throw new Error("This CLI build doesn't include the env-to-1claw skill.");
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true });
    cpSync(bundledSkillDir(), to, { recursive: true });
    writeFileSync(join(to, ".cli-version"), `${cliVersion()}\n`);
    return `.claude/skills/${SKILL}`;
}
