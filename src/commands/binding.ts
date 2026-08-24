import { readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printKeyValue,
    printSuccess,
    printInfo,
    printJson,
    formatDate,
} from "../output.js";

interface CredentialSource {
    type: "inline" | "vault_ref";
    value?: Record<string, unknown>;
    vault_id?: string;
    path?: string;
}

interface Binding {
    id: string;
    agent_id: string;
    name: string;
    binding_type: string;
    config?: Record<string, unknown>;
    guardrails?: Record<string, unknown>;
    is_active: boolean;
    credential_set?: boolean;
    credential_source_type?: "inline" | "vault_ref" | null;
    credential_vault_id?: string | null;
    credential_path?: string | null;
    created_at: string;
    updated_at: string;
}

interface ExecuteResult {
    execution_id: string;
    status: string;
    execution_surface?: string;
    result?: unknown;
    error?: string;
    duration_ms?: number;
}

interface ExecutionEvent {
    id: string;
    binding_id: string;
    intent_type: string;
    status: string;
    execution_surface?: string;
    created_at: string;
}

function parseVaultRef(raw: string | undefined): CredentialSource | undefined {
    if (!raw) return undefined;
    const colonIdx = raw.indexOf(":");
    if (colonIdx === -1) {
        throw new Error(
            "Invalid --vault-ref format. Expected <vault-id>:<path> (e.g. 550e8400-...:secrets/api-key)",
        );
    }
    const vaultId = raw.slice(0, colonIdx);
    const path = raw.slice(colonIdx + 1);
    if (!vaultId || !path) {
        throw new Error(
            "Invalid --vault-ref format. Both vault ID and path are required (e.g. <vault-id>:<path>)",
        );
    }
    return { type: "vault_ref", vault_id: vaultId, path };
}

function parseJsonOption(raw: string | undefined, label: string): Record<string, unknown> | undefined {
    if (raw === undefined || raw === "") return undefined;
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(`Invalid JSON for ${label}`);
    }
}

