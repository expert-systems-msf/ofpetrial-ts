// Plot layout — port of R make_exp_plots() and its spatial helpers
// (ofpetrial 0.1.3, R/make_exp_plots.R and R/utility_spatial.R).
//
// Coordinate strategy (design.md D2): the boundary and ab-line are projected
// once into a shared UTM zone (EPSG from the boundary centroid, mirroring R's
// st_transform_utm), the whole construction happens in that plane, and every
// output is reprojected to WGS84. Internally the math lives in the ab-line
// frame: u = P · ab_xy_nml (along the machine direction), v = P · ab_xy_nml_p90
// (across it). R's strips are axis-aligned rectangles in that frame, and each
// strip's "through line" is exactly its center line, so R's cascade of
// st_intersection(strips, eroded field) followed by
// st_intersection(piece, through_line) collapses to exact horizontal scanline
// intersections: segment set = center line ∩ eroded field. The dissolve and
// headland steps use @turf/union / @turf/difference — wrappers over the same
// polygon-clipping engine that powers @turf/intersect (design.md D2's
// clipping constraint), never polygon-clipping directly.
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import difference from "@turf/difference";
import union from "@turf/union";
import unkinkPolygon from "@turf/unkink-polygon";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import { toUtm, toWgs, utmEpsg } from "./projection.js";
import { roundHalfEven } from "./trial-setup.js";
import { GeometryError, ValidationError } from "./types.js";
import type { ExpData, InputLayout, PlotInfo } from "./types.js";

type Pt = [number, number];
type Ring = Pt[]; // closed: first point === last point
type Interval = [number, number];

// !===========================================================
// ! Planar ring / interval primitives
// !===========================================================

/** Shoelace signed area of a closed ring (positive = counter-clockwise). */
function signedRingArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Area centroid of a closed ring (undefined for degenerate rings). */
function ringCentroid(ring: Ring): { area: number; cx: number; cy: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    const w = x1 * y2 - x2 * y1;
    a += w;
    cx += (x1 + x2) * w;
    cy += (y1 + y2) * w;
  }
  a /= 2;
  return { area: a, cx: cx / (6 * a), cy: cy / (6 * a) };
}

/** Drops consecutive duplicate points and guarantees ring closure. */
function cleanRing(ring: Pt[]): Ring | null {
  const out: Pt[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) {
      out.push([p[0], p[1]]);
    }
  }
  if (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first[0] - last[0]) <= 1e-12 && Math.abs(first[1] - last[1]) <= 1e-12) {
      out.pop();
    }
  }
  if (out.length < 3) return null;
  out.push([out[0]![0], out[0]![1]]);
  return out;
}

/** Sorted merge of possibly overlapping intervals. */
function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    const last = out[out.length - 1]!;
    if (s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** base minus subtrahend, both merged interval lists. */
function subtractIntervals(base: Interval[], minus: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [bs, be] of base) {
    let cursor = bs;
    for (const [ms, me] of minus) {
      if (me <= cursor || ms >= be) continue;
      if (ms > cursor) out.push([cursor, ms]);
      cursor = Math.max(cursor, me);
      if (cursor >= be) break;
    }
    if (cursor < be) out.push([cursor, be]);
  }
  return out;
}

/**
 * Even-odd scanline: interior intervals of a set of simple closed rings cut
 * by the horizontal line v = const. Rings must be individually simple; the
 * union across rings is merged afterwards by the callers.
 */
function ringIntervalsAt(ring: Ring, v: number): Interval[] {
  const xs: number[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    if (y1 > v !== y2 > v) {
      xs.push(x1 + ((v - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  // A simple ring always crosses a horizontal line an even number of times;
  // an odd count means a kinked/degenerate ring slipped through repair.
  if (xs.length % 2 !== 0) {
    throw new GeometryError(
      `odd crossing count (${xs.length}) at v=${v}: ring is not simple after repair`,
    );
  }
  xs.sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i]!, xs[i + 1]!]);
  return out;
}

function ringsIntervalsAt(rings: Ring[], v: number): Interval[] {
  const all: Interval[] = [];
  for (const ring of rings) all.push(...ringIntervalsAt(ring, v));
  return mergeIntervals(all);
}

/** Minimum distance from a point to any segment of the given rings. */
function distToRings(pt: Pt, rings: Ring[]): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[i + 1]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt[0] - x1) * dx + (pt[1] - y1) * dy) / len2));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      best = Math.min(best, Math.hypot(pt[0] - px, pt[1] - py));
    }
  }
  return best;
}

