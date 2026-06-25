import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
    printSuccess,
    printError,
    printWarning,
    printInfo,
    printKeyValue,
} from "../output.js";
import {
    dockerBuild,
    dockerTag,
    dockerPush,
    dockerCommit,
    dockerContainerStatus,
} from "../lib/docker-client.js";
import { buildModuleImage, DEFAULT_BASE_IMAGE } from "../lib/image-build.js";
import { resolveModules } from "../modules/registry.js";
import {
    loadContainerState,
    saveContainerState,
} from "../lib/container-config.js";

interface PublishOptions {
    name?: string;
    tag?: string;
    registry?: string;
    dockerfile?: string;
    context?: string;
    commit?: boolean;
}

export const publishCommand = new Command("publish")
    .description("Build and push your custom agent container to a registry")
    .option("--name <name>", "Container name (from `1claw init` state)")
    .option("--tag <tag>", "Image tag (default: {name}:latest)")
    .option("--registry <url>", "Registry URL (default: docker.io)")
    .option("--dockerfile <path>", "Custom Dockerfile (build from context)")
    .option("--context <path>", "Build context directory (default: .)")
    .option("--commit", "Snapshot a running container via `docker commit`")
    .action(async (opts: PublishOptions) => {
        try {
            await publishAction(opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function resolveTag(opts: PublishOptions, fallbackName: string): string {
    let tag = opts.tag ?? `${fallbackName}:latest`;
    if (opts.registry && !tag.startsWith(opts.registry)) {
        const host = opts.registry.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (host && host !== "docker.io") tag = `${host}/${tag}`;
    }
    if (!opts.tag) {
        printWarning(
            `No --tag given; using "${tag}". For Docker Hub use --tag <username>/<name>:<version>.`,
        );
    }
    return tag;
}

async function publishAction(opts: PublishOptions): Promise<void> {
    console.log();

    // CASE B — custom Dockerfile / current directory (no --name).
    if (!opts.name) {
        const context = resolve(opts.context ?? ".");
        const dockerfile = opts.dockerfile
            ? resolve(opts.dockerfile)
            : join(context, "Dockerfile");
        if (!existsSync(dockerfile)) {
            throw new Error(
                "No --name and no Dockerfile found. Provide --name <container> or run from a directory with a Dockerfile.",
            );
        }
        const tag = resolveTag(opts, "1claw-agent");
        const buildSpinner = ora(`Building from ${dockerfile}...`).start();
        try {
            await dockerBuild({
                context,
                dockerfile,
                tag,
                onProgress: (l) => (buildSpinner.text = chalk.dim(l.slice(0, 70))),
            });
            buildSpinner.succeed(`Built ${tag}`);
        } catch (err) {
            buildSpinner.fail("Build failed.");
            throw err;
        }
        await pushTag(tag);
        printPullHint(tag);
        return;
    }

    // CASE A / C — publish a container created by `1claw init`.
    const state = loadContainerState(opts.name);
    if (!state) {
        throw new Error(
            `No container state for "${opts.name}". Was it created with \`1claw init\`?`,
        );
    }
    const tag = resolveTag(opts, state.containerName);

    let sourceImage: string;

    if (opts.commit) {
        // CASE C — snapshot runtime state.
        const status = await dockerContainerStatus(state.containerName);
        if (!status.exists) {
            throw new Error(`Container "${state.containerName}" not found to commit.`);
        }
        printWarning(
            "Publishing from a container commit (not a Dockerfile). " +
                "For reproducible builds, prefer building from a Dockerfile.",
        );
        const commitSpinner = ora(`Committing ${state.containerName}...`).start();
        try {
            sourceImage = `1claw-commit-${state.containerName}:latest`;
            await dockerCommit(state.containerName, sourceImage);
            commitSpinner.succeed("Container committed.");
        } catch (err) {
            commitSpinner.fail("Commit failed.");
            throw err;
        }
    } else if (state.modules.length > 0) {
        // CASE A — rebuild reproducibly from base + modules.
        const modules = resolveModules(state.modules);
        const baseImage = state.image || DEFAULT_BASE_IMAGE;
        const buildSpinner = ora(
            `Rebuilding from base + modules (${modules.map((m) => m.name).join(", ")})...`,
        ).start();
        try {
            const { tag: builtTag } = await buildModuleImage(
                baseImage,
                modules,
                (l) => (buildSpinner.text = chalk.dim(l.slice(0, 70))),
            );
            sourceImage = builtTag;
            buildSpinner.succeed("Rebuilt module image.");
        } catch (err) {
            buildSpinner.fail("Rebuild failed.");
            throw err;
        }
    } else {
        // No modules — publish the base/custom image directly.
        sourceImage = state.customImage ?? state.image;
    }

    const tagSpinner = ora(`Tagging ${sourceImage} → ${tag}...`).start();
    try {
        await dockerTag(sourceImage, tag);
        tagSpinner.succeed(`Tagged ${tag}`);
    } catch (err) {
        tagSpinner.fail("Tag failed.");
        throw err;
    }

    await pushTag(tag);

    state.customImage = tag;
    state.publishedAt = new Date().toISOString();
    saveContainerState(state);

    printPullHint(tag);
}

async function pushTag(tag: string): Promise<void> {
    const spinner = ora(`Pushing ${tag}...`).start();
    try {
        await dockerPush(tag, (l) => (spinner.text = chalk.dim(l.slice(0, 70))));
        spinner.succeed(`Pushed ${tag}`);
    } catch (err) {
        spinner.fail("Push failed.");
        const msg = err instanceof Error ? err.message : String(err);
        if (/denied|unauthorized|authentication required/i.test(msg)) {
            printError(
                "Registry authentication failed. Run `docker login` first, then retry.",
            );
        }
        throw err;
    }
}

function printPullHint(tag: string): void {
    console.log();
    printSuccess("Published.");
    printKeyValue([["Image", tag], ["Pull", `docker pull ${tag}`]]);
    console.log();
    printInfo("Deploy it to the cloud with `1claw deploy --google-cloud --name <name>`.");
    console.log();
}
