import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printKeyValue, printTable, printJson, printInfo } from "../output.js";

interface Subscription {
    plan: string;
    status: string;
    current_period_end?: string;
    requests_used: number;
    requests_limit: number;
    vaults_used: number;
    vaults_limit: number;
    secrets_used: number;
    secrets_limit: number;
    agents_used: number;
    agents_limit: number;
    overage_method: string;
}

interface CreditBalance {
    balance_cents: number;
    expiring_within_30d_cents: number;
}

interface CreditTransaction {
    id: string;
    amount_cents: number;
    description: string;
    created_at: string;
}

export const billingCommand = new Command("billing").description(
    "View billing and usage",
);

billingCommand
    .command("status")
    .description("Show subscription and usage summary")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const sub = await api<Subscription>("/billing/subscription");

            if (opts.json) {
                printJson(sub);
                return;
            }

            const pct = Math.round(
                (sub.requests_used / sub.requests_limit) * 100,
            );
            const bar = progressBar(pct);

            printKeyValue([
                ["Plan", chalk.bold(sub.plan)],
                [
                    "Status",
                    sub.status === "active"
                        ? chalk.green("Active")
                        : chalk.yellow(sub.status),
                ],
                [
                    "Period ends",
                    sub.current_period_end
                        ? new Date(sub.current_period_end).toLocaleDateString()
                        : "—",
                ],
                ["Overage method", sub.overage_method],
            ]);

            console.log();
            console.log(chalk.bold("  Usage"));
            console.log(
                `  Requests   ${bar}  ${sub.requests_used.toLocaleString()} / ${sub.requests_limit.toLocaleString()} (${pct}%)`,
            );
            console.log(
                `  Vaults     ${sub.vaults_used} / ${sub.vaults_limit}`,
            );
            console.log(
                `  Secrets    ${sub.secrets_used.toLocaleString()} / ${sub.secrets_limit.toLocaleString()}`,
            );
            console.log(
                `  Agents     ${sub.agents_used} / ${sub.agents_limit}`,
            );
        } catch (err) {
            handleError(err);
        }
    });

billingCommand
    .command("credits")
    .description("Show credit balance")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const balance = await api<CreditBalance>(
                "/billing/credits/balance",
            );

            if (opts.json) {
                printJson(balance);
                return;
            }

            printKeyValue([
                [
                    "Balance",
                    chalk.bold(`$${(balance.balance_cents / 100).toFixed(2)}`),
                ],
                [
                    "Expiring within 30 days",
                    balance.expiring_within_30d_cents > 0
                        ? chalk.yellow(
                              `$${(balance.expiring_within_30d_cents / 100).toFixed(2)}`,
                          )
                        : "$0.00",
                ],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

billingCommand
    .command("usage")
    .description("Show detailed usage stats")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const sub = await api<Subscription>("/billing/subscription");

            if (opts.json) {
                printJson(sub);
                return;
            }

            printTable(
                [
                    {
                        resource: "API Requests",
                        used: sub.requests_used.toLocaleString(),
                        limit: sub.requests_limit.toLocaleString(),
                        pct: `${Math.round((sub.requests_used / sub.requests_limit) * 100)}%`,
                    },
                    {
                        resource: "Vaults",
                        used: String(sub.vaults_used),
                        limit: String(sub.vaults_limit),
                        pct: `${Math.round((sub.vaults_used / sub.vaults_limit) * 100)}%`,
                    },
                    {
                        resource: "Secrets",
                        used: sub.secrets_used.toLocaleString(),
                        limit: sub.secrets_limit.toLocaleString(),
                        pct: `${Math.round((sub.secrets_used / sub.secrets_limit) * 100)}%`,
                    },
                    {
                        resource: "Agents",
                        used: String(sub.agents_used),
                        limit: String(sub.agents_limit),
                        pct: `${Math.round((sub.agents_used / sub.agents_limit) * 100)}%`,
                    },
                ],
                [
                    { key: "resource", header: "Resource", width: 16 },
                    { key: "used", header: "Used", width: 10 },
                    { key: "limit", header: "Limit", width: 10 },
                    { key: "pct", header: "%" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

billingCommand
    .command("ledger")
    .description("Show credit transaction history")
    .option("--limit <n>", "Number of records", "20")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const txns = await api<CreditTransaction[]>(
                "/billing/credits/transactions",
                { query: { limit: opts.limit } },
            );

            if (opts.json) {
                printJson(txns);
                return;
            }

            printTable(
                txns.map((t) => ({
                    ...t,
                    amount:
                        t.amount_cents >= 0
                            ? chalk.green(
                                  `+$${(t.amount_cents / 100).toFixed(2)}`,
                              )
                            : chalk.red(
                                  `-$${(Math.abs(t.amount_cents) / 100).toFixed(2)}`,
                              ),
                    date: new Date(t.created_at).toLocaleString(),
                })),
                [
                    { key: "date", header: "Date", width: 22 },
                    { key: "amount", header: "Amount", width: 12 },
                    { key: "description", header: "Description", width: 40 },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

function progressBar(pct: number, width = 20): string {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const color =
        pct >= 90 ? chalk.red : pct >= 70 ? chalk.yellow : chalk.green;
    return color("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}
