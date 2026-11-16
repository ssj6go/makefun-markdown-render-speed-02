// Driver for the markdown-render-speed-02 entry: renders every case in
// <input>/cases.json with parse.js and writes <output>/html.json.
// Reads MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR, defaulting to /input and /output.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw);

const results = [];
for (const entry of cases) {
  const markdown = typeof entry === "string" ? entry : entry.input ?? entry.markdown ?? "";
  results.push(parse(markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(results));
