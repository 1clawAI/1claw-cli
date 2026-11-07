import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printSuccess } from "../output.js";
import { readProject } from "../lib/project.js";

function setActive(active: boolean, opts: { agent?: string }) {
    return async () => {
        try {
            requireToken();
            const project = readProject()?.data;
            const id = opts.agent ?? project?.agent_id;
            if (!id) throw new Error("This folder has no agent yet. Pass --agent <id>.");
            await api(`/agents/${id}`, { method: "PATCH", body: { is_active: active } });
            const name = chalk.bold(project?.agent_name ?? id);
            printSuccess(active ? `${name} restored. Its key works again.` : `${name} revoked. Its key stopped working just now.`);
        } catch (err) {
            handleError(err);
        }
    };
}

export const revokeCommand = new Command("revoke")
    .description("Cut this project's app off from 1Claw right now")
    .option("--agent <id>", "Agent ID (default: this project's)")
    .action((opts) => setActive(false, opts)());

export const restoreCommand = new Command("restore")
    .description("Give this project's app its access back")
    .option("--agent <id>", "Agent ID (default: this project's)")
    .action((opts) => setActive(true, opts)());
