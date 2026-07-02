import { describe, expect, it } from "vitest";
import {
  appendDraftStation,
  appendDraftStop,
  cancelDraftRoute,
  closingLoopIsPathable,
  removeDraftNode,
  resolveStationAtTile,
  resolveStopAtTile,
} from "../../src/ui/routeDraft";
import { createUiState, type UiState } from "../../src/ui/uiState";
import {
  addTestBusStop,
  addTestMetroStation,
  createTestGameState,
  placeTestBuilding,
} from "../helpers/gameState";
import { pointsOnRow, withRoads, withTracks } from "../helpers/mapFixtures";

describe("resolveStopAtTile", () => {
  it("returns the exact stop at the tile", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    expect(resolveStopAtTile(state, { x: 7, y: 8 })?.id).toBe("stop-001");
  });

  it("resolves a stop via a busStop building's occupied tile", () => {
    // A busStop building occupies its origin tile and links to a transit stop;
    // clicking any occupied tile should resolve to that stop even when no stop
    // is positioned exactly on the clicked tile.
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = placeTestBuilding(state, "busStop", { x: 7, y: 8 }, 0);
    // The building's transitNodeId points at the auto-created stop at (7,8).
    const stop = resolveStopAtTile(state, { x: 7, y: 8 });
    expect(stop).toBeDefined();
    expect(stop?.id).toBe("stop-001");
  });

  it("resolves a stop via a busTerminal building's occupied tile", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = placeTestBuilding(state, "busTerminal", { x: 7, y: 8 }, 0);
    const stop = resolveStopAtTile(state, { x: 7, y: 8 });
    expect(stop?.id).toBe("stop-001");
    expect(stop?.kind).toBe("busTerminal");
  });

  it("returns undefined when no stop or stop-building sits at the tile", () => {
    const state = createTestGameState();
    expect(resolveStopAtTile(state, { x: 1, y: 1 })).toBeUndefined();
  });

  it("does not resolve a metro station as a stop", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    expect(resolveStopAtTile(state, { x: 3, y: 0 })).toBeUndefined();
  });
});

describe("resolveStationAtTile", () => {
  it("returns the exact station at the tile", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    expect(resolveStationAtTile(state, { x: 3, y: 0 })?.id).toBe("station-001");
  });

  it("resolves a station via a metroStation building's occupied tile", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = withRoads(state, [{ x: 3, y: 0 }]);
    state = placeTestBuilding(state, "metroStation", { x: 3, y: 0 }, 0);
    const station = resolveStationAtTile(state, { x: 3, y: 0 });
    expect(station?.id).toBe("station-001");
  });

  it("returns undefined when no station sits at the tile", () => {
    const state = createTestGameState();
    expect(resolveStationAtTile(state, { x: 1, y: 1 })).toBeUndefined();
  });

  it("does not resolve a bus stop as a station", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    expect(resolveStationAtTile(state, { x: 7, y: 8 })).toBeUndefined();
  });
});

describe("appendDraftStop / appendDraftStation", () => {
  it("appends the first stop id and leaves paths empty", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    const ui = { ...createUiState(), activeTool: "busRoute" as const };
    const next = appendDraftStop(state, ui, state.transit.stops[0]);
    expect(next.draftStopIds).toEqual(["stop-001"]);
    expect(next.draftStopPaths).toEqual([]);
  });

  it("appends a second stop and computes the connecting path", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    let ui: UiState = { ...createUiState(), activeTool: "busRoute" as const };
    ui = appendDraftStop(state, ui, state.transit.stops[0]);
    const next = appendDraftStop(state, ui, state.transit.stops[1]);
    expect(next.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(next.draftStopPaths).toHaveLength(1);
    expect(next.draftStopPaths[0].length).toBeGreaterThan(1);
  });

  it("is a no-op when the same stop is appended twice in a row", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    const ui = { ...createUiState(), activeTool: "busRoute" as const };
    const first = appendDraftStop(state, ui, state.transit.stops[0]);
    const second = appendDraftStop(state, first, state.transit.stops[0]);
    expect(second).toBe(first);
  });

  it("does not append when no road path connects the two stops", () => {
    // Two stops with no road between them: findTilePath returns null and the
    // draft is left unchanged.
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    let ui: UiState = { ...createUiState(), activeTool: "busRoute" as const };
    ui = appendDraftStop(state, ui, state.transit.stops[0]);
    const next = appendDraftStop(state, ui, state.transit.stops[1]);
    expect(next).toBe(ui);
    expect(next.draftStopIds).toEqual(["stop-001"]);
  });

  it("appends metro stations and computes a track-based path", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    state = addTestMetroStation(state, { x: 9, y: 0 });
    let ui: UiState = { ...createUiState(), activeTool: "metroLine" as const };
    ui = appendDraftStation(state, ui, state.transit.stations[0]);
    const next = appendDraftStation(state, ui, state.transit.stations[1]);
    expect(next.draftStationIds).toEqual(["station-001", "station-002"]);
    expect(next.draftStationPaths).toHaveLength(1);
  });

  it("bails when the previous draft node no longer exists", () => {
    // The previous id points at a node that no longer exists; findTilePath
    // cannot resolve a previous position so the path is null and the draft is
    // returned unchanged (the stale id is preserved, not silently dropped).
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-999"],
    };
    const next = appendDraftStop(state, ui, state.transit.stops[1]);
    expect(next).toBe(ui);
    expect(next.draftStopIds).toEqual(["stop-999"]);
  });
});

