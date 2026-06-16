# Road-building tool UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make road building drag-based with presets, auto-hide the build menu, show a cursor badge + build/delete mode tint, and add tool hotkeys — all on the existing road tile model with no simulation changes.

**Architecture:** A new pure module `src/ui/roadDrag.ts` computes axis-locked drag lines and applies them via existing pure helpers (`layRoad`, `setTileOneWay`, `layTrack`). The runtime gains `roadPreset` + `dragStart` UI state and `setRoadPreset` / `startDrag` / `commitDrag` / `cancelDrag` methods; `mountCanvas` wires `pointerdown`/`pointerup` for drags. Rendering adds a drag-line preview (in `overlayRenderer.ts`) and a screen-space cursor badge (`src/render/cursorBadge.ts`). Hotkeys live in `App.svelte`.

**Tech Stack:** TypeScript, Svelte 5 runes, Vite, Vitest (projects: ui/jsdom, runtime/node, simulation/node), Playwright e2e, Bun.

**Spec:** `docs/superpowers/specs/2026-06-16-road-building-ux-design.md`

**Conventions:** Immutable `GameState`/`UiState` (never mutate in place — the runtime only re-renders on reference change). Run a single test file with `bunx vitest run <path>`. Determinism contract: nothing here enters the `tickSimulation` pipeline.

---

## Reference: map layout for test coordinates

`src/scenario/growingSuburb.ts` `kindFor(x,y)` — map is 28×18:
- Roads: `y === 8 || x === 7 || x === 15 || x === 22`.
- Residential: `x 2..5, y 3..6`. Jobs: `x 10..13, y 4..7`. Civic: `x 18..20, y 10..12`. Park: `x 4..6, y 12..14`.
- Everything else is `empty`.

Safe-empty spans used by tests below: row `y=0` (`x 0..6` empty), row `y=1` (`x 1..4` empty), `y=0` above it; columns `x=24` and `x=25` and `x=23` (`y 0..4` empty); row `y=9` `x 24..26` empty with road row `y=8` directly above.

Costs (`src/simulation/transit.ts`): `COSTS.road = 100`, `COSTS.track = 500`.

---

### Task 1: RoadPreset type + UiState fields

**Files:**
- Modify: `src/domain/types.ts` (add `RoadPreset` near `Tool`)
- Modify: `src/ui/uiState.ts` (interface + factory)
- Test: `tests/ui/uiState.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/ui/uiState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createUiState } from "../../src/ui/uiState";

describe("createUiState road UX defaults", () => {
  it("defaults roadPreset to twoWay and dragStart to null", () => {
    const ui = createUiState();
    expect(ui.roadPreset).toBe("twoWay");
    expect(ui.dragStart).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/uiState.test.ts`
Expected: FAIL — `roadPreset`/`dragStart` do not exist on `UiState`.

- [ ] **Step 3: Add the type**

In `src/domain/types.ts`, directly after the `Tool` union (around line 35), add:

```ts
export type RoadPreset = "twoWay" | "oneWay" | "dualBidirectional";
```

- [ ] **Step 4: Add the UiState fields and defaults**

In `src/ui/uiState.ts`, extend the import from `../domain/types` to include `RoadPreset`:

```ts
import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  RoadPreset,
  Tool,
} from "../domain/types";
```

Add to the `UiState` interface (after `activeTool`):

```ts
  /** Road build style for the road tool's drag gesture. */
  roadPreset: RoadPreset;
  /** Pressed tile during an in-progress road/track/remove drag; null otherwise. */
  dragStart: Point | null;
```

Add to the object returned by `createUiState()`:

```ts
    roadPreset: "twoWay",
    dragStart: null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run tests/ui/uiState.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/ui/uiState.ts tests/ui/uiState.test.ts
git commit -m "feat(ui): add roadPreset and dragStart to UiState"
```

---

### Task 2: axisLockedLine

**Files:**
- Create: `src/ui/roadDrag.ts`
- Test: `tests/runtime/roadDrag.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/runtime/roadDrag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { axisLockedLine } from "../../src/ui/roadDrag";

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

  it("returns a single tile when start === end", () => {
    expect(axisLockedLine({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([
      { x: 5, y: 5 },
    ]);
  });

  it("walks in the negative direction", () => {
    expect(axisLockedLine({ x: 3, y: 0 }, { x: 0, y: 0 })).toEqual([
      { x: 3, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: FAIL — module `src/ui/roadDrag` does not exist.

- [ ] **Step 3: Create the module with axisLockedLine**

Create `src/ui/roadDrag.ts`:

```ts
import type { GameState, Point, RoadDirection } from "../domain/types";
import { getTile, setTileOneWay } from "../simulation/map";
import { layRoad, layTrack } from "../simulation/transit";
import type { UiState } from "./uiState";

/** Inclusive straight tile line from `start`, locked to the dominant axis.
 *  Ties (|dx| === |dy|) lock horizontal. start === end yields [start]. */
export function axisLockedLine(start: Point, end: Point): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const length = horizontal ? Math.abs(dx) : Math.abs(dy);
  const stepX = horizontal ? Math.sign(dx) : 0;
  const stepY = horizontal ? 0 : Math.sign(dy);
  const line: Point[] = [];
  for (let i = 0; i <= length; i += 1) {
    line.push({ x: start.x + stepX * i, y: start.y + stepY * i });
  }
  return line;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/roadDrag.ts tests/runtime/roadDrag.test.ts
git commit -m "feat(ui): add axisLockedLine for road drags"
```

---

### Task 3: applyDragGesture — track + single-lane road

**Files:**
- Modify: `src/ui/roadDrag.ts`
- Test: `tests/runtime/roadDrag.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/roadDrag.test.ts`:

```ts
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { getTile } from "../../src/simulation/map";
import { COSTS } from "../../src/simulation/transit";
import { createUiState } from "../../src/ui/uiState";
import { applyDragGesture } from "../../src/ui/roadDrag";

function tileAt(state: GameState, x: number, y: number) {
  const t = getTile(state.map, { x, y });
  if (t === null) throw new Error(`no tile at ${x},${y}`);
  return t;
}

