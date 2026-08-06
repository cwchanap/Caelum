import { describe, expect, it } from "vitest";

import type { GameBackend } from "../../src/runtime/backend";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

describe("GameBackend contract", () => {
  it("contains only the nine runtime-consumed methods", () => {
    const backend: GameBackend = {
      ...previewBackendStubs(),
      snapshot: async () => createRustSnapshot(),
      dispatch: async () => ({
        snapshot: createRustSnapshot(),
        applied: false,
        rejection: null,
      }),
      tick: async () => ({
        snapshot: createRustSnapshot(),
        applied: false,
        rejection: null,
      }),
      reset: async () => ({ ok: true, snapshot: createRustSnapshot() }),
    };

    expect(Object.keys(backend).sort()).toEqual([
      "buildSandboxSnapshot",
      "dispatch",
      "previewRoadMutation",
      "previewRoute",
      "reset",
      "restoreSnapshot",
      "snapshot",
      "snapshotForSave",
      "tick",
    ]);
    expect("beginRuntime" in backend).toBe(false);
    expect("validateSnapshot" in backend).toBe(false);
    expect("createSandbox" in backend).toBe(false);
    expect("runtimeIdentity" in backend).toBe(false);
  });
});