function ringToPolygonFeature(ring: Ring): Feature<Polygon> {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

/**
 * A point strictly inside a simple closed ring. Fast paths (vertex mean,
 * diagonal midpoints) first; guaranteed fallback via the scanline midpoint
 * at the ring's median height, which exists for every simple ring.
 */
function samplePointInRing(ring: Ring): Pt | null {
  const poly = ringToPolygonFeature(ring);
  let sx = 0;
  let sy = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    sx += ring[i]![0];
    sy += ring[i]![1];
  }
  const mean: Pt = [sx / n, sy / n];
  if (booleanPointInPolygon(mean, poly)) return mean;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 2) % n]!;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (booleanPointInPolygon(mid, poly)) return mid;
  }
  // Guaranteed interior point: midpoint of the widest interior interval at
  // the median vertex height (nudged off exact vertex heights).
  const ys = ring.slice(0, n).map((p) => p[1]).sort((a, b) => a - b);
  const yMid = ys[Math.floor(n / 2)]!;
  for (const v of [yMid + 1e-9, yMid - 1e-9, (ys[0]! + ys[n - 1]!) / 2]) {
    const intervals = ringIntervalsAt(ring, v);
    if (intervals.length > 0) {
      const widest = intervals.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
      return [(widest[0] + widest[1]) / 2, v];
    }
  }
  return null;
}

// !===========================================================
// ! Ring offsetting (st_buffer equivalent for our two uses)
// !===========================================================

/**
 * Offsets a simple closed CCW ring by a signed distance (positive = outward,
 * negative = inward). Follows GEOS buffer semantics: round joins (arcs) where
 * the offset opens a gap at a vertex, plain line intersections where it
 * closes one. Arc discretization matches sf's st_buffer default of
 * nQuadSegs = 30.
 */
function offsetRingRound(ring: Ring, dist: number): Ring | null {
  const pts = ring.slice(0, -1);
  const n = pts.length;
  if (n < 3) return null;
  const out: Pt[] = [];
  const arcStep = Math.PI / 2 / 30;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const d1: Pt = [cur[0] - prev[0], cur[1] - prev[1]];
    const d2: Pt = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(d1[0], d1[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    if (l1 === 0 || l2 === 0) continue;
    const t1: Pt = [d1[0] / l1, d1[1] / l1];
    const t2: Pt = [d2[0] / l2, d2[1] / l2];
    // right normal of a CCW ring points outward
    const n1: Pt = [t1[1], -t1[0]];
    const n2: Pt = [t2[1], -t2[0]];
    const a: Pt = [cur[0] + dist * n1[0], cur[1] + dist * n1[1]];
    const b: Pt = [cur[0] + dist * n2[0], cur[1] + dist * n2[1]];
    const cross = t1[0] * t2[1] - t1[1] * t2[0];
    if (Math.abs(cross) < 1e-9) {
      out.push(a);
    } else if (cross * dist > 0) {
      // the offset edges diverge here: round join around the vertex
      const a1 = Math.atan2(a[1] - cur[1], a[0] - cur[0]);
      const a2 = Math.atan2(b[1] - cur[1], b[0] - cur[0]);
      let delta = a2 - a1;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / arcStep));
      const r = Math.abs(dist);
      for (let j = 0; j <= steps; j++) {
        const ang = a1 + (delta * j) / steps;
        out.push([cur[0] + r * Math.cos(ang), cur[1] + r * Math.sin(ang)]);
      }
    } else {
      // the offset edges cross: their intersection is the new vertex
      const t = ((b[0] - a[0]) * t2[1] - (b[1] - a[1]) * t2[0]) / cross;
      out.push([a[0] + t * t1[0], a[1] + t * t1[1]]);
    }
  }
  if (out.length < 3) return null;
  out.push([out[0]![0], out[0]![1]]);
  return cleanRing(out);
}

/** Splits a possibly self-intersecting offset ring into simple pieces. */
function unkinkRing(ring: Ring): Ring[] {
  let features: Array<Feature<Polygon>>;
  try {
    features = unkinkPolygon(ringToPolygonFeature(ring)).features;
  } catch (e) {
    // never let a still-kinked ring flow into the scanline silently
    throw new GeometryError(
      `unkink failed on an offset ring (${ring.length - 1} vertices): ${String(e)}`,
    );
  }
  const out: Ring[] = [];
  for (const f of features) {
    const cleaned = cleanRing(f.geometry.coordinates[0]!.map((p) => [p[0]!, p[1]!] as Pt));
    if (cleaned && Math.abs(signedRingArea(cleaned)) > 1e-6) out.push(cleaned);
  }
  return out;
}

/** Rewinds a ring to counter-clockwise orientation. */
function toCcw(ring: Ring): Ring {
  return signedRingArea(ring) >= 0 ? ring : [...ring].reverse();
}

/**
 * Shrinks a CCW ring inward by `dist` and keeps only the pieces that truly
 * belong to the eroded region (interior sample point at depth >= dist from
 * the original ring) — this discards the inverted loops a plain offset
 * produces where the shape is narrower than 2 * dist.
 */
function shrinkRing(ring: Ring, dist: number): Ring[] {
  const raw = offsetRingRound(ring, -dist);
  if (!raw) return [];
  const out: Ring[] = [];
  for (const piece of unkinkRing(raw)) {
    const pt = samplePointInRing(piece);
    if (pt && distToRings(pt, [ring]) >= dist - 0.01) out.push(toCcw(piece));
  }
  return out;
}

