import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
} from "../output.js";

interface Policy {
    id: string;
    vault_id: string;
    principal_type: string;
    principal_id: string;
    secret_path_pattern: string;
    permissions: string[];
    expires_at?: string;
    created_at: string;
}

export const policyCommand = new Command("policy").description(
    "Manage access policies",
);

policyCommand
    .command("list")
    .alias("ls")
    .description("List policies for a vault")
    .option("-v, --vault <id>", "Vault ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);
            const res = await api<{ policies: Policy[] }>(`/vaults/${vaultId}/policies`);
            const policies = res.policies ?? [];

            if (opts.json) {
                printJson(policies);
                return;
            }

            printTable(
                policies.map((p) => ({
                    ...p,
                    permissions: p.permissions.join(", "),
                    principal: `${p.principal_type}:${p.principal_id.slice(0, 8)}…`,
                    expires: p.expires_at
                        ? new Date(p.expires_at).toLocaleDateString()
                        : chalk.dim("never"),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "principal", header: "Principal", width: 20 },
                    { key: "secret_path_pattern", header: "Path pattern", width: 20 },
                    { key: "permissions", header: "Permissions", width: 16 },
                    { key: "expires", header: "Expires" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

policyCommand
    .command("create")
    .description("Create an access policy")
    .option("-v, --vault <id>", "Vault ID")
    .requiredOption("--principal-type <type>", "Principal type: agent or user")
    .requiredOption("--principal-id <id>", "Principal UUID")
    .requiredOption("--path <pattern>", "Path glob pattern (e.g. api-keys/*)")
    .option(
        "--permissions <perms>",
        "Comma-separated: read, write, delete",
        "read",
    )
    .option("--expires <date>", "Expiration date (ISO 8601)")
    .option("--tx-conditions <json>", "Signing-time tx_conditions JSON (AND)")
    .option("--consensus-trigger <json>", "Consensus trigger JSON (202 pending approval)")
    .option("--policy-schema-version <n>", "Policy schema version (1=legacy, 2=expression engine)", "2")
    .option("--approval-id <uuid>", "Completed approval ID for control-plane consensus bypass")
    .action(async (opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            const body: Record<string, unknown> = {
                principal_type: opts.principalType,
                principal_id: opts.principalId,
                secret_path_pattern: opts.path,
                permissions: opts.permissions
                    .split(",")
                    .map((s: string) => s.trim()),
            };
            if (opts.expires) body.expires_at = opts.expires;
            if (opts.txConditions) {
                try {
                    body.tx_conditions = JSON.parse(opts.txConditions);
                } catch {
                    throw new Error("--tx-conditions must be valid JSON");
                }
            }
            if (opts.consensusTrigger) {
                try {
                    body.consensus_trigger = JSON.parse(opts.consensusTrigger);
                } catch {
                    throw new Error("--consensus-trigger must be valid JSON");
                }
            }
            if (opts.policySchemaVersion) {
                body.policy_schema_version = parseInt(opts.policySchemaVersion, 10);
            }
            if (opts.approvalId) body.approval_id = opts.approvalId;

            const policy = await api<Policy>(`/vaults/${vaultId}/policies`, {
                method: "POST",
                body,
            });

            printSuccess(`Policy created: ${policy.id}`);
            printKeyValue([
                ["ID", policy.id],
                [
                    "Principal",
                    `${policy.principal_type}:${policy.principal_id}`,
                ],
                ["Path", policy.secret_path_pattern],
                ["Permissions", policy.permissions.join(", ")],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

policyCommand
    .command("delete <id>")
    .description("Delete a policy")
    .option("-v, --vault <id>", "Vault ID")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id, opts) => {
        try {
            requireToken();
            const vaultId = resolveVaultId(opts);

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete policy ${id}?`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/vaults/${vaultId}/policies/${id}`, {
                method: "DELETE",
            });
            printSuccess("Policy deleted.");
        } catch (err) {
            handleError(err);
        }
    });
