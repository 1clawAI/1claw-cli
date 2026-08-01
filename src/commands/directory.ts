import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { handleError } from "../middleware.js";
import { printTable, printKeyValue, printJson } from "../output.js";

export const directoryCommand = new Command("directory")
    .description("Browse the public agent directory")
    .addCommand(
        new Command("search")
            .description("Search for agents in the directory")
            .argument("[query]", "Search query")
            .option("--tags <tags>", "Filter by comma-separated tags")
            .option("--page <page>", "Page number", "1")
            .option("--json", "Output as JSON")
            .action(async (query, opts) => {
                try {
                    const params = new URLSearchParams();
                    if (query) params.set("q", query);
                    if (opts.tags) params.set("tags", opts.tags);
                    params.set("page", opts.page);
                    params.set("page_size", "20");
                    const qs = params.toString();

                    const result = await api.get(
                        `/v1/agents/directory${qs ? `?${qs}` : ""}`,
                    );

                    if (opts.json) {
                        printJson(result);
                        return;
                    }

                    const data = result as {
                        agents: Array<{
                            id: string;
                            name: string;
                            description: string;
                            tags: string[];
                            a2a_url?: string;
                            capabilities: string[];
                        }>;
                        total: number;
                        page: number;
                    };

                    if (data.agents.length === 0) {
                        console.log(chalk.yellow("No agents found."));
                        return;
                    }

                    console.log(
                        chalk.bold(
                            `Found ${data.total} agent(s) (page ${data.page}):\n`,
                        ),
                    );

                    printTable(
                        ["Name", "ID", "Capabilities", "Tags", "A2A URL"],
                        data.agents.map((a) => [
                            a.name,
                            a.id.slice(0, 8) + "...",
                            a.capabilities.join(", "),
                            a.tags.join(", "),
                            a.a2a_url ?? "-",
                        ]),
                    );
                } catch (err) {
                    handleError(err);
                }
            }),
    )
    .addCommand(
        new Command("card")
            .description("Get an agent's public card")
            .argument("<agent-id>", "Agent ID")
            .option("--json", "Output as JSON")
            .action(async (agentId, opts) => {
                try {
                    const result = await api.get(
                        `/v1/agents/${agentId}/card`,
                    );

                    if (opts.json) {
                        printJson(result);
                        return;
                    }

                    const card = result as {
                        id: string;
                        name: string;
                        description: string;
                        tags: string[];
                        a2a_url?: string;
                        mcp_url?: string;
                        capabilities: string[];
                    };

                    printKeyValue([
                        ["Name", card.name],
                        ["ID", card.id],
                        ["Description", card.description],
                        ["Capabilities", card.capabilities.join(", ")],
                        ["Tags", card.tags.join(", ")],
                        ["A2A URL", card.a2a_url ?? "-"],
                        ["MCP URL", card.mcp_url ?? "-"],
                    ]);
                } catch (err) {
                    handleError(err);
                }
            }),
    );
