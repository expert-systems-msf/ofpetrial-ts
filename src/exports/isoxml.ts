// ISOXML (ISO 11783-10) TASKDATA.XML generator — task 7.3. BETA: see
// docs/isoxml-units.md for the DDI/unit mapping, sourcing, and known
// simplifications. Not validated against the official XSD (auth-gated on the
// AEF portal); the element/attribute shapes below are cross-checked against
// two independent public sources instead: the fetchable
// `ISO11783_TaskFile_V3-3.xsd` (isobus.net) and the actively-maintained
// `dev4Agriculture/isoxml-js` TypeScript implementation (its per-entity
// `ATTRIBUTES` tables for Partfield/Task/TreatmentZone/ProcessDataVariable/
// Polygon/LineString/Point/GuidanceGroup/GuidancePattern agree letter-for-
// letter with the XSD fetch). `Open-Agriculture/AgIsoStack-plus-plus` was
// also checked (per a reviewer suggestion) but turned out to implement ISO
// 11783-13 (the live TC-BUS device descriptor protocol: DVC/DET/DPD/DPT
// elements) rather than the ISOXML TASKDATA field/task/geometry side
// (PFD/TSK/TZN/PLN/LSG/PNT) needed here — its one embedded ISOXML sample
// (test/ddop_tests.cpp) confirms the shared
// `<ISO11783_TaskData VersionMajor=.. DataTransferOrigin=..>` root
// convention but has no PFD/TZN content to cross-check against. Actual
// conformance gate is task 7.5 (manual import on a real terminal/simulator);
// until then this format stays "beta" in the docs.
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
} from "geojson";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";
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
  /**
   * Exact field boundary. When omitted, derived as the @turf/union of every
   * geometry in the `plots` array passed to writeIsoxml (which already
   * merges plots + headlands — see trialDesignFeatures in
   * write-trial-files.ts). Emitted as a PLN (PolygonType 1, "Partfield
   * Boundary") directly under PFD, separate from the per-plot treatment-zone
   * PLNs nested under each TZN.
   */
  boundary?: Feature<Polygon | MultiPolygon>;
  /** Applicator AB line. When provided, emitted as a GPN (AB-line guidance pattern) under PFD's GGP. */
  abLine?: Feature<LineString | MultiLineString>;
  /** Harvester guidance lines. Each feature becomes its own GPN under the same GGP. */
  guidanceLines?: FeatureCollection;
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
      .replaceAll(CONTROL_CHARS_RE, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  );
}

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

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

/**
 * PLN (Polygon) element. `polygonType` per the PolygonType enumeration:
 * 1 = Partfield Boundary (direct PFD child), 2 = TreatmentZone (TZN child).
 * A MultiPolygon emits one PLN per component polygon, all sharing the type.
 */
function polygonToPln(geometry: Polygon | MultiPolygon, polygonType: 1 | 2): string {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .map((rings) => {
      const lsgs = rings
        .map((ring, index) => {
          const type = index === 0 ? 1 : 2; // 1=PolygonExterior, 2=PolygonInterior
          return `<LSG A="${type}">${ringToPnt(ring as Array<[number, number]>)}</LSG>`;
        })
        .join("");
      return `<PLN A="${polygonType}">${lsgs}</PLN>`;
    })
    .join("");
}

/**
 * Field boundary, used when IsoxmlOptions.boundary isn't supplied: the
 * @turf/union of every geometry in `plots` (already merges plots + headlands
 * — see trialDesignFeatures in write-trial-files.ts), dissolved to one
 * Polygon/MultiPolygon. @turf/union throws below 2 input geometries, so a
 * single plot's own geometry is the boundary as-is.
 */
function deriveBoundary(plots: IsoxmlPlotInput[]): Polygon | MultiPolygon {
  if (plots.length === 1) {
    return plots[0]!.geometry;
  }
  const fc = featureCollection<Polygon | MultiPolygon>(
    plots.map((p) => ({ type: "Feature" as const, properties: {}, geometry: p.geometry }))
  );
  const dissolved = union(fc);
  if (!dissolved) {
    throw new ExportError(
      "writeIsoxml: could not derive a field boundary from the plot geometries (union returned null)"
    );
  }
  return dissolved.geometry;
}

