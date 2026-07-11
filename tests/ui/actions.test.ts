import { describe, expect, it } from "vitest";
import type { GameState, Point } from "../../src/domain/types";
import {
  applyUiTileClick,
  cancelDraftRoute,
  removeDraftNode,
  resolveNodeAtTile,
  resolveNodesAtTile,
} from "../../src/ui/actions";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
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

  it("optimistically appends a repeated final stop for Rust to validate", () => {
    const { state, ui } = busDraftState();

    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 7, y: 8 });

    expect(result.ui.routeDraft?.waypointIds).toEqual(["stop-001", "stop-001"]);
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

  it("removes draft nodes by index and keeps paths in sync", () => {
    const { state, ui } = busDraftState();
    let result = applyUiTileClick(state, ui, { x: 7, y: 8 });
    result = applyUiTileClick(state, result.ui, { x: 15, y: 8 });

    const next = removeDraftNode(state, result.ui, 0);

    expect(next.routeDraft?.waypointIds).toEqual(["stop-002"]);
    expect(next.routeDraft?.preview).toBeNull();
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
