import type { GameState, Point, Station, Stop } from "../domain/types";
import { placeBuilding } from "../simulation/buildings";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
} from "../simulation/transit";
import type { UiState } from "./uiState";

const BUS_VEHICLE_COST = 8_000;
const METRO_VEHICLE_COST = 50_000;

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function resolveStopAtTile(state: GameState, point: Point): Stop | undefined {
  const exactStop = state.transit.stops.find((candidate) =>
    samePoint(candidate.position, point),
  );

  if (exactStop !== undefined) {
    return exactStop;
  }

  const building = state.buildings.find(
    (candidate) =>
      (candidate.type === "busStop" || candidate.type === "busTerminal") &&
      candidate.transitNodeId !== undefined &&
      candidate.occupiedTiles.some((tile) => samePoint(tile, point)),
  );

  return building?.transitNodeId === undefined
    ? undefined
    : state.transit.stops.find((stop) => stop.id === building.transitNodeId);
}

export type ResolvedNode =
  | { kind: "stop"; node: Stop }
  | { kind: "station"; node: Station };

function resolveStationAtTile(
  state: GameState,
  point: Point,
): Station | undefined {
  const exactStation = state.transit.stations.find((candidate) =>
    samePoint(candidate.position, point),
  );
  if (exactStation !== undefined) {
    return exactStation;
  }

  const building = state.buildings.find(
    (candidate) =>
      candidate.type === "metroStation" &&
      candidate.transitNodeId !== undefined &&
      candidate.occupiedTiles.some((tile) => samePoint(tile, point)),
  );

  return building?.transitNodeId === undefined
    ? undefined
    : state.transit.stations.find(
        (station) => station.id === building.transitNodeId,
      );
}

export function resolveNodesAtTile(
  state: GameState,
  point: Point,
): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined) {
    nodes.push({ kind: "stop", node: stop });
  }
  const station = resolveStationAtTile(state, point);
  if (station !== undefined) {
    nodes.push({ kind: "station", node: station });
  }
  return nodes;
}

export function resolveNodeAtTile(
  state: GameState,
  point: Point,
  preferredKind?: "stop" | "station",
): ResolvedNode | null {
  if (preferredKind === "station") {
    const station = resolveStationAtTile(state, point);
    if (station !== undefined) {
      return { kind: "station", node: station };
    }
    const stop = resolveStopAtTile(state, point);
    if (stop !== undefined) {
      return { kind: "stop", node: stop };
    }
    return null;
  }

  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined) {
    return { kind: "stop", node: stop };
  }

  const station = resolveStationAtTile(state, point);
  if (station !== undefined) {
    return { kind: "station", node: station };
  }

  return null;
}

function stripRoutesFromPlatforms<
  T extends { platforms: { routeIds: string[] }[] },
>(nodes: T[], removedIds: Set<string>): T[] {
  if (removedIds.size === 0) {
    return nodes;
  }

  return nodes.map((node) => {
    let changed = false;
    const platforms = node.platforms.map((platform) => {
      const filtered = platform.routeIds.filter((id) => !removedIds.has(id));
      if (filtered.length !== platform.routeIds.length) {
        changed = true;
        return { ...platform, routeIds: filtered };
      }
      return platform;
    });
    return changed ? { ...node, platforms } : node;
  });
}

