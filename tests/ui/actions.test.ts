import { describe, expect, it } from "vitest";
import type {
  GameplayRejection,
  GameState,
  Point,
} from "../../src/domain/types";
import {
  applyUiTileClick,
  cancelDraftRoute,
  draftHandleIndexAtPoint,
  resolveNodeAtTile,
  resolveNodesAtTile,
} from "../../src/ui/actions";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft, selectWaypoint } from "../../src/ui/routeDraft";
import {
  addTestBusStop,
  addTestMetroStation,
  createTestGameState,
  placeTestBuilding,
} from "../helpers/gameState";
import { pointsOnRow, withRoads, withTracks } from "../helpers/mapFixtures";

function withColocatedStopAndStation(
  state: GameState,
  point: Point,
): GameState {
  return {
    ...state,
    transit: {
      ...state.transit,
      stops: [
        ...state.transit.stops,
        {
          id: "stop-001",
          kind: "busStop",
          status: "present",
          position: { ...point },
          platforms: [
            { id: "stop-001-p0", label: "A", capacity: 50, routeIds: [] },
          ],
        },
      ],
      stations: [
        ...state.transit.stations,
        {
          id: "station-001",
          status: "present",
          position: { ...point },
          platforms: [
            { id: "station-001-p0", label: "A", capacity: 300, routeIds: [] },
            { id: "station-001-p1", label: "B", capacity: 300, routeIds: [] },
          ],
        },
      ],
    },
  };
}

describe("resolveNodeAtTile", () => {
  it("resolves a bus stop at its exact tile", () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 2 }]);
    state = addTestBusStop(state, { x: 7, y: 2 });

    const resolved = resolveNodeAtTile(state, { x: 7, y: 2 });

    expect(resolved?.kind).toBe("stop");
    expect(resolved?.node.id).toBe(state.transit.stops[0].id);
  });

  it("resolves a metro station at its exact tile", () => {
    let state = createTestGameState();
    state = withTracks(state, [{ x: 22, y: 2 }]);
    state = addTestMetroStation(state, { x: 22, y: 2 });

    const resolved = resolveNodeAtTile(state, { x: 22, y: 2 });

    expect(resolved?.kind).toBe("station");
    expect(resolved?.node.id).toBe(state.transit.stations[0].id);
  });

  it("resolves a building-backed transit node via a non-origin occupied tile", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "busTerminal", { x: 0, y: 0 }, 0);

    const building = state.buildings[0];
    const nodePosition = state.transit.stops.find(
      (stop) => stop.id === building.transitNodeId,
    )!.position;
    const footprintTile = building.occupiedTiles.find(
      (tile) => !(tile.x === nodePosition.x && tile.y === nodePosition.y),
    )!;

    const resolved = resolveNodeAtTile(state, footprintTile);

    expect(resolved?.kind).toBe("stop");
    expect(resolved?.node.id).toBe(building.transitNodeId);
  });

  it("returns null on an empty tile", () => {
    expect(resolveNodeAtTile(createTestGameState(), { x: 0, y: 0 })).toBeNull();
  });

  it("does not resolve a missing node for routing or inspection", () => {
    let state = addTestBusStop(createTestGameState(), { x: 7, y: 2 });
    state = {
      ...state,
      transit: {
        ...state.transit,
        stops: state.transit.stops.map((stop) => ({
          ...stop,
          status: "missing" as const,
        })),
      },
    };

    expect(resolveNodeAtTile(state, { x: 7, y: 2 })).toBeNull();
    expect(resolveNodesAtTile(state, { x: 7, y: 2 })).toEqual([]);
  });

  it("honors the preferred node kind on a co-located tile", () => {
    const state = withColocatedStopAndStation(createTestGameState(), {
      x: 7,
      y: 2,
    });

    expect(resolveNodeAtTile(state, { x: 7, y: 2 }, "station")?.kind).toBe(
      "station",
    );
    expect(resolveNodeAtTile(state, { x: 7, y: 2 }, "stop")?.kind).toBe("stop");
  });
});

describe("resolveNodesAtTile", () => {
  it("returns both nodes when a stop and station share a tile", () => {
    const state = withColocatedStopAndStation(createTestGameState(), {
      x: 7,
      y: 2,
    });

    const nodes = resolveNodesAtTile(state, { x: 7, y: 2 });

    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.kind).sort()).toEqual(["station", "stop"]);
  });
});

