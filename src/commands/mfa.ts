import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printKeyValue,
    printSuccess,
    printInfo,
    printWarning,
} from "../output.js";

export const mfaCommand = new Command("mfa").description(
    "Manage two-factor authentication",
);

mfaCommand
    .command("status")
    .description("Check MFA status")
    .action(async () => {
        try {
            requireToken();
            const status = await api<{ enabled: boolean }>("/auth/mfa/status");

            printKeyValue([
                [
                    "MFA",
                    status.enabled
                        ? chalk.green("Enabled")
                        : chalk.yellow("Disabled"),
                ],
            ]);

            if (!status.enabled) {
                printInfo(
                    "Run `1claw mfa enable` to set up two-factor authentication.",
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

mfaCommand
    .command("enable")
    .description("Enable TOTP two-factor authentication")
    .action(async () => {
        try {
            requireToken();

            const setup = await api<{
                otpauth_uri: string;
                secret: string;
            }>("/auth/mfa/setup", { method: "POST" });

            console.log();
            console.log(chalk.bold("  Set up two-factor authentication"));
            console.log();
            console.log("  Add this account to your authenticator app:");
            console.log();
            console.log(`  Secret key: ${chalk.cyan.bold(setup.secret)}`);
            console.log();
            console.log(chalk.dim(`  URI: ${setup.otpauth_uri}`));
            console.log();

            const { code } = await inquirer.prompt([
                {
                    type: "input",
                    name: "code",
                    message: "Enter the 6-digit code from your app to verify:",
                    validate: (v: string) =>
                        /^\d{6}$/.test(v) || "Enter a 6-digit code",
                },
            ]);

            const result = await api<{ recovery_codes: string[] }>(
                "/auth/mfa/verify-setup",
                { method: "POST", body: { code } },
            );

            printSuccess("Two-factor authentication enabled!");
            console.log();
            console.log(
                chalk.yellow.bold(
                    "  Save these recovery codes in a safe place:",
                ),
            );
            console.log(chalk.yellow("  Each code can only be used once."));
            console.log();
            for (const rc of result.recovery_codes) {
                console.log(`  ${chalk.bold(rc)}`);
            }
            console.log();
        } catch (err) {
            handleError(err);
        }
    });

mfaCommand
    .command("disable")
    .description("Disable two-factor authentication")
    .action(async () => {
        try {
            requireToken();

            const { method } = await inquirer.prompt([
                {
                    type: "list",
                    name: "method",
                    message: "Confirm with:",
                    choices: [
                        {
                            name: "TOTP code from authenticator app",
                            value: "totp",
                        },
                        { name: "Account password", value: "password" },
                    ],
                },
            ]);

            const body: Record<string, string> = {};

            if (method === "totp") {
                const { code } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "code",
                        message: "Enter your 6-digit TOTP code:",
                        validate: (v: string) =>
                            /^\d{6}$/.test(v) || "Enter a 6-digit code",
                    },
                ]);
                body.code = code;
            } else {
                const { password } = await inquirer.prompt([
                    {
                        type: "password",
                        name: "password",
                        message: "Enter your account password:",
                        mask: "•",
                    },
                ]);
                body.password = password;
            }

            await api("/auth/mfa", {
                method: "DELETE",
                body,
            });

            printSuccess("Two-factor authentication disabled.");
        } catch (err) {
            handleError(err);
        }
    });
