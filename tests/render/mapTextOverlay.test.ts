import { describe, expect, it } from "vitest";
import type {
  GameState,
  RoadStructure,
  RouteLegPath,
} from "../../src/domain/types";
import { selectMapTextOverlayItems } from "../../src/render/mapTextOverlay";
import type { RoadMutationPreviewResponse } from "../../src/runtime/backend/types";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import {
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
  it("derives the cursor badge wording and aboveOrBelow placement", () => {
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
        placement: "aboveOrBelow",
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
        placement: "aboveOrBelow",
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

  it("derives the road preview feedback label from the Rust response", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
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

    const items = itemsOfKind(state, ui, "roadPreview");

    expect(items).toEqual([
      {
        kind: "roadPreview",
        anchor: { x: 5, y: 6 },
        text: "$500 · route-a rerouted · route-z broken",
      },
    ]);
  });

  it("emits no road preview item when the preview is stale", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 1,
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

    expect(itemsOfKind(state, ui, "roadPreview")).toHaveLength(0);
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
        )[0]?.text,
      ).toBe("⦿ Roundabout 2×2 …");
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
            rejection: { code: "insufficientBudget", context: {} },
          }),
        },
        "cursorBadge",
      );
      expect(rejected[0]?.text).toBe("⦿ Roundabout 3×3 ⊘");
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

  describe("road preview item", () => {
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
        roadPreviewGeneration: preview.generation,
        roadMutationPreview: preview,
      };
    }

    it("anchors on the first authored tile before changed tiles", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            authoredTiles: [
              {
                point: { x: 9, y: 9 },
                roadConnections: ["east"],
              },
            ],
            changedTiles: [{ x: 5, y: 6 }],
          }),
        ),
        "roadPreview",
      );

      expect(items[0]?.anchor).toEqual({ x: 9, y: 9 });
    });

    it("anchors on the first generated structure when no tiles changed", () => {
      const roundabout: RoadStructure = {
        kind: "roundabout",
        id: "rb-1",
        origin: { x: 7, y: 7 },
        size: "compact2x2",
        footprint: [
          { x: 7, y: 7 },
          { x: 8, y: 7 },
          { x: 7, y: 8 },
          { x: 8, y: 8 },
        ],
        ports: [],
      };
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(previewResponse({ generatedStructures: [roundabout] })),
        "roadPreview",
      );

      expect(items[0]?.anchor).toEqual({ x: 7, y: 7 });
    });

    it("falls back to the origin when a rejection preview has no content", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            skippedTiles: [{ x: 5, y: 6 }],
            rejection: { code: "blockedTile", context: {} },
          }),
        ),
        "roadPreview",
      );

      expect(items[0]?.anchor).toEqual({ x: 0, y: 0 });
    });

    it("sorts route impacts by name then kind, keeping stable ties", () => {
      const items = itemsOfKind(
        createTestGameState(),
        previewUi(
          previewResponse({
            changedTiles: [{ x: 1, y: 1 }],
            routeImpacts: [
              { routeId: "route-x", kind: "rerouted" },
              { routeId: "route-x", kind: "broken" },
              { routeId: "route-x", kind: "broken" },
            ],
          }),
        ),
        "roadPreview",
      );

      // Unknown route ids fall back to the id as the display name; equal
      // (name, kind) pairs keep their authored order.
      expect(items[0]?.text).toBe(
        "$0 · route-x broken · route-x broken · route-x rerouted",
      );
    });

    it("sorts route impacts across names and both kind directions", () => {
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
        "roadPreview",
      );

      // Name ordering first, then kind ordering within a name — regardless of
      // authored order.
      expect(items[0]?.text).toBe(
        "$0 · route-a broken · route-a rerouted · route-b broken · route-b rerouted",
      );
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
