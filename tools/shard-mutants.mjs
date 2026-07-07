// Split the mutated source scope into N balanced shards for parallel Stryker
// runs in CI (.github/workflows/mutation.yml). Each shard mutates only its own
// files, so its mutant count — and its share of the slow "static" mutants —
// scales down with the shard, letting the matrix finish well under the job
// timeout instead of the single ~8 h serial run.
//
// Env:
//   SHARDS  number of shards (default 4)
//   MUTATE  optional comma/space-separated files/globs to restrict the scope
//           (mirrors the workflow_dispatch input); blank = whole src/.
//
// Emits a single `shards=<json>` line (for $GITHUB_OUTPUT) where <json> is an
// array of { name, mutate } objects; `mutate` is a comma-joined file list ready
// for `stryker run --mutate`. A human-readable summary goes to stderr.

import { readdirSync, readFileSync } from "node:fs";

const SHARDS = Math.max(1, Number.parseInt(process.env.SHARDS || "4", 10) || 4);
const mutateInput = (process.env.MUTATE || "").trim();

// Mirror the `mutate` scope from stryker.config.json: all src/**/*.ts except
// declaration files and tests.
const candidates = readdirSync("src", { recursive: true })
  .map((p) => `src/${String(p).split(/[\\/]/).join("/")}`)
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts"))
  .sort();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A MUTATE entry matches by exact path, directory prefix, or `*` glob.
function toMatcher(entry) {
  if (entry.includes("*")) {
    const re = new RegExp(`^${entry.split("*").map(escapeRegex).join(".*")}$`);
    return (p) => re.test(p);
  }
  const dir = `${entry.replace(/\/$/, "")}/`;
  return (p) => p === entry || p.startsWith(dir);
}

let files = candidates;
if (mutateInput) {
  const matchers = mutateInput
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(toMatcher);
  files = candidates.filter((p) => matchers.some((m) => m(p)));
}

if (files.length === 0) {
  throw new Error(`No source files matched MUTATE="${mutateInput}"`);
}

// Weight each file by line count — a cheap proxy for mutant count / runtime —
// then greedily bin-pack heaviest-first into the lightest shard (LPT). This
// keeps the shards' estimated runtimes close so no single shard dominates.
const weighted = files
  .map((f) => ({ f, w: readFileSync(f, "utf8").split("\n").length }))
  .sort((a, b) => b.w - a.w);

const bins = Array.from({ length: Math.min(SHARDS, weighted.length) }, () => ({
  w: 0,
  files: [],
}));
for (const item of weighted) {
  bins.sort((a, b) => a.w - b.w);
  bins[0].w += item.w;
  bins[0].files.push(item.f);
}

const shards = bins
  .filter((b) => b.files.length > 0)
  .map((b, i) => ({ name: String(i + 1), mutate: b.files.sort().join(","), weight: b.w }));

for (const s of shards) {
  process.stderr.write(`shard ${s.name} (~${s.weight} lines): ${s.mutate}\n`);
}

process.stdout.write(
  `shards=${JSON.stringify(shards.map(({ name, mutate }) => ({ name, mutate })))}\n`
);
