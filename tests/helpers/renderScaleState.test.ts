import { describe, expect, it } from "vitest";
import type { Vehicle } from "../../src/domain/types";
import { buildRenderScaleState } from "./renderScaleState";

function lineLegs(
  state: ReturnType<typeof buildRenderScaleState>,
  vehicle: Vehicle,
) {
  return vehicle.mode === "bus"
    ? state.transit.routes.find((route) => route.id === vehicle.lineId)?.legs
    : state.transit.metroLines.find((line) => line.id === vehicle.lineId)?.legs;
}

describe("buildRenderScaleState", () => {
  it("composes the pinned renderer vehicle counts", () => {
    expect(buildRenderScaleState(200).transit.vehicles).toHaveLength(200);
    expect(buildRenderScaleState(5_000).transit.vehicles).toHaveLength(5_000);
  });

  it("includes representative roads, tracks, buildings, and valid routes", () => {
    const state = buildRenderScaleState(200);

    expect(state.map.tiles.some((tile) => tile.kind === "road")).toBe(true);
    expect(state.map.tiles.some((tile) => tile.hasTrack)).toBe(true);
    expect(state.buildings.length).toBeGreaterThanOrEqual(3);
    expect(state.transit.routes).toHaveLength(1);
    expect(state.transit.metroLines).toHaveLength(1);
    for (const line of [...state.transit.routes, ...state.transit.metroLines]) {
      expect(line.pathBroken).toBe(false);
      expect(line.legs.length).toBeGreaterThan(0);
      for (const leg of line.legs) {
        expect(leg.status).toBe("connected");
        expect(leg.currentPath?.steps.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("derives non-empty demand, traffic, and crowding presentation rows", () => {
    const state = buildRenderScaleState(200);

    expect(state.demandFlow.length).toBeGreaterThan(0);
    expect(state.trafficFlow.length).toBeGreaterThan(0);
    expect(state.platformOccupancy.length).toBeGreaterThan(0);
  });

  it("distributes every synthetic vehicle onto an authored path step", () => {
    const state = buildRenderScaleState(200);

    expect(state.transit.vehicles.length).toBeGreaterThan(0);
    for (const vehicle of state.transit.vehicles) {
      const leg = lineLegs(state, vehicle)?.[vehicle.itineraryIndex];
      expect(leg).toBeDefined();
      expect(leg?.currentPath?.steps[vehicle.pathStepIndex]).toBeDefined();
      expect(vehicle.stepProgress).toBeGreaterThan(0);
      expect(vehicle.stepProgress).toBeLessThanOrEqual(1);
    }
  });
});