describe("removeDraftNode", () => {
  function twoStopDraft() {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    state = addTestBusStop(state, { x: 12, y: 8 });
    let ui: UiState = { ...createUiState(), activeTool: "busRoute" as const };
    ui = appendDraftStop(state, ui, state.transit.stops[0]);
    ui = appendDraftStop(state, ui, state.transit.stops[1]);
    ui = appendDraftStop(state, ui, state.transit.stops[2]);
    return { state, ui };
  }

  it("is a no-op when the active tool is neither busRoute nor metroLine", () => {
    const { state, ui } = twoStopDraft();
    const nonRouteUi = { ...ui, activeTool: "inspect" as const };
    const next = removeDraftNode(state, nonRouteUi, 0);
    expect(next).toBe(nonRouteUi);
  });

  it("is a no-op for an out-of-range index", () => {
    const { state, ui } = twoStopDraft();
    expect(removeDraftNode(state, ui, -1)).toBe(ui);
    expect(removeDraftNode(state, ui, 99)).toBe(ui);
  });

  it("removes the first node and drops the leading path", () => {
    const { state, ui } = twoStopDraft();
    const next = removeDraftNode(state, ui, 0);
    expect(next.draftStopIds).toEqual(["stop-002", "stop-003"]);
    // The first path (stop-001 -> stop-002) is dropped; one path remains.
    expect(next.draftStopPaths).toHaveLength(1);
  });

  it("removes the last node and drops the trailing path", () => {
    const { state, ui } = twoStopDraft();
    const next = removeDraftNode(state, ui, 2);
    expect(next.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(next.draftStopPaths).toHaveLength(1);
  });

  it("removes a middle node and re-bridges its neighbors", () => {
    const { state, ui } = twoStopDraft();
    expect(ui.draftStopIds).toEqual(["stop-001", "stop-002", "stop-003"]);
    const next = removeDraftNode(state, ui, 1);
    expect(next.draftStopIds).toEqual(["stop-001", "stop-003"]);
    // The two surrounding paths merge into one re-bridged path.
    expect(next.draftStopPaths).toHaveLength(1);
  });

  it("leaves the draft unchanged when the re-bridge path is broken", () => {
    // Break the road between the neighbors of the middle node so the merged
    // path cannot be found; removeDraftNode must bail and keep the draft.
    const { state, ui } = twoStopDraft();
    // Remove all road tiles between stop-001 (7,8) and stop-003 (12,8) except
    // the ones adjacent to stop-002 so the original draft was valid, but the
    // direct 001->003 bridge is not. Simpler: clear the road at (10,8) which
    // sits on the 001->003 corridor.
    const brokenMap = {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === 10 && tile.y === 8
          ? { ...tile, kind: "empty" as const }
          : tile,
      ),
    };
    const brokenState = { ...state, map: brokenMap };
    const next = removeDraftNode(brokenState, ui, 1);
    expect(next).toBe(ui);
    expect(next.draftStopIds).toEqual(["stop-001", "stop-002", "stop-003"]);
  });

  it("removes a metro draft node", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    state = addTestMetroStation(state, { x: 6, y: 0 });
    state = addTestMetroStation(state, { x: 9, y: 0 });
    let ui: UiState = { ...createUiState(), activeTool: "metroLine" as const };
    ui = appendDraftStation(state, ui, state.transit.stations[0]);
    ui = appendDraftStation(state, ui, state.transit.stations[1]);
    ui = appendDraftStation(state, ui, state.transit.stations[2]);
    const next = removeDraftNode(state, ui, 1);
    expect(next.draftStationIds).toEqual(["station-001", "station-003"]);
    expect(next.draftStationPaths).toHaveLength(1);
  });

  it("leaves the draft unchanged when a middle node's neighbor no longer exists", () => {
    // When the before/after neighbors of a middle node can't be found in the
    // transit stops, the merged path is null and removeDraftNode bails.
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 12, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    let ui: UiState = { ...createUiState(), activeTool: "busRoute" as const };
    ui = appendDraftStop(state, ui, state.transit.stops[0]);
    ui = appendDraftStop(state, ui, state.transit.stops[1]);
    ui = appendDraftStop(state, ui, state.transit.stops[2]);
    // Remove stop-001 from the state so the `before` neighbor lookup fails for
    // index 1 (ids[0] === "stop-001" no longer exists in transit.stops).
    const reducedState = {
      ...state,
      transit: {
        ...state.transit,
        stops: state.transit.stops.filter((s) => s.id !== "stop-001"),
      },
    };
    const next = removeDraftNode(reducedState, ui, 1);
    expect(next).toBe(ui);
    expect(next.draftStopIds).toEqual(["stop-001", "stop-002", "stop-003"]);
  });
});

