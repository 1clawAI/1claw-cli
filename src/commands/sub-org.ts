import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

/** SubOrgResponse (vault/src/api/dto/sub_orgs.rs). */
interface SubOrg {
    id: string;
    name: string;
    parent_org_id: string;
    org_type: string;
    isolation_mode: string;
    kek_id?: string | null;
    created_at: string;
}

interface SubOrgPermission {
    id: string;
    permission: string;
    granted_by: string;
    created_at: string;
}

export const subOrgCommand = new Command("sub-org")
    .description("Manage sub-organizations");

subOrgCommand
    .command("create <name>")
    .description("Create a sub-organization")
    .option("--isolation-mode <mode>", "full (own KEK and billing, default) or shared_billing")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { name };
            if (opts.isolationMode) body.isolation_mode = opts.isolationMode;
            const res = await api<SubOrg>("/org/sub-orgs", { method: "POST", body });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Sub-organization created: ${res.name} (${res.id}, ${res.isolation_mode})`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("list")
    .description("List sub-organizations")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ sub_orgs: SubOrg[] }>("/org/sub-orgs");
            if (opts.json) { printJson(res.sub_orgs); return; }
            if (!res.sub_orgs.length) { console.log("No sub-organizations found."); return; }
            printTable(res.sub_orgs.map((s) => ({ ...s })), [
                { key: "id", header: "ID" },
                { key: "name", header: "Name" },
                { key: "isolation_mode", header: "Isolation" },
                { key: "created_at", header: "Created" },
            ]);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("get <id>")
    .description("Get a sub-organization and its permissions")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<{ sub_org: SubOrg; permissions: SubOrgPermission[] }>(`/org/sub-orgs/${id}`);
            if (opts.json) { printJson(res); return; }
            const s = res.sub_org;
            printKeyValue([
                ["ID", s.id],
                ["Name", s.name],
                ["Parent", s.parent_org_id],
                ["Isolation", s.isolation_mode],
                ["Created", s.created_at],
                ["Permissions", res.permissions.map((p) => p.permission).join(", ") || "none"],
            ]);
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
    .action(async (id, opts) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}/permissions`, { method: "POST", body: { permission: opts.permission } });
            printSuccess(`Permission ${opts.permission} granted to sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("revoke <id> <permission>")
    .description("Revoke a permission (by its name, e.g. the string given to grant) from a sub-organization")
    .action(async (id, permission) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}/permissions/${encodeURIComponent(permission)}`, { method: "DELETE" });
            printSuccess(`Permission ${permission} revoked from sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("add-user <id>")
    .description("Add a user (by email) to a sub-organization")
    .requiredOption("--email <email>", "Email of the user to add")
    .option("--role <role>", "Role: admin, member, viewer", "member")
    .action(async (id, opts) => {
        try {
            requireToken();
            await api(`/org/sub-orgs/${id}/users`, { method: "POST", body: { email: opts.email, role: opts.role } });
            printSuccess(`User ${opts.email} added to sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });

subOrgCommand
    .command("wallets <id>")
    .description("Generate treasury wallets for a sub-organization (all supported chains)")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api(`/org/sub-orgs/${id}/wallets/generate`, { method: "POST" });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Wallets generated for sub-org ${id}.`);
        } catch (err) { handleError(err); }
    });
