import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printKeyValue, printJson, printInfo, printSuccess } from "../output.js";

// Shapes mirror vault handlers/ai_spend.rs (spec ≥ 0.61.40).
interface Totals {
    cost_usd: number;
    tokens: number;
    requests: number;
    blocked: number;
    unpriced_requests: number;
    avg_cost_per_day: number;
    cost_per_request: number;
    cost_per_mtok: number;
}
interface AiSpend {
    window: { from: string; to: string; interval: string; days: number };
    totals: Totals;
    previous: Totals;
    by_provider: { provider: string; cost_usd: number; tokens: number; requests: number; share_pct: number; trend_pct: number | null }[];
    by_model: { provider: string; model: string; cost_usd: number; requests: number; share_pct: number; trend_pct: number | null; priced: boolean }[];
    by_agent: {
        agent_id: string; agent_name: string; cost_usd: number; tokens: number; requests: number; top_model: string | null;
        trend_pct: number | null; daily_budget_usd: number | null; today_cost_usd: number; budget_used_pct: number | null; blocked_by_budget: number;
    }[];
    limits: {
        agents_with_daily_budget: number; agents_over_80pct: number; agents_at_cap: number; blocked_by_budget: number;
        router_keys: { agent_name: string; name: string; spent_usd: number; cap_usd: number | null }[];
        credit_balance_usd: number; inspection_fees_usd: number;
    };
}
interface Price {
    id: string; org_id: string | null; provider: string; model_pattern: string;
    input_micro_usd_per_mtok: number; output_micro_usd_per_mtok: number; source: string;
}

