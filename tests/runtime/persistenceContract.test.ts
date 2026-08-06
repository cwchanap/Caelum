import { describe, expect, it } from "vitest";

import {
  runSnapshotOperation,
  snapshotError,
} from "../../src/runtime/backend/persistence";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

describe("snapshot persistence mapping", () => {
  it("maps a schema rejection without an operation field", async () => {
    await expect(
      runSnapshotOperation(() =>
        Promise.reject({
          code: "unsupportedSchema",
          context: { expected: 4, actual: 3 },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupportedSchema",
        diagnostic: "[object Object]",
      },
    });
  });

  it("maps a non-schema construction rejection to invalidSnapshot", async () => {
    await expect(
      runSnapshotOperation(() =>
        Promise.reject({ code: "invalidSnapshot", context: "bad tile count" }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalidSnapshot",
        diagnostic: "[object Object]",
      },
    });
  });

  it("maps an unexpected adapter failure to hostFailure", async () => {
    await expect(
      runSnapshotOperation(() => Promise.reject(new Error("IPC unavailable"))),
    ).resolves.toEqual({
      ok: false,
      error: snapshotError("hostFailure", "IPC unavailable"),
    });
  });

  it("accepts a current-schema snapshot", async () => {
    const snapshot = createRustSnapshot();
    await expect(runSnapshotOperation(() => snapshot)).resolves.toEqual({
      ok: true,
      snapshot,
    });
  });
});
