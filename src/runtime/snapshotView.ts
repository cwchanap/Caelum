import {
  SNAPSHOT_SCHEMA_VERSION,
  type GameState,
  type Station,
  type Stop,
} from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema version: ${String(snapshot.schemaVersion)}`,
    );
  }
  return {
    ...snapshot,
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