describe("applyUiTileClick inspect", () => {
  it("opens the inspect drawer when a node is clicked", () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 });
    const ui = { ...createUiState(), activeTool: "inspect" as const };

    const result = applyUiTileClick(state, ui, { x: 7, y: 7 });

    expect(result.state).toBe(state);
    expect(result.ui.activeHudCategory).toBe("inspect");
    expect(result.ui.selectedId).toBe("7,7");
    expect(result.ui.selectedNodeKind).toBe("stop");
  });

  it("selects empty tiles and closes an open inspect drawer", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      activeHudCategory: "inspect" as const,
    };

    const result = applyUiTileClick(state, ui, { x: 0, y: 0 });

    expect(result.state).toBe(state);
    expect(result.ui.selectedId).toBe("0,0");
    expect(result.ui.selectedNodeKind).toBeNull();
    expect(result.ui.activeHudCategory).toBeNull();
  });

  it("cycles co-located node kinds on repeated clicks", () => {
    const state = withColocatedStopAndStation(createTestGameState(), {
      x: 7,
      y: 2,
    });
    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "7,2",
      selectedNodeKind: "stop" as const,
    };

    const result = applyUiTileClick(state, ui, { x: 7, y: 2 });

    expect(result.ui.selectedNodeKind).toBe("station");
  });
});

