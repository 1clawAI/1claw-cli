/**
 * Shared provisioning and daemon lifecycle helpers used by both `init` and
 * `spawn` commands. Extracted from init.ts to avoid duplication.
 */

import ora from "ora";
import inquirer from "inquirer";
import { api } from "../client.js";
import { getToken } from "../config.js";
import { loginWithDevice } from "../auth.js";
import { printInfo, printWarning } from "../output.js";
import {
    vaultExists,
    createVault,
    loadVault,
    saveVault,
    addSecret,
    getSecret,
} from "../local-vault.js";
import {
    loadPolicy,
    savePolicy,
    setSecretPolicy,
    type SecretPolicy,
} from "../local-policy.js";
import {
    daemonSocketPath,
    daemonHealthy,
    startDaemonDetached,
    stopDaemon,
} from "./daemon-control.js";
import { sanitizeName } from "./container-config.js";

export interface ProvisionResult {
    agentId: string;
    apiKey: string;
    vaultId: string;
    vaultName: string;
}

export interface StoreKeySpec {
    path: string;
    value?: string;
    type?: string;
    policy: SecretPolicy;
}

export async function provisionCloudResources(
    containerName: string,
): Promise<ProvisionResult> {
    const sid = sanitizeName(containerName);

    const agentSpinner = ora("Provisioning agent...").start();
    let agentId: string;
    let apiKey: string;
    try {
        const res = await api<
            | { id: string; api_key?: string }
            | { agent: { id: string }; api_key?: string }
        >("/agents", {
            method: "POST",
            body: {
                name: `docker-agent-${sid}`.slice(0, 60),
                description: "Created by `1claw init --docker`",
                shroud_enabled: true,
                intents_api_enabled: true,
                auth_method: "api_key",
            },
        });
        agentId = "agent" in res ? res.agent.id : res.id;
        if (!res.api_key) {
            agentSpinner.fail("Agent created but no API key returned.");
            throw new Error("No agent API key returned by the API.");
        }
        apiKey = res.api_key;
        agentSpinner.succeed(`Agent provisioned (${agentId.slice(0, 8)}…)`);
    } catch (err) {
        agentSpinner.fail("Failed to provision agent.");
        throw err;
    }

    const vaultSpinner = ora("Creating vault...").start();
    let vaultId: string;
    let vaultName: string;
    try {
        const vault = await api<{ id: string; name: string }>("/vaults", {
            method: "POST",
            body: {
                name: `docker-vault-${sid}`.slice(0, 60),
                description: "Created by `1claw init --docker`",
            },
        });
        vaultId = vault.id;
        vaultName = vault.name;
        vaultSpinner.succeed(`Vault created (${vaultName})`);
    } catch (err) {
        vaultSpinner.fail("Failed to create vault.");
        throw err;
    }

    const policySpinner = ora("Binding vault and granting read policy...").start();
    try {
        await api(`/agents/${agentId}`, {
            method: "PATCH",
            body: { vault_ids: [vaultId] },
        });
        await api(`/vaults/${vaultId}/policies`, {
            method: "POST",
            body: {
                principal_type: "agent",
                principal_id: agentId,
                secret_path_pattern: "secrets/*",
                permissions: ["read"],
            },
        });
        await api(`/vaults/${vaultId}/policies`, {
            method: "POST",
            body: {
                principal_type: "agent",
                principal_id: agentId,
                secret_path_pattern: "providers/*",
                permissions: ["read"],
            },
        });
        policySpinner.succeed("Vault bound; read policies on secrets/* and providers/* granted.");
    } catch (err) {
        policySpinner.fail("Failed to bind vault / create policy.");
        throw err;
    }

    return { agentId, apiKey, vaultId, vaultName };
}

export async function resolvePassphrase(confirm: boolean): Promise<string> {
    if (process.env.ONECLAW_VAULT_PASSPHRASE) {
        return process.env.ONECLAW_VAULT_PASSPHRASE;
    }
    const { passphrase } = await inquirer.prompt([
        {
            type: "password",
            name: "passphrase",
            message: "Local vault passphrase:",
            mask: "*",
            validate: (v: string) =>
                v.length >= 8 ? true : "Passphrase must be at least 8 characters",
        },
    ]);
    if (confirm) {
        const { confirmed } = await inquirer.prompt([
            {
                type: "password",
                name: "confirmed",
                message: "Confirm passphrase:",
                mask: "*",
            },
        ]);
        if (passphrase !== confirmed) {
            throw new Error("Passphrases do not match.");
        }
    }
    return passphrase;
}

