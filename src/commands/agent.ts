import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
} from "../output.js";

interface Agent {
    id: string;
    name: string;
    scopes: string[];
    crypto_proxy_enabled: boolean;
    tx_to_allowlist?: string[];
    tx_max_value_eth?: string;
    tx_daily_limit_eth?: string;
    tx_allowed_chains?: string[];
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
            const agents = await api<Agent[]>("/agents");

            if (opts.json) {
                printJson(agents);
                return;
            }

            printTable(
                agents.map((a) => ({
                    ...a,
                    crypto: a.crypto_proxy_enabled
                        ? chalk.green("✓")
                        : chalk.dim("—"),
                    scopes: a.scopes.join(", "),
                    created: new Date(a.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "name", header: "Name", width: 24 },
                    { key: "scopes", header: "Scopes", width: 30 },
                    { key: "crypto", header: "Crypto" },
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
    .option("--crypto-proxy", "Enable crypto transaction proxy")
    .option("--tx-to-allowlist <addrs>", "Comma-separated allowed destination addresses")
    .option("--tx-max-value <eth>", "Max ETH value per transaction")
    .option("--tx-daily-limit <eth>", "Max ETH spend per 24h rolling window")
    .option("--tx-allowed-chains <chains>", "Comma-separated allowed chain names")
    .action(async (name, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {
                name,
                scopes: opts.scopes.split(",").map((s: string) => s.trim()),
            };
            if (opts.cryptoProxy) body.crypto_proxy_enabled = true;
            if (opts.txToAllowlist) body.tx_to_allowlist = opts.txToAllowlist.split(",").map((s: string) => s.trim());
            if (opts.txMaxValue) body.tx_max_value_eth = opts.txMaxValue;
            if (opts.txDailyLimit) body.tx_daily_limit_eth = opts.txDailyLimit;
            if (opts.txAllowedChains) body.tx_allowed_chains = opts.txAllowedChains.split(",").map((s: string) => s.trim());

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
                ["Scopes", agent.scopes.join(", ")],
                [
                    "Crypto proxy",
                    agent.crypto_proxy_enabled ? "enabled" : "disabled",
                ],
            ];
            if (agent.crypto_proxy_enabled) {
                rows.push([
                    "Allowed destinations",
                    agent.tx_to_allowlist?.length ? agent.tx_to_allowlist.join(", ") : chalk.dim("any"),
                ]);
                rows.push([
                    "Max value/tx",
                    agent.tx_max_value_eth ? `${agent.tx_max_value_eth} ETH` : chalk.dim("unlimited"),
                ]);
                rows.push([
                    "Daily limit",
                    agent.tx_daily_limit_eth ? `${agent.tx_daily_limit_eth} ETH` : chalk.dim("unlimited"),
                ]);
                rows.push([
                    "Allowed chains",
                    agent.tx_allowed_chains?.length ? agent.tx_allowed_chains.join(", ") : chalk.dim("all"),
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
    .option("--crypto-proxy <bool>", "Enable/disable crypto proxy (true/false)")
    .option("--tx-to-allowlist <addrs>", 'Comma-separated allowed destination addresses (use "" to clear)')
    .option("--tx-max-value <eth>", 'Max ETH value per transaction (use "" to remove)')
    .option("--tx-daily-limit <eth>", 'Max ETH spend per 24h (use "" to remove)')
    .option("--tx-allowed-chains <chains>", 'Comma-separated allowed chains (use "" to clear)')
    .option("--active <bool>", "Set agent active status (true/false)")
    .action(async (id, opts) => {
        try {
            requireToken();
            const body: Record<string, unknown> = {};

            if (opts.cryptoProxy !== undefined) body.crypto_proxy_enabled = opts.cryptoProxy === "true";
            if (opts.active !== undefined) body.is_active = opts.active === "true";
            if (opts.txToAllowlist !== undefined) {
                body.tx_to_allowlist = opts.txToAllowlist === "" ? [] : opts.txToAllowlist.split(",").map((s: string) => s.trim());
            }
            if (opts.txMaxValue !== undefined) {
                body.tx_max_value_eth = opts.txMaxValue === "" ? null : opts.txMaxValue;
            }
            if (opts.txDailyLimit !== undefined) {
                body.tx_daily_limit_eth = opts.txDailyLimit === "" ? null : opts.txDailyLimit;
            }
            if (opts.txAllowedChains !== undefined) {
                body.tx_allowed_chains = opts.txAllowedChains === "" ? [] : opts.txAllowedChains.split(",").map((s: string) => s.trim());
            }

            if (Object.keys(body).length === 0) {
                console.log(chalk.yellow("No update options provided. Use --help for available flags."));
                return;
            }

            const agent = await api<Agent>(`/agents/${id}`, {
                method: "PATCH",
                body,
            });

            printSuccess(`Agent ${chalk.bold(agent.name)} updated.`);
            printKeyValue([
                ["ID", agent.id],
                ["Crypto proxy", agent.crypto_proxy_enabled ? "enabled" : "disabled"],
                ["Allowed destinations", agent.tx_to_allowlist?.length ? agent.tx_to_allowlist.join(", ") : chalk.dim("any")],
                ["Max value/tx", agent.tx_max_value_eth ? `${agent.tx_max_value_eth} ETH` : chalk.dim("unlimited")],
                ["Daily limit", agent.tx_daily_limit_eth ? `${agent.tx_daily_limit_eth} ETH` : chalk.dim("unlimited")],
                ["Allowed chains", agent.tx_allowed_chains?.length ? agent.tx_allowed_chains.join(", ") : chalk.dim("all")],
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
