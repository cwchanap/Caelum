import { describe, expect, it } from "vitest";
import { BUILD_MENU } from "../../src/domain/catalog/buildMenu";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type { BuildingType } from "../../src/domain/types";

describe("BUILD_MENU", () => {
  it("orders the ten categories as specified", () => {
    expect(BUILD_MENU.map((c) => c.id)).toEqual([
      "road",
      "rail",
      "bus",
      "metro",
      "residential",
      "commercial",
      "industrial",
      "office",
      "civic",
      "park",
    ]);
  });

  it("covers every building in BUILDING_CATALOG exactly once", () => {
    const placed = BUILD_MENU.flatMap((c) =>
      c.items.flatMap((i) =>
        i.action.kind === "building" ? [i.action.building] : [],
      ),
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
    expect(
      road?.items.flatMap((i) =>
        i.action.kind === "road" ? [i.action.roadPreset] : [],
      ),
    ).toEqual(["twoWay", "oneWay", "dualBidirectional"]);
  });

  it("lists both roundabout stamps under Road without duplicating prices", () => {
    const road = BUILD_MENU.find((category) => category.id === "road");
    expect(road?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "compactRoundabout",
          label: "Compact Roundabout",
          action: { kind: "roundabout", size: "compact2x2" },
        }),
        expect.objectContaining({
          id: "standardRoundabout",
          label: "Standard Roundabout",
          action: { kind: "roundabout", size: "standard3x3" },
        }),
      ]),
    );
    expect(JSON.stringify(road)).not.toMatch(/1000|2000|cost/i);
  });

  it("puts a single track item under rail", () => {
    const rail = BUILD_MENU.find((c) => c.id === "rail");
    expect(rail?.items).toHaveLength(1);
    expect(rail?.items[0]?.action.kind).toBe("track");
  });
});
