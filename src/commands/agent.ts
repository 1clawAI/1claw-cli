import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printKeyValue, printSuccess, printJson } from "../output.js";

interface Agent {
  id: string;
  name: string;
  scopes: string[];
  crypto_proxy_enabled: boolean;
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
          crypto: a.crypto_proxy_enabled ? chalk.green("✓") : chalk.dim("—"),
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
  .option("--scopes <scopes>", "Comma-separated scopes", "vault.read,vault.write")
  .option("--crypto-proxy", "Enable crypto transaction proxy")
  .action(async (name, opts) => {
    try {
      requireToken();
      const body: Record<string, unknown> = {
        name,
        scopes: opts.scopes.split(",").map((s: string) => s.trim()),
      };
      if (opts.cryptoProxy) body.crypto_proxy_enabled = true;

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
          chalk.yellow("  Save this API key — it won't be shown again:"),
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

      printKeyValue([
        ["ID", agent.id],
        ["Name", agent.name],
        ["Scopes", agent.scopes.join(", ")],
        ["Crypto proxy", agent.crypto_proxy_enabled ? "enabled" : "disabled"],
        ["Created by", agent.created_by],
        ["Created", new Date(agent.created_at).toLocaleString()],
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
