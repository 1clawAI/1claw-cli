import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
    loginCommand,
    logoutCommand,
    whoamiCommand,
} from "./commands/login.js";
import {
    forgotPasswordCommand,
    resetPasswordCommand,
} from "./commands/password-reset.js";
import { authCommand } from "./commands/auth.js";
import { vaultCommand } from "./commands/vault.js";
import { secretCommand } from "./commands/secret.js";
import { envCommand } from "./commands/env.js";
import { agentCommand } from "./commands/agent.js";
import { policyCommand } from "./commands/policy.js";
import { shareCommand } from "./commands/share.js";
import { billingCommand } from "./commands/billing.js";
import { auditCommand } from "./commands/audit.js";
import { mfaCommand } from "./commands/mfa.js";
import { configCommand } from "./commands/config.js";
import { proxyCommand } from "./commands/proxy.js";
import { setOutputFormat, setApiUrl } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled to dist/src/index.js → ../../package.json; ts-node from src/ → ../package.json
const pkgJsonPath = [join(__dirname, "../../package.json"), join(__dirname, "../package.json")].find(
    (p) => existsSync(p),
);
if (!pkgJsonPath) {
    throw new Error("package.json not found next to CLI package root");
}
const cliPackageVersion = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version as string;

export function createProgram(): Command {
    const program = new Command("1claw")
        .version(cliPackageVersion)
        .description(
            "1Claw CLI — HSM-backed secret management for AI agents and humans",
        );

    // Auth
    program.addCommand(loginCommand);
    program.addCommand(logoutCommand);
    program.addCommand(whoamiCommand);
    program.addCommand(forgotPasswordCommand);
    program.addCommand(resetPasswordCommand);
    program.addCommand(authCommand);

    // Core resources
    program.addCommand(vaultCommand);
    program.addCommand(secretCommand);
    program.addCommand(envCommand);
    program.addCommand(agentCommand);
    program.addCommand(policyCommand);

    // Sharing
    program.addCommand(shareCommand);

    // Billing
    program.addCommand(billingCommand);

    // Security
    program.addCommand(auditCommand);
    program.addCommand(mfaCommand);

    // Config
    program.addCommand(configCommand);

    // Proxy
    program.addCommand(proxyCommand);

    // Global options
    program.option("--json", "Force JSON output for all commands");
    program.option("--api-url <url>", "Override API URL for this invocation");

    program.hook("preAction", () => {
        const globalOpts = program.opts();
        if (globalOpts.json) {
            setOutputFormat("json");
        }
        if (globalOpts.apiUrl) {
            setApiUrl(globalOpts.apiUrl);
        }
    });

    return program;
}
