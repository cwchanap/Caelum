import { describe, expect, it } from "vitest";
import type { GameBackend, GameIntent } from "../../src/runtime/backend/types";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

describe("Rust backend contract", () => {
  it("normalizes a Rust snapshot into shell-readable frontend state", () => {
    const rustSnapshot = createRustSnapshot({
      day: 1,
      clockMinutes: 9 * 60 + 15,
      metrics: {
        lateTrips: 1,
        completedTrips: 2,
        unservedTrips: 3,
        totalWaitSeconds: 45,
        waitingTripCount: 4,
        averageWaitSeconds: 11.25,
        tripOutcomes: [
          {
            outcome: "late",
            waitSeconds: 45,
            time: 555,
          },
        ],
        state: "running",
        lossReason: null,
      },
      sims: [
        {
          id: "sim-001",
          home: { x: 1, y: 1 },
          position: { x: 1, y: 1 },
          workerProfile: "worker",
          shiftTemplate: "standard",
          workplace: { x: 5, y: 1 },
          commuteDay: 1,
          outboundResolvedToday: false,
          outboundArrivedToday: false,
          returnResolvedToday: false,
          returnedHomeToday: false,
        },
      ],
    });
    const snapshot = normalizeRustSnapshot(rustSnapshot);
    const anotherSnapshot = normalizeRustSnapshot(createRustSnapshot());

    expect(rustSnapshot.metrics.waitingTripCount).toBe(4);
    expect(rustSnapshot.metrics.tripOutcomes).toEqual([
      {
        outcome: "late",
        waitSeconds: 45,
        time: 555,
      },
    ]);
    expect(snapshot.scenario.name).toBe("Growing Suburb");
    expect(snapshot.day).toBe(1);
    expect(snapshot.clockMinutes).toBe(555);
    expect(snapshot.sims).toHaveLength(1);
    expect(snapshot.citizens).toEqual([]);
    expect(snapshot.metrics.waitingCitizenCount).toBe(4);
    expect(snapshot.metrics.waitingTripCount).toBe(4);
    expect(snapshot.metrics.tripOutcomes).toEqual([
      {
        outcome: "late",
        waitSeconds: 45,
        time: 555,
      },
    ]);
    expect(snapshot.scenario.growthWaves).not.toBe(
      anotherSnapshot.scenario.growthWaves,
    );
    expect(snapshot.scenario.growthWaves[0]).not.toBe(
      anotherSnapshot.scenario.growthWaves[0],
    );
  });

  it("backend methods return promises so browser and Tauri share one runtime contract", async () => {
    const intent: GameIntent = { type: "setPaused", paused: false };
    const snapshot = createRustSnapshot();
    const backend: GameBackend = {
      snapshot: async () => snapshot,
      dispatch: async (received) => ({
        snapshot: {
          ...snapshot,
          paused:
            received.type === "setPaused" ? received.paused : snapshot.paused,
        },
        applied: true,
        rejection: null,
      }),
      tick: async () => ({ snapshot, applied: false, rejection: null }),
      reset: async () => snapshot,
    };

    await expect(backend.dispatch(intent)).resolves.toMatchObject({
      applied: true,
      snapshot: { paused: false },
    });
  });
});
