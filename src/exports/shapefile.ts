// Shapefile (.shp/.shx/.dbf/.prj) writer — task 7.1.
//
// Decision (D7): a hand-rolled writer, not `@mapbox/shp-write`.
// `shp-write` (0.4.3, BSD-2) was evaluated first per design.md D7, but
// rejected on inspection: it depends on `jszip` + `file-saver`
// (`npm view @mapbox/shp-write dependencies`), both explicitly excluded by
// D7's zip decision ("fflate dans les deux cas, pas jszip/file-saver");
// `file-saver` assumes a `Blob`/`document` browser global, which is unsound
// in Deno/Node; and the package has had no release since 2023-08. The
// shapefile binary format itself is a short, stable, fully public spec
// (ESRI Shapefile Technical Description, 1998) — a controlled ~300-line
// writer is cheaper and more auditable than routing around a stale
// dependency's assumptions. Verified against the R fixtures
// (fixtures/*/imperial/r-exports/*.shp) for header layout, ring winding and
// DBF NA encoding (see comments below); an independent reader written for
// the test suite re-parses this module's own output (no self-validation).
// GDAL ogrinfo/ogr2ogr 3.13 verification was additionally run locally on
// 2026-07-02 (one-time D7 "QGIS-openable" gate; the recurring gate is the
// independent-reader test suite).
import type { LineString, MultiLineString, MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../types.js";

export type Ring = Array<[number, number]>;

export interface ShapefileFieldSpec {
  /** DBF field name, <= 10 chars (dBase III name cell is 11 bytes incl. NUL). */
  name: string;
  type: "N" | "C";
  length: number;
  /** Decimal places for "N" fields (ignored for "C"). Default 0. */
  decimals?: number;
}

export interface ShapefileFeatureInput {
  geometry: Polygon | MultiPolygon | LineString | MultiLineString;
  properties: Record<string, number | string | null>;
}

export interface WriteShapefileOptions {
  geometryType: "polygon" | "polyline";
  fields: ShapefileFieldSpec[];
}

export interface ShapefileBytes {
  shp: Uint8Array;
  shx: Uint8Array;
  dbf: Uint8Array;
  prj: Uint8Array;
}

/** Same WGS84 .prj text ArcGIS/GDAL (and thus R's sf::st_write) produce. */
const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

const SHAPE_TYPE_POLYGON = 5;
const SHAPE_TYPE_POLYLINE = 3;

/** Shoelace signed area; positive = CCW, negative = CW (standard x/y convention). */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[index + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function reversed(ring: Ring): Ring {
  return [...ring].reverse();
}

/**
 * Rings of a Polygon/MultiPolygon, reoriented to the shapefile convention:
 * outer ring clockwise, hole rings counter-clockwise — the opposite of
 * GeoJSON/RFC 7946's right-hand rule. Verified against
 * fixtures/simple1/imperial/r-exports/trial-design-seed.shp (outer ring
 * signed area < 0, hole ring signed area > 0).
 */
function polygonRings(geometry: Polygon | MultiPolygon): Ring[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const rings: Ring[] = [];
  for (const poly of polygons) {
    poly.forEach((ring, index) => {
      const r = ring as Ring;
      const isWantClockwise = index === 0; // exterior ring
      const isClockwise = signedArea(r) < 0;
      rings.push(isWantClockwise === isClockwise ? r : reversed(r));
    });
  }
  return rings;
}

function lineParts(geometry: LineString | MultiLineString): Ring[] {
  return geometry.type === "LineString"
    ? [geometry.coordinates as Ring]
    : (geometry.coordinates as Ring[]);
}

function partsOf(
  geometryType: "polygon" | "polyline",
  geometry: ShapefileFeatureInput["geometry"]
): Ring[] {
  if (geometryType === "polygon") {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
      throw new ExportError(`Expected Polygon/MultiPolygon geometry, got "${geometry.type}"`);
    }
    return polygonRings(geometry);
  }
  if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") {
    throw new ExportError(`Expected LineString/MultiLineString geometry, got "${geometry.type}"`);
  }
  return lineParts(geometry);
}

interface Bbox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

function partsBbox(parts: Ring[]): Bbox {
  if (parts.every((p) => p.length === 0)) {
    throw new ExportError("writeShapefile: feature has no rings/points (empty geometry)");
  }
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const part of parts) {
    for (const [x, y] of part) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  return { xMin, yMin, xMax, yMax };
}

