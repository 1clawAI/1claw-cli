import { Command } from "commander";
import { api, apiNoAuth } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printJson, printKeyValue, printTable, printSuccess } from "../output.js";

interface ModuleRegistryResponse {
    chain: string;
    modules: Array<{ name: string; address: string; version: string }>;
}

interface AllowanceReconcileReport {
    org_id: string;
    agents_checked: number;
    compiled: unknown[];
    drift_detected: Array<{ agent_id: string; chain: string; reason: string }>;
    onchain_sync: string;
}

export const safeCommand = new Command("safe").description(
    "Safe module registry and org-level allowance reconciliation (Phase 5)",
);

safeCommand
    .command("module-registry <chain>")
    .description("List pinned Safe module addresses for a chain (public, no auth)")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts: { json?: boolean }) => {
        try {
            const res = await apiNoAuth<ModuleRegistryResponse>(
                `/safe/module-registry/${encodeURIComponent(chain)}`,
            );
            if (opts.json) {
                printJson(res);
                return;
            }
            printKeyValue([["Chain", res.chain]]);
            if (res.modules.length) {
                console.log("\nModules:");
                printTable(res.modules, [
                    { key: "name", header: "Name" },
                    { key: "address", header: "Address" },
                    { key: "version", header: "Version" },
                ]);
            } else {
                console.log("No modules registered for this chain.");
            }
        } catch (err) {
            handleError(err);
        }
    });

safeCommand
    .command("sync-allowances")
    .description("Reconcile org Safe allowance configs against agent guardrails (owner/admin only)")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
        try {
            requireToken();
            const res = await api<AllowanceReconcileReport>("/org/safe/sync-allowances", {
                method: "POST",
            });
            if (opts.json) {
                printJson(res);
                return;
            }
            printKeyValue([
                ["Org ID", res.org_id],
                ["Agents checked", String(res.agents_checked)],
                ["On-chain sync", res.onchain_sync],
                ["Drift entries", String(res.drift_detected.length)],
            ]);
            if (res.drift_detected.length) {
                console.log("\nDrift:");
                printTable(res.drift_detected, [
                    { key: "agent_id", header: "Agent" },
                    { key: "chain", header: "Chain" },
                    { key: "reason", header: "Reason" },
                ]);
            }
            printSuccess("Allowance reconciliation complete (counterfactual — no on-chain broadcast)");
        } catch (err) {
            handleError(err);
        }
    });
