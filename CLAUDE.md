# CLAUDE.md — ofpetrial-ts

TypeScript port of the ofpetrial R package (0.1.3) for on-farm precision
experiments. GPL-3.0-or-later. Runs in Node >= 20, Deno, browsers.

## Commands

```bash
bun run build       # tsup -> dist/ (REQUIRED before typecheck/test: browser smoke imports dist/)
bun run typecheck   # tsc --noEmit
bun run lint        # eslint (0 warnings expected)
bun run test        # vitest, ~300 tests incl. R-parity suites
Rscript tools/run-test-cases.R   # shared test-cases validated against R
Rscript tools/r-coverage.R       # R coverage gate (>= 95% of ported scope)
Rscript tools/gen-fixtures.R     # regenerate golden-master fixtures (see rules below)
deno run --allow-read tools/deno-smoke.ts
```

CI order is build -> typecheck -> lint -> test (publish.yml adds a
tag-must-equal-package.json-version guard and the parity-map gate).

## Non-negotiable rules

- **R 0.1.3 is the source of truth.** Every behavior change must be checked
  against the R sources in `tools/.cache/ofpetrial-0.1.3/R/` (auto-downloaded
  by `tools/r-coverage.R`). Where R has a bug, TS does the right thing and the
  deviation is recorded in `parity-map.json` — never silently.
- **`parity-map.json` is the contract**: 11 R functions -> TS symbols, test
  cases, deviations. `tools/check-parity-map.ts` gates npm publishes. Update
  it in the same PR as any behavior change.
- **Fixtures are golden masters** frozen from R (seed 20260702). Changes must
  be ADDITIVE: rerun `tools/gen-fixtures.R` twice, diff must be byte-identical,
  pre-existing files unchanged (known exception: 1-byte `.dbf` date headers —
  revert them). New exports need a `verify_*` stopifnot gate re-deriving the
  values through R's actual internals.
- **Tolerances** (design.md D9): 1e-6 relative on R-precomputed data
  (machine precision in practice), 1e-3 only for live Turf.js spatial joins,
  >= 99% overlap / <= 10 cm centroids for geometry.
- **npm tarball is whitelisted** (`files: [dist, LICENSE, README.md]`) — repo
  docs/fixtures/tools never ship. Keep it that way.
- **Dependencies**: fflate (never jszip/file-saver), Turf 7, proj4, geotiff.
  Node builtins only behind dynamic imports (browser bundle must stay clean —
  `tests/browser-smoke.test.ts` enforces it).

## Architecture (src/)

- `trial-setup.ts` — prepPlot/prepRate (R: prepare_plot_info.R, prepare_rate_info.R)
- `plot-layout.ts` — makeExpPlots; exact scanline in the ab-line frame instead
  of GEOS st_intersection (parity proven >= 99.94% overlap, holes included)
- `rate-assignment.ts` — assignRates (ls/str/rstr/rb/ejca/sparse), conditional,
  addBlocks (exact R parity), changeRates; injected seedable splitmix32 RNG
  (`rng.ts`) — designs verified by properties, NOT by R sequence reproduction
- `diagnostics.ts` — checkAlignment/checkOrthoInputs/checkOrthoWithChars +
  spatialJoin; dual input modes (live geometry vs R-precomputed fragments)
- `exports/` — hand-rolled shapefile writer, RFC 7946 GeoJSON, ISOXML (beta,
  DDI mapping in docs/isoxml-units.md), writeTrialFiles zip
- `raster.ts` — GeoTIFF reader (terra::extract cell-center semantics,
  handles north-up AND south-up: yres is SIGNED)

Data conventions: options objects camelCase in, R-parity snake_case data out
(`strip_id`, `plot_id`, `rate`). `plot_id` restarts per strip AND per
hole-split strip piece — `(strip_id, plot_id)` is NOT unique; never key
features by plotKey, key by feature identity/order.

## Gotchas

- vitest testTimeout is 30s: live-geometry parity tests take 3-4s each.
- `bun run typecheck` fails without a prior build (dist/index.d.ts needed by
  the browser smoke test).
- The OpenSpec plan lives in `openspec/changes/port-ofpetrial-ts/` (design.md
  D-decisions explain most "why"s).
- Upstream sync procedure: `tools/upstream-sync` + UPSTREAM-SYNC.md; upstream
  testthat suite contributed in DIFM-Brain/ofpetrial#55 mirrors `tests/r/`.
