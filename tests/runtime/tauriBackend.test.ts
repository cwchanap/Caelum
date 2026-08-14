import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { createTauriBackend } from "../../src/runtime/backend/tauriBackend";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const request = {
  templateId: "blankGrid",
  economyPreset: "standard",
  startingCapital: 120_000,
  demandMultiplier: 1,
} as const;

describe("Tauri backend", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case "game_begin_runtime":
          return { runtimeEpoch: 7, snapshot: createRustSnapshot() };
        case "game_snapshot":
        case "game_snapshot_for_save":
        case "game_restore_snapshot":
        case "game_build_sandbox_snapshot":
        case "game_reset":
          return createRustSnapshot();
        case "game_dispatch":
        case "game_tick":
          return {
            snapshot: createRustSnapshot(),
            applied: false,
            rejection: null,
          };
        default:
          return {
            generation: 1,
            legs: [],
            totalTravelSeconds: 0,
            initialVehicleCost: 0,
            affordable: true,
            turnSummary: {
              straight: 0,
              rightTurn: 0,
              leftTurn: 0,
              uTurn: 0,
              roundaboutEntry: 0,
            },
            missingWaypointIds: [],
            warnings: [],
            rejection: null,
          };
      }
    });
  });

  it("begins the native epoch privately and exposes the final methods", async () => {
    const backend = await createTauriBackend();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "game_begin_runtime");
    expect("beginRuntime" in backend).toBe(false);

    await backend.dispatch({ type: "setPaused", paused: true });
    expect(invokeMock).toHaveBeenLastCalledWith("game_dispatch", {
      intent: { type: "setPaused", paused: true },
      runtimeEpoch: 7,
    });
  });

  it("builds a sandbox without mutating the managed engine", async () => {
    const backend = await createTauriBackend();

    await expect(backend.buildSandboxSnapshot(request)).resolves.toEqual({
      ok: true,
      snapshot: expect.any(Object),
    });
    expect(invokeMock).toHaveBeenLastCalledWith("game_build_sandbox_snapshot", {
      request,
    });
  });

  it("maps an invalid restore response and keeps it definitive", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "game_begin_runtime") {
        return { runtimeEpoch: 1, snapshot: createRustSnapshot() };
      }
      if (command === "game_restore_snapshot") {
        throw { code: "invalidSnapshot", context: "bad candidate" };
      }
      return createRustSnapshot();
    });

    const backend = await createTauriBackend();
    await expect(backend.restoreSnapshot({})).resolves.toEqual({
      ok: false,
      error: {
        code: "invalidSnapshot",
        diagnostic: '{"code":"invalidSnapshot","context":"bad candidate"}',
      },
    });
  });
});
