import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printJson, printKeyValue, printTable } from "../output.js";

interface GuardrailShadowReport {
    org_id: string;
    since: string;
    until: string;
    total_would_deny: number;
    by_reason: Array<{ reason_code: string; would_deny_count: number; enforced_count: number }>;
}

interface GuardrailRevisionList {
    revisions: Array<{
        id: string;
        resource_type: string;
        resource_id: string;
        change_kind: string;
        created_at: string;
    }>;
}

interface GuardrailReplayResponse {
    agent_id: string;
    window_days: number;
    allowed: number;
    denied: number;
    would_require_approval: number;
    samples: unknown[];
}

export const guardrailsCommand = new Command("guardrails")
    .description("Guardrail governance — shadow reports, revisions, and replay");

guardrailsCommand
    .command("shadow-report")
    .description("Show Convention 6 guardrail shadow violations")
    .option("--since <iso>", "Report start (RFC3339)")
    .option("--until <iso>", "Report end (RFC3339)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const params = new URLSearchParams();
            if (opts.since) params.set("since", opts.since);
            if (opts.until) params.set("until", opts.until);
            const qs = params.toString();
            const res = await api<GuardrailShadowReport>(
                `/org/guardrail-shadow-report${qs ? `?${qs}` : ""}`,
            );
            if (opts.json) {
                printJson(res);
                return;
            }
            printKeyValue([
                ["Total would-deny", String(res.total_would_deny)],
                ["Since", res.since],
                ["Until", res.until],
            ]);
            if (res.by_reason.length) {
                console.log("\nBy reason:");
                printTable(res.by_reason, [
                    { key: "reason_code", header: "Reason" },
                    { key: "would_deny_count", header: "Would deny" },
                    { key: "enforced_count", header: "Enforced" },
                ]);
            }
        } catch (err) {
            handleError(err);
        }
    });

guardrailsCommand
    .command("revisions")
    .description("List guardrail revision history")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<GuardrailRevisionList>("/org/guardrail-revisions");
            if (opts.json) {
                printJson(res);
                return;
            }
            printTable(
                res.revisions.map((r) => ({
                    ...r,
                    resource_id: `${r.resource_id.slice(0, 8)}…`,
                })),
                [
                    { key: "created_at", header: "When" },
                    { key: "resource_type", header: "Type" },
                    { key: "resource_id", header: "Resource" },
                    { key: "change_kind", header: "Change" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

guardrailsCommand
    .command("replay")
    .description("Dry-run guardrail changes against recent agent transactions")
    .argument("<agent-id>", "Agent UUID")
    .option("--days <n>", "Lookback window in days", "7")
    .option("--draft-guardrails <json>", "Draft guardrails JSON")
    .option("--draft-approval-policy <json>", "Draft approval policy JSON")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = { days: Number(opts.days) };
            if (opts.draftGuardrails) body.draft_guardrails = JSON.parse(opts.draftGuardrails);
            if (opts.draftApprovalPolicy) {
                body.draft_approval_policy = JSON.parse(opts.draftApprovalPolicy);
            }
            const res = await api<GuardrailReplayResponse>(
                `/agents/${agentId}/guardrails/replay`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(res);
                return;
            }
            printKeyValue([
                ["Agent", res.agent_id],
                ["Window (days)", String(res.window_days)],
                ["Allowed", String(res.allowed)],
                ["Denied", String(res.denied)],
                ["Would require approval", String(res.would_require_approval)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });
