import chalk from "chalk";
import { getOutputFormat } from "./config.js";

export function printJson(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
}

export function printTable(
    rows: Record<string, unknown>[],
    columns: { key: string; header: string; width?: number }[],
): void {
    const format = getOutputFormat();

    if (format === "json") {
        printJson(rows);
        return;
    }

    if (format === "plain" || rows.length === 0) {
        if (rows.length === 0) {
            console.log(chalk.dim("No results."));
            return;
        }
        for (const row of rows) {
            const parts = columns.map((c) => String(row[c.key] ?? ""));
            console.log(parts.join("\t"));
        }
        return;
    }

    const widths = columns.map((c) => {
        if (c.width) return c.width;
        const maxData = Math.max(
            ...rows.map((r) => String(r[c.key] ?? "").length),
        );
        return Math.max(c.header.length, maxData);
    });

    const headerLine = columns
        .map((c, i) => chalk.bold(c.header.padEnd(widths[i])))
        .join("  ");
    console.log(headerLine);
    console.log(chalk.dim("─".repeat(headerLine.length)));

    for (const row of rows) {
        const line = columns
            .map((c, i) => String(row[c.key] ?? "").padEnd(widths[i]))
            .join("  ");
        console.log(line);
    }
}

export function printKeyValue(pairs: [string, string | undefined][]): void {
    const format = getOutputFormat();

    if (format === "json") {
        const obj: Record<string, string> = {};
        for (const [k, v] of pairs) {
            if (v !== undefined) obj[k] = v;
        }
        printJson(obj);
        return;
    }

    const maxKey = Math.max(...pairs.map(([k]) => k.length));
    for (const [key, value] of pairs) {
        if (value === undefined) continue;
        console.log(`${chalk.bold(key.padEnd(maxKey))}  ${value}`);
    }
}

export function printSuccess(msg: string): void {
    console.log(chalk.green("✓") + " " + msg);
}

export function printWarning(msg: string): void {
    console.log(chalk.yellow("⚠") + " " + msg);
}

export function printError(msg: string): void {
    console.error(chalk.red("✗") + " " + msg);
}

export function printInfo(msg: string): void {
    console.log(chalk.blue("ℹ") + " " + msg);
}

export function formatDate(value: string | null | undefined, style: "short" | "long" = "short"): string {
    if (!value) return chalk.dim("—");
    const d = new Date(value);
    if (isNaN(d.getTime())) return chalk.dim("—");
    return style === "long" ? d.toLocaleString() : d.toLocaleDateString();
}
