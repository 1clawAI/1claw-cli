import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { api, apiNoAuth } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
} from "../output.js";

interface ShroudConfig {
    pii_policy?: string;
    injection_threshold?: number;
    context_injection_threshold?: number;
    allowed_providers?: string[];
    allowed_models?: string[];
    denied_models?: string[];
    max_tokens_per_request?: number;
    max_requests_per_minute?: number;
    max_requests_per_day?: number;
    daily_budget_usd?: number;
    enable_secret_redaction?: boolean;
    enable_response_filtering?: boolean;
    // Threat detection (optional nested configs)
    unicode_normalization?: { enabled?: boolean };
    command_injection_detection?: { enabled?: boolean; action?: string };
    social_engineering_detection?: { enabled?: boolean; action?: string; sensitivity?: string };
    encoding_detection?: { enabled?: boolean; action?: string };
    network_detection?: { enabled?: boolean; action?: string; blocked_domains?: string[]; allowed_domains?: string[] };
    filesystem_detection?: { enabled?: boolean; action?: string; blocked_paths?: string[] };
    tool_call_inspection?: { enabled?: boolean; allowed_tool_names?: string[]; denied_tool_names?: string[]; scan_arguments?: boolean; block_credential_exfil?: boolean; action?: string };
    output_policy?: { enabled?: boolean; blocked_patterns?: string[]; blocked_entities?: string[]; block_harmful_content?: boolean; harmful_categories?: string[]; action?: string };
    secret_injection_detection?: { enabled?: boolean; action?: string; sensitivity?: string };
    advanced_redaction?: { enabled?: boolean; detect_base64_encoded?: boolean; detect_split_secrets?: boolean; detect_prefix_leak?: boolean; min_secret_length?: number };
    semantic_policy?: { enabled?: boolean; allowed_topics?: string[]; denied_topics?: string[]; allowed_tasks?: string[]; denied_tasks?: string[]; action?: string };
    sanitization_mode?: string;
    threat_logging?: boolean;
    flagged_request_retention_days?: number;
}

interface Agent {
    id: string;
    name: string;
    scopes: string[];
    intents_api_enabled: boolean;
    tx_to_allowlist?: string[];
    tx_max_value_eth?: string;
    tx_daily_limit_eth?: string;
    tx_allowed_chains?: string[];
    token_ttl_seconds?: number | null;
    vault_ids?: string[];
    shroud_enabled: boolean;
    shroud_config?: ShroudConfig | null;
    created_at: string;
    created_by: string;
}

export const agentCommand = new Command("agent").description("Manage agents");

