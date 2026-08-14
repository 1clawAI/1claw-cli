import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

interface PendingApproval {
    id: string;
    policy_id: string;
    action: string;
    status: string;
    submitted_by: string;
    submitted_by_type: string;
    required_approvals: number;
    current_approvals: number;
    expires_at?: string;
    created_at: string;
    signatures: Array<{
        signer_id: string;
        signer_type: string;
        decision: string;
        payload_hash: string;
        reason?: string;
        created_at: string;
    }>;
}

export const pendingApprovalCommand = new Command("pending-approval")
    .description("Manage consensus-based pending approvals");

pendingApprovalCommand
    .command("list")
    .description("List pending approvals")
    .option("--status <status>", "Filter by status (pending, approved, rejected, executed, expired, cancelled)")
    .option("--agent-id <id>", "Filter by agent ID")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const query: Record<string, string> = {};
            if (opts.status) query.status = opts.status;
            if (opts.agentId) query.agent_id = opts.agentId;
            const res = await api<{ pending_approvals: PendingApproval[] }>("/pending-approvals", { query });
            if (opts.json) { printJson(res.pending_approvals); return; }
            if (!res.pending_approvals.length) { console.log("No pending approvals found."); return; }
            printTable(
                res.pending_approvals.map((a) => ({
                    ...a,
                    progress: `${a.current_approvals}/${a.required_approvals}`,
                    submitter: `${a.submitted_by_type}:${a.submitted_by.slice(0, 8)}…`,
                    status_display: colorStatus(a.status),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "action", header: "Action", width: 20 },
                    { key: "status_display", header: "Status", width: 12 },
                    { key: "progress", header: "Approvals", width: 10 },
                    { key: "submitter", header: "Submitted By", width: 18 },
                ],
            );
        } catch (err) { handleError(err); }
    });

pendingApprovalCommand
    .command("get <id>")
    .description("Get pending approval details")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<PendingApproval>(`/pending-approvals/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["ID", res.id],
                ["Policy ID", res.policy_id],
                ["Action", res.action],
                ["Status", res.status],
                ["Approvals", `${res.current_approvals}/${res.required_approvals}`],
                ["Submitted By", `${res.submitted_by_type}:${res.submitted_by}`],
                ["Expires", res.expires_at ?? "never"],
                ["Created", res.created_at],
            ]);
            if (res.signatures.length) {
                console.log("\nSignatures:");
                printTable(res.signatures, [
                    { key: "signer_id", header: "Signer", width: 36 },
                    { key: "decision", header: "Decision", width: 10 },
                    { key: "reason", header: "Reason", width: 20 },
                    { key: "created_at", header: "Time" },
                ]);
            }
        } catch (err) { handleError(err); }
    });

pendingApprovalCommand
    .command("approve <id>")
    .description("Approve a pending approval")
    .requiredOption("--payload-hash <hash>", "SHA-256 hash of the action payload")
    .option("--reason <reason>", "Reason for approval")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                decision: "approve",
                payload_hash: opts.payloadHash,
            };
            if (opts.reason) body.reason = opts.reason;
            await api(`/pending-approvals/${id}/approve`, { method: "POST", body });
            printSuccess(`Pending approval ${id} approved.`);
        } catch (err) { handleError(err); }
    });

pendingApprovalCommand
    .command("reject <id>")
    .description("Reject a pending approval")
    .requiredOption("--payload-hash <hash>", "SHA-256 hash of the action payload")
    .option("--reason <reason>", "Reason for rejection")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                decision: "reject",
                payload_hash: opts.payloadHash,
            };
            if (opts.reason) body.reason = opts.reason;
            await api(`/pending-approvals/${id}/approve`, { method: "POST", body });
            printSuccess(`Pending approval ${id} rejected.`);
        } catch (err) { handleError(err); }
    });

pendingApprovalCommand
    .command("execute <id>")
    .description("Execute an approved pending approval")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/pending-approvals/${id}/execute`, { method: "POST" });
            printSuccess(`Pending approval ${id} executed.`);
        } catch (err) { handleError(err); }
    });

pendingApprovalCommand
    .command("cancel <id>")
    .description("Cancel a pending approval")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/pending-approvals/${id}/cancel`, { method: "POST" });
            printSuccess(`Pending approval ${id} cancelled.`);
        } catch (err) { handleError(err); }
    });

function colorStatus(status: string): string {
    switch (status) {
        case "pending": return chalk.yellow(status);
        case "approved": return chalk.green(status);
        case "rejected": return chalk.red(status);
        case "executed": return chalk.blue(status);
        case "expired": return chalk.dim(status);
        case "cancelled": return chalk.gray(status);
        default: return status;
    }
}
