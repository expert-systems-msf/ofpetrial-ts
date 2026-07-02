// Publish gate (tag builds only, see .github/workflows/publish.yml):
// every public R function in parity-map.json must be ported, point at an
// existing TS file that exports the mapped symbol, and reference at least
// one existing shared test-case file.
import { existsSync, readFileSync } from "node:fs";

interface ParityEntry {
  rFunction: string;
  tsFile: string;
  tsSymbol: string;
  testCases: string[];
  status: string;
  deviations?: string[];
}

interface ParityMap {
  ofpetrialVersion: string;
  publicFunctions: ParityEntry[];
  internals: ParityEntry[];
}

const map = JSON.parse(readFileSync("parity-map.json", "utf8")) as ParityMap;
const problems: string[] = [];

function exportsSymbol(file: string, symbol: string): boolean {
  const src = readFileSync(file, "utf8");
  return new RegExp(`export (async )?(function|const|class) ${symbol}\\b`).test(src);
}

for (const entry of map.publicFunctions) {
  const tag = `${entry.rFunction} -> ${entry.tsSymbol}`;
  if (entry.status !== "ported") {
    problems.push(`${tag}: status is "${entry.status}" (must be "ported")`);
    continue;
  }
  if (!existsSync(entry.tsFile)) {
    problems.push(`${tag}: ${entry.tsFile} does not exist`);
    continue;
  }
  if (!exportsSymbol(entry.tsFile, entry.tsSymbol)) {
    problems.push(`${tag}: ${entry.tsFile} does not export ${entry.tsSymbol}`);
  }
  if (entry.testCases.length === 0) {
    problems.push(`${tag}: no shared test case referenced`);
  }
  for (const tc of entry.testCases) {
    if (!existsSync(tc)) problems.push(`${tag}: test case file ${tc} missing`);
  }
}

if (problems.length > 0) {
  console.error(`parity-map check FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `parity-map check OK: ${map.publicFunctions.length} public functions ported against ofpetrial ${map.ofpetrialVersion}.`,
);
