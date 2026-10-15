import inquirer from "inquirer";

/**
 * Read a sensitive value without writing it back to the terminal.
 *
 * Keep terminal handling with Inquirer rather than maintaining separate raw
 * mode/readline implementations at each call site. Its password prompt owns
 * cleanup for normal completion, cancellation, and errors.
 */
export async function promptHiddenValue(message: string): Promise<string> {
    const answer = await inquirer.prompt<{ value: string }>([
        {
            type: "password",
            name: "value",
            message,
            mask: "*",
        },
    ]);
    return String(answer.value ?? "");
}
