import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

export const cedarPolicyCommand = new Command("cedar-policy")
    .description("Manage Cedar policies (Team+ tier)");

cedarPolicyCommand
    .command("create")
    .description("Create a Cedar policy")
    .requiredOption("--policy-text <text>", "Cedar policy text")
    .option("--description <desc>", "Policy description")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { policy_text: opts.policyText };
            if (opts.description) body.description = opts.description;
            const res = await api<{ id: string; policy_text: string; created_at: string }>("/org/cedar-policies", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Cedar policy created: ${res.id}`);
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("list")
    .description("List Cedar policies")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ policies: Array<{ id: string; description: string; created_at: string }> }>("/org/cedar-policies");
            if (opts.json) { printJson(res.policies); return; }
            if (!res.policies.length) { console.log("No Cedar policies found."); return; }
            printTable(res.policies, [{ key: "id", header: "ID" }, { key: "description", header: "Description" }, { key: "created_at", header: "Created" }]);
        } catch (err) { handleError(err); }
    });

cedarPolicyCommand
    .command("get <id>")
    .description("Get a Cedar policy")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<{ id: string; policy_text: string; description: string; created_at: string }>(`/org/cedar-policies/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([["ID", res.id], ["Policy", res.policy_text], ["Description", res.description ?? ""], ["Created", res.created_at]]);
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
    .description("Dry-run a Cedar policy evaluation")
    .requiredOption("--principal <principal>", "Principal")
    .requiredOption("--action <action>", "Action")
    .requiredOption("--resource <resource>", "Resource")
    .option("--context <json>", "Context JSON")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { principal: opts.principal, action: opts.action, resource: opts.resource };
            if (opts.context) body.context = JSON.parse(opts.context);
            const res = await api<{ decision: string; reasons: string[] }>("/org/cedar-policies/test", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printKeyValue([["Decision", res.decision], ["Reasons", res.reasons?.join(", ") ?? ""]]);
        } catch (err) { handleError(err); }
    });
