import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
    formatDate,
} from "../output.js";

interface ChatConversation {
    id: string;
    agent_id: string;
    title: string | null;
    mode: string;
    model: string | null;
    provider: string | null;
    created_at: string;
    updated_at: string;
}

interface ChatMessage {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    tokens_prompt: number;
    tokens_completion: number;
    model: string | null;
    created_at: string;
}

interface SendMessageResponse {
    conversation_id: string;
    message: ChatMessage;
}

export const chatCommand = new Command("chat")
    .description("Chat with agents via Shroud LLM");

chatCommand
    .command("send <agent-id> <message>")
    .description("Send a chat message to an agent (non-streaming)")
    .option("--conversation-id <id>", "Continue an existing conversation")
    .option("--model <model>", "LLM model to use")
    .option("--provider <provider>", "LLM provider (e.g. openai, anthropic)")
    .option("--json", "Output as JSON")
    .action(async (agentId, message, opts) => {
        try {
            requireToken();

            const body: Record<string, unknown> = { message };
            if (opts.conversationId) body.conversation_id = opts.conversationId;
            if (opts.model) body.model = opts.model;
            if (opts.provider) body.provider = opts.provider;

            const res = await api<SendMessageResponse>(
                `/agents/${agentId}/chat`,
                { method: "POST", body },
            );

            if (opts.json) {
                printJson(res);
                return;
            }

            console.log(chalk.dim(`Conversation: ${res.conversation_id}`));
            console.log(chalk.dim(`Model: ${res.message.model ?? "default"}`));
            console.log();
            console.log(chalk.bold("Assistant:"));
            console.log(res.message.content);

            if (res.message.tokens_prompt || res.message.tokens_completion) {
                console.log(
                    chalk.dim(
                        `\n(${res.message.tokens_prompt} prompt + ${res.message.tokens_completion} completion tokens)`,
                    ),
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

chatCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List chat conversations for an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const res = await api<{ conversations: ChatConversation[] }>(
                `/agents/${agentId}/chat/conversations`,
            );
            const items = res.conversations ?? [];

            if (opts.json) {
                printJson(items);
                return;
            }

            if (items.length === 0) {
                console.log(chalk.dim("No conversations found."));
                return;
            }

            printTable(
                items.map((c) => ({
                    id: c.id,
                    title: c.title ?? chalk.dim("(untitled)"),
                    mode: c.mode,
                    model: c.model ?? chalk.dim("—"),
                    updated: formatDate(c.updated_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "title", header: "Title", width: 30 },
                    { key: "mode", header: "Mode", width: 10 },
                    { key: "model", header: "Model", width: 20 },
                    { key: "updated", header: "Updated" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

chatCommand
    .command("get <agent-id> <conversation-id>")
    .description("Show conversation messages")
    .option("--json", "Output as JSON")
    .action(async (agentId, conversationId, opts) => {
        try {
            requireToken();
            const res = await api<{
                conversation: ChatConversation;
                messages: ChatMessage[];
            }>(`/agents/${agentId}/chat/conversations/${conversationId}`);

            if (opts.json) {
                printJson(res);
                return;
            }

            printKeyValue([
                ["Conversation ID", res.conversation.id],
                ["Title", res.conversation.title ?? "(untitled)"],
                ["Mode", res.conversation.mode],
                ["Model", res.conversation.model ?? "—"],
                ["Created", formatDate(res.conversation.created_at)],
            ]);

            console.log(chalk.bold(`\nMessages (${res.messages.length}):\n`));
            for (const msg of res.messages) {
                const roleColor = msg.role === "user" ? chalk.blue : chalk.green;
                console.log(roleColor(`[${msg.role}]`) + chalk.dim(` ${formatDate(msg.created_at)}`));
                console.log(msg.content);
                console.log();
            }
        } catch (err) {
            handleError(err);
        }
    });

chatCommand
    .command("delete <agent-id> <conversation-id>")
    .alias("rm")
    .description("Archive a conversation")
    .action(async (agentId, conversationId) => {
        try {
            requireToken();
            await api(`/agents/${agentId}/chat/conversations/${conversationId}`, {
                method: "DELETE",
            });
            printSuccess("Conversation archived.");
        } catch (err) {
            handleError(err);
        }
    });
