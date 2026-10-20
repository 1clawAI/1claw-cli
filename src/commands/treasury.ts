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
    /** server, client_tss (2-of-3 FROST) or client_multisig (Tron 2-of-3). */
    custody?: string;
    owner_wraps?: number;
    backup?: BackupState;
    multisig_status?: string;
    multisig_keys?: unknown;
}

interface BackupState {
    threshold: string;
    passkey_wraps: number;
    recovery_code_wraps: number;
    generation: number;
    kit_generation: number | null;
    kit_covered: boolean;
    backed_up: boolean;
    missing: string[];
}

interface MultisigSafe {
    id: string;
    chain: string;
    chain_id: number;
    safe_address: string;
    custody: string;
    deploy_status: string;
    owners: unknown;
    threshold: number;
    backup: BackupState;
}

function custodyLabel(w: { custody?: string }): string {
    switch (w.custody) {
        case "client_tss":
            return "self (2-of-3)";
        case "client_multisig":
            return "self (multisig)";
        case undefined:
        case "":
        case "server":
            return "server";
        default:
            return w.custody;
    }
}

function backupLabel(b?: BackupState): string {
    if (!b) return chalk.dim("—");
    return b.backed_up ? chalk.green("backed up") : chalk.yellow("needs backup");
}

function backupRows(b?: BackupState): [string, string][] {
    if (!b) return [];
    const rows: [string, string][] = [
        ["Backup", backupLabel(b)],
        ["Passkey wraps", String(b.passkey_wraps)],
        ["Kit covers current shares", b.kit_covered ? "Yes" : "No"],
    ];
    if (b.missing.length > 0) rows.push(["Still needs", b.missing.join("; ")]);
    return rows;
}

interface TreasuryWalletExport {
    chain: string;
    address: string;
    private_key_hex: string;
}

/**
 * Request body for POST /v1/treasury/wallets/{chain}/send
 * (`SendFromWalletRequest`). There is no token field for EVM: an ERC-20
 * transfer is a call to the token contract with `transfer(to, amount)`
 * calldata and zero value. Non-EVM tokens go in `token_mint`.
 */
export function buildTreasurySendBody(opts: {
    to: string;
    amount: string;
    token?: string;
    tokenDecimals?: string;
    memo?: string;
    destinationTag?: string;
    gasless?: boolean;
    approvalId?: string;
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        to: opts.to,
        value_wei: opts.amount,
    };
    if (opts.token && /^0x[0-9a-fA-F]{40}$/.test(opts.token)) {
        // ERC-20: the API takes calldata; build transfer(to, amount).
        if (!/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
            throw new Error("--to must be a 0x address for an ERC-20 transfer");
        }
        if (!/^[0-9]+$/.test(String(opts.amount))) {
            throw new Error(
                "--amount must be an integer in the token's base units for an ERC-20 transfer",
            );
        }
        body.to = opts.token;
        body.value_wei = "0";
        body.data =
            "0xa9059cbb" +
            opts.to.slice(2).toLowerCase().padStart(64, "0") +
            BigInt(opts.amount).toString(16).padStart(64, "0");
    } else if (opts.token) {
        body.token_mint = opts.token;
        if (opts.tokenDecimals) body.token_decimals = parseInt(opts.tokenDecimals, 10);
    }
    if (opts.memo) body.memo = opts.memo;
    if (opts.destinationTag) body.destination_tag = parseInt(opts.destinationTag, 10);
    if (opts.gasless) body.gasless = true;
    if (opts.approvalId) body.approval_id = opts.approvalId;
    return body;
}

