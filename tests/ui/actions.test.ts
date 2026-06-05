import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { placeBuilding } from "../../src/simulation/buildings";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
} from "../../src/simulation/transit";
import {
  cancelDraftRoute,
  finishDraftRoute,
  handleTileClick,
  removeDraftStop,
  resolveNodeAtTile,
  resolveNodesAtTile,
} from "../../src/ui/actions";
import { createUiState } from "../../src/ui/uiState";

describe("UI tile actions", () => {
  it("accumulates bus route stops without committing at two stops", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });

    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "busRoute" as const },
      { x: 7, y: 8 },
    );
    result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

    expect(result.ui.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(result.state.transit.routes).toEqual([]);
  });

  it("accumulates a third bus stop into the draft", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });

    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "busRoute" as const },
      { x: 7, y: 8 },
    );
    result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });
    result = handleTileClick(result.state, result.ui, { x: 22, y: 8 });

    expect(result.ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
      "stop-003",
    ]);
  });

  it("ignores clicking the same stop twice in a row", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });

    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "busRoute" as const },
      { x: 7, y: 8 },
    );
    const afterFirst = result.ui;
    result = handleTileClick(result.state, result.ui, { x: 7, y: 8 });

    expect(result.ui.draftStopIds).toEqual(["stop-001"]);
    expect(result.ui).toBe(afterFirst);
  });

  it("accumulates metro line stations without committing", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });

    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "metroLine" as const },
      { x: 7, y: 8 },
    );
    result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

    expect(result.ui.draftStationIds).toEqual(["station-001", "station-002"]);
    expect(result.state.transit.metroLines).toEqual([]);
  });

  it("removes stops and dependent routes at the clicked tile", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");
    const removed = handleTileClick(
      state,
      { ...createUiState(), activeTool: "remove" as const },
      { x: 7, y: 8 },
    );

    expect(removed.state.transit.stops).toEqual([
      {
        id: "stop-002",
        kind: "busStop",
        position: { x: 15, y: 8 },
        platforms: [
          { id: "stop-002-p0", label: "A", capacity: 50, routeIds: [] },
        ],
      },
    ]);
    expect(removed.state.transit.routes).toEqual([]);
    expect(removed.state.transit.vehicles).toEqual([]);
  });

  it("clears selectedRouteId when bulldozing a stop cascades to the selected route's deletion", () => {
    // Regression: previously, handleTileClick(remove) cleared selectedId but
    // NOT selectedRouteId, so the UI held a stale id that no longer pointed
    // at any live route. Selectors tolerated it via live-id matching, which
    // masked the bug.
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      selectedRouteId: "route-001",
    };

    const removed = handleTileClick(state, ui, { x: 7, y: 8 });

    expect(removed.state.transit.routes).toEqual([]);
    expect(removed.ui.selectedRouteId).toBeNull();
  });

  it("preserves selectedRouteId when bulldozing does not affect the selected route", () => {
    // Two routes; bulldoze a stop that only route-001 depends on while
    // route-002 is selected. selectedRouteId must survive.
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]); // route-001 (deleted)
    state = addBusRoute(state, ["stop-002", "stop-003"]); // route-002 (selected)
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      selectedRouteId: "route-002",
    };

    const removed = handleTileClick(state, ui, { x: 7, y: 8 });

    expect(removed.state.transit.routes.map((r) => r.id)).toEqual([
      "route-002",
    ]);
    expect(removed.ui.selectedRouteId).toBe("route-002");
  });

  it("removes stations and dependent metro lines at the clicked tile", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = assignVehicle(state, "metro", "metro-001");
    const removed = handleTileClick(
      state,
      { ...createUiState(), activeTool: "remove" as const },
      { x: 7, y: 8 },
    );

    expect(removed.state.transit.stations).toEqual([
      {
        id: "station-002",
        position: { x: 15, y: 8 },
        platforms: [
          { id: "station-002-p0", label: "A", capacity: 300, routeIds: [] },
          { id: "station-002-p1", label: "B", capacity: 300, routeIds: [] },
        ],
      },
    ]);
    expect(removed.state.transit.metroLines).toEqual([]);
    expect(removed.state.transit.vehicles).toEqual([]);
  });

  it("places a selected building and leaves the UI unchanged", () => {
    const ui = {
      ...createUiState(),
      selectedBuilding: "busTerminal" as const,
      buildingRotation: 90 as const,
    };

    const result = handleTileClick(createInitialGameState(), ui, {
      x: 0,
      y: 0,
    });

    expect(result.ui).toBe(ui);
    expect(result.state.buildings[0]).toMatchObject({
      id: "building-001",
      type: "busTerminal",
      rotation: 90,
      transitNodeId: "stop-001",
    });
  });

  it("removes a whole house building from any occupied tile without removing citizens", () => {
    const added = placeBuilding(
      createInitialGameState(),
      "largeHouse",
      { x: 0, y: 0 },
      0,
    );

    const removed = handleTileClick(
      added,
      { ...createUiState(), activeTool: "remove" as const },
      { x: 2, y: 1 },
    );

    expect(removed.state.buildings).toEqual([]);
    expect(removed.state.citizens).toHaveLength(46);
  });

  it("removes a building transit node and dependent routes and vehicles", () => {
    let state = createInitialGameState();
    state = placeBuilding(state, "busTerminal", { x: 0, y: 0 }, 0);
    state = placeBuilding(state, "busStop", { x: 4, y: 0 }, 0);
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    const removed = handleTileClick(
      state,
      { ...createUiState(), activeTool: "remove" as const },
      { x: 2, y: 1 },
    );

    expect(removed.state.buildings).toHaveLength(1);
    expect(removed.state.buildings[0]?.id).toBe("building-002");
    expect(removed.state.transit.stops).toEqual([
      {
        id: "stop-002",
        kind: "busStop",
        position: { x: 4, y: 0 },
        platforms: [
          { id: "stop-002-p0", label: "A", capacity: 50, routeIds: [] },
        ],
      },
    ]);
    expect(removed.state.transit.routes).toEqual([]);
    expect(removed.state.transit.vehicles).toEqual([]);
  });

  it("drafts bus routes from any occupied terminal tile", () => {
    let state = createInitialGameState();
    state = placeBuilding(state, "busTerminal", { x: 0, y: 0 }, 0);
    state = placeBuilding(state, "busStop", { x: 4, y: 0 }, 0);

    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "busRoute" as const },
      { x: 2, y: 1 },
    );
    result = handleTileClick(result.state, result.ui, { x: 4, y: 0 });

    expect(result.ui.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(result.state.transit.routes).toEqual([]);
  });
});