/** Grows a CCW ring outward by `dist`, keeping the dominant piece. */
function growRing(ring: Ring, dist: number): Ring[] {
  const raw = offsetRingRound(ring, dist);
  if (!raw) return [];
  const pieces = unkinkRing(raw);
  if (pieces.length <= 1) return pieces.map(toCcw);
  let best = pieces[0]!;
  for (const p of pieces) {
    if (Math.abs(signedRingArea(p)) > Math.abs(signedRingArea(best))) best = p;
  }
  return [toCcw(best)];
}

// !===========================================================
// ! Field model in the ab-line frame
// !===========================================================

interface FramePolygon {
  shell: Ring; // CCW in frame coordinates
  holes: Ring[]; // CCW in frame coordinates (orientation normalized on ingest)
}

/**
 * A region described by positive rings minus negative rings; the scanline of
 * the region at v is intervals(shells) - intervals(holes). Used for the
 * original field, its erosion, and its dilation.
 */
interface RingRegion {
  shells: Ring[];
  holes: Ring[];
}

function regionIntervalsAt(region: RingRegion, v: number): Interval[] {
  return subtractIntervals(ringsIntervalsAt(region.shells, v), ringsIntervalsAt(region.holes, v));
}

interface FieldFrame {
  polys: FramePolygon[];
  region: RingRegion;
  vMin: number;
  vMax: number;
  /** Area centroid of the field, frame coordinates. */
  centroidV: number;
  /** R: sqrt(diff(xy bbox)^2 sums) — the XY (not frame) bbox diagonal. */
  bboxDiag: number;
}

/**
 * R st_buffer(field, -dist) as far as the scanline needs it: shells shrink,
 * holes grow, and hole overflow is resolved by the 1-D interval subtraction.
 */
function erodeField(field: FieldFrame, dist: number): RingRegion {
  const shells: Ring[] = [];
  const holes: Ring[] = [];
  for (const poly of field.polys) {
    shells.push(...shrinkRing(poly.shell, dist));
    for (const hole of poly.holes) holes.push(...growRing(hole, dist));
  }
  return { shells, holes };
}

/** R st_buffer(field, +dist): shells grow, holes shrink (and may vanish). */
function dilateField(field: FieldFrame, dist: number): RingRegion {
  const shells: Ring[] = [];
  const holes: Ring[] = [];
  for (const poly of field.polys) {
    shells.push(...growRing(poly.shell, dist));
    for (const hole of poly.holes) holes.push(...shrinkRing(hole, dist));
  }
  return { shells, holes };
}

// !===========================================================
// ! Input normalization and repair
// !===========================================================

function collectPolygonFeatures(
  input: Feature<Polygon | MultiPolygon> | FeatureCollection,
): Array<Position[][]> {
  const features = input.type === "FeatureCollection" ? input.features : [input];
  const polys: Array<Position[][]> = [];
  for (const f of features) {
    const geom: Geometry | null = f.geometry;
    if (!geom) continue;
    // R drops LINESTRING rows from the boundary layer and keeps polygons
    if (geom.type === "Polygon") polys.push(geom.coordinates);
    else if (geom.type === "MultiPolygon") polys.push(...geom.coordinates);
  }
  return polys;
}

/** Whether any two non-adjacent ring segments properly intersect. */
function ringIsSimple(ring: Ring): boolean {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[i + 1]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closure
      const [cx, cy] = ring[j]!;
      const [dx, dy] = ring[j + 1]!;
      const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
      const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return false;
      }
    }
  }
  return true;
}

/** Unkinks a single self-intersecting ring into simple rings. */
function unkinkSingleRing(ring: Ring): Ring[] {
  let features: Array<Feature<Polygon>>;
  try {
    features = unkinkPolygon(ringToPolygonFeature(ring)).features;
  } catch {
    throw new GeometryError(
      "The field boundary is invalid and could not be repaired (self-intersections persist after unkinking).",
    );
  }
  const out: Ring[] = [];
  for (const f of features) {
    const cleaned = cleanRing(f.geometry.coordinates[0]!.map((p) => [p[0]!, p[1]!] as Pt));
    if (cleaned && Math.abs(signedRingArea(cleaned)) > 0) out.push(cleaned);
  }
  return out;
}

/**
 * st_make_valid equivalent (design.md D2): duplicate-vertex cleanup, ring
 * closure, removal of degenerate rings, and unkinking of self-intersecting
 * rings via @turf/unkink-polygon. Unkinking runs per ring (turf's
 * unkinkPolygon splits a valid polygon-with-holes into separate positive
 * polygons, which would turn holes into field area); when the shell had to be
 * split, each hole is reattached to the shell piece that contains it. Throws
 * GeometryError when nothing usable remains.
 */
