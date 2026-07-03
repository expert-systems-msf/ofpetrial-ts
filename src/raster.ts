// GeoTIFF reading — pure raster I/O, no trial-design domain knowledge (that
// lives in diagnostics.ts's extractRasterMeans, which consumes RasterGrid).
// Uses geotiff.js (MIT) to decode band 1 of a single-band GeoTIFF, matching
// the R side's `terra::rast(path)` (ofpetrial's check_ortho_with_chars raster
// branch, see diagnose.R's summarize_chars).
import { fromArrayBuffer } from "geotiff";

/**
 * Decoded single-band raster: band cell values in row-major order, plus the
 * geo transform needed to compute cell-center coordinates. Row orientation
 * is carried by `yres`'s sign — do not assume north-up.
 */
export interface RasterGrid {
  width: number;
  height: number;
  /** [minX, minY, maxX, maxY] in the raster's native CRS units. */
  bbox: [number, number, number, number];
  /** Pixel width (always positive), in the raster's native CRS units. */
  xres: number;
  /**
   * SIGNED pixel height (geotiff.js getResolution convention): negative for
   * the usual north-up rasters (row 0 = north/top), positive for south-up
   * rasters (row 0 = south/bottom). extractRasterMeans handles both.
   */
  yres: number;
  /** Row-major band values, length width*height. NaN marks nodata cells. */
  data: Float64Array;
  /** EPSG code from the file's GeoKeys, or null when none could be determined. */
  epsg: number | null;
}

function epsgFromGeoKeys(geoKeys: Partial<Record<string, unknown>> | null): number | null {
  if (!geoKeys) return null;
  const modelType = geoKeys.GTModelTypeGeoKey;
  if (modelType === 2) {
    // Geographic (lon/lat) CRS.
    const code = geoKeys.GeographicTypeGeoKey;
    return typeof code === "number" ? code : null;
  }
  if (modelType === 1) {
    // Projected CRS.
    const code = geoKeys.ProjectedCSTypeGeoKey;
    return typeof code === "number" ? code : null;
  }
  return null;
}

/**
 * Reads band `band` (0-based, default the first/only band) of a GeoTIFF from
 * raw bytes. Mirrors `terra::rast(path)` + implicit band-1 selection on the R
 * side closely enough for check_ortho_with_chars' raster branch: same cell
 * grid, same nodata handling (both the file's declared nodata value and
 * literal NaN cells are treated as missing). The y-resolution is kept SIGNED
 * (negative = north-up) so south-up rasters keep their orientation.
 */
export async function readGeoTiffRaster(bytes: Uint8Array, band = 0): Promise<RasterGrid> {
  // Copy to a zero-offset ArrayBuffer: geotiff.js requires ArrayBuffer, and a
  // Uint8Array view's own .buffer may be larger/offset (e.g. a Node Buffer).
  const arrayBuffer = Uint8Array.from(bytes).buffer;
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  const [minX, minY, maxX, maxY] = image.getBoundingBox() as [number, number, number, number];
  const [xres, yres] = image.getResolution() as [number, number];
  const nodata = image.getGDALNoData();

  const rasters = await image.readRasters({ samples: [band], interleave: false });
  const raw = (rasters as unknown as ArrayLike<number>[])[0]!;
  const data = new Float64Array(width * height);
  for (let index = 0; index < data.length; index++) {
    const value = raw[index]!;
    data[index] = nodata !== null && value === nodata ? NaN : value;
  }

  return {
    width,
    height,
    bbox: [minX, minY, maxX, maxY],
    xres,
    yres,
    data,
    epsg: epsgFromGeoKeys(image.getGeoKeys()),
  };
}
