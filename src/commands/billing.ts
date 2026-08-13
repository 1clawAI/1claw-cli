import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printKeyValue, printTable, printJson, printInfo, formatDate } from "../output.js";

interface UsageMeter {
    used: number;
    limit: number;
}

interface Subscription {
    tier: string;
    status: string;
    period_end?: string;
    overage_method: string;
    usage?: {
        requests?: UsageMeter;
        vaults?: UsageMeter;
        secrets?: UsageMeter;
        agents?: UsageMeter;
        wallets?: UsageMeter;
        intent_transactions?: UsageMeter;
    };
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

            const req = sub.usage?.requests ?? { used: 0, limit: 0 };
            const vaults = sub.usage?.vaults ?? { used: 0, limit: 0 };
            const secrets = sub.usage?.secrets ?? { used: 0, limit: 0 };
            const agents = sub.usage?.agents ?? { used: 0, limit: 0 };
            const wallets = sub.usage?.wallets ?? { used: 0, limit: 0 };
            const sigs = sub.usage?.intent_transactions ?? { used: 0, limit: 0 };
            const pct =
                req.limit > 0 ? Math.round((req.used / req.limit) * 100) : 0;
            const bar = progressBar(pct);

            printKeyValue([
                ["Plan", chalk.bold(sub.tier)],
                [
                    "Status",
                    sub.status === "active"
                        ? chalk.green("Active")
                        : chalk.yellow(sub.status),
                ],
                ["Period ends", formatDate(sub.period_end)],
                ["Overage method", sub.overage_method],
            ]);

            console.log();
            console.log(chalk.bold("  Usage"));
            console.log(
                `  API calls  ${bar}  ${req.used.toLocaleString()} / ${req.limit.toLocaleString()} (${pct}%)`,
            );
            console.log(`  Wallets    ${wallets.used.toLocaleString()} / ${wallets.limit.toLocaleString()}`);
            console.log(`  Signatures ${sigs.used.toLocaleString()} / ${sigs.limit.toLocaleString()}`);
            console.log(`  Vaults     ${vaults.used} / ${vaults.limit}`);
            console.log(
                `  Secrets    ${secrets.used.toLocaleString()} / ${secrets.limit.toLocaleString()}`,
            );
            console.log(
                `  Agents     ${agents.used.toLocaleString()} / ${agents.limit.toLocaleString()}`,
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

            const req = sub.usage?.requests ?? { used: 0, limit: 0 };
            const vaults = sub.usage?.vaults ?? { used: 0, limit: 0 };
            const secrets = sub.usage?.secrets ?? { used: 0, limit: 0 };
            const agents = sub.usage?.agents ?? { used: 0, limit: 0 };

            const pct = (u: number, l: number) =>
                l > 0 ? Math.round((u / l) * 100) : 0;

            printTable(
                [
                    {
                        resource: "API Requests",
                        used: req.used.toLocaleString(),
                        limit: req.limit.toLocaleString(),
                        pct: `${pct(req.used, req.limit)}%`,
                    },
                    {
                        resource: "Vaults",
                        used: String(vaults.used),
                        limit: String(vaults.limit),
                        pct: `${pct(vaults.used, vaults.limit)}%`,
                    },
                    {
                        resource: "Secrets",
                        used: secrets.used.toLocaleString(),
                        limit: secrets.limit.toLocaleString(),
                        pct: `${pct(secrets.used, secrets.limit)}%`,
                    },
                    {
                        resource: "Agents",
                        used: String(agents.used),
                        limit: String(agents.limit),
                        pct: `${pct(agents.used, agents.limit)}%`,
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
                    date: formatDate(t.created_at, "long"),
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
