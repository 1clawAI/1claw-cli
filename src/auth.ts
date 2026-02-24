import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import open from "open";
import ora from "ora";
import chalk from "chalk";
import { api, apiNoAuth, type ApiError } from "./client.js";
import { setAuth, getApiUrl, clearAuth, type StoredAuth } from "./config.js";
import { printError, printSuccess } from "./output.js";

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

interface DeviceTokenResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: string;
    email?: string;
    user_id?: string;
    org_id?: string;
}

export async function loginWithDevice(): Promise<StoredAuth | null> {
    const spinner = ora("Requesting login code…").start();

    let device: DeviceCodeResponse;
    try {
        device = await apiNoAuth<DeviceCodeResponse>("/auth/device/code", {
            method: "POST",
            body: { client_id: "cli" },
        });
    } catch (err) {
        spinner.fail("Failed to request device code");
        printError((err as Error).message);
        return null;
    }

    spinner.stop();

    const dashboardUrl = getApiUrl().replace("api.", "");
    const verifyUrl = `${dashboardUrl}/cli/verify?code=${device.user_code}`;

    console.log();
    console.log(chalk.bold("  Login to 1Claw"));
    console.log();
    console.log(`  Your code: ${chalk.cyan.bold(device.user_code)}`);
    console.log();
    console.log(`  Open this URL to authenticate:`);
    console.log(`  ${chalk.underline(verifyUrl)}`);
    console.log();

    try {
        await open(verifyUrl);
        console.log(chalk.dim("  Browser opened. Waiting for approval…"));
    } catch {
        console.log(chalk.dim("  Open the URL above in your browser."));
    }
    console.log();

    const pollSpinner = ora("Waiting for approval…").start();
    const deadline = Date.now() + device.expires_in * 1000;
    const interval = (device.interval ?? 5) * 1000;

    while (Date.now() < deadline) {
        await sleep(interval);

        try {
            const result = await apiNoAuth<DeviceTokenResponse>(
                "/auth/device/token",
                {
                    method: "POST",
                    body: {
                        device_code: device.device_code,
                        grant_type:
                            "urn:ietf:params:oauth:grant-type:device_code",
                    },
                },
            );

            if (result.access_token) {
                pollSpinner.succeed("Authenticated!");

                const auth: StoredAuth = {
                    token: result.access_token,
                    email: result.email ?? "",
                    userId: result.user_id ?? "",
                    orgId: result.org_id ?? "",
                    expiresAt: result.expires_in
                        ? new Date(
                              Date.now() + result.expires_in * 1000,
                          ).toISOString()
                        : undefined,
                };
                setAuth(auth);
                return auth;
            }

            if (result.error === "expired_token") {
                pollSpinner.fail(
                    "Login code expired. Run `1claw login` again.",
                );
                return null;
            }

            if (result.error === "access_denied") {
                pollSpinner.fail("Login was denied.");
                return null;
            }
        } catch {
            // authorization_pending — keep polling
        }
    }

    pollSpinner.fail("Login timed out. Run `1claw login` again.");
    return null;
}

export async function loginWithCredentials(
    email: string,
    password: string,
): Promise<StoredAuth | null> {
    try {
        const result = await apiNoAuth<{
            access_token: string;
            expires_in: number;
            mfa_required?: boolean;
            mfa_token?: string;
        }>("/auth/token", {
            method: "POST",
            body: { email, password },
        });

        if (result.mfa_required && result.mfa_token) {
            return { mfaToken: result.mfa_token } as unknown as StoredAuth;
        }

        const me = await api<{ id: string; email: string; org_id: string }>(
            "/auth/me",
            { token: result.access_token },
        );

        const auth: StoredAuth = {
            token: result.access_token,
            email: me.email,
            userId: me.id,
            orgId: me.org_id,
            expiresAt: new Date(
                Date.now() + result.expires_in * 1000,
            ).toISOString(),
        };
        setAuth(auth);
        return auth;
    } catch (err) {
        printError((err as Error).message);
        return null;
    }
}

export async function completeMfaLogin(
    mfaToken: string,
    code: string,
): Promise<StoredAuth | null> {
    try {
        const result = await apiNoAuth<{
            access_token: string;
            expires_in: number;
        }>("/auth/mfa/verify", {
            method: "POST",
            body: { mfa_token: mfaToken, code },
        });

        const me = await api<{ id: string; email: string; org_id: string }>(
            "/auth/me",
            { token: result.access_token },
        );

        const auth: StoredAuth = {
            token: result.access_token,
            email: me.email,
            userId: me.id,
            orgId: me.org_id,
            expiresAt: new Date(
                Date.now() + result.expires_in * 1000,
            ).toISOString(),
        };
        setAuth(auth);
        return auth;
    } catch (err) {
        printError((err as Error).message);
        return null;
    }
}

export function requireAuth(): string {
    const token =
        process.env.ONECLAW_TOKEN ??
        process.env.ONECLAW_API_KEY ??
        (() => {
            try {
                const { getToken } = require("./config.js");
                return getToken();
            } catch {
                return null;
            }
        })();

    if (!token) {
        printError("Not authenticated. Run `1claw login` first.");
        process.exit(1);
    }
    return token;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
