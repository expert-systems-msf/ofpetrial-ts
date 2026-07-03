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
  features: ReadShpFeature[];
}

export function readShp(bytes: Uint8Array): ReadShpResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
      const numParts = view.getInt32(o, true);
      o += 4;
      const numPoints = view.getInt32(o, true);
      o += 4;
      const partStarts: number[] = [];
      for (let i = 0; i < numParts; i++) {
        partStarts.push(view.getInt32(o, true));
        o += 4;
      }
      const points: Array<[number, number]> = [];
      for (let i = 0; i < numPoints; i++) {
        const x = view.getFloat64(o, true);
        const y = view.getFloat64(o + 8, true);
        points.push([x, y]);
        o += 16;
      }
      const parts: Array<Array<[number, number]>> = partStarts.map((start, i) => {
        const end = i + 1 < partStarts.length ? partStarts[i + 1]! : numPoints;
        return points.slice(start, end);
      });
      features.push({ parts });
    }
    offset = contentStart + contentLengthWords * 2;
  }
  return { shapeType, features };
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
  const numRecords = view.getUint32(4, true);
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
  for (let r = 0; r < numRecords; r++) {
    let fieldOffset = recOffset + 1; // skip deletion flag
    const record: Record<string, number | string | null> = {};
    for (const field of fields) {
      const raw = new TextDecoder().decode(bytes.slice(fieldOffset, fieldOffset + field.length));
      if (field.type === "C") {
        record[field.name] = raw.replace(/\s+$/, "");
      } else if (/^\*+$/.test(raw)) {
        record[field.name] = null;
      } else {
        record[field.name] = Number(raw.trim());
      }
      fieldOffset += field.length;
    }
    records.push(record);
    recOffset += recordSize;
  }

  return { fields, records };
}
