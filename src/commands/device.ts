import { Command } from "commander";
import chalk from "chalk";
import { api } from "../client.js";
import { requireToken, handleError } from "../middleware.js";
import {
    printTable,
    printSuccess,
    printInfo,
    printJson,
} from "../output.js";

interface Device {
    id: string;
    name: string;
    platform: string;
    attestation_verified: boolean;
    last_used_at: string | null;
    created_at: string;
}

export const deviceCommand = new Command("device").description(
    "Manage registered mobile devices",
);

deviceCommand
    .command("list")
    .alias("ls")
    .description("List registered mobile devices")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
        try {
            requireToken();
            const result = await api<{ devices: Device[] }>("/auth/devices");
            if (opts.json) {
                printJson(result);
                return;
            }
            if (result.devices.length === 0) {
                printInfo("No registered devices.");
                return;
            }
            printTable(
                result.devices.map((d) => ({
                    id: d.id,
                    name: d.name,
                    platform: d.platform,
                    verified: d.attestation_verified
                        ? chalk.green("Yes")
                        : chalk.red("No"),
                    last_used: d.last_used_at
                        ? new Date(d.last_used_at).toLocaleDateString()
                        : chalk.dim("Never"),
                    created: new Date(d.created_at).toLocaleDateString(),
                })),
                [
                    { key: "id", header: "ID", width: 38 },
                    { key: "name", header: "Name", width: 20 },
                    { key: "platform", header: "Platform", width: 10 },
                    { key: "verified", header: "Verified" },
                    { key: "last_used", header: "Last Used" },
                    { key: "created", header: "Created" },
                ],
            );
        } catch (e) {
            handleError(e);
        }
    });

deviceCommand
    .command("revoke <device-id>")
    .description("Revoke a registered mobile device")
    .action(async (deviceId: string) => {
        try {
            requireToken();
            await api(`/auth/devices/${deviceId}`, { method: "DELETE" });
            printSuccess(`Revoked device ${deviceId}`);
        } catch (e) {
            handleError(e);
        }
    });
