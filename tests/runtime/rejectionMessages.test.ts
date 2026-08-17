import { describe, expect, it } from "vitest";
import {
  rejectionMessage,
  routeFailureGuidance,
  workingSaveErrorMessage,
  warningMessage,
} from "../../src/runtime/rejectionMessages";
import type { GameplayRejection } from "../../src/domain/types";
import type { GameplayWarning } from "../../src/runtime/backend/types";

describe("workingSaveErrorMessage", () => {
  it.each([
    [{ kind: "busy" } as const, "Another city action is already in progress."],
    [{ kind: "unavailable" } as const, "City storage is unavailable."],
    [{ kind: "noActiveCity" } as const, "No city is active."],
    [
      { kind: "unsavedChanges" } as const,
      "Pause and Save before switching cities.",
    ],
    [
      {
        kind: "sandbox",
        error: { code: "unknownTemplateId", context: {} },
      } as const,
      "Could not create that city setup.",
    ],
    [
      { kind: "backend", error: { code: "hostFailure" } } as const,
      "Could not apply the city state.",
    ],
  ])("maps working-save error %o to player copy", (error, message) => {
    expect(workingSaveErrorMessage(error)).toBe(message);
  });

  it("maps create-store failure without exposing diagnostics", () => {
    const message = workingSaveErrorMessage({
      kind: "store",
      error: {
        operation: "createCity",
        code: "failed",
        diagnostic: "QuotaExceededError: private browser detail",
      },
    });

    expect(message).toBe("Could not save the new city.");
    expect(message).not.toContain("QuotaExceededError");
  });

  it.each([
    ["listCities", "Could not load the city list."],
    ["readCity", "Could not load that city."],
    ["createCity", "Could not save the new city."],
    ["updateCity", "Could not save the city."],
    ["renameCity", "Could not rename the city."],
    ["deleteCity", "Could not delete the city."],
  ] as const)("maps %s store errors", (operation, expected) => {
    expect(
      workingSaveErrorMessage({
        kind: "store",
        error: { operation, code: "failed" },
      }),
    ).toBe(expected);
  });
});

describe("routeFailureGuidance", () => {
  it("guides noLegalTurnaround", () => {
    expect(
      routeFailureGuidance("noLegalTurnaround", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("No legal U-turn here; add a junction or roundabout.");
  });

  it("guides networkDisconnected for a loop-closing leg", () => {
    expect(
      routeFailureGuidance("networkDisconnected", {
        isLoopClosing: true,
        legKind: "service",
      }),
    ).toBe("Loop can't close here; remove a stop or switch to Shuttle.");
  });

  it("guides networkDisconnected for a terminal reversal leg", () => {
    expect(
      routeFailureGuidance("networkDisconnected", {
        isLoopClosing: false,
        legKind: "terminalReversal",
      }),
    ).toBe("No turnaround path here; add a junction or roundabout nearby.");
  });

  it("guides networkDisconnected fallback for a non-loop service leg", () => {
    expect(
      routeFailureGuidance("networkDisconnected", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("Roads not connected between these stops.");
  });

  it("guides noRoadAccess", () => {
    expect(
      routeFailureGuidance("noRoadAccess", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("Stop has no adjacent road.");
  });

  it("guides noLegalEntryHeading", () => {
    expect(
      routeFailureGuidance("noLegalEntryHeading", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("Road direction doesn't allow serving this stop here.");
  });

  it("guides noLegalExitHeading", () => {
    expect(
      routeFailureGuidance("noLegalExitHeading", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("Road direction doesn't allow serving this stop here.");
  });

  it("guides missingNode", () => {
    expect(
      routeFailureGuidance("missingNode", {
        isLoopClosing: false,
        legKind: "service",
      }),
    ).toBe("Restore the missing node at its former location.");
  });
});

describe("warningMessage", () => {
  const baseContext = gameplayRejectionContext();

  it("formats existingBrokenLeg", () => {
    const warning: GameplayWarning = {
      code: "existingBrokenLeg",
      context: baseContext,
    };
    expect(warningMessage(warning)).toBe(
      "This leg was already disconnected in the saved route.",
    );
  });

  it("formats skippedTiles", () => {
    const warning: GameplayWarning = {
      code: "skippedTiles",
      context: baseContext,
    };
    expect(warningMessage(warning)).toBe("Some tiles were skipped.");
  });

  it("formats routeWillReroute", () => {
    const warning: GameplayWarning = {
      code: "routeWillReroute",
      context: baseContext,
    };
    expect(warningMessage(warning)).toBe("This will reroute the saved path.");
  });

  it("formats routeWillBreak", () => {
    const warning: GameplayWarning = {
      code: "routeWillBreak",
      context: baseContext,
    };
    expect(warningMessage(warning)).toBe("This will break the saved route.");
  });
});

function gameplayRejectionContext(): GameplayRejection["context"] {
  return { affectedRouteIds: [] };
}

describe("assertNever fallbacks", () => {
  // In DEV (vitest), assertNever throws so unrecognized codes surface
  // immediately as Rust/TS enum drift rather than silently degrading.
  it("rejectionMessage throws on an unrecognized rejection code in DEV", () => {
    expect(() =>
      rejectionMessage({
        code: "unknownCode" as unknown as GameplayRejection["code"],
        context: gameplayRejectionContext(),
      }),
    ).toThrow("Unhandled rejection code");
  });

  it("warningMessage throws on an unrecognized warning code in DEV", () => {
    expect(() =>
      warningMessage({
        code: "unknownCode" as unknown as GameplayWarning["code"],
        context: gameplayRejectionContext(),
      }),
    ).toThrow("Unhandled warning code");
  });
});
