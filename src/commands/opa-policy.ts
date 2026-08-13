import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

export const opaPolicyCommand = new Command("opa-policy")
    .description("Manage OPA policies (Business+ tier)");

opaPolicyCommand
    .command("create")
    .description("Create an OPA policy")
    .requiredOption("--rego <module>", "Rego module source")
    .option("--description <desc>", "Policy description")
    .option("--data <json>", "Static data document JSON")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { rego_module: opts.rego };
            if (opts.description) body.description = opts.description;
            if (opts.data) body.data = JSON.parse(opts.data);
            const res = await api<{ id: string; created_at: string }>("/org/opa-policies", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`OPA policy created: ${res.id}`);
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("list")
    .description("List OPA policies")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ policies: Array<{ id: string; description: string; created_at: string }> }>("/org/opa-policies");
            if (opts.json) { printJson(res.policies); return; }
            if (!res.policies.length) { console.log("No OPA policies found."); return; }
            printTable(res.policies, [{ key: "id", header: "ID" }, { key: "description", header: "Description" }, { key: "created_at", header: "Created" }]);
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("get <id>")
    .description("Get an OPA policy")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<{ id: string; rego_module: string; description: string; data: unknown; created_at: string }>(`/org/opa-policies/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([["ID", res.id], ["Rego Module", res.rego_module], ["Description", res.description ?? ""], ["Created", res.created_at]]);
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("delete <id>")
    .description("Delete an OPA policy")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/org/opa-policies/${id}`, { method: "DELETE" });
            printSuccess(`OPA policy ${id} deleted.`);
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("test")
    .description("Dry-run an OPA policy evaluation")
    .requiredOption("--input <json>", "Input document JSON")
    .option("--data <json>", "Optional data override JSON")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { input: JSON.parse(opts.input) };
            if (opts.data) body.data = JSON.parse(opts.data);
            const res = await api<{ decision: string; result: unknown }>("/org/opa-policies/test", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printKeyValue([["Decision", res.decision], ["Result", JSON.stringify(res.result)]]);
        } catch (err) { handleError(err); }
    });
