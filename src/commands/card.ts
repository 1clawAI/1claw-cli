import { Command } from "commander";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printKeyValue, printSuccess, printJson } from "../output.js";

interface Card {
    id: string;
    agent_id?: string | null;
    issuer: string;
    kind: string;
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
    currency: string;
    order_amount_usd?: string;
    balance?: string;
    status: string;
    storage_mode: string;
    reveal_policy: Record<string, unknown>;
    void_after?: string;
    created_at: string;
    updated_at: string;
}

interface RevealedCard {
    id: string;
    pan?: string;
    cvv?: string;
    exp_month?: number;
    exp_year?: number;
    brand?: string;
    redemption?: unknown;
    disclaimer: string;
}

function printCard(card: Card): void {
    printKeyValue([
        ["ID", card.id],
        ["Kind", card.kind],
        ["Issuer", card.issuer],
        ["Status", card.status],
        ["Brand", card.brand ?? chalk.dim("—")],
        ["Last 4", card.last4 ? `····${card.last4}` : chalk.dim("—")],
        [
            "Balance",
            card.balance ? `${card.balance} ${card.currency}` : chalk.dim("—"),
        ],
    ]);
}

export const cardCommand = new Command("card").description(
    "Order and manage payment cards (x402 card ordering via Laso)",
);

cardCommand
    .command("order")
    .description("Order a prepaid or gift card for an agent")
    .requiredOption("--agent <id>", "Agent ID")
    .requiredOption("--amount <usd>", "USD amount, e.g. 25.00")
    .option("--kind <kind>", "prepaid or gift_card", "prepaid")
    .option("--server-id <id>", "Laso gift-card server/brand id (gift cards)")
    .option("--country <cc>", "Country code (prepaid, default US)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                kind: opts.kind,
                amount_usd: opts.amount,
            };
            if (opts.serverId) body.laso_server_id = opts.serverId;
            if (opts.country) body.country = opts.country;
            const card = await api<Card>(`/agents/${opts.agent}/cards/order`, {
                method: "POST",
                body,
                headers: { "Idempotency-Key": randomUUID() },
            });
            if (opts.json) return printJson(card);
            printSuccess(`Card ordered: ${card.id} (${card.status})`);
            printCard(card);
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("list")
    .alias("ls")
    .description("List payment cards (masked)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ cards: Card[] }>("/cards");
            const cards = res.cards ?? [];
            if (opts.json) return printJson(cards);
            printTable(
                cards.map((c) => ({
                    ...c,
                    last4: c.last4 ? `····${c.last4}` : chalk.dim("—"),
                    balance: c.balance ?? chalk.dim("—"),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "kind", header: "Kind", width: 10 },
                    { key: "status", header: "Status", width: 16 },
                    { key: "last4", header: "Last 4", width: 8 },
                    { key: "balance", header: "Balance" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("get <id>")
    .description("Get a card (masked)")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const card = await api<Card>(`/cards/${id}`);
            if (opts.json) return printJson(card);
            printCard(card);
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("reveal <id>")
    .description("Reveal full card details (requires --password for humans)")
    .option("-p, --password <password>", "Account password for re-authentication")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const headers: Record<string, string> = {};
            if (opts.password) headers["X-Auth-Confirm"] = opts.password;
            const card = await api<RevealedCard>(`/cards/${id}/reveal`, {
                method: "POST",
                headers,
            });
            if (opts.json) return printJson(card);
            printKeyValue([
                ["PAN", card.pan ?? chalk.dim("—")],
                ["CVV", card.cvv ?? chalk.dim("—")],
                [
                    "Expiry",
                    card.exp_month && card.exp_year
                        ? `${card.exp_month}/${card.exp_year}`
                        : chalk.dim("—"),
                ],
            ]);
            console.log(chalk.yellow(`\n${card.disclaimer}`));
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("void <id>")
    .description("Void a card (1Claw-level lock; forward-looking only)")
    .action(async (id) => {
        try {
            requireToken();
            await api<Card>(`/cards/${id}/void`, { method: "POST" });
            printSuccess("Card voided.");
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("refresh <id>")
    .description("Refresh a card's balance/status from Laso")
    .action(async (id) => {
        try {
            requireToken();
            const card = await api<Card>(`/cards/${id}/refresh`, {
                method: "POST",
            });
            printSuccess("Card refreshed.");
            printCard(card);
        } catch (err) {
            handleError(err);
        }
    });

cardCommand
    .command("import")
    .description("Manually import an existing card (human-only, full storage)")
    .requiredOption("--pan <pan>", "Card number")
    .requiredOption("--cvv <cvv>", "CVV/CVC")
    .requiredOption("--exp-month <mm>", "Expiry month")
    .requiredOption("--exp-year <yyyy>", "Expiry year")
    .option("--brand <brand>", "Card brand")
    .option("--balance <amount>", "Known balance")
    .option("--agent <id>", "Associate with an agent")
    .action(async (opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                pan: opts.pan,
                cvv: opts.cvv,
                exp_month: Number(opts.expMonth),
                exp_year: Number(opts.expYear),
            };
            if (opts.brand) body.brand = opts.brand;
            if (opts.balance) body.balance = opts.balance;
            if (opts.agent) body.agent_id = opts.agent;
            const card = await api<Card>("/cards/import", {
                method: "POST",
                body,
            });
            printSuccess(`Card imported: ${card.id}`);
            printCard(card);
        } catch (err) {
            handleError(err);
        }
    });
