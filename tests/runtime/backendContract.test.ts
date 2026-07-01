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
    expect(snapshot.metrics.waitingCitizenCount).toBe(4);
    expect(snapshot.metrics.waitingTripCount).toBe(4);
    expect(snapshot.metrics.tripOutcomes).toEqual([
      {
        outcome: "late",
        waitSeconds: 45,
        time: 555,
      },
    ]);
    // The Growing Suburb sandbox has no timed growth waves (see
    // docs/architecture.md). The shell must not synthesize TS-side waves that
    // Rust will never auto-apply, so normalization always emits an empty list
    // regardless of metrics state.
    expect(snapshot.scenario.growthWaves).toEqual([]);
    expect(anotherSnapshot.scenario.growthWaves).toEqual([]);
  });

  it("sources objective thresholds from the Rust snapshot, not a local shim", () => {
    // Guards against the drift that motivated this contract: a previous TS shim
    // hard-coded `rollingWindowSeconds = 600` while the core evaluates at 300.
    const withThresholds = createRustSnapshot({
      scenario: {
        name: "Growing Suburb",
        objectives: {
          maxLateRatio: 0.25,
          maxUnservedRatio: 0.2,
          maxAverageWait: 180,
          rollingWindowSeconds: 300,
          survivalTime: 1_200,
        },
      },
    });
    const normalized = normalizeRustSnapshot(withThresholds);

    expect(normalized.scenario.objectives).toEqual(
      withThresholds.scenario.objectives,
    );
    expect(normalized.scenario.objectives.rollingWindowSeconds).toBe(300);

    // And a custom threshold round-trips through unchanged (proving the value
    // is read from the snapshot, not overwritten by a constant).
    const custom = normalizeRustSnapshot(
      createRustSnapshot({
        scenario: {
          name: "Tight Suburb",
          objectives: {
            maxLateRatio: 0.1,
            maxUnservedRatio: 0.05,
            maxAverageWait: 90,
            rollingWindowSeconds: 150,
            survivalTime: 600,
          },
        },
      }),
    );
    expect(custom.scenario.name).toBe("Tight Suburb");
    expect(custom.scenario.objectives.maxLateRatio).toBe(0.1);
    expect(custom.scenario.objectives.rollingWindowSeconds).toBe(150);
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
