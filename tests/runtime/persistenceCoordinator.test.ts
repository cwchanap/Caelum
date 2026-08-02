import { describe, expect, it } from "vitest";
import {
  runtimeUnavailable,
  type PersistenceOperationResult,
} from "../../src/runtime/persistenceCoordinator";

describe("runtime persistence coordinator contracts", () => {
  it("represents supersession without a runtime error", () => {
    const result: PersistenceOperationResult<{ savedAt: string }> = {
      status: "superseded",
    };
    expect(result.status).toBe("superseded");
  });

  it("creates a typed unavailable result", () => {
    expect(runtimeUnavailable("saveWorking")).toEqual({
      status: "failed",
      error: {
        kind: "precondition",
        error: { code: "runtimeUnavailable", operation: "saveWorking" },
      },
    });
  });
});
