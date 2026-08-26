import { describe, expect, it } from "vitest";
import { axisLockedLine, rectanglePoints } from "../../src/ui/roadDrag";

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
    expect(rectanglePoints({ x: 2, y: 3 }, { x: 4, y: 4 })).toEqual(
      expected,
    );
  });

  it("canonicalizes reverse drag direction", () => {
    expect(rectanglePoints({ x: 4, y: 4 }, { x: 2, y: 3 })).toEqual(
      expected,
    );
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
