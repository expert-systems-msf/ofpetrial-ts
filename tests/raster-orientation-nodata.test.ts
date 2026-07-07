// Regression tests for the raster reader (src/raster.ts), audit findings:
// - M6: north-up orientation must come from the affine origin, not the sign
//   of yres — a north-up ModelTransformation raster reports a POSITIVE yres
//   yet must still be read top-row-first.
// - M7: a Float32 raster whose GDAL_NODATA sentinel does not round-trip
//   exactly to Float32 (e.g. "-3.402823e+38") must still mask its nodata cells.
import { writeArrayBuffer } from "geotiff";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { extractRasterMeans } from "../src/diagnostics.js";
import { readGeoTiffRaster } from "../src/raster.js";

interface TiffOpts {
  width: number;
  height: number;
  /** 4x4 row-major affine (GeoTIFF ModelTransformation tag), or omitted for
   * the default ModelPixelScale+tiepoint north-up georeferencing. */
  transform?: number[];
  nodata?: string;
  float32?: boolean;
  epsg?: number;
}

function writeTiff(values: number[], opts: TiffOpts): Uint8Array {
  const metadata: Record<string, unknown> = { width: opts.width, height: opts.height };
  if (opts.transform) metadata.ModelTransformation = opts.transform;
  if (opts.nodata !== undefined) metadata.GDAL_NODATA = opts.nodata;
  if (opts.float32) {
    metadata.SampleFormat = [3];
    metadata.BitsPerSample = [32];
  }
  if (opts.epsg !== undefined) {
    metadata.GTModelTypeGeoKey = 2; // geographic (lon/lat)
    metadata.GTRasterTypeGeoKey = 1;
    metadata.GeographicTypeGeoKey = opts.epsg;
  }
  const array = opts.float32 ? new Float32Array(values) : new Float64Array(values);
  const ab = writeArrayBuffer(array, metadata) as ArrayBuffer;
  return new Uint8Array(ab);
}

// row-major affine: [a,b,0,c, d,e,0,f, 0,0,0,0, 0,0,0,1] maps (col,row)->(x,y)
// as x = a*col + b*row + c, y = d*col + e*row + f.
const northUpTransform = (originX: number, originY: number, xres: number, yres: number): number[] => [
  xres, 0, 0, originX,
  0, -yres, 0, originY, // e = -yres < 0 => row grows southward => north-up
  0, 0, 0, 0,
  0, 0, 0, 1,
];
const southUpTransform = (originX: number, originY: number, xres: number, yres: number): number[] => [
  xres, 0, 0, originX,
  0, yres, 0, originY, // e = +yres > 0 => row grows northward => south-up
  0, 0, 0, 0,
  0, 0, 0, 1,
];

describe("readGeoTiffRaster — M6 orientation from affine origin", () => {
  it("reports north-up for a north-up ModelTransformation raster even when yres is positive", async () => {
    const bytes = writeTiff([10, 10, 20, 20], {
      width: 2,
      height: 2,
      transform: northUpTransform(0, 2, 1, 1),
    });
    const raster = await readGeoTiffRaster(bytes);
    // The whole point of the bug: getResolution yields a positive yres here...
    expect(raster.yres).toBeGreaterThan(0);
    // ...but the raster is genuinely north-up (origin at the top edge).
    expect(raster.northUp).toBe(true);
  });

  it("reports south-up for a south-up ModelTransformation raster (yres negative)", async () => {
    const bytes = writeTiff([20, 20, 10, 10], {
      width: 2,
      height: 2,
      transform: southUpTransform(0, 0, 1, 1),
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(raster.yres).toBeLessThan(0);
    expect(raster.northUp).toBe(false);
  });
});

describe("extractRasterMeans — M6 samples the correct row for a north-up ModelTransformation raster", () => {
  it("a polygon over the northern half reads the top row, not the mirrored bottom row", async () => {
    // 2x2 grid, cells 1x1, origin (0,2) top-left, north-up. Top row (row 0,
    // y in [1,2]) = 10; bottom row (row 1, y in [0,1]) = 20.
    const bytes = writeTiff([10, 10, 20, 20], {
      width: 2,
      height: 2,
      transform: northUpTransform(0, 2, 1, 1),
      epsg: 4326,
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(raster.epsg).toBe(4326);

    const northPolygon: Feature<Polygon> = {
      type: "Feature",
      properties: { rate: 100, type: "experiment", strip_id: 1, plot_id: 1 },
      geometry: {
        type: "Polygon",
        coordinates: [[[0.1, 1.1], [1.9, 1.1], [1.9, 1.9], [0.1, 1.9], [0.1, 1.1]]],
      },
    };
    const design: FeatureCollection = { type: "FeatureCollection", features: [northPolygon] };

    const [result] = extractRasterMeans(design, raster);
    expect(result!.mean).toBe(10); // north row; pre-fix (mirrored) would read 20
  });
});

describe("readGeoTiffRaster — M7 Float32 nodata masking", () => {
  it("masks Float32 nodata cells whose sentinel does not round-trip to Float64", async () => {
    const sentinel = "-3.402823e+38";
    const nd = Math.fround(Number(sentinel)); // the Float32-quantised cell value
    // 2x2: one nodata cell, three real values.
    const bytes = writeTiff([nd, 1.5, 2.5, 3.5], {
      width: 2,
      height: 2,
      float32: true,
      nodata: sentinel,
    });
    const raster = await readGeoTiffRaster(bytes);
    expect(Number.isNaN(raster.data[0]!)).toBe(true); // masked
    expect(raster.data[1]).toBeCloseTo(1.5, 4);
    expect(raster.data[2]).toBeCloseTo(2.5, 4);
    expect(raster.data[3]).toBeCloseTo(3.5, 4);
  });
});