function parseJsonFile(path: string, label: string): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read ${label} from ${path}: ${msg}`);
    }
}

function resolveJson(
    inline: string | undefined,
    file: string | undefined,
    label: string,
): Record<string, unknown> | undefined {
    if (file) return parseJsonFile(file, label);
    return parseJsonOption(inline, label);
}

type GraphqlGuardrailOpts = {
    allowMutations?: boolean;
    allowIntrospection?: boolean;
    maxQueryDepth?: number;
    maxAliases?: number;
    allowedOperations?: string;
};

function mergeGraphqlGuardrailFlags(
    guardrails: Record<string, unknown> | undefined,
    opts: GraphqlGuardrailOpts,
): Record<string, unknown> | undefined {
    const hasFlag =
        opts.allowMutations !== undefined ||
        opts.allowIntrospection !== undefined ||
        opts.maxQueryDepth !== undefined ||
        opts.maxAliases !== undefined ||
        opts.allowedOperations !== undefined;
    if (!hasFlag) return guardrails;

    const merged: Record<string, unknown> = { ...(guardrails ?? {}) };
    if (opts.allowMutations !== undefined) merged.allow_mutations = opts.allowMutations;
    if (opts.allowIntrospection !== undefined) merged.allow_introspection = opts.allowIntrospection;
    if (opts.maxQueryDepth !== undefined) merged.max_query_depth = opts.maxQueryDepth;
    if (opts.maxAliases !== undefined) merged.max_aliases = opts.maxAliases;
    if (opts.allowedOperations !== undefined) {
        merged.allowed_operations = opts.allowedOperations
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return merged;
}

/** Register `1claw agent binding …` subcommands on the agent command group. */
export function registerAgentBindingCommands(agentCommand: Command): void {
    const bindingCommand = agentCommand
        .command("binding")
        .description("Execution Intents — manage bindings and execute HTTP/GraphQL intents");

    bindingCommand
        .command("create <agent-id>")
        .description("Create a binding (human-only)")
        .requiredOption("--name <name>", "Binding name (unique per agent)")
        .requiredOption(
            "--type <type>",
            "Binding type: http, graphql, postgres, mysql, redis, grpc, smtp, s3, custom",
        )
        .option("--config <json>", "Binding config JSON (e.g. {\"base_url\":\"https://api.example.com\"})")
        .option("--config-file <path>", "Path to binding config JSON file")
        .option("--guardrails <json>", "Per-binding guardrails JSON")
        .option("--guardrails-file <path>", "Path to guardrails JSON file")
        .option("--allow-mutations <bool>", "GraphQL: allow mutations/subscriptions (true/false)")
        .option("--allow-introspection <bool>", "GraphQL: allow __schema/__type introspection (true/false)")
        .option("--max-query-depth <n>", "GraphQL: max query depth (default 10)")
        .option("--max-aliases <n>", "GraphQL: max field aliases per query (default 30)")
        .option(
            "--allowed-operations <names>",
            "GraphQL: comma-separated allowed root operation names",
        )
        .option("--credential <json>", "Credential JSON (write-only; not returned on read)")
        .option("--credential-file <path>", "Path to credential JSON file")
        .option(
            "--vault-ref <vault-id:path>",
            "Live-pointer credential source — reference a vault secret instead of inline credential (e.g. <vault-id>:secrets/api-key)",
        )
        .option("--json", "Output as JSON")
        .action(async (agentId: string, opts) => {
            try {
                requireToken();
                const body: Record<string, unknown> = {
                    name: opts.name,
                    binding_type: opts.type,
                };
                const config = resolveJson(opts.config, opts.configFile, "config");
                let guardrails = resolveJson(opts.guardrails, opts.guardrailsFile, "guardrails");
                guardrails = mergeGraphqlGuardrailFlags(guardrails, {
                    allowMutations: opts.allowMutations === undefined ? undefined : opts.allowMutations === "true",
                    allowIntrospection:
                        opts.allowIntrospection === undefined
                            ? undefined
                            : opts.allowIntrospection === "true",
                    maxQueryDepth:
                        opts.maxQueryDepth === undefined ? undefined : parseInt(opts.maxQueryDepth, 10),
                    maxAliases:
                        opts.maxAliases === undefined ? undefined : parseInt(opts.maxAliases, 10),
                    allowedOperations: opts.allowedOperations,
                });
                const credential = resolveJson(opts.credential, opts.credentialFile, "credential");
                const vaultRef = parseVaultRef(opts.vaultRef);

                if (vaultRef && credential) {
                    throw new Error("Cannot use both --credential and --vault-ref. Choose one credential source.");
                }

                if (config) body.config = config;
                if (guardrails) body.guardrails = guardrails;
                if (vaultRef) {
                    body.credential_source = vaultRef;
                } else if (credential) {
                    body.credential = credential;
                }

                const result = await api<Binding>(`/agents/${agentId}/bindings`, {
                    method: "POST",
                    body,
                });
                if (opts.json) {
                    printJson(result);
                    return;
                }
                printSuccess(`Binding ${chalk.bold(result.name)} created`);
                const rows: [string, string][] = [
                    ["ID", result.id],
                    ["Type", result.binding_type],
                    ["Credential set", result.credential_set ? "yes" : "no"],
                ];
                if (result.credential_source_type === "vault_ref") {
                    rows.push(["Credential source", `vault_ref → ${result.credential_vault_id}:${result.credential_path}`]);
                }
                printKeyValue(rows);
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("list <agent-id>")
        .alias("ls")
        .description("List bindings for an agent")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, opts) => {
            try {
                requireToken();
                const result = await api<{ bindings: Binding[] }>(
                    `/agents/${agentId}/bindings`,
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                const bindings = result.bindings ?? [];
                if (bindings.length === 0) {
                    printInfo("No bindings configured.");
                    return;
                }
                printTable(
                    bindings.map((b) => ({
                        id: b.id,
                        name: b.name,
                        type: b.binding_type,
                        active: b.is_active ? chalk.green("yes") : chalk.dim("no"),
                        credential: b.credential_set ? chalk.green("set") : chalk.dim("—"),
                        updated: formatDate(b.updated_at),
                    })),
                    [
                        { key: "id", header: "ID", width: 36 },
                        { key: "name", header: "Name", width: 20 },
                        { key: "type", header: "Type", width: 10 },
                        { key: "active", header: "Active" },
                        { key: "credential", header: "Credential" },
                        { key: "updated", header: "Updated" },
                    ],
                );
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("get <agent-id> <binding-id>")
        .description("Get binding details")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, bindingId: string, opts) => {
            try {
                requireToken();
                const result = await api<Binding>(
                    `/agents/${agentId}/bindings/${bindingId}`,
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                const rows: [string, string][] = [
                    ["ID", result.id],
                    ["Name", result.name],
                    ["Type", result.binding_type],
                    ["Active", result.is_active ? "yes" : "no"],
                    ["Credential set", result.credential_set ? "yes" : "no"],
                ];
                if (result.credential_source_type === "vault_ref") {
                    rows.push(["Credential source", `vault_ref → ${result.credential_vault_id}:${result.credential_path}`]);
                } else if (result.credential_source_type === "inline") {
                    rows.push(["Credential source", "inline (stored in __agent-keys)"]);
                }
                rows.push(
                    ["Config", JSON.stringify(result.config ?? {})],
                    ["Guardrails", JSON.stringify(result.guardrails ?? {})],
                    ["Created", formatDate(result.created_at, "long")],
                    ["Updated", formatDate(result.updated_at, "long")],
                );
                printKeyValue(rows);
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("update <agent-id> <binding-id>")
        .description("Update binding config, guardrails, credential source, or active status")
        .option("--config <json>", "Updated config JSON")
        .option("--config-file <path>", "Path to config JSON file")
        .option("--guardrails <json>", "Updated guardrails JSON")
        .option("--guardrails-file <path>", "Path to guardrails JSON file")
        .option("--allow-mutations <bool>", "GraphQL: allow mutations/subscriptions (true/false)")
        .option("--allow-introspection <bool>", "GraphQL: allow __schema/__type introspection (true/false)")
        .option("--max-query-depth <n>", "GraphQL: max query depth (default 10)")
        .option("--max-aliases <n>", "GraphQL: max field aliases per query (default 30)")
        .option(
            "--allowed-operations <names>",
            "GraphQL: comma-separated allowed root operation names",
        )
        .option("--credential <json>", "Updated credential JSON (inline)")
        .option("--credential-file <path>", "Path to credential JSON file")
        .option(
            "--vault-ref <vault-id:path>",
            "Switch to a live-pointer credential source (e.g. <vault-id>:secrets/api-key)",
        )
        .option("--active <bool>", "Set is_active (true/false)")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, bindingId: string, opts) => {
            try {
                requireToken();
                const body: Record<string, unknown> = {};
                const config = resolveJson(opts.config, opts.configFile, "config");
                let guardrails = resolveJson(opts.guardrails, opts.guardrailsFile, "guardrails");
                guardrails = mergeGraphqlGuardrailFlags(guardrails, {
                    allowMutations: opts.allowMutations === undefined ? undefined : opts.allowMutations === "true",
                    allowIntrospection:
                        opts.allowIntrospection === undefined
                            ? undefined
                            : opts.allowIntrospection === "true",
                    maxQueryDepth:
                        opts.maxQueryDepth === undefined ? undefined : parseInt(opts.maxQueryDepth, 10),
                    maxAliases:
                        opts.maxAliases === undefined ? undefined : parseInt(opts.maxAliases, 10),
                    allowedOperations: opts.allowedOperations,
                });
                const credential = resolveJson(opts.credential, opts.credentialFile, "credential");
                const vaultRef = parseVaultRef(opts.vaultRef);

                if (vaultRef && credential) {
                    throw new Error("Cannot use both --credential and --vault-ref. Choose one credential source.");
                }

                if (config) body.config = config;
                if (guardrails) body.guardrails = guardrails;
                if (vaultRef) {
                    body.credential_source = vaultRef;
                } else if (credential) {
                    body.credential = credential;
                }
                if (opts.active !== undefined) body.is_active = opts.active === "true";

                const result = await api<Binding>(
                    `/agents/${agentId}/bindings/${bindingId}`,
                    { method: "PATCH", body },
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                printSuccess(`Binding ${result.name} updated`);
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("delete <agent-id> <binding-id>")
        .description("Delete a binding (purges stored credential)")
        .action(async (agentId: string, bindingId: string) => {
            try {
                requireToken();
                await api(`/agents/${agentId}/bindings/${bindingId}`, { method: "DELETE" });
                printSuccess("Binding deleted");
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("test <agent-id> <binding-id>")
        .description("Test binding connectivity")
        .option("--timeout-ms <ms>", "Client timeout in milliseconds")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, bindingId: string, opts) => {
            try {
                requireToken();
                const body: Record<string, unknown> = {};
                if (opts.timeoutMs) body.timeout_ms = parseInt(opts.timeoutMs, 10);
                const result = await api<{ ok: boolean; message?: string; latency_ms?: number }>(
                    `/agents/${agentId}/bindings/${bindingId}/test`,
                    { method: "POST", body },
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                if (result.ok) {
                    printSuccess(
                        `Connectivity OK${result.latency_ms != null ? ` (${result.latency_ms}ms)` : ""}`,
                    );
                } else {
                    printInfo(result.message ?? "Connectivity check failed");
                }
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("rotate-credential <agent-id> <binding-id>")
        .description("Rotate (overwrite) a binding's stored credential")
        .requiredOption("--credential <json>", "New credential JSON")
        .option("--credential-file <path>", "Path to credential JSON file (overrides --credential)")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, bindingId: string, opts) => {
            try {
                requireToken();
                const credential = resolveJson(opts.credential, opts.credentialFile, "credential");
                if (!credential) {
                    throw new Error("Credential is required");
                }
                const result = await api<Binding>(
                    `/agents/${agentId}/bindings/${bindingId}/rotate-credential`,
                    { method: "POST", body: { credential } },
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                printSuccess("Credential rotated");
                printKeyValue([
                    ["Binding", result.name],
                    ["Credential set", result.credential_set ? "yes" : "no"],
                ]);
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("execute <agent-id>")
        .description("Execute an intent through a binding (agent token or human)")
        .requiredOption("--binding <name>", "Binding name")
        .requiredOption("--intent-type <type>", "Intent type: http, graphql, …")
        .option("--params <json>", "Intent params JSON")
        .option("--params-file <path>", "Path to params JSON file")
        .option("--mode <mode>", "Execution surface: vault (default) or tee", "vault")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, opts) => {
            try {
                requireToken();
                const params = resolveJson(opts.params, opts.paramsFile, "params") ?? {};
                const result = await api<ExecuteResult>(`/agents/${agentId}/execute`, {
                    method: "POST",
                    body: {
                        binding: opts.binding,
                        intent_type: opts.intentType,
                        execution_mode: opts.mode,
                        params,
                    },
                });
                if (opts.json) {
                    printJson(result);
                    return;
                }
                const rows: [string, string][] = [
                    ["Execution ID", result.execution_id],
                    ["Status", result.status],
                ];
                if (result.execution_surface) {
                    rows.push(["Surface", result.execution_surface]);
                }
                if (result.duration_ms != null) {
                    rows.push(["Duration", `${result.duration_ms}ms`]);
                }
                if (result.error) rows.push(["Error", result.error]);
                if (result.result !== undefined) {
                    rows.push(["Result", JSON.stringify(result.result).slice(0, 500)]);
                }
                printKeyValue(rows);
            } catch (err) {
                handleError(err);
            }
        });

    bindingCommand
        .command("executions <agent-id>")
        .alias("history")
        .description("List recent execution events for an agent")
        .option("--limit <n>", "Max events to return", "20")
        .option("--offset <n>", "Pagination offset", "0")
        .option("--json", "Output as JSON")
        .action(async (agentId: string, opts) => {
            try {
                requireToken();
                const qs = new URLSearchParams({
                    limit: opts.limit,
                    offset: opts.offset,
                });
                const result = await api<{ events: ExecutionEvent[] }>(
                    `/agents/${agentId}/executions?${qs}`,
                );
                if (opts.json) {
                    printJson(result);
                    return;
                }
                const events = result.events ?? [];
                if (events.length === 0) {
                    printInfo("No execution events.");
                    return;
                }
                printTable(
                    events.map((e) => ({
                        id: e.id,
                        intent: e.intent_type,
                        status: e.status,
                        surface: e.execution_surface ?? "—",
                        created: formatDate(e.created_at),
                    })),
                    [
                        { key: "id", header: "ID", width: 36 },
                        { key: "intent", header: "Intent", width: 10 },
                        { key: "status", header: "Status", width: 10 },
                        { key: "surface", header: "Surface", width: 8 },
                        { key: "created", header: "Created" },
                    ],
                );
            } catch (err) {
                handleError(err);
            }
        });
}