describe("applyUiTileClick route drafts", () => {
  function busDraftState(): { state: GameState; ui: UiState } {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    return {
      state,
      ui: {
        ...createUiState(),
        activeTool: "busRoute" as const,
        routeDraft: createDraft("bus", 1),
      },
    };
  }

  it("accumulates bus route stops without mutating state", () => {
    const { state, ui } = busDraftState();

    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(result.state, result.ui, { x: 15, y: 8 });

    expect(result.state).toBe(state);
    expect(result.state.transit.routes).toEqual([]);
    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001", "stop-002"]);
    expect(result.ui.routeDraft?.previewPending).toBe(true);
  });

  it("preserves the draft when clicking the repeated final stop", () => {
    const { state, ui } = busDraftState();

    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    const first = result.ui;
    result = applyUiTileClick(state, first, { x: 7, y: 8 });

    expect(result.ui).toBe(first);
    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001"]);
  });

  it("selects an existing waypoint for a duplicate compatible node click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    const selectedUi = {
      ...result.ui,
      routeDraft: selectWaypoint(result.ui.routeDraft!, 0, "replace"),
    };

    result = applyUiTileClick(state, selectedUi, { x: 15, y: 8 });

    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001", "stop-002"]);
    expect(result.ui.routeDraft?.selectedIndex).toBe(1);
  });

  it("preserves preview and host errors on a generation-stable selection click", () => {
    const { state, ui } = busDraftState();
    // Build a draft with two waypoints, then click a duplicate to trigger a
    // selection-only (generation-stable) update.
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    const previewError: GameplayRejection = {
      code: "disconnectedLeg",
      context: { affectedRouteIds: [] },
    };
    const uiWithErrors: UiState = {
      ...result.ui,
      routePreviewError: previewError,
      routePreviewHostError: "backend unreachable",
    };

    // Clicking stop-001 (not the last waypoint) in append mode selects it
    // without bumping generation (append + existing waypoint → selectWaypoint).
    result = applyUiTileClick(state, uiWithErrors, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.selectedIndex).toBe(0);
    expect(result.ui.routeDraft?.generation).toBe(
      uiWithErrors.routeDraft!.generation,
    );
    expect(result.ui.routePreviewError).toBe(previewError);
    expect(result.ui.routePreviewHostError).toBe("backend unreachable");
  });

  it("clears a stale invalidRouteDraftInteraction error on a successful selection click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    const uiWithInteractionError: UiState = {
      ...result.ui,
      routePreviewError: {
        code: "invalidRouteDraftInteraction",
        context: { operation: "selectWaypoint", waypointIndex: 99 },
      },
    };

    // Clicking stop-001 (not the last waypoint) selects it (generation-stable)
    // and resolves the stale interaction error.
    result = applyUiTileClick(state, uiWithInteractionError, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.selectedIndex).toBe(0);
    expect(result.ui.routePreviewError).toBeNull();
  });

  it("clears a stale incompatibleRouteNode error on a successful compatible selection click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    // Simulate a prior incompatible click that stored an
    // incompatibleRouteNode rejection without changing the draft.
    const uiWithIncompatibleError: UiState = {
      ...result.ui,
      routePreviewError: {
        code: "incompatibleRouteNode",
        context: { nodeId: "station-001", affectedRouteIds: [] },
      },
    };

    // Clicking stop-001 (an existing waypoint) in append mode selects it
    // (generation-stable) — the stale incompatible rejection must clear so
    // Save is not left disabled by a click the user has since corrected.
    result = applyUiTileClick(state, uiWithIncompatibleError, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.selectedIndex).toBe(0);
    expect(result.ui.routeDraft?.generation).toBe(
      uiWithIncompatibleError.routeDraft!.generation,
    );
    expect(result.ui.routePreviewError).toBeNull();
  });

  it("clears a stale missingRouteNode error on a successful compatible selection click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    const uiWithMissingError: UiState = {
      ...result.ui,
      routePreviewError: {
        code: "missingRouteNode",
        context: { nodeId: "stop-999", affectedRouteIds: [] },
      },
    };

    result = applyUiTileClick(state, uiWithMissingError, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.selectedIndex).toBe(0);
    expect(result.ui.routePreviewError).toBeNull();
  });

  it("preserves a persistent routeChangedWhileEditing error on a generation-stable selection click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });
    const persistentError: GameplayRejection = {
      code: "routeChangedWhileEditing",
      context: { routeId: "route-001", affectedRouteIds: ["route-001"] },
    };
    const uiWithPersistentError: UiState = {
      ...result.ui,
      routePreviewError: persistentError,
    };

    result = applyUiTileClick(state, uiWithPersistentError, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.selectedIndex).toBe(0);
    expect(result.ui.routePreviewError).toBe(persistentError);
  });

  it("replaces the preview error with a new interaction rejection on an incompatible node click", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    // Place a metro station on a tile with no bus stop so the resolver falls
    // back to the station (mode-incompatible for a bus route draft).
    const stateWithStation = addTestMetroStation(state, { x: 12, y: 8 });
    const uiWithPreviewError: UiState = {
      ...result.ui,
      routePreviewError: {
        code: "disconnectedLeg",
        context: { affectedRouteIds: [] },
      },
    };

    // In bus mode, preferredKind is "stop"; with no stop at this tile the
    // resolver falls back to the station, which is mode-incompatible. The
    // draft is unchanged (generation-stable) but a new rejection is produced.
    result = applyUiTileClick(stateWithStation, uiWithPreviewError, {
      x: 12,
      y: 8,
    });

    expect(result.ui.routePreviewError?.code).toBe("incompatibleRouteNode");
  });

  it("propagates a duplicate insertion notice through the UI state", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    const insertAfter = {
      ...result.ui,
      routeDraft: selectWaypoint(result.ui.routeDraft!, 0, "insertAfter"),
    };

    result = applyUiTileClick(state, insertAfter, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001"]);
    expect(result.ui.routeDraftNotice).toEqual({
      kind: "alreadyOnRoute",
      waypointId: "stop-001",
    });
  });

  it("appends before Rust reports that the next leg is disconnected", () => {
    let state = createTestGameState();
    state = withRoads(state, [
      { x: 1, y: 4 },
      { x: 9, y: 4 },
    ]);
    state = addTestBusStop(state, { x: 1, y: 4 });
    state = addTestBusStop(state, { x: 9, y: 4 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: createDraft("bus", 1),
    };

    let result = applyUiTileClick(state, ui, { x: 1, y: 4 });
    result = applyUiTileClick(state, result.ui, { x: 9, y: 4 });

    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001", "stop-002"]);
  });

  it("accumulates metro line stations without mutating state", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(8, 7, 15));
    state = addTestMetroStation(state, { x: 7, y: 8 });
    state = addTestMetroStation(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      routeDraft: createDraft("metro", 1),
    };

    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(result.state, result.ui, { x: 15, y: 8 });

    expect(result.state).toBe(state);
    expect(result.state.transit.metroLines).toEqual([]);
    expect(result.ui.routeDraft?.waypointIds).toEqual([
      "station-001",
      "station-002",
    ]);
  });

  it("cancels both drafts", () => {
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001"],
      },
    };

    const next = cancelDraftRoute(ui);

    expect(next.routeDraft).toBeNull();
  });
});

describe("draftHandleIndexAtPoint", () => {
  it("resolves a retained missing waypoint by its exact anchor", () => {
    let state = addTestBusStop(createTestGameState(), { x: 6, y: 4 });
    state = {
      ...state,
      transit: {
        ...state.transit,
        stops: state.transit.stops.map((node) => ({
          ...node,
          status: "missing" as const,
        })),
      },
    };
    const draft = {
      ...createDraft("bus", 1),
      source: {
        kind: "edit" as const,
        routeId: "route-001",
        expectedRevision: 1,
      },
      waypointIds: ["stop-other", "stop-001"],
    };

    expect(draftHandleIndexAtPoint(draft, state, { x: 6, y: 4 })).toBe(1);
  });
});

describe("applyUiTileClick gameplay tools", () => {
  it("does not mutate state for Rust-authoritative gameplay tools", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
    };

    const result = applyUiTileClick(state, ui, { x: 8, y: 7 });

    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });
});
