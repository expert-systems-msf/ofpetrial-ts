// Merge the per-shard Stryker JSON reports produced by the parallel mutation
// matrix (.github/workflows/mutation.yml) into a single report, and emit an
// actionable digest of the mutants that escaped the tests.
//
// The shards mutate disjoint files, so their `files` maps never collide — the
// merge is a plain union. From the union we recompute the *global* mutation
// score (a shard-by-shard average would be wrong) and write
// `surviving-mutants.md`: every Survived (test too weak) and NoCoverage (test
// missing) mutant, grouped by file with its source line, mutator, and the
// original -> mutated code. That markdown is what you hand to Claude Code to
// strengthen the offending tests.
//
// Usage: node tools/merge-mutation-reports.mjs [inputDir] [outDir]
//   inputDir  dir holding the downloaded shard artifacts (default "shard-reports")
//   outDir    where to write mutation.json + surviving-mutants.md (default "reports/mutation")
// A human-readable summary is printed to stdout (wire it to $GITHUB_STEP_SUMMARY).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const inputDir = process.argv[2] || "shard-reports";
const outDir = process.argv[3] || "reports/mutation";

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

// Recursively collect every mutation.json under inputDir (one per shard).
function findReports(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findReports(p));
    else if (entry.name === "mutation.json") out.push(p);
  }
  return out;
}

const reportPaths = findReports(inputDir);
if (reportPaths.length === 0) {
  throw new Error(`No mutation.json found under ${inputDir}`);
}

let merged = null;
for (const p of reportPaths) {
  const report = JSON.parse(readFileSync(p, "utf8"));
  if (!merged) {
    merged = { ...report, files: {} };
  }
  for (const [file, data] of Object.entries(report.files ?? {})) {
    if (merged.files[file]) {
      // Same file mutated by two shards should never happen (disjoint split);
      // keep both mutant sets rather than silently dropping one.
      merged.files[file].mutants.push(...data.mutants);
    } else {
      merged.files[file] = data;
    }
  }
}

// Tally statuses across the whole run and collect the actionable escapees.
const counts = {};
const escaped = []; // { file, data, mutant }
for (const [file, data] of Object.entries(merged.files)) {
  for (const mutant of data.mutants) {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    if (UNDETECTED.has(mutant.status)) escaped.push({ file, data, mutant });
  }
}

const detected = [...DETECTED].reduce((n, s) => n + (counts[s] ?? 0), 0);
const undetected = [...UNDETECTED].reduce((n, s) => n + (counts[s] ?? 0), 0);
const valid = detected + undetected;
const score = valid > 0 ? (detected / valid) * 100 : 0;

// Extract the original source spanned by a mutant's location, for context.
function originalSnippet(source, location) {
  if (!source || !location) return "";
  const lines = source.split("\n");
  const { start, end } = location;
  if (start.line === end.line) {
    return lines[start.line - 1]?.slice(start.column - 1, end.column - 1) ?? "";
  }
  const first = lines[start.line - 1]?.slice(start.column - 1) ?? "";
  return `${first} …`;
}

function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}

// Build the Claude-facing digest, worst files first.
const byFile = new Map();
for (const e of escaped) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}
const filesSorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

const md = [];
md.push("# Surviving mutants — tests to strengthen");
md.push("");
md.push(
  `**Global mutation score: ${score.toFixed(2)}%** ` +
    `(detected ${detected} / valid ${valid})`
);
const order = ["Killed", "Timeout", "Survived", "NoCoverage", "CompileError", "RuntimeError", "Ignored"];
md.push("");
md.push(
  order
    .filter((s) => counts[s])
    .map((s) => `${s}: ${counts[s]}`)
    .join(" · ")
);
md.push("");
md.push(
  "Each entry below is a code change that the tests did NOT catch. " +
    "`Survived` = a test executes the line but does not assert on the mutated " +
    "behaviour; `NoCoverage` = no test exercises the line at all. Add or " +
    "tighten tests so each mutation would fail the suite."
);
md.push("");

for (const [file, entries] of filesSorted) {
  const source = byFile.get(file)[0].data.source;
  md.push(`## ${file} (${entries.length})`);
  md.push("");
  entries.sort((a, b) => a.mutant.location.start.line - b.mutant.location.start.line);
  for (const { mutant } of entries) {
    const loc = mutant.location.start;
    const orig = oneLine(originalSnippet(source, mutant.location));
    const repl = oneLine(mutant.replacement ?? "");
    md.push(
      `- \`${file}:${loc.line}:${loc.column}\` **${mutant.mutatorName}** ` +
        `[${mutant.status}]` +
        (orig ? ` — \`${orig}\` → \`${repl}\`` : ` → \`${repl}\``)
    );
  }
  md.push("");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "mutation.json"), JSON.stringify(merged));
writeFileSync(join(outDir, "surviving-mutants.md"), md.join("\n"));

// Summary for the GitHub step summary / logs.
process.stdout.write(
  [
    `## Mutation testing — combined (${reportPaths.length} shards)`,
    "",
    `**Global mutation score: ${score.toFixed(2)}%** (detected ${detected} / valid ${valid})`,
    "",
    order
      .filter((s) => counts[s])
      .map((s) => `- ${s}: ${counts[s]}`)
      .join("\n"),
    "",
    `${escaped.length} surviving/uncovered mutants across ${byFile.size} files — see the \`surviving-mutants.md\` in the \`mutation-combined\` artifact.`,
    "",
  ].join("\n")
);
