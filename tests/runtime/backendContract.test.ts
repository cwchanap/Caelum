import { describe, expect, it } from "vitest";

import type { GameBackend } from "../../src/runtime/backend";
import {
  createPresentationUpdate,
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

describe("GameBackend contract", () => {
  it("contains only the nine runtime-consumed methods", () => {
    const backend: GameBackend = {
      ...previewBackendStubs(),
      presentation: async () => createPresentationUpdate(createRustSnapshot()),
      dispatch: async () => ({
        update: createPresentationUpdate(createRustSnapshot(), false),
        applied: false,
        rejection: null,
      }),
      tick: async () => ({
        update: createPresentationUpdate(createRustSnapshot(), false),
        applied: false,
        rejection: null,
      }),
      reset: async () => ({
        ok: true,
        update: createPresentationUpdate(createRustSnapshot()),
      }),
    };

    expect(Object.keys(backend).sort()).toEqual([
      "buildSandboxSnapshot",
      "dispatch",
      "presentation",
      "previewRoadMutation",
      "previewRoute",
      "reset",
      "restoreSnapshot",
      "snapshotForSave",
      "tick",
    ]);
  });
});
