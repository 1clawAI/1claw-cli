import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    copyFileSync,
    writeFileSync,
    readdirSync,
} from "node:fs";
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
import { loadContainerState, saveContainerState } from "../lib/container-config.js";
import { deployTemplateDir } from "../lib/paths.js";

interface DeployOptions {
    googleCloud?: boolean;
    aws?: boolean;
    fly?: boolean;
    name?: string;
    region: string;
    serviceName?: string;
    apply?: boolean;
    output: string;
}

export const deployCommand = new Command("deploy")
    .description("Deploy your agent container to the cloud")
    .option("--google-cloud", "Deploy to Google Cloud Run")
    .option("--aws", "Deploy to AWS ECS/Fargate (coming soon)")
    .option("--fly", "Deploy to Fly.io (coming soon)")
    .option("--name <name>", "Container name (from `1claw init` state)")
    .option("--region <region>", "Cloud region", "us-central1")
    .option("--service-name <name>", "Cloud service name")
    .option("--apply", "Run terraform apply automatically")
    .option("--output <dir>", "Output directory for generated files", "./terraform")
    .action(async (opts: DeployOptions) => {
        try {
            await deployAction(opts);
        } catch (err) {
            printError(err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

function run(
    cmd: string,
    args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
    return new Promise((resolve) => {
        execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                stdout: stdout?.toString() ?? "",
                stderr: stderr?.toString() ?? "",
                ok: !err,
            });
        });
    });
}

function runStreaming(cmd: string, args: string[], cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, stdio: "inherit" });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}

async function commandExists(cmd: string, versionArg = "--version"): Promise<boolean> {
    const r = await run(cmd, [versionArg]);
    return r.ok;
}

async function deployAction(opts: DeployOptions): Promise<void> {
    console.log();

    if (opts.aws || opts.fly) {
        printWarning(
            `${opts.aws ? "AWS" : "Fly.io"} deployment is coming soon. ` +
                "Only --google-cloud is implemented today.",
        );
        return;
    }
    if (!opts.googleCloud) {
        printInfo("Choose a target. Currently supported: --google-cloud");
        printInfo("  1claw deploy --google-cloud --name <container>");
        return;
    }

    // ── Step 1: Load state ───────────────────────────────────────────────
    if (!opts.name) {
        throw new Error("Provide --name <container> (from `1claw init`).");
    }
    const state = loadContainerState(opts.name);
    if (!state) {
        throw new Error(`No container state for "${opts.name}".`);
    }

    // ── Step 2: Prerequisites ────────────────────────────────────────────
    const tfOk = await commandExists("terraform");
    if (!tfOk) {
        throw new Error(
            "Terraform is not installed. Install it: https://developer.hashicorp.com/terraform/install",
        );
    }
    const gcloudOk = await commandExists("gcloud");
    if (!gcloudOk) {
        printWarning(
            "gcloud CLI not found. You can still generate Terraform, but `--apply` needs gcloud auth.",
        );
    }

    // ── Step 3: Image source ─────────────────────────────────────────────
    if (!state.customImage) {
        throw new Error(
            "This container has no published image. Push it first:\n" +
                `  1claw publish --name ${state.containerName} --tag <username>/${state.containerName}:latest`,
        );
    }

    // Resolve a default project from gcloud config (best-effort).
    let projectId = "YOUR_GCP_PROJECT_ID";
    if (gcloudOk) {
        const r = await run("gcloud", ["config", "get-value", "project"]);
        const val = r.stdout.trim();
        if (r.ok && val && val !== "(unset)") projectId = val;
    }

    const serviceName = opts.serviceName ?? state.containerName.replace(/[^a-z0-9-]/g, "-");

    // ── Step 4: Generate Terraform ───────────────────────────────────────
    const outDir = resolve(opts.output);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const tplDir = deployTemplateDir("google-cloud");
    for (const file of readdirSync(tplDir)) {
        if (file.endsWith(".tf")) {
            copyFileSync(join(tplDir, file), join(outDir, file));
        }
    }

    const tfvars =
        `project_id    = "${projectId}"\n` +
        `region        = "${opts.region}"\n` +
        `service_name  = "${serviceName}"\n` +
        `image_tag     = "${state.customImage}"\n` +
        `agent_id      = "${state.agentId ?? ""}"\n` +
        `modules       = "${state.modules.join(",")}"\n` +
        `# agent_api_key is sensitive — provide it at apply time instead of committing it:\n` +
        `#   export TF_VAR_agent_api_key="ocv_..."\n`;
    writeFileSync(join(outDir, "terraform.tfvars"), tfvars);

    printSuccess(`Terraform written to ${outDir}`);
    printKeyValue([
        ["Provider", "Google Cloud Run"],
        ["Project", projectId],
        ["Region", opts.region],
        ["Service", serviceName],
        ["Image", state.customImage],
    ]);
    console.log();

    // ── Step 5: Print or apply ───────────────────────────────────────────
    if (!opts.apply) {
        printInfo("Review the files, then deploy:");
        console.log(chalk.dim(`  cd ${outDir}`));
        console.log(chalk.dim(`  export TF_VAR_agent_api_key="ocv_..."`));
        console.log(chalk.dim(`  terraform init && terraform apply`));
        console.log();
        return;
    }

    if (!process.env.TF_VAR_agent_api_key) {
        throw new Error(
            "TF_VAR_agent_api_key is not set. Export the agent API key before --apply:\n" +
                '  export TF_VAR_agent_api_key="ocv_..."',
        );
    }

    const initSpinner = ora("terraform init...").start();
    initSpinner.stop();
    if (!(await runStreaming("terraform", ["init"], outDir))) {
        throw new Error("terraform init failed.");
    }
    if (!(await runStreaming("terraform", ["apply", "-auto-approve"], outDir))) {
        throw new Error("terraform apply failed.");
    }

    const urlRes = await run("terraform", ["-chdir=" + outDir, "output", "-raw", "service_url"]);
    const serviceUrl = urlRes.ok ? urlRes.stdout.trim() : undefined;

    state.deployment = {
        provider: "google-cloud-run",
        serviceUrl,
        region: opts.region,
        deployedAt: new Date().toISOString(),
    };
    saveContainerState(state);

    console.log();
    printSuccess("Deployed to Google Cloud Run.");
    if (serviceUrl) printKeyValue([["Service URL", chalk.cyan(serviceUrl)]]);
    console.log();
}
