// Coverage tests for extractRasterMeans branches not exercised by the existing
// north-up WGS84 suites (raster-orientation-nodata.test.ts,
// parity-ortho-with-chars-extensions.test.ts). Every case asserts an EXACT
// cell-center mean computed by hand from the fixture (terra::extract cell-center
// semantics: a cell is counted iff its CENTER falls inside the polygon).
//
// Branches targeted (src/diagnostics.ts line numbers):
// - isUtmEpsg southern arm 32701..32760                              (757)
// - projectGeom Polygon reprojection path (needsReprojection true)   (91)
// - projectGeom MultiPolygon branch                                  (93-96)
// - rowOf / cellY south-up arms                                      (809, 831)
// - count > 0 ? sum/count : NaN  -> NaN fallback arm                 (845)
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { describe, expect, it } from "vitest";
import { extractRasterMeans } from "../src/diagnostics.js";
import type { RasterGrid } from "../src/raster.js";
import { toWgs } from "../src/projection.js";

// EPSG:32721 = UTM zone 21S. A 2x2 raster, 100 m cells, native UTM meters.
// Origin (top-left) at (500000, 6000200), north-up. Cell centers:
//   x in {500050, 500150}, y in {6000150 (north row), 6000050 (south row)}
// Values (north-up row-major): north row 10,20 ; south row 30,40.
const UTM_EPSG = 32_721;
function utmSouthGrid(): RasterGrid {
  return {
    width: 2,
    height: 2,
    bbox: [500_000, 6_000_000, 500_200, 6_000_200],
    xres: 100,
    yres: -100, // north-up ModelPixelScale convention
    northUp: true,
    data: new Float64Array([10, 20, 30, 40]),
    epsg: UTM_EPSG,
  };
}

// A UTM-meter axis-aligned rectangle expressed back in WGS84 lon/lat, so that
// extractRasterMeans' projectGeom (toUtm, same zone) round-trips it to ~the
// original UTM rectangle (round-trip error << 1 m; all cell centers sit >= 50 m
// from every polygon edge, so coverage is exact and known).
function utmRectRing(x0: number, y0: number, x1: number, y1: number): Position[] {
  const c: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  return c.map((p) => toWgs(p, UTM_EPSG) as Position);
}

function designOf(geometry: Polygon | MultiPolygon): FeatureCollection {
  const feature: Feature<Polygon | MultiPolygon> = {
    type: "Feature",
    properties: { rate: 1, strip_id: 1, plot_id: 1 },
    geometry,
  };
  return { type: "FeatureCollection", features: [feature] };
}

describe("extractRasterMeans — southern UTM raster (reprojection path)", () => {
  it("takes the 32701..32760 arm and projectGeom Polygon path, exact per-plot mean", () => {
    // Polygon (in lon/lat) covering only the NORTH row of the UTM grid:
    // UTM rect x[500000,500200] y[6000100,6000200]. North centers (y=6000150)
    // are inside -> values 10, 20; south centers (y=6000050) excluded.
    // mean = (10 + 20) / 2 = 15.
    const ring = utmRectRing(500_000, 6_000_100, 500_200, 6_000_200);
    const design = designOf({ type: "Polygon", coordinates: [ring] });

    const [result] = extractRasterMeans(design, utmSouthGrid());
    expect(result!.mean).toBe(15);
  });

  it("full-extent lon/lat polygon over the UTM grid averages all four cells", () => {
    // UTM rect x[500000,500200] y[6000000,6000200] covers every cell center.
    // mean = (10 + 20 + 30 + 40) / 4 = 25.
    const ring = utmRectRing(500_000, 6_000_000, 500_200, 6_000_200);
    const design = designOf({ type: "Polygon", coordinates: [ring] });

    const [result] = extractRasterMeans(design, utmSouthGrid());
    expect(result!.mean).toBe(25);
  });
});

describe("extractRasterMeans — MultiPolygon design over a UTM raster", () => {
  it("forces the projectGeom MultiPolygon branch, exact union-of-cells mean", () => {
    // Two disjoint UTM rectangles (expressed in lon/lat):
    //   polyA x[500000,500100] y[6000100,6000200] -> north-west center
    //         (500050, 6000150) = value 10
    //   polyB x[500100,500200] y[6000000,6000100] -> south-east center
    //         (500150, 6000050) = value 40
    // Covered cells across the union: {10, 40}; mean = (10 + 40) / 2 = 25.
    const ringA = utmRectRing(500_000, 6_000_100, 500_100, 6_000_200);
    const ringB = utmRectRing(500_100, 6_000_000, 500_200, 6_000_100);
    const geometry: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [[ringA], [ringB]],
    };
    const design = designOf(geometry);

    const [result] = extractRasterMeans(design, utmSouthGrid());
    expect(result!.mean).toBe(25);
  });
});

// 2x2 WGS84 grid over bbox [0,0]..[2,2], 1x1 cells, centers x,y in {0.5, 1.5}.
// Same geographic scene as the parity suite's syntheticGrid:
//   north row (y=1.5): 10 (west), 20 (east); south row (y=0.5): 30, 40.
// Row-major storage flips with orientation.
function wgsGrid(northUp: boolean): RasterGrid {
  return {
    width: 2,
    height: 2,
    bbox: [0, 0, 2, 2],
    xres: 1,
    yres: northUp ? -1 : 1,
    northUp,
    data: northUp ? new Float64Array([10, 20, 30, 40]) : new Float64Array([30, 40, 10, 20]),
    epsg: 4326,
  };
}

