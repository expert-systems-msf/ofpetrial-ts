// Small planar/projection helpers shared by plot-layout.ts and diagnostics.ts.
import type { Position } from "geojson";
import { utmEpsg } from "./projection.js";

/** Shoelace signed area of a closed ring (positive = counter-clockwise). */
export function signedRingArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const p1 = ring[index]!;
    const p2 = ring[index + 1]!;
    sum += p1[0]! * p2[1]! - p2[0]! * p1[1]!;
  }
  return sum / 2;
}

/**
 * Shared UTM zone for a set of lon/lat vertices, chosen from their coordinate
 * mean. R's st_transform_utm picks the zone from each object's bbox longitude
 * *midpoint* instead — a different algorithm that lands on the same zone for
 * any real field (fields are km-scale, UTM zones 6 degrees wide). Note that R
 * hardcodes the northern hemisphere (EPSG 326xx); utmEpsg branches
 * 326xx/327xx on latitude — an intentional improvement over R, not a parity
 * bug to "fix".
 */
export function utmEpsgFromVertexMean(points: Iterable<Position>): number {
  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  for (const p of points) {
    lonSum += p[0]!;
    latSum += p[1]!;
    n++;
  }
  return utmEpsg(lonSum / n, latSum / n);
}
