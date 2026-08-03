import { describe, expect, it } from "vitest";
import {
  rejectionMessage,
  routeFailureGuidance,
  warningMessage,
} from "../../src/runtime/rejectionMessages";
import type { GameplayRejection } from "../../src/domain/types";
import type { GameplayWarning } from "../../src/runtime/backend/types";

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
  const baseContext = GameplayRejectionContext();

  it("formats insufficientBudget", () => {
    const warning: GameplayWarning = {
      code: "insufficientBudget",
      context: { requiredBudget: 500, availableBudget: 200 },
    };
    expect(warningMessage(warning)).toBe("Need $500; only $200 available.");
  });

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

function GameplayRejectionContext(): GameplayRejection["context"] {
  return { affectedRouteIds: [] };
}

describe("assertNever fallbacks", () => {
  // In DEV (vitest), assertNever throws so unrecognized codes surface
  // immediately as Rust/TS enum drift rather than silently degrading.
  it("rejectionMessage throws on an unrecognized rejection code in DEV", () => {
    expect(() =>
      rejectionMessage({
        code: "unknownCode" as unknown as GameplayRejection["code"],
        context: GameplayRejectionContext(),
      }),
    ).toThrow("Unhandled rejection code");
  });

  it("warningMessage throws on an unrecognized warning code in DEV", () => {
    expect(() =>
      warningMessage({
        code: "unknownCode" as unknown as GameplayWarning["code"],
        context: GameplayRejectionContext(),
      }),
    ).toThrow("Unhandled rejection code");
  });
});