function repairBoundary(polys: Array<Position[][]>): Array<Position[][]> {
  const repaired: Array<Position[][]> = [];
  for (const rings of polys) {
    const shellIn = rings[0];
    if (!shellIn) continue;
    const shell = cleanRing(shellIn.map((p) => [p[0]!, p[1]!] as Pt));
    if (!shell) continue; // shell collapsed
    const holes: Ring[] = [];
    for (const ring of rings.slice(1)) {
      const hole = cleanRing(ring.map((p) => [p[0]!, p[1]!] as Pt));
      if (!hole) continue;
      if (ringIsSimple(hole)) {
        if (Math.abs(signedRingArea(hole)) > 0) holes.push(hole);
      } else {
        holes.push(...unkinkSingleRing(hole));
      }
    }
    if (ringIsSimple(shell)) {
      // note: a self-intersecting ring can have zero *signed* area (its lobes
      // cancel), so the degeneracy test only applies to simple rings
      if (Math.abs(signedRingArea(shell)) === 0) continue;
      repaired.push([shell, ...holes]);
      continue;
    }
    const shellPieces = unkinkSingleRing(shell);
    for (const piece of shellPieces) {
      const pieceFeature = ringToPolygonFeature(piece);
      const contained = holes.filter((hole) => {
        const pt = samplePointInRing(hole);
        return pt !== null && booleanPointInPolygon(pt, pieceFeature);
      });
      repaired.push([piece, ...contained]);
    }
  }
  if (repaired.length === 0) {
    throw new GeometryError(
      "The field boundary is empty or degenerate after repair; cannot lay out experiment plots.",
    );
  }
  return repaired;
}

function extractAbLine(
  input: Feature<LineString> | FeatureCollection | undefined,
  ablineType: string,
): [Position, Position] {
  const missing = (): never => {
    throw new ValidationError(
      ablineType === "lock"
        ? 'ablineType "lock" requires an ab-line, but none was provided.'
        : "An ab-line (GeoJSON LineString) is required by makeExpPlots.",
    );
  };
  if (!input) missing();
  const features = input!.type === "FeatureCollection" ? input!.features : [input!];
  // R: ab_sf[1, ] — only the first line is used when several are supplied
  for (const f of features) {
    if (f.geometry?.type === "LineString") {
      const coords = f.geometry.coordinates;
      if (coords.length >= 2) return [coords[0]!, coords[1]!];
    }
  }
  return missing();
}

// !===========================================================
// ! Trial plots per input (R: make_trial_plots_by_input)
// !===========================================================

interface FramePlot {
  plotId: number;
  u0: number;
  u1: number;
  polyLine: string;
}

interface StripPlots {
  stripId: number;
  vc: number;
  plots: FramePlot[];
}

/** R get_trial_plot_data: divide a strip's usable length into plot lengths. */
function trialPlotLengths(tot: number, minLen: number, maxLen: number): number[] {
  const numPlots = Math.floor(tot / minLen);
  if (numPlots < 1) return [];
  const remainder = tot - numPlots * minLen;
  const additional = remainder / numPlots;
  const len = additional + minLen > maxLen ? maxLen : minLen + additional;
  return Array.from({ length: numPlots }, () => len);
}

interface MakeTrialPlotsParams {
  field: FieldFrame;
  /** v of the (possibly shifted) plot heading in the ab-line frame. */
  anchorV: number;
  plotInfo: PlotInfo;
  /** Only "lock" is distinguished here — "free" and "non" build the same grid. */
  ablineType: "free" | "lock" | "non";
  secondInput: boolean;
}

/**
 * R make_trial_plots_by_input. The R version builds a strip grid anchored on
 * the field centroid, finds the strip crossing the plot heading, and shifts
 * the whole grid so that strip's center line coincides with the heading
 * (edge-aligns it for a second input, half-section-shifts it for "lock").
 * After the shift the grid is fully determined by the heading's v — except
 * for the second-input edge-side sign, which depends on the pre-shift grid
 * phase and is reproduced below.
 */
