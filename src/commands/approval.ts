import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printInfo,
    printJson,
} from "../output.js";

interface Approval {
    id: string;
    action: string;
    target_type: string;
    target_id: string;
    /**
     * A number, 1-3. Typed as a string here for a long time, which made
     * `riskBadge` call `.toLowerCase()` on it and throw as soon as any approval
     * existed — and made it compare against "t1"/"t2"/"t3", which the API has
     * never sent.
     */
    risk_tier: number;
    declared_risk_tier?: number | null;
    declared_below_floor?: boolean;
    status: string;
    agent_id: string;
    summary?: Record<string, unknown>;
    human_summary?: string | null;
    payload?: Record<string, unknown>;
    reason?: string | null;
    decision_reason?: string | null;
    created_at: string;
    expires_at: string | null;
}

export const approvalCommand = new Command("approval").description(
    "Manage mobile companion approvals",
);

approvalCommand
    .command("list")
    .alias("ls")
    .description("List pending approvals")
    .option("--status <status>", "Filter by status (e.g. pending, approved, rejected)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const params = new URLSearchParams();
            if (opts.status) params.set("status", opts.status);
            const qs = params.toString();
            const result = await api<{ approvals: Approval[] }>(
                `/approvals${qs ? `?${qs}` : ""}`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            if (result.approvals.length === 0) {
                printInfo("No approvals found.");
                return;
            }
            printTable(
                result.approvals.map((a) => ({
                    id: a.id,
                    action: a.action,
                    // The sentence if there is one; the raw target otherwise.
                    target: a.human_summary
                        ? truncate(a.human_summary, 40)
                        : `${a.target_type}/${a.target_id.slice(0, 8)}`,
                    risk: riskBadge(a.risk_tier),
                    status: statusBadge(a.status),
                    agent: a.agent_id.slice(0, 8),
                    created: new Date(a.created_at).toLocaleDateString(),
                    expires: a.expires_at
                        ? new Date(a.expires_at).toLocaleDateString()
                        : chalk.dim("—"),
                })),
                [
                    { key: "id", header: "ID", width: 38 },
                    { key: "action", header: "Action", width: 18 },
                    { key: "target", header: "Summary", width: 42 },
                    { key: "risk", header: "Risk" },
                    { key: "status", header: "Status" },
                    { key: "agent", header: "Agent" },
                    { key: "created", header: "Created" },
                    { key: "expires", header: "Expires" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

approvalCommand
    .command("status <id>")
    .description("Poll lightweight approval status (agent token only)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts) => {
        try {
            requireToken();
            const result = await api<{ status: string; expires_at?: string | null }>(
                `/approvals/${id}/status`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([
                ["Status", statusBadge(result.status)],
                [
                    "Expires",
                    result.expires_at
                        ? new Date(result.expires_at).toLocaleString()
                        : "—",
                ],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

approvalCommand
    .command("get <id>")
    .description("Get approval details")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts) => {
        try {
            requireToken();
            const a = await api<Approval>(`/approvals/${id}`);
            if (opts.json) {
                printJson(a);
                return;
            }
            const rows: [string, string][] = [
                ["ID", a.id],
                ["Action", a.action],
            ];
            if (a.human_summary) rows.push(["Summary", a.human_summary]);
            rows.push(
                ["Target Type", a.target_type],
                ["Target ID", a.target_id],
                ["Risk Tier", riskBadge(a.risk_tier)],
            );
            // Only worth a line when the two disagree — otherwise it is noise.
            if (a.declared_below_floor) {
                rows.push([
                    "Requested Tier",
                    chalk.yellow(
                        `${a.declared_risk_tier} (raised to ${a.risk_tier} by policy)`,
                    ),
                ]);
            }
            rows.push(["Status", statusBadge(a.status)], ["Agent ID", a.agent_id]);
            if (a.payload && Object.keys(a.payload).length > 0) {
                rows.push(["Payload", JSON.stringify(a.payload)]);
            }
            if (a.reason) rows.push(["Reason", a.reason]);
            if (a.decision_reason) rows.push(["Decision Reason", a.decision_reason]);
            rows.push(
                ["Created", new Date(a.created_at).toLocaleDateString()],
                ["Expires", a.expires_at ? new Date(a.expires_at).toLocaleDateString() : "—"],
            );
            printKeyValue(rows);
        } catch (e) {
            handleError(e);
        }
    });

approvalCommand
    .command("decide <id> <decision>")
    .description("Approve or reject a pending approval")
    .option("--reason <text>", "Reason for the decision")
    .action(async (id: string, decision: string, opts) => {
        try {
            requireToken();
            if (decision !== "approve" && decision !== "reject") {
                console.error(
                    chalk.red('Decision must be "approve" or "reject".'),
                );
                process.exit(1);
            }
            await api(`/approvals/${id}/decide`, {
                method: "POST",
                body: { decision, reason: opts.reason },
            });
            printSuccess(
                `Approval ${id} ${decision === "approve" ? "approved" : "rejected"}`,
            );
        } catch (e) {
            handleError(e);
        }
    });

function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function riskBadge(tier: number): string {
    switch (tier) {
        case 1:
            return chalk.green("T1");
        case 2:
            return chalk.yellow("T2");
        case 3:
            return chalk.red("T3");
        default:
            return String(tier);
    }
}

function statusBadge(status: string): string {
    switch (status.toLowerCase()) {
        case "pending":
            return chalk.yellow("pending");
        case "approved":
            return chalk.green("approved");
        case "rejected":
            return chalk.red("rejected");
        default:
            return status;
    }
}
