import inquirer from "inquirer";

/**
 * Read a sensitive value without writing it back to the terminal.
 *
 * Keep terminal handling with Inquirer rather than maintaining separate raw
 * mode/readline implementations at each call site. Its password prompt owns
 * cleanup for normal completion, cancellation, and errors.
 *
 * The prompt is written to **stderr**, not Inquirer's default of stdout. These
 * prompts appear in the middle of commands whose stdout is data — `env get`,
 * `secret get`, anything with `--json` — and is routinely captured with
 * `$(1claw …)` or piped to `jq`. On stdout the prompt text, the mask
 * characters and the ANSI redraw codes all land in the captured value, and
 * the person at the terminal never sees the question, so the command appears
 * to hang. The readline prompts this replaced wrote to stderr for that reason.
 */
const prompt = inquirer.createPromptModule({ output: process.stderr });

export async function promptHiddenValue(message: string): Promise<string> {
    const answer = await prompt<{ value: string }>([
        {
            type: "password",
            name: "value",
            message,
            mask: "*",
        },
    ]);
    return String(answer.value ?? "");
}
