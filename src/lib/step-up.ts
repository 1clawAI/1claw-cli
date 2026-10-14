import { createInterface } from "node:readline";

/**
 * Supplying the `X-Auth-Confirm` credential that step-up actions require.
 *
 * Several routes refuse to act on a bearer token alone. Editing agent
 * guardrails is one: the server calls `require_guardrail_step_up` with purpose
 * `security.guardrail.edit`, which is correct and deliberate — an agent must
 * not be able to loosen its own limits, and a stolen token must not be enough
 * to widen somebody else's.
 *
 * The CLI had no way to satisfy it. `agent update` carries 51 guardrail flags
 * and not one of them supplies a credential, so every guardrail edit failed
 * with a 403 naming a header the CLI could not send, and the dashboard was the
 * only route. Two other commands (`signing-keys import`, `export-signing-key`)
 * did support it, which made the gap look like an oversight rather than a
 * policy — reported externally as 1claw-cli#4.
 *
 * ## Why not a flag
 *
 * The two commands that already had step-up took `--password <password>`, and
 * a password in argv is readable by every user on the machine via `ps`, and
 * lands in shell history. This module reads it from stdin or prompts for it
 * without echo, the same reason `--agent-key -` exists in `lib/agent-key.ts`.
 *
 * ## Why a password rather than a device-code flow
 *
 * The server declares this purpose `StepUpPolicy::Any`, so a password is
 * sufficient here — unlike the pay guardrails, which require `StrongFactor`
 * and reject a password whenever a passkey or TOTP is enrolled. A browser
 * approval flow would be more pleasant and no more secure for this purpose. If
 * guardrails are ever raised to `StrongFactor`, this is the seam to replace.
 */

/** How the credential was obtained, for the error message when it is refused. */
export type StepUpSource = "stdin" | "prompt";

export interface StepUpCredential {
    value: string;
    source: StepUpSource;
}

async function readAllStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Prompt without echoing.
 *
 * `readline` with `terminal: true` still echoes, so the keypress handler
 * writes nothing and the raw input never reaches the screen. Errors restore
 * the terminal before rethrowing; a prompt that leaves the tty in raw mode on
 * Ctrl-C is its own small disaster.
 */
async function promptHidden(label: string): Promise<string> {
    const { stdin, stderr } = process;
    stderr.write(label);
    const rl = createInterface({ input: stdin, output: stderr, terminal: true });
    const wasRaw = stdin.isRaw ?? false;
    try {
        if (stdin.isTTY) stdin.setRawMode(true);
        const value = await new Promise<string>((resolve, reject) => {
            let buf = "";
            const onData = (chunk: Buffer) => {
                const s = chunk.toString("utf-8");
                for (const ch of s) {
                    if (ch === "\r" || ch === "\n") {
                        cleanup();
                        stderr.write("\n");
                        resolve(buf);
                        return;
                    }
                    if (ch === "\u0003") {
                        cleanup();
                        stderr.write("\n");
                        reject(new Error("Cancelled."));
                        return;
                    }
                    if (ch === "\u007f" || ch === "\b") {
                        buf = buf.slice(0, -1);
                        continue;
                    }
                    buf += ch;
                }
            };
            const cleanup = () => {
                stdin.off("data", onData);
                if (stdin.isTTY) stdin.setRawMode(wasRaw);
                rl.close();
            };
            stdin.on("data", onData);
        });
        return value;
    } finally {
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        rl.close();
    }
}

/**
 * Obtain the step-up credential for an action, or explain why it cannot.
 *
 * `passwordStdin` is the `--password-stdin` flag. Otherwise an interactive
 * terminal is prompted.
 *
 * **Fails closed with no TTY.** In CI, a missing credential is an error naming
 * `--password-stdin`, never a silent downgrade to a weaker method and never a
 * hang waiting on a prompt nobody will answer.
 */
export async function resolveStepUp(opts: {
    passwordStdin?: boolean;
    action: string;
}): Promise<StepUpCredential> {
    if (opts.passwordStdin) {
        const raw = (await readAllStdin()).trim();
        if (!raw) {
            throw new Error(
                "--password-stdin was given but stdin was empty. Pipe the password in, " +
                    "e.g. `printf %s \"$ONECLAW_PASSWORD\" | 1claw agent update …`",
            );
        }
        return { value: raw, source: "stdin" };
    }

    if (!process.stdin.isTTY) {
        throw new Error(
            `${opts.action} requires re-authentication, and there is no terminal to ask on.\n` +
                "Pipe your account password in with --password-stdin:\n" +
                '  printf %s "$ONECLAW_PASSWORD" | 1claw <command> --password-stdin\n' +
                "Do not pass it as a flag: an argv is visible to every user on the machine.",
        );
    }

    const value = await promptHidden(`Password (to ${opts.action}): `);
    if (!value) throw new Error("No password entered.");
    return { value, source: "prompt" };
}

/** The header a step-up credential travels in. */
export function stepUpHeaders(cred: StepUpCredential): Record<string, string> {
    return { "X-Auth-Confirm": cred.value };
}

/**
 * Does this failure mean "re-authenticate and try again"?
 *
 * Matched on the server's own wording rather than on 403 alone, because a 403
 * is also what an ordinary permission failure returns and telling someone to
 * re-enter their password for that is a wild goose chase.
 */
export function isStepUpRequired(err: unknown): boolean {
    const e = err as { status?: number; detail?: string } | undefined;
    if (!e || e.status !== 403) return false;
    const d = (e.detail ?? "").toLowerCase();
    return d.includes("requires re-authentication") || d.includes("x-auth-confirm");
}

/**
 * What to print when the server asks for step-up and we have no credential.
 *
 * The raw server message names an HTTP header and a purpose string, which is
 * the right thing to tell an API client and useless to someone at a terminal
 * who just wants their flags applied.
 */
export function stepUpHint(command: string): string {
    return (
        "This change needs you to confirm your identity.\n" +
        `  Interactive:  ${command}        (you will be prompted for your password)\n` +
        `  Scripted:     printf %s "$ONECLAW_PASSWORD" | ${command} --password-stdin\n` +
        "Agent credentials cannot perform this action — it must be a human account."
    );
}