const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : 4)}`;
const trend = (p: number | null) => (p == null ? chalk.dim("—") : p >= 0 ? chalk.red(`+${p}%`) : chalk.green(`${p}%`));
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

function windowQuery(opts: { days?: string; from?: string; to?: string; agent?: string; provider?: string; interval?: string }) {
    const q: Record<string, string | undefined> = {};
    if (opts.from) q.from = opts.from;
    else if (opts.days) q.from = new Date(Date.now() - Number(opts.days) * 86_400_000).toISOString();
    if (opts.to) q.to = opts.to;
    if (opts.agent) q.agent_id = opts.agent;
    if (opts.provider) q.provider = opts.provider;
    if (opts.interval) q.interval = opts.interval;
    return q;
}

export const spendCommand = new Command("spend").description("AI spend: inference cost per agent, provider and model, against budgets");

spendCommand
    .command("ai")
    .description("AI token spend for a window (default: the last 30 days)")
    .option("--days <n>", "Window length in days", "30")
    .option("--from <rfc3339>", "Window start")
    .option("--to <rfc3339>", "Window end")
    .option("--agent <id>", "Only this agent")
    .option("--provider <name>", "Only this provider (anthropic, openai, …)")
    .option("--by <dimension>", "agent (default), model or provider", "agent")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const s = await api<AiSpend>("/spend/ai", { query: windowQuery(opts) });
            if (opts.json) { printJson(s); return; }
            const t = s.totals;
            const p = s.previous;
            const delta = (a: number, b: number) => (b > 0 ? trend(Math.round(((a - b) / b) * 1000) / 10) : chalk.dim("—"));
            printKeyValue([
                ["Window", `${s.window.from.slice(0, 10)} → ${s.window.to.slice(0, 10)} (${Math.round(s.window.days)}d)`],
                ["Total spend", `${chalk.bold(usd(t.cost_usd))}  ${delta(t.cost_usd, p.cost_usd)} vs previous`],
                ["Tokens", `${compact(t.tokens)}  ${delta(t.tokens, p.tokens)}`],
                ["Requests", `${compact(t.requests)}  (${t.blocked} blocked, ${t.unpriced_requests} unpriced)`],
                ["Avg cost / day", usd(t.avg_cost_per_day)],
                ["Cost / request", usd(t.cost_per_request)],
                ["Cost / MTok", usd(t.cost_per_mtok)],
                ["Inspection fees", `${usd(s.limits.inspection_fees_usd)} (1Claw, separate from provider cost)`],
                ["Credit balance", usd(s.limits.credit_balance_usd)],
                ["Budgets", `${s.limits.agents_with_daily_budget} agents with a daily budget · ${s.limits.agents_over_80pct} over 80% · ${s.limits.agents_at_cap} at cap · ${s.limits.blocked_by_budget} requests blocked`],
            ]);
            console.log();
            if (opts.by === "provider") {
                printTable(
                    s.by_provider.map((r) => ({ provider: r.provider, spend: usd(r.cost_usd), share: `${r.share_pct}%`, tokens: compact(r.tokens), requests: r.requests, trend: trend(r.trend_pct) })),
                    [{ key: "provider", header: "Provider" }, { key: "spend", header: "Spend" }, { key: "share", header: "Share" }, { key: "tokens", header: "Tokens" }, { key: "requests", header: "Requests" }, { key: "trend", header: "Trend" }],
                );
            } else if (opts.by === "model") {
                printTable(
                    s.by_model.map((r) => ({ model: r.model + (r.priced ? "" : chalk.dim(" (unpriced)")), provider: r.provider, spend: usd(r.cost_usd), share: `${r.share_pct}%`, requests: r.requests, trend: trend(r.trend_pct) })),
                    [{ key: "model", header: "Model" }, { key: "provider", header: "Provider" }, { key: "spend", header: "Spend" }, { key: "share", header: "Share" }, { key: "requests", header: "Requests" }, { key: "trend", header: "Trend" }],
                );
            } else {
                printTable(
                    s.by_agent.map((r) => ({
                        agent: r.agent_name, model: r.top_model ?? "—", spend: usd(r.cost_usd), tokens: compact(r.tokens), requests: r.requests, trend: trend(r.trend_pct),
                        budget: r.daily_budget_usd ? `${usd(r.today_cost_usd)} / ${usd(r.daily_budget_usd)} (${r.budget_used_pct ?? 0}%)${r.blocked_by_budget ? chalk.red(` ${r.blocked_by_budget} blocked`) : ""}` : chalk.dim("none"),
                    })),
                    [{ key: "agent", header: "Agent" }, { key: "model", header: "Top model" }, { key: "spend", header: "Spend" }, { key: "tokens", header: "Tokens" }, { key: "requests", header: "Requests" }, { key: "trend", header: "Trend" }, { key: "budget", header: "Daily budget (today)" }],
                );
            }
            if (s.limits.router_keys.some((k) => k.cap_usd != null)) {
                console.log();
                printInfo("Router-key spend caps");
                printTable(
                    s.limits.router_keys.filter((k) => k.cap_usd != null).map((k) => ({ agent: k.agent_name, key: k.name, spent: usd(k.spent_usd), cap: usd(k.cap_usd ?? 0) })),
                    [{ key: "agent", header: "Agent" }, { key: "key", header: "Key" }, { key: "spent", header: "Spent" }, { key: "cap", header: "Cap" }],
                );
            }
        } catch (e) { handleError(e); }
    });

spendCommand
    .command("export")
    .description("AI spend as CSV (one row per agent × provider × model) to stdout")
    .option("--days <n>", "Window length in days", "30")
    .option("--from <rfc3339>", "Window start")
    .option("--to <rfc3339>", "Window end")
    .option("--agent <id>", "Only this agent")
    .option("--provider <name>", "Only this provider")
    .action(async (opts) => {
        try {
            requireToken();
            const csv = await api<string>("/spend/ai/export.csv", { query: windowQuery(opts) });
            process.stdout.write(typeof csv === "string" ? csv : JSON.stringify(csv));
        } catch (e) { handleError(e); }
    });

const prices = spendCommand.command("prices").description("The LLM price card (global list prices + this org's overrides)");

prices
    .command("list")
    .description("Show the price card")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const r = await api<{ prices: Price[] }>("/spend/ai/prices");
            if (opts.json) { printJson(r); return; }
            printTable(
                r.prices.map((p) => ({ provider: p.provider, pattern: p.model_pattern, input: `$${(p.input_micro_usd_per_mtok / 1e6).toFixed(2)}`, output: `$${(p.output_micro_usd_per_mtok / 1e6).toFixed(2)}`, scope: p.org_id ? chalk.cyan("org") : chalk.dim("global"), id: p.org_id ? p.id : "" })),
                [{ key: "provider", header: "Provider" }, { key: "pattern", header: "Model pattern" }, { key: "input", header: "In / MTok" }, { key: "output", header: "Out / MTok" }, { key: "scope", header: "Scope" }, { key: "id", header: "Override id" }],
            );
        } catch (e) { handleError(e); }
    });

prices
    .command("set <provider> <modelPattern> <inputUsdPerMtok> <outputUsdPerMtok>")
    .description("Set an org override, e.g. `set anthropic 'claude-sonnet-5%' 3 15` (owner/admin)")
    .action(async (provider: string, modelPattern: string, input: string, output: string) => {
        try {
            requireToken();
            const p = await api<Price>("/spend/ai/prices", {
                method: "PUT",
                body: { provider, model_pattern: modelPattern, input_usd_per_mtok: Number(input), output_usd_per_mtok: Number(output) },
            });
            printSuccess(`Override ${p.id}: ${p.provider} ${p.model_pattern} → $${(p.input_micro_usd_per_mtok / 1e6).toFixed(2)} in / $${(p.output_micro_usd_per_mtok / 1e6).toFixed(2)} out per MTok`);
        } catch (e) { handleError(e); }
    });

prices
    .command("remove <id>")
    .description("Remove an org override (owner/admin)")
    .action(async (id: string) => {
        try {
            requireToken();
            await api(`/spend/ai/prices/${id}`, { method: "DELETE" });
            printSuccess("Override removed");
        } catch (e) { handleError(e); }
    });

prices
    .command("reprice")
    .description("Price the org's requests that arrived without a card (owner/admin)")
    .action(async () => {
        try {
            requireToken();
            const r = await api<{ repriced: number }>("/spend/ai/reprice", { method: "POST" });
            printSuccess(`${r.repriced} request(s) priced`);
        } catch (e) { handleError(e); }
    });
