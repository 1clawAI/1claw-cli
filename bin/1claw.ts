#!/usr/bin/env node
import { createProgram } from "../src/index.js";

const program = createProgram();
program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
});
