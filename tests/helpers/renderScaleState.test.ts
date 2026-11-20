import { describe, expect, it } from "vitest";
import { SPRITE_INSTANCE_FLOATS } from "../../src/render/gameplayRenderer";
import { buildMapBatch } from "../../src/render/webgpu/mapBatch";
import { MAP_SIZES } from "../../src/scenario/sandbox";
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

  it("stays on the small board when no mapSize option is passed", () => {
    const state = buildRenderScaleState(200);

    expect(state.map.width).toBe(MAP_SIZES.small.width);
    expect(state.map.height).toBe(MAP_SIZES.small.height);
    expect(state.rules.sandbox.mapSize).toBe("small");
  });
});

describe("buildRenderScaleState large fixture", () => {
  const large = () => buildRenderScaleState(200, { mapSize: "large" });

  it("covers the full 84x54 large board", () => {
    const state = large();

    expect(state.map.width).toBe(MAP_SIZES.large.width);
    expect(state.map.height).toBe(MAP_SIZES.large.height);
    expect(state.map.tiles).toHaveLength(
      MAP_SIZES.large.width * MAP_SIZES.large.height,
    );
    expect(state.rules.sandbox.mapSize).toBe("large");
  });

  it("composes the pinned renderer vehicle counts on the large board", () => {
    expect(large().transit.vehicles).toHaveLength(200);
    expect(
      buildRenderScaleState(5_000, { mapSize: "large" }).transit.vehicles,
    ).toHaveLength(5_000);
  });

  it("lays representative roads, tracks, and buildings across the board", () => {
    const state = large();

    const roadTiles = state.map.tiles.filter((tile) => tile.kind === "road");
    expect(roadTiles.length).toBeGreaterThanOrEqual(300);
    expect(state.map.tiles.some((tile) => tile.hasTrack)).toBe(true);
    expect(state.buildings.length).toBeGreaterThanOrEqual(30);
    const developed = new Set(
      [...roadTiles, ...state.map.tiles.filter((tile) => tile.hasTrack)].map(
        (tile) => `${tile.x},${tile.y}`,
      ),
    );
    for (const building of state.buildings) {
      for (const tile of building.occupiedTiles) {
        expect(developed.has(`${tile.x},${tile.y}`)).toBe(false);
      }
    }
  });

  it("renders deterministic tree sprites on thousands of empty tiles", () => {
    const first = buildMapBatch(large()).sprites;
    const second = buildMapBatch(large()).sprites;

    const spriteCount = first.length / SPRITE_INSTANCE_FLOATS;
    // ~12% TREE_RATE over the thousands of empty large-board tiles: far
    // above the fixture's ~33 building sprites, so trees dominate the
    // sprite stage.
    expect(spriteCount).toBeGreaterThan(300);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it("distributes every synthetic vehicle onto an authored large-board path step", () => {
    const state = large();

    for (const vehicle of state.transit.vehicles) {
      const leg = lineLegs(state, vehicle)?.[vehicle.itineraryIndex];
      expect(leg).toBeDefined();
      expect(leg?.status).toBe("connected");
      expect(leg?.currentPath?.steps[vehicle.pathStepIndex]).toBeDefined();
      expect(vehicle.stepProgress).toBeGreaterThan(0);
      expect(vehicle.stepProgress).toBeLessThanOrEqual(1);
    }
  });
});
