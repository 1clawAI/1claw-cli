import { readFileSync } from "node:fs";
import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

/** OpaPolicyResponse (vault/src/api/dto/opa_policies.rs). */
interface OpaPolicy {
    id: string;
    name: string;
    rego_source?: string;
    has_wasm_bundle: boolean;
    entrypoint: string;
    is_active: boolean;
    enforcement_status: string;
    created_at: string;
    updated_at: string;
}

export const opaPolicyCommand = new Command("opa-policy")
    .description("Manage OPA policies (Business+ tier)");

opaPolicyCommand
    .command("create")
    .description("Create an OPA policy from Rego source or a compiled Wasm bundle")
    .requiredOption("--name <name>", "Policy name")
    .option("--rego <source>", "Rego module source")
    .option("--rego-file <path>", "Read the Rego module from a file")
    .option("--wasm-file <path>", "Compiled OPA Wasm bundle (sent base64-encoded)")
    .option("--entrypoint <path>", "Decision entrypoint (default oneclaw/allow)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { name: opts.name };
            const rego = opts.regoFile ? readFileSync(opts.regoFile, "utf8") : opts.rego;
            if (rego) body.rego_source = rego;
            if (opts.wasmFile) body.wasm_bundle_base64 = readFileSync(opts.wasmFile).toString("base64");
            if (!rego && !opts.wasmFile) throw new Error("Provide --rego, --rego-file or --wasm-file");
            if (opts.entrypoint) body.entrypoint = opts.entrypoint;
            const res = await api<OpaPolicy>("/org/opa-policies", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`OPA policy created: ${res.id} (${res.enforcement_status})`);
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("list")
    .description("List OPA policies")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ policies: OpaPolicy[] }>("/org/opa-policies");
            if (opts.json) { printJson(res.policies); return; }
            if (!res.policies.length) { console.log("No OPA policies found."); return; }
            printTable(
                res.policies.map((p) => ({ ...p, active: p.is_active ? "yes" : "no" })),
                [
                    { key: "id", header: "ID" },
                    { key: "name", header: "Name" },
                    { key: "entrypoint", header: "Entrypoint" },
                    { key: "active", header: "Active" },
                    { key: "enforcement_status", header: "Enforcement" },
                    { key: "created_at", header: "Created" },
                ],
            );
        } catch (err) { handleError(err); }
    });

opaPolicyCommand
    .command("get <id>")
    .description("Get an OPA policy")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<OpaPolicy>(`/org/opa-policies/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["ID", res.id],
                ["Name", res.name],
                ["Entrypoint", res.entrypoint],
                ["Active", res.is_active ? "yes" : "no"],
                ["Enforcement", res.enforcement_status],
                ["Wasm bundle", res.has_wasm_bundle ? "yes" : "no"],
                ["Rego", res.rego_source ?? "—"],
                ["Created", res.created_at],
            ]);
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
    .description("Dry-run the org's OPA policies for one request")
    .requiredOption("--principal-type <type>", "Principal type (agent or user)")
    .requiredOption("--principal-id <uuid>", "Principal ID")
    .requiredOption("--action <action>", "Action (e.g. read, write)")
    .requiredOption("--resource-path <path>", "Secret path")
    .requiredOption("--vault-id <uuid>", "Vault ID")
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
            if (opts.context) body.context = JSON.parse(opts.context);
            const res = await api<{
                decision: string;
                backend: string;
                enforcement_status: string;
                note: string;
                warning?: string;
            }>("/org/opa-policies/test", { method: "POST", body });
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
