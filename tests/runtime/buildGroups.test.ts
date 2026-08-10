import { describe, expect, it } from "vitest";
import { AREA_KINDS } from "../../src/domain/catalog/areas";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import { BUILD_GROUPS } from "../../src/domain/catalog/buildGroups";

const items = () =>
  BUILD_GROUPS.flatMap((group) =>
    group.sections.flatMap((section) => section.items),
  );

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
});