/** LSG (LineString) element: type 5 = Guidance Pattern, per LineStringType enumeration. */
function lineToLsg(coordinates: ReadonlyArray<readonly [number, number]>): string {
  return `<LSG A="5">${ringToPnt(coordinates)}</LSG>`;
}

/** Line parts of a (possibly multi-part) guidance geometry. */
function guidanceLineParts(
  geometry: LineString | MultiLineString
): Array<Array<[number, number]>> {
  return geometry.type === "LineString"
    ? [geometry.coordinates as Array<[number, number]>]
    : (geometry.coordinates as Array<Array<[number, number]>>);
}

/**
 * Guidance section: PFD > GGP (one group) > GPN (one for the applicator
 * ab-line, designated "ab-line", plus one per harvester guidanceLines
 * feature, designated "harvester-1", "harvester-2", ...). A multi-part
 * guidance geometry (an ab-line split by a hole/concavity, M2) becomes one
 * GPN per part, suffixed "-2", "-3", ... Omitted entirely when neither abLine
 * nor guidanceLines is supplied.
 */
function guidanceSectionXml(
  abLine: Feature<LineString | MultiLineString> | undefined,
  guidanceLines: FeatureCollection | undefined
): string {
  const gpns: string[] = [];
  // GPN (GuidancePattern) C="1" = AB Line, per GuidancePatternType enumeration.
  const pushGpns = (geometry: LineString | MultiLineString, baseDesignator: string): void => {
    const parts = guidanceLineParts(geometry);
    for (const [index, coordinates] of parts.entries()) {
      const designator = parts.length === 1 ? baseDesignator : `${baseDesignator}-${index + 1}`;
      gpns.push(
        `<GPN A="GPN${gpns.length + 1}" B="${escapeXml(designator)}" C="1">` +
          `${lineToLsg(coordinates)}</GPN>`
      );
    }
  };
  if (abLine) pushGpns(abLine.geometry, "ab-line");
  const harvesterFeatures = guidanceLines?.features ?? [];
  for (const [index, f] of harvesterFeatures.entries()) {
    pushGpns(f.geometry as LineString | MultiLineString, `harvester-${index + 1}`);
  }
  if (gpns.length === 0) return "";
  return `<GGP A="GGP1">${gpns.join("")}</GGP>`;
}

function polygonAreaM2(geometry: Polygon | MultiPolygon): number {
  // Shoelace on each ring, holes subtract, in degrees^2 scaled by a rough
  // meters-per-degree factor at the ring's own latitude — good enough for
  // the required-but-informational PartfieldArea attribute (sum of plot +
  // headland polygon areas, independent of the PFD boundary PLN geometry).
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const rings of polygons) {
    rings.forEach((ring, index) => {
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
      total += index === 0 ? area : -area;
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
export function writeIsoxml(plots: IsoxmlPlotInput[], options: IsoxmlOptions): Uint8Array {
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

  const tznXml = [...byRate]
    .map(([rate, group], index) => {
      const { ddiHex, raw } = rateToDdiValue(rate, options.unitSystem, options.rateUnit);
      const code = index + 1; // 0 reserved for "undefined zone"
      const plns = group.map((p) => polygonToPln(p.geometry, 2)).join("");
      return (
        `<TZN A="${code}" B="${escapeXml(`rate ${rate} ${options.rateUnit}`)}">` +
        `<PDV A="${ddiHex}" B="${raw}"/>${plns}</TZN>`
      );
    })
    .join("");

  const boundaryGeometry = options.boundary?.geometry ?? deriveBoundary(plots);
  const boundaryPln = polygonToPln(boundaryGeometry, 1);
  const guidanceXml = guidanceSectionXml(options.abLine, options.guidanceLines);

  const pfdId = "PFD1";
  const taskId = "TSK1";
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ISO11783_TaskData VersionMajor="4" VersionMinor="3" ` +
    `ManagementSoftwareManufacturer="ofpetrial-ts" ManagementSoftwareVersion="0.0.0" DataTransferOrigin="1">` +
    `<PFD A="${pfdId}" C="${escapeXml(options.inputName)}" D="${Math.round(totalArea)}">` +
    `${boundaryPln}${guidanceXml}</PFD>` +
    `<TSK A="${taskId}" B="${escapeXml(`${options.inputName} trial design`)}" E="${pfdId}" G="1">${tznXml}</TSK>` +
    `</ISO11783_TaskData>`;

  return new TextEncoder().encode(xml);
}