function removeAtTile(state: GameState, point: Point): GameState {
  const removedBuilding = state.buildings.find((building) =>
    building.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
  const removedStopIds = new Set<string>();
  const removedStationIds = new Set<string>();

  if (
    removedBuilding?.transitNodeId !== undefined &&
    (removedBuilding.type === "busStop" ||
      removedBuilding.type === "busTerminal")
  ) {
    removedStopIds.add(removedBuilding.transitNodeId);
  }

  if (
    removedBuilding?.transitNodeId !== undefined &&
    removedBuilding.type === "metroStation"
  ) {
    removedStationIds.add(removedBuilding.transitNodeId);
  }

  if (removedBuilding === undefined) {
    state.transit.stops
      .filter((stop) => samePoint(stop.position, point))
      .forEach((stop) => removedStopIds.add(stop.id));
    state.transit.stations
      .filter((station) => samePoint(station.position, point))
      .forEach((station) => removedStationIds.add(station.id));
  }

  const removedRouteIds = new Set(
    state.transit.routes
      .filter((route) =>
        route.stopIds.some((stopId) => removedStopIds.has(stopId)),
      )
      .map((route) => route.id),
  );
  const removedMetroLineIds = new Set(
    state.transit.metroLines
      .filter((metroLine) =>
        metroLine.stationIds.some((stationId) =>
          removedStationIds.has(stationId),
        ),
      )
      .map((metroLine) => metroLine.id),
  );

  if (
    removedBuilding === undefined &&
    removedStopIds.size === 0 &&
    removedStationIds.size === 0
  ) {
    return state;
  }

  return {
    ...state,
    buildings:
      removedBuilding === undefined
        ? state.buildings
        : state.buildings.filter(
            (building) => building.id !== removedBuilding.id,
          ),
    transit: {
      ...state.transit,
      stops: stripRoutesFromPlatforms(
        state.transit.stops.filter((stop) => !removedStopIds.has(stop.id)),
        removedRouteIds,
      ),
      stations: stripRoutesFromPlatforms(
        state.transit.stations.filter(
          (station) => !removedStationIds.has(station.id),
        ),
        removedMetroLineIds,
      ),
      routes: state.transit.routes.filter(
        (route) => !removedRouteIds.has(route.id),
      ),
      metroLines: state.transit.metroLines.filter(
        (metroLine) => !removedMetroLineIds.has(metroLine.id),
      ),
      vehicles: state.transit.vehicles.filter(
        (vehicle) =>
          !removedRouteIds.has(vehicle.lineId) &&
          !removedMetroLineIds.has(vehicle.lineId),
      ),
    },
  };
}

export function handleTileClick(
  state: GameState,
  ui: UiState,
  point: Point,
): { state: GameState; ui: UiState } {
  if (ui.selectedBuilding !== null) {
    return {
      state: placeBuilding(
        state,
        ui.selectedBuilding,
        point,
        ui.buildingRotation,
      ),
      ui,
    };
  }

  if (ui.activeTool === "busStop") {
    return { state: addBusStop(state, point), ui };
  }

  if (ui.activeTool === "metroStation") {
    return { state: addMetroStation(state, point), ui };
  }

  if (ui.activeTool === "busRoute") {
    const stop = resolveStopAtTile(state, point);

    if (stop === undefined) {
      return { state, ui };
    }

    const draftStopIds = [...ui.draftStopIds, stop.id];

    if (draftStopIds.length >= 2) {
      if (state.budget < BUS_VEHICLE_COST) {
        return { state, ui };
      }

      const withRoute = addBusRoute(state, draftStopIds);
      const routeId = withRoute.transit.routes.at(-1)?.id;

      return {
        state:
          routeId === undefined
            ? withRoute
            : assignVehicle(withRoute, "bus", routeId),
        ui: { ...ui, draftStopIds: [] },
      };
    }

    return { state, ui: { ...ui, draftStopIds } };
  }

  if (ui.activeTool === "metroLine") {
    const station = state.transit.stations.find((candidate) =>
      samePoint(candidate.position, point),
    );

    if (station === undefined) {
      return { state, ui };
    }

    const draftStationIds = [...ui.draftStationIds, station.id];

    if (draftStationIds.length >= 2) {
      if (state.budget < METRO_VEHICLE_COST) {
        return { state, ui };
      }

      const withLine = addMetroLine(state, draftStationIds);
      const lineId = withLine.transit.metroLines.at(-1)?.id;

      return {
        state:
          lineId === undefined
            ? withLine
            : assignVehicle(withLine, "metro", lineId),
        ui: { ...ui, draftStationIds: [] },
      };
    }

    return { state, ui: { ...ui, draftStationIds } };
  }

  if (ui.activeTool === "inspect") {
    const nodes = resolveNodesAtTile(state, point);
    if (nodes.length === 0) {
      return {
        state,
        ui: {
          ...ui,
          selectedId: `${point.x},${point.y}`,
          selectedNodeKind: null,
        },
      };
    }

    const isSameTile = ui.selectedId === `${point.x},${point.y}`;
    let selectedNodeKind: "stop" | "station";
    if (isSameTile && nodes.length > 1) {
      const otherNode = nodes.find((n) => n.kind !== ui.selectedNodeKind);
      selectedNodeKind = otherNode?.kind ?? nodes[0].kind;
    } else {
      selectedNodeKind = nodes[0].kind;
    }

    return {
      state,
      ui: { ...ui, selectedId: `${point.x},${point.y}`, selectedNodeKind },
    };
  }

  if (ui.activeTool === "remove") {
    return {
      state: removeAtTile(state, point),
      ui: { ...ui, draftStopIds: [], draftStationIds: [], selectedId: null },
    };
  }

  return { state, ui };
}
