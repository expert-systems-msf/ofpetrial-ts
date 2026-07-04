# ofpetrial-ts

[![npm](https://img.shields.io/npm/v/ofpetrial-ts)](https://www.npmjs.com/package/ofpetrial-ts)
[![license](https://img.shields.io/npm/l/ofpetrial-ts)](LICENSE)
[![CI](https://github.com/expert-systems-msf/ofpetrial-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/expert-systems-msf/ofpetrial-ts/actions/workflows/ci.yml)

TypeScript port of the [ofpetrial](https://github.com/DIFM-Brain/ofpetrial) R package (v0.1.3) for designing and diagnosing **on-farm precision agriculture experiments**: lay out randomized-rate trial plots inside a field boundary along an ab-line, assign input rates with several randomized-design strategies, run alignment/orthogonality diagnostics, and export machine-ready files (Shapefile, GeoJSON, ISOXML). Runs unmodified in Node ≥ 22, Deno, and the browser (no native dependencies). Licensed GPL-3.0-or-later.

> **Pre-1.0.** The public API is stable in shape (11/11 ported functions, see Status below) but has not yet had a tagged release.

## Status

All 11 public functions of ofpetrial 0.1.3 are ported and validated against golden-master fixtures generated from the R package itself. See [`parity-map.json`](parity-map.json) for the full R → TS function map, test-case references, and per-function deviations.

- **Functional parity: 11/11** public functions ported.
- **ISOXML export is beta** — ofpetrial has no ISOXML export of its own, so there is no R reference to compare against; see [Deviations from R](#deviations-from-r) and [`docs/isoxml-units.md`](docs/isoxml-units.md).
- R coverage of the ported scope: **97.17 %** (gate ≥ 95 %, see [`coverage/r-coverage.json`](coverage/r-coverage.json)).

## Install

```bash
npm install ofpetrial-ts
# or
bun add ofpetrial-ts
```

Deno (no install step, import by specifier):

```ts
import { assignRates, makeExpPlots, prepPlot, prepRate } from "npm:ofpetrial-ts";
```

## Quick start

The full pipeline is: `prepPlot` → `prepRate` → `makeExpPlots` → `assignRates` → checks → `writeTrialFiles`. Every function takes/returns plain, JSON-serializable objects (no classes) — `PlotInfo`/`RateInfo` in, `ExpData`/`TrialDesign` out, GeoJSON everywhere geometry is involved.

Inputs to `makeExpPlots`:

- `boundary` — a `Feature<Polygon | MultiPolygon>` (or a `FeatureCollection` of one), the field boundary in WGS84 lon/lat. Holes are supported.
- `abLine` — a `Feature<LineString>` (or a `FeatureCollection`, first line used), the guidance line the applicator drives along. Only its direction and one point matter; it is stretched across the field internally.

### Imperial example

```ts
import {
  assignRates,
  checkAlignment,
  makeExpPlots,
  prepPlot,
  prepRate,
  writeTrialFiles,
} from "ofpetrial-ts";

// Real field boundary (WGS84 lon/lat), e.g. loaded from your own GeoJSON file.
// It must be large enough to fit several plot widths x plot lengths — see
// fixtures/boundary-simple1.geojson for a full real-world example.
const boundary: GeoJSON.Feature<GeoJSON.Polygon> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-96.901, 41.03],
        [-96.893, 41.03],
        [-96.893, 41.034],
        [-96.901, 41.034],
        [-96.901, 41.03],
      ],
    ],
  },
};
const abLine: GeoJSON.Feature<GeoJSON.LineString> = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "LineString",
    coordinates: [
      [-96.901, 41.031],
      [-96.893, 41.031],
    ],
  },
};

const plotInfo = prepPlot({
  inputName: "seed",
  unitSystem: "imperial",
  machineWidth: 60, // feet
  sectionNum: 24,
  harvesterWidth: 30, // feet
});

const rateInfo = prepRate(plotInfo, {
  gcRate: 34000, // grower-chosen rate, seeds/acre
  unit: "seeds",
  rates: [20000, 26000, 32000, 38000, 44000],
});

const layout = makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine });
const design = assignRates(layout, rateInfo, { seed: 20260702 }); // seed is optional, default 42

const alignment = checkAlignment(design);
console.log(alignment[0].overlapData.length, "harvester/plot overlap rows");

const zip = writeTrialFiles(design, { ext: "shp" }); // Uint8Array (zip)
```

### Metric example

Every option that takes a physical quantity is in the unit system's own units — metric inputs are metres, hectares, kilograms, litres; no separate conversion step is needed:

```ts
const plotInfoMetric = prepPlot({
  inputName: "NH3",
  unitSystem: "metric",
  machineWidth: 18.3, // meters
  sectionNum: 24,
  harvesterWidth: 9.1, // meters
});

const rateInfoMetric = prepRate(plotInfoMetric, {
  gcRate: 200,
  unit: "kg",
  rates: [140, 170, 200, 230, 260],
});
```

`makeExpPlots`/`assignRates` accept either a single `PlotInfo`/`RateInfo` or an array of (at most two) — the array form is how a two-input joint design is requested (e.g. `assignRates(layout, [rateInfoA, rateInfoB])`).

## API reference

All options objects use camelCase (idiomatic TS). Returned data structures use snake_case field names — this mirrors the R tibble/attribute names one-for-one, so GeoJSON `properties` and `PlotInfo`/`RateInfo` fields match the R columns exactly.

### Trial setup (`prepPlot`, `prepRate`)

| Export          | Signature                                                        | Description                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepPlot`      | `(options: PrepPlotOptions) => PlotInfo`                         | Derives plot/strip geometry (plot width, headland/side length, min/max plot length) from machine dimensions. Returns everything in meters regardless of `unitSystem`. |
| `prepRate`      | `(plotInfo: PlotInfo, options: PrepRateOptions) => RateInfo`     | Builds the trial-rate ladder (explicit `rates` or `minRate`/`maxRate`/`numRates`) and per-design-type rate ranks.                                                     |
| `getRates`      | `(minRate, maxRate, gcRate, numLevels) => number[]`              | Rate ladder anchored asymmetrically on `gcRate`; the returned length can differ from `numLevels` (R quirk, size off `.length`).                                       |
| `findPlotWidth` | `(sectionWidth, harvesterWidth, maxPlotWidth) => number`         | Plot width: LCM of the two machine widths when one fits under `maxPlotWidth`, else a width-ratio fallback.                                                            |
| `getLcm`        | `(sectionWidth, harvesterWidth, maxPlotWidth) => number \| null` | Smallest common multiple of the two widths within `maxPlotWidth` (±0.05 m tolerance), or `null`.                                                                      |

`PrepPlotOptions`: `{ inputName, unitSystem: "imperial" | "metric", machineWidth, sectionNum, harvesterWidth, plotWidth?, headlandLength?, sideLength?, maxPlotWidth?, minPlotLength?, maxPlotLength? }`.
`PrepRateOptions`: `{ gcRate, unit, rates?, minRate?, maxRate?, numRates? (default 5), designType?, rankSeqWs?, rankSeqAs?, rateJumpThreshold? }`.

### Plot layout (`makeExpPlots`)

| Export         | Signature                                   | Description                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeExpPlots` | `(options: MakeExpPlotsOptions) => ExpData` | Subdivides the field boundary into experiment strips/plots aligned on the ab-line, and derives the per-input applicator ab-line, harvester guidance line, and headlands. All geometry math runs in UTM; input/output is WGS84 GeoJSON. |

`MakeExpPlotsOptions`: `{ inputPlotInfo: PlotInfo | PlotInfo[], boundary, abLine, ablineType?: "free" | "lock" | "non" (default "free") }`.

### Rate assignment (`assignRates`, `assignRatesConditional`, `addBlocks`, `changeRates`)

| Export                   | Signature                                                                                  | Description                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignRates`            | `(expData, rateInfo: RateInfo \| RateInfo[], options?: AssignRatesOptions) => TrialDesign` | Randomly assigns trial rates to plots per input's `design_type`. Matches `RateInfo` to `ExpData` inputs **by `input_name`**, never by position. Inputs without a matching `RateInfo` come back with `rateInfo: null` (geometry only), consumable by `assignRatesConditional`. Two same-geometry `"ls"`-type inputs with compatible rate counts are jointly balanced. |
| `assignRatesConditional` | `(expData, rateInfo: RateInfo, existingDesign: TrialDesign, options?) => TrialDesign`      | Doses the remaining geometry-only input of a partially-dosed two-input `TrialDesign`, keeping the joint (rate¹, rate²) combinations balanced. Reduced scope vs R — see Deviations.                                                                                                                                                                                   |
| `addBlocks`              | `(td: TrialDesign) => TrialDesign`                                                         | Adds a 2D block grid (`block_id`, `plot_id_within_block`) to every dosed input, sized on its own rate count.                                                                                                                                                                                                                                                         |
| `changeRates`            | `(td: TrialDesign, opts: ChangeRatesOptions) => TrialDesign`                               | Overwrites rates on selected strips/plots of one named input, either uniformly (`"all"`), per strip (`"strip"`), or per (plot, strip) cell (`"plot"`).                                                                                                                                                                                                               |

`AssignRatesOptions`: `{ seed?: number }` (default `42`).
`ChangeRatesOptions`: `{ inputName?, stripIds: number[], plotIds?: number[], newRates: number | number[] | number[][], rateBy?: "all" | "strip" | "plot" (default "all") }`.

Design types (`RateInfo.design_type`, defaults to `"ls"` when `null`):

| Type     | Behavior                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ls`     | Default. Sequential rank sequence within each strip that respects a max rate-jump threshold, with a strip-starting rank chosen to avoid gradual drift across neighboring strips.        |
| `str`    | One rate per whole strip; the rate rotates across strips following a randomized starting sequence.                                                                                      |
| `rstr`   | Like `str`, but the strip-rotation sequence is reshuffled independently every `numRates` strips.                                                                                        |
| `rb`     | Randomized (complete) block: every `numRates`-sized block of plots gets its own random permutation of rates.                                                                            |
| `ejca`   | Splits strips into two rank tiers (below/above the median rank); each tier gets a deterministic zigzag rank sequence, direction alternating by strip. Requires an even number of rates. |
| `sparse` | The grower-chosen rate (`gcRate`, rank 1) alternates with the test rates every other plot within a strip. Requires `gcRate` to be included in `rates`.                                  |

### Diagnostics (`checkAlignment`, `checkOrthoInputs`, `checkOrthoWithChars`, `spatialJoin`, `extractRasterMeans`, `readGeoTiffRaster`)

| Export                | Signature                                                                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkAlignment`      | `(td: TrialDesign, fragments?: AlignmentFragment[][]) => AlignmentResult[]`                                                    | Per-input table of harvester-strip × experiment-plot overlap (tabular only — no plot). Pass precomputed `fragments` (one array per input) to skip the live geometry pass.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `checkOrthoInputs`    | `(td: TrialDesign, fragments?: OrthoInputsFragment[]) => number`                                                               | Area-weighted correlation between the two inputs' rates over their plot intersection (experiment plots only). Requires a two-input `td`; throws `ValidationError` on a single-input design.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `checkOrthoWithChars` | `(td: TrialDesign, soilData: FeatureCollection \| SoilFragment[] \| RasterSoilData, vars: string[]) => OrthoWithCharsResult[]` | Per-input, per-variable check between rate and a soil/field characteristic, over the full design (experiment plots + headlands). Numeric variables produce a correlation (`result.correlations`); character/factor variables produce a per-class rate mean/sd (`result.factorSummaries`) — split by the variable's runtime type, like R's `class(joined_data[[var]])`. `soilData` is a soil-layer `FeatureCollection` (join runs internally), a precomputed `SoilFragment[]` table, or `RasterSoilData` (a decoded single-band `SpatRaster` — always numeric, always populates `correlations`). |
| `spatialJoin`         | `(design: FeatureCollection, soilLayer: FeatureCollection) => SoilFragment[]`                                                  | Low-level polygon⋂polygon (or point-in-polygon) join underlying `checkOrthoWithChars`'s vector modes, exposed for direct use/testing. `values` carries both numeric and character/string soil properties.                                                                                                                                                                                                                                                                                                                                                                                       |
| `readGeoTiffRaster`   | `(bytes: Uint8Array, band?: number) => Promise<RasterGrid>`                                                                    | Decodes one band (default the first) of a GeoTIFF into a `RasterGrid` (cell grid + geo transform + nodata as `NaN`), for `extractRasterMeans`/`checkOrthoWithChars`'s raster mode.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `extractRasterMeans`  | `(design: FeatureCollection, raster: RasterGrid) => RasterPlotMean[]`                                                          | Per-design-polygon cell-center mean (R: `terra::extract(raster, rate_design, fun = mean, na.rm = TRUE)`), over the full design. Reprojects the design into the raster's CRS first if it isn't WGS84 (UTM only; other CRSs throw).                                                                                                                                                                                                                                                                                                                                                               |

Types: `AlignmentFragment`, `AlignmentOverlapRow`, `AlignmentResult`, `CharCorrelation`, `FactorClassSummary`, `FactorVarSummary`, `OrthoInputsFragment`, `OrthoWithCharsResult`, `RasterGrid`, `RasterPlotMean`, `RasterSoilData`.

Both `spatialJoin` and `extractRasterMeans` take a **flattened**
`FeatureCollection` (plots + headlands merged), not a `TrialDesign`:

```ts
const input = design.inputs[0];
const flat = {
  type: "FeatureCollection",
  features: [...input.plots.features, ...input.headlands.features],
};
const fragments = spatialJoin(flat, soilLayer);
const means = extractRasterMeans(flat, raster);
```

When feeding a precomputed fragment table to `checkOrthoWithChars`, each row
must be `{ plotKey, rate, values: { <var>: ... } }` — flat rows (like R's
`fragments.json` fixtures) need mapping first:

```ts
const fragments = rows.map(({ plotKey, rate, ...values }) => ({ plotKey, rate, values }));
```

### Machine file export (`writeTrialFiles`, `writeTrialFilesToDisk`)

| Export                  | Signature                                                                              | Description                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writeTrialFiles`       | `(td: TrialDesign, opts: WriteTrialFilesOptions) => Uint8Array`                        | Writes every input's trial-design layer (plots + headlands) plus ab-lines into a single zip archive. `ext` is `"shp"` (Shapefile), `"geojson"`, or `"isoxml"` (`TASKDATA.XML`, beta). Browser-safe. |
| `writeTrialFilesToDisk` | `(td: TrialDesign, folderPath: string, opts: WriteTrialFilesOptions) => Promise<void>` | Node/Deno-only helper: unzips `writeTrialFiles`'s output to `folderPath` via dynamic `node:fs`/`node:path` imports.                                                                                 |

`WriteTrialFilesOptions`: `{ ext: "shp" | "geojson" | "isoxml", zipName? }`.

### Units, projection, and RNG utilities

| Export                                                                     | Signature                                                                               | Description                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convUnit`                                                                 | `(value, from, to) => number`                                                           | Table lookup among `hectares`/`acres`, `meters`/`feet`, `kg`/`pounds`, `acres`/`m2` pairs; throws `ValidationError` on an unknown pair.             |
| `convertRates`                                                             | `(inputName, unit, rate, conversionType?: "to_n_equiv" \| "from_n_equiv") => number`    | Converts an input dose to (or from) its nitrogen-equivalent rate, per `INPUT_UNIT_CONVERSION_TABLE`.                                                |
| `feetToMeters`, `metersToFeet`, `acresToHectares`, `hectaresToAcres`       | `(value) => number`                                                                     | Direct unit converters.                                                                                                                             |
| `ACRES_TO_HECTARES`, `FEET_TO_METERS`, `POUNDS_TO_KG`, `LITERS_TO_GALLONS` | `number`                                                                                | Exact conversion constants.                                                                                                                         |
| `GENERIC_UNIT_CONVERSION_TABLE`, `INPUT_UNIT_CONVERSION_TABLE`             | tables                                                                                  | The raw conversion tables `convUnit`/`convertRates` look up.                                                                                        |
| `toUtm`                                                                    | `(coord: [number, number], epsg?: number) => { point: [number, number]; epsg: number }` | Projects a WGS84 `[lon, lat]` to UTM; zone from the point itself, or a supplied `epsg` to share one plane across a geometry.                        |
| `toWgs`                                                                    | `(point: [number, number], epsg: number) => [number, number]`                           | Projects a UTM point back to WGS84.                                                                                                                 |
| `utmZone`, `utmEpsg`, `utmProjString`                                      | —                                                                                       | UTM zone/EPSG/proj4-string helpers.                                                                                                                 |
| `createRng`                                                                | `(seed: number) => Rng`                                                                 | Seedable RNG (splitmix32) with `next()`, `nextInt(maxExclusive)`, `shuffle(arr)`, `sample(arr, n)`. Not a reproduction of R's RNG — see Deviations. |
| `plotKey`                                                                  | `(stripId: number, plotId: number) => string`                                           | Canonical `"${stripId}:${plotId}"` plot key (matches `SoilFragment.plotKey`); not guaranteed unique on boundaries with holes.                       |

### Error classes

`OfpetrialError` (base) → `ValidationError` (bad/inconsistent inputs), `GeometryError` (unrepairable boundary / geometry construction failure), `ExportError` (machine-file export failure, e.g. unsafe `input_name`).

### Core types

`PlotInfo`, `RateData`, `RateInfo`, `InputLayout` (output of `makeExpPlots`), `ExpData` (`{ inputs: InputLayout[] }`), `InputDesign` (output of `assignRates`), `TrialDesign` (`{ inputs: InputDesign[]; seed: number }`), `SoilFragment` (`{ plotKey, rate, values }`). `OFPETRIAL_R_VERSION` is the pinned R version string (`"0.1.3"`) these are ported from.

## R ↔ TS name mapping

See [`parity-map.json`](parity-map.json) for the authoritative, machine-checked map (R function → TS file/symbol → shared test cases → deviations). Summary:

| R                          | TS                       |
| -------------------------- | ------------------------ |
| `prep_plot`                | `prepPlot`               |
| `prep_rate`                | `prepRate`               |
| `make_exp_plots`           | `makeExpPlots`           |
| `assign_rates`             | `assignRates`            |
| `assign_rates_conditional` | `assignRatesConditional` |
| `add_blocks`               | `addBlocks`              |
| `change_rates`             | `changeRates`            |
| `check_alignment`          | `checkAlignment`         |
| `check_ortho_inputs`       | `checkOrthoInputs`       |
| `check_ortho_with_chars`   | `checkOrthoWithChars`    |
| `write_trial_files`        | `writeTrialFiles`        |

### Deviations from R

Full list with code references in `parity-map.json`; the notable ones:

- **`changeRates` targets the named input**, not R's first input — R 0.1.3's `input_name` filter is a tautology (`dplyr::filter(input_name == input_name)`) that always modifies the first input regardless of the option passed.
- **`assignRatesConditional` supports only the "partial design" flow** (one dosed + one geometry-only input); R's second supported case (conditioning on an already fully-dosed, separately built `TrialDesign`) is out of scope.
- **`sparse` design is ported from source semantics, not execution parity** — the R 0.1.3 `assign_rates` sparse branch is broken against modern `data.table` (verified by direct execution); no R reference run is possible for it.
- **`convertRates` returns sane values on paths where R 0.1.3 returns `numeric(0)`** (a dead factor-1 fallback): `unit = "liters"`, unknown (input, unit) combinations, and metric-`kg`-only input types. These paths are excluded from R parity; `tgt_rate_equiv` is informational only.
- **UTM zone selection handles both hemispheres** (326xx north / 327xx south) instead of R's hardcoded northern-hemisphere EPSG base.
- **Explicit errors instead of silent corruption/crashes**: e.g. `prepRate` throws when a `sparse` design's `rates` omits `gcRate` (R silently returns a corrupt `RateInfo`); `checkOrthoInputs` throws `ValidationError` on a single-input design (R crashes with an unassigned-variable error); `changeRates` throws on unknown strip/plot targets (R silently no-ops).
- **Seedable splitmix32 RNG**, not a reproduction of R's RNG — randomized designs are verified by properties (balance, rate-jump respect, determinism-by-seed), never by matching R's actual random sequence (design.md D4).
- **`checkOrthoWithChars`'s raster mode (`RasterSoilData`) only reprojects into WGS84 or a UTM zone** — R's `terra::extract` works in any `SpatRaster` CRS; `extractRasterMeans` throws `ValidationError` for other CRSs rather than adding a general reprojection path (out of scope: `projection.ts` only derives WGS84<->UTM transforms).
- **`OrthoWithCharsResult` keeps `correlations` in its original shape** (numeric variables only) and adds a separate `factorSummaries` array for character/factor variables, instead of folding both into one discriminated-union array — chosen so existing consumers of `correlations`/`CharCorrelation` are unaffected by factor-variable support.

## Parity & testing

Every ported function is checked against **golden-master fixtures** generated by running ofpetrial 0.1.3 itself (`tools/gen-fixtures.R`), plus a bi-runtime shared test suite: JSON test cases under `test-cases/` are run by both an R `testthat` executor (`tools/run-test-cases.R`) and the TypeScript `vitest` suite, so the same expectations exercise both languages.

Tolerances:

- **1e-6** on R-precomputed data at machine precision (e.g. `checkAlignment`/`checkOrthoInputs` fragment tables shipped as fixtures).
- **1e-3** on live-geometry integration tests (full turf.js polygon joins vs GEOS in R — reprojection/clipping noise).
- **≥ 99 % area overlap / ≤ 10 cm centroid distance** for plot-layout geometry parity.

R coverage of the ported scope is gated at **≥ 95 %** (`tools/r-coverage.R`; currently 97.17 %, see `coverage/r-coverage.json`).

Regenerating fixtures requires R + the `ofpetrial` 0.1.3 package + `sf` installed:

```bash
Rscript tools/gen-fixtures.R
```

Fixtures are deterministic (fixed seed, no timestamps) except shapefile `.dbf` headers (embed the write date) and `manifest.json` (embeds `rVersion`/`ofpetrialVersion`).

Running everything:

```bash
bun run typecheck && bun run lint && bun run build && bun run test   # TypeScript
Rscript tools/run-test-cases.R                                       # R: shared test cases
Rscript tools/r-coverage.R                                           # R: coverage gate
deno run --allow-read tools/deno-smoke.ts                             # Deno smoke test
```

## Runtimes

- **Browser / Web Worker / Node / Deno**: everything except `writeTrialFilesToDisk` is pure JS/TS over plain objects and GeoJSON — no native dependencies, no bundler-unsafe imports.
- **`writeTrialFilesToDisk`** is Node/Deno-only: it dynamically imports `node:fs/promises` and `node:path`, so it is never pulled into a browser bundle unless explicitly called.
- See [`examples/supabase-edge-function/index.ts`](examples/supabase-edge-function/index.ts) for a working Deno Edge Function running the full pipeline per request, and [`tools/deno-smoke.ts`](tools/deno-smoke.ts) / [`tests/browser-smoke.test.ts`](tests/browser-smoke.test.ts) for the runtime smoke tests this repo's CI runs on every push.

## License and attribution

GPL-3.0-or-later (see [LICENSE](LICENSE)). This is a derivative work of [ofpetrial](https://cran.r-project.org/package=ofpetrial) ([DIFM-Brain/ofpetrial](https://github.com/DIFM-Brain/ofpetrial)) by **Taro Mieno et al.** — all algorithmic credit belongs to the original authors. Importing this library into an application produces a combined work subject to the terms of GPL-3; combining it into proprietary software requires clearing that obligation first (GPL-3 has no library exception, unlike LGPL).

## Upstream sync

When a new `ofpetrial` version lands on CRAN, see [`tools/UPSTREAM-SYNC.md`](tools/UPSTREAM-SYNC.md) for the version-bump procedure (`tools/upstream-sync.ts` diffs the ported R scope, maps touched functions via `parity-map.json`, and drives fixture/reference regeneration).
