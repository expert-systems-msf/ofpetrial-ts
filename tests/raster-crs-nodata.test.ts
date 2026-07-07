// Coverage tests for src/raster.ts branches not exercised by
// raster-orientation-nodata.test.ts:
// - epsgFromGeoKeys projected branch (raster.ts:49-53): GTModelTypeGeoKey=1
//   reads ProjectedCSTypeGeoKey.
// - readGeoTiffRaster nodata masking on a Float64 raster (raster.ts:96, the
//   exact `value === nodata` arm with noDataF32 === null).
// - no GDAL_NODATA tag => nodata === null => nothing masked (short-circuit).
import { writeArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { readGeoTiffRaster } from "../src/raster.js";

interface TiffOpts {
  width: number;
  height: number;
  nodata?: string;
  float32?: boolean;
  /** 4x4 row-major ModelTransformation affine (georeferencing). */
  transform?: number[];
  /** Geographic (lon/lat) CRS EPSG => GTModelTypeGeoKey=2. */
  geographicEpsg?: number;
  /** Projected CRS EPSG => GTModelTypeGeoKey=1. */
  projectedEpsg?: number;
}

// north-up affine: x = xres*col + originX, y = -yres*row + originY.
const northUpTransform = (
  originX: number,
  originY: number,
  xres: number,
  yres: number
): number[] => [xres, 0, 0, originX, 0, -yres, 0, originY, 0, 0, 0, 0, 0, 0, 0, 1];

function writeTiff(values: number[], opts: TiffOpts): Uint8Array {
  const metadata: Record<string, unknown> = { width: opts.width, height: opts.height };
  if (opts.transform) metadata.ModelTransformation = opts.transform;
  if (opts.nodata !== undefined) metadata.GDAL_NODATA = opts.nodata;
  if (opts.float32) {
    metadata.SampleFormat = [3];
    metadata.BitsPerSample = [32];
  }
  if (opts.geographicEpsg !== undefined) {
    metadata.GTModelTypeGeoKey = 2; // geographic (lon/lat)
    metadata.GTRasterTypeGeoKey = 1;
    metadata.GeographicTypeGeoKey = opts.geographicEpsg;
  }
  if (opts.projectedEpsg !== undefined) {
    metadata.GTModelTypeGeoKey = 1; // projected
    metadata.GTRasterTypeGeoKey = 1;
    metadata.ProjectedCSTypeGeoKey = opts.projectedEpsg;
  }
  const array = opts.float32 ? new Float32Array(values) : new Float64Array(values);
  const ab = writeArrayBuffer(array, metadata) as ArrayBuffer;
  return new Uint8Array(ab);
}

describe("readGeoTiffRaster — projected CRS GeoKeys (raster.ts:49-53)", () => {
  it("reads ProjectedCSTypeGeoKey for a projected (GTModelTypeGeoKey=1) UTM raster", async () => {
    // UTM zone 16N (WGS84) — a plausible on-farm projected CRS.
    const bytes = writeTiff([1, 2, 3, 4], {
      width: 2,
      height: 2,
      transform: northUpTransform(500_000, 4_649_776, 30, 30),
      projectedEpsg: 32_616,
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(raster.epsg).toBe(32_616);
  });
});

describe("readGeoTiffRaster — Float64 nodata masking (raster.ts:91-97)", () => {
  it("masks a Float64 cell equal to the declared nodata value, keeps real values", async () => {
    // Float64 raster: isFloat32 === false => noDataF32 === null, so masking
    // relies solely on the exact `value === nodata` arm (raster.ts:96).
    const nodata = -9999;
    const bytes = writeTiff([nodata, 1.25, 2.5, 3.75], {
      width: 2,
      height: 2,
      nodata: String(nodata),
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(Number.isNaN(raster.data[0]!)).toBe(true); // sentinel => masked
    expect(raster.data[1]).toBe(1.25);
    expect(raster.data[2]).toBe(2.5);
    expect(raster.data[3]).toBe(3.75);
  });

  it("masks nothing when there is no GDAL_NODATA tag (nodata === null short-circuit)", async () => {
    // Same sentinel-looking value, but no nodata tag => nodata === null, so the
    // mask short-circuits and the value is retained verbatim.
    const bytes = writeTiff([-9999, 1.25, 2.5, 3.75], {
      width: 2,
      height: 2,
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(raster.data[0]).toBe(-9999); // retained, not masked
    expect(Number.isNaN(raster.data[0]!)).toBe(false);
    expect(raster.data[1]).toBe(1.25);
  });
});
