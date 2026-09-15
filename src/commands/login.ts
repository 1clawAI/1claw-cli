import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
    loginWithDevice,
    loginWithCredentials,
    completeMfaLogin,
} from "../auth.js";
import { getAuth, clearAuth, getConfigPath, setApiUrl } from "../config.js";
import {
    printSuccess,
    printError,
    printKeyValue,
    printInfo,
    printWarning,
} from "../output.js";
import { handleError } from "../middleware.js";

export const loginCommand = new Command("login")
    .description("Authenticate with 1Claw")
    .option("--email", "Use email/password instead of browser login")
    .option("--api-url <url>", "Override the API URL")
    .action(async (opts) => {
        try {
            if (opts.apiUrl) {
                setApiUrl(opts.apiUrl);
                printInfo(`API URL set to ${opts.apiUrl}`);
            }

            if (opts.email) {
                const answers = await inquirer.prompt([
                    { type: "input", name: "email", message: "Email:" },
                    {
                        type: "password",
                        name: "password",
                        message: "Password:",
                        mask: "•",
                    },
                ]);

                const result = await loginWithCredentials(
                    answers.email,
                    answers.password,
                );
                if (!result) return;

                if ((result as any).mfaToken) {
                    const mfa = await inquirer.prompt([
                        {
                            type: "input",
                            name: "code",
                            message: "MFA code (from authenticator app):",
                        },
                    ]);
                    const finalAuth = await completeMfaLogin(
                        (result as any).mfaToken,
                        mfa.code,
                    );
                    if (!finalAuth) return;
                    printSuccess(`Logged in as ${chalk.bold(finalAuth.email)}`);
                    noteSessionOnAgentHost();
                    return;
                }

                printSuccess(`Logged in as ${chalk.bold(result.email)}`);
                noteSessionOnAgentHost();
                return;
            }

            const auth = await loginWithDevice();
            if (auth) {
                printSuccess(`Logged in as ${chalk.bold(auth.email)}`);
                noteSessionOnAgentHost();
            }
        } catch (err) {
            handleError(err);
        }
    });

/**
 * The session token is written to the config file, readable by this Unix
 * user. On a machine where an agent runs as the same user, the agent can
 * read it too — the local vault and daemon policy do not cover it. Say so
 * when the machine looks like one (a local vault or daemon is present).
 */
function noteSessionOnAgentHost(): void {
    const configDir = process.env.ONECLAW_CONFIG_DIR ?? join(homedir(), ".config", "1claw");
    const agentHost = existsSync(join(configDir, "daemon.sock")) || existsSync(join(configDir, "daemon.pid")) || existsSync(process.env.ONECLAW_LOCAL_VAULT ?? join(configDir, "local-vault.enc"));
    if (!agentHost) return;
    printWarning(
        "This session token is stored in the CLI config, readable by this Unix user. An agent running as the same user can use it; the local vault policy does not cover it.",
    );
    printInfo("Run `1claw logout` when you are done here, or run the agent as its own user (`1claw daemon start --socket-group <group>`).");
}

export const logoutCommand = new Command("logout")
    .description("Clear stored credentials")
    .action(() => {
        clearAuth();
        printSuccess("Logged out. Credentials removed.");
    });

export const whoamiCommand = new Command("whoami")
    .description("Show current authenticated user")
    .action(async () => {
        try {
            const auth = getAuth();
            if (!auth) {
                printError("Not authenticated. Run `1claw login` first.");
                process.exit(1);
            }

            if (auth.email === "env") {
                printInfo(
                    "Authenticated via ONECLAW_TOKEN environment variable.",
                );
                return;
            }

            printKeyValue([
                ["Email", auth.email],
                ["User ID", auth.userId],
                ["Org ID", auth.orgId],
                ["Token expires", auth.expiresAt ?? "unknown"],
                ["Config", getConfigPath()],
            ]);
        } catch (err) {
            handleError(err);
        }
    });
