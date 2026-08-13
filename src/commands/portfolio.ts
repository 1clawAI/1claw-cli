import { Command } from "commander";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson } from "../output.js";

export const portfolioCommand = new Command("portfolio")
    .description("View unified portfolio balances across all wallets")
    .option("--chains <chains>", "Filter by chains (comma-separated)")
    .option("--include-tokens", "Include token balances")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const params = new URLSearchParams();
            if (opts.chains) params.set("chains", opts.chains);
            if (opts.includeTokens) params.set("include_tokens", "true");
            const qs = params.toString();
            const res = await api<{ wallets: Array<{ wallet_type: string; chain: string; address: string; native_balance: string; native_balance_usd?: string }>; total_usd_estimate?: string }>(`/portfolio${qs ? `?${qs}` : ""}`);
            if (opts.json) { printJson(res); return; }
            if (!res.wallets.length) { console.log("No wallets found."); return; }
            console.log(`\nTotal USD estimate: ${res.total_usd_estimate ?? "N/A"}\n`);
            printTable(res.wallets, [{ key: "wallet_type", header: "Type" }, { key: "chain", header: "Chain" }, { key: "address", header: "Address" }, { key: "native_balance", header: "Balance" }, { key: "native_balance_usd", header: "USD" }]);
        } catch (err) { handleError(err); }
    });