describe("cancelDraftRoute", () => {
  it("clears all bus draft fields", () => {
    const ui = {
      ...createUiState(),
      draftStopIds: ["stop-001", "stop-002"],
      draftStopPaths: [[{ x: 1, y: 1 }]],
    };
    const next = cancelDraftRoute(ui);
    expect(next.draftStopIds).toEqual([]);
    expect(next.draftStopPaths).toEqual([]);
  });

  it("clears all metro draft fields", () => {
    const ui = {
      ...createUiState(),
      draftStationIds: ["station-001"],
      draftStationPaths: [[{ x: 1, y: 1 }]],
    };
    const next = cancelDraftRoute(ui);
    expect(next.draftStationIds).toEqual([]);
    expect(next.draftStationPaths).toEqual([]);
  });

  it("is a no-op when there is no draft", () => {
    const ui = createUiState();
    expect(cancelDraftRoute(ui)).toBe(ui);
  });
});

describe("closingLoopIsPathable", () => {
  it("returns true when fewer than two nodes are drafted", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
    };
    expect(closingLoopIsPathable(state, ui)).toBe(true);
  });

  it("returns true when the active tool is not a route tool", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), activeTool: "inspect" as const };
    expect(closingLoopIsPathable(state, ui)).toBe(true);
  });

  it("returns true when the closing loop has a pathable road back", () => {
    // Two stops on the same road row: the last->first segment is pathable.
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(closingLoopIsPathable(state, ui)).toBe(true);
  });

  it("returns false when the closing loop cannot be pathed under one-way roads", () => {
    // A one-way east road from 7->15 makes the forward 001->002 path valid,
    // but the closing 002->001 segment against the one-way direction is not.
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    // Mark the corridor one-way east.
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.y === 8 && tile.x >= 7 && tile.x <= 15
            ? { ...tile, oneWay: "east" as const }
            : tile,
        ),
      },
    };
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(closingLoopIsPathable(state, ui)).toBe(false);
  });

  it("returns false when a drafted node id no longer exists", () => {
    // A missing first/last node means the closing loop cannot be verified, so
    // the guard rejects early rather than deferring to finishRoute().
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(closingLoopIsPathable(state, ui)).toBe(false);
  });

  it("validates a metro line closing loop over track", () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    state = addTestMetroStation(state, { x: 9, y: 0 });
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001", "station-002"],
    };
    expect(closingLoopIsPathable(state, ui)).toBe(true);
  });
});
