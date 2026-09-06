import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printInfo, printJson, printSuccess } from "../output.js";

/**
 * `1claw diff` — a thin client over POST /v1/org/apply/diff.
 *
 * There is deliberately no reconcile logic here. The server's
 * `chart_reconciler` is the only implementation: two of them would drift, and
 * the drift would show up as a CLI that provisions differently from a platform
 * rollout. This file parses YAML, posts it, and renders what comes back.
 */

const STATE_PATH = ".1claw/apply-state.json";

interface ResourceAction {
    action: "create" | "patch" | "unchanged" | "skipped_drifted" | "refused";
    kind: string;
    name: string;
    fields?: string[];
    drifted_fields?: string[];
    reason?: string;
}

interface DiffResponse {
    chart_name: string;
    actions: ResourceAction[];
    warnings: string[];
    summary: {
        create: number;
        patch: number;
        skipped_drifted: number;
        unchanged: number;
        refused: number;
        no_changes: boolean;
    };
}

function loadChart(file: string): unknown {
    const path = resolve(file);
    if (!existsSync(path)) {
        console.error(chalk.red(`No such file: ${file}`));
        process.exit(1);
    }
    const raw = readFileSync(path, "utf8");
    try {
        return parseYaml(raw);
    } catch (e) {
        console.error(chalk.red(`${file} is not valid YAML:`));
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}

function loadAppliedState(): Record<string, unknown> {
    if (!existsSync(STATE_PATH)) return {};
    try {
        return JSON.parse(readFileSync(STATE_PATH, "utf8"));
    } catch {
        // A corrupt state file must not be treated as "nothing applied" — that
        // would report every existing resource as a create, and hide drift
        // entirely. Stop and let a human look at it.
        console.error(
            chalk.red(`${STATE_PATH} is not valid JSON. Fix or delete it before continuing.`),
        );
        process.exit(1);
    }
}

function renderPlan(res: DiffResponse): void {
    console.log(chalk.bold(`\nChart: ${res.chart_name}\n`));

    for (const a of res.actions) {
        const label = `${a.kind}/${a.name}`;
        switch (a.action) {
            case "create":
                console.log(`  ${chalk.green("+")} ${label}`);
                break;
            case "patch":
                console.log(
                    `  ${chalk.yellow("~")} ${label} ${chalk.dim(`(${(a.fields ?? []).join(", ")})`)}`,
                );
                break;
            case "unchanged":
                console.log(`  ${chalk.dim("=")} ${chalk.dim(label)}`);
                break;
            case "skipped_drifted":
                console.log(
                    `  ${chalk.yellow("!")} ${label} ${chalk.yellow(
                        `changed outside this chart (${(a.drifted_fields ?? []).join(", ")}) — left alone`,
                    )}`,
                );
                break;
            case "refused":
                console.log(`  ${chalk.red("✗")} ${label} ${chalk.red(a.reason ?? "refused")}`);
                break;
        }
    }

    const s = res.summary;
    console.log("");
    if (s.no_changes) {
        printSuccess("No changes — the chart matches what is deployed.");
    } else {
        console.log(
            `  ${chalk.green(`${s.create} to create`)}, ` +
                `${chalk.yellow(`${s.patch} to update`)}, ` +
                `${chalk.dim(`${s.unchanged} unchanged`)}`,
        );
    }
    if (s.skipped_drifted > 0 || s.refused > 0) {
        console.log(
            `  ${chalk.yellow(`${s.skipped_drifted} skipped`)}, ` +
                `${chalk.red(`${s.refused} refused`)}`,
        );
    }

    if (res.warnings.length > 0) {
        console.log("");
        for (const w of res.warnings) console.log(`  ${chalk.yellow("warning:")} ${w}`);
    }
    console.log("");
}

export const diffCommand = new Command("diff")
    .description("Show what a chart would change, without changing anything")
    .requiredOption("-f, --file <chart.yaml>", "Chart file")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const chart = loadChart(opts.file);
            const res = await api<DiffResponse>("/org/apply/diff", {
                method: "POST",
                body: { chart, applied_state: loadAppliedState() },
            });
            if (opts.json) {
                printJson(res);
                return;
            }
            renderPlan(res);
        } catch (e) {
            handleError(e);
        }
    });

export const applyCommand = new Command("apply")
    .description("Apply a chart (use --dry-run to preview)")
    .requiredOption("-f, --file <chart.yaml>", "Chart file")
    .option("--dry-run", "Validate and print the plan without applying")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const chart = loadChart(opts.file);
            const res = await api<DiffResponse>("/org/apply/diff", {
                method: "POST",
                body: { chart, applied_state: loadAppliedState() },
            });

            if (opts.json) {
                printJson(res);
                return;
            }
            renderPlan(res);

            if (opts.dryRun) {
                printInfo("Dry run — nothing was changed.");
                return;
            }

            // Writing apply is the next step; until it exists, saying so beats
            // reporting a success that did not happen.
            printInfo(
                "Applying is not enabled yet — this preview is the diff. Re-run with --dry-run to silence this.",
            );
        } catch (e) {
            handleError(e);
        }
    });

/** Persist what an apply set, so the next run can tell drift from a first run. */
export function writeAppliedState(state: Record<string, unknown>): void {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}
