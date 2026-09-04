import type { GameState, Station, Stop } from "../domain/types";
import { normalizeRouteLegPath } from "./backend/shared";
import type { PresentationUpdate } from "./backend/types";

/**
 * The one live-view reducer: folds a Rust `PresentationUpdate` into the flat,
 * unversioned `GameState`. Frame rows always come from the update; scene rows
 * fall back to `current` on frame-only updates (ticks, rejected/no-op
 * dispatches). Scene route/metro wire rows carry no `serviceMetrics`, so the
 * newest per-line frame row is merged into the live rows here.
 */
export function applyPresentationUpdate(
  current: GameState | null,
  update: PresentationUpdate,
): GameState {
  if (current === null && update.scene === null) {
    throw new Error("initial presentation update must include scene");
  }

  const scene = update.scene;
  const rules = scene?.rules ?? current!.rules;
  const map = scene?.map ?? current!.map;
  const buildings = scene?.buildings ?? current!.buildings;
  const stops = scene?.stops ?? current!.transit.stops;
  const stations = scene?.stations ?? current!.transit.stations;
  const baseRoutes = scene?.routes ?? current!.transit.routes;
  const baseMetroLines = scene?.metroLines ?? current!.transit.metroLines;

  const metricsByLine = new Map(
    update.frame.serviceMetrics.map((row) => [row.lineId, row.metrics]),
  );

  const routes = baseRoutes.map((route) => ({
    ...route,
    // serde-wasm-bindgen omits Rust `None` fields as `undefined`; keep explicit
    // nulls so renderers can use strict null checks (same normalization the
    // raw snapshot path applies).
    legs: route.legs.map(normalizeRouteLegPath),
    targetHeadwaySeconds: route.targetHeadwaySeconds ?? null,
    serviceMetrics: metricsByLine.get(route.id) ?? null,
  }));
  const metroLines = baseMetroLines.map((line) => ({
    ...line,
    legs: line.legs.map(normalizeRouteLegPath),
    targetHeadwaySeconds: line.targetHeadwaySeconds ?? null,
    serviceMetrics: metricsByLine.get(line.id) ?? null,
  }));

  return {
    rules,
    map,
    buildings,
    transit: {
      stops,
      stations,
      routes,
      metroLines,
      vehicles: update.frame.vehicles.map((vehicle) => ({
        ...vehicle,
        parkedPosition: vehicle.parkedPosition ?? null,
      })),
    },
    time: update.frame.time,
    day: update.frame.day,
    clockMinutes: update.frame.clockMinutes,
    speed: update.frame.speed,
    paused: update.frame.paused,
    budget: update.frame.budget,
    metrics: update.frame.metrics,
    populationCount: update.frame.populationCount,
    buildingOccupancy: update.frame.buildingOccupancy,
    platformOccupancy: update.frame.platformOccupancy,
    trafficFlow: update.frame.trafficFlow,
    demandFlow: update.frame.demandFlow,
  };
}

export function isPresentTransitNode(node: Stop | Station): boolean {
  return node.status === "present";
}
