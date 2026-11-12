import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AREA_KINDS } from "../../src/domain/catalog/areas";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import {
  BUILD_GROUPS,
  type BuildMenuGroup,
} from "../../src/domain/catalog/buildGroups";
import { ROAD_PRESET_KEYS, buildGroupShortcuts } from "../../src/ui/shortcuts";

const items = () =>
  BUILD_GROUPS.flatMap((group) =>
    group.sections.flatMap((section) => section.items),
  );

const item = (id: string) => {
  const match = items().find((candidate) => candidate.id === id);
  if (match === undefined) throw new Error(`missing build item ${id}`);
  return match;
};

const groupItems = (group: BuildMenuGroup) =>
  group.sections.flatMap((section) => section.items);

const coreCost = (module: string, name: string): number => {
  const source = readFileSync(
    new URL(`../../crates/caelum-core/src/${module}`, import.meta.url),
    "utf8",
  );
  const match = source.match(new RegExp(`pub const ${name}: i32 = ([\\d_]+);`));
  if (match === null) throw new Error(`missing ${name} in ${module}`);
  return Number(match[1].replaceAll("_", ""));
};

/** Zone → building pairs from the core growth table. */
const coreGrowth = (): Map<string, string> => {
  const source = readFileSync(
    new URL("../../crates/caelum-core/src/growth.rs", import.meta.url),
    "utf8",
  );
  return new Map(
    [...source.matchAll(/\("([a-z]+)", "([A-Za-z]+)"\)/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
};

describe("BUILD_GROUPS", () => {
  it("orders exactly the four approved root groups", () => {
    expect(BUILD_GROUPS.map((group) => group.id)).toEqual([
      "roads",
      "transit",
      "zones",
      "buildings",
    ]);
  });

  it("keeps the current road and transit inventory", () => {
    const roads = BUILD_GROUPS[0].sections[0].items;
    const transit = BUILD_GROUPS[1].sections[0].items;
    expect(roads.map((item) => item.id)).toEqual([
      "road-twoWay",
      "road-oneWay",
      "road-dual",
      "compactRoundabout",
      "standardRoundabout",
    ]);
    expect(transit.map((item) => item.id)).toEqual([
      "track",
      "busStop",
      "busTerminal",
      "metroStation",
    ]);
  });

  it("maps all six area paints into Zones", () => {
    const zones = BUILD_GROUPS[2].sections[0].items;
    expect(
      zones.flatMap((item) =>
        item.action.kind === "area" ? [item.action.area] : [],
      ),
    ).toEqual(AREA_KINDS);
  });

  it("groups every area-bound building exactly once", () => {
    const buildings = BUILD_GROUPS[3].sections.flatMap(
      (section) => section.items,
    );
    const expected = Object.values(BUILDING_CATALOG)
      .filter((definition) => definition.allowedArea !== undefined)
      .map((definition) => definition.type)
      .sort();
    const actual = buildings
      .flatMap((item) =>
        item.action.kind === "building" ? [item.action.building] : [],
      )
      .sort();
    expect(actual).toEqual(expected);
    expect(new Set(items().map((item) => item.id)).size).toBe(items().length);
  });

  it("places every BUILDING_CATALOG entry exactly once across all groups", () => {
    // busStop and metroStation are BUILDING_CATALOG entries surfaced as transit
    // tool actions rather than building actions, so count them through the tool
    // action. Every catalog entry must appear exactly once somewhere in the
    // menu; an orphaned or duplicated entry fails here.
    const placed = items()
      .flatMap((item) => {
        if (item.action.kind === "building") return [item.action.building];
        if (item.action.kind === "tool") return [item.action.tool];
        return [];
      })
      .sort();
    const catalogEntries = Object.keys(BUILDING_CATALOG).sort();
    expect(placed).toEqual(catalogEntries);
  });

  it("gives every item a short description and a display cost", () => {
    for (const entry of items()) {
      expect(entry.description.trim()).not.toBe("");
      if (entry.cost !== "free") {
        expect(entry.cost.amount).toBeGreaterThan(0);
        expect(["each", "perTile"]).toContain(entry.cost.unit);
      }
    }
  });

  it("derives building and stop prices from BUILDING_CATALOG", () => {
    for (const entry of items()) {
      const building =
        entry.action.kind === "building"
          ? entry.action.building
          : entry.action.kind === "tool"
            ? entry.action.tool
            : null;
      if (building === null) continue;
      expect(entry.cost).toEqual({
        amount: BUILDING_CATALOG[building].cost,
        unit: "each",
      });
    }
  });

  it("pins the nominal non-building hints against the Rust cost constants", () => {
    const road = coreCost("transit.rs", "ROAD_COST");
    const track = coreCost("transit.rs", "TRACK_COST");
    const compact = coreCost("roundabouts.rs", "COMPACT_ROUNDABOUT_COST");
    const standard = coreCost("roundabouts.rs", "STANDARD_ROUNDABOUT_COST");

    expect(item("road-twoWay").cost).toEqual({
      amount: road,
      unit: "perTile",
    });
    expect(item("road-oneWay").cost).toEqual({
      amount: road,
      unit: "perTile",
    });
    // A dual stroke tile can need both lanes, so its nominal hint is two tiles.
    expect(item("road-dual").cost).toEqual({
      amount: road * 2,
      unit: "perTile",
    });
    expect(item("track").cost).toEqual({
      amount: track,
      unit: "perTile",
    });
    expect(item("compactRoundabout").cost).toEqual({
      amount: compact,
      unit: "each",
    });
    expect(item("standardRoundabout").cost).toEqual({
      amount: standard,
      unit: "each",
    });
    for (const entry of groupItems(BUILD_GROUPS[2])) {
      expect(entry.cost).toBe("free");
    }
  });

  it("describes only the growth the core actually performs", () => {
    const growth = coreGrowth();
    expect(Object.fromEntries(growth)).toEqual({
      residential: "smallHouse",
      commercial: "supermarket",
      office: "officeTower",
      industrial: "factory",
    });

    const industrial = item("industrial").description;
    expect(industrial).toMatch(/factories grow/i);
    expect(industrial).toMatch(/warehouses can be placed by hand/i);

    for (const manualZone of ["civic", "park"] as const) {
      expect(growth.has(manualZone)).toBe(false);
      expect(item(manualZone).description).not.toMatch(/grow/i);
    }
    expect(item("civic").description).toMatch(
      /clinics and schools can be placed here by hand/i,
    );
  });
});

describe("buildGroupShortcuts", () => {
  it("maps the first nine visible items to 1–9 in order", () => {
    for (const group of BUILD_GROUPS) {
      const shortcuts = buildGroupShortcuts(group);
      const visible = groupItems(group);
      visible.slice(0, 9).forEach((entry, index) => {
        expect(shortcuts[entry.id]).toBe(String(index + 1));
      });
      for (const entry of visible.slice(9)) {
        expect(shortcuts[entry.id]).toBeUndefined();
      }
    }
    expect(Object.keys(buildGroupShortcuts(BUILD_GROUPS[3]))).toHaveLength(9);
    expect(Object.keys(buildGroupShortcuts(BUILD_GROUPS[1]))).toHaveLength(4);
  });

  it("keeps Roads 1/2/3 aligned with ROAD_PRESET_KEYS", () => {
    const shortcuts = buildGroupShortcuts(BUILD_GROUPS[0]);
    for (const preset of ["twoWay", "oneWay", "dualBidirectional"] as const) {
      const entry = groupItems(BUILD_GROUPS[0]).find(
        (candidate) =>
          candidate.action.kind === "road" &&
          candidate.action.roadPreset === preset,
      );
      expect(entry).toBeDefined();
      expect(shortcuts[entry!.id]).toBe(ROAD_PRESET_KEYS[preset]);
    }
  });
});
