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

// Public API surface: the package only ships dist/ built from src/index.ts, so
// a symbol that its own module exports but src/index.ts does NOT re-export is
// not actually public. Parse the named re-exports (multi-line blocks included)
// and any `export * from`.
const indexSrc = readFileSync("src/index.ts", "utf8");
const indexStarExport = /export\s*\*\s*from/.test(indexSrc);
const indexNamedExports = new Set<string>();
for (const match of indexSrc.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
  for (const clause of match[1]!.split(",")) {
    for (const token of clause.trim().split(/\s+as\s+/)) {
      const name = token.trim();
      if (name) indexNamedExports.add(name);
    }
  }
}
function reExportedFromIndex(symbol: string): boolean {
  return indexStarExport || indexNamedExports.has(symbol);
}

function checkEntry(
  entry: ParityEntry,
  opts: { requireTestCases: boolean; requireIndexReExport: boolean }
): void {
  const tag = `${entry.rFunction} -> ${entry.tsSymbol}`;
  if (entry.status !== "ported") {
    problems.push(`${tag}: status is "${entry.status}" (must be "ported")`);
    return;
  }
  if (!existsSync(entry.tsFile)) {
    problems.push(`${tag}: ${entry.tsFile} does not exist`);
    return;
  }
  if (!exportsSymbol(entry.tsFile, entry.tsSymbol)) {
    problems.push(`${tag}: ${entry.tsFile} does not export ${entry.tsSymbol}`);
  }
  // L13: a public function must be re-exported from src/index.ts (the package
  // entry point), not merely from its own module.
  if (opts.requireIndexReExport && !reExportedFromIndex(entry.tsSymbol)) {
    problems.push(`${tag}: ${entry.tsSymbol} is not re-exported from src/index.ts`);
  }
  if (opts.requireTestCases && entry.testCases.length === 0) {
    problems.push(`${tag}: no shared test case referenced`);
  }
  for (const tc of entry.testCases) {
    if (!existsSync(tc)) problems.push(`${tag}: test case file ${tc} missing`);
  }
}

for (const entry of map.publicFunctions) {
  checkEntry(entry, { requireTestCases: true, requireIndexReExport: true });
}
// L12: internals were never validated at all. They are not part of the public
// API (no index.ts re-export) and may legitimately have no shared test-case
// file, but their tsFile/tsSymbol and any listed test cases must still exist.
for (const entry of map.internals) {
  checkEntry(entry, { requireTestCases: false, requireIndexReExport: false });
}

if (problems.length > 0) {
  console.error(`parity-map check FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `parity-map check OK: ${map.publicFunctions.length} public functions + ${map.internals.length} internals ported against ofpetrial ${map.ofpetrialVersion}.`
);
