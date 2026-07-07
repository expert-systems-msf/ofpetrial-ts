import { describe, expect, it } from "vitest";
import { toUtm, toWgs, utmEpsg, utmProjString, utmZone } from "./projection.js";

describe("utmZone", () => {
  it("computes the UTM zone from longitude", () => {
    expect(utmZone(-88.2)).toBe(16); // Illinois
    expect(utmZone(-71.2)).toBe(19); // Quebec
    expect(utmZone(0)).toBe(31);
    expect(utmZone(-180)).toBe(1);
    expect(utmZone(179.9999)).toBe(60);
  });

  it("wraps at the antimeridian like R's %% 60", () => {
    expect(utmZone(180)).toBe(1);
    expect(utmEpsg(180, 10)).toBe(32_601);
  });
});

describe("utmEpsg", () => {
  it("returns a 326xx code in the northern hemisphere", () => {
    expect(utmEpsg(-88.2, 40.1)).toBe(32_616); // Illinois
    expect(utmEpsg(-71.2, 46.8)).toBe(32_619); // Quebec
  });

  it("returns a 327xx code in the southern hemisphere", () => {
    expect(utmEpsg(-58.4, -34.6)).toBe(32_721); // Buenos Aires
  });
});

describe("utmProjString", () => {
  it("appends +south only for southern-hemisphere zones", () => {
    expect(utmProjString(32_721)).toBe("+proj=utm +zone=21 +datum=WGS84 +units=m +no_defs +south");
    expect(utmProjString(32_616)).toBe("+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs");
    expect(utmProjString(32_616)).not.toContain("+south");
  });
});

describe("toUtm / toWgs round-trip", () => {
  it("round-trips within 1 mm at an Illinois point", () => {
    const lon = -88.2;
    const lat = 40.1;
    const { point, epsg } = toUtm([lon, lat]);
    const [backLon, backLat] = toWgs(point, epsg);

    // Convert the 1e-3 m tolerance to degrees roughly (~1e-8 deg at these
    // latitudes is far tighter than needed); compare in UTM meters instead.
    const { point: roundTripUtm } = toUtm([backLon, backLat]);
    expect(Math.hypot(roundTripUtm[0] - point[0], roundTripUtm[1] - point[1])).toBeLessThan(0.001);
  });

  it("round-trips within 1 mm at a Quebec point", () => {
    const lon = -71.2;
    const lat = 46.8;
    const { point, epsg } = toUtm([lon, lat]);
    const [backLon, backLat] = toWgs(point, epsg);
    const { point: roundTripUtm } = toUtm([backLon, backLat]);
    expect(Math.hypot(roundTripUtm[0] - point[0], roundTripUtm[1] - point[1])).toBeLessThan(0.001);
  });

  it("round-trips within 1 mm at a Buenos Aires (southern) point", () => {
    // Exercises the +south proj string (327xx zone) end to end.
    const lon = -58.4;
    const lat = -34.6;
    const { point, epsg } = toUtm([lon, lat]);
    expect(epsg).toBe(32_721);
    const [backLon, backLat] = toWgs(point, epsg);
    const { point: roundTripUtm } = toUtm([backLon, backLat]);
    expect(Math.hypot(roundTripUtm[0] - point[0], roundTripUtm[1] - point[1])).toBeLessThan(0.001);
  });

  it("uses the expected EPSG zone for each point", () => {
    expect(toUtm([-88.2, 40.1]).epsg).toBe(32_616);
    expect(toUtm([-71.2, 46.8]).epsg).toBe(32_619);
  });

  it("projects into a caller-supplied EPSG (shared frame from a centroid)", () => {
    // Point near the zone 16/17 boundary, forced into zone 16.
    const forced = toUtm([-83.9, 40.1], 32_616);
    expect(forced.epsg).toBe(32_616);
    const auto = toUtm([-83.9, 40.1]);
    expect(auto.epsg).toBe(32_617);
    expect(forced.point[0]).not.toBeCloseTo(auto.point[0], 0);
    // Round-trip through the forced zone still lands on the same WGS84 point.
    const [lon, lat] = toWgs(forced.point, 32_616);
    expect(lon).toBeCloseTo(-83.9, 8);
    expect(lat).toBeCloseTo(40.1, 8);
  });
});