function mergeBbox(a: Bbox, b: Bbox): Bbox {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

// ---------------------------------------------------------------------------
// .shp / .shx
// ---------------------------------------------------------------------------

function recordContentLengthBytes(parts: Ring[]): number {
  const numberPoints = parts.reduce((n, p) => n + p.length, 0);
  return 4 + 32 + 4 + 4 + 4 * parts.length + 16 * numberPoints;
}

function writeShpRecordContent(
  view: DataView,
  offset: number,
  shapeType: number,
  parts: Ring[]
): number {
  let o = offset;
  const bbox = partsBbox(parts);
  view.setInt32(o, shapeType, true);
  o += 4;
  view.setFloat64(o, bbox.xMin, true);
  view.setFloat64(o + 8, bbox.yMin, true);
  view.setFloat64(o + 16, bbox.xMax, true);
  view.setFloat64(o + 24, bbox.yMax, true);
  o += 32;
  view.setInt32(o, parts.length, true);
  o += 4;
  const numberPoints = parts.reduce((n, p) => n + p.length, 0);
  view.setInt32(o, numberPoints, true);
  o += 4;
  let pointIndex = 0;
  for (const part of parts) {
    view.setInt32(o, pointIndex, true);
    o += 4;
    pointIndex += part.length;
  }
  for (const part of parts) {
    for (const [x, y] of part) {
      view.setFloat64(o, x, true);
      view.setFloat64(o + 8, y, true);
      o += 16;
    }
  }
  return o;
}

function writeShpAndShx(
  shapeType: number,
  featureParts: Ring[][]
): { shp: Uint8Array; shx: Uint8Array } {
  const contentLengths = featureParts.map(recordContentLengthBytes);
  const shpBodyBytes = contentLengths.reduce((n, c) => n + 8 + c, 0);
  const shpTotalBytes = 100 + shpBodyBytes;
  const shxTotalBytes = 100 + 8 * featureParts.length;

  const shpBuffer = new ArrayBuffer(shpTotalBytes);
  const shxBuffer = new ArrayBuffer(shxTotalBytes);
  const shpView = new DataView(shpBuffer);
  const shxView = new DataView(shxBuffer);

  const datasetBbox =
    featureParts.length > 0
      ? featureParts.map(partsBbox).reduce(mergeBbox)
      : { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };

  function writeHeader(view: DataView, fileLengthWords: number): void {
    view.setInt32(0, 9994, false);
    for (let index = 4; index <= 20; index += 4) view.setInt32(index, 0, false);
    view.setInt32(24, fileLengthWords, false);
    view.setInt32(28, 1000, true);
    view.setInt32(32, shapeType, true);
    view.setFloat64(36, datasetBbox.xMin, true);
    view.setFloat64(44, datasetBbox.yMin, true);
    view.setFloat64(52, datasetBbox.xMax, true);
    view.setFloat64(60, datasetBbox.yMax, true);
    for (let index = 68; index < 100; index += 8) view.setFloat64(index, 0, true);
  }

  writeHeader(shpView, shpTotalBytes / 2);
  writeHeader(shxView, shxTotalBytes / 2);

  let shpOffset = 100;
  let shxOffset = 100;
  for (const [index, parts] of featureParts.entries()) {
    const contentLength = contentLengths[index]!;
    shpView.setInt32(shpOffset, index + 1, false);
    shpView.setInt32(shpOffset + 4, contentLength / 2, false);
    writeShpRecordContent(shpView, shpOffset + 8, shapeType, parts);

    shxView.setInt32(shxOffset, shpOffset / 2, false);
    shxView.setInt32(shxOffset + 4, contentLength / 2, false);

    shpOffset += 8 + contentLength;
    shxOffset += 8;
  }

  return { shp: new Uint8Array(shpBuffer), shx: new Uint8Array(shxBuffer) };
}

// ---------------------------------------------------------------------------
// .dbf (dBase III, no memo)
// ---------------------------------------------------------------------------

function padName(name: string): Uint8Array {
  if (name.length > 10) {
    throw new ExportError(
      `DBF field name "${name}" exceeds 10 characters (dBase III name cell is 11 bytes incl. NUL)`
    );
  }
  const bytes = new Uint8Array(11);
  for (let index = 0; index < name.length; index++) bytes[index] = name.charCodeAt(index);
  return bytes;
}

/**
 * Formats one field value per dBase III convention: "N" right-justified
 * (space-padded), "C" left-justified (space-padded). `null` numerics are
 * written as a field of '*' — the NA marker GDAL's Shapefile driver writes
 * (verified byte-for-byte against fixtures/simple1/imperial/r-exports/
 * trial-design-seed.dbf's headland row: strip_id/plot_id are `null` in R
 * and stored as 18 '*' characters, i.e. two 9-wide fields fully starred).
 * The '*' NA convention only exists for numeric fields; a null on a "C"
 * field has no dBase encoding here and throws.
 */
function formatField(value: number | string | null, field: ShapefileFieldSpec): string {
  const { type, length, decimals = 0 } = field;
  if (value === null) {
    if (type !== "N") {
      throw new ExportError(
        `DBF field "${field.name}": null is only supported on numeric ("N") fields`
      );
    }
    return "*".repeat(length);
  }
  if (type === "C") {
    return String(value).slice(0, length).padEnd(length, " ");
  }
  const text =
    decimals > 0 ? (value as number).toFixed(decimals) : String(Math.trunc(value as number));
  if (text.length > length) {
    throw new ExportError(
      `DBF field "${field.name}" value "${text}" (${text.length} chars) exceeds width ${length}`
    );
  }
  return text.padStart(length, " ");
}

function writeDbf(features: ShapefileFeatureInput[], fields: ShapefileFieldSpec[]): Uint8Array {
  for (const field of fields) {
    // The DBF field-length descriptor is a single byte: lengths > 255 would
    // silently wrap. (padName rejects names > 10 chars for the same reason.)
    if (field.length > 255) {
      throw new ExportError(
        `DBF field "${field.name}" length ${field.length} exceeds the single-byte maximum (255)`
      );
    }
  }
  const numberFields = fields.length;
  const headerSize = 32 + 32 * numberFields + 1;
  const recordSize = 1 + fields.reduce((n, f) => n + f.length, 0);
  const numberRecords = features.length;
  const totalSize = headerSize + numberRecords * recordSize + 1; // +1 EOF marker

  const buffer = new ArrayBuffer(totalSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const now = new Date();
  bytes[0] = 0x03;
  bytes[1] = now.getFullYear() - 1900;
  bytes[2] = now.getMonth() + 1;
  bytes[3] = now.getDate();
  view.setUint32(4, numberRecords, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, recordSize, true);

  let o = 32;
  for (const field of fields) {
    bytes.set(padName(field.name), o);
    bytes[o + 11] = field.type.charCodeAt(0);
    bytes[o + 16] = field.length;
    bytes[o + 17] = field.decimals ?? 0;
    o += 32;
  }
  bytes[o] = 0x0d; // field descriptor terminator
  o += 1;

  for (const feature of features) {
    bytes[o] = 0x20; // not deleted
    o += 1;
    for (const field of fields) {
      const value = feature.properties[field.name] ?? null;
      const text = formatField(value, field);
      for (let index = 0; index < text.length; index++) bytes[o + index] = text.charCodeAt(index);
      o += field.length;
    }
  }
  bytes[o] = 0x1a; // EOF marker

  return bytes;
}

/**
 * Writes a single-layer Shapefile (polygon or polyline) as four in-memory
 * byte buffers. All features must share `opts.geometryType`; polygons follow
 * the shapefile ring-winding convention regardless of input winding (fixed
 * up automatically). WGS84 `.prj` matches R's `sf::st_write` output.
 */
export function writeShapefile(
  features: ShapefileFeatureInput[],
  options: WriteShapefileOptions
): ShapefileBytes {
  if (features.length === 0) {
    throw new ExportError("writeShapefile: cannot write a layer with zero features");
  }
  const shapeType = options.geometryType === "polygon" ? SHAPE_TYPE_POLYGON : SHAPE_TYPE_POLYLINE;
  const featureParts = features.map((f) => partsOf(options.geometryType, f.geometry));
  const { shp, shx } = writeShpAndShx(shapeType, featureParts);
  const dbf = writeDbf(features, options.fields);
  const prj = new TextEncoder().encode(WGS84_PRJ);
  return { shp, shx, dbf, prj };
}
