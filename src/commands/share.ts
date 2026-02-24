import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printJson,
    printInfo,
} from "../output.js";

interface Share {
    id: string;
    secret_id: string;
    secret_path?: string;
    recipient_type: string;
    recipient_id?: string;
    recipient_email?: string;
    status: string;
    expires_at?: string;
    max_access_count?: number;
    access_count: number;
    created_at: string;
    share_url?: string;
}

export const shareCommand = new Command("share").description(
    "Share secrets with users and agents",
);

shareCommand
    .command("create <secret-id>")
    .description("Create a share link or targeted share")
    .option(
        "--to <recipient>",
        "Recipient: user:<id>, agent:<id>, or email address",
    )
    .option("--expires <date>", "Expiration date (ISO 8601)")
    .option("--max-access <n>", "Maximum access count", parseInt)
    .option("--passphrase <phrase>", "Require passphrase to access")
    .option("--link", "Create an open share link (anyone with link)")
    .action(async (secretId, opts) => {
        try {
            requireToken();

            const body: Record<string, unknown> = { secret_id: secretId };

            if (opts.link) {
                body.recipient_type = "anyone_with_link";
            } else if (opts.to) {
                if (opts.to.startsWith("user:")) {
                    body.recipient_type = "user";
                    body.recipient_id = opts.to.slice(5);
                } else if (opts.to.startsWith("agent:")) {
                    body.recipient_type = "agent";
                    body.recipient_id = opts.to.slice(6);
                } else if (opts.to.includes("@")) {
                    body.recipient_type = "external_email";
                    body.recipient_email = opts.to;
                } else {
                    body.recipient_type = "user";
                    body.recipient_id = opts.to;
                }
            } else {
                body.recipient_type = "anyone_with_link";
            }

            if (opts.expires) body.expires_at = opts.expires;
            if (opts.maxAccess) body.max_access_count = opts.maxAccess;
            if (opts.passphrase) body.passphrase = opts.passphrase;

            const share = await api<Share>("/shares", { method: "POST", body });

            printSuccess("Share created.");
            printKeyValue([
                ["Share ID", share.id],
                ["Recipient", share.recipient_type],
                ["Expires", share.expires_at ?? "never"],
            ]);

            if (share.share_url) {
                console.log();
                console.log(`  ${chalk.underline(share.share_url)}`);
                console.log();
            }
        } catch (err) {
            handleError(err);
        }
    });

shareCommand
    .command("list")
    .alias("ls")
    .description("List shares")
    .option("--inbound", "Show shares sent to you")
    .option("--outbound", "Show shares you created (default)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const direction = opts.inbound ? "inbound" : "outbound";
            const res = await api<{ shares: Share[] }>(`/shares?direction=${direction}`);
            const shares = res.shares ?? [];

            if (opts.json) {
                printJson(shares);
                return;
            }

            printTable(
                shares.map((s) => ({
                    ...s,
                    target:
                        s.recipient_email ??
                        s.recipient_id?.slice(0, 8) ??
                        "link",
                    expires: s.expires_at
                        ? new Date(s.expires_at).toLocaleDateString()
                        : chalk.dim("never"),
                    access: `${s.access_count}/${s.max_access_count ?? "∞"}`,
                    created: new Date(s.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 36 },
                    { key: "secret_path", header: "Secret", width: 24 },
                    { key: "recipient_type", header: "Type", width: 14 },
                    { key: "target", header: "Recipient", width: 20 },
                    { key: "status", header: "Status" },
                    { key: "access", header: "Access" },
                    { key: "expires", header: "Expires" },
                ],
            );
        } catch (err) {
            handleError(err);
        }
    });

shareCommand
    .command("accept <id>")
    .description("Accept an inbound share")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/shares/${id}/accept`, { method: "POST" });
            printSuccess("Share accepted.");
        } catch (err) {
            handleError(err);
        }
    });

shareCommand
    .command("decline <id>")
    .description("Decline an inbound share")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/shares/${id}/decline`, { method: "POST" });
            printSuccess("Share declined.");
        } catch (err) {
            handleError(err);
        }
    });

shareCommand
    .command("revoke <id>")
    .description("Revoke a share you created")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/shares/${id}`, { method: "DELETE" });
            printSuccess("Share revoked.");
        } catch (err) {
            handleError(err);
        }
    });
