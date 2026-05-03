import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation, assignVehicle } from "../../src/simulation/transit";

describe("transit network actions", () => {
  it("adds a bus stop on a valid road tile and charges the budget", () => {
    const state = createInitialGameState();

    const nextState = addBusStop(state, { x: 7, y: 8 });

    expect(nextState.transit.stops).toEqual([{ id: "stop-001", position: { x: 7, y: 8 }, queueCitizenIds: [] }]);
    expect(nextState.budget).toBe(118_000);
  });

  it("returns the original state when adding a bus stop on an invalid residential tile", () => {
    const state = createInitialGameState();

    const nextState = addBusStop(state, { x: 2, y: 3 });

    expect(nextState).toBe(state);
  });

  it("creates an active bus route and assigns a bus vehicle to it", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const nextState = assignVehicle(state, "bus", "route-001");

    expect(nextState.transit.routes[0]).toMatchObject({
      id: "route-001",
      name: "Bus 1",
      color: "#e04f39",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: ["vehicle-001"],
      active: true
    });
    expect(nextState.transit.vehicles[0]).toEqual({
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0
    });
  });

  it("creates an active metro line and assigns a metro vehicle to it", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const nextState = assignVehicle(state, "metro", "metro-001");

    expect(nextState.transit.metroLines[0]).toMatchObject({
      id: "metro-001",
      name: "Metro 1",
      color: "#2867b2",
      stationIds: ["station-001", "station-002"],
      vehicleIds: ["vehicle-001"],
      active: true
    });
    expect(nextState.transit.vehicles[0]).toEqual({
      id: "vehicle-001",
      mode: "metro",
      lineId: "metro-001",
      capacity: 90,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0
    });
  });

  it("returns the original state when assigning vehicles to missing or mismatched lines", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    expect(assignVehicle(state, "bus", "route-999")).toBe(state);
    expect(assignVehicle(state, "metro", "route-001")).toBe(state);
  });
});
