import { describe, expect, it } from "vitest";
import { BUILD_GROUPS } from "../../src/domain/catalog/buildGroups";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type { BuildingType } from "../../src/domain/types";

describe("BUILD_GROUPS", () => {
  it("orders the four command groups", () => {
    expect(BUILD_GROUPS.map((group) => group.id)).toEqual([
      "roads",
      "transit",
      "zones",
      "buildings",
    ]);
  });

  it("covers every building in BUILDING_CATALOG exactly once", () => {
    const placed = BUILD_GROUPS.flatMap((group) =>
      group.sections.flatMap((section) =>
        section.items.flatMap((item) =>
          item.action.kind === "building"
            ? [item.action.building]
            : item.action.kind === "tool"
              ? [item.action.tool]
              : [],
        ),
      ),
    );
    const catalogTypes = Object.keys(BUILDING_CATALOG) as BuildingType[];
    expect([...placed].sort()).toEqual([...catalogTypes].sort());
  });

  it("keeps the road presets and roundabout stamps in Roads", () => {
    const roads = BUILD_GROUPS.find((group) => group.id === "roads")!;
    const items = roads.sections.flatMap((section) => section.items);
    expect(
      items.flatMap((item) =>
        item.action.kind === "road" ? [item.action.roadPreset] : [],
      ),
    ).toEqual(["twoWay", "oneWay", "dualBidirectional"]);
    expect(items.map((item) => item.id)).toEqual([
      "road-twoWay",
      "road-oneWay",
      "road-dual",
      "compactRoundabout",
      "standardRoundabout",
    ]);
  });

  it("contains all six zone actions", () => {
    const zones = BUILD_GROUPS.find((group) => group.id === "zones")!;
    expect(zones.sections[0].items.map((item) => item.id)).toEqual([
      "residential",
      "commercial",
      "industrial",
      "office",
      "civic",
      "park",
    ]);
  });
});
