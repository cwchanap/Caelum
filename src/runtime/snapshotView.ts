import {
  SNAPSHOT_SCHEMA_VERSION,
  type GameState,
  type Station,
  type Stop,
} from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";
import { normalizeRouteLegPath } from "./backend/shared";

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema version: ${String(snapshot.schemaVersion)}`,
    );
  }
  return {
    ...snapshot,
    transit: {
      ...snapshot.transit,
      routes: snapshot.transit.routes.map((route) => ({
        ...route,
        legs: route.legs.map(normalizeRouteLegPath),
      })),
      metroLines: snapshot.transit.metroLines.map((line) => ({
        ...line,
        legs: line.legs.map(normalizeRouteLegPath),
      })),
      // serde-wasm-bindgen omits Rust `None` as `undefined`; keep explicit null
      // so renderers can use strict null checks without throwing on park sites.
      vehicles: snapshot.transit.vehicles.map((vehicle) => ({
        ...vehicle,
        parkedPosition: vehicle.parkedPosition ?? null,
      })),
    },
    metrics: {
      ...snapshot.metrics,
      waitingCitizenCount: snapshot.metrics.waitingTripCount,
    },
    scenario: {
      name: snapshot.scenario.name,
      objectives: snapshot.scenario.objectives,
      growthWaves: snapshot.scenario.growthWaves,
    },
  };
}

export function isPresentTransitNode(node: Stop | Station): boolean {
  return node.status === "present";
}
