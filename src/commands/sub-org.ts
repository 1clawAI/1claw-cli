import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

export const subOrgCommand = new Command("sub-org")
    .description("Manage sub-organizations");

subOrgCommand
    .command("create <name>")
    .description("Create a sub-organization")
    .option("--description <desc>", "Description")
    .option("--billing-model <model>", "Billing model: inherit or independent", "inherit")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { name, billing_model: opts.billingModel };
            if (opts.description) body.description = opts.description;
            const res = await api<{ id: string; name: string; created_at: string }>("/org/sub-orgs", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Sub-organization created: ${res.name} (${res.id})`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("list")
    .description("List sub-organizations")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ sub_orgs: Array<{ id: string; name: string; status: string; created_at: string }> }>("/org/sub-orgs");
            if (opts.json) { printJson(res.sub_orgs); return; }
            if (!res.sub_orgs.length) { console.log("No sub-organizations found."); return; }
            printTable(res.sub_orgs, [{ key: "id", header: "ID" }, { key: "name", header: "Name" }, { key: "status", header: "Status" }, { key: "created_at", header: "Created" }]);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("get <id>")
    .description("Get a sub-organization")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<{ id: string; name: string; description: string; billing_model: string; status: string; created_at: string }>(`/org/sub-orgs/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([["ID", res.id], ["Name", res.name], ["Description", res.description ?? ""], ["Billing", res.billing_model], ["Status", res.status], ["Created", res.created_at]]);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("archive <id>")
    .description("Archive a sub-organization")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}`, { method: "DELETE" });
            printSuccess(`Sub-organization ${id} archived.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("grant <id>")
    .description("Grant a permission to a sub-organization")
    .requiredOption("--permission <perm>", "Permission string")
    .option("--resource-ids <ids>", "Comma-separated resource UUIDs")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { permission: opts.permission };
            if (opts.resourceIds) body.resource_ids = opts.resourceIds.split(",");
            await api(`/org/sub-orgs/${id}/permissions`, { method: "POST", body });
            printSuccess(`Permission granted to sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("revoke <id> <permissionId>")
    .description("Revoke a permission from a sub-organization")
    .action(async (id, permissionId) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}/permissions/${permissionId}`, { method: "DELETE" });
            printSuccess(`Permission ${permissionId} revoked from sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("add-user <id>")
    .description("Add a user to a sub-organization")
    .requiredOption("--user-id <userId>", "User UUID")
    .option("--role <role>", "Role: admin, member, viewer", "member")
    .action(async (id, opts) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}/users`, { method: "POST", body: { user_id: opts.userId, role: opts.role } });
            printSuccess(`User ${opts.userId} added to sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("wallets <id>")
    .description("Generate wallets for a sub-organization")
    .option("--chains <chains>", "Comma-separated chain names")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.chains) body.chains = opts.chains.split(",");
            const res = await api(`/org/sub-orgs/${id}/wallets/generate`, { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Wallets generated for sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });
