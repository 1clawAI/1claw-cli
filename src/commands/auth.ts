import { Command } from "commander";
import { api } from "../client.js";
import { requireAuth } from "../auth.js";
import { handleError } from "../middleware.js";
import { printError, printJson, printKeyValue } from "../output.js";
import { getOutputFormat } from "../config.js";

interface TokenExchangeResponse {
    access_token: string;
    issued_token_type: string;
    token_type: string;
    expires_in: number;
    scope?: string;
}

const TOKEN_EXCHANGE_GRANT_TYPE =
    "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";
const SUBJECT_TOKEN_TYPE_API_KEY = "urn:1claw:params:oauth:token-type:api-key";

const federatedTokenCommand = new Command("federated-token")
    .description(
        "Exchange the current 1claw credential for a short-lived OIDC federation JWT (RFC 8693). " +
            "Use the returned access_token with relying parties such as Anthropic Workload Identity Federation.",
    )
    .requiredOption(
        "-a, --audience <url>",
        "Required `aud` value for the federation token (e.g. https://api.anthropic.com)",
    )
    .option(
        "-s, --scope <scopes>",
        "Optional space-separated subset of the agent's scopes",
    )
    .option(
        "--subject-token <token>",
        "Optional explicit subject_token. Defaults to the current login or ONECLAW_API_KEY/ONECLAW_TOKEN.",
    )
    .option(
        "--raw",
        "Print only the access_token to stdout (handy for shell pipelines)",
    )
    .action(async (opts) => {
        try {
            const subjectToken: string =
                opts.subjectToken ?? requireAuth();
            const subjectTokenType = subjectToken.startsWith("ocv_")
                ? SUBJECT_TOKEN_TYPE_API_KEY
                : SUBJECT_TOKEN_TYPE_JWT;

            const body: Record<string, string> = {
                grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
                subject_token: subjectToken,
                subject_token_type: subjectTokenType,
                audience: opts.audience,
            };
            if (opts.scope) body.scope = opts.scope;

            const result = await api<TokenExchangeResponse>(
                "/auth/federated-token",
                { method: "POST", body, token: "" },
            );

            if (opts.raw) {
                process.stdout.write(`${result.access_token}\n`);
                return;
            }

            if (getOutputFormat() === "json") {
                printJson(result);
                return;
            }

            printKeyValue([
                ["Access token", result.access_token],
                ["Token type", result.token_type],
                ["Issued token type", result.issued_token_type],
                ["Expires in (s)", String(result.expires_in)],
                ["Scope", result.scope ?? "(unchanged)"],
                ["Audience", opts.audience],
            ]);
        } catch (err) {
            if ((err as Error).message?.includes("403")) {
                printError(
                    "Federation denied. Confirm the agent has federation_enabled and the audience is on its allowlist.",
                );
            }
            handleError(err);
        }
    });

export const authCommand = new Command("auth")
    .description("Authentication helpers (federated-token, etc.)")
    .addCommand(federatedTokenCommand);
