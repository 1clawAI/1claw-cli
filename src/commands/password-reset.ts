import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import { apiNoAuth } from "../client.js";
import { setApiUrl } from "../config.js";
import { printSuccess, printError, printInfo } from "../output.js";
import { handleError } from "../middleware.js";

export const forgotPasswordCommand = new Command("forgot-password")
    .description(
        "Request a password reset email (link opens the dashboard). No auth required.",
    )
    .option("--email <email>", "Account email address")
    .option("--api-url <url>", "Override API base URL")
    .action(async (opts: { email?: string; apiUrl?: string }) => {
        try {
            if (opts.apiUrl) {
                setApiUrl(opts.apiUrl);
                printInfo(`API URL set to ${opts.apiUrl}`);
            }

            let email = opts.email?.trim();
            if (!email) {
                const answers = await inquirer.prompt([
                    { type: "input", name: "email", message: "Email:" },
                ]);
                email = String(answers.email ?? "").trim();
            }

            if (!email) {
                printError("Email is required.");
                process.exit(2);
            }

            const res = await apiNoAuth<{ message: string; status: string }>(
                "/auth/forgot-password",
                {
                    method: "POST",
                    body: { email },
                },
            );

            if (res.status === "no_account") {
                printError(res.message || "No account found with that email.");
            } else if (res.status === "social_account") {
                printInfo(res.message || "This account uses social sign-in.");
                printInfo("Open the dashboard to sign in: " + chalk.dim("1claw.co/login"));
            } else {
                printSuccess(res.message || "Check your email for reset instructions.");
                printInfo(
                    `Open the link in the email in your browser (${chalk.dim("1claw.co/reset-password")}).`,
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

export const resetPasswordCommand = new Command("reset-password")
    .description(
        "Set a new password using the token from the reset email. No auth required.",
    )
    .option("--token <token>", "Token from the reset email URL")
    .option("--password <password>", "New password (avoid: visible in shell history)")
    .option("--api-url <url>", "Override API base URL")
    .action(
        async (opts: { token?: string; password?: string; apiUrl?: string }) => {
            try {
                if (opts.apiUrl) {
                    setApiUrl(opts.apiUrl);
                    printInfo(`API URL set to ${opts.apiUrl}`);
                }

                let token = opts.token?.trim();
                let newPassword = opts.password;

                if (!token) {
                    const t = await inquirer.prompt([
                        {
                            type: "input",
                            name: "token",
                            message: "Reset token (from email link):",
                        },
                    ]);
                    token = String(t.token ?? "").trim();
                }

                if (!newPassword) {
                    const p = await inquirer.prompt([
                        {
                            type: "password",
                            name: "password",
                            message: "New password:",
                            mask: "•",
                        },
                        {
                            type: "password",
                            name: "confirm",
                            message: "Confirm new password:",
                            mask: "•",
                        },
                    ]);
                    if (p.password !== p.confirm) {
                        printError("Passwords do not match.");
                        process.exit(2);
                    }
                    newPassword = p.password as string;
                }

                if (!token || !newPassword) {
                    printError("Token and new password are required.");
                    process.exit(2);
                }

                const res = await apiNoAuth<{ message: string }>(
                    "/auth/reset-password",
                    {
                        method: "POST",
                        body: { token, new_password: newPassword },
                    },
                );
                printSuccess(res.message || "Password updated. Run `1claw login`.");
            } catch (err) {
                handleError(err);
            }
        },
    );
