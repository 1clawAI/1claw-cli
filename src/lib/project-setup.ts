/** Find or create what a project needs in 1Claw: its vault, and its app's agent with access to that vault. */
import { basename } from "node:path";
import inquirer from "inquirer";
import chalk from "chalk";
import { api } from "../client.js";
import { printSuccess } from "../output.js";
import { readAgentKey, readProject, writeAgentKey, writeProject } from "./project.js";

interface NamedVault {
    id: string;
    name: string;
}

async function listVaults(): Promise<NamedVault[]> {
    const res = await api<{ vaults?: NamedVault[] } | NamedVault[]>("/vaults");
    return Array.isArray(res) ? res : (res.vaults ?? []);
}

async function createVault(name: string): Promise<NamedVault> {
    return api<NamedVault>("/vaults", { method: "POST", body: { name, description: `Secrets for the ${name} project` } });
}

export const canAsk = () => process.env.CLAUDECODE !== "1" && Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** The vault for the current folder. Asks once, then remembers it in `.1claw/project.json`. */
export async function chooseProjectVault(opts: { vault?: string; yes?: boolean; quiet?: boolean }): Promise<string> {
    const dir = process.cwd();
    const say = (msg: string) => {
        if (!opts.quiet) printSuccess(msg);
    };
    if (opts.vault) {
        writeProject(readProject(dir)?.root ?? dir, { vault_id: opts.vault });
        return opts.vault;
    }
    const project = readProject(dir);
    if (project?.data.vault_id) return project.data.vault_id;
    if (process.env.ONECLAW_VAULT_ID) return process.env.ONECLAW_VAULT_ID;

    const name = basename(dir);
    const vaults = await listVaults();
    const sameName = vaults.find((v) => v.name === name);
    const remember = (v: NamedVault, verb: string) => {
        writeProject(dir, { vault_id: v.id, vault_name: v.name });
        say(`Vault ${chalk.bold(v.name)} ${verb}, remembered for this folder`);
        return v.id;
    };

    if (!canAsk()) {
        if (opts.yes) return sameName ? remember(sameName, "found") : remember(await createVault(name), "created");
        throw new Error(`No vault for this project. Run this in your own terminal to choose one, or pass --yes to use "${name}".`);
    }

    const CREATE = "\0create";
    const { choice } = await inquirer.prompt<{ choice: string }>([
        {
            type: "select",
            name: "choice",
            message: "Which vault should this project use?",
            choices: [
                ...(sameName ? [] : [{ name: `Create "${name}"`, value: CREATE }]),
                ...vaults.map((v) => ({ name: `Use "${v.name}"`, value: v.id })),
            ],
            default: sameName?.id,
        },
    ]);
    if (choice === CREATE) return remember(await createVault(name), "created");
    return remember(vaults.find((v) => v.id === choice)!, "selected");
}

export interface AppSpec {
    name?: string;
    environment?: string;
}

/**
 * This app's agent: an identity allowed to read this vault and use bindings. Its
 * key is shown only at creation, so it goes straight into `.env` and is never printed.
 */
export async function ensureAppAgent(vaultId: string, app: AppSpec): Promise<{ id: string; name: string; created: boolean }> {
    const project = readProject();
    const root = project?.root ?? process.cwd();
    const environment = app.environment ?? "production";
    let id = project?.data.agent_id;
    let name = project?.data.agent_name ?? app.name ?? basename(root);
    let created = false;

    if (id) {
        if (!readAgentKey(root)) throw new Error(`This project's agent ${name} has no key in .env. Its key is only shown at creation, so create a new agent.`);
    } else {
        const list = await api<{ agents?: { id: string; name: string }[] }>("/agents");
        if ((list.agents ?? []).some((a) => a.name === name)) {
            throw new Error(`An agent named "${name}" already exists, and its key is only shown when it's created. Delete it, or set "app": {"name": "..."} in the plan.`);
        }
        const res = await api<{ agent: { id: string; name: string }; api_key?: string }>("/agents", {
            method: "POST",
            body: { name, execution_intents_enabled: true, environment, vault_ids: [vaultId] },
        });
        if (!res.api_key) throw new Error("1Claw did not return a key for the new agent");
        id = res.agent.id;
        name = res.agent.name;
        created = true;
        writeAgentKey(root, res.api_key);
        writeProject(root, { agent_id: id, agent_name: name, environment });
    }

    const policies = await api<{ policies?: { principal_id: string; secret_path_pattern: string }[] }>(`/vaults/${vaultId}/policies`);
    if (!(policies.policies ?? []).some((p) => p.principal_id === id && p.secret_path_pattern === "**")) {
        await api(`/vaults/${vaultId}/policies`, {
            method: "POST",
            body: { principal_type: "agent", principal_id: id, secret_path_pattern: "**", permissions: ["read"], policy_schema_version: 2 },
        });
    }
    return { id, name, created };
}