const roadUi = (preset: "twoWay" | "oneWay") => ({
  ...createUiState(),
  activeTool: "road" as const,
  roadPreset: preset,
});

describe("applyDragGesture single-lane road", () => {
  it("lays a two-way road line and charges per tile", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).kind).toBe("road");
      expect(tileAt(next, x, 0).oneWay).toBeUndefined();
    }
    expect(next.budget).toBe(state.budget - 4 * COSTS.road);
  });

  it("lays a one-way road line in the eastbound drag direction", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).oneWay).toBe("east");
    }
  });

  it("lays one-way westbound when dragged in reverse", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 4, y: 0 }, { x: 1, y: 0 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).oneWay).toBe("west");
    }
  });

  it("lays one-way southbound for a vertical drag", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 0, y: 0 }, { x: 0, y: 3 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const y of [0, 1, 2, 3]) {
      expect(tileAt(next, 0, y).oneWay).toBe("south");
    }
  });

  it("redirects an existing one-way line back to two-way for free", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const oneWay = applyDragGesture(state, roadUi("oneWay"), line);
    expect(tileAt(oneWay, 2, 0).oneWay).toBe("east");
    const cleared = applyDragGesture(oneWay, roadUi("twoWay"), line);
    expect(tileAt(cleared, 2, 0).oneWay).toBeUndefined();
    expect(cleared.budget).toBe(oneWay.budget); // already road -> no charge
  });

  it("skips non-empty tiles in the line and only charges placed tiles", () => {
    const state = createInitialGameState();
    // Row y=3 crosses residential at x 2..5; x1 and x6 are empty.
    const line = axisLockedLine({ x: 1, y: 3 }, { x: 6, y: 3 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    expect(tileAt(next, 1, 3).kind).toBe("road");
    expect(tileAt(next, 2, 3).kind).toBe("residential");
    expect(tileAt(next, 6, 3).kind).toBe("road");
    expect(next.budget).toBe(state.budget - 2 * COSTS.road);
  });

  it("stops laying when the budget is exhausted mid-line", () => {
    const state = { ...createInitialGameState(), budget: 250 };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    expect(tileAt(next, 1, 0).kind).toBe("road");
    expect(tileAt(next, 2, 0).kind).toBe("road");
    expect(tileAt(next, 3, 0).kind).toBe("empty");
    expect(next.budget).toBe(50);
  });
});

