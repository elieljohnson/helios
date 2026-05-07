import { describe, expect, it } from "vitest";
import {
  classifyGeofence,
  haversineMeters,
  MAX_LOCATION_AGE_SEC,
} from "./geofence";

// Mill Valley, CA — used as the reference home in Helios's
// single-tenant config. Tests use this so distances are intuitive
// (1 mile from this lat is ~1.6 km horizontally).
const MILL_VALLEY = { lat: 37.906, lng: -122.545 };

describe("haversineMeters", () => {
  it("returns 0 for identical coordinates", () => {
    expect(haversineMeters(MILL_VALLEY, MILL_VALLEY)).toBe(0);
  });

  it("computes ~1 meter for 0.00001-degree separation", () => {
    // 1° latitude ≈ 111 km, so 0.00001° ≈ 1.11 m.
    const d = haversineMeters(MILL_VALLEY, {
      lat: MILL_VALLEY.lat + 0.00001,
      lng: MILL_VALLEY.lng,
    });
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(2);
  });

  it("computes ~111 km for 1-degree latitude separation", () => {
    const d = haversineMeters(MILL_VALLEY, {
      lat: MILL_VALLEY.lat + 1,
      lng: MILL_VALLEY.lng,
    });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("is symmetric", () => {
    const sf = { lat: 37.7749, lng: -122.4194 };
    expect(haversineMeters(MILL_VALLEY, sf)).toBeCloseTo(
      haversineMeters(sf, MILL_VALLEY),
      0,
    );
  });
});

describe("classifyGeofence", () => {
  const fixedNow = new Date("2026-05-06T19:00:00Z");
  const recentLocationAt = new Date(
    fixedNow.getTime() - 60_000,
  ).toISOString(); // 1 min ago

  it("returns at_home when car is within radius and reading is fresh", () => {
    const v = classifyGeofence({
      carLat: MILL_VALLEY.lat,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: recentLocationAt,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("at_home");
    if (v.state === "at_home") expect(v.distanceM).toBe(0);
  });

  it("returns away when car is outside radius and reading is fresh", () => {
    // 0.005° latitude ≈ 555 m — well outside a 200 m radius.
    const v = classifyGeofence({
      carLat: MILL_VALLEY.lat + 0.005,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: recentLocationAt,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("away");
    if (v.state === "away") {
      expect(v.distanceM).toBeGreaterThan(500);
      expect(v.distanceM).toBeLessThan(600);
    }
  });

  it("returns unknown when home coordinates are missing", () => {
    const v = classifyGeofence({
      carLat: MILL_VALLEY.lat,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: recentLocationAt,
      homeLat: undefined,
      homeLng: undefined,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("unknown");
  });

  it("returns unknown when vehicle GPS is missing", () => {
    const v = classifyGeofence({
      carLat: undefined,
      carLng: undefined,
      carLocationAtIso: undefined,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("unknown");
  });

  it("returns unknown when GPS reading is stale", () => {
    // 30 minutes old — past the 10-minute freshness threshold.
    const stale = new Date(fixedNow.getTime() - 30 * 60_000).toISOString();
    const v = classifyGeofence({
      carLat: MILL_VALLEY.lat,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: stale,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("unknown");
    if (v.state === "unknown") expect(v.reason).toMatch(/stale/);
  });

  it("treats reading exactly at MAX_LOCATION_AGE_SEC as still fresh", () => {
    const exactlyAtLimit = new Date(
      fixedNow.getTime() - MAX_LOCATION_AGE_SEC * 1000,
    ).toISOString();
    const v = classifyGeofence({
      carLat: MILL_VALLEY.lat,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: exactlyAtLimit,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      radiusM: 200,
      now: fixedNow,
    });
    expect(v.state).toBe("at_home");
  });

  it("respects radius — same coordinates classify differently with different radii", () => {
    // 0.001° ≈ 111 m. Inside 200 m, outside 50 m.
    const carPos = {
      carLat: MILL_VALLEY.lat + 0.001,
      carLng: MILL_VALLEY.lng,
      carLocationAtIso: recentLocationAt,
      homeLat: MILL_VALLEY.lat,
      homeLng: MILL_VALLEY.lng,
      now: fixedNow,
    };
    expect(classifyGeofence({ ...carPos, radiusM: 200 }).state).toBe("at_home");
    expect(classifyGeofence({ ...carPos, radiusM: 50 }).state).toBe("away");
  });
});
