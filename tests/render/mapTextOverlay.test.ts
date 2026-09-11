import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { selectMapTextOverlayItems } from "../../src/render/mapTextOverlay";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import { addTestBusStop, createTestGameState } from "../helpers/gameState";
import { withRoads } from "../helpers/mapFixtures";
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
