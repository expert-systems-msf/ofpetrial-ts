// Comparison utilities for the bi-runtime parity harness (design.md D5).
// Tolerances: 1e-6 relative for anything computed on R-precomputed data
// (fragments, plain arithmetic); 1e-3 only for correlations coming out of
// the full Turf.js spatial join; >= 99% area overlap and <= 10 cm centroid
// distance for geometry parity.
import area from "@turf/area";
import centroid from "@turf/centroid";
import intersect from "@turf/intersect";
import { featureCollection } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { toUtm } from "../src/projection.js";

/** Relative closeness: |actual - expected| <= tol * max(1, |expected|). */
export function relClose(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
}

/**
 * Area-overlap ratio between a TS-produced polygon and its R reference:
 * area(intersection(ts, r)) / area(r). Geometry parity requires >= 0.99.
 */
export function overlapRatio(
  ts: Feature<Polygon | MultiPolygon>,
  r: Feature<Polygon | MultiPolygon>
): number {
  const overlap = intersect(featureCollection([ts, r]));
  if (!overlap) return 0;
  return area(overlap) / area(r);
}

/**
 * Distance in meters between the centroids of two features, measured in the
 * UTM frame of the reference centroid. Geometry parity requires <= 0.10 m.
 */
export function centroidDistanceMeters(
  ts: Feature<Polygon | MultiPolygon>,
  r: Feature<Polygon | MultiPolygon>
): number {
  const cTs = centroid(ts).geometry.coordinates as [number, number];
  const cR = centroid(r).geometry.coordinates as [number, number];
  const { point: pR, epsg } = toUtm(cR);
  const { point: pTs } = toUtm(cTs, epsg);
  return Math.hypot(pTs[0] - pR[0], pTs[1] - pR[1]);
}
