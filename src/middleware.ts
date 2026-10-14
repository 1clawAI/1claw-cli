import { getToken, getDefaultVaultId } from "./config.js";
import { printError } from "./output.js";
import { ApiError } from "./client.js";
import { isStepUpRequired } from "./lib/step-up.js";

export function requireToken(): string {
    const token = getToken();
    if (!token) {
        printError("Not authenticated. Run `1claw login` first.");
        process.exit(1);
    }
    return token;
}

export function resolveVaultId(opts: { vault?: string }): string {
    const id = opts.vault ?? getDefaultVaultId();
    if (!id) {
        printError(
            "No vault specified. Use --vault <id> or run `1claw vault link <id>`.",
        );
        process.exit(1);
    }
    return id;
}

export function handleError(err: unknown): never {
    if (err instanceof ApiError) {
        printError(`API error (${err.status}): ${err.detail}`);
        if (err.status === 401) {
            printError("Try running `1claw login` to re-authenticate.");
        }
        // A step-up 403 names an HTTP header and a purpose string. That is the
        // right answer for an API client and useless at a terminal: it was
        // reported as a dead end, because nothing told the reader the CLI
        // could satisfy it or how. Commands that support step-up handle this
        // themselves; this catches the ones that do not yet, so the message is
        // at worst a pointer rather than a wall.
        if (isStepUpRequired(err)) {
            printError(
                "This action needs you to confirm your identity.\n" +
                    "  Re-run it in an interactive terminal to be prompted, or pipe your\n" +
                    '  password in:  printf %s "$ONECLAW_PASSWORD" | 1claw <command> --password-stdin\n' +
                    "  Not every command supports this yet — the dashboard can do it in the meantime.",
            );
        }
    } else if (err instanceof Error) {
        printError(err.message);
    } else {
        printError(String(err));
    }
    process.exit(1);
}
