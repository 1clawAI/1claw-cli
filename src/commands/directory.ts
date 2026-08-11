import { Command } from "commander";
import chalk from "chalk";
import { api, apiNoAuth } from "../client.js";
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
                    const params: Record<string, string> = {
                        page: opts.page,
                        page_size: "20",
                    };
                    if (query) params.q = query;
                    if (opts.tags) params.tags = opts.tags;

                    const data = await apiNoAuth<{
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
                    }>("/agents/directory", { query: params });

                    if (opts.json) {
                        printJson(data);
                        return;
                    }

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
                        data.agents.map((a) => ({
                            name: a.name,
                            id: a.id.slice(0, 8) + "...",
                            capabilities: a.capabilities.join(", "),
                            tags: a.tags.join(", "),
                            a2a_url: a.a2a_url ?? "-",
                        })),
                        [
                            { key: "name", header: "Name", width: 24 },
                            { key: "id", header: "ID", width: 12 },
                            { key: "capabilities", header: "Capabilities", width: 30 },
                            { key: "tags", header: "Tags", width: 20 },
                            { key: "a2a_url", header: "A2A URL", width: 30 },
                        ],
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
                    const card = await apiNoAuth<{
                        id: string;
                        name: string;
                        description: string;
                        tags: string[];
                        a2a_url?: string;
                        mcp_url?: string;
                        capabilities: string[];
                    }>(`/agents/${agentId}/card`);

                    if (opts.json) {
                        printJson(card);
                        return;
                    }

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
    )
    .addCommand(
        new Command("org")
            .description("List agents in your organization")
            .option("-q, --query <query>", "Search query")
            .option("--tags <tags>", "Filter by comma-separated tags")
            .option("--page <page>", "Page number", "1")
            .option("--page-size <size>", "Results per page", "20")
            .option("--json", "Output as JSON")
            .action(async (opts) => {
                try {
                    const params: Record<string, string> = {
                        page: opts.page,
                        page_size: opts.pageSize,
                    };
                    if (opts.query) params.q = opts.query;
                    if (opts.tags) params.tags = opts.tags;

                    const data = await api<{
                        agents: Array<{
                            id: string;
                            name: string;
                            description: string;
                            tags: string[];
                            capabilities: string[];
                        }>;
                        total: number;
                        page: number;
                    }>("/agents/org-directory", { query: params });

                    if (opts.json) {
                        printJson(data);
                        return;
                    }

                    if (data.agents.length === 0) {
                        console.log(chalk.yellow("No agents found in your organization."));
                        return;
                    }

                    console.log(
                        chalk.bold(
                            `Found ${data.total} agent(s) in your org (page ${data.page}):\n`,
                        ),
                    );

                    printTable(
                        data.agents.map((a) => ({
                            name: a.name,
                            id: a.id.slice(0, 8) + "...",
                            tags: (a.tags || []).join(", "),
                            capabilities: (a.capabilities || []).join(", "),
                        })),
                        [
                            { key: "name", header: "Name", width: 24 },
                            { key: "id", header: "ID", width: 12 },
                            { key: "tags", header: "Tags", width: 20 },
                            { key: "capabilities", header: "Capabilities", width: 30 },
                        ],
                    );
                } catch (err) {
                    handleError(err);
                }
            }),
    );