function makeTrialPlotsByInput(params: MakeTrialPlotsParams): StripPlots[] {
  const { field, anchorV, plotInfo, ablineType, secondInput } = params;
  const pw = plotInfo.plot_width;
  const halfW = pw / 2;
  const radius = field.bboxDiag / 2 + 100;

  // pre-shift grid phase (R create_strips): strip i spans
  // [v0 - i * pw, v0 - (i - 1) * pw] with v0 = centroid v + 2 * radius
  let gridShift = 0;
  if (secondInput) {
    const v0 = field.centroidV + 2 * radius;
    const intersecting = Math.ceil((v0 - anchorV) / pw);
    const cInt = v0 - intersecting * pw + halfW;
    const delta = anchorV - cInt;
    // R: aligns the strip edge (not center) with the heading, on the side
    // the correction shift pointed to
    gridShift = delta < 0 ? -halfW : halfW;
  } else if (ablineType === "lock") {
    const sectionWidth = plotInfo.section_width;
    const numSectionsInPlot = roundHalfEven(pw / sectionWidth);
    const machineOdd = plotInfo.section_num % 2 === 1;
    const plotOdd = numSectionsInPlot % 2 === 1;
    if (machineOdd !== plotOdd) gridShift = sectionWidth / 2;
  }
  const baseV = anchorV + gridShift; // strip centers sit at baseV + k * pw

  const inner = plotInfo.side_length + halfW;
  const eroded = erodeField(field, inner);
  const dAdj = plotInfo.headland_length - inner;

  // strips in R group order: descending v
  const kHiRaw = Math.floor((field.vMax + halfW - baseV) / pw);
  const kHi = baseV + kHiRaw * pw - halfW < field.vMax ? kHiRaw : kHiRaw - 1;
  const kLoRaw = Math.ceil((field.vMin - halfW - baseV) / pw);
  const kLo = baseV + kLoRaw * pw + halfW > field.vMin ? kLoRaw : kLoRaw + 1;

  const strips: StripPlots[] = [];
  for (let k = kHi; k >= kLo; k--) {
    const vc = baseV + k * pw;
    const plots: FramePlot[] = [];
    let segIdx = 0;
    for (const [s0, s1] of regionIntervalsAt(eroded, vc)) {
      // R extend_or_shorten_line: trim (or extend, when dAdj < 0) both ends
      if (s1 - s0 <= 2 * dAdj) continue;
      const u0 = s0 + dAdj;
      const lengths = trialPlotLengths(s1 - s0 - 2 * dAdj, plotInfo.min_plot_length, plotInfo.max_plot_length);
      if (lengths.length === 0) continue;
      segIdx++;
      let start = u0;
      lengths.forEach((len, j) => {
        plots.push({ plotId: j + 1, u0: start, u1: start + len, polyLine: `${segIdx}_1` });
        start += len;
      });
    }
    if (plots.length > 0) {
      strips.push({ stripId: strips.length + 1, vc, plots });
    }
  }
  if (strips.length === 0) {
    throw new GeometryError(
      "No experiment plots fit inside the field boundary with the given plot dimensions.",
    );
  }
  return strips;
}

// !===========================================================
// ! Ab-lines (R: make_ablines_data / make_ablines / make_plot_edge_line)
// !===========================================================

interface AblineRow {
  abId: 1 | 2;
  dirP: -1 | 1;
  /** v of the candidate line (center of the first plot of the first/last strip). */
  v: number;
  /** u of that plot's centroid — the through line spans u ± abLength. */
  u: number;
  /** R int_check: does the line shifted by dirP * 5 * pw still hit the plots? */
  intCheck: boolean;
}

/**
 * R make_ablines_data. Row order matters (R slices the first matching row):
 * expand.grid varies dir_p fastest, so rows come as
 * (ab1, -1), (ab1, +1), (ab2, -1), (ab2, +1).
 */
function makeAblinesData(strips: StripPlots[], plotWidth: number): AblineRow[] {
  const firstOf = (strip: StripPlots): FramePlot => strip.plots.find((p) => p.plotId === 1) ?? strip.plots[0]!;
  const first = strips[0]!;
  const last = strips[strips.length - 1]!;
  const candidates: Array<{ abId: 1 | 2; v: number; u: number }> = [
    { abId: 1, v: first.vc, u: (firstOf(first).u0 + firstOf(first).u1) / 2 },
    { abId: 2, v: last.vc, u: (firstOf(last).u0 + firstOf(last).u1) / 2 },
  ];
  const halfW = plotWidth / 2;
  const rows: AblineRow[] = [];
  for (const { abId, v, u } of candidates) {
    for (const dirP of [-1, 1] as const) {
      const shifted = v + dirP * 5 * plotWidth;
      const intCheck = strips.some((s) => Math.abs(shifted - s.vc) <= halfW);
      rows.push({ abId, dirP, v, u, intCheck });
    }
  }
  return rows;
}

interface AblineGeometry {
  v: number;
  u: number;
}

/**
 * R make_ablines, "free" branch (the "lock" branch is handled by the caller,
 * which returns the extended input ab-line unchanged). Picks the candidate
 * line and re-centers it by half the machine/plot width difference.
 */
function chooseFreeAbline(
  rows: AblineRow[],
  machineWidth: number,
  plotWidth: number,
): AblineGeometry {
  if (machineWidth === plotWidth) {
    const row = rows.find((r) => r.abId === 1)!;
    return { v: row.v, u: row.u };
  }
  const wanted = machineWidth > plotWidth;
  const row = rows.find((r) => r.intCheck === wanted);
  if (!row) {
    throw new GeometryError(
      "Could not orient the ab-line: too few strips to run the direction check.",
    );
  }
  return { v: row.v + (row.dirP * Math.abs(machineWidth - plotWidth)) / 2, u: row.u };
}

/** R make_plot_edge_line: first row whose direction check leaves the field. */
function plotEdgeLine(rows: AblineRow[], plotWidth: number): AblineGeometry {
  const row = rows.find((r) => !r.intCheck);
  if (!row) {
    throw new GeometryError("Could not derive the plot edge line for the second input.");
  }
  return { v: row.v + (row.dirP * plotWidth) / 2, u: row.u };
}

// !===========================================================
// ! prepare_ablines (v shift when the ab-line misses the field)
// !===========================================================

/**
 * R prepare_ablines: when the (extended) heading line does not intersect the
 * field, shift it laterally by a whole number of plot widths toward the field
 * centroid. Only the line's v matters downstream.
 */
