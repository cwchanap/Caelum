import { describe, expect, it } from "vitest";
import { BUILD_MENU } from "../../src/domain/catalog/buildMenu";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type { BuildingType } from "../../src/domain/types";

describe("BUILD_MENU", () => {
  it("orders the ten categories as specified", () => {
    expect(BUILD_MENU.map((c) => c.id)).toEqual([
      "road", "rail", "bus", "metro",
      "residential", "commercial", "industrial", "office", "civic", "park",
    ]);
  });

  it("covers every building in BUILDING_CATALOG exactly once", () => {
    const placed = BUILD_MENU.flatMap((c) =>
      c.items.flatMap((i) => (i.action.kind === "building" ? [i.action.building] : [])),
    );
    const catalogTypes = Object.keys(BUILDING_CATALOG) as BuildingType[];
    expect([...placed].sort()).toEqual([...catalogTypes].sort());
  });

  it("labels building items from BUILDING_CATALOG", () => {
    for (const category of BUILD_MENU) {
      for (const item of category.items) {
        if (item.action.kind === "building") {
          expect(item.label).toBe(BUILDING_CATALOG[item.action.building].label);
        }
      }
    }
  });

  it("maps the three road presets under the road category", () => {
    const road = BUILD_MENU.find((c) => c.id === "road");
    expect(road?.items.map((i) => (i.action.kind === "road" ? i.action.roadPreset : null))).toEqual([
      "twoWay", "oneWay", "dualBidirectional",
    ]);
  });

  it("puts a single track item under rail", () => {
    const rail = BUILD_MENU.find((c) => c.id === "rail");
    expect(rail?.items).toHaveLength(1);
    expect(rail?.items[0]?.action.kind).toBe("track");
  });
});
