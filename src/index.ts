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
import {
    setPasswordCommand,
    changeEmailCommand,
} from "./commands/account.js";
import { authCommand } from "./commands/auth.js";
import { vaultCommand } from "./commands/vault.js";
import { secretCommand } from "./commands/secret.js";
import { envCommand } from "./commands/env.js";
import { agentCommand } from "./commands/agent.js";
import { cardCommand } from "./commands/card.js";
import { policyCommand } from "./commands/policy.js";
import { shareCommand } from "./commands/share.js";
import { billingCommand } from "./commands/billing.js";
import { auditCommand } from "./commands/audit.js";
import { mfaCommand } from "./commands/mfa.js";
import { configCommand } from "./commands/config.js";
import { setupCommand } from "./commands/setup.js";
import { importCommand } from "./commands/import.js";
import { localCommand } from "./commands/local.js";
import { daemonCommand } from "./commands/daemon.js";
import { proxyCommand } from "./commands/proxy.js";
import { treasuryCommand } from "./commands/treasury.js";
import { webhookCommand } from "./commands/webhook.js";
import { platformCommand } from "./commands/platform.js";
import { deviceCommand } from "./commands/device.js";
import { approvalCommand } from "./commands/approval.js";
import { connectorCommand } from "./commands/connector.js";
import { notifyCommand } from "./commands/notify.js";
import { applyCommand, diffCommand } from "./commands/chart.js";
import { initCommand } from "./commands/init.js";
import { spawnCommand } from "./commands/spawn.js";
import { publishCommand } from "./commands/publish.js";
import { ejectCommand } from "./commands/eject.js";
import { containersCommand } from "./commands/containers.js";
import { deployCommand } from "./commands/deploy.js";
import { automationCommand } from "./commands/automation.js";
import { memoryCommand } from "./commands/memory.js";
import { runtimeCommand } from "./commands/runtime.js";
import { directoryCommand } from "./commands/directory.js";
import { chatCommand } from "./commands/chat.js";
import { channelCommand } from "./commands/channel.js";
import { oauthCommand } from "./commands/oauth.js";
import { cedarPolicyCommand } from "./commands/cedar-policy.js";
import { opaPolicyCommand } from "./commands/opa-policy.js";
import { policyBackendCommand } from "./commands/policy-backend.js";
import { guardrailsCommand } from "./commands/guardrails.js";
import { contractAbiCommand } from "./commands/contract-abi.js";
import { pendingApprovalCommand } from "./commands/pending-approval.js";
import { browserCommand } from "./commands/browser.js";
import { subOrgCommand } from "./commands/sub-org.js";
import { portfolioCommand } from "./commands/portfolio.js";
import { safeCommand } from "./commands/safe.js";
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
        )
        // Required by `platform exec` (.passThroughOptions) under Commander 13+
        .enablePositionalOptions();

    // Auth
    program.addCommand(loginCommand);
    program.addCommand(logoutCommand);
    program.addCommand(whoamiCommand);
    program.addCommand(forgotPasswordCommand);
    program.addCommand(resetPasswordCommand);
    program.addCommand(setPasswordCommand);
    program.addCommand(changeEmailCommand);
    program.addCommand(authCommand);

    // Core resources
    program.addCommand(vaultCommand);
    program.addCommand(secretCommand);
    program.addCommand(envCommand);
    program.addCommand(agentCommand);
    program.addCommand(cardCommand);
    program.addCommand(policyCommand);

    // Sharing
    program.addCommand(shareCommand);

    // Billing
    program.addCommand(billingCommand);

    // Security
    program.addCommand(auditCommand);
    program.addCommand(mfaCommand);

    // Setup, import & local vault
    program.addCommand(setupCommand);
    program.addCommand(importCommand);
    program.addCommand(localCommand);
    program.addCommand(daemonCommand);

    // Containerized agent runtime
    program.addCommand(initCommand);
    program.addCommand(spawnCommand);
    program.addCommand(publishCommand);
    program.addCommand(ejectCommand);
    program.addCommand(containersCommand);
    program.addCommand(deployCommand);

    // Config
    program.addCommand(configCommand);

    // Treasury
    program.addCommand(treasuryCommand);

    // Webhooks
    program.addCommand(webhookCommand);

    // Proxy
    program.addCommand(proxyCommand);

    // Platform
    program.addCommand(platformCommand);

    // Mobile companion
    program.addCommand(deviceCommand);
    program.addCommand(approvalCommand);
    program.addCommand(connectorCommand);
    program.addCommand(notifyCommand);
    program.addCommand(applyCommand);
    program.addCommand(diffCommand);

    // Automations, Memory & Runtimes
    program.addCommand(automationCommand);
    program.addCommand(memoryCommand);
    program.addCommand(runtimeCommand);
    program.addCommand(directoryCommand);

    // Agent Communication
    program.addCommand(chatCommand);
    program.addCommand(channelCommand);

    // OAuth Connected Accounts
    program.addCommand(oauthCommand);

    // Policy engines
    program.addCommand(cedarPolicyCommand);
    program.addCommand(opaPolicyCommand);
    program.addCommand(policyBackendCommand);
    program.addCommand(guardrailsCommand);
    program.addCommand(contractAbiCommand);
    program.addCommand(pendingApprovalCommand);

    // Sub-organizations
    program.addCommand(browserCommand);
    program.addCommand(subOrgCommand);

    // Portfolio
    program.addCommand(portfolioCommand);

    // Safe (Phase 5)
    program.addCommand(safeCommand);

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
