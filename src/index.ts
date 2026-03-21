import { Command } from "commander";
import {
    loginCommand,
    logoutCommand,
    whoamiCommand,
} from "./commands/login.js";
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

export function createProgram(): Command {
    const program = new Command("1claw")
        .version("0.10.2")
        .description(
            "1Claw CLI — HSM-backed secret management for AI agents and humans",
        );

    // Auth
    program.addCommand(loginCommand);
    program.addCommand(logoutCommand);
    program.addCommand(whoamiCommand);

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
