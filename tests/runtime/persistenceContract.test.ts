import { describe, expect, it } from "vitest";

import {
  runRestoreOperation,
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
        diagnostic:
          '{"code":"unsupportedSchema","context":{"expected":4,"actual":3}}',
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
        diagnostic: '{"code":"invalidSnapshot","context":"bad tile count"}',
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

  it("rejects an ambiguous restore transport failure", async () => {
    await expect(
      runRestoreOperation(() => Promise.reject(new Error("IPC unavailable"))),
    ).rejects.toThrow("IPC unavailable");
  });

  it("resolves a successful restore as the returned snapshot", async () => {
    const snapshot = createRustSnapshot();
    await expect(runRestoreOperation(() => snapshot)).resolves.toEqual({
      ok: true,
      snapshot,
    });
  });

  it("resolves a definitive restore rejection without rethrowing", async () => {
    await expect(
      runRestoreOperation(() =>
        Promise.reject({ code: "invalidSnapshot", context: "bad candidate" }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalidSnapshot",
        diagnostic: '{"code":"invalidSnapshot","context":"bad candidate"}',
      },
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