function prepareAblineV(
  field: FieldFrame,
  vLine: number,
  uRange: Interval,
  plotWidth: number,
): number {
  const intervals = regionIntervalsAt(field.region, vLine);
  const intersects = intervals.some(([a, b]) => a <= uRange[1] && b >= uRange[0]);
  if (intersects) return vLine;
  return vLine + roundHalfEven((field.centroidV - vLine) / plotWidth) * plotWidth;
}

// !===========================================================
// ! makeExpPlots
// !===========================================================

export interface MakeExpPlotsOptions {
  inputPlotInfo: PlotInfo | PlotInfo[];
  boundary: Feature<Polygon | MultiPolygon> | FeatureCollection;
  abLine: Feature<LineString> | FeatureCollection;
  /** One of "free", "lock", "non" — matches R's abline_type. Default "free". */
  ablineType?: "free" | "lock" | "non";
}

/**
 * Port of R `make_exp_plots`: lays experiment strips/plots inside the field
 * boundary along the ab-line, and derives the applicator ab-line, harvester
 * guidance line and headlands for each input. All outputs are WGS84.
 *
 * Deviation: R's `make_ablines` returns `NULL` for the per-input ab-line when
 * `abline_type == "non"` (harvester guidance is unaffected — R always builds
 * it with the "free" branch regardless of the outer type). The public
 * `InputLayout.abLine` field is a non-nullable `Feature`, so "non" falls
 * through to the same "free" computation as a documented best-effort
 * fallback instead of a null/absent value.
 */
