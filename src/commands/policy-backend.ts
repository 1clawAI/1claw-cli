import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printKeyValue, printJson, printSuccess, printTable } from "../output.js";

interface PolicyBackendSettings {
    backend: string;
    mode: string;
    scope: string[];
    breaker_behavior: string;
}

/** DivergenceReport (vault/src/domain/unified_policy_evaluator.rs). */
interface ShadowReport {
    concordance_rate: number;
    total_evaluated: number;
    total_divergences: number;
    total_errors: number;
    period_start?: string;
    period_end?: string;
    sample_events: Array<{
        id: string;
        backend: string;
        action: string;
        builtin_decision: string;
        backend_decision: string;
        divergent: boolean;
        error_text?: string | null;
        caller_id?: string | null;
        resource_path?: string | null;
        created_at: string;
    }>;
}

export const policyBackendCommand = new Command("policy-backend")
    .description("Manage org policy backend settings (Cedar/OPA enforcement)");

policyBackendCommand
    .command("get")
    .description("Show current policy backend settings")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<PolicyBackendSettings>("/org/settings/policy-backend");
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["Backend", res.backend],
                ["Mode", res.mode],
                ["Scope", res.scope.length ? res.scope.join(", ") : "(all)"],
                ["Breaker Behavior", res.breaker_behavior],
            ]);
        } catch (err) { handleError(err); }
    });

policyBackendCommand
    .command("set")
    .description("Update policy backend settings")
    .option("--backend <backend>", "Backend: builtin, cedar, opa, builtin+cedar, builtin+opa")
    .option("--mode <mode>", "Mode: shadow or enforce")
    .option("--scope <scope>", "Comma-separated scope (e.g. sign,submit_transaction)")
    .option("--breaker <behavior>", "Circuit breaker: fail_closed or fail_open_builtin")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};
            if (opts.backend) body.backend = opts.backend;
            if (opts.mode) body.mode = opts.mode;
            if (opts.scope) body.scope = opts.scope.split(",").map((s: string) => s.trim());
            if (opts.breaker) body.breaker_behavior = opts.breaker;

            const res = await api<PolicyBackendSettings>("/org/settings/policy-backend", {
                method: "PATCH",
                body,
            });
            if (opts.json) { printJson(res); return; }
            printSuccess("Policy backend settings updated.");
            printKeyValue([
                ["Backend", res.backend],
                ["Mode", res.mode],
                ["Scope", res.scope.length ? res.scope.join(", ") : "(all)"],
                ["Breaker Behavior", res.breaker_behavior],
            ]);
        } catch (err) { handleError(err); }
    });

policyBackendCommand
    .command("shadow-report")
    .description("Show policy shadow mode divergence report")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<ShadowReport>("/org/policy-shadow-report");
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["Concordance Rate", `${(res.concordance_rate * 100).toFixed(1)}%`],
                ["Total Evaluated", String(res.total_evaluated)],
                ["Divergences", String(res.total_divergences)],
                ["Errors", String(res.total_errors)],
            ]);
            if (res.sample_events.length) {
                console.log("\nSample divergences:");
                printTable(
                    res.sample_events.map((e) => ({
                        ...e,
                        caller: e.caller_id ? `${e.caller_id.slice(0, 8)}…` : "—",
                        resource: e.resource_path ?? "—",
                    })),
                    [
                        { key: "created_at", header: "Time" },
                        { key: "action", header: "Action" },
                        { key: "caller", header: "Caller", width: 12 },
                        { key: "resource", header: "Resource", width: 24 },
                        { key: "builtin_decision", header: "Builtin" },
                        { key: "backend_decision", header: "Backend" },
                    ],
                );
            }
        } catch (err) { handleError(err); }
    });