export async function ensureDaemonRunning(opts: {
    storeKeys?: StoreKeySpec[];
}): Promise<string> {
    const socketPath = daemonSocketPath();
    const alreadyRunning = await daemonHealthy(socketPath);

    const storeKeys = opts.storeKeys ?? [];
    const needVaultWrite = storeKeys.length > 0;
    const needStart = !alreadyRunning;
    const needReload = needVaultWrite && alreadyRunning;

    if (!needVaultWrite && !needStart) {
        return socketPath;
    }

    const creatingVault = !vaultExists();
    let passphrase: string | undefined;

    if (creatingVault) {
        printInfo("No local vault found — creating one for the daemon.");
        passphrase = await resolvePassphrase(true);
        createVault(passphrase);
    } else {
        passphrase = await resolvePassphrase(false);
        try {
            loadVault(passphrase);
        } catch {
            throw new Error(
                "Wrong passphrase for the existing local vault.\n" +
                    "  • If you mistyped it, re-run and enter the correct passphrase.\n" +
                    "  • If you've forgotten it, reset the vault with: 1claw local destroy --force\n" +
                    "    (this permanently deletes the old local vault and its secrets), then re-run.",
            );
        }
    }

    if (needVaultWrite && passphrase) {
        let vault;
        try {
            vault = loadVault(passphrase);
        } catch {
            throw new Error("Wrong passphrase or corrupted local vault.");
        }
        const policy = loadPolicy();
        for (const spec of storeKeys) {
            if (spec.value !== undefined) {
                addSecret(vault, spec.path, spec.value, spec.type ?? "api_key");
            } else if (!getSecret(vault, spec.path)) {
                throw new Error(
                    `Provider key secret "${spec.path}" not found in the local vault.\n` +
                        `  Add it first:  1claw local add ${spec.path}`,
                );
            }
            setSecretPolicy(policy, spec.path, spec.policy);
        }
        saveVault(vault, passphrase);
        savePolicy(policy);
    }

    if (needReload) {
        const spinner = ora("Reloading daemon to pick up new secrets...").start();
        await stopDaemon(socketPath);
        const ok = await startDaemonDetached(passphrase!, socketPath);
        if (!ok) {
            spinner.fail("Daemon did not come back up.");
            throw new Error(
                "Failed to reload the daemon.\n" +
                    "  • Check status:  1claw daemon status\n" +
                    "  • Start it manually (shows errors):  1claw daemon start",
            );
        }
        spinner.succeed(`Daemon reloaded on ${socketPath}`);
    } else if (needStart) {
        if (!passphrase) passphrase = await resolvePassphrase(false);
        const spinner = ora("Starting local daemon...").start();
        const ok = await startDaemonDetached(passphrase, socketPath);
        if (!ok) {
            spinner.fail("Daemon did not become ready in time.");
            throw new Error(
                "Failed to start the daemon.\n" +
                    "  • Check status:  1claw daemon status\n" +
                    "  • Start it manually (shows errors):  1claw daemon start\n" +
                    "  • Stop a stuck daemon:  1claw daemon stop\n" +
                    "  • Forgot the vault passphrase? Reset it:  1claw local destroy --force",
            );
        }
        spinner.succeed(`Daemon running on ${socketPath}`);
    } else {
        printInfo(`Reusing running daemon at ${socketPath}`);
    }

    return socketPath;
}

export function defaultModelForProvider(provider: string): string {
    switch (provider.toLowerCase()) {
        case "anthropic":
            return "claude-3-5-haiku-latest";
        case "google":
        case "gemini":
            return "gemini-2.5-flash";
        case "mistral":
            return "mistral-small-latest";
        case "openai":
        default:
            return "gpt-4o-mini";
    }
}

/**
 * Ensure the user is authenticated. Prompts for login if needed.
 * Returns true if authenticated, false if the user declined.
 */
export async function ensureAuth(): Promise<boolean> {
    if (getToken()) return true;

    printInfo("You need to log in to provision cloud resources.");
    const { shouldLogin } = await inquirer.prompt([
        {
            type: "confirm",
            name: "shouldLogin",
            message: "Log in now? (choose No to run offline with --local)",
            default: true,
        },
    ]);
    if (!shouldLogin) return false;

    const auth = await loginWithDevice();
    return !!auth;
}

export async function waitForHealthy(
    port: number,
    endpoint = "/health",
    timeoutMs = 30000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://localhost:${port}${endpoint}`;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}