export function makeExpPlots(options: MakeExpPlotsOptions): ExpData {
  const ablineType = options.ablineType ?? "free";
  if (ablineType !== "free" && ablineType !== "lock" && ablineType !== "non") {
    throw new ValidationError(`ablineType must be "free", "lock", or "non", got ${JSON.stringify(ablineType)}.`);
  }

  // ! Check and modify input_plot_info if necessary (R lines 45-61)
  const infosIn = Array.isArray(options.inputPlotInfo) ? options.inputPlotInfo : [options.inputPlotInfo];
  if (infosIn.length === 0 || infosIn.length > 2) {
    throw new ValidationError(`makeExpPlots supports one or two inputs, got ${infosIn.length}.`);
  }
  if (infosIn.length === 2) {
    for (const key of ["harvester_width", "min_plot_length", "max_plot_length"] as const) {
      if (infosIn[0]![key] !== infosIn[1]![key]) {
        throw new ValidationError(
          `You specified inconsistent ${key} across inputs. Please make sure they are the same when preparing plot information individually, or use prepPlot to avoid these inconsistencies.`,
        );
      }
    }
  }
  const headlandLength = Math.max(...infosIn.map((pi) => pi.headland_length));
  const sideLength = Math.max(...infosIn.map((pi) => pi.side_length));
  const plotInfos: PlotInfo[] = infosIn.map((pi) => ({
    ...pi,
    headland_length: headlandLength,
    side_length: sideLength,
  }));

  // ! Field boundary: repair, project to one shared UTM zone (R make_sf_utm)
  const boundaryPolys = repairBoundary(collectPolygonFeatures(options.boundary));
  let lonSum = 0;
  let latSum = 0;
  let nPts = 0;
  for (const rings of boundaryPolys) {
    for (const p of rings[0]!) {
      lonSum += p[0]!;
      latSum += p[1]!;
      nPts++;
    }
  }
  const epsg = utmEpsg(lonSum / nPts, latSum / nPts);
  const project = (p: Position): Pt => toUtm([p[0]!, p[1]!], epsg).point;

  const xyPolys = boundaryPolys.map((rings) => rings.map((ring) => ring.map(project)));
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const rings of xyPolys) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        xMin = Math.min(xMin, x);
        xMax = Math.max(xMax, x);
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
    }
  }
  const bboxDiag = Math.hypot(xMax - xMin, yMax - yMin);

  // ! Ab-line: project, keep the first line, stretch it across the field (R st_extend_line)
  const [abaRaw, abbRaw] = extractAbLine(options.abLine, ablineType);
  const abA = project(abaRaw);
  const abBIn = project(abbRaw);
  const abVec: Pt = [abBIn[0] - abA[0], abBIn[1] - abA[1]];
  const abLen = Math.hypot(abVec[0], abVec[1]);
  if (abLen === 0) throw new ValidationError("The ab-line is degenerate (zero length).");
  const abB: Pt = [abA[0] + (bboxDiag / abLen) * abVec[0], abA[1] + (bboxDiag / abLen) * abVec[1]];

  // ! Ab-line frame (R prepare_ablines: ab_xy_nml / ab_xy_nml_p90)
  const nml: Pt = [abVec[0] / abLen, abVec[1] / abLen];
  const p90: Pt = [nml[1], -nml[0]];
  const toFrame = ([x, y]: Pt): Pt => [x * nml[0] + y * nml[1], x * p90[0] + y * p90[1]];
  const fromFrame = ([u, v]: Pt): Pt => [u * nml[0] + v * p90[0], u * nml[1] + v * p90[1]];

  const framePolys: FramePolygon[] = [];
  for (const rings of xyPolys) {
    const frameRings = rings
      .map((ring) => cleanRing(ring.map(toFrame)))
      .filter((r): r is Ring => r !== null);
    const shell = frameRings[0];
    if (!shell) continue;
    framePolys.push({ shell: toCcw(shell), holes: frameRings.slice(1).map(toCcw) });
  }
  if (framePolys.length === 0) {
    throw new GeometryError("The field boundary collapsed during projection.");
  }

  let areaSum = 0;
  let cvSum = 0;
  let vMin = Infinity;
  let vMax = -Infinity;
  const shells: Ring[] = [];
  const holes: Ring[] = [];
  for (const poly of framePolys) {
    shells.push(poly.shell);
    const sc = ringCentroid(poly.shell);
    areaSum += Math.abs(sc.area);
    cvSum += Math.abs(sc.area) * sc.cy;
    for (const hole of poly.holes) {
      holes.push(hole);
      const hc = ringCentroid(hole);
      areaSum -= Math.abs(hc.area);
      cvSum -= Math.abs(hc.area) * hc.cy;
    }
    for (const [, v] of poly.shell) {
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
  }
  if (!(areaSum > 0) || !Number.isFinite(cvSum / areaSum)) {
    throw new GeometryError(
      "field boundary collapsed to zero area after projection/repair — cannot place strips",
    );
  }
  const field: FieldFrame = {
    polys: framePolys,
    region: { shells, holes },
    vMin,
    vMax,
    centroidV: cvSum / areaSum,
    bboxDiag,
  };

  const abAF = toFrame(abA);
  const abBF = toFrame(abB);
  const vAb = abAF[1];
  const abURange: Interval = [Math.min(abAF[0], abBF[0]), Math.max(abAF[0], abBF[0])];

  // through lines extend the field bbox half-diagonal + 100 m each way (R ab_length)
  const throughHalfLen = bboxDiag / 2 + 100;
  const dilated: RingRegion = dilateField(field, 20); // R st_buffer(field_sf, 20) for ab-line clipping

  const lineFeature = (xyPoints: Pt[]): Feature<LineString> => ({
    type: "Feature",
    properties: { ab_id: 1 },
    geometry: { type: "LineString", coordinates: xyPoints.map((p) => toWgs(p, epsg)) },
  });

  /** Clips a free ab-line candidate to the +20 m dilated field (R make_ablines tail). */
  const clipFreeLine = (geom: AblineGeometry): Feature<LineString> => {
    const lineRange: Interval = [geom.u - throughHalfLen, geom.u + throughHalfLen];
    const pieces = regionIntervalsAt(dilated, geom.v)
      .map(([a, b]): Interval => [Math.max(a, lineRange[0]), Math.min(b, lineRange[1])])
      .filter(([a, b]) => b > a);
    if (pieces.length === 0) {
      throw new GeometryError("The generated ab-line does not intersect the field.");
    }
    // R keeps the whole (possibly multi-part) intersection; a single part is
    // the practical case — with several parts we keep the longest.
    const best = pieces.reduce((acc, p) => (p[1] - p[0] > acc[1] - acc[0] ? p : acc));
    return lineFeature([fromFrame([best[0], geom.v]), fromFrame([best[1], geom.v])]);
  };

  const lockLine = (): Feature<LineString> => lineFeature([abA, abB]);

  // ! First input (R lines 176-241)
  const pi1 = plotInfos[0]!;
  const anchor1 = prepareAblineV(field, vAb, abURange, pi1.plot_width);
  const strips1 = makeTrialPlotsByInput({
    field,
    anchorV: anchor1,
    plotInfo: pi1,
    ablineType,
    secondInput: false,
  });
  const rows1 = makeAblinesData(strips1, pi1.plot_width);
  const abLine1 =
    ablineType === "lock"
      ? lockLine()
      : clipFreeLine(chooseFreeAbline(rows1, pi1.machine_width, pi1.plot_width));
  // harvester guidance is always generated in "free" mode (R hardcodes it)
  const harvest1 = clipFreeLine(chooseFreeAbline(rows1, pi1.harvester_width, pi1.plot_width));

  const perInput: Array<{
    plotInfo: PlotInfo;
    strips: StripPlots[];
    abLine: Feature<LineString>;
    guidance: Feature<LineString>;
  }> = [{ plotInfo: pi1, strips: strips1, abLine: abLine1, guidance: harvest1 }];

  // ! Second input (R lines 250-356)
  if (plotInfos.length === 2) {
    const pi2 = plotInfos[1]!;
    if (pi2.plot_width === pi1.plot_width) {
      // same plot width: share the first input's plots and ab-lines data
      const abLine2 =
        ablineType === "lock"
          ? lockLine()
          : clipFreeLine(chooseFreeAbline(rows1, pi2.machine_width, pi2.plot_width));
      perInput.push({ plotInfo: pi2, strips: strips1, abLine: abLine2, guidance: harvest1 });
    } else {
      // different plot widths: anchor the second input's strips on the edge
      // of the first input's plots (or on the locked ab-line)
      const edge = ablineType === "lock" ? null : plotEdgeLine(rows1, pi1.plot_width);
      const anchor2 = edge
        ? prepareAblineV(
            field,
            edge.v,
            [edge.u - throughHalfLen, edge.u + throughHalfLen],
            pi2.plot_width,
          )
        : prepareAblineV(field, vAb, abURange, pi2.plot_width);
      const strips2 = makeTrialPlotsByInput({
        field,
        anchorV: anchor2,
        plotInfo: pi2,
        ablineType,
        secondInput: true,
      });
      const rows2 = makeAblinesData(strips2, pi2.plot_width);
      const abLine2 =
        ablineType === "lock"
          ? lockLine()
          : clipFreeLine(chooseFreeAbline(rows2, pi2.machine_width, pi2.plot_width));
      perInput.push({ plotInfo: pi2, strips: strips2, abLine: abLine2, guidance: harvest1 });
    }
  }

  // ! Finalize: plots FC, dissolved plots, headland = field - plots (R lines 361-413)
  const frameRingToWgs = (ring: Ring): Position[] => ring.map((p) => toWgs(fromFrame(p), epsg));
  const framePolyFeature = (coordinates: Position[][][]): Feature<MultiPolygon> => ({
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates },
  });

  const fieldFeature = framePolyFeature(
    field.polys.map((poly) => [poly.shell, ...poly.holes] as Position[][]),
  );

  const headlandCache = new Map<StripPlots[], FeatureCollection>();
  const headlandsFor = (strips: StripPlots[], halfW: number): FeatureCollection => {
    const cached = headlandCache.get(strips);
    if (cached) return cached;
    // R: st_buffer(exp_plots, 0.01) |> summarize() — the tiny buffer closes
    // float-thin gaps between neighboring rectangles before dissolving
    const rects: Array<Feature<Polygon>> = [];
    for (const strip of strips) {
      for (const plot of strip.plots) {
        rects.push(
          ringToPolygonFeature([
            [plot.u0 - 0.01, strip.vc + halfW + 0.01],
            [plot.u1 + 0.01, strip.vc + halfW + 0.01],
            [plot.u1 + 0.01, strip.vc - halfW - 0.01],
            [plot.u0 - 0.01, strip.vc - halfW - 0.01],
            [plot.u0 - 0.01, strip.vc + halfW + 0.01],
          ]),
        );
      }
    }
    const dissolved = union(featureCollection<Polygon | MultiPolygon>(rects));
    const head = dissolved
      ? difference(featureCollection<Polygon | MultiPolygon>([fieldFeature, dissolved]))
      : fieldFeature;
    const features: Array<Feature> = [];
    if (head) {
      const geom = head.geometry;
      const coordinates =
        geom.type === "Polygon"
          ? [geom.coordinates.map((ring) => ring.map((p) => toWgs(fromFrame([p[0]!, p[1]!]), epsg)))]
          : geom.coordinates.map((poly) =>
              poly.map((ring) => ring.map((p) => toWgs(fromFrame([p[0]!, p[1]!]), epsg))),
            );
      features.push({
        type: "Feature",
        properties: { type: "headland" },
        geometry:
          coordinates.length === 1
            ? { type: "Polygon", coordinates: coordinates[0]! }
            : { type: "MultiPolygon", coordinates },
      });
    }
    const fc = featureCollection(features);
    headlandCache.set(strips, fc);
    return fc;
  };

  const plotsCache = new Map<StripPlots[], FeatureCollection>();
  const plotsFor = (strips: StripPlots[], halfW: number): FeatureCollection => {
    const cached = plotsCache.get(strips);
    if (cached) return cached;
    const features: Array<Feature> = [];
    for (const strip of strips) {
      for (const plot of strip.plots) {
        // vertex order mirrors R create_plots_in_strip (p1..p4, closed)
        features.push({
          type: "Feature",
          properties: { plot_id: plot.plotId, strip_id: strip.stripId, poly_line: plot.polyLine },
          geometry: {
            type: "Polygon",
            coordinates: [
              frameRingToWgs([
                [plot.u0, strip.vc + halfW],
                [plot.u1, strip.vc + halfW],
                [plot.u1, strip.vc - halfW],
                [plot.u0, strip.vc - halfW],
                [plot.u0, strip.vc + halfW],
              ]),
            ],
          },
        });
      }
    }
    const fc = featureCollection(features);
    plotsCache.set(strips, fc);
    return fc;
  };

  const inputs: InputLayout[] = perInput.map(({ plotInfo, strips, abLine, guidance }) => ({
    plotInfo,
    plots: plotsFor(strips, plotInfo.plot_width / 2),
    headlands: headlandsFor(strips, plotInfo.plot_width / 2),
    abLine,
    guidanceLines: featureCollection([guidance]),
  }));

  return { inputs };
}
