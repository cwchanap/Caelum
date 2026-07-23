import { describe, expect, it } from "vitest";
import type { RoutePreviewResponse } from "../../src/runtime/backend/types";
import {
  appendWaypoint,
  applyNodeClick,
  applyRouteNodeClick,
  canSaveRouteDraft,
  createDraft,
  editDraft,
  moveWaypoint,
  removeWaypoint,
  reverseRoute,
  selectWaypoint,
  setPattern,
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
  function draftWith(...waypointIds: string[]) {
    return { ...createDraft("bus", 1), waypointIds };
  }

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

  it("does not mutate or preview when appending the last stop again", () => {
    const draft = draftWith("stop-001");
    const result = applyNodeClick(draft, "stop-001");

    expect(result.draft).toBe(draft);
    expect(result.previewRequested).toBe(false);
  });

  it("selects an existing waypoint instead of appending it", () => {
    const draft = draftWith("a", "b");
    const result = applyNodeClick(draft, "a");

    expect(result.draft.waypointIds).toEqual(["a", "b"]);
    expect(result.draft.selectedIndex).toBe(0);
    expect(result.previewRequested).toBe(false);
  });

  it("appends after selecting an existing waypoint in append mode", () => {
    const draft = draftWith("a", "b");
    const selected = applyNodeClick(draft, "a");
    const result = applyNodeClick(selected.draft, "c");

    expect(result.draft.waypointIds).toEqual(["a", "b", "c"]);
    expect(result.previewRequested).toBe(true);
  });

  it("notices an insert duplicate without mutation", () => {
    const insertAfterDraft = selectWaypoint(
      draftWith("a", "b"),
      0,
      "insertAfter",
    );
    const result = applyNodeClick(insertAfterDraft, "a");

    expect(result.draft).toBe(insertAfterDraft);
    expect(result.notice).toEqual({ kind: "alreadyOnRoute", waypointId: "a" });
  });

  it("clears an old preview for every meaningful order change", () => {
    const draft = {
      ...createDraft("bus", 1),
      waypointIds: ["stop-0001", "stop-0002"],
      generation: 2,
      previewPending: false,
      preview: connectedPreview(2),
    };

    expect(removeWaypoint(selectWaypoint(draft, 0, "replace"))).toMatchObject({
      waypointIds: ["stop-0002"],
      generation: 3,
      previewPending: true,
      preview: null,
    });
  });

  it("returns the original draft for an invalid removal index", () => {
    const draft = createDraft("metro", 1);
    expect(removeWaypoint(draft)).toBe(draft);
  });
});

describe("route edit reducers", () => {
  const loop = editDraft(
    {
      routeId: "route-0001",
      expectedRevision: 7,
      mode: "bus",
      pattern: "loop",
      waypointIds: ["A", "B", "C"],
    },
    1,
  );

  it("inserts after the selected handle", () => {
    const selected = selectWaypoint(loop, 1, "insertAfter");
    expect(applyNodeClick(selected, "X").draft.waypointIds).toEqual([
      "A",
      "B",
      "X",
      "C",
    ]);
  });

  it("replaces exactly the selected handle", () => {
    const selected = selectWaypoint(loop, 1, "replace");
    expect(applyNodeClick(selected, "X").draft.waypointIds).toEqual([
      "A",
      "X",
      "C",
    ]);
  });

  it("removes and selects the nearest retained index", () => {
    expect(
      removeWaypoint(selectWaypoint(loop, 2, "replace")).selectedIndex,
    ).toBe(1);
  });

  it("moves the selected waypoint without losing selection", () => {
    const moved = moveWaypoint(selectWaypoint(loop, 1, "replace"), -1);
    expect(moved.waypointIds).toEqual(["B", "A", "C"]);
    expect(moved.selectedIndex).toBe(0);
  });

  it("keeps the first Loop waypoint fixed while reversing the rest", () => {
    expect(reverseRoute(loop).waypointIds).toEqual(["A", "C", "B"]);
  });

  it("reverses the complete Shuttle list", () => {
    expect(reverseRoute({ ...loop, pattern: "shuttle" }).waypointIds).toEqual([
      "C",
      "B",
      "A",
    ]);
  });

  it("increments generation and clears preview for every meaningful change", () => {
    const changed = setPattern(loop, "shuttle");
    expect(changed.generation).toBe(loop.generation + 1);
    expect(changed.preview).toBeNull();
    expect(changed.previewPending).toBe(true);
  });

  it("uses one pure save predicate for current valid previews", () => {
    const preview = {
      ...connectedPreview(0),
      legs: [
        {
          fromWaypointId: "A",
          toWaypointId: "B",
          direction: "loop" as const,
          kind: "service" as const,
          status: "connected" as const,
          currentPath: null,
          lastValidPath: null,
          estimatedSeconds: 1,
          failureReason: null,
        },
      ],
    };
    const draft = {
      ...createDraft("bus", 1),
      waypointIds: ["A", "B"],
      preview,
    };

    expect(canSaveRouteDraft(draft)).toBe(true);
    expect(
      canSaveRouteDraft({
        ...draft,
        preview: { ...preview, generation: draft.generation + 1 },
      }),
    ).toBe(false);
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
