import { describe, expect, it } from "vitest";
import type { RoutePreviewResponse } from "../../src/runtime/backend/types";
import {
  appendWaypoint,
  applyRouteNodeClick,
  createDraft,
  removeWaypoint,
} from "../../src/ui/routeDraft";

function connectedPreview(generation: number): RoutePreviewResponse {
  return {
    generation,
    legs: [],
    totalTravelSeconds: 0,
    initialVehicleCost: 8_000,
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

describe("route draft reducers", () => {
  it("creates the final creation-draft shape", () => {
    expect(createDraft("bus", 7)).toEqual({
      instanceId: 7,
      source: { kind: "create" },
      mode: "bus",
      pattern: "loop",
      waypointIds: [],
      selectedIndex: null,
      interaction: "append",
      generation: 0,
      previewPending: false,
      preview: null,
    });
  });

  it("appends before Rust reports a disconnected preview", () => {
    const draft = createDraft("bus", 1);
    const appended = appendWaypoint(draft, "stop-0002");

    expect(appended.waypointIds).toEqual(["stop-0002"]);
    expect(appended.generation).toBe(1);
    expect(appended.previewPending).toBe(true);
    expect(appended.preview).toBeNull();
  });

  it("clears an old preview for every meaningful order change", () => {
    const draft = {
      ...createDraft("bus", 1),
      waypointIds: ["stop-0001", "stop-0002"],
      generation: 2,
      previewPending: false,
      preview: connectedPreview(2),
    };

    expect(removeWaypoint(draft, 0)).toMatchObject({
      waypointIds: ["stop-0002"],
      generation: 3,
      previewPending: true,
      preview: null,
    });
  });

  it("returns the original draft for an invalid removal index", () => {
    const draft = createDraft("metro", 1);
    expect(removeWaypoint(draft, 0)).toBe(draft);
  });
});

describe("applyRouteNodeClick", () => {
  it("appends a node compatible with the draft mode", () => {
    const result = applyRouteNodeClick(createDraft("bus", 1), {
      id: "stop-0001",
      kind: "busStop",
      status: "present",
      position: { x: 2, y: 3 },
      platforms: [],
    });

    expect(result.rejection).toBeNull();
    expect(result.draft.waypointIds).toEqual(["stop-0001"]);
  });

  it("returns actionable feedback for an incompatible route node", () => {
    const draft = createDraft("metro", 1);
    const result = applyRouteNodeClick(draft, {
      id: "stop-0001",
      kind: "busStop",
      status: "present",
      position: { x: 2, y: 3 },
      platforms: [],
    });

    expect(result.draft).toBe(draft);
    expect(result.rejection).toEqual({
      code: "incompatibleRouteNode",
      context: { nodeId: "stop-0001", affectedRouteIds: [] },
    });
  });

  it("rejects a missing node before changing the draft", () => {
    const draft = createDraft("bus", 1);
    const result = applyRouteNodeClick(draft, {
      id: "stop-0001",
      kind: "busStop",
      status: "missing",
      position: { x: 2, y: 3 },
      platforms: [],
    });

    expect(result.draft).toBe(draft);
    expect(result.rejection).toEqual({
      code: "missingRouteNode",
      context: { nodeId: "stop-0001", affectedRouteIds: [] },
    });
  });
});
