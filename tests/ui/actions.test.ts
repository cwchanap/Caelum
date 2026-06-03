import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { placeBuilding } from "../../src/simulation/buildings";
import {
  addBusRoute,
  addBusStop,
  addMetroStation,
  assignVehicle,
} from "../../src/simulation/transit";
import { handleTileClick } from "../../src/ui/actions";
import { createUiState } from "../../src/ui/uiState";

describe("UI tile actions", () => {
  it("preserves a bus route draft when the bus cannot be afforded", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = { ...state, budget: 7_999 };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
    };

    const result = handleTileClick(state, ui, { x: 15, y: 8 });

    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });

  it("preserves a metro line draft when the train cannot be afforded", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = { ...state, budget: 49_999 };
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001"],
    };

    const result = handleTileClick(state, ui, { x: 15, y: 8 });

    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });

  it("removes stops and dependent routes at the clicked tile", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "busRoute" as const },
      { x: 7, y: 8 },
    );
    result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

    const removed = handleTileClick(
      result.state,
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

  it("removes stations and dependent metro lines at the clicked tile", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    let result = handleTileClick(
      state,
      { ...createUiState(), activeTool: "metroLine" as const },
      { x: 7, y: 8 },
    );
    result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

    const removed = handleTileClick(
      result.state,
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

    expect(result.state.transit.routes[0]).toMatchObject({
      id: "route-001",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    expect(result.ui.draftStopIds).toEqual([]);
  });
});
