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

/**
 * Always renders as aligned key-value (never JSON), for interactive summaries
 * where raw JSON with ANSI codes would be unreadable.
 */
export function printSummaryBox(pairs: [string, string | undefined][]): void {
    const filtered = pairs.filter(([, v]) => v !== undefined);
    if (filtered.length === 0) return;
    const maxKey = Math.max(...filtered.map(([k]) => k.length));
    for (const [key, value] of filtered) {
        console.log(`  ${chalk.bold(key.padEnd(maxKey))}  ${value}`);
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

/**
 * Parse a date string that is either ISO 8601 or a relative duration like "30d", "90d", "6m", "1y".
 * Returns an ISO 8601 string (absolute date) or null if the input is empty/clearing.
 */
export function resolveExpiresAt(input: string): string | null {
    if (!input || input === '""' || input === "''") return null;

    const match = input.match(/^(\d+)(d|m|y)$/i);
    if (match) {
        const amount = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const date = new Date();
        if (unit === "d") date.setDate(date.getDate() + amount);
        else if (unit === "m") date.setMonth(date.getMonth() + amount);
        else if (unit === "y") date.setFullYear(date.getFullYear() + amount);
        return date.toISOString();
    }

    const parsed = new Date(input);
    if (isNaN(parsed.getTime())) {
        throw new Error(
            `Invalid date: "${input}". Use ISO 8601 (e.g. 2025-12-31T00:00:00Z) or relative duration (30d, 6m, 1y).`,
        );
    }
    return parsed.toISOString();
}
