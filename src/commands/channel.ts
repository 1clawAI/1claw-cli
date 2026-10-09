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

interface Channel {
    id: string;
    org_id: string;
    agent_id: string;
    channel_type: string;
    channel_name: string | null;
    webhook_path: string | null;
    webhook_url: string | null;
    is_active: boolean;
    /** Holds `owner_sender_id`, which is what gates admin slash commands. */
    metadata?: Record<string, unknown> | null;
    sender_allowlist?: string[] | null;
    created_at: string;
    updated_at: string;
}

interface ChannelMessage {
    id: string;
    channel_id: string;
    direction: string;
    external_chat_id: string;
    external_message_id: string | null;
    sender_name: string | null;
    content: string;
    media_url: string | null;
    created_at: string;
}

export const channelCommand = new Command("channel")
    .description("Manage agent messaging channels (Telegram, WhatsApp, Discord)");

channelCommand
    .command("create <agent-id>")
    .description("Register a new messaging channel")
    .requiredOption("--type <type>", "Channel type: telegram, whatsapp, or discord")
    .option("--name <name>", "Display name for the channel")
    .requiredOption("--config <json>", "Channel config JSON (e.g. bot_token, phone_number_id)")
    .option(
        "--slash-commands",
        'Enable Hermes-compatible slash commands (/help, /new, /model, /personality, /retry, /undo, /compress, /stop, /status, /skills, /usage, /sethome)',
    )
    .option(
        "--voice-transcription",
        "Enable automatic voice message transcription via Whisper API (Telegram only)",
    )
    .option(
        "--sender-allowlist <ids>",
        "Comma-separated sender IDs that may message the agent AND run admin slash commands. Setting it stops every other sender getting replies",
        (v: string) => v.split(",").map((s: string) => s.trim()),
    )
    .option("--auto-respond", "Enable auto-respond for inbound messages")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();

            let config: Record<string, string>;
            try {
                config = JSON.parse(opts.config);
            } catch {
                console.error(chalk.red("Error: --config must be valid JSON"));
                process.exit(1);
            }

            const body: Record<string, unknown> = {
                channel_type: opts.type,
                config,
            };
            if (opts.name) body.channel_name = opts.name;
            if (opts.slashCommands) body.slash_commands_enabled = true;
            if (opts.voiceTranscription) body.voice_transcription_enabled = true;
            if (opts.senderAllowlist) body.sender_allowlist = opts.senderAllowlist;
            if (opts.autoRespond) body.auto_respond_enabled = true;

            const ch = await api<Channel>(`/agents/${agentId}/channels`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(ch);
                return;
            }

            printSuccess(`Channel created: ${chalk.bold(ch.channel_type)} (${ch.id})`);
            if (ch.webhook_url) {
                console.log(chalk.dim("Webhook URL:"), ch.webhook_url);
            }
        } catch (err) {
            handleError(err);
        }
    });

