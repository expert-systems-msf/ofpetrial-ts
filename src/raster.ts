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
   * SIGNED pixel height (geotiff.js getResolution convention). Its sign is a
   * RELIABLE north-up indicator only for ModelPixelScale georeferencing; for
   * ModelTransformation rasters getResolution derives yres from the affine and
   * a north-up raster can report a POSITIVE yres. Use `northUp` for
   * orientation and `Math.abs(yres)` for the cell height.
   */
  yres: number;
  /**
   * True when row 0 is the north/top edge. Derived from the affine origin
   * (getOrigin returns the top-left corner for both ModelPixelScale and
   * ModelTransformation georeferencing), so it is correct where `yres < 0` is
   * not. extractRasterMeans uses this to orient row indexing.
   */
  northUp: boolean;
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

  // Orientation from the affine origin, not the sign of yres: getOrigin
  // returns the top-left corner for both ModelPixelScale and
  // ModelTransformation georeferencing, so this is correct even when a
  // north-up ModelTransformation raster reports a positive yres (see M6).
  const originY = (image.getOrigin() as [number, number, number])[1];
  const northUp = Math.abs(originY - maxY) <= Math.abs(originY - minY);

  const rasters = await image.readRasters({ samples: [band], interleave: false });
  const raw = (rasters as unknown as ArrayLike<number>[])[0]!;
  // Float32 rasters carry Float32-quantised cell values, but getGDALNoData
  // parses the tag string as Float64. A sentinel like "-3.402823e+38" then
  // does not === the widened Float32 cell, so also compare against the
  // Float32 rounding of the nodata value (see M7).
  const isFloat32 = raw instanceof Float32Array;
  const noDataF32 = nodata !== null && isFloat32 ? Math.fround(nodata) : null;
  const data = new Float64Array(width * height);
  for (let index = 0; index < data.length; index++) {
    const value = raw[index]!;
    const masked = nodata !== null && (value === nodata || value === noDataF32);
    data[index] = masked ? NaN : value;
  }

  return {
    width,
    height,
    bbox: [minX, minY, maxX, maxY],
    xres,
    yres,
    northUp,
    data,
    epsg: epsgFromGeoKeys(image.getGeoKeys()),
  };
}
