import chalk from "chalk";

/**
 * The 1Claw banner shown above the top-level help: the official mark (https://1claw.co/brand-kit) in Unicode
 * quadrant blocks, in its own red and white, beside a block wordmark.
 *
 * The mark is rasterised to 40 x 20 pixels; each character cell shows 2 x 2 of them, which keeps the claws' curves.
 * chalk handles colour support: truecolor where available, 256/16 colours otherwise, and none for NO_COLOR or
 * output that is not a terminal.
 */

const RED = "#df171a";
const WHITE = "#ffffff";
const DIM = "#6e7681";

// r = red claw, w = white claw, . = empty. 40 x 20 pixels -> 20 columns x 10 rows.
const MARK = [
    "...........r................w...........",
    "........rrr..................www........",
    "......rrr......................www......",
    "....rrrr........................wwww....",
    "...rrrrr........................wwwww...",
    "..rrrrr..........................wwwww..",
    ".rrrrrr..........................wwwwww.",
    "rrrrrrr..........................wwwwwww",
    "rrrrrrrr........................wwwwwwww",
    "rrrrrrrrr......................wwwwwwwww",
    "rrrrrrrrr......................wwwwwwwww",
    "rrrrrrrrrrrrr..............wwwwwwwwwwwww",
    ".rrrrrrrrrrrrrr..........wwwwwwwwwwwwww.",
    ".rrrrrrrrrrrrrrr........wwwwwwwwwwwwwww.",
    "..rrrrrrr.rrrrrrr......wwwwwww.wwwwwww..",
    "...rrrrrr....rrrr......wwww....wwwwww...",
    "....rrrrrr.....rr......ww.....wwwwww....",
    "......rrrrrr...rr......ww...wwwwww......",
    "........rrrrr..............wwwww........",
    "............rr...........www............",
];

// "1CLAW": the strokes drawn bright, the box-drawing shadow dim.
const WORDMARK = [
    " ██╗ ██████╗██╗      █████╗ ██╗    ██╗",
    "███║██╔════╝██║     ██╔══██╗██║    ██║",
    "╚██║██║     ██║     ███████║██║ █╗ ██║",
    " ██║██║     ██║     ██╔══██║██║███╗██║",
    " ██║╚██████╗███████╗██║  ██║╚███╔███╔╝",
    " ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
];

// Bits are top-left, top-right, bottom-left, bottom-right.
const QUADRANT: Record<number, string> = {
    0b0000: " ", 0b1000: "▘", 0b0100: "▝", 0b0010: "▖", 0b0001: "▗", 0b1100: "▀", 0b0011: "▄", 0b1010: "▌",
    0b0101: "▐", 0b1001: "▚", 0b0110: "▞", 0b1110: "▛", 0b1101: "▜", 0b1011: "▙", 0b0111: "▟", 0b1111: "█",
};

const COLOUR: Record<string, (s: string) => string> = { r: chalk.hex(RED), w: chalk.hex(WHITE) };

/** The mark as 10 lines of 20 characters. */
export function markLines(): string[] {
    const lines: string[] = [];
    for (let y = 0; y < MARK.length; y += 2) {
        let line = "";
        for (let x = 0; x < MARK[0].length; x += 2) {
            const px = [MARK[y][x], MARK[y][x + 1], MARK[y + 1][x], MARK[y + 1][x + 1]];
            const inked = px.filter((c) => c !== ".");
            if (inked.length === 0) {
                line += " ";
                continue;
            }
            // A cell never mixes the two claws in practice; take the majority colour.
            const colour = inked.filter((c) => c === "r").length >= inked.length / 2 ? "r" : "w";
            const bits = px.reduce((b, c, i) => (c === colour ? b | (1 << (3 - i)) : b), 0);
            line += COLOUR[colour](QUADRANT[bits]);
        }
        lines.push(line);
    }
    return lines;
}

function wordmarkLines(): string[] {
    const bright = chalk.bold.hex(WHITE);
    const dim = chalk.hex(DIM);
    return WORDMARK.map((line) => [...line].map((ch) => (ch === "█" ? bright(ch) : dim(ch))).join(""));
}

/**
 * The banner for a terminal `columns` wide: mark and wordmark side by side when there is room (about 62 columns),
 * otherwise a single line.
 */
export function banner(tagline: string, columns = process.stdout.columns ?? 80): string {
    if (columns < 62) {
        return `${chalk.hex(RED)("▐")}${chalk.hex(WHITE)("▌")}  ${chalk.bold("1Claw")}  ${chalk.hex(DIM)(tagline)}\n`;
    }
    const mark = markLines();
    // The wordmark and tagline sit beside the mark, vertically centred on it.
    const right = ["", "", ...wordmarkLines(), chalk.hex(DIM)(tagline)];
    const lines = mark.map((m, i) => (right[i] ? `${m}   ${right[i]}` : m).trimEnd());
    return `\n${lines.join("\n")}\n`;
}

/** Only for people at a terminal: never in pipes, scripts or JSON output. */
export function shouldShowBanner(argv: string[] = process.argv): boolean {
    return Boolean(process.stdout.isTTY) && !argv.includes("--json") && !process.env.ONECLAW_NO_BANNER;
}
