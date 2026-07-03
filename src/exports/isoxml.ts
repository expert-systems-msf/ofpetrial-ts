// ISOXML (ISO 11783-10) TASKDATA.XML generator — task 7.3. BETA: see
// docs/isoxml-units.md for the DDI/unit mapping, sourcing, and known
// simplifications (no PFD boundary geometry, no guidance lines). Not
// validated against the official XSD (auth-gated on the AEF portal); the
// element/attribute shapes below are cross-checked against two independent
// public sources instead: the fetchable `ISO11783_TaskFile_V3-3.xsd`
// (isobus.net) and the actively-maintained `dev4Agriculture/isoxml-js`
// TypeScript implementation (its per-entity `ATTRIBUTES` tables for
// Partfield/Task/TreatmentZone/ProcessDataVariable/Polygon/LineString/Point
// agree letter-for-letter with the XSD fetch). `Open-Agriculture/
// AgIsoStack-plus-plus` was also checked (per a reviewer suggestion) but
// turned out to implement ISO 11783-13 (the live TC-BUS device descriptor
// protocol: DVC/DET/DPD/DPT elements) rather than the ISOXML TASKDATA
// field/task/geometry side (PFD/TSK/TZN/PLN/LSG/PNT) needed here — its one
// embedded ISOXML sample (test/ddop_tests.cpp) confirms the shared
// `<ISO11783_TaskData VersionMajor=.. DataTransferOrigin=..>` root
// convention but has no PFD/TZN content to cross-check against. Actual
// conformance gate is task 7.5 (manual import on a real terminal/simulator);
// until then this format stays "beta" in the docs.
import type { MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../types.js";

export interface IsoxmlPlotInput {
  geometry: Polygon | MultiPolygon;
  rate: number;
}

export interface IsoxmlOptions {
  inputName: string;
  unitSystem: "imperial" | "metric";
  /** RateInfo.unit, e.g. "seeds", "lb", "kg", "gallons", "liters". */
  rateUnit: string;
}

const ACRE_M2 = 4046.8564224;
const HECTARE_M2 = 10_000;

/** DDI (hex string per PDV.A, xs:hexBinary length 2) + unit conversion. See docs/isoxml-units.md. */
interface DdiMapping {
  ddiHex: string;
  /** rate-unit value -> DDI-declared SI unit (mg/m^2, mm^3/m^2 or count/m^2). */
  toDdiUnitPerM2: number;
  resolution: number;
}

const DDI_BY_UNIT: Record<string, DdiMapping> = {
  seeds: { ddiHex: "000B", toDdiUnitPerM2: 1, resolution: 0.001 },
  lb: { ddiHex: "0006", toDdiUnitPerM2: 453_592.37, resolution: 1 },
  kg: { ddiHex: "0006", toDdiUnitPerM2: 1_000_000, resolution: 1 },
  gallons: { ddiHex: "0001", toDdiUnitPerM2: 3_785_411.784, resolution: 0.01 },
  liters: { ddiHex: "0001", toDdiUnitPerM2: 1_000_000, resolution: 0.01 },
};

/** Converts one target rate to its ISOXML DDI raw integer value. Exported for the unit test in docs/isoxml-units.md's worked examples. */
export function rateToDdiValue(
  rate: number,
  unitSystem: "imperial" | "metric",
  rateUnit: string
): {
  ddiHex: string;
  raw: number;
} {
  const mapping = DDI_BY_UNIT[rateUnit];
  if (!mapping) {
    throw new ExportError(
      `No ISOXML DDI mapping for rate unit "${rateUnit}" (see docs/isoxml-units.md)`
    );
  }
  const areaM2 = unitSystem === "imperial" ? ACRE_M2 : HECTARE_M2;
  const perM2 = (rate * mapping.toDdiUnitPerM2) / areaM2;
  const raw = Math.round(perM2 / mapping.resolution);
  return { ddiHex: mapping.ddiHex, raw };
}

function escapeXml(value: string): string {
  return (
    value
      // XML 1.0 forbids C0 control characters except tab/LF/CR — strip them
      // rather than emit an unparseable document.
      .replace(CONTROL_CHARS_RE, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function ringToPnt(ring: ReadonlyArray<readonly [number, number]>): string {
  return ring
    .map(([lon, lat]) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new ExportError(`writeIsoxml: non-finite coordinate [${lon}, ${lat}]`);
      }
      return `<PNT A="2" C="${lat.toFixed(9)}" D="${lon.toFixed(9)}"/>`;
    })
    .join("");
}

/** PLN (Polygon) element: type 2 = TreatmentZone, per PolygonType enumeration. */
function plotToPln(geometry: Polygon | MultiPolygon): string {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .map((rings) => {
      const lsgs = rings
        .map((ring, i) => {
          const type = i === 0 ? 1 : 2; // 1=PolygonExterior, 2=PolygonInterior
          return `<LSG A="${type}">${ringToPnt(ring as Array<[number, number]>)}</LSG>`;
        })
        .join("");
      return `<PLN A="2">${lsgs}</PLN>`;
    })
    .join("");
}

function polygonAreaM2(geometry: Polygon | MultiPolygon): number {
  // Shoelace on each ring, holes subtract, in degrees^2 scaled by a rough
  // meters-per-degree factor at the ring's own latitude — good enough for
  // the required-but-informational PartfieldArea attribute (see
  // docs/isoxml-units.md: no field-boundary geometry is emitted in beta).
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const rings of polygons) {
    rings.forEach((ring, i) => {
      const r = ring as Array<[number, number]>;
      const lat0 = r[0]![1];
      const mPerDegLat = 111_320;
      const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
      let area = 0;
      for (let k = 0; k < r.length - 1; k++) {
        const [x1, y1] = r[k]!;
        const [x2, y2] = r[k + 1]!;
        area += x1 * mPerDegLon * (y2 * mPerDegLat) - x2 * mPerDegLon * (y1 * mPerDegLat);
      }
      area = Math.abs(area / 2);
      total += i === 0 ? area : -area;
    });
  }
  return Math.abs(total);
}

/**
 * Builds one TASKDATA.XML for a single input: one PFD (partfield), one TSK
 * referencing it, and one TZN per distinct rate value (grouping plots by
 * rate — see docs/isoxml-units.md on the 254-zone ceiling), each TZN holding
 * a PDV (the rate, as a DDI value) plus one PLN per plot sharing that rate.
 */
export function writeIsoxml(plots: IsoxmlPlotInput[], opts: IsoxmlOptions): Uint8Array {
  if (plots.length === 0) {
    throw new ExportError("writeIsoxml: cannot write a task with zero plots");
  }

  const byRate = new Map<number, IsoxmlPlotInput[]>();
  for (const plot of plots) {
    const group = byRate.get(plot.rate);
    if (group) group.push(plot);
    else byRate.set(plot.rate, [plot]);
  }
  // TreatmentZoneCode (TZN.A) is an xs:unsignedByte capped at 254 (not 255 —
  // confirmed against isoxml-js's TreatmentZone ATTRIBUTES.A.maxValue), and
  // code 0 is reserved here (not by the XSD itself) as a conservative
  // "undefined zone" convention, leaving 254 usable codes.
  if (byRate.size > 254) {
    throw new ExportError(
      `writeIsoxml: ${byRate.size} distinct rates exceed the 254 usable TreatmentZoneCode values (xs:unsignedByte, max 254, 0 reserved)`
    );
  }

  const totalArea = plots.reduce((sum, p) => sum + polygonAreaM2(p.geometry), 0);

  const tznXml = [...byRate.entries()]
    .map(([rate, group], i) => {
      const { ddiHex, raw } = rateToDdiValue(rate, opts.unitSystem, opts.rateUnit);
      const code = i + 1; // 0 reserved for "undefined zone"
      const plns = group.map((p) => plotToPln(p.geometry)).join("");
      return (
        `<TZN A="${code}" B="${escapeXml(`rate ${rate} ${opts.rateUnit}`)}">` +
        `<PDV A="${ddiHex}" B="${raw}"/>${plns}</TZN>`
      );
    })
    .join("");

  const pfdId = "PFD1";
  const taskId = "TSK1";
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ISO11783_TaskData VersionMajor="4" VersionMinor="3" ` +
    `ManagementSoftwareManufacturer="ofpetrial-ts" ManagementSoftwareVersion="0.0.0" DataTransferOrigin="1">` +
    `<PFD A="${pfdId}" C="${escapeXml(opts.inputName)}" D="${Math.round(totalArea)}"/>` +
    `<TSK A="${taskId}" B="${escapeXml(`${opts.inputName} trial design`)}" E="${pfdId}" G="1">${tznXml}</TSK>` +
    `</ISO11783_TaskData>`;

  return new TextEncoder().encode(xml);
}