export const treasuryCommand = new Command("treasury").description(
    "Manage treasury wallets (human-only, counts toward wallet quota). " +
        "Self-custody wallets (2-of-3 keys, Tron multisig, multisig Safes) are created, " +
        "backed up and spent from the dashboard, which holds the passkey; the CLI lists them.",
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
                    custody: custodyLabel(w),
                    backup:
                        w.multisig_status === "pending_activation"
                            ? chalk.yellow("not activated")
                            : backupLabel(w.backup),
                    active: w.is_active ? chalk.green("Yes") : chalk.red("No"),
                    created: new Date(w.created_at).toLocaleDateString(),
                })),
                [
                    { key: "chain", header: "Chain", width: 12 },
                    { key: "address", header: "Address", width: 48 },
                    { key: "custody", header: "Custody", width: 16 },
                    { key: "backup", header: "Backup", width: 14 },
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
                ["Custody", custodyLabel(wallet)],
                ...(wallet.multisig_status
                    ? ([["Multisig status", wallet.multisig_status]] as [string, string][])
                    : []),
                ...backupRows(wallet.backup),
                ["Active", wallet.is_active ? "Yes" : "No"],
                ["Created", new Date(wallet.created_at).toLocaleDateString()],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("export <chain>")
    .description(
        "Export private key for a server-custody treasury wallet (audit-logged, requires re-auth). " +
            "Self-custody wallets have no private key to export; use the recovery kit with oneclaw-recover.",
    )
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
    .description(
        "Rotate key for a server-custody treasury wallet (self-custody wallets refresh shares from the dashboard instead)",
    )
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
                native: { symbol: string; balance_wei: string; balance_display: string };
                tokens?: { contract_address: string; balance_raw: string }[];
            }>(`/treasury/wallets/${chain.toLowerCase()}/balance${qs}`);
            if (opts.json) {
                printJson(result);
                return;
            }
            printKeyValue([
                ["Chain", result.chain],
                ["Address", result.address],
                [`${result.native.symbol} Balance`, result.native.balance_display],
                ["Base units", result.native.balance_wei],
            ]);
            if (result.tokens && result.tokens.length > 0) {
                console.log();
                printTable(
                    result.tokens.map((t) => ({
                        contract: t.contract_address,
                        balance: t.balance_raw,
                    })),
                    [
                        { key: "contract", header: "Contract", width: 44 },
                        { key: "balance", header: "Balance (base units)", width: 30 },
                    ],
                );
            }
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("send <chain>")
    .description(
        "Send native currency or ERC-20 tokens from a server-custody wallet (requires re-auth). " +
            "Self-custody wallets send from the dashboard, which co-signs with your passkey.",
    )
    .requiredOption("--to <address>", "Recipient address")
    .requiredOption(
        "--amount <value>",
        "Amount: wei on EVM chains, major units (e.g. 0.5) on non-EVM chains; with an ERC-20 --token, the token's base units",
    )
    .option(
        "--token <contract>",
        "Token to send instead of native: ERC-20 contract (0x...), SPL mint, TRC-20 contract, or Cardano policy_id.asset_name",
    )
    .option("--token-decimals <n>", "Token decimals for non-EVM tokens (default 6)")
    .option("--memo <text>", "Memo (Solana, XRP)")
    .option("--destination-tag <n>", "XRP destination tag")
    .option("--gasless", "Submit as gasless (sponsored) transaction via ERC-4337 paymaster")
    .option("--approval-id <id>", "Approved consensus request, when the org requires one for treasury sends")
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
            const body = buildTreasurySendBody(opts);
            const result = await api<{
                tx_hash: string;
                from: string;
                to: string;
                value_wei: string;
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
                ["Amount", result.value_wei],
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
    .option("--slippage <percent>", "Deprecated: the API sets slippage itself; this value is not sent")
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
            };
            const result = await api<{
                tx_hash: string;
                sell_token: string;
                buy_token: string;
                sell_amount: string;
                buy_amount: string;
                chain: string;
                status: string;
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
                ["Status", result.status],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

treasuryCommand
    .command("import <chain>")
    .description("Import an existing private key as a treasury wallet")
    .requiredOption("--key <privateKey>", "Private key to import")
    .option("--format <format>", "Key format: hex, base64, wif", "hex")
    .requiredOption("--password <password>", "Account password for re-authentication")
    .option("--json", "Output as JSON")
    .action(async (chain: string, opts) => {
        try {
            requireToken();
            const res = await api(`/treasury/wallets/${chain.toLowerCase()}/import`, {
                method: "POST",
                body: { private_key: opts.key, format: opts.format },
                headers: { "X-Auth-Confirm": opts.password },
            });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Treasury wallet imported for ${chain}.`);
        } catch (e) { handleError(e); }
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

treasuryCommand
    .command("tss-chains")
    .description(
        "Show which chains this org can create self-custody (2-of-3) wallets, Tron multisig wallets and multisig Safes on",
    )
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const r = await api<{
                chains: string[];
                supported: string[];
                multisig_chains: string[];
                multisig_supported: string[];
                multisig_safe_chains: string[];
            }>("/keys/tss/chains");
            if (opts.json) {
                printJson(r);
                return;
            }
            const list = (xs?: string[]) =>
                xs && xs.length > 0 ? xs.join(", ") : chalk.dim("none");
            printKeyValue([
                ["2-of-3 keys (enabled)", list(r.chains)],
                ["2-of-3 keys (supported)", list(r.supported)],
                ["Native multisig (enabled)", list(r.multisig_chains)],
                ["Native multisig (supported)", list(r.multisig_supported)],
                ["Multisig Safes (enabled)", list(r.multisig_safe_chains)],
            ]);
        } catch (e) {
            handleError(e);
        }
    });

const safesCmd = treasuryCommand
    .command("safes")
    .description(
        "2-of-3 multisig Safes on EVM: a device key, a recovery key in your offline kit, and a 1Claw key. Created and spent from the dashboard.",
    );

safesCmd
    .command("list")
    .alias("ls")
    .description("List your multisig Safes")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const r = await api<{ safes: MultisigSafe[] }>(
                "/treasury/multisig-safes",
            );
            const safes = r.safes ?? [];
            if (opts.json) {
                printJson(r);
                return;
            }
            if (safes.length === 0) {
                printInfo("No multisig Safes.");
                return;
            }
            printTable(
                safes.map((x) => ({
                    id: x.id,
                    chain: x.chain,
                    address: x.safe_address,
                    status: x.deploy_status,
                    threshold: String(x.threshold),
                    backup: backupLabel(x.backup),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "chain", header: "Chain", width: 12 },
                    { key: "address", header: "Safe address", width: 44 },
                    { key: "status", header: "Deploy", width: 10 },
                    { key: "threshold", header: "Threshold", width: 9 },
                    { key: "backup", header: "Backup" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

safesCmd
    .command("retire <safeId>")
    .description(
        "Retire a Safe that was never deployed and holds no funds (a deployed or funded Safe is refused)",
    )
    .option("-y, --yes", "Skip confirmation")
    .action(async (safeId: string, opts) => {
        try {
            requireToken();
            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Retire Safe ${safeId}?`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }
            await api(`/treasury/multisig-safes/${encodeURIComponent(safeId)}`, {
                method: "DELETE",
            });
            printSuccess(`Retired Safe ${safeId}`);
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
    .requiredOption("--safe-tx-hash <hex>", "EIP-712 SafeTx hash you computed for this transaction")
    .requiredOption("--nonce <n>", "Safe nonce the SafeTx hash was computed with")
    .option("--value <wei>", "Value in wei", "0")
    .option("--data <hex>", "Hex-encoded calldata")
    .option("--operation <n>", "Safe operation: 0 = call (default), 1 = delegatecall")
    .option("--chain <name>", "Deprecated: the chain comes from the treasury; this value is not sent")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                to: opts.to,
                value_wei: opts.value,
                safe_tx_hash: opts.safeTxHash,
                nonce: parseInt(opts.nonce, 10),
            };
            if (opts.data) body.data = opts.data;
            if (opts.operation !== undefined) body.operation = parseInt(opts.operation, 10);
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
    .requiredOption("--signer-address <address>", "Address of the Safe owner that produced the signature")
    .option("--decision <decision>", "approve or reject", "approve")
    .option("--json", "Output as JSON")
    .action(async (treasuryId: string, proposalId: string, opts) => {
        try {
            requireToken();
            const body = {
                signature: opts.signature,
                signer_address: opts.signerAddress,
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
