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

interface TreasuryWallet {
    id: string;
    chain: string;
    curve: string;
    public_key_hex: string;
    address: string;
    is_active: boolean;
    created_at: string;
}

interface TreasuryWalletExport {
    chain: string;
    address: string;
    private_key_hex: string;
}

export const treasuryCommand = new Command("treasury").description(
    "Manage treasury wallets (human-only, Pro+ required)",
);

treasuryCommand
    .command("generate")
    .description("Generate multi-chain treasury wallets")
    .option(
        "--chains <chains>",
        "Comma-separated chains (default: all supported)",
    )
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const body: { chains?: string[] } = {};
            if (opts.chains) {
                body.chains = opts.chains
                    .split(",")
                    .map((c: string) => c.trim().toLowerCase());
            }
            const result = await api<{ wallets: TreasuryWallet[] }>(
                "/treasury/wallets/generate",
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(
                `Generated ${result.wallets.length} treasury wallet(s)`,
            );
            for (const w of result.wallets) {
                console.log();
                printKeyValue([
                    ["Chain", w.chain],
                    ["Curve", w.curve],
                    ["Address", w.address],
                    ["Public Key", w.public_key_hex],
                ]);
            }
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("list")
    .alias("ls")
    .description("List all active treasury wallets")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const result = await api<{ wallets: TreasuryWallet[] }>(
                "/treasury/wallets",
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            if (result.wallets.length === 0) {
                printInfo(
                    'No treasury wallets. Run "1claw treasury generate" to create.',
                );
                return;
            }
            printTable(
                result.wallets.map((w) => ({
                    chain: w.chain,
                    address: w.address,
                    curve: w.curve,
                    active: w.is_active ? chalk.green("Yes") : chalk.red("No"),
                    created: new Date(w.created_at).toLocaleDateString(),
                })),
                [
                    { key: "chain", header: "Chain", width: 12 },
                    { key: "address", header: "Address", width: 48 },
                    { key: "curve", header: "Curve", width: 12 },
                    { key: "active", header: "Active" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("get <chain>")
    .description("Get treasury wallet for a specific chain")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            const wallet = await api<TreasuryWallet>(
                `/treasury/wallets/${chain.toLowerCase()}`,
            );
            if (opts.json) {
                printJson(wallet);
                return;
            }
            printKeyValue([
                ["Chain", wallet.chain],
                ["Curve", wallet.curve],
                ["Address", wallet.address],
                ["Public Key", wallet.public_key_hex],
                ["Active", wallet.is_active ? "Yes" : "No"],
                ["Created", new Date(wallet.created_at).toLocaleDateString()],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("export <chain>")
    .description("Export private key for a treasury wallet (audit-logged)")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            const result = await api<TreasuryWalletExport>(
                `/treasury/wallets/${chain.toLowerCase()}/export`,
                { method: "POST" },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            console.log(
                chalk.yellow("  ⚠ This export is audit-logged. Handle the private key with care."),
            );
            console.log();
            printKeyValue([
                ["Chain", result.chain],
                ["Address", result.address],
                ["Private key", result.private_key_hex],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("rotate <chain>")
    .description("Rotate key for a treasury wallet")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            const wallet = await api<TreasuryWallet>(
                `/treasury/wallets/${chain.toLowerCase()}/rotate`,
                { method: "POST" },
            );
            if (opts.json) {
                printJson(wallet);
                return;
            }
            printSuccess(`Rotated ${wallet.chain} treasury wallet`);
            printKeyValue([
                ["New Address", wallet.address],
                ["New Public Key", wallet.public_key_hex],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("deactivate <chain>")
    .description("Deactivate a treasury wallet")
    .action(async (chain: string) => {
        try {
            requireToken();
            await api(`/treasury/wallets/${chain.toLowerCase()}`, {
                method: "DELETE",
            });
            printSuccess(
                `Deactivated ${chain.toLowerCase()} treasury wallet`,
            );
        } catch (e) {
            handleError(e);
        }
    });
