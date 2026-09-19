import { describe, expect, it } from "vitest";
import type { WaitingLocationView } from "../../src/domain/types";
import { applyPresentationUpdate } from "../../src/runtime/presentationView";
import {
  createPresentationUpdate,
  createRustSnapshot,
} from "../fixtures/rustSnapshot";

function location(lineId: string, platformId: string): WaitingLocationView {
  return {
    lineId,
    platformId,
    waitingCount: 3,
    atRiskCount: 1,
    longestWaitSeconds: 90,
  };
}

describe("applyPresentationUpdate", () => {
  it("replaces waiting locations on frame-only updates instead of accumulating", () => {
    const initialUpdate = createPresentationUpdate(createRustSnapshot(), true);
    const initial = applyPresentationUpdate(null, {
      ...initialUpdate,
      frame: {
        ...initialUpdate.frame,
        waitingLocations: [location("route-001", "stop-001-p0")],
      },
    });
    expect(initial.waitingLocations).toEqual([
      location("route-001", "stop-001-p0"),
    ]);

    const next = applyPresentationUpdate(initial, {
      scene: null,
      frame: {
        ...initialUpdate.frame,
        waitingLocations: [
          location("route-002", "stop-002-p0"),
          location("route-003", "stop-003-p0"),
        ],
      },
    });

    expect(next.waitingLocations).toEqual([
      location("route-002", "stop-002-p0"),
      location("route-003", "stop-003-p0"),
    ]);
  });
});
