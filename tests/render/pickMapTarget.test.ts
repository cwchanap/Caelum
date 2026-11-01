import { describe, expect, it } from "vitest";
import { pickMapTarget } from "../../src/render/webgpu/pickMapTarget";
import { tileSize } from "../../src/render/boardTransform";

describe("pickMapTarget", () => {
  it("picks the sample inside half a tile", () => {
    const pick = pickMapTarget(
      [{ id: "vehicle-001", point: { x: 80, y: 80 } }],
      { x: 90, y: 88 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("keeps the boundary at exactly half a tile and misses beyond it", () => {
    const samples = [{ id: "vehicle-001", point: { x: 80, y: 80 } }];

    expect(pickMapTarget(samples, { x: 80 + tileSize / 2, y: 80 })).toEqual({
      vehicleId: "vehicle-001",
      lineId: null,
    });
    expect(
      pickMapTarget(samples, { x: 80 + tileSize / 2 + 0.5, y: 80 }),
    ).toBeNull();
    expect(pickMapTarget(samples, { x: 400, y: 400 })).toBeNull();
  });

  it("picks the nearest of two samples", () => {
    const pick = pickMapTarget(
      [
        { id: "vehicle-001", point: { x: 80, y: 80 } },
        { id: "vehicle-002", point: { x: 84, y: 80 } },
      ],
      { x: 83, y: 80 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-002", lineId: null });
  });

  it("breaks a distance tie by id", () => {
    const pick = pickMapTarget(
      [
        { id: "vehicle-002", point: { x: 76, y: 80 } },
        { id: "vehicle-001", point: { x: 84, y: 80 } },
      ],
      { x: 80, y: 80 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("misses an empty sample list", () => {
    expect(pickMapTarget([], { x: 80, y: 80 })).toBeNull();
  });
});
