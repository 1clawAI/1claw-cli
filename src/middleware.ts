import { getToken, getDefaultVaultId } from "./config.js";
import { printError } from "./output.js";
import { ApiError } from "./client.js";

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
  } else if (err instanceof Error) {
    printError(err.message);
  } else {
    printError(String(err));
  }
  process.exit(1);
}
