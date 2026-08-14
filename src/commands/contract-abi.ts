import { Command } from "commander";
import { readFileSync } from "node:fs";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import { printTable, printJson, printSuccess, printKeyValue } from "../output.js";

interface ContractAbi {
    id: string;
    chain: string;
    contract_address: string;
    name?: string;
    description?: string;
    token_decimals?: number;
    created_at: string;
}

export const contractAbiCommand = new Command("contract-abi")
    .description("Manage contract ABI registry");

contractAbiCommand
    .command("upload")
    .description("Upload a contract ABI")
    .requiredOption("--chain <chain>", "Chain name (e.g. ethereum)")
    .requiredOption("--address <address>", "Contract address")
    .requiredOption("--file <path>", "Path to ABI JSON file")
    .option("--name <name>", "Display name")
    .option("--description <desc>", "Description")
    .option("--token-decimals <n>", "Token decimals (for ERC-20 contracts)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const abiJson = JSON.parse(readFileSync(opts.file, "utf-8"));
            const body: Record<string, unknown> = {
                chain: opts.chain,
                contract_address: opts.address,
                abi_json: abiJson,
            };
            if (opts.name) body.name = opts.name;
            if (opts.description) body.description = opts.description;
            if (opts.tokenDecimals) body.token_decimals = parseInt(opts.tokenDecimals, 10);

            const res = await api<ContractAbi>("/org/contract-abis", {
                method: "POST",
                body,
            });
            if (opts.json) { printJson(res); return; }
            printSuccess(`Contract ABI uploaded: ${res.id}`);
            printKeyValue([
                ["ID", res.id],
                ["Chain", res.chain],
                ["Address", res.contract_address],
                ["Name", res.name ?? ""],
            ]);
        } catch (err) { handleError(err); }
    });

contractAbiCommand
    .command("list")
    .description("List contract ABIs")
    .option("--chain <chain>", "Filter by chain")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const query: Record<string, string> = {};
            if (opts.chain) query.chain = opts.chain;
            const res = await api<{ abis: ContractAbi[] }>("/org/contract-abis", { query });
            if (opts.json) { printJson(res.abis); return; }
            if (!res.abis.length) { console.log("No contract ABIs found."); return; }
            printTable(res.abis as unknown as Record<string, unknown>[], [
                { key: "id", header: "ID", width: 36 },
                { key: "chain", header: "Chain", width: 12 },
                { key: "contract_address", header: "Address", width: 44 },
                { key: "name", header: "Name", width: 20 },
            ]);
        } catch (err) { handleError(err); }
    });

contractAbiCommand
    .command("get <id>")
    .description("Get a contract ABI")
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
        try {
            requireToken();
            const res = await api<ContractAbi & { abi_json: unknown }>(`/org/contract-abis/${id}`);
            if (opts.json) { printJson(res); return; }
            printKeyValue([
                ["ID", res.id],
                ["Chain", res.chain],
                ["Address", res.contract_address],
                ["Name", res.name ?? ""],
                ["Description", res.description ?? ""],
                ["Token Decimals", res.token_decimals != null ? String(res.token_decimals) : ""],
                ["Created", res.created_at],
            ]);
        } catch (err) { handleError(err); }
    });

contractAbiCommand
    .command("delete <id>")
    .description("Delete a contract ABI")
    .action(async (id) => {
        try {
            requireToken();
            await api(`/org/contract-abis/${id}`, { method: "DELETE" });
            printSuccess(`Contract ABI ${id} deleted.`);
        } catch (err) { handleError(err); }
    });
