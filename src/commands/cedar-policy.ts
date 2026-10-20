import { readFileSync } from "node:fs";
import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

/** CedarPolicyResponse (vault/src/api/dto/cedar_policies.rs). */
interface CedarPolicy {
    id: string;
    name: string;
    cedar_text: string;
    is_active: boolean;
    enforcement_status: string;
    created_at: string;
    updated_at: string;
}

interface PolicyTestResult {
    decision: string;
    backend: string;
    enforcement_status: string;
    note: string;
    warning?: string;
}

function policyText(opts: { policyText?: string; file?: string }): string | undefined {
    if (opts.file) return readFileSync(opts.file, "utf8");
    return opts.policyText;
}

export const cedarPolicyCommand = new Command("cedar-policy")
    .description("Manage Cedar policies (Team+ tier)");

cedarPolicyCommand
    .command("create")
    .description("Create a Cedar policy")
    .requiredOption("--name <name>", "Policy name")
    .option("--policy-text <text>", "Cedar policy text")
    .option("--file <path>", "Read the Cedar policy text from a file")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const cedar_text = policyText(opts);
            if (!cedar_text) throw new Error("Provide --policy-text or --file");
            const res = await api<CedarPolicy>("/org/cedar-policies", {
                method: "POST",
                body: { name: opts.name, cedar_text },
            });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Cedar policy created: ${res.id} (${res.enforcement_status})`);
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("list")
    .description("List Cedar policies")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ policies: CedarPolicy[] }>("/org/cedar-policies");
            if (opts.json) { printJson(res.policies); return; }
            if (!res.policies.length) { console.log("No Cedar policies found."); return; }
            printTable(
                res.policies.map((p) => ({ ...p, active: p.is_active ? "yes" : "no" })),
                [
                    { key: "id", header: "ID" },
                    { key: "name", header: "Name" },
                    { key: "active", header: "Active" },
                    { key: "enforcement_status", header: "Enforcement" },
                    { key: "created_at", header: "Created" },
                ],
            );
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("get <id>")
    .description("Get a Cedar policy")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<CedarPolicy>(`/org/cedar-policies/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["ID", res.id],
                ["Name", res.name],
                ["Active", res.is_active ? "yes" : "no"],
                ["Enforcement", res.enforcement_status],
                ["Policy", res.cedar_text],
                ["Created", res.created_at],
            ]);
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("delete <id>")
    .description("Delete a Cedar policy")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/org/cedar-policies/${id}`, { method: "DELETE" });
            printSuccess(`Cedar policy ${id} deleted.`);
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("test")
    .description("Dry-run a Cedar evaluation for one request (against --policy-text/--file, or the org's active policies)")
    .requiredOption("--principal-type <type>", "Principal type (agent or user)")
    .requiredOption("--principal-id <uuid>", "Principal ID")
    .requiredOption("--action <action>", "Action (e.g. read, write)")
    .requiredOption("--resource-path <path>", "Secret path")
    .requiredOption("--vault-id <uuid>", "Vault ID")
    .option("--policy-text <text>", "Cedar text to test instead of the stored policies")
    .option("--file <path>", "Read the Cedar text to test from a file")
    .option("--context <json>", "Context JSON")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                principal_type: opts.principalType,
                principal_id: opts.principalId,
                action: opts.action,
                resource_path: opts.resourcePath,
                vault_id: opts.vaultId,
            };
            const text = policyText(opts);
            if (text) body.cedar_text = text;
            if (opts.context) body.context = JSON.parse(opts.context);
            const res = await api<PolicyTestResult>("/org/cedar-policies/test", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            const rows: [string, string][] = [
                ["Decision", res.decision],
                ["Backend", res.backend],
                ["Enforcement", res.enforcement_status],
                ["Note", res.note],
            ];
            if (res.warning) rows.push(["Warning", res.warning]);
            printKeyValue(rows);
        } catch (err) { handleError(err); }
    });
