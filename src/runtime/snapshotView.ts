import {
  SNAPSHOT_SCHEMA_VERSION,
  type GameState,
  type RoutePlan,
  type Station,
  type Stop,
} from "../domain/types";
import type { RustGameSnapshot, RustRoutePlan } from "./backend/types";
import { normalizeRouteLegPath } from "./backend/shared";

type CompleteRuntimeGameState = GameState &
  Required<
    Pick<
      GameState,
      "sims" | "activeTrips" | "tripSequenceDay" | "nextTripSequence"
    >
  >;

function normalizeRoutePlan(
  plan: RustRoutePlan | null | undefined,
): RoutePlan | null {
  if (plan == null) return null;
  return {
    ...plan,
    legs: plan.legs.map((leg) => ({
      ...leg,
      serviceDirection: leg.serviceDirection ?? null,
      boardItineraryIndex: leg.boardItineraryIndex ?? null,
      alightItineraryIndex: leg.alightItineraryIndex ?? null,
    })),
  };
}

export function normalizeRustSnapshot(
  snapshot: RustGameSnapshot,
): CompleteRuntimeGameState {
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
        serviceMetrics: route.serviceMetrics ?? null,
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
    activeTrips: snapshot.activeTrips.map((trip) => ({
      ...trip,
      routePlan: normalizeRoutePlan(trip.routePlan),
      privateCarTrip: trip.privateCarTrip ?? null,
    })),
    metrics: {
      ...snapshot.metrics,
      waitingCitizenCount: snapshot.metrics.waitingTripCount,
      lossReason: snapshot.metrics.lossReason ?? null,
    },
    scenario: {
      name: snapshot.scenario.name,
      objectives: snapshot.scenario.objectives ?? null,
      growthWaves: snapshot.scenario.growthWaves,
    },
  };
}

export function isPresentTransitNode(node: Stop | Station): boolean {
  return node.status === "present";
}
