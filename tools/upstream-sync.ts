// Upstream-sync work-list generator.
//
// Diffs the R sources of two ofpetrial CRAN versions restricted to the
// ported scope, cross-references parity-map.json, and prints the work list
// for a version bump. Procedure documented in tools/UPSTREAM-SYNC.md.
//
// Usage:  bun run tools/upstream-sync.ts <fromVersion> <toVersion>
// Example: bun run tools/upstream-sync.ts 0.1.3 0.1.4
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [fromVersion, toVersion] = process.argv.slice(2);
if (!fromVersion || !toVersion) {
  console.error("Usage: bun run tools/upstream-sync.ts <fromVersion> <toVersion>");
  process.exit(1);
}

const CACHE = "tools/.cache";
mkdirSync(CACHE, { recursive: true });

function fetchSource(version: string): string {
  const dir = join(CACHE, `ofpetrial-${version}`);
  if (existsSync(dir)) return dir;
  const tarball = join(CACHE, `ofpetrial_${version}.tar.gz`);
  if (!existsSync(tarball)) {
    // current release lives in src/contrib, older ones in the Archive
    const urls = [
      `https://cloud.r-project.org/src/contrib/ofpetrial_${version}.tar.gz`,
      `https://cloud.r-project.org/src/contrib/Archive/ofpetrial/ofpetrial_${version}.tar.gz`,
    ];
    let ok = false;
    for (const url of urls) {
      try {
        execSync(`curl -fsSL -o ${tarball} ${url}`, { stdio: "pipe" });
        ok = true;
        break;
      } catch {
        // try the next location
      }
    }
    if (!ok) throw new Error(`Cannot download ofpetrial ${version} from CRAN`);
  }
  execSync(`tar -xzf ${tarball} -C ${CACHE} && mv ${CACHE}/ofpetrial ${dir}`, { stdio: "pipe" });
  return dir;
}

interface ParityEntry {
  rFunction: string;
  tsFile: string;
  tsSymbol: string;
  status: string;
}
const map = JSON.parse(readFileSync("parity-map.json", "utf8")) as {
  publicFunctions: ParityEntry[];
  internals: ParityEntry[];
};
const scope = JSON.parse(readFileSync("tools/r-coverage-scope.json", "utf8")) as {
  include: string[];
};

const fromDir = fetchSource(fromVersion);
const toDir = fetchSource(toVersion);

// Diff every R/ source file; keep files whose diff touches a scope function.
const rFiles = new Set([
  ...readdirSync(join(fromDir, "R")),
  ...readdirSync(join(toDir, "R")),
]);

const touched = new Map<string, string[]>(); // file -> scope functions mentioned in its diff
for (const file of [...rFiles].sort()) {
  const a = join(fromDir, "R", file);
  const b = join(toDir, "R", file);
  let diff = "";
  try {
    execSync(`diff -u ${existsSync(a) ? a : "/dev/null"} ${existsSync(b) ? b : "/dev/null"}`, {
      stdio: "pipe",
    });
  } catch (e) {
    diff = (e as { stdout?: Buffer }).stdout?.toString() ?? "";
  }
  if (!diff) continue;
  const hits = scope.include.filter((fn) => new RegExp(`\\b${fn}\\b`).test(diff));
  if (hits.length > 0) touched.set(file, hits);
}

if (touched.size === 0) {
  console.log(
    `No ported-scope R source changes between ofpetrial ${fromVersion} and ${toVersion}.`,
  );
  console.log("Still required for a version bump: regenerate fixtures and re-run both suites");
  console.log("(see tools/UPSTREAM-SYNC.md).");
  process.exit(0);
}

const allEntries = [...map.publicFunctions, ...map.internals];
console.log(`Ported-scope changes between ofpetrial ${fromVersion} and ${toVersion}:\n`);
for (const [file, fns] of touched) {
  console.log(`R/${file}:`);
  for (const fn of fns) {
    const entry = allEntries.find((e) => e.rFunction === fn);
    const target = entry ? `${entry.tsFile} (${entry.tsSymbol}, ${entry.status})` : "UNMAPPED";
    console.log(`  - ${fn} -> ${target}`);
  }
}
console.log("\nWork list: review each diff above, update the TS symbols, bump");
console.log("ofpetrialVersion in parity-map.json / fixtures, regenerate fixtures");
console.log("(Rscript tools/gen-fixtures.R), and re-run both suites plus the");
console.log("coverage gate (see tools/UPSTREAM-SYNC.md).");
