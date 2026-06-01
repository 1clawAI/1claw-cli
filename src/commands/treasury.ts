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
    .description("Export private key for a treasury wallet (audit-logged, requires re-auth)")
    .option("--json", "Output as JSON")
    .option("--password <password>", "Account password for re-authentication")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            let password: string = opts.password ?? "";
            if (!password) {
                const inquirer = await import("inquirer");
                const answers = await inquirer.default.prompt([
                    {
                        type: "password",
                        name: "password",
                        message: "Account password (re-authentication required):",
                        mask: "*",
                    },
                ]);
                password = String(answers.password ?? "");
            }
            if (!password) {
                console.error(chalk.red("Password is required for wallet export."));
                process.exit(1);
            }
            const result = await api<TreasuryWalletExport>(
                `/treasury/wallets/${chain.toLowerCase()}/export`,
                { method: "POST", headers: { "X-Auth-Confirm": password } },
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
    .command("balance <chain>")
    .description("Get native + token balances for a treasury wallet")
    .option("--tokens <addresses>", "Comma-separated ERC-20 contract addresses")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            const params = new URLSearchParams();
            if (opts.tokens) {
                for (const t of opts.tokens.split(",")) {
                    params.append("tokens", t.trim());
                }
            }
            const qs = params.toString() ? `?${params.toString()}` : "";
            const result = await api<{
                chain: string;
                address: string;
                native_balance: string;
                native_symbol: string;
                tokens?: { contract: string; symbol: string; balance: string; decimals: number }[];
            }>(`/treasury/wallets/${chain.toLowerCase()}/balance${qs}`);
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([
                ["Chain", result.chain],
                ["Address", result.address],
                [`${result.native_symbol} Balance`, result.native_balance],
            ]);
            if (result.tokens && result.tokens.length > 0) {
                console.log();
                printTable(
                    result.tokens.map((t) => ({
                        token: t.symbol || t.contract,
                        balance: t.balance,
                        contract: t.contract,
                    })),
                    [
                        { key: "token", header: "Token", width: 12 },
                        { key: "balance", header: "Balance", width: 24 },
                        { key: "contract", header: "Contract", width: 44 },
                    ],
                );
            }
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("send <chain>")
    .description("Send native currency or ERC-20 tokens (requires re-auth)")
    .requiredOption("--to <address>", "Recipient address")
    .requiredOption("--amount <value>", "Amount to send")
    .option("--token <contract>", "ERC-20 contract address (omit for native)")
    .option("--gasless", "Submit as gasless (sponsored) transaction via ERC-4337 paymaster")
    .option("--password <password>", "Account password for re-authentication")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            let password: string = opts.password ?? "";
            if (!password) {
                const inquirer = await import("inquirer");
                const answers = await inquirer.default.prompt([
                    {
                        type: "password",
                        name: "password",
                        message: "Account password (re-authentication required):",
                        mask: "*",
                    },
                ]);
                password = String(answers.password ?? "");
            }
            if (!password) {
                console.error(chalk.red("Password is required for send."));
                process.exit(1);
            }
            const body: Record<string, unknown> = {
                to: opts.to,
                amount: opts.amount,
            };
            if (opts.token) body.token_contract = opts.token;
            if (opts.gasless) body.gasless = true;
            const result = await api<{
                tx_hash: string;
                from: string;
                to: string;
                amount: string;
                chain: string;
                status: string;
                user_op_hash?: string;
            }>(`/treasury/wallets/${chain.toLowerCase()}/send`, {
                method: "POST",
                body,
                headers: { "X-Auth-Confirm": password },
            });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Transaction sent");
            const kv: [string, string][] = [
                ["Tx Hash", result.tx_hash],
                ["From", result.from],
                ["To", result.to],
                ["Amount", result.amount],
                ["Chain", result.chain],
                ["Status", result.status],
            ];
            if (result.user_op_hash) {
                kv.push(["UserOp Hash", result.user_op_hash]);
            }
            printKeyValue(kv);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("swap <chain>")
    .description("Swap tokens via DEX aggregator (requires re-auth)")
    .requiredOption("--sell-token <address>", "Token to sell (or 'native')")
    .requiredOption("--buy-token <address>", "Token to buy")
    .requiredOption("--amount <value>", "Amount of sell token")
    .option("--slippage <percent>", "Max slippage percentage", "1")
    .option("--password <password>", "Account password for re-authentication")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            let password: string = opts.password ?? "";
            if (!password) {
                const inquirer = await import("inquirer");
                const answers = await inquirer.default.prompt([
                    {
                        type: "password",
                        name: "password",
                        message: "Account password (re-authentication required):",
                        mask: "*",
                    },
                ]);
                password = String(answers.password ?? "");
            }
            if (!password) {
                console.error(chalk.red("Password is required for swap."));
                process.exit(1);
            }
            const body = {
                sell_token: opts.sellToken,
                buy_token: opts.buyToken,
                sell_amount: opts.amount,
                slippage_percentage: opts.slippage,
            };
            const result = await api<{
                tx_hash: string;
                sell_token: string;
                buy_token: string;
                sell_amount: string;
                buy_amount: string;
                chain: string;
            }>(`/treasury/wallets/${chain.toLowerCase()}/swap`, {
                method: "POST",
                body,
                headers: { "X-Auth-Confirm": password },
            });
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Swap executed");
            printKeyValue([
                ["Tx Hash", result.tx_hash],
                ["Sold", `${result.sell_amount} ${result.sell_token}`],
                ["Bought", `${result.buy_amount} ${result.buy_token}`],
                ["Chain", result.chain],
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

// ---------------------------------------------------------------------------
// Treasury Proposals (multisig)
// ---------------------------------------------------------------------------

interface Proposal {
    id: string;
    treasury_id: string;
    proposed_by: string;
    proposed_by_type: string;
    chain: string;
    to_address: string;
    value_wei: string;
    status: string;
    threshold: number;
    safe_tx_hash: string;
    nonce?: number;
    executed_tx_hash?: string;
    signatures?: { signer_address: string; decision: string }[];
    created_at: string;
}

const proposalCmd = treasuryCommand
    .command("proposal")
    .alias("proposals")
    .description("Manage treasury multisig proposals");

proposalCmd
    .command("create <treasuryId>")
    .description("Create a multisig proposal")
    .requiredOption("--to <address>", "Destination address")
    .requiredOption("--value <wei>", "Value in wei")
    .requiredOption("--chain <name>", "Chain name")
    .option("--data <hex>", "Hex-encoded calldata")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                to_address: opts.to,
                value_wei: opts.value,
                chain: opts.chain,
            };
            if (opts.data) body.data_hex = opts.data;
            const result = await api<Proposal>(
                `/treasury/${treasuryId}/proposals`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(`Proposal created: ${result.id}`);
            printKeyValue([
                ["ID", result.id],
                ["Status", result.status],
                ["To", result.to_address],
                ["Value (wei)", result.value_wei],
                ["Chain", result.chain],
                ["Threshold", String(result.threshold)],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

proposalCmd
    .command("list <treasuryId>")
    .description("List proposals for a treasury")
    .option("--status <status>", "Filter by status (pending, approved, executed, rejected, expired)")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, opts) => {
        try {
            requireToken();
            const qs = opts.status ? `?status=${opts.status}` : "";
            const result = await api<{ proposals: Proposal[] }>(
                `/treasury/${treasuryId}/proposals${qs}`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            if (result.proposals.length === 0) {
                printInfo("No proposals found.");
                return;
            }
            printTable(
                result.proposals.map((p) => ({
                    id: p.id.slice(0, 8) + "…",
                    to: p.to_address,
                    value: p.value_wei,
                    status: p.status,
                    chain: p.chain,
                    threshold: String(p.threshold),
                })),
                [
                    { key: "id", header: "ID", width: 10 },
                    { key: "to", header: "To", width: 44 },
                    { key: "value", header: "Value (wei)", width: 18 },
                    { key: "status", header: "Status", width: 10 },
                    { key: "chain", header: "Chain", width: 10 },
                    { key: "threshold", header: "Threshold" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

proposalCmd
    .command("get <treasuryId> <proposalId>")
    .description("Get proposal details with signatures")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, proposalId: string, opts) => {
        try {
            requireToken();
            const result = await api<Proposal>(
                `/treasury/${treasuryId}/proposals/${proposalId}`,
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([
                ["ID", result.id],
                ["Status", result.status],
                ["To", result.to_address],
                ["Value (wei)", result.value_wei],
                ["Chain", result.chain],
                ["Threshold", String(result.threshold)],
                ["Safe Tx Hash", result.safe_tx_hash],
                ["Proposed By", `${result.proposed_by_type}:${result.proposed_by}`],
                ["Created", new Date(result.created_at).toLocaleString()],
            ]);
            if (result.executed_tx_hash) {
                console.log(chalk.green(`  Executed: ${result.executed_tx_hash}`));
            }
            if (result.signatures && result.signatures.length > 0) {
                console.log();
                console.log(chalk.bold("Signatures:"));
                for (const s of result.signatures) {
                    const icon = s.decision === "approve" ? chalk.green("✓") : chalk.red("✗");
                    console.log(`  ${icon} ${s.signer_address} (${s.decision})`);
                }
            }
        } catch (e) {
            handleError(e);
        }
    });

proposalCmd
    .command("sign <treasuryId> <proposalId>")
    .description("Sign (approve or reject) a proposal")
    .requiredOption("--signature <hex>", "EIP-712 signature hex")
    .option("--decision <decision>", "approve or reject", "approve")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, proposalId: string, opts) => {
        try {
            requireToken();
            const body = {
                signature: opts.signature,
                decision: opts.decision,
            };
            const result = await api<Proposal>(
                `/treasury/${treasuryId}/proposals/${proposalId}/sign`,
                { method: "POST", body },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess(`Proposal ${opts.decision}d`);
            console.log(`  Status: ${result.status}`);
            if (result.executed_tx_hash) {
                console.log(chalk.green(`  Auto-executed: ${result.executed_tx_hash}`));
            }
        } catch (e) {
            handleError(e);
        }
    });

proposalCmd
    .command("execute <treasuryId> <proposalId>")
    .description("Force-execute a proposal if threshold is met (user-only)")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, proposalId: string, opts) => {
        try {
            requireToken();
            const result = await api<Proposal>(
                `/treasury/${treasuryId}/proposals/${proposalId}/execute`,
                { method: "POST" },
            );
            if (opts.json) {
                printJson(result);
                return;
            }
            printSuccess("Proposal executed");
            if (result.executed_tx_hash) {
                console.log(`  Tx Hash: ${result.executed_tx_hash}`);
            }
        } catch (e) {
            handleError(e);
        }
    });

proposalCmd
    .command("cancel <treasuryId> <proposalId>")
    .description("Cancel a pending proposal (proposer only)")
    .action(async (treasuryId: string, proposalId: string) => {
        try {
            requireToken();
            await api(
                `/treasury/${treasuryId}/proposals/${proposalId}`,
                { method: "DELETE" },
            );
            printSuccess("Proposal cancelled");
        } catch (e) {
            handleError(e);
        }
    });
