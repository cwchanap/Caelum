import { describe, expect, it } from "vitest";
import type { BuildingRotation } from "../../src/domain/types";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
  getRotatedFootprintSize,
} from "../../src/simulation/buildings";

describe("building catalog and footprints", () => {
  it("defines the first Build menu catalog", () => {
    expect(Object.keys(BUILDING_CATALOG)).toEqual([
      "busStop",
      "busTerminal",
      "metroStation",
      "smallHouse",
      "largeHouse",
    ]);
    expect(BUILDING_CATALOG.busTerminal).toMatchObject({
      label: "Bus Terminal",
      width: 3,
      height: 2,
      cost: 12_000,
      effect: "busTerminal",
    });
    expect(BUILDING_CATALOG.smallHouse).toMatchObject({
      label: "Small House",
      width: 2,
      height: 1,
      cost: 4_000,
      citizenCount: 4,
      effect: "housing",
    });
  });

  it.each([
    [0, { width: 3, height: 2 }],
    [90, { width: 2, height: 3 }],
    [180, { width: 3, height: 2 }],
    [270, { width: 2, height: 3 }],
  ] satisfies Array<[BuildingRotation, { width: number; height: number }]>)(
    "rotates a 3x2 footprint at %s degrees",
    (rotation, size) => {
      expect(getRotatedFootprintSize("busTerminal", rotation)).toEqual(size);
    },
  );

  it("expands a rotated footprint from its origin", () => {
    expect(getBuildingFootprint("smallHouse", { x: 4, y: 5 }, 90)).toEqual([
      { x: 4, y: 5 },
      { x: 4, y: 6 },
    ]);
  });
});
