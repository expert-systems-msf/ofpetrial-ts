// WGS84 <-> UTM projection via proj4, zone chosen from a point's longitude
// (mirrors the R side's zone-from-centroid logic).
import proj4 from "proj4";

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

/** UTM zone number (1-60) for a given longitude (wraps at the antimeridian, like R's `%% 60`). */
export function utmZone(lon: number): number {
  return (Math.floor((lon + 180) / 6) % 60) + 1;
}

/** EPSG code for the UTM zone covering (lon, lat): 326xx north / 327xx south. */
export function utmEpsg(lon: number, lat: number): number {
  const zone = utmZone(lon);
  const base = lat >= 0 ? 32600 : 32700;
  return base + zone;
}

/** proj4 definition string for a UTM EPSG code (326xx north / 327xx south). */
export function utmProjString(epsg: number): string {
  const north = epsg < 32700;
  const zone = epsg % 100;
  return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs${north ? "" : " +south"}`;
}

/**
 * Projects a [lon, lat] WGS84 point to UTM. Without `epsg`, the zone is
 * chosen from the point's own longitude/latitude; pass an explicit `epsg`
 * (e.g. derived once from a field's centroid) to project every vertex of a
 * geometry into the same planar frame.
 */
export function toUtm(
  coord: [number, number],
  epsg?: number,
): { point: [number, number]; epsg: number } {
  const [lon, lat] = coord;
  const zoneEpsg = epsg ?? utmEpsg(lon, lat);
  const [x, y] = proj4(WGS84, utmProjString(zoneEpsg), [lon, lat]);
  return { point: [x, y], epsg: zoneEpsg };
}

/** Projects a UTM [x, y] point (given its EPSG zone) back to WGS84 [lon, lat]. */
export function toWgs(point: [number, number], epsg: number): [number, number] {
  const [lon, lat] = proj4(utmProjString(epsg), WGS84, point);
  return [lon, lat];
}