describe("applyDragGesture track", () => {
  it("lays track along the line", () => {
    const state = createInitialGameState();
    const ui = { ...createUiState(), activeTool: "track" as const };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, ui, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).hasTrack).toBe(true);
    }
    expect(next.budget).toBe(state.budget - 4 * COSTS.track);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: FAIL — `applyDragGesture` is not exported.

- [ ] **Step 3: Implement applyDragGesture (single-lane + track)**

Append to `src/ui/roadDrag.ts`:

```ts
/** Drag-axis travel direction from the first two tiles (null if < 2 tiles). */
function lineDirection(line: Point[]): RoadDirection | null {
  if (line.length < 2) {
    return null;
  }
  const dx = line[1].x - line[0].x;
  const dy = line[1].y - line[0].y;
  if (dx > 0) return "east";
  if (dx < 0) return "west";
  if (dy > 0) return "south";
  return "north";
}

/** Lay/keep a road at `point` and set its direction (undefined = two-way).
 *  Existing roads are redirected (free); empty tiles are laid (charged);
 *  off-map / occupied / unaffordable tiles are skipped (no-op). */
function layLane(
  state: GameState,
  point: Point,
  direction: RoadDirection | undefined,
): GameState {
  const existing = getTile(state.map, point);
  const withRoad = existing?.kind === "road" ? state : layRoad(state, point);
  if (getTile(withRoad.map, point)?.kind !== "road") {
    return withRoad;
  }
  return { ...withRoad, map: setTileOneWay(withRoad.map, point, direction) };
}

/** Apply a >=2-tile road/track drag line. Routes by tool + road preset and
 *  composes existing pure helpers. Single-tile taps and the remove tool are
 *  handled by the runtime via the legacy click path, not here. */
export function applyDragGesture(
  state: GameState,
  ui: UiState,
  line: Point[],
): GameState {
  if (line.length === 0) {
    return state;
  }
  if (ui.activeTool === "track") {
    return line.reduce((acc, point) => layTrack(acc, point), state);
  }
  if (ui.activeTool === "road") {
    const direction =
      ui.roadPreset === "oneWay" ? (lineDirection(line) ?? undefined) : undefined;
    return line.reduce((acc, point) => layLane(acc, point, direction), state);
  }
  return state;
}
```

(`dualBidirectional` is added in Task 4; for now it falls through the `oneWay`/`twoWay` branch as a two-way line — Task 4 replaces that.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/roadDrag.ts tests/runtime/roadDrag.test.ts
git commit -m "feat(ui): applyDragGesture for two-way/one-way road and track lines"
```

---

### Task 4: applyDragGesture — 2-lane bidirectional

**Files:**
- Modify: `src/ui/roadDrag.ts`
- Test: `tests/runtime/roadDrag.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/roadDrag.test.ts`:

```ts
describe("applyDragGesture dual bidirectional", () => {
  const dualUi = {
    ...createUiState(),
    activeTool: "road" as const,
    roadPreset: "dualBidirectional" as const,
  };

  it("east drag: forward east on the dragged row, west on the lane to the north", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 1 }, { x: 4, y: 1 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 1).oneWay).toBe("east");
      expect(tileAt(next, x, 0).oneWay).toBe("west");
    }
    expect(next.budget).toBe(state.budget - 8 * COSTS.road);
  });

  it("west drag: forward west, east on the lane to the south", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 4, y: 1 }, { x: 1, y: 1 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 1).oneWay).toBe("west");
      expect(tileAt(next, x, 2).oneWay).toBe("east");
    }
  });

  it("south drag: forward south, north on the lane to the east", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 24, y: 0 }, { x: 24, y: 4 });
    const next = applyDragGesture(state, dualUi, line);
    for (const y of [0, 1, 2, 3, 4]) {
      expect(tileAt(next, 24, y).oneWay).toBe("south");
      expect(tileAt(next, 25, y).oneWay).toBe("north");
    }
  });

  it("north drag: forward north, south on the lane to the west", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 24, y: 4 }, { x: 24, y: 0 });
    const next = applyDragGesture(state, dualUi, line);
    for (const y of [0, 1, 2, 3, 4]) {
      expect(tileAt(next, 24, y).oneWay).toBe("north");
      expect(tileAt(next, 23, y).oneWay).toBe("south");
    }
  });

  it("never hijacks an existing road for the reverse lane", () => {
    const state = createInitialGameState();
    // Row y=9 is empty; the lane to the north (y=8) is an existing road row.
    const line = axisLockedLine({ x: 24, y: 9 }, { x: 26, y: 9 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [24, 25, 26]) {
      expect(tileAt(next, x, 9).oneWay).toBe("east"); // forward lane laid
      expect(tileAt(next, x, 8).kind).toBe("road");
      expect(tileAt(next, x, 8).oneWay).toBeUndefined(); // existing road untouched
    }
    expect(next.budget).toBe(state.budget - 3 * COSTS.road); // reverse lane skipped
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: FAIL — the dual-lane tests fail (current code lays a single two-way line, so `x,0`/`x,2`/reverse lanes have no `oneWay`).

- [ ] **Step 3: Implement dual-lane support**

In `src/ui/roadDrag.ts`, add the direction maps and the `layReverseLane` + `applyDualLane` helpers **above** `applyDragGesture`:

```ts
const REVERSE_OF: Record<RoadDirection, RoadDirection> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

/** Unit offset to the left of travel (right-hand-traffic 2nd-lane placement). */
const LEFT_OF: Record<RoadDirection, Point> = {
  north: { x: -1, y: 0 },
  east: { x: 0, y: -1 },
  south: { x: 1, y: 0 },
  west: { x: 0, y: 1 },
};

/** The reverse-lane tiles for a dual-lane drag (left-of-travel offset of every
 *  tile in `line`). Empty when the line has no axis. Shared by the gesture and
 *  the drag preview so both agree on the 2-lane footprint. */
export function reverseLanePoints(line: Point[]): Point[] {
  const forward = lineDirection(line);
  if (forward === null) {
    return [];
  }
  const offset = LEFT_OF[forward];
  return line.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
}

/** Lay a *new* reverse lane only on an empty, placeable tile — never hijacks an
 *  existing road and never runs off the map. */
function layReverseLane(
  state: GameState,
  point: Point,
  direction: RoadDirection,
): GameState {
  if (getTile(state.map, point)?.kind !== "empty") {
    return state;
  }
  const withRoad = layRoad(state, point);
  if (getTile(withRoad.map, point)?.kind !== "road") {
    return withRoad;
  }
  return { ...withRoad, map: setTileOneWay(withRoad.map, point, direction) };
}

function applyDualLane(state: GameState, line: Point[]): GameState {
  const forward = lineDirection(line);
  if (forward === null) {
    return line.reduce((acc, point) => layLane(acc, point, undefined), state);
  }
  const reverse = REVERSE_OF[forward];
  const withForward = line.reduce(
    (acc, point) => layLane(acc, point, forward),
    state,
  );
  return reverseLanePoints(line).reduce(
    (acc, point) => layReverseLane(acc, point, reverse),
    withForward,
  );
}
```

Then, in `applyDragGesture`, replace the `road` branch body with:

```ts
  if (ui.activeTool === "road") {
    if (ui.roadPreset === "dualBidirectional") {
      return applyDualLane(state, line);
    }
    const direction =
      ui.roadPreset === "oneWay" ? (lineDirection(line) ?? undefined) : undefined;
    return line.reduce((acc, point) => layLane(acc, point, direction), state);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/roadDrag.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/roadDrag.ts tests/runtime/roadDrag.test.ts
git commit -m "feat(ui): 2-lane bidirectional road drag with right-hand-traffic lanes"
```

---

### Task 5: Runtime — setRoadPreset + preset preservation

**Files:**
- Modify: `src/runtime/types.ts` (add methods to `RuntimeController`)
- Modify: `src/runtime/createGameRuntime.ts` (`setRoadPreset`, preserve preset, reset dragStart)
- Modify: `tests/ui/appShell.test.ts` (harness stubs for new methods)
- Test: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/gameRuntime.test.ts` (inside the top-level file, after the existing `describe("Game Runtime", ...)` block — a new describe):

```ts
describe("runtime road preset", () => {
  it("sets the road preset and preserves it across tool switches", () => {
    const runtime = createGameRuntime();
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setTool("track");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: FAIL — `setRoadPreset` is not a function (and TS error on `RuntimeController`).

- [ ] **Step 3: Add the methods to the controller interface**

In `src/runtime/types.ts`, add `RoadPreset` to the import from `../domain/types`:

```ts
import type {
  BuildingType,
  GameState,
  Overlay,
  Point,
  RoadPreset,
  Tool,
} from "../domain/types";
```

Add to the `RuntimeController` interface (after `setBuilding`):

```ts
  setRoadPreset: (preset: RoadPreset) => RuntimeSnapshot;
  startDrag: (point: Point) => RuntimeSnapshot;
  commitDrag: () => RuntimeSnapshot;
  cancelDrag: () => RuntimeSnapshot;
```

(`startDrag`/`commitDrag`/`cancelDrag` are implemented in Task 6, but declaring them now keeps the interface and the test harness in one place.)

- [ ] **Step 4: Implement setRoadPreset + preserve preset / reset dragStart**

In `src/runtime/createGameRuntime.ts`, import `RoadPreset`:

```ts
import type { BuildingType, Point, RoadPreset, Tool } from "../domain/types";
```

In `nextToolUiState`, add these two lines to the returned object (after `selectedRouteId: null,`):

```ts
    roadPreset: current.roadPreset,
    dragStart: null,
```

In `nextBuildingUiState`, add the same two lines to the returned object (after `selectedRouteId: null,`):

```ts
    roadPreset: current.roadPreset,
    dragStart: null,
```

Add the `setRoadPreset` method to the `api` object (after `setBuilding`):

```ts
    setRoadPreset(preset) {
      return commit(
        state,
        ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
      );
    },
```

- [ ] **Step 5: Add harness stubs so the App test still type-checks**

In `tests/ui/appShell.test.ts`, add stub methods to the `runtime` object (e.g. right after `setBuilding: vi.fn(...)`, before `rotateBuilding`):

```ts
    setRoadPreset: vi.fn((preset) => {
      ui = { ...ui, roadPreset: preset };
      return publish();
    }),
    startDrag: vi.fn((point: Point) => {
      ui = { ...ui, dragStart: point, hoverTile: point };
      return publish();
    }),
    commitDrag: vi.fn(() => {
      ui = { ...ui, dragStart: null };
      return publish();
    }),
    cancelDrag: vi.fn(() => {
      ui = { ...ui, dragStart: null };
      return publish();
    }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
git commit -m "feat(runtime): setRoadPreset and preset preservation across tool switches"
```

---

### Task 6: Runtime — startDrag / commitDrag / cancelDrag

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Test: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/gameRuntime.test.ts`:

```ts
describe("runtime road drag", () => {
  function tileKind(runtime: ReturnType<typeof createGameRuntime>, x: number, y: number) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((t) => t.x === x && t.y === y)?.kind;
  }

  it("builds a road line from startDrag -> hover -> commitDrag", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setHoverTile({ x: 4, y: 0 });
    const snap = runtime.commitDrag();
    for (const x of [1, 2, 3, 4]) {
      expect(tileKind(runtime, x, 0)).toBe("road");
    }
    expect(snap.ui.dragStart).toBeNull();
  });

  it("treats a zero-length drag as a tap (cycles an existing road's direction)", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.startDrag({ x: 8, y: 8 }); // existing road tile
    runtime.setHoverTile({ x: 8, y: 8 });
    runtime.commitDrag();
    expect(
      runtime.getSnapshot().state.map.tiles.find((t) => t.x === 8 && t.y === 8)
        ?.oneWay,
    ).toBe("north"); // first cycle: undefined -> north
  });

  it("bulldozes a line with the remove tool drag", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setHoverTile({ x: 3, y: 0 });
    runtime.commitDrag();
    runtime.setTool("remove");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setHoverTile({ x: 3, y: 0 });
    runtime.commitDrag();
    for (const x of [1, 2, 3]) {
      expect(tileKind(runtime, x, 0)).toBe("empty");
    }
  });

  it("cancelDrag clears the drag without building", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setHoverTile({ x: 4, y: 0 });
    runtime.cancelDrag();
    expect(runtime.getSnapshot().ui.dragStart).toBeNull();
    expect(tileKind(runtime, 4, 0)).toBe("empty");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: FAIL — `startDrag`/`commitDrag`/`cancelDrag` are not implemented.

- [ ] **Step 3: Implement the drag methods**

In `src/runtime/createGameRuntime.ts`, add to the imports from `../ui/roadDrag`:

```ts
import { applyDragGesture, axisLockedLine } from "../ui/roadDrag";
```

Add these methods to the `api` object (after `setRoadPreset`):

```ts
    startDrag(point) {
      return commit(state, { ...ui, dragStart: point, hoverTile: point });
    },
    cancelDrag() {
      return commit(state, ui.dragStart === null ? ui : { ...ui, dragStart: null });
    },
    commitDrag() {
      if (ui.dragStart === null || ui.hoverTile === null) {
        return commit(
          state,
          ui.dragStart === null ? ui : { ...ui, dragStart: null },
        );
      }
      const line = axisLockedLine(ui.dragStart, ui.hoverTile);
      // A tap (single tile) reuses the legacy click path so road cycling and
      // the full remove (buildings/nodes/routes + UI cleanup) are preserved.
      if (line.length <= 1) {
        const result = applyTileClick(state, ui, line[0]);
        return commit(result.state, { ...result.ui, dragStart: null });
      }
      // A remove drag deletes every tile via the same full per-tile removal.
      if (ui.activeTool === "remove") {
        let nextState = state;
        let nextUi = ui;
        for (const point of line) {
          const result = applyTileClick(nextState, nextUi, point);
          nextState = result.state;
          nextUi = result.ui;
        }
        return commit(nextState, { ...nextUi, dragStart: null });
      }
      // A road/track build drag uses the preset-aware line painter.
      return commit(applyDragGesture(state, ui, line), { ...ui, dragStart: null });
    },
```

(`applyTileClick` is already imported as `handleTileClick as applyTileClick`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat(runtime): startDrag/commitDrag/cancelDrag road gestures"
```

---

### Task 7: Auto-hide the build drawer on tool/building selection

**Files:**
- Modify: `src/runtime/createGameRuntime.ts` (`nextToolUiState`, `nextBuildingUiState`)
- Modify: `tests/runtime/gameRuntime.test.ts` (reorder the existing resetUi test so its `setHudCategory` survives)
- Test: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/gameRuntime.test.ts`:

```ts
describe("build drawer auto-hide", () => {
  it("closes the drawer when a tool or building is selected, but not on preset change", () => {
    const runtime = createGameRuntime();
    runtime.setHudCategory("build");
    runtime.setTool("road");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();

    runtime.setHudCategory("build");
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");

    runtime.setHudCategory("build");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: FAIL — first assertion fails (drawer stays `"build"` because `setTool` currently preserves `activeHudCategory`).

- [ ] **Step 3: Close the drawer in nextToolUiState/nextBuildingUiState**

In `src/runtime/createGameRuntime.ts`, add `activeHudCategory: null` to the returned object of **both** `nextToolUiState` and `nextBuildingUiState` (place it next to the `roadPreset`/`dragStart` lines added in Task 5):

```ts
    activeHudCategory: null,
```

- [ ] **Step 4: Repair the existing resetUi test (it interleaves setHudCategory + setTool)**

The test `"resets transient UI state without changing simulation state"` calls `setHudCategory("manage")` *before* `setTool(...)`. With auto-hide, the later `setTool` now nulls the category. Move the `setHudCategory("manage")` call so it runs **after** the tool setup, preserving the test's intent (reset clears a non-default category).

In `tests/runtime/gameRuntime.test.ts`, in that test, delete the `runtime.setHudCategory("manage");` line that currently sits before `runtime.setTool("busStop");`, and add it immediately **after** the last `runtime.handleTileClick({ x: 15, y: 8 });` of the busRoute setup (i.e. just before `const beforeReset = runtime.getSnapshot();`):

```ts
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
    runtime.setHudCategory("manage");

    const beforeReset = runtime.getSnapshot();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: PASS (both the new auto-hide test and the repaired resetUi test).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat(runtime): auto-hide build drawer when a tool or building is selected"
```

---

### Task 8: Canvas pointer wiring (drag gesture)

**Files:**
- Modify: `src/runtime/createGameRuntime.ts` (`mountCanvas`)

This task wires DOM pointer events to the runtime drag methods. It is verified by `bun run check` + the existing suite + the Task 13 e2e (jsdom lacks a real 2D canvas context, so there is no unit test for `mountCanvas` here — matching the existing codebase, which exercises canvas interaction only through Playwright).

- [ ] **Step 1: Add a drag-tool predicate and pointer handlers**

In `src/runtime/createGameRuntime.ts`, add a module-level constant near the top (after the imports):

```ts
const DRAG_TOOLS = new Set<Tool>(["road", "track", "remove"]);
```

In `mountCanvas`, change `handleClick` to early-return for drag tools (so a tap does not double-fire — `click` follows `pointerup`). Add the guard at the start of `handleClick`, right after the `if (canvas === null) { return; }`:

```ts
      if (DRAG_TOOLS.has(ui.activeTool)) {
        return; // road/track/remove are driven by pointerdown/up below.
      }
```

Add two new handlers next to `handlePointerMove`:

```ts
    const handlePointerDown = (event: PointerEvent): void => {
      if (canvas === null || !DRAG_TOOLS.has(ui.activeTool)) {
        return;
      }
      const point = canvasToTile(canvas, event.clientX, event.clientY, state.map);
      if (point !== null) {
        api.startDrag(point);
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      if (canvas === null || ui.dragStart === null) {
        return;
      }
      const point = canvasToTile(canvas, event.clientX, event.clientY, state.map);
      if (point !== null) {
        api.setHoverTile(point);
      }
      api.commitDrag();
    };
```

Update `handlePointerLeave` to abandon an in-flight drag:

```ts
    const handlePointerLeave = (): void => {
      if (ui.dragStart !== null) {
        api.cancelDrag();
      }
      api.setHoverTile(null);
    };
```

- [ ] **Step 2: Register and unregister the listeners**

In `mountCanvas`, after `canvas.addEventListener("pointermove", handlePointerMove);` add:

```ts
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
```

In the cleanup function, after `canvas.removeEventListener("pointermove", handlePointerMove);` add:

```ts
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointerup", handlePointerUp);
```

- [ ] **Step 3: Verify type-check and full suite pass**

Run: `bun run check && bunx vitest run`
Expected: PASS (no type errors; existing tests green).

- [ ] **Step 4: Commit**

```bash
git add src/runtime/createGameRuntime.ts
git commit -m "feat(runtime): wire canvas pointer events to road drag gestures"
```

---

### Task 9: Build panel — road preset selector

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Modify: `src/components/hud/HudDrawer.svelte`
- Modify: `src/App.svelte`
- Test: `tests/ui/buildPanel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui/buildPanel.test.ts`:

```ts
describe("BuildPanel road presets", () => {
  it("renders the three road presets and reports selection", async () => {
    const onSetRoadPreset = vi.fn();
    render(BuildPanel, {
      props: {
        activeTool: "road" as const,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset,
      },
    });
    expect(screen.getByRole("button", { name: "1-Lane" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1-Lane One-Way" })).toBeVisible();
    expect(screen.getByRole("button", { name: "2-Lane" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(onSetRoadPreset).toHaveBeenCalledWith("dualBidirectional");
  });
});
```

Also update the existing `renderPanel` helper at the top of the file to pass the new props (so the existing tests keep compiling). Change it to:

```ts
function renderPanel(onSetTool = vi.fn()) {
  render(BuildPanel, {
    props: {
      activeTool: "inspect" as const,
      selectedBuilding: null,
      buildingRotation: 0 as const,
      roadPreset: "twoWay" as const,
      onSetTool,
      onSetBuilding: vi.fn(),
      onRotateBuilding: vi.fn(),
      onSetRoadPreset: vi.fn(),
    },
  });
  return onSetTool;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/buildPanel.test.ts`
Expected: FAIL — preset buttons not found / `onSetRoadPreset` prop unknown.

- [ ] **Step 3: Add the preset selector to BuildPanel**

In `src/components/hud/panels/BuildPanel.svelte`, extend the imports and props. Change the type import line to include `RoadPreset`:

```ts
  import type {
    BuildingRotation,
    BuildingType,
    RoadPreset,
    Tool,
  } from "../../../domain/types";
```

Add to the `Props` interface:

```ts
    roadPreset: RoadPreset;
    onSetRoadPreset: (preset: RoadPreset) => void;
```

Add to the destructured `$props()`:

```ts
    roadPreset,
    onSetRoadPreset,
```

Add a presets list to the `<script>` (after `networkTools`):

```ts
  const roadPresets: Array<{ id: RoadPreset; label: string }> = [
    { id: "twoWay", label: "1-Lane" },
    { id: "oneWay", label: "1-Lane One-Way" },
    { id: "dualBidirectional", label: "2-Lane" },
  ];
```

In the Network `<section>`, after the network `toolbar` `</div>`, add the preset row:

```svelte
    <div class="toolbar toolbar--compact" aria-label="Road presets">
      {#each roadPresets as preset, index (preset.id)}
        <button
          type="button"
          data-road-preset={preset.id}
          aria-pressed={roadPreset === preset.id}
          aria-label={preset.label}
          class:active={roadPreset === preset.id}
          onclick={() => onSetRoadPreset(preset.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{preset.label}</span>
        </button>
      {/each}
    </div>
```

- [ ] **Step 4: Thread the props through HudDrawer**

In `src/components/hud/HudDrawer.svelte`:

Add `RoadPreset` to the `../../domain/types` import. Add to the `Props` interface:

```ts
    roadPreset: RoadPreset;
    onSetRoadPreset: (preset: RoadPreset) => void;
```

In the `<BuildPanel ... />` usage, add:

```svelte
        roadPreset={p.roadPreset}
        onSetRoadPreset={p.onSetRoadPreset}
```

- [ ] **Step 5: Thread the props through App**

In `src/App.svelte`:

Add to the imported types: `RoadPreset` (extend the `./domain/types` import). Add a handler near `handleSetBuilding`:

```ts
  function handleSetRoadPreset(preset: RoadPreset): void {
    setSnapshot(runtime.setRoadPreset(preset));
  }
```

In the `<HudDrawer ... />` usage, add:

```svelte
        roadPreset={snapshot.ui.roadPreset}
        onSetRoadPreset={handleSetRoadPreset}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bunx vitest run tests/ui/buildPanel.test.ts && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte src/components/hud/HudDrawer.svelte src/App.svelte tests/ui/buildPanel.test.ts
git commit -m "feat(ui): road preset selector in the build panel"
```

---

### Task 10: Drag-line preview + tool hover tint

**Files:**
- Modify: `src/render/overlayRenderer.ts`
- Test: `tests/render/overlayRenderer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/render/overlayRenderer.test.ts` (extend the existing `fakeCtx` import usage; this file already defines a `fakeCtx`). Add a richer fake context local to the new tests and the new cases:

```ts
import { axisLockedLine } from "../../src/ui/roadDrag";
import { colors } from "../../src/render/colors";

function dragCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe("renderOverlays drag preview", () => {
  it("fills each tile of a road drag line with the build (green) tint", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      dragStart: { x: 1, y: 0 },
      hoverTile: { x: 4, y: 0 },
    };
    renderOverlays(ctx, state, ui);
    const line = axisLockedLine(ui.dragStart, ui.hoverTile);
    // One fillRect per previewed tile (at minimum).
    expect((ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThanOrEqual(line.length);
    expect(ctx.fillStyle).toBe(colors.previewValid);
  });

  it("uses the delete (red) tint for a remove drag line", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      dragStart: { x: 1, y: 0 },
      hoverTile: { x: 3, y: 0 },
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillStyle).toBe(colors.previewInvalid);
  });

  it("previews both lanes for the dual-bidirectional preset", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      dragStart: { x: 1, y: 1 },
      hoverTile: { x: 4, y: 1 },
    };
    renderOverlays(ctx, state, ui);
    // 4 forward tiles + 4 reverse-lane tiles = 8 fillRect calls (at minimum).
    expect(
      (ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/render/overlayRenderer.test.ts`
Expected: FAIL — no drag preview is drawn yet (fillStyle never set to the preview tints for a drag).

- [ ] **Step 3: Implement the drag preview**

In `src/render/overlayRenderer.ts`, add the import for the line helpers and the type:

```ts
import { axisLockedLine, reverseLanePoints } from "../ui/roadDrag";
import type { GameState, Point, Tool } from "../domain/types";
```

(Adjust the existing `import type { GameState, Point } ...` line to include `Tool`.)

Add a helper above `renderOverlays`:

```ts
const DRAG_PREVIEW_TOOLS: Tool[] = ["road", "track", "remove"];

function renderDragPreview(
  ctx: CanvasRenderingContext2D,
  ui: UiState,
): void {
  if (
    ui.dragStart === null ||
    ui.hoverTile === null ||
    !DRAG_PREVIEW_TOOLS.includes(ui.activeTool)
  ) {
    return;
  }
  const isDelete = ui.activeTool === "remove";
  ctx.fillStyle = isDelete ? colors.previewInvalid : colors.previewValid;
  ctx.strokeStyle = isDelete
    ? colors.previewInvalidStroke
    : colors.previewValidStroke;
  ctx.lineWidth = 2;
  const line = axisLockedLine(ui.dragStart, ui.hoverTile);
  // Dual preset shows both lanes so the 2-lane footprint is visible while
  // dragging. Direction is conveyed by the cursor badge and committed arrows.
  const tiles =
    ui.activeTool === "road" && ui.roadPreset === "dualBidirectional"
      ? [...line, ...reverseLanePoints(line)]
      : line;
  for (const point of tiles) {
    fillTile(ctx, point);
    strokeTile(ctx, point);
  }
}
```

In `renderOverlays`, replace the final hover block. Currently it ends with the building-preview early-return then the plain hover stroke. Change the tail so a drag preview takes priority:

```ts
  if (ui.dragStart !== null) {
    renderDragPreview(ctx, ui);
    return;
  }

  if (ui.hoverTile !== null && ui.selectedBuilding !== null) {
    renderBuildingPreview(ctx, state, ui);
    return;
  }

  if (ui.hoverTile !== null && isInMap(state, ui.hoverTile)) {
    ctx.strokeStyle = colors.hover;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      ui.hoverTile.x * tileSize + 2,
      ui.hoverTile.y * tileSize + 2,
      tileSize - 4,
      tileSize - 4,
    );
  }
```

(The `renderDragPreview` block is the only addition; keep the existing building-preview and hover-stroke blocks as shown.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/render/overlayRenderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/overlayRenderer.ts tests/render/overlayRenderer.test.ts
git commit -m "feat(render): drag-line preview with build/delete tint"
```

---

### Task 11: Cursor badge

**Files:**
- Create: `src/render/cursorBadge.ts`
- Modify: `src/render/canvas.ts` (call the badge pass after `ctx.restore()`)
- Test: `tests/render/cursorBadge.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/render/cursorBadge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { renderCursorBadge } from "../../src/render/cursorBadge";
import { getBoardTransform } from "../../src/render/canvas";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";

function badgeCtx() {
  const calls: string[] = [];
  const ctx = {
    canvas: { width: 896, height: 576 },
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn((text: string) => calls.push(text)),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("renderCursorBadge", () => {
  it("draws nothing when there is no hover tile", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    renderCursorBadge(ctx, state, createUiState(), getBoardTransform(ctx.canvas, state.map));
    expect(calls).toHaveLength(0);
  });

  it("labels the one-way road preset with a direction glyph", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("Road");
    expect(calls.join("")).toContain("→");
  });

  it("labels the remove tool as Demolish", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("Demolish");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/render/cursorBadge.test.ts`
Expected: FAIL — module `src/render/cursorBadge` does not exist.

- [ ] **Step 3: Create the cursor badge module**

Create `src/render/cursorBadge.ts`:

```ts
import type { GameState } from "../domain/types";
import {
  BUILDING_CATALOG,
  canPlaceBuilding,
} from "../simulation/buildings";
import {
  getTile,
  isValidRoadPlacement,
  isValidTrackPlacement,
} from "../simulation/map";
import type { UiState } from "../ui/uiState";
import type { BoardTransform } from "./canvas";
import { tileSize } from "./canvas";
import { colors } from "./colors";

/** Tool/preset label shown on the cursor, or null when no badge applies. */
function badgeText(state: GameState, ui: UiState): string | null {
  if (ui.hoverTile === null) {
    return null;
  }
  if (ui.selectedBuilding !== null) {
    const def = BUILDING_CATALOG[ui.selectedBuilding];
    const ok =
      state.budget >= def.cost &&
      canPlaceBuilding(state, ui.selectedBuilding, ui.hoverTile, ui.buildingRotation);
    return `⦿ ${def.label} ${ui.buildingRotation}°${ok ? "" : " ⊘"}`;
  }
  switch (ui.activeTool) {
    case "road": {
      const glyph =
        ui.roadPreset === "oneWay"
          ? " →"
          : ui.roadPreset === "dualBidirectional"
            ? " ⇄"
            : "";
      const ok =
        isValidRoadPlacement(state, ui.hoverTile) ||
        getTile(state.map, ui.hoverTile)?.kind === "road";
      return `⦿ Road${glyph}${ok ? "" : " ⊘"}`;
    }
    case "track":
      return `⦿ Track${isValidTrackPlacement(state, ui.hoverTile) ? "" : " ⊘"}`;
    case "remove":
      return "⦿ Demolish";
    default:
      return null;
  }
}

export function renderCursorBadge(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  transform: BoardTransform,
): void {
  const text = badgeText(state, ui);
  if (text === null || ui.hoverTile === null) {
    return;
  }
  const centerX =
    transform.offsetX + (ui.hoverTile.x + 0.5) * tileSize * transform.scale;
  const tileTop =
    transform.offsetY + ui.hoverTile.y * tileSize * transform.scale;

  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padding = 6;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 20;
  const boxX = centerX - width / 2;
  const boxY = tileTop - height - 8;

  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}
```

- [ ] **Step 4: Add the badge colors**

In `src/render/colors.ts`, add two tokens before the closing `} as const;`:

```ts
  badgeBackground: "rgba(17, 24, 32, 0.88)",
  badgeText: "#e8eef0",
```

- [ ] **Step 5: Call the badge pass from renderGame**

In `src/render/canvas.ts`, import the badge and call it after `ctx.restore()` in `renderGame`:

```ts
import { renderCursorBadge } from "./cursorBadge";
```

At the end of `renderGame`, after `ctx.restore();`:

```ts
  renderCursorBadge(ctx, state, ui, transform);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bunx vitest run tests/render/cursorBadge.test.ts && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/render/cursorBadge.ts src/render/canvas.ts src/render/colors.ts tests/render/cursorBadge.test.ts
git commit -m "feat(render): cursor badge for active tool/road preset"
```

---

### Task 12: Hotkeys

**Files:**
- Modify: `src/App.svelte`
- Test: `tests/ui/appShell.test.ts`

Hotkeys: `B` toggle Build drawer · `R` rotate building if one is selected else Road tool · `T` Track · `X` Remove · `V` Inspect · `1`/`2`/`3` road preset (Road tool active) · `Esc` existing cancel/reset. Ignored while typing in inputs or when a modifier key is held.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui/appShell.test.ts` (these use the existing `createRuntimeHarness` + `render(App, ...)` pattern; check the file for how `App` is rendered in existing tests and mirror it). Add:

```ts
describe("App hotkeys", () => {
  it("selects the road tool on 'r' when no building is selected", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.setTool).toHaveBeenCalledWith("road");
  });

  it("toggles the build drawer on 'b'", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b" });
    expect(runtime.setHudCategory).toHaveBeenCalledWith("build");
  });

  it("rotates the building on 'r' when a building is selected", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), selectedBuilding: "smallHouse" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.rotateBuilding).toHaveBeenCalled();
    expect(runtime.setTool).not.toHaveBeenCalledWith("road");
  });

  it("selects a road preset on '2' while the road tool is active", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), activeTool: "road" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "2" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("oneWay");
  });

  it("ignores hotkeys typed into an input field", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await fireEvent.keyDown(input, { key: "r" });
    expect(runtime.setTool).not.toHaveBeenCalledWith("road");
    input.remove();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/ui/appShell.test.ts`
Expected: FAIL — hotkeys not handled.

- [ ] **Step 3: Implement the hotkeys**

In `src/App.svelte`, add a text-input guard helper in the `<script>`:

```ts
  function isTextInput(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    );
  }
```

Replace the body of `handleWindowKeydown` with:

```ts
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (shellError) {
      return;
    }

    if (event.key === "Escape") {
      // Escape mirrors the Cancel button; respect the same canCancel gate.
      if (snapshot !== null && !snapshot.shell.hud.canCancel) {
        return;
      }
      setSnapshot(runtime.resetUi());
      return;
    }

    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isTextInput(event.target)
    ) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "b") {
      const next = snapshot?.ui.activeHudCategory === "build" ? null : "build";
      setSnapshot(runtime.setHudCategory(next));
      return;
    }
    if (key === "r") {
      if (snapshot?.ui.selectedBuilding != null) {
        setSnapshot(runtime.rotateBuilding());
      } else {
        setSnapshot(runtime.setTool("road"));
      }
      return;
    }
    if (key === "t") {
      setSnapshot(runtime.setTool("track"));
      return;
    }
    if (key === "x") {
      setSnapshot(runtime.setTool("remove"));
      return;
    }
    if (key === "v") {
      setSnapshot(runtime.setTool("inspect"));
      return;
    }
    if (
      (key === "1" || key === "2" || key === "3") &&
      snapshot?.ui.activeTool === "road"
    ) {
      const preset =
        key === "1" ? "twoWay" : key === "2" ? "oneWay" : "dualBidirectional";
      setSnapshot(runtime.setRoadPreset(preset));
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/ui/appShell.test.ts && bun run check`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte tests/ui/appShell.test.ts
git commit -m "feat(ui): tool/build hotkeys (B/R/T/X/V/1-3) with input guard"
```

---

### Task 13: e2e — drag helper + smoke updates

**Files:**
- Modify: `tests/e2e/helpers.ts` (add `dragMapTiles`)
- Modify: `tests/e2e/smoke.spec.ts` (account for auto-hide + rotate hotkey; add a drag-build assertion)

- [ ] **Step 1: Add a drag helper**

In `tests/e2e/helpers.ts`, after `clickMapTile`, add:

```ts
/** Press-drag from one map tile to another on the runtime canvas. */
export async function dragMapTiles(
  page: Page,
  canvas: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const scale = Math.min(
    box.width / (mapWidth * tileSize),
    box.height / (mapHeight * tileSize),
  );
  const offsetX = (box.width - mapWidth * tileSize * scale) / 2;
  const offsetY = (box.height - mapHeight * tileSize * scale) / 2;
  const at = (tile: { x: number; y: number }) => ({
    x: box.x + offsetX + (tile.x + 0.5) * tileSize * scale,
    y: box.y + offsetY + (tile.y + 0.5) * tileSize * scale,
  });
  const start = at(from);
  const end = at(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
```

- [ ] **Step 2: Update the smoke spec for auto-hide + rotate hotkey, and assert a drag build**

In `tests/e2e/smoke.spec.ts`, update the import to include `dragMapTiles`:

```ts
import { clickMapTile, dragMapTiles, openHudCategory } from "./helpers";
```

Replace the building/rotate block (current lines 45–55) with the following. After selecting a building the drawer now auto-hides, so re-open it before the next panel selection, and rotate via the `R` hotkey rather than the (now-hidden) Rotate button. Also add a road drag build:

```ts
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Small House" }).click();
  await clickMapTile(canvas, { x: 0, y: 1 });

  await expect(topbar.getByText("$116,000")).toBeVisible();
  await expect(populationReadout.getByText("40")).toBeVisible();

  // Build a road line by dragging (road tool drag, two-way preset by default).
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await dragMapTiles(page, canvas, { x: 0, y: 0 }, { x: 3, y: 0 });
  // Four road tiles at $100 each: 116,000 - 400 = 115,600.
  await expect(topbar.getByText("$115,600")).toBeVisible();

  // Select a building, then rotate it with the hotkey (drawer is auto-hidden).
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");
```

- [ ] **Step 3: Run the e2e smoke test**

Run: `bunx playwright test tests/e2e/smoke.spec.ts`
Expected: PASS. (If Playwright browsers are not installed, run `bunx playwright install` first.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/helpers.ts tests/e2e/smoke.spec.ts
git commit -m "test(e2e): drag-build smoke and auto-hide/rotate-hotkey updates"
```

---

### Task 14: Full verification

- [ ] **Step 1: Run the entire gate locally**

```bash
bun run check
bun run lint
bun run test
bunx playwright test
```

Expected: all green. If `bun run lint` flags unused vars, prefix with `_`. If `format:check` is part of your pre-commit, run `bunx prettier --write .` on touched files.

- [ ] **Step 2: Manual smoke (optional but recommended)**

```bash
bun run dev
```

Verify by hand: press `B` (drawer opens), `R` (drawer hides, cursor shows `⦿ Road`), drag across empty tiles (green ghost line builds road), `2` (badge shows `⦿ Road →`), drag (one-way arrows), `3` then drag (two parallel opposing lanes), `X` then drag (red ghost line bulldozes), select a building then `R` to rotate.

- [ ] **Step 3: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: format and lint fixes for road-building UX"
```

---

## Self-Review

**Spec coverage:**
- Goal 1 (auto-hide menu + type on cursor): Task 7 (auto-hide) + Task 11 (cursor badge). ✓
- Goal 2 (drag to build/redirect): Tasks 2–4 (line + gesture), Task 6 (runtime), Task 8 (pointer wiring). ✓
- Goal 3 (three presets): Task 1 (type), Tasks 3–4 (apply), Task 9 (selector UI). ✓
- Goal 4 (build vs delete indicator): Task 10 (drag tint) + Task 11 (badge `⦿ Demolish` / `⊘`). ✓
- Goal 5 (hotkeys): Task 12. ✓
- Spec §C single-tile parity: Task 6 (`commitDrag` routes taps to `applyTileClick`); covered by the cycle test. ✓
- Spec §D right-hand-traffic dual lanes: Task 4 (LEFT_OF / REVERSE_OF), all four axes tested. ✓
- Spec §F preset keeps drawer open: Task 7 test. ✓
- Spec §G input guard + modifier ignore: Task 12. ✓
- Spec extra (rotate stranded by auto-hide): resolved by context-sensitive `R` in Task 12 + e2e rotate-hotkey in Task 13. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `RoadPreset = "twoWay" | "oneWay" | "dualBidirectional"` used consistently across `types.ts`, `uiState.ts`, `roadDrag.ts`, `runtime/types.ts`, `BuildPanel.svelte`, `cursorBadge.ts`. New controller methods `setRoadPreset`/`startDrag`/`commitDrag`/`cancelDrag` are declared in `RuntimeController` (Task 5), implemented in the runtime (Tasks 5–6), and stubbed in the App harness (Task 5). `applyDragGesture(state, ui, line)` and `axisLockedLine(start, end)` signatures match every call site. ✓