describe("resolveNodeAtTile", () => {
  it("resolves a bus stop at its exact tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    expect(state.transit.stops).toHaveLength(1);

    const resolved = resolveNodeAtTile(state, { x: 7, y: 2 });
    expect(resolved?.kind).toBe("stop");
    expect(resolved?.node.id).toBe(state.transit.stops[0].id);
  });

  it("resolves a metro station at its exact tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addMetroStation(state, { x: 22, y: 2 });
    expect(state.transit.stations).toHaveLength(1);

    const resolved = resolveNodeAtTile(state, { x: 22, y: 2 });
    expect(resolved?.kind).toBe("station");
    expect(resolved?.node.id).toBe(state.transit.stations[0].id);
  });

  it("resolves a building-backed transit node via a non-origin occupied tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    // busTerminal has a 3x2 footprint, so it has non-origin occupied tiles.
    state = placeBuilding(state, "busTerminal", { x: 0, y: 0 }, 0);

    expect(state.buildings).toHaveLength(1);
    const building = state.buildings[0];
    expect(building.transitNodeId).toBeDefined();

    // The stop is placed at the building origin, so its position is the node's
    // exact tile. Resolve via a footprint tile that is NOT that exact position
    // to exercise the building-backed branch rather than the exact-position match.
    const nodePosition = state.transit.stops.find(
      (stop) => stop.id === building.transitNodeId,
    )!.position;
    const footprintTile = building.occupiedTiles.find(
      (tile) => !(tile.x === nodePosition.x && tile.y === nodePosition.y),
    )!;
    expect(footprintTile).toBeDefined();

    const resolved = resolveNodeAtTile(state, footprintTile);
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("stop");
    expect(resolved!.node.id).toBe(building.transitNodeId);
  });

  it("returns null on an empty tile", () => {
    const state = createInitialGameState();
    expect(resolveNodeAtTile(state, { x: 0, y: 0 })).toBeNull();
  });

  it("prefers station when preferredKind is station", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });

    const resolved = resolveNodeAtTile(state, { x: 7, y: 2 }, "station");
    expect(resolved?.kind).toBe("station");
  });

  it("prefers stop when preferredKind is stop", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });

    const resolved = resolveNodeAtTile(state, { x: 7, y: 2 }, "stop");
    expect(resolved?.kind).toBe("stop");
  });
});

