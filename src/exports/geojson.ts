// GeoJSON (RFC 7946) writer — task 7.2.
//
// One FeatureCollection per input, no top-level "crs" member (RFC 7946 fixes
// the CRS to WGS84 and forbids the legacy GeoJSON "crs" key), right-hand
// rule ring winding (exterior counter-clockwise, holes clockwise) — the
// opposite convention from the shapefile writer (src/exports/shapefile.ts),
// enforced here regardless of the input geometry's original winding.
import type { LineString, MultiLineString, MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../types.js";
import type { Ring } from "./shapefile.js";

export interface GeoJsonFeatureInput {
  geometry: Polygon | MultiPolygon | LineString | MultiLineString;
  properties: Record<string, number | string | null>;
}

function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** Right-hand rule: exterior ring CCW (area > 0), hole rings CW (area < 0). */
function rightHandRing(ring: Ring, isExterior: boolean): Ring {
  const isCcw = signedArea(ring) > 0;
  return isCcw === isExterior ? ring : [...ring].reverse();
}

function fixPolygonWinding(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring, i) => rightHandRing(ring as Ring, i === 0)),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map((poly) =>
      poly.map((ring, i) => rightHandRing(ring as Ring, i === 0)),
    ),
  };
}

/**
 * Serializes features into an RFC 7946 FeatureCollection (UTF-8 JSON bytes).
 * Polygon/MultiPolygon geometries are reoriented to the right-hand rule;
 * LineString/MultiLineString geometries pass through unchanged (RFC 7946
 * does not constrain line winding).
 */
export function writeGeoJson(features: GeoJsonFeatureInput[]): Uint8Array {
  if (features.length === 0) {
    throw new ExportError("writeGeoJson: cannot write a layer with zero features");
  }
  const fc = {
    type: "FeatureCollection" as const,
    features: features.map((f) => ({
      type: "Feature" as const,
      properties: f.properties,
      geometry:
        f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"
          ? fixPolygonWinding(f.geometry)
          : f.geometry,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(fc));
}
