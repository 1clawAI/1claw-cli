import { Command } from "commander";
import inquirer from "inquirer";
import { api } from "../client.js";
import { printSuccess, printError, printInfo } from "../output.js";
import { handleError } from "../middleware.js";

export const setPasswordCommand = new Command("set-password")
    .description(
        "Set a password (for Platform API users who don't have one yet).",
    )
    .option("--password <password>", "Password (avoid: visible in shell history)")
    .action(async (opts: { password?: string }) => {
        try {
            let password = opts.password;

            if (!password) {
                const answers = await inquirer.prompt([
                    {
                        type: "password",
                        name: "password",
                        message: "New password (min 12 chars):",
                        mask: "*",
                    },
                    {
                        type: "password",
                        name: "confirm",
                        message: "Confirm password:",
                        mask: "*",
                    },
                ]);
                if (answers.password !== answers.confirm) {
                    printError("Passwords do not match.");
                    process.exit(2);
                }
                password = answers.password as string;
            }

            const res = await api<{ message: string }>("/auth/set-password", {
                method: "POST",
                body: { password, password_confirm: password },
            });

            printSuccess(res.message);
        } catch (err) {
            handleError(err);
        }
    });

export const changeEmailCommand = new Command("change-email")
    .description("Change your account email address (requires verification).")
    .option("--email <email>", "New email address")
    .action(async (opts: { email?: string }) => {
        try {
            let newEmail = opts.email?.trim();

            if (!newEmail) {
                const answers = await inquirer.prompt([
                    { type: "input", name: "email", message: "New email:" },
                ]);
                newEmail = String(answers.email ?? "").trim();
            }

            if (!newEmail) {
                printError("Email is required.");
                process.exit(2);
            }

            const res = await api<{
                message: string;
                new_email: string;
                expires_in_seconds: number;
            }>("/auth/change-email", {
                method: "POST",
                body: { new_email: newEmail },
            });

            printSuccess(res.message);
            printInfo(
                `Check ${res.new_email} for the 6-digit verification code (expires in ${Math.round(res.expires_in_seconds / 60)} min).`,
            );

            const codeAnswer = await inquirer.prompt([
                {
                    type: "input",
                    name: "code",
                    message: "Verification code:",
                },
            ]);

            const code = String(codeAnswer.code ?? "").trim();
            if (!code) {
                printError("Code is required.");
                process.exit(2);
            }

            const verify = await api<{ message: string; email: string }>(
                "/auth/verify-email-change",
                {
                    method: "POST",
                    body: { code },
                },
            );

            printSuccess(`${verify.message} New email: ${verify.email}`);
        } catch (err) {
            handleError(err);
        }
    });