function rectDesign(x0: number, y0: number, x1: number, y1: number): FeatureCollection {
  return designOf({
    type: "Polygon",
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  });
}

describe("extractRasterMeans — south-up orientation arms", () => {
  it("rowOf/cellY south arms yield the south-row cells with an exact mean", () => {
    // Polygon over the SOUTH half (y in [0,1]) contains only the south-row
    // centers (y=0.5): values 30, 40. mean = (30 + 40) / 2 = 35.
    const [result] = extractRasterMeans(rectDesign(0, 0, 2, 1), wgsGrid(false));
    expect(result!.mean).toBe(35);
  });

  it("south-up north half yields the north-row cells, exact mean", () => {
    // South half excluded; north-row centers (y=1.5): 10, 20. mean = 15.
    const [result] = extractRasterMeans(rectDesign(0, 1, 2, 2), wgsGrid(false));
    expect(result!.mean).toBe(15);
  });
});

describe("extractRasterMeans — raster-edge scan-window clamps (Math.max/min pinned)", () => {
  // wgsGrid(true): bbox [0,0]..[2,2], 1x1 cells, centers x,y in {0.5, 1.5}.
  //   row 0 (north, y=1.5): col0=10, col1=20 ; row 1 (south, y=0.5): col0=30, col1=40.
  // Each design plot pokes PAST one raster edge so that, WITHOUT the clamp, the
  // scan window's phantom out-of-range index either wraps into a neighbouring
  // row's real cell (left/right edges -> a wrong finite mean) or reads past the
  // flat array (top/bottom edges -> undefined -> NaN). The clamp is therefore
  // load-bearing: each exact mean below differs from the unclamped result.
  const grid = wgsGrid(true);

  it("col 0 / left edge: Math.max(0, ...) prevents col -1 wrapping into the prior row", () => {
    // Plot x[-1,1] y[0,1] contains only the south-row col0 center (0.5, 0.5)=30.
    // colLo = max(0, floor((-1-0)/1) - 1) = max(0, -2) = 0.  Without the clamp
    // colLo=-1 -> cellX=-0.5 (inside the plot) -> data[1*2 + (-1)] = data[1] = 20
    // wrongly averaged in, giving 25. Clamped mean = 30.
    const [result] = extractRasterMeans(rectDesign(-1, 0, 1, 1), grid);
    expect(result!.mean).toBe(30);
  });

  it("last col / right edge: Math.min(width-1, ...) prevents col=width wrapping into the next row", () => {
    // Plot x[1,3] y[1,2] contains only the north-row col1 center (1.5, 1.5)=20.
    // colHi = min(1, ceil((3-0)/1) + 1) = min(1, 4) = 1.  Without the clamp
    // colHi=... reaches col=2 -> cellX=2.5 (inside) -> data[0*2 + 2] = data[2] = 30
    // wrongly averaged in, giving 25. Clamped mean = 20.
    const [result] = extractRasterMeans(rectDesign(1, 1, 3, 2), grid);
    expect(result!.mean).toBe(20);
  });

  it("row 0 / top edge: Math.max(0, ...) prevents row -1 reading before the array", () => {
    // Plot x[0,1] y[1,3] contains only the north-row col0 center (0.5, 1.5)=10.
    // rowLo = max(0, floor(min(rowOf(1),rowOf(3))) - 1) = max(0, -2) = 0. Without
    // the clamp row=-1 -> cellY=2.5 (inside) -> data[-1*2 + 0] = data[-2] =
    // undefined -> mean NaN. Clamped mean = 10.
    const [result] = extractRasterMeans(rectDesign(0, 1, 1, 3), grid);
    expect(result!.mean).toBe(10);
  });

  it("last row / bottom edge: Math.min(height-1, ...) prevents row=height reading past the array", () => {
    // Plot x[0,1] y[-1,1] contains only the south-row col0 center (0.5, 0.5)=30.
    // rowHi = min(1, ceil(max(rowOf(-1),rowOf(1))) + 1) = min(1, 4) = 1. Without
    // the clamp row=2 -> cellY=-0.5 (inside) -> data[2*2 + 0] = data[4] =
    // undefined -> mean NaN. Clamped mean = 30.
    const [result] = extractRasterMeans(rectDesign(0, -1, 1, 1), grid);
    expect(result!.mean).toBe(30);
  });
});

describe("extractRasterMeans — NaN fallback when no valid cell center is covered", () => {
  it("returns NaN when the only covered cell center is nodata (count === 0 arm)", () => {
    // North-up grid whose north-west cell (center 0.5, 1.5) is nodata (NaN).
    const grid: RasterGrid = {
      ...wgsGrid(true),
      data: new Float64Array([NaN, 20, 30, 40]),
    };
    // Tiny polygon x[0.3,0.7] y[1.3,1.7] contains ONLY the (0.5, 1.5) center,
    // which is nodata -> skipped -> count 0 -> mean NaN.
    const [result] = extractRasterMeans(rectDesign(0.3, 1.3, 0.7, 1.7), grid);
    expect(Number.isNaN(result!.mean)).toBe(true);
  });

  it("returns NaN when the polygon sits between cell centers (no center inside)", () => {
    // Polygon x[0.6,0.9] y[0.6,0.9] falls in the gap between the four centers
    // (0.5/1.5) -> no cell center inside -> count 0 -> mean NaN.
    const [result] = extractRasterMeans(rectDesign(0.6, 0.6, 0.9, 0.9), wgsGrid(true));
    expect(Number.isNaN(result!.mean)).toBe(true);
  });
});
