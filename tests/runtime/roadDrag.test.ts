import { describe, expect, it } from "vitest";
import {
  roadClickIntent,
  roadClickMutation,
  roadMutationForUi,
  roadMutationIsPrefix,
} from "../../src/runtime/roadMutations";
import { axisLockedLine, rectanglePoints } from "../../src/ui/roadDrag";
import { createUiState } from "../../src/ui/uiState";
import { createTestGameState } from "../helpers/gameState";
import { withRoads, withTracks } from "../helpers/mapFixtures";

describe("rectanglePoints", () => {
  const expected = [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 2, y: 4 },
    { x: 3, y: 4 },
    { x: 4, y: 4 },
  ];

  it("returns an inclusive row-major rectangle", () => {
    expect(rectanglePoints({ x: 2, y: 3 }, { x: 4, y: 4 })).toEqual(expected);
  });

  it("canonicalizes reverse drag direction", () => {
    expect(rectanglePoints({ x: 4, y: 4 }, { x: 2, y: 3 })).toEqual(expected);
  });

  it("keeps 1x1, 1xN, and Nx1 rectangles inclusive", () => {
    expect(rectanglePoints({ x: 7, y: 8 }, { x: 7, y: 8 })).toEqual([
      { x: 7, y: 8 },
    ]);
    expect(rectanglePoints({ x: 1, y: 2 }, { x: 3, y: 2 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ]);
    expect(rectanglePoints({ x: 2, y: 1 }, { x: 2, y: 3 })).toEqual([
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ]);
  });
});

describe("axisLockedLine", () => {
  it("locks to the horizontal axis when |dx| >= |dy|", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("locks to the vertical axis when |dy| > |dx|", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 1, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ]);
  });

  it("breaks ties toward horizontal", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it("returns a single tile when start equals end", () => {
    expect(axisLockedLine({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([
      { x: 5, y: 5 },
    ]);
  });
});

describe("road click preset gating", () => {
  const state = withRoads(createTestGameState(), [
    { x: 4, y: 4 },
    { x: 5, y: 4 },
    { x: 6, y: 4 },
  ]);

  it.each(["twoWay", "dualBidirectional"] as const)(
    "returns null for an existing road under the %s preset",
    (preset) => {
      expect(roadClickIntent(state, { x: 5, y: 4 }, preset)).toBeNull();
      expect(roadClickMutation(state, { x: 5, y: 4 }, preset)).toBeNull();
    },
  );

  it("cycles an existing road only under the oneWay preset", () => {
    expect(roadClickIntent(state, { x: 5, y: 4 }, "oneWay")).toEqual({
      type: "cycleRoadDirection",
      point: { x: 5, y: 4 },
    });
    expect(roadClickMutation(state, { x: 5, y: 4 }, "oneWay")).toEqual({
      type: "cycleRoadDirection",
      point: { x: 5, y: 4 },
    });
  });

  it.each(["twoWay", "oneWay", "dualBidirectional"] as const)(
    "lays a new road on an empty tile under the %s preset",
    (preset) => {
      expect(roadClickIntent(state, { x: 5, y: 7 }, preset)).toEqual({
        type: "layRoad",
        point: { x: 5, y: 7 },
      });
      expect(roadClickMutation(state, { x: 5, y: 7 }, preset)).toEqual({
        type: "layRoad",
        point: { x: 5, y: 7 },
      });
    },
  );

  it("gates a stationary drag on a road tile through the same decision", () => {
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      hoverTile: { x: 5, y: 4 },
      drag: {
        tool: "road" as const,
        start: { x: 5, y: 4 },
        current: { x: 5, y: 4 },
      },
    };
    expect(roadMutationForUi(state, ui)).toBeNull();
    expect(roadMutationForUi(state, { ...ui, roadPreset: "oneWay" })).toEqual({
      type: "cycleRoadDirection",
      point: { x: 5, y: 4 },
    });
  });

  it("gates the hover arm through the same decision", () => {
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      hoverTile: { x: 5, y: 4 },
    };
    expect(roadMutationForUi(state, ui)).toBeNull();
    expect(roadMutationForUi(state, { ...ui, roadPreset: "oneWay" })).toEqual({
      type: "cycleRoadDirection",
      point: { x: 5, y: 4 },
    });
  });

  it("keeps multi-tile strokes on layRoadLine with the captured preset", () => {
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      drag: {
        tool: "road" as const,
        start: { x: 4, y: 4 },
        current: { x: 6, y: 4 },
      },
    };
    expect(roadMutationForUi(state, ui)).toEqual({
      type: "layRoadLine",
      points: [
        { x: 4, y: 4 },
        { x: 5, y: 4 },
        { x: 6, y: 4 },
      ],
      preset: "oneWay",
    });
  });
});

describe("track mutation derivation", () => {
  it("derives layTrack for a track hover, even over existing track", () => {
    const state = withTracks(createTestGameState(), [{ x: 5, y: 5 }]);
    const ui = {
      ...createUiState(),
      activeTool: "track" as const,
      hoverTile: { x: 5, y: 5 },
    };
    expect(roadMutationForUi(state, ui)).toEqual({
      type: "layTrack",
      point: { x: 5, y: 5 },
    });
  });

  it("derives layTrack for a single-tile track drag", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "track" as const,
      drag: {
        tool: "track" as const,
        start: { x: 3, y: 3 },
        current: { x: 3, y: 3 },
      },
    };
    expect(roadMutationForUi(state, ui)).toEqual({
      type: "layTrack",
      point: { x: 3, y: 3 },
    });
  });

  it("derives layTrackLine with the same axis-locked points as a road stroke", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "track" as const,
      drag: {
        tool: "track" as const,
        start: { x: 2, y: 2 },
        current: { x: 5, y: 3 },
      },
    };
    expect(roadMutationForUi(state, ui)).toEqual({
      type: "layTrackLine",
      points: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
        { x: 5, y: 2 },
      ],
    });
  });
});

describe("track held-preview identity", () => {
  const stroke = (points: Array<{ x: number; y: number }>) =>
    ({ type: "layTrackLine", points }) as const;

  it("prefixes identical single-tile mutations for drag-start retention", () => {
    expect(
      roadMutationIsPrefix(
        { type: "layTrack", point: { x: 5, y: 5 } },
        { type: "layTrack", point: { x: 5, y: 5 } },
      ),
    ).toBe(true);
  });

  it("prefixes a shorter track stroke extended along the same line", () => {
    expect(
      roadMutationIsPrefix(
        stroke([
          { x: 4, y: 5 },
          { x: 5, y: 5 },
        ]),
        stroke([
          { x: 4, y: 5 },
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects a held track stroke the drag retracted past", () => {
    expect(
      roadMutationIsPrefix(
        stroke([
          { x: 4, y: 5 },
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ]),
        stroke([
          { x: 4, y: 5 },
          { x: 5, y: 5 },
        ]),
      ),
    ).toBe(false);
  });

  it("never prefixes across mutation kinds", () => {
    expect(
      roadMutationIsPrefix(
        { type: "layTrack", point: { x: 5, y: 5 } },
        stroke([
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ]),
      ),
    ).toBe(false);
    expect(
      roadMutationIsPrefix(
        stroke([
          { x: 5, y: 5 },
          { x: 6, y: 5 },
        ]),
        { type: "layRoadLine", points: [{ x: 5, y: 5 }], preset: "twoWay" },
      ),
    ).toBe(false);
  });
});
