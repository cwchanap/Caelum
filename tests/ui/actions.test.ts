import { describe, expect, it } from "vitest";
import { getTile } from "../../src/simulation/map";
import { applyDueGrowthWaves } from "../../src/simulation/map";
import { createInitialGameState } from "../../src/simulation/gameState";
import { addBusStop, addMetroStation } from "../../src/simulation/transit";
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
      { id: "stop-002", position: { x: 15, y: 8 }, queueCitizenIds: [] },
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
      { id: "station-002", position: { x: 15, y: 8 }, queueCitizenIds: [] },
    ]);
    expect(removed.state.transit.metroLines).toEqual([]);
    expect(removed.state.transit.vehicles).toEqual([]);
  });

  it("removes a civic anchor at the clicked tile", () => {
    const added = handleTileClick(
      createInitialGameState(),
      { ...createUiState(), activeTool: "civicAnchor" as const },
      { x: 0, y: 0 },
    );

    const removed = handleTileClick(
      added.state,
      { ...createUiState(), activeTool: "remove" as const },
      { x: 0, y: 0 },
    );

    expect(getTile(removed.state.map, { x: 0, y: 0 })?.kind).toBe("empty");
  });

  it("limits civic anchors and marks them as growth destinations", () => {
    let state = createInitialGameState();
    state = handleTileClick(
      state,
      { ...createUiState(), activeTool: "civicAnchor" as const },
      { x: 0, y: 0 },
    ).state;
    state = handleTileClick(
      state,
      { ...createUiState(), activeTool: "civicAnchor" as const },
      { x: 1, y: 0 },
    ).state;
    state = handleTileClick(
      state,
      { ...createUiState(), activeTool: "civicAnchor" as const },
      { x: 2, y: 0 },
    ).state;
    const overLimit = handleTileClick(
      state,
      { ...createUiState(), activeTool: "civicAnchor" as const },
      { x: 3, y: 0 },
    ).state;

    expect(getTile(state.map, { x: 0, y: 0 })?.districtId).toBe("anchor");
    expect(overLimit).toBe(state);

    const grown = applyDueGrowthWaves({ ...state, time: 250 });
    const newCitizens = grown.citizens.slice(
      createInitialGameState().citizens.length,
    );

    expect(
      newCitizens.some(
        (citizen) => citizen.destination.x === 0 && citizen.destination.y === 0,
      ),
    ).toBe(true);
  });
});
