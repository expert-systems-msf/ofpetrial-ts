// Minimal independent Shapefile/DBF reader for the export test suite (tasks
// 7.1/7.4). Deliberately NOT shared with src/exports/shapefile.ts — the
// whole point of "independent relecture" (design.md D8) is that a bug in
// the writer's encoding of a field wouldn't also be present, unnoticed, in
// the code that reads it back for the tests.
export interface ReadShpFeature {
  /** Each part is one ring/line, as an array of [x, y] pairs. */
  parts: Array<Array<[number, number]>>;
}

export interface ReadShpResult {
  shapeType: number;
  /** Big-endian magic at offset 0 — must be 9994 per the ESRI spec. */
  fileCode: number;
  /** Big-endian file length at offset 24, in 16-bit words (bytes / 2). */
  fileLengthWords: number;
  /** Dataset bounding box from the 100-byte header (little-endian doubles). */
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number };
  features: ReadShpFeature[];
}

export interface ShpHeader {
  fileCode: number;
  fileLengthWords: number;
  shapeType: number;
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number };
}

/** Reads only the 100-byte fixed header — shared layout between .shp and .shx. */
export function readShpHeader(bytes: Uint8Array): ShpHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    fileCode: view.getInt32(0, false),
    fileLengthWords: view.getInt32(24, false),
    shapeType: view.getInt32(32, true),
    bbox: {
      xMin: view.getFloat64(36, true),
      yMin: view.getFloat64(44, true),
      xMax: view.getFloat64(52, true),
      yMax: view.getFloat64(60, true),
    },
  };
}

export function readShp(bytes: Uint8Array): ReadShpResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { fileCode, fileLengthWords, bbox } = readShpHeader(bytes);
  const shapeType = view.getInt32(32, true);
  const features: ReadShpFeature[] = [];
  let offset = 100;
  while (offset < bytes.length) {
    const contentLengthWords = view.getInt32(offset + 4, false);
    const contentStart = offset + 8;
    const recShapeType = view.getInt32(contentStart, true);
    if (recShapeType === 0) {
      // Null shape record: no geometry.
      features.push({ parts: [] });
    } else {
      let o = contentStart + 4 + 32; // skip shapeType + bbox
      const numberParts = view.getInt32(o, true);
      o += 4;
      const numberPoints = view.getInt32(o, true);
      o += 4;
      const partStarts: number[] = [];
      for (let index = 0; index < numberParts; index++) {
        partStarts.push(view.getInt32(o, true));
        o += 4;
      }
      const points: Array<[number, number]> = [];
      for (let index = 0; index < numberPoints; index++) {
        const x = view.getFloat64(o, true);
        const y = view.getFloat64(o + 8, true);
        points.push([x, y]);
        o += 16;
      }
      const parts: Array<Array<[number, number]>> = partStarts.map((start, index) => {
        const end = index + 1 < partStarts.length ? partStarts[index + 1]! : numberPoints;
        return points.slice(start, end);
      });
      features.push({ parts });
    }
    offset = contentStart + contentLengthWords * 2;
  }
  return { shapeType, fileCode, fileLengthWords, bbox, features };
}

export interface DbfFieldDef {
  name: string;
  type: string;
  length: number;
  decimals: number;
}

export interface ReadDbfResult {
  fields: DbfFieldDef[];
  records: Array<Record<string, number | string | null>>;
}

export function readDbf(bytes: Uint8Array): ReadDbfResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numberRecords = view.getUint32(4, true);
  const headerSize = view.getUint16(8, true);
  const recordSize = view.getUint16(10, true);

  const fields: DbfFieldDef[] = [];
  let o = 32;
  while (bytes[o] !== 0x0d) {
    let nameEnd = o;
    while (nameEnd < o + 11 && bytes[nameEnd] !== 0) nameEnd++;
    const name = new TextDecoder().decode(bytes.slice(o, nameEnd));
    const type = String.fromCharCode(bytes[o + 11]!);
    const length = bytes[o + 16]!;
    const decimals = bytes[o + 17]!;
    fields.push({ name, type, length, decimals });
    o += 32;
  }

  const records: Array<Record<string, number | string | null>> = [];
  let recOffset = headerSize;
  for (let r = 0; r < numberRecords; r++) {
    let fieldOffset = recOffset + 1; // skip deletion flag
    const record: Record<string, number | string | null> = {};
    for (const field of fields) {
      const raw = new TextDecoder().decode(bytes.slice(fieldOffset, fieldOffset + field.length));
      if (field.type === "C") {
        record[field.name] = raw.replace(/\s+$/, "");
      } else if (/^\*+$/.test(raw)) {
        record[field.name] = null;
      } else {
        // L17: this is the independent DBF re-reader (design.md D8). Parse
        // strictly so a malformed numeric field ("NaN"/"Infinity"/"1e+21"/
        // "0x10"/"") is rejected rather than silently coerced by Number() —
        // otherwise it would round-trip the L5 writer bug undetected.
        const trimmed = raw.trim();
        if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
          throw new Error(
            `readDbf: field "${field.name}" is not a plain DBF numeric: ${JSON.stringify(raw)}`
          );
        }
        record[field.name] = Number(trimmed);
      }
      fieldOffset += field.length;
    }
    records.push(record);
    recOffset += recordSize;
  }

  return { fields, records };
}
