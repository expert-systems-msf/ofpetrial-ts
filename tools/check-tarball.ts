// Guards the npm tarball contents against whitelist regressions: the
// published package must contain exactly these files — nothing from
// fixtures/, tests/, tools/, openspec/ or agent context may ever ship.
// Run: bun run tools/check-tarball.ts   (used by CI and the publish gate)
import { execSync } from "node:child_process";

const EXPECTED = [
  "LICENSE",
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/index.js.map",
  "package.json",
];

const raw = execSync("npm pack --dry-run --json", { encoding: "utf8" });
const [report] = JSON.parse(raw) as [{ files: { path: string }[]; size: number }];
const actual = report.files.map((f) => f.path).sort();

const missing = EXPECTED.filter((f) => !actual.includes(f));
const extra = actual.filter((f) => !EXPECTED.includes(f));

if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) console.error(`tarball MISSING: ${missing.join(", ")}`);
  if (extra.length > 0) console.error(`tarball EXTRA (must never ship): ${extra.join(", ")}`);
  process.exit(1);
}
console.log(`tarball OK: ${actual.length} files, ${(report.size / 1024).toFixed(1)} kB packed`);
