import { Command } from "commander";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    copyFileSync,
    readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import chalk from "chalk";
import { printSuccess, printError, printInfo } from "../output.js";
import { loadContainerState } from "../lib/container-config.js";
import { resolveModules } from "../modules/registry.js";
import { generateDockerfile } from "../lib/image-build.js";
import { moduleDir, composeTemplatePath } from "../lib/paths.js";
import { DEFAULT_BASE_IMAGE } from "../lib/image-build.js";
import { daemonSocketPath } from "../lib/daemon-control.js";

interface EjectOptions {
    name?: string;
    output: string;
}

export const ejectCommand = new Command("eject")
    .description("Export Dockerfile, module configs, and docker-compose for manual control")
    .option("--name <name>", "Container name (from `1claw init` state)")
    .option("--output <dir>", "Output directory", ".")
    .action((opts: EjectOptions) => {
        try {
            ejectAction(opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function fillTemplate(tmpl: string, vars: Record<string, string>): string {
    return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function ejectAction(opts: EjectOptions): void {
    if (!opts.name) {
        throw new Error("Provide --name <container> (from `1claw init`).");
    }
    const state = loadContainerState(opts.name);
    if (!state) {
        throw new Error(`No container state for "${opts.name}".`);
    }

    const outDir = resolve(opts.output);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const baseImage = state.image || DEFAULT_BASE_IMAGE;
    const modules = state.modules.length ? resolveModules(state.modules) : [];

    // Dockerfile
    const dockerfilePath = join(outDir, "Dockerfile");
    writeFileSync(dockerfilePath, generateDockerfile(baseImage, modules));
    printSuccess(`Wrote ${dockerfilePath}`);

    // Module assets under modules/<name>/
    if (modules.length) {
        for (const m of modules) {
            for (const c of m.docker.copy) {
                const src = join(moduleDir(m.name), c.src);
                if (!existsSync(src)) continue;
                const dest = join(outDir, "modules", m.name, c.src);
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(src, dest);
            }
        }
        printSuccess(`Wrote module configs to ${join(outDir, "modules")}/`);
    }

    // docker-compose.yaml
    const composePath = join(outDir, "docker-compose.yaml");
    let composeTmpl =
        "services:\n  agent:\n    image: {{IMAGE}}\n    container_name: {{NAME}}\n";
    const tplFile = composeTemplatePath();
    if (existsSync(tplFile)) composeTmpl = readFileSync(tplFile, "utf-8");
    writeFileSync(
        composePath,
        fillTemplate(composeTmpl, {
            IMAGE: state.customImage ?? baseImage,
            NAME: state.containerName,
            PORT: String(state.port),
            DAEMON_SOCKET: daemonSocketPath(),
            AGENT_ID: state.agentId ?? "",
            MODULES: state.modules.join(","),
        }),
    );
    printSuccess(`Wrote ${composePath}`);

    console.log();
    printInfo("Build and run manually:");
    console.log(chalk.dim(`  cd ${outDir}`));
    console.log(chalk.dim(`  docker build -t ${state.containerName} .`));
    console.log(chalk.dim(`  docker compose up   # uses the daemon socket mount`));
    console.log();
    printInfo("Or publish your custom image:");
    console.log(
        chalk.dim(
            `  1claw publish --context ${outDir} --tag <username>/${state.containerName}:latest`,
        ),
    );
    console.log();
}