describe("resolveNodesAtTile", () => {
  it("returns both nodes when a stop and station share a tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });

    const nodes = resolveNodesAtTile(state, { x: 7, y: 2 });
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.kind).sort()).toEqual(["station", "stop"]);
  });

  it("returns a single node when only one kind exists", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });

    const nodes = resolveNodesAtTile(state, { x: 7, y: 2 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("stop");
  });
});

describe("inspect tool co-located cycling", () => {
  it("selects stop first on a co-located tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });
    const ui = createUiState();

    const result = handleTileClick(state, ui, { x: 7, y: 2 });
    expect(result.ui.selectedNodeKind).toBe("stop");
  });

  it("cycles to station on second click of same tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });
    const ui = {
      ...createUiState(),
      selectedId: "7,2",
      selectedNodeKind: "stop" as const,
    };

    const result = handleTileClick(state, ui, { x: 7, y: 2 });
    expect(result.ui.selectedNodeKind).toBe("station");
  });

  it("cycles back to stop on third click of same tile", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 7, y: 2 });
    const ui = {
      ...createUiState(),
      selectedId: "7,2",
      selectedNodeKind: "station" as const,
    };

    const result = handleTileClick(state, ui, { x: 7, y: 2 });
    expect(result.ui.selectedNodeKind).toBe("stop");
  });
});

describe("stripRoutesFromPlatforms reference equality", () => {
  it("returns the original node reference when no routes are stripped", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }); // stop-001, will be removed
    state = addBusStop(state, { x: 15, y: 8 }); // stop-002, survives
    state = addBusStop(state, { x: 22, y: 2 }); // stop-003, survives (no route)
    const stopIds = [state.transit.stops[0]!.id, state.transit.stops[1]!.id];
    state = addBusRoute(state, stopIds);

    const routeId = state.transit.routes[0]!.id;
    const stop003Before = state.transit.stops.find((s) => s.id === "stop-003")!;

    const ui = { ...createUiState(), activeTool: "remove" as const };
    const result = handleTileClick(state, ui, { x: 7, y: 2 });

    const stop002After = result.state.transit.stops.find(
      (s) => s.id === "stop-002",
    )!;
    const stop003After = result.state.transit.stops.find(
      (s) => s.id === "stop-003",
    )!;

    // stop-002 had the route stripped — should be a new object
    expect(stop002After.platforms[0]!.routeIds).not.toContain(routeId);
    // stop-003 never had the route — should be the same reference
    expect(stop003After).toBe(stop003Before);
  });
});

