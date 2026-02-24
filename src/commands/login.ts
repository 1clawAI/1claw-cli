import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
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
                    return;
                }

                printSuccess(`Logged in as ${chalk.bold(result.email)}`);
                return;
            }

            const auth = await loginWithDevice();
            if (auth) {
                printSuccess(`Logged in as ${chalk.bold(auth.email)}`);
            }
        } catch (err) {
            handleError(err);
        }
    });

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
