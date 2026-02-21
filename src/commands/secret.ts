import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, resolveVaultId, handleError } from "../middleware.js";
import { printTable, printKeyValue, printSuccess, printJson, printWarning } from "../output.js";

interface Secret {
  id: string;
  path: string;
  secret_type: string;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

interface SecretValue extends Secret {
  value: string;
}

export const secretCommand = new Command("secret").description(
  "Manage secrets",
);

secretCommand
  .command("list")
  .alias("ls")
  .description("List secrets in a vault")
  .option("-v, --vault <id>", "Vault ID")
  .option("--prefix <prefix>", "Filter by path prefix")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);
      const query: Record<string, string> = {};
      if (opts.prefix) query.prefix = opts.prefix;

      const secrets = await api<Secret[]>(`/vaults/${vaultId}/secrets`, {
        query,
      });

      if (opts.json) {
        printJson(secrets);
        return;
      }

      printTable(
        secrets.map((s) => ({
          ...s,
          updated: new Date(s.updated_at).toLocaleDateString(),
          expires: s.expires_at
            ? new Date(s.expires_at).toLocaleDateString()
            : chalk.dim("—"),
        })),
        [
          { key: "path", header: "Path", width: 35 },
          { key: "secret_type", header: "Type", width: 14 },
          { key: "version", header: "Ver" },
          { key: "updated", header: "Updated" },
          { key: "expires", header: "Expires" },
        ],
      );
    } catch (err) {
      handleError(err);
    }
  });

secretCommand
  .command("get <path>")
  .description("Fetch a decrypted secret value")
  .option("-v, --vault <id>", "Vault ID")
  .option("--json", "Output as JSON")
  .option("--quiet", "Print only the raw value (for piping)")
  .action(async (path, opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);
      const secret = await api<SecretValue>(
        `/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`,
      );

      if (opts.quiet) {
        process.stdout.write(secret.value);
        return;
      }

      if (opts.json) {
        printJson(secret);
        return;
      }

      printKeyValue([
        ["Path", secret.path],
        ["Type", secret.secret_type],
        ["Version", String(secret.version)],
        ["Value", secret.value],
        ["Updated", new Date(secret.updated_at).toLocaleString()],
      ]);
    } catch (err) {
      handleError(err);
    }
  });

secretCommand
  .command("set <path> [value]")
  .description("Create or update a secret")
  .option("-v, --vault <id>", "Vault ID")
  .option("-t, --type <type>", "Secret type", "api_key")
  .option("-e, --expires <date>", "Expiration date (ISO 8601)")
  .option("--stdin", "Read value from stdin")
  .action(async (path, value, opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);

      let secretValue = value;
      if (opts.stdin || !value) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        secretValue = Buffer.concat(chunks).toString().trim();
      }

      if (!secretValue) {
        printWarning("No value provided. Use a value argument or --stdin.");
        process.exit(1);
      }

      const body: Record<string, unknown> = {
        value: secretValue,
        secret_type: opts.type,
      };
      if (opts.expires) body.expires_at = opts.expires;

      await api(`/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`, {
        method: "PUT",
        body,
      });

      printSuccess(`Secret ${chalk.bold(path)} saved.`);
    } catch (err) {
      handleError(err);
    }
  });

secretCommand
  .command("delete <path>")
  .description("Soft-delete a secret")
  .option("-v, --vault <id>", "Vault ID")
  .option("-y, --yes", "Skip confirmation")
  .action(async (path, opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);

      if (!opts.yes) {
        const inquirer = await import("inquirer");
        const { confirm } = await inquirer.default.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: `Delete secret "${path}"?`,
            default: false,
          },
        ]);
        if (!confirm) return;
      }

      await api(`/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`, {
        method: "DELETE",
      });
      printSuccess(`Secret ${chalk.bold(path)} deleted.`);
    } catch (err) {
      handleError(err);
    }
  });

secretCommand
  .command("rotate <path> [value]")
  .description("Store a new version of an existing secret")
  .option("-v, --vault <id>", "Vault ID")
  .option("--stdin", "Read value from stdin")
  .action(async (path, value, opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);

      let secretValue = value;
      if (opts.stdin || !value) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        secretValue = Buffer.concat(chunks).toString().trim();
      }

      await api(`/vaults/${vaultId}/secrets/${encodeURIComponent(path)}`, {
        method: "PUT",
        body: { value: secretValue },
      });

      printSuccess(`Secret ${chalk.bold(path)} rotated.`);
    } catch (err) {
      handleError(err);
    }
  });

secretCommand
  .command("describe <path>")
  .description("Get secret metadata (no value)")
  .option("-v, --vault <id>", "Vault ID")
  .option("--json", "Output as JSON")
  .action(async (path, opts) => {
    try {
      requireToken();
      const vaultId = resolveVaultId(opts);
      const secret = await api<Secret>(
        `/vaults/${vaultId}/secrets/${encodeURIComponent(path)}/metadata`,
      );

      if (opts.json) {
        printJson(secret);
        return;
      }

      printKeyValue([
        ["Path", secret.path],
        ["Type", secret.secret_type],
        ["Version", String(secret.version)],
        ["Created", new Date(secret.created_at).toLocaleString()],
        ["Updated", new Date(secret.updated_at).toLocaleString()],
        [
          "Expires",
          secret.expires_at
            ? new Date(secret.expires_at).toLocaleString()
            : "never",
        ],
      ]);
    } catch (err) {
      handleError(err);
    }
  });
