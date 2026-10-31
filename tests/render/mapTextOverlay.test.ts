import { describe, expect, it } from "vitest";
import type { GameState, RouteLegPath } from "../../src/domain/types";
import { selectMapTextOverlayItems } from "../../src/render/mapTextOverlay";
import type { RoadMutationPreviewResponse } from "../../src/runtime/backend/types";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroStation,
  createTestGameState,
} from "../helpers/gameState";
import { withAreas, withRoads, withTracks } from "../helpers/mapFixtures";
import type { TransitPath } from "../../src/domain/types";

type MapTextOverlayItem = ReturnType<typeof selectMapTextOverlayItems>[number];

function itemsOfKind<K extends MapTextOverlayItem["kind"]>(
  state: GameState,
  ui: UiState,
  kind: K,
): Extract<MapTextOverlayItem, { kind: K }>[] {
  return selectMapTextOverlayItems(state, ui).filter(
    (item): item is Extract<MapTextOverlayItem, { kind: K }> =>
      item.kind === kind,
  );
}

function markerPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: from,
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from, to },
        travelSeconds: 1,
      },
    ],
    totalTravelSeconds: 1,
  };
}

describe("selectMapTextOverlayItems", () => {
  it("derives the cursor badge wording", () => {
    const state = withRoads(createTestGameState(), [{ x: 7, y: 8 }]);
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      hoverTile: { x: 7, y: 8 },
    };

    const items = itemsOfKind(state, ui, "cursorBadge");

    expect(items).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 7, y: 8 },
        text: "⦿ Road →",
        a11yText: "Road →",
      },
    ]);
  });

  it("anchors the cursor badge on the drag current tile", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      hoverTile: { x: 1, y: 1 },
      drag: {
        tool: "remove" as const,
        start: { x: 2, y: 2 },
        current: { x: 4, y: 2 },
      },
    };

    const items = itemsOfKind(state, ui, "cursorBadge");

    expect(items).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 4, y: 2 },
        text: "⦿ Demolish",
        a11yText: "Demolish",
      },
    ]);
  });

  it("emits no cursor badge without a hover tile", () => {
    const items = itemsOfKind(
      createTestGameState(),
      createUiState(),
      "cursorBadge",
    );
    expect(items).toHaveLength(0);
  });

  it("numbers route draft waypoint handles at their node positions", () => {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 3, y: 3 });
    state = addTestBusStop(state, { x: 8, y: 3 });
    const ui: UiState = {
      ...createUiState(),
      activeTool: "busRoute",
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: state.transit.stops.map((stop) => stop.id),
        selectedIndex: null,
        interaction: "append",
        generation: 1,
        previewPending: false,
        preview: null,
      },
    };

    const items = itemsOfKind(state, ui, "routeWaypoint");

    expect(items).toEqual([
      { kind: "routeWaypoint", anchor: { x: 3, y: 3 }, text: "1" },
      { kind: "routeWaypoint", anchor: { x: 8, y: 3 }, text: "2" },
    ]);
  });

  it("omits draft waypoints whose node left the network", () => {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 3, y: 3 });
    const ui: UiState = {
      ...createUiState(),
      activeTool: "busRoute",
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: [state.transit.stops[0]!.id, "ghost-stop"],
        selectedIndex: null,
        interaction: "append",
        generation: 1,
        previewPending: false,
        preview: null,
      },
    };

    const items = itemsOfKind(state, ui, "routeWaypoint");

    expect(items).toEqual([
      { kind: "routeWaypoint", anchor: { x: 3, y: 3 }, text: "1" },
    ]);
  });

  it("merges useful Rust preview feedback into the cursor badge", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 7, y: 8 },
      roadPreviewGeneration: 3,
      roadMutationPreview: {
        generation: 3,
        changedTiles: [{ x: 5, y: 6 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 500,
        skippedTiles: [],
        routeImpacts: [
          { routeId: "route-z", kind: "broken" as const },
          { routeId: "route-a", kind: "rerouted" as const },
        ],
        warnings: [],
        rejection: null,
      },
    };

    const items = itemsOfKind(state, ui, "cursorBadge");

    expect(items).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 7, y: 8 },
        text: "⦿ Road · $500 · route-z broken · route-a rerouted",
        a11yText: "Road, $500, route-z will break, route-a will reroute",
      },
    ]);
  });

  it("keeps the last resolved preview during a drag while a newer request is pending", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 5, y: 6 },
      drag: {
        tool: "road" as const,
        start: { x: 4, y: 6 },
        current: { x: 5, y: 6 },
      },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
        // The held answer resolved for this same (4,6)→(5,6) stroke, so its
        // verdict still describes a prefix of the pending request's stroke.
        mutation: {
          type: "layRoadLine" as const,
          points: [
            { x: 4, y: 6 },
            { x: 5, y: 6 },
          ],
          preset: "twoWay" as const,
        },
        changedTiles: [{ x: 5, y: 6 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };

    expect(itemsOfKind(state, ui, "cursorBadge")).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 5, y: 6 },
        text: "⦿ Road · $100",
        a11yText: "Road, $100",
      },
    ]);
  });

  it("shows neutral pending instead of a held accepted verdict the stroke retracted past", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 5, y: 6 },
      drag: {
        tool: "road" as const,
        start: { x: 4, y: 6 },
        current: { x: 5, y: 6 },
      },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
        // The held answer resolved for the longer (4,6)→(7,6) stroke; the
        // retracted stroke commits only its first two tiles, so the old
        // cost cannot stand in as this stroke's verdict.
        mutation: {
          type: "layRoadLine" as const,
          points: [
            { x: 4, y: 6 },
            { x: 5, y: 6 },
            { x: 6, y: 6 },
            { x: 7, y: 6 },
          ],
          preset: "twoWay" as const,
        },
        changedTiles: [
          { x: 4, y: 6 },
          { x: 5, y: 6 },
          { x: 6, y: 6 },
          { x: 7, y: 6 },
        ],
        authoredTiles: [],
        generatedStructures: [],
        cost: 400,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };

    expect(itemsOfKind(state, ui, "cursorBadge")).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 5, y: 6 },
        text: "⦿ Road …",
        a11yText: "Road, preview pending",
      },
    ]);
  });

  it("shows neutral pending instead of a held rejection mid-drag", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 6, y: 6 },
      drag: {
        tool: "road" as const,
        start: { x: 4, y: 6 },
        current: { x: 4, y: 6 },
      },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [{ x: 6, y: 6 }],
        routeImpacts: [],
        warnings: [],
        rejection: { code: "blockedTile" as const, context: {} },
      },
    };

    // The player retracted the stroke below the blocked tile; the old
    // rejection cannot keep claiming this stroke is blocked.
    expect(itemsOfKind(state, ui, "cursorBadge")).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 4, y: 6 },
        text: "⦿ Road …",
        a11yText: "Road, preview pending",
      },
    ]);
  });

  it("shows neutral pending instead of a held preview's verdict at idle hover", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 5, y: 6 },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 4, y: 6 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };

    expect(itemsOfKind(state, ui, "cursorBadge")).toEqual([
      {
        kind: "cursorBadge",
        anchor: { x: 5, y: 6 },
        text: "⦿ Road …",
        a11yText: "Road, preview pending",
      },
    ]);
  });

  it("does not present a held rejection as the new idle tile's verdict", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 5, y: 6 },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: { code: "blockedTile" as const, context: {} },
      },
    };

    const items = itemsOfKind(state, ui, "cursorBadge");
    expect(items[0]?.text).toBe("⦿ Road …");
    expect(items[0]?.tone).toBeUndefined();
  });

  describe("cursor badge wording", () => {
    function previewResponse(
      overrides: Partial<RoadMutationPreviewResponse> = {},
    ): RoadMutationPreviewResponse {
      return {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
        ...overrides,
      };
    }

    it("labels a selected building with its catalog name, rotation, and validity", () => {
      let state = createTestGameState();
      state = withAreas(state, "residential", [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
      ]);
      const ui: UiState = {
        ...createUiState(),
        selectedBuilding: "smallHouse",
        hoverTile: { x: 3, y: 3 },
      };

      expect(itemsOfKind(state, ui, "cursorBadge")[0]?.text).toBe(
        "⦿ Small House 0°",
      );

      // Off the residential zone the footprint is unplaceable -> ⊘ flag.
      const offZone = itemsOfKind(
        state,
        { ...ui, hoverTile: { x: 8, y: 8 } },
        "cursorBadge",
      );
      expect(offZone[0]?.text).toBe("⦿ Small House 0° ⊘");
    });

    it("labels the road tool per preset and flags unplaceable tiles", () => {
      const state = createTestGameState();
      const ui: UiState = {
        ...createUiState(),
        activeTool: "road",
        hoverTile: { x: 2, y: 2 },
      };

      expect(itemsOfKind(state, ui, "cursorBadge")[0]?.text).toBe("⦿ Road");
      expect(
        itemsOfKind(
          state,
          { ...ui, roadPreset: "dualBidirectional" },
          "cursorBadge",
        )[0]?.text,
      ).toBe("⦿ Road ⇄");
      // Hovering an existing bare road stays valid (direction cycling).
      expect(
        itemsOfKind(withRoads(state, [{ x: 2, y: 2 }]), ui, "cursorBadge")[0]
          ?.text,
      ).toBe("⦿ Road");
      // Off-map tiles cannot accept a road.
      expect(
        itemsOfKind(
          state,
          { ...ui, hoverTile: { x: -1, y: 0 } },
          "cursorBadge",
        )[0]?.text,
      ).toBe("⦿ Road ⊘");
    });

    it("labels the track tool and flags invalid tiles", () => {
      const state = createTestGameState();
      const ui: UiState = {
        ...createUiState(),
        activeTool: "track",
        hoverTile: { x: 2, y: 2 },
      };

      expect(itemsOfKind(state, ui, "cursorBadge")[0]?.text).toBe("⦿ Track");
      expect(
        itemsOfKind(withTracks(state, [{ x: 2, y: 2 }]), ui, "cursorBadge")[0]
          ?.text,
      ).toBe("⦿ Track ⊘");
    });

    it("labels the roundabout tool by size and preview outcome", () => {
      const state = createTestGameState();
      const ui: UiState = {
        ...createUiState(),
        activeTool: "roundabout",
        roundaboutSize: "standard3x3",
        hoverTile: { x: 4, y: 4 },
      };

      // No preview yet: pending ellipsis; compact preset reports 2×2.
      expect(
        itemsOfKind(
          state,
          { ...ui, roundaboutSize: "compact2x2" },
          "cursorBadge",
        )[0],
      ).toMatchObject({
        text: "⦿ Roundabout 2×2 …",
        a11yText: "Roundabout 2×2, preview pending",
      });
      expect(itemsOfKind(state, ui, "cursorBadge")[0]?.text).toBe(
        "⦿ Roundabout 3×3 …",
      );

      const accepted = itemsOfKind(
        state,
        {
          ...ui,
          roadPreviewGeneration: 2,
          roadMutationPreview: previewResponse({ generation: 2 }),
        },
        "cursorBadge",
      );
      expect(accepted[0]?.text).toBe("⦿ Roundabout 3×3");

      const rejected = itemsOfKind(
        state,
        {
          ...ui,
          roadPreviewGeneration: 2,
          roadMutationPreview: previewResponse({
            generation: 2,
            cost: 500,
            rejection: { code: "unsafeRoundaboutPortMapping", context: {} },
          }),
        },
        "cursorBadge",
      );
      expect(rejected[0]?.text).toBe(
        "⦿ Roundabout 3×3 · The roads crossing this footprint cannot map safely to roundabout ports. ⊘",
      );
      expect(rejected[0]?.text).not.toContain("$500");
      expect(rejected[0]?.tone).toBe("warning");
    });

    it("labels the area tool only while an area kind is selected", () => {
      const state = createTestGameState();
      const ui: UiState = {
        ...createUiState(),
        activeTool: "area",
        hoverTile: { x: 2, y: 2 },
      };

      expect(itemsOfKind(state, ui, "cursorBadge")).toHaveLength(0);
      expect(
        itemsOfKind(
          state,
          { ...ui, selectedArea: "residential" },
          "cursorBadge",
        )[0]?.text,
      ).toBe("⦿ Area Residential");
      // Tracked tiles are not paintable.
      expect(
        itemsOfKind(
          withTracks(state, [{ x: 2, y: 2 }]),
          { ...ui, selectedArea: "residential" },
          "cursorBadge",
        )[0]?.text,
      ).toBe("⦿ Area Residential ⊘");
    });

    it("emits no badge for tools without a cursor label", () => {
      const items = itemsOfKind(
        createTestGameState(),
        {
          ...createUiState(),
          activeTool: "busStop",
          hoverTile: { x: 2, y: 2 },
        },
        "cursorBadge",
      );
      expect(items).toHaveLength(0);
    });
  });

  describe("mutation previews in the cursor badge", () => {
    function previewResponse(
      overrides: Partial<RoadMutationPreviewResponse> = {},
    ): RoadMutationPreviewResponse {
      return {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
        ...overrides,
      };
    }

    function previewUi(preview: RoadMutationPreviewResponse): UiState {
      return {
        ...createUiState(),
        activeTool: "road",
        hoverTile: { x: 2, y: 2 },
        roadPreviewGeneration: preview.generation,
        roadMutationPreview: preview,
      };
    }

    it("anchors preview feedback on the cursor, not preview tiles", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            changedTiles: [{ x: 5, y: 6 }],
            authoredTiles: [
              { point: { x: 9, y: 9 }, roadConnections: ["east"] },
            ],
          }),
        ),
        "cursorBadge",
      );

      expect(items[0]?.anchor).toEqual({ x: 2, y: 2 });
    });

    it("names the route when a single impact applies", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [{ routeId: "route-b", kind: "broken" }],
          }),
        ),
        "cursorBadge",
      );

      // Unknown route ids fall back to their ids as display names.
      expect(items[0]?.text).toBe("⦿ Road · Free · route-b broken");
      expect(items[0]?.a11yText).toBe("Road, Free, route-b will break");
    });

    it("caps an over-long single route name", () => {
      let state = addTestBusStop(createTestGameState(), { x: 1, y: 1 });
      state = addTestBusStop(state, { x: 4, y: 1 });
      state = addTestBusRoute(state, ["stop-001", "stop-002"]);
      state = {
        ...state,
        transit: {
          ...state.transit,
          routes: state.transit.routes.map((route) => ({
            ...route,
            name: "Crosstown Express via the Old Harbor Loop and Back",
          })),
        },
      };

      const items = itemsOfKind(
        state,
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [
              { routeId: state.transit.routes[0]!.id, kind: "broken" },
            ],
          }),
        ),
        "cursorBadge",
      );

      // Route names are unbounded player input; the badge trims past the cap
      // so the nowrap label cannot overflow the clipped overlay.
      expect(items[0]?.text).toBe(
        "⦿ Road · Free · Crosstown Express via t… broken",
      );
    });

    it("caps route names on grapheme boundaries so emoji stay whole", () => {
      let state = addTestBusStop(createTestGameState(), { x: 1, y: 1 });
      state = addTestBusStop(state, { x: 4, y: 1 });
      state = addTestBusRoute(state, ["stop-001", "stop-002"]);
      state = {
        ...state,
        transit: {
          ...state.transit,
          routes: state.transit.routes.map((route) => ({
            ...route,
            name: "🚍".repeat(30),
          })),
        },
      };

      const items = itemsOfKind(
        state,
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [
              { routeId: state.transit.routes[0]!.id, kind: "broken" },
            ],
          }),
        ),
        "cursorBadge",
      );

      // A UTF-16 slice could split the surrogate pair; the grapheme cap keeps
      // 23 whole buses then the ellipsis.
      expect(items[0]?.text).toBe(`⦿ Road · Free · ${"🚍".repeat(23)}… broken`);
    });

    it("names the first impacts broken-first and counts the rest", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [
              { routeId: "route-a", kind: "rerouted" },
              { routeId: "route-b", kind: "broken" },
              { routeId: "route-a", kind: "broken" },
              { routeId: "route-b", kind: "rerouted" },
            ],
          }),
        ),
        "cursorBadge",
      );

      // The badge cannot wrap or grow past the board, so it names the two
      // broken routes first and counts the remainder — while the spoken
      // readout names every route.
      expect(items[0]?.text).toBe(
        "⦿ Road · Free · route-b broken · route-a broken · +2 more",
      );
      expect(items[0]?.a11yText).toBe(
        "Road, Free, route-b will break, route-a will break, route-a will reroute, route-b will reroute",
      );
    });

    it("names both impacts when two share one kind", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [
              { routeId: "route-a", kind: "rerouted" },
              { routeId: "route-b", kind: "rerouted" },
            ],
          }),
        ),
        "cursorBadge",
      );

      expect(items[0]?.text).toBe(
        "⦿ Road · Free · route-a rerouted · route-b rerouted",
      );
    });

    it("lets an accepted Rust response override the single-tile road heuristic", () => {
      const state = addTestBusStop(createTestGameState(), { x: 2, y: 2 });
      const ui: UiState = {
        ...createUiState(),
        activeTool: "road",
        hoverTile: { x: 2, y: 2 },
      };
      expect(itemsOfKind(state, ui, "cursorBadge")[0]?.text).toBe("⦿ Road ⊘");

      const accepted = itemsOfKind(
        state,
        {
          ...ui,
          roadPreviewGeneration: 1,
          roadMutationPreview: previewResponse({
            generation: 1,
            changedTiles: [{ x: 3, y: 2 }],
            skippedTiles: [{ x: 2, y: 2 }],
            cost: 100,
          }),
        },
        "cursorBadge",
      )[0];
      expect(accepted?.text).toBe("⦿ Road · $100");
      expect(accepted?.tone).toBeUndefined();
    });

    it("shows the Rust rejection instead of the nominal cost and local glyph", () => {
      const state = createTestGameState();
      const items = itemsOfKind(
        state,
        {
          ...previewUi(
            previewResponse({
              cost: 500,
              rejection: { code: "blockedTile", context: {} },
            }),
          ),
        },
        "cursorBadge",
      );

      expect(items[0]?.text).toBe("⦿ Road · That tile is blocked. ⊘");
      expect(items[0]?.text).not.toContain("$500");
      expect(items[0]?.a11yText).toBe(
        "Road, That tile is blocked. Cannot place.",
      );
      expect(items[0]?.tone).toBe("warning");
    });

    it("suppresses idle remove rejections but shows them during a remove drag", () => {
      const state = createTestGameState();
      const rejected = previewResponse({
        rejection: { code: "blockedTile", context: {} },
      });
      const idleUi: UiState = {
        ...createUiState(),
        activeTool: "remove",
        hoverTile: { x: 2, y: 2 },
        roadPreviewGeneration: rejected.generation,
        roadMutationPreview: rejected,
      };
      expect(itemsOfKind(state, idleUi, "cursorBadge")[0]).toEqual({
        kind: "cursorBadge",
        anchor: { x: 2, y: 2 },
        text: "⦿ Demolish",
        a11yText: "Demolish",
      });

      const duringDrag = itemsOfKind(
        state,
        {
          ...idleUi,
          drag: {
            tool: "remove",
            start: { x: 1, y: 2 },
            current: { x: 2, y: 2 },
          },
        },
        "cursorBadge",
      )[0];
      expect(duringDrag?.text).toBe("⦿ Demolish · That tile is blocked. ⊘");
      expect(duringDrag?.a11yText).toBe(
        "Demolish, That tile is blocked. Cannot place.",
      );
      expect(duringDrag?.tone).toBe("warning");

      const acceptedRemoval = itemsOfKind(
        state,
        {
          ...idleUi,
          roadMutationPreview: previewResponse({
            generation: rejected.generation,
            changedTiles: [{ x: 2, y: 2 }],
            cost: 50,
          }),
        },
        "cursorBadge",
      )[0];
      expect(acceptedRemoval?.text).toBe("⦿ Demolish · $50");
    });

    it("shows Free for accepted previews in Creative economy", () => {
      const base = createTestGameState();
      const state = {
        ...base,
        rules: { ...base.rules, economyPreset: "creative" as const },
      };
      const items = itemsOfKind(
        state,
        previewUi(
          previewResponse({ changedTiles: [{ x: 2, y: 2 }], cost: 500 }),
        ),
        "cursorBadge",
      );

      expect(items[0]?.text).toBe("⦿ Road · Free");
      expect(items[0]?.text).not.toContain("$500");
      expect(items[0]?.a11yText).toBe("Road, Free");
    });
  });

  describe("route failure items", () => {
    function leg(
      from: string,
      to: string,
      status: RouteLegPath["status"],
      lastValidPath: TransitPath | null = null,
    ): RouteLegPath {
      return {
        fromWaypointId: from,
        toWaypointId: to,
        direction: "loop",
        kind: "service",
        status,
        currentPath: null,
        lastValidPath,
        estimatedSeconds: null,
        failureReason:
          status === "networkDisconnected" ? "networkDisconnected" : null,
      };
    }

    function routeState(
      legs: RouteLegPath[],
      stopIds: string[] = ["a", "b"],
    ): GameState {
      const state = createTestGameState();
      return {
        ...state,
        transit: {
          ...state.transit,
          stops: ["a", "b"].map((id, index) => ({
            id,
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 1 + index * 4, y: 1 },
            platforms: [],
          })),
          routes: [
            {
              id: "route-001",
              name: "Route 1",
              color: "#e04f39",
              stopIds,
              vehicleIds: [],
              active: true,
              pattern: "loop" as const,
              revision: 1,
              legs,
              pathBroken: legs.some((entry) => entry.status !== "connected"),
              targetHeadwaySeconds: null,
              serviceMetrics: null,
            },
          ],
        },
      };
    }

    it("emits nothing when the selected route does not exist", () => {
      const state = routeState([leg("a", "b", "networkDisconnected")]);
      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-999" },
        "routeFailure",
      );
      expect(items).toHaveLength(0);
    });

    it("skips connected legs and legs whose endpoints are all gone", () => {
      const state = routeState([
        {
          ...leg("a", "b", "connected"),
          currentPath: markerPath({ x: 1, y: 1 }, { x: 5, y: 1 }),
        },
        leg("ghost-from", "ghost-to", "networkDisconnected"),
      ]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      // The connected leg is fine; the failed leg has no anchor at all.
      expect(items).toHaveLength(0);
    });

    it("anchors a no-path failure at the endpoint midpoint", () => {
      const state = routeState([leg("a", "b", "networkDisconnected")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      // Stops a (1,1) and b (5,1) average to (3,1).
      expect(items[0]?.anchor).toEqual({ x: 3, y: 1 });
    });

    it("anchors on the remaining endpoint when the other is gone", () => {
      const state = routeState([leg("ghost", "b", "networkDisconnected")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 5, y: 1 });
    });

    it("anchors on the from-node when the to-node left the network", () => {
      const state = routeState([leg("a", "ghost", "networkDisconnected")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 1, y: 1 });
    });

    it("anchors a missing-node leg on the present endpoint when neither side is flagged missing", () => {
      // The leg reports a missing node but both stops are still present in the
      // network (stale leg data): fall back to the authored endpoints.
      const state = routeState([leg("a", "b", "missingNode")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 1, y: 1 });
    });

    it("anchors on the to-node when the from-node left the network", () => {
      const state = routeState([leg("ghost", "b", "missingNode")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 5, y: 1 });
    });

    it("anchors a missing-node leg on the missing from-node", () => {
      const base = routeState([leg("a", "b", "missingNode")]);
      const state: GameState = {
        ...base,
        transit: {
          ...base.transit,
          stops: base.transit.stops.map((stop) =>
            stop.id === "a" ? { ...stop, status: "missing" as const } : stop,
          ),
        },
      };

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      // The flagged-missing endpoint is where the player must act.
      expect(items[0]?.anchor).toEqual({ x: 1, y: 1 });
    });

    it("skips a missing-node leg whose endpoints both left the network", () => {
      const state = routeState([leg("ghost-a", "ghost-b", "missingNode")]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items).toHaveLength(0);
    });

    it("anchors a missing-station leg on the station for metro lines", () => {
      let state = createTestGameState();
      state = addTestMetroStation(state, { x: 2, y: 8 });
      state = addTestMetroStation(state, { x: 6, y: 8 });
      const [stationA, stationB] = state.transit.stations.map(
        (station) => station.id,
      );
      state = {
        ...state,
        transit: {
          ...state.transit,
          stations: state.transit.stations.map((station) =>
            station.id === stationB
              ? { ...station, status: "missing" as const }
              : station,
          ),
          metroLines: [
            {
              id: "metro-001",
              name: "Metro 1",
              color: "#3355aa",
              stationIds: [stationA!, stationB!],
              vehicleIds: [],
              active: true,
              pattern: "loop" as const,
              revision: 1,
              legs: [leg(stationA!, stationB!, "missingNode")],
              pathBroken: true,
              targetHeadwaySeconds: null,
              serviceMetrics: null,
            },
          ],
        },
      };

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "metro-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 6, y: 8 });
    });

    it("anchors a zero-duration last-valid step at its geometry midpoint", () => {
      const path: TransitPath = {
        kind: "road",
        steps: [
          {
            position: { x: 1, y: 1 },
            enteringHeading: "east",
            leavingHeading: "east",
            movement: "straight",
            geometry: {
              kind: "line",
              from: { x: 1, y: 1 },
              to: { x: 5, y: 1 },
            },
            travelSeconds: 0,
          },
        ],
        totalTravelSeconds: 0,
      };
      const state = routeState([leg("a", "b", "networkDisconnected", path)]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items[0]?.anchor).toEqual({ x: 3, y: 1 });
    });

    it("skips a failed leg whose last-valid path has no steps", () => {
      const emptyPath: TransitPath = {
        kind: "road",
        steps: [],
        totalTravelSeconds: 0,
      };
      const state = routeState([
        leg("a", "b", "networkDisconnected", emptyPath),
      ]);

      const items = itemsOfKind(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        "routeFailure",
      );

      expect(items).toHaveLength(0);
    });
  });

  it("anchors failure guidance at the last-valid path midpoint", () => {
    const state = createTestGameState();
    const routeState = {
      ...state,
      transit: {
        ...state.transit,
        stops: [
          {
            id: "a",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 1, y: 1 },
            platforms: [],
          },
          {
            id: "b",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 6, y: 1 },
            platforms: [],
          },
        ],
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["a", "b"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [
              {
                fromWaypointId: "b",
                toWaypointId: "a",
                direction: "loop" as const,
                kind: "service" as const,
                status: "networkDisconnected" as const,
                currentPath: null,
                lastValidPath: markerPath({ x: 6, y: 1 }, { x: 1, y: 1 }),
                estimatedSeconds: null,
                failureReason: "networkDisconnected" as const,
              },
            ],
            pathBroken: true,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const ui = {
      ...createUiState(),
      selectedRouteId: "route-001",
    };

    const items = itemsOfKind(routeState, ui, "routeFailure");

    expect(items).toEqual([
      {
        kind: "routeFailure",
        anchor: { x: 3.5, y: 1 },
        text: "Loop can't close here; remove a stop or switch to Shuttle.",
      },
    ]);
  });
});