agentCommand
    .command("list")
    .alias("ls")
    .description("List all agents in your org")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const res = await api<{ agents: Agent[] }>("/agents");
            const agents = res.agents ?? [];

            if (opts.json) {
                printJson(agents);
                return;
            }

            printTable(
                agents.map((a) => ({
                    ...a,
                    intents: a.intents_api_enabled
                        ? chalk.green("✓")
                        : chalk.dim("—"),
                    shroud: a.shroud_enabled ? chalk.cyan("✓") : chalk.dim("—"),
                    scopes: a.scopes.join(", "),
                    created: new Date(a.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 24 },
                    { key: "scopes", header: "Scopes", width: 30 },
                    { key: "intents", header: "Intents" },
                    { key: "shroud", header: "Shroud" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("create <name>")
    .description("Register a new agent")
    .option(
        "--scopes <scopes>",
        "Comma-separated scopes",
        "vault.read,vault.write",
    )
    .option("--intents-api", "Enable Intents API")
    .option("--shroud", "Enable Shroud LLM Proxy")
    .option(
        "--tx-to-allowlist <addrs>",
        "Comma-separated allowed destination addresses",
    )
    .option("--tx-max-value <eth>", "Max ETH value per transaction")
    .option("--tx-daily-limit <eth>", "Max ETH spend per 24h rolling window")
    .option(
        "--tx-allowed-chains <chains>",
        "Comma-separated allowed chain names",
    )
    .option(
        "--token-ttl <seconds>",
        "Token TTL in seconds (overrides default 3600)",
    )
    .option(
        "--vault-ids <ids>",
        "Comma-separated vault UUIDs to bind this agent to",
    )
    .action(async (name, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                name,
                scopes: opts.scopes.split(",").map((s: string) => s.trim()),
            };
            if (opts.intentsApi) body.intents_api_enabled = true;
            if (opts.shroud) body.shroud_enabled = true;
            if (opts.txToAllowlist)
                body.tx_to_allowlist = opts.txToAllowlist
                    .split(",")
                    .map((s: string) => s.trim());
            if (opts.txMaxValue) body.tx_max_value_eth = opts.txMaxValue;
            if (opts.txDailyLimit) body.tx_daily_limit_eth = opts.txDailyLimit;
            if (opts.txAllowedChains)
                body.tx_allowed_chains = opts.txAllowedChains
                    .split(",")
                    .map((s: string) => s.trim());
            if (opts.tokenTtl)
                body.token_ttl_seconds = parseInt(opts.tokenTtl, 10);
            if (opts.vaultIds)
                body.vault_ids = opts.vaultIds
                    .split(",")
                    .map((s: string) => s.trim());

            const agent = await api<Agent & { api_key?: string }>("/agents", {
                method: "POST",
                body,
            });

            printSuccess(`Agent ${chalk.bold(agent.name)} created.`);
            printKeyValue([
                ["ID", agent.id],
                ["Name", agent.name],
                ["Scopes", agent.scopes.join(", ")],
            ]);

            if (agent.api_key) {
                console.log();
                console.log(
                    chalk.yellow(
                        "  Save this API key — it won't be shown again:",
                    ),
                );
                console.log(`  ${chalk.bold(agent.api_key)}`);
                console.log();
            }
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("enroll <name>")
    .description(
        "Self-enroll an agent (no auth required). Use --email to email the account holder, or omit it for link-only enrollment.",
    )
    .option(
        "--email <email>",
        "Email of a human with a 1Claw account (optional; omit for approval URL only)",
    )
    .option("--description <desc>", "Agent description")
    .action(async (name, opts) => {
        try {
            const body: {
                name: string;
                description?: string;
                human_email?: string;
            } = { name };
            if (opts.description) body.description = opts.description;
            if (opts.email) body.human_email = opts.email;

            const res = await apiNoAuth<{
                agent_id: string;
                message: string;
                approval_url?: string;
            }>("/agents/enroll", {
                method: "POST",
                body,
            });
            printSuccess("Enrollment request submitted.");
            printKeyValue([
                ["Agent ID", res.agent_id],
                ["Message", res.message],
            ]);
            if (res.approval_url) {
                printKeyValue([["Approval URL", res.approval_url]]);
                console.log();
                console.log(
                    chalk.dim(
                        "  Open this URL while signed in to approve (also check email if you used --email).",
                    ),
                );
            }
            console.log();
            console.log(
                chalk.dim(
                    "  After approval, the human receives the API key by email. They must create access policies before the agent can read secrets.",
                ),
            );
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("get <id>")
    .description("Get agent details")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const agent = await api<Agent>(`/agents/${id}`);

            if (opts.json) {
                printJson(agent);
                return;
            }

            const rows: [string, string][] = [
                ["ID", agent.id],
                ["Name", agent.name],
                [
                    "Scopes",
                    agent.scopes.length
                        ? agent.scopes.join(", ")
                        : chalk.dim("none (zero access)"),
                ],
                [
                    "Token TTL",
                    agent.token_ttl_seconds
                        ? `${agent.token_ttl_seconds}s`
                        : chalk.dim("default (3600s)"),
                ],
                [
                    "Vault binding",
                    agent.vault_ids?.length
                        ? agent.vault_ids.join(", ")
                        : chalk.dim("all vaults"),
                ],
                [
                    "Intents API",
                    agent.intents_api_enabled ? "enabled" : "disabled",
                ],
                [
                    "Shroud LLM Proxy",
                    agent.shroud_enabled ? "enabled" : "disabled",
                ],
            ];
            if (agent.shroud_enabled && agent.shroud_config) {
                rows.push([
                    "  PII policy",
                    agent.shroud_config.pii_policy ?? "redact",
                ]);
                rows.push([
                    "  Injection threshold",
                    String(agent.shroud_config.injection_threshold ?? 0.7),
                ]);
                rows.push([
                    "  Providers",
                    agent.shroud_config.allowed_providers?.length
                        ? agent.shroud_config.allowed_providers.join(", ")
                        : chalk.dim("all"),
                ]);
                rows.push([
                    "  Models",
                    agent.shroud_config.allowed_models?.length
                        ? agent.shroud_config.allowed_models.join(", ")
                        : chalk.dim("all"),
                ]);
                if (agent.shroud_config.denied_models?.length) {
                    rows.push([
                        "  Denied models",
                        agent.shroud_config.denied_models.join(", "),
                    ]);
                }
                if (agent.shroud_config.max_requests_per_minute != null) {
                    rows.push([
                        "  Rate limit (min)",
                        String(agent.shroud_config.max_requests_per_minute),
                    ]);
                }
                if (agent.shroud_config.max_requests_per_day != null) {
                    rows.push([
                        "  Rate limit (day)",
                        String(agent.shroud_config.max_requests_per_day),
                    ]);
                }
                const threatKeys = [
                    "unicode_normalization",
                    "command_injection_detection",
                    "social_engineering_detection",
                    "encoding_detection",
                    "network_detection",
                    "filesystem_detection",
                    "tool_call_inspection",
                    "output_policy",
                    "secret_injection_detection",
                    "advanced_redaction",
                    "semantic_policy",
                ] as const;
                const cfg = agent.shroud_config as Record<string, unknown> | undefined;
                const configured = threatKeys.filter(
                    (k) => cfg && cfg[k] != null && typeof cfg[k] === "object",
                );
                if (configured.length > 0) {
                    rows.push([
                        "  Threat detection",
                        configured
                            .map((k) =>
                                k
                                    .replace(/_detection$/, "")
                                    .replace(/_inspection$/, "")
                                    .replace(/_policy$/, " policy")
                                    .replace(/_redaction$/, " redaction")
                                    .replace(/_/g, " "),
                            )
                            .join(", "),
                    ]);
                }
                if (agent.shroud_config.tool_call_inspection?.enabled) {
                    const tci = agent.shroud_config.tool_call_inspection;
                    if (tci.allowed_tool_names?.length)
                        rows.push(["    Allowed tools", tci.allowed_tool_names.join(", ")]);
                    if (tci.denied_tool_names?.length)
                        rows.push(["    Denied tools", tci.denied_tool_names.join(", ")]);
                    if (tci.block_credential_exfil)
                        rows.push(["    Block cred exfil", "yes"]);
                    if (tci.action)
                        rows.push(["    Action", tci.action]);
                }
                if (agent.shroud_config.output_policy?.enabled) {
                    const op = agent.shroud_config.output_policy;
                    if (op.blocked_patterns?.length)
                        rows.push(["    Blocked patterns", op.blocked_patterns.join(", ")]);
                    if (op.blocked_entities?.length)
                        rows.push(["    Blocked entities", op.blocked_entities.join(", ")]);
                    if (op.block_harmful_content)
                        rows.push(["    Block harmful", "yes"]);
                    if (op.action)
                        rows.push(["    Action", op.action]);
                }
                if (agent.shroud_config.secret_injection_detection?.enabled) {
                    const sid = agent.shroud_config.secret_injection_detection;
                    if (sid.sensitivity)
                        rows.push(["    Sensitivity", sid.sensitivity]);
                    if (sid.action)
                        rows.push(["    Action", sid.action]);
                }
                if (agent.shroud_config.advanced_redaction?.enabled) {
                    const ar = agent.shroud_config.advanced_redaction;
                    const flags = [
                        ar.detect_base64_encoded && "base64",
                        ar.detect_split_secrets && "split",
                        ar.detect_prefix_leak && "prefix",
                    ].filter(Boolean);
                    if (flags.length)
                        rows.push(["    Detectors", flags.join(", ")]);
                    if (ar.min_secret_length != null)
                        rows.push(["    Min secret len", String(ar.min_secret_length)]);
                }
                if (agent.shroud_config.semantic_policy?.enabled) {
                    const sp = agent.shroud_config.semantic_policy;
                    if (sp.allowed_topics?.length)
                        rows.push(["    Allowed topics", sp.allowed_topics.join(", ")]);
                    if (sp.denied_topics?.length)
                        rows.push(["    Denied topics", sp.denied_topics.join(", ")]);
                    if (sp.allowed_tasks?.length)
                        rows.push(["    Allowed tasks", sp.allowed_tasks.join(", ")]);
                    if (sp.denied_tasks?.length)
                        rows.push(["    Denied tasks", sp.denied_tasks.join(", ")]);
                    if (sp.action)
                        rows.push(["    Action", sp.action]);
                }
                if (agent.shroud_config.flagged_request_retention_days != null) {
                    rows.push([
                        "  Flagged retention",
                        `${agent.shroud_config.flagged_request_retention_days} days`,
                    ]);
                }
            }
            if (agent.intents_api_enabled) {
                rows.push([
                    "Allowed destinations",
                    agent.tx_to_allowlist?.length
                        ? agent.tx_to_allowlist.join(", ")
                        : chalk.dim("any"),
                ]);
                rows.push([
                    "Max value/tx",
                    agent.tx_max_value_eth
                        ? `${agent.tx_max_value_eth} ETH`
                        : chalk.dim("unlimited"),
                ]);
                rows.push([
                    "Daily limit",
                    agent.tx_daily_limit_eth
                        ? `${agent.tx_daily_limit_eth} ETH`
                        : chalk.dim("unlimited"),
                ]);
                rows.push([
                    "Allowed chains",
                    agent.tx_allowed_chains?.length
                        ? agent.tx_allowed_chains.join(", ")
                        : chalk.dim("all"),
                ]);
            }
            rows.push(["Created by", agent.created_by]);
            rows.push(["Created", new Date(agent.created_at).toLocaleString()]);
            printKeyValue(rows);
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("update <id>")
    .description("Update agent settings")
    .option("--intents-api <bool>", "Enable/disable Intents API (true/false)")
    .option("--shroud <bool>", "Enable/disable Shroud LLM Proxy (true/false)")
    .option(
        "--tx-to-allowlist <addrs>",
        'Comma-separated allowed destination addresses (use "" to clear)',
    )
    .option(
        "--tx-max-value <eth>",
        'Max ETH value per transaction (use "" to remove)',
    )
    .option(
        "--tx-daily-limit <eth>",
        'Max ETH spend per 24h (use "" to remove)',
    )
    .option(
        "--tx-allowed-chains <chains>",
        'Comma-separated allowed chains (use "" to clear)',
    )
    .option(
        "--token-ttl <seconds>",
        'Token TTL in seconds (use "" to reset to default)',
    )
    .option(
        "--vault-ids <ids>",
        'Comma-separated vault UUIDs (use "" to clear)',
    )
    .option("--active <bool>", "Set agent active status (true/false)")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};

            if (opts.intentsApi !== undefined)
                body.intents_api_enabled = opts.intentsApi === "true";
            if (opts.shroud !== undefined)
                body.shroud_enabled = opts.shroud === "true";
            if (opts.active !== undefined)
                body.is_active = opts.active === "true";
            if (opts.txToAllowlist !== undefined) {
                body.tx_to_allowlist =
                    opts.txToAllowlist === ""
                        ? []
                        : opts.txToAllowlist
                              .split(",")
                              .map((s: string) => s.trim());
            }
            if (opts.txMaxValue !== undefined) {
                body.tx_max_value_eth =
                    opts.txMaxValue === "" ? null : opts.txMaxValue;
            }
            if (opts.txDailyLimit !== undefined) {
                body.tx_daily_limit_eth =
                    opts.txDailyLimit === "" ? null : opts.txDailyLimit;
            }
            if (opts.txAllowedChains !== undefined) {
                body.tx_allowed_chains =
                    opts.txAllowedChains === ""
                        ? []
                        : opts.txAllowedChains
                              .split(",")
                              .map((s: string) => s.trim());
            }
            if (opts.tokenTtl !== undefined) {
                body.token_ttl_seconds =
                    opts.tokenTtl === "" ? null : parseInt(opts.tokenTtl, 10);
            }
            if (opts.vaultIds !== undefined) {
                body.vault_ids =
                    opts.vaultIds === ""
                        ? []
                        : opts.vaultIds.split(",").map((s: string) => s.trim());
            }

            if (Object.keys(body).length === 0) {
                console.log(
                    chalk.yellow(
                        "No update options provided. Use --help for available flags.",
                    ),
                );
                return;
            }

            const agent = await api<Agent>(`/agents/${id}`, {
                method: "PATCH",
                body,
            });

            printSuccess(`Agent ${chalk.bold(agent.name)} updated.`);
            printKeyValue([
                ["ID", agent.id],
                [
                    "Intents API",
                    agent.intents_api_enabled ? "enabled" : "disabled",
                ],
                ["Shroud", agent.shroud_enabled ? "enabled" : "disabled"],
                [
                    "Allowed destinations",
                    agent.tx_to_allowlist?.length
                        ? agent.tx_to_allowlist.join(", ")
                        : chalk.dim("any"),
                ],
                [
                    "Max value/tx",
                    agent.tx_max_value_eth
                        ? `${agent.tx_max_value_eth} ETH`
                        : chalk.dim("unlimited"),
                ],
                [
                    "Daily limit",
                    agent.tx_daily_limit_eth
                        ? `${agent.tx_daily_limit_eth} ETH`
                        : chalk.dim("unlimited"),
                ],
                [
                    "Allowed chains",
                    agent.tx_allowed_chains?.length
                        ? agent.tx_allowed_chains.join(", ")
                        : chalk.dim("all"),
                ],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("delete <id>")
    .description("Delete an agent")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Delete agent ${id}? This revokes all access.`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(`/agents/${id}`, { method: "DELETE" });
            printSuccess("Agent deleted.");
        } catch (err) {
            handleError(err);
        }
    });

agentCommand
    .command("token <id>")
    .description("Generate a new JWT for an agent")
    .option("--quiet", "Print only the token")
    .action(async (id, opts) => {
        try {
            requireToken();
            const result = await api<{ token: string; expires_in: number }>(
                `/agents/${id}/token`,
                { method: "POST" },
            );

            if (opts.quiet) {
                process.stdout.write(result.token);
                return;
            }

            printSuccess("Agent token generated.");
            printKeyValue([
                ["Token", result.token],
                ["Expires in", `${result.expires_in}s`],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// ── Transaction commands ────────────────────────────────────────────────

interface TxResponse {
    id: string;
    agent_id: string;
    chain: string;
    chain_id: number;
    to: string;
    value_wei: string;
    status: string;
    signed_tx?: string;
    tx_hash?: string;
    error_message?: string;
    created_at: string;
    signed_at?: string;
    simulation_id?: string;
    simulation_status?: string;
}

interface SignTxResponse {
    signed_tx: string;
    tx_hash: string;
    from: string;
    to: string;
    chain: string;
    chain_id: number;
    nonce: number;
    value_wei: string;
    status: string;
    simulation_id?: string;
    simulation_status?: string;
}

const txCommand = agentCommand
    .command("tx")
    .description("Transaction commands (Intents API)");

txCommand
    .command("submit <agent-id>")
    .description("Submit a transaction for signing and broadcasting")
    .requiredOption("--to <address>", "Destination address")
    .requiredOption("--value <eth>", "Value in ETH")
    .requiredOption("--chain <chain>", "Chain name or ID")
    .option("--data <hex>", "Hex-encoded calldata")
    .option("--signing-key-path <path>", "Vault path to signing key")
    .option("--nonce <n>", "Transaction nonce")
    .option("--gas-price <wei>", "Gas price in wei (legacy)")
    .option("--gas-limit <n>", "Gas limit")
    .option("--max-fee-per-gas <wei>", "EIP-1559 max fee per gas")
    .option("--max-priority-fee-per-gas <wei>", "EIP-1559 max priority fee")
    .option("--simulate", "Simulate before signing", false)
    .option("--json", "Output raw JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                to: opts.to,
                value: opts.value,
                chain: opts.chain,
                simulate_first: opts.simulate,
            };
            if (opts.data) body.data = opts.data;
            if (opts.signingKeyPath) body.signing_key_path = opts.signingKeyPath;
            if (opts.nonce) body.nonce = parseInt(opts.nonce, 10);
            if (opts.gasPrice) body.gas_price = opts.gasPrice;
            if (opts.gasLimit) body.gas_limit = parseInt(opts.gasLimit, 10);
            if (opts.maxFeePerGas) body.max_fee_per_gas = opts.maxFeePerGas;
            if (opts.maxPriorityFeePerGas) body.max_priority_fee_per_gas = opts.maxPriorityFeePerGas;

            const tx = await api<TxResponse>(`/agents/${agentId}/transactions`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(tx);
                return;
            }

            printSuccess(`Transaction ${tx.status.toUpperCase()}`);
            printKeyValue([
                ["ID", tx.id],
                ["Chain", `${tx.chain} (${tx.chain_id})`],
                ["To", tx.to],
                ["Value", `${tx.value_wei} wei`],
                ["Status", tx.status],
                ...(tx.tx_hash ? [["Tx hash", tx.tx_hash] as [string, string]] : []),
                ...(tx.error_message ? [["Error", chalk.red(tx.error_message)] as [string, string]] : []),
            ]);
        } catch (err) {
            handleError(err);
        }
    });

txCommand
    .command("sign <agent-id>")
    .description("Sign a transaction without broadcasting (returns signed_tx for self-broadcast)")
    .requiredOption("--to <address>", "Destination address")
    .requiredOption("--value <eth>", "Value in ETH")
    .requiredOption("--chain <chain>", "Chain name or ID")
    .option("--data <hex>", "Hex-encoded calldata")
    .option("--signing-key-path <path>", "Vault path to signing key")
    .option("--nonce <n>", "Transaction nonce")
    .option("--gas-price <wei>", "Gas price in wei (legacy)")
    .option("--gas-limit <n>", "Gas limit")
    .option("--max-fee-per-gas <wei>", "EIP-1559 max fee per gas")
    .option("--max-priority-fee-per-gas <wei>", "EIP-1559 max priority fee")
    .option("--simulate", "Simulate before signing", false)
    .option("--json", "Output raw JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                to: opts.to,
                value: opts.value,
                chain: opts.chain,
                simulate_first: opts.simulate,
            };
            if (opts.data) body.data = opts.data;
            if (opts.signingKeyPath) body.signing_key_path = opts.signingKeyPath;
            if (opts.nonce) body.nonce = parseInt(opts.nonce, 10);
            if (opts.gasPrice) body.gas_price = opts.gasPrice;
            if (opts.gasLimit) body.gas_limit = parseInt(opts.gasLimit, 10);
            if (opts.maxFeePerGas) body.max_fee_per_gas = opts.maxFeePerGas;
            if (opts.maxPriorityFeePerGas) body.max_priority_fee_per_gas = opts.maxPriorityFeePerGas;

            const tx = await api<SignTxResponse>(`/agents/${agentId}/transactions/sign`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(tx);
                return;
            }

            printSuccess("Transaction SIGNED (not broadcast)");
            printKeyValue([
                ["Tx hash", tx.tx_hash],
                ["From", tx.from],
                ["To", tx.to],
                ["Chain", `${tx.chain} (${tx.chain_id})`],
                ["Nonce", String(tx.nonce)],
                ["Value", `${tx.value_wei} wei`],
                ["Signed tx", tx.signed_tx],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

txCommand
    .command("list <agent-id>")
    .description("List recent transactions for an agent")
    .option("--include-signed-tx", "Include signed_tx in response")
    .option("--json", "Output raw JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const qs = opts.includeSignedTx ? "?include_signed_tx=true" : "";
            const result = await api<{ transactions: TxResponse[] }>(
                `/agents/${agentId}/transactions${qs}`,
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            if (!result.transactions.length) {
                console.log(chalk.dim("No transactions found."));
                return;
            }

            printTable(
                result.transactions.map((tx) => ({
                    id: tx.id.slice(0, 8) + "…",
                    chain: tx.chain,
                    to: tx.to.slice(0, 10) + "…",
                    status: tx.status,
                    tx_hash: tx.tx_hash ? tx.tx_hash.slice(0, 10) + "…" : "-",
                    created: new Date(tx.created_at).toLocaleString(),
                })),
                [
                    { key: "id", header: "ID" },
                    { key: "chain", header: "Chain" },
                    { key: "to", header: "To" },
                    { key: "status", header: "Status" },
                    { key: "tx_hash", header: "Tx Hash" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

txCommand
    .command("get <agent-id> <tx-id>")
    .description("Get a transaction by ID")
    .option("--include-signed-tx", "Include signed_tx in response")
    .option("--json", "Output raw JSON")
    .action(async (agentId, txId, opts) => {
        try {
            requireToken();
            const qs = opts.includeSignedTx ? "?include_signed_tx=true" : "";
            const tx = await api<TxResponse>(
                `/agents/${agentId}/transactions/${txId}${qs}`,
            );

            if (opts.json) {
                printJson(tx);
                return;
            }

            printKeyValue([
                ["ID", tx.id],
                ["Agent", tx.agent_id],
                ["Chain", `${tx.chain} (${tx.chain_id})`],
                ["To", tx.to],
                ["Value", `${tx.value_wei} wei`],
                ["Status", tx.status],
                ...(tx.tx_hash ? [["Tx hash", tx.tx_hash] as [string, string]] : []),
                ...(tx.signed_tx ? [["Signed tx", tx.signed_tx] as [string, string]] : []),
                ...(tx.error_message ? [["Error", chalk.red(tx.error_message)] as [string, string]] : []),
                ["Created", tx.created_at],
                ...(tx.signed_at ? [["Signed at", tx.signed_at] as [string, string]] : []),
            ]);
        } catch (err) {
            handleError(err);
        }
    });

// ── Signing key commands ────────────────────────────────────────────────

interface SigningKeyResponse {
    id: string;
    agent_id: string;
    chain: string;
    curve: string;
    public_key: string;
    address?: string;
    key_version: number;
    is_active: boolean;
    created_at: string;
    rotated_at?: string;
}

const keysCommand = agentCommand
    .command("keys")
    .description("Manage agent signing keys");

keysCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List signing keys for an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const res = await api<{ keys: SigningKeyResponse[] }>(
                `/agents/${agentId}/signing-keys`,
            );
            const keys = res.keys ?? [];

            if (opts.json) {
                printJson(keys);
                return;
            }

            if (!keys.length) {
                console.log(chalk.dim("No signing keys found."));
                return;
            }

            printTable(
                keys.map((k) => ({
                    id: k.id.slice(0, 8) + "…",
                    chain: k.chain,
                    curve: k.curve,
                    address: k.address ?? chalk.dim("—"),
                    version: String(k.key_version),
                    active: k.is_active ? chalk.green("✓") : chalk.dim("✗"),
                    created: new Date(k.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID" },
                    { key: "chain", header: "Chain", width: 12 },
                    { key: "curve", header: "Curve", width: 12 },
                    { key: "address", header: "Address", width: 44 },
                    { key: "version", header: "Ver" },
                    { key: "active", header: "Active" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

keysCommand
    .command("create <agent-id>")
    .description("Create a signing key for an agent")
    .requiredOption("--chain <chain>", "Chain name (e.g. ethereum, solana, bitcoin)")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const key = await api<SigningKeyResponse>(
                `/agents/${agentId}/signing-keys`,
                { method: "POST", body: { chain: opts.chain } },
            );

            if (opts.json) {
                printJson(key);
                return;
            }

            printSuccess(`Signing key created for ${chalk.bold(opts.chain)}.`);
            printKeyValue([
                ["ID", key.id],
                ["Chain", key.chain],
                ["Curve", key.curve],
                ["Public key", key.public_key],
                ["Address", key.address ?? chalk.dim("n/a")],
                ["Version", String(key.key_version)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

keysCommand
    .command("rotate <agent-id>")
    .description("Rotate a signing key for a chain")
    .requiredOption("--chain <chain>", "Chain name to rotate key for")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const key = await api<SigningKeyResponse>(
                `/agents/${agentId}/signing-keys/${encodeURIComponent(opts.chain)}/rotate`,
                { method: "POST" },
            );

            if (opts.json) {
                printJson(key);
                return;
            }

            printSuccess(`Signing key rotated for ${chalk.bold(opts.chain)}.`);
            printKeyValue([
                ["ID", key.id],
                ["Chain", key.chain],
                ["Curve", key.curve],
                ["Public key", key.public_key],
                ["Address", key.address ?? chalk.dim("n/a")],
                ["Version", String(key.key_version)],
            ]);
        } catch (err) {
            handleError(err);
        }
    });

keysCommand
    .command("delete <agent-id>")
    .description("Deactivate a signing key for a chain")
    .requiredOption("--chain <chain>", "Chain name to deactivate key for")
    .option("-y, --yes", "Skip confirmation")
    .action(async (agentId, opts) => {
        try {
            requireToken();

            if (!opts.yes) {
                const inquirer = await import("inquirer");
                const { confirm } = await inquirer.default.prompt([
                    {
                        type: "confirm",
                        name: "confirm",
                        message: `Deactivate signing key for ${opts.chain} on agent ${agentId}?`,
                        default: false,
                    },
                ]);
                if (!confirm) return;
            }

            await api(
                `/agents/${agentId}/signing-keys/${encodeURIComponent(opts.chain)}`,
                { method: "DELETE" },
            );
            printSuccess(`Signing key for ${chalk.bold(opts.chain)} deactivated.`);
        } catch (err) {
            handleError(err);
        }
    });

// ── Unified sign command ────────────────────────────────────────────────

interface SignIntentResponse {
    intent_type: string;
    chain: string;
    from: string;
    signature?: string;
    signed_tx?: string;
    tx_hash?: string;
    message_hash?: string;
    typed_data_hash?: string;
    tx_type?: number;
}

agentCommand
    .command("sign <agent-id>")
    .description("Unified signing: personal_sign, typed_data, or transaction")
    .requiredOption("--intent-type <type>", "Intent type: personal_sign, typed_data, transaction")
    .option("--chain <chain>", "Chain name", "ethereum")
    .option("--signing-key-path <path>", "Override vault path to signing key")
    .option("--message <hex>", "Hex-encoded message (personal_sign)")
    .option("--typed-data <file>", "Path to JSON file with EIP-712 typed data")
    .option("--to <address>", "Destination address (transaction)")
    .option("--value <eth>", "Value in ETH (transaction)")
    .option("--tx-type <n>", "Transaction type (0-4)")
    .option("--data <hex>", "Hex-encoded calldata (transaction)")
    .option("--nonce <n>", "Transaction nonce")
    .option("--gas-limit <n>", "Gas limit")
    .option("--gas-price <wei>", "Gas price in wei (legacy)")
    .option("--max-fee-per-gas <wei>", "EIP-1559 max fee per gas")
    .option("--max-priority-fee-per-gas <wei>", "EIP-1559 max priority fee")
    .option("--access-list <json>", "JSON-encoded access list")
    .option("--max-fee-per-blob-gas <wei>", "EIP-4844 max fee per blob gas")
    .option("--blob-versioned-hashes <hashes>", "Comma-separated blob versioned hashes")
    .option("--authorization-list <json>", "JSON-encoded authorization list (EIP-7702)")
    .option("--json", "Output raw JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();

            const body: Record<string, unknown> = {
                intent_type: opts.intentType,
                chain: opts.chain,
            };

            if (opts.signingKeyPath) body.signing_key_path = opts.signingKeyPath;
            if (opts.message) body.message = opts.message;

            if (opts.typedData) {
                const filePath = opts.typedData as string;
                if (!existsSync(filePath)) {
                    throw new Error(`Typed data file not found: ${filePath}`);
                }
                body.typed_data = JSON.parse(readFileSync(filePath, "utf8"));
            }

            if (opts.to) body.to = opts.to;
            if (opts.value) body.value = opts.value;
            if (opts.txType != null) body.tx_type = parseInt(opts.txType, 10);
            if (opts.data) body.data = opts.data;
            if (opts.nonce != null) body.nonce = parseInt(opts.nonce, 10);
            if (opts.gasLimit) body.gas_limit = parseInt(opts.gasLimit, 10);
            if (opts.gasPrice) body.gas_price = opts.gasPrice;
            if (opts.maxFeePerGas) body.max_fee_per_gas = opts.maxFeePerGas;
            if (opts.maxPriorityFeePerGas) body.max_priority_fee_per_gas = opts.maxPriorityFeePerGas;
            if (opts.accessList) body.access_list = JSON.parse(opts.accessList);
            if (opts.maxFeePerBlobGas) body.max_fee_per_blob_gas = opts.maxFeePerBlobGas;
            if (opts.blobVersionedHashes) {
                body.blob_versioned_hashes = (opts.blobVersionedHashes as string)
                    .split(",")
                    .map((h: string) => h.trim());
            }
            if (opts.authorizationList) body.authorization_list = JSON.parse(opts.authorizationList);

            const result = await api<SignIntentResponse>(
                `/agents/${agentId}/sign`,
                { method: "POST", body },
            );

            if (opts.json) {
                printJson(result);
                return;
            }

            printSuccess(`Signed ${chalk.bold(result.intent_type)} on ${chalk.bold(result.chain)}`);

            const rows: [string, string][] = [
                ["Intent type", result.intent_type],
                ["Chain", result.chain],
                ["From", result.from],
            ];

            if (result.signature) rows.push(["Signature", result.signature]);
            if (result.message_hash) rows.push(["Message hash", result.message_hash]);
            if (result.typed_data_hash) rows.push(["Typed data hash", result.typed_data_hash]);
            if (result.tx_type != null) rows.push(["Tx type", String(result.tx_type)]);
            if (result.signed_tx) rows.push(["Signed tx", result.signed_tx]);
            if (result.tx_hash) rows.push(["Tx hash", result.tx_hash]);

            printKeyValue(rows);
        } catch (err) {
            handleError(err);
        }
    });