channelCommand
    .command("list <agent-id>")
    .alias("ls")
    .description("List channels for an agent")
    .option("--json", "Output as JSON")
    .action(async (agentId, opts) => {
        try {
            requireToken();
            const res = await api<{ channels: Channel[] }>(
                `/agents/${agentId}/channels`,
            );
            const items = res.channels ?? [];

            if (opts.json) {
                printJson(items);
                return;
            }

            if (items.length === 0) {
                console.log(chalk.dim("No channels found."));
                return;
            }

            printTable(
                items.map((ch) => ({
                    id: ch.id,
                    type: ch.channel_type,
                    name: ch.channel_name ?? chalk.dim("—"),
                    active: ch.is_active ? chalk.green("✓") : chalk.red("✗"),
                    webhook: ch.webhook_url
                        ? ch.webhook_url.slice(0, 50) + (ch.webhook_url.length > 50 ? "…" : "")
                        : chalk.dim("—"),
                    created: formatDate(ch.created_at),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "type", header: "Type", width: 10 },
                    { key: "name", header: "Name", width: 16 },
                    { key: "active", header: "Active", width: 8 },
                    { key: "webhook", header: "Webhook URL", width: 52 },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

/** Parsed `channel update` flags, as commander hands them over. */
export interface ChannelUpdateOpts {
    name?: string;
    active?: string;
    config?: string;
    slashCommands?: string;
    voiceTranscription?: string;
    /** `string[]` from the parser, or `""` for the clear form. */
    senderAllowlist?: string[] | "";
    /** `""` for the revoke form. */
    admin?: string;
    autoRespond?: string;
}

/**
 * Turn `channel update` flags into a PATCH body.
 *
 * Exported so the three states of each clearable field can be tested without a
 * server. The distinction is the whole point and is easy to lose: an omitted
 * key means "leave it alone", and only an explicit `null` (admin) or `[]`
 * (allowlist) clears. The vault keeps those apart via `double_option`; sending
 * `undefined` here would serialise to an absent key and silently do nothing —
 * which is the exact failure this command was reported for.
 */
export function buildChannelUpdateBody(
    opts: ChannelUpdateOpts,
): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (opts.name) body.channel_name = opts.name;
    if (opts.active !== undefined) body.is_active = opts.active === "true";
    if (opts.config) body.config = JSON.parse(opts.config);
    if (opts.slashCommands !== undefined) body.slash_commands_enabled = opts.slashCommands === "true";
    if (opts.voiceTranscription !== undefined) body.voice_transcription_enabled = opts.voiceTranscription === "true";
    if (opts.senderAllowlist !== undefined) {
        body.sender_allowlist = opts.senderAllowlist === "" ? [] : opts.senderAllowlist;
    }
    if (opts.admin !== undefined) {
        body.owner_sender_id = opts.admin === "" ? null : opts.admin;
    }
    if (opts.autoRespond !== undefined) body.auto_respond_enabled = opts.autoRespond === "true";
    return body;
}

channelCommand
    .command("update <agent-id> <channel-id>")
    .description("Update a channel")
    .option("--name <name>", "New display name")
    .option("--active <bool>", "Enable or disable the channel")
    .option("--config <json>", "Updated config JSON")
    .option(
        "--slash-commands <bool>",
        'Enable/disable Hermes-compatible slash commands (/help, /new, /model, /personality, /retry, /undo, /compress, /stop, /status, /skills, /usage, /sethome)',
    )
    .option(
        "--voice-transcription <bool>",
        "Enable/disable automatic voice message transcription via Whisper API (Telegram only)",
    )
    .option(
        "--sender-allowlist <ids>",
        'Comma-separated sender IDs that may message the agent AND run admin slash commands. Setting it stops every other sender getting replies (use "" to clear)',
        (v: string) => v === "" ? "" : v.split(",").map((s: string) => s.trim()),
    )
    .option(
        "--admin <id>",
        'Sender ID that may run admin slash commands, without restricting who can message the agent (use "" to revoke)',
    )
    .option("--auto-respond <bool>", "Enable/disable auto-respond for inbound messages")
    .option("--json", "Output as JSON")
    .action(async (agentId, channelId, opts) => {
        try {
            requireToken();

            const body = buildChannelUpdateBody(opts);

            const ch = await api<Channel>(
                `/agents/${agentId}/channels/${channelId}`,
                { method: "PATCH", body },
            );

            if (opts.json) {
                printJson(ch);
                return;
            }

            printSuccess(`Channel updated: ${chalk.bold(ch.channel_type)} (${ch.id})`);

            // Echo back what the server stored, not what was asked for. The
            // reported bug here was a 200 with a fresh `updated_at` and no
            // change — a confirmation that only repeats the request would have
            // looked identical.
            if (opts.admin !== undefined) {
                const stored = ch.metadata?.owner_sender_id;
                if (typeof stored === "string") {
                    console.log(`  Admin: ${chalk.bold(stored)}`);
                } else if ((ch.sender_allowlist ?? []).length > 0) {
                    console.log(
                        `  Admin: none named; the allowlist (${(ch.sender_allowlist ?? []).join(", ")}) grants admin commands`,
                    );
                } else {
                    console.log(
                        `  Admin: ${chalk.yellow("nobody")} — admin slash commands are refused until one is named`,
                    );
                }
            }
            if (opts.senderAllowlist !== undefined) {
                const list = ch.sender_allowlist ?? [];
                console.log(
                    list.length > 0
                        ? `  Allowed senders: ${chalk.bold(list.join(", "))} (everyone else gets no reply)`
                        : `  Allowed senders: ${chalk.bold("anyone")}`,
                );
            }
        } catch (err) {
            handleError(err);
        }
    });

channelCommand
    .command("delete <agent-id> <channel-id>")
    .alias("rm")
    .description("Delete a channel")
    .action(async (agentId, channelId) => {
        try {
            requireToken();
            await api(`/agents/${agentId}/channels/${channelId}`, {
                method: "DELETE",
            });
            printSuccess("Channel deleted.");
        } catch (err) {
            handleError(err);
        }
    });

channelCommand
    .command("send <agent-id> <channel-id>")
    .description("Send an outbound message via a channel")
    .requiredOption("--chat-id <id>", "External chat/user ID to send to")
    .requiredOption("--message <text>", "Message content")
    .option("--reply-to <id>", "External message ID to reply to")
    .option("--json", "Output as JSON")
    .action(async (agentId, channelId, opts) => {
        try {
            requireToken();

            const body: Record<string, unknown> = {
                external_chat_id: opts.chatId,
                content: opts.message,
            };
            if (opts.replyTo) body.reply_to = opts.replyTo;

            const res = await api(`/agents/${agentId}/channels/${channelId}/send`, {
                method: "POST",
                body,
            });

            if (opts.json) {
                printJson(res);
                return;
            }

            printSuccess("Message sent.");
        } catch (err) {
            handleError(err);
        }
    });

channelCommand
    .command("messages <agent-id> <channel-id>")
    .alias("msgs")
    .description("List message history for a channel")
    .option("--limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(async (agentId, channelId, opts) => {
        try {
            requireToken();
            const res = await api<{ messages: ChannelMessage[] }>(
                `/agents/${agentId}/channels/${channelId}/messages`,
                { query: { limit: parseInt(opts.limit, 10) } },
            );
            const msgs = res.messages ?? [];

            if (opts.json) {
                printJson(msgs);
                return;
            }

            if (msgs.length === 0) {
                console.log(chalk.dim("No messages found."));
                return;
            }

            for (const msg of msgs) {
                const dirColor = msg.direction === "inbound" ? chalk.blue : chalk.green;
                const arrow = msg.direction === "inbound" ? "←" : "→";
                const sender = msg.sender_name ?? msg.external_chat_id;
                console.log(
                    dirColor(`${arrow} [${msg.direction}]`) +
                    chalk.dim(` ${sender} · ${formatDate(msg.created_at)}`),
                );
                console.log(`  ${msg.content}`);
                console.log();
            }
        } catch (err) {
            handleError(err);
        }
    });