describe("removal strips routes from surviving platforms", () => {
  it("removes a deleted route's id from a shared terminal's platforms", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal"); // survives
    state = addBusStop(state, { x: 22, y: 2 }); // will be removed
    expect(state.transit.stops).toHaveLength(2);

    const terminalId = state.transit.stops.find(
      (s) => s.kind === "busTerminal",
    )!.id;
    const stopIds = state.transit.stops.map((s) => s.id);
    state = addBusRoute(state, stopIds);
    const routeId = state.transit.routes.at(-1)!.id;
    expect(state.transit.routes).toHaveLength(1);

    const terminalBefore = state.transit.stops.find(
      (s) => s.id === terminalId,
    )!;
    expect(
      terminalBefore.platforms.some((p) => p.routeIds.includes(routeId)),
    ).toBe(true);

    const ui = { ...createUiState(), activeTool: "remove" as const };
    const result = handleTileClick(state, ui, { x: 22, y: 2 });

    const terminal = result.state.transit.stops.find(
      (s) => s.id === terminalId,
    )!;
    const stillHolding = terminal.platforms.some((p) =>
      p.routeIds.includes(routeId),
    );
    expect(result.state.transit.routes).toHaveLength(0); // route deleted
    expect(stillHolding).toBe(false); // and scrubbed from the surviving terminal
  });
});

describe("draft route helpers", () => {
  function busDraft() {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    return { state, ui };
  }

  it("finishes a bus route, assigns a vehicle, and clears the draft", () => {
    const { state, ui } = busDraft();
    const result = finishDraftRoute(state, ui);

    expect(result.state.transit.routes[0]).toMatchObject({
      id: "route-001",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    expect(result.ui.draftStopIds).toEqual([]);
  });

  it("does not finish when fewer than two distinct stops", () => {
    const { state } = busDraft();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
    };
    const result = finishDraftRoute(state, ui);
    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });

  it("does not finish when the vehicle is unaffordable", () => {
    const draft = busDraft();
    const state = { ...draft.state, budget: 7_999 };
    const result = finishDraftRoute(state, draft.ui);
    expect(result.state).toBe(state);
    expect(result.ui).toBe(draft.ui);
  });

  it("finishes a metro line, assigns a metro vehicle, and clears the draft", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001", "station-002"],
    };

    const result = finishDraftRoute(state, ui);

    expect(result.state.transit.metroLines[0]).toMatchObject({
      id: "metro-001",
      stationIds: ["station-001", "station-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    // Metro vehicles must be mode "metro" with metro capacity — guards
    // against a swapped mode or cost wiring (COSTS.metro = 50_000) silently
    // passing if the bus branch was copy-pasted incorrectly.
    expect(result.state.transit.vehicles[0]).toMatchObject({
      id: "vehicle-001",
      mode: "metro",
      lineId: "metro-001",
      capacity: 90,
    });
    expect(result.ui.draftStationIds).toEqual([]);
  });

  it("does not finish a metro line when fewer than two distinct stations", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001"],
    };
    const result = finishDraftRoute(state, ui);
    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });

  it("does not finish a metro line when the metro vehicle is unaffordable", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001", "station-002"],
    };
    const unaffordable = { ...state, budget: 49_999 };
    const result = finishDraftRoute(unaffordable, ui);
    expect(result.state).toBe(unaffordable);
    expect(result.ui).toBe(ui);
  });

  it("removes a specific draft stop by index", () => {
    const { ui } = busDraft();
    const next = removeDraftStop(ui, 0);
    expect(next.draftStopIds).toEqual(["stop-002"]);
  });

  it("removes a metro draft station by index", () => {
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001", "station-002"],
    };
    const next = removeDraftStop(ui, 1);
    expect(next.draftStationIds).toEqual(["station-001"]);
  });

  it("cancels both drafts", () => {
    const ui = {
      ...createUiState(),
      draftStopIds: ["stop-001"],
      draftStationIds: ["station-001"],
    };
    const next = cancelDraftRoute(ui);
    expect(next.draftStopIds).toEqual([]);
    expect(next.draftStationIds).toEqual([]);
  });

  it("removeDraftStop returns the same ui for an out-of-range index", () => {
    const { ui } = busDraft();
    expect(removeDraftStop(ui, 5)).toBe(ui);
    expect(removeDraftStop(ui, -1)).toBe(ui);
  });

  it("cancelDraftRoute returns the same ui when already empty", () => {
    const ui = createUiState();
    expect(cancelDraftRoute(ui)).toBe(ui);
  });
});
