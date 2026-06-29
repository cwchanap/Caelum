# Road Direction & Multilane Roads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in one-way `direction` attribute to road lanes so bus routing is constrained by traffic direction, with multilane roads formed by laying parallel lane-tiles.

**Architecture:** A new optional `oneWay?: RoadDirection` field on `Tile` mirrors the existing `hasTrack?` layer. `findTilePath` gains a bus-only "exit constraint" (you may only leave a one-way tile along its arrow). The Road tool lays two-way roads on empty tiles and cycles direction (`two-way → north → east → south → west → two-way`) on existing roads, reusing `recomputeRoutePaths` for route revalidation. A render pass draws direction arrows. Two-way tiles (`oneWay === undefined`) behave exactly as today, so the deterministic Growing Suburb scenario and all existing tests are unchanged.

**Tech Stack:** TypeScript, Vitest (projects: `simulation` / `runtime` node, `ui` / `render` jsdom), Bun, canvas 2D rendering.

**Spec:** `docs/superpowers/specs/2026-06-14-road-direction-multilane-design.md`

---

## File Structure

Files created/modified, each with one responsibility:

- **`src/domain/types.ts`** (modify) — `RoadDirection` union, `oneWay?` on `Tile`, and the `ROAD_DIRECTION_OFFSET` cardinal→`Point` mapping (the single source of truth for direction vectors, shared by pathfinding and rendering).
- **`legacy-ts-simulation/network.ts`** (modify) — `findTilePath` honours the one-way exit constraint for bus mode.
- **`legacy-ts-simulation/map.ts`** (modify) — `setTileOneWay` helper; `setTileKind` clears `oneWay` whenever a tile stops being a road.
- **`legacy-ts-simulation/transit.ts`** (modify) — `cycleRoadDirection` action (cycles `oneWay`, runs `recomputeRoutePaths`).
- **`src/ui/actions.ts`** (modify) — Road tool branch: empty tile → lay, existing road → cycle direction.
- **`src/render/colors.ts`** (modify) — `oneWayArrow` colour.
- **`src/render/mapRenderer.ts`** (modify) — one-way arrow render pass.
- **`tests/simulation/network.test.ts`**, **`tests/simulation/map.test.ts`**, **`tests/simulation/transit.test.ts`**, **`tests/ui/actions.test.ts`**, **`tests/render/mapRenderer.test.ts`** (modify) — coverage.

Map facts used by tests (from `src/scenario/growingSuburb.ts`): map is 28×18. Roads = row `y=8` (all x) plus columns `x=7`, `x=15`, `x=22` (all y). `tileSize = 32`, so tile `(x,y)` center = `(32x+16, 32y+16)`.

---

## Task 1: One-way pathfinding constraint (data model + `findTilePath`)

**Files:**
- Modify: `src/domain/types.ts` (add `RoadDirection`, `oneWay?`, `ROAD_DIRECTION_OFFSET`)
- Modify: `legacy-ts-simulation/network.ts` (exit constraint)
- Test: `tests/simulation/network.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these helpers and tests to `tests/simulation/network.test.ts`. Add `RoadDirection` to the existing type import on line 2, i.e. `import type { GameState, Point, RoadDirection } from "../../src/domain/types";`.

```ts
function withRoad(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((p) => `${p.x},${p.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, kind: "road" } : tile,
      ),
    },
  };
}

function withOneWay(
  state: GameState,
  entries: Array<{ x: number; y: number; oneWay: RoadDirection }>,
): GameState {
  const byKey = new Map(entries.map((e) => [`${e.x},${e.y}`, e.oneWay]));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        const oneWay = byKey.get(`${tile.x},${tile.y}`);
        return oneWay === undefined ? tile : { ...tile, oneWay };
      }),
    },
  };
}

describe("findTilePath one-way roads", () => {
  it("permits forward traversal of a one-way road and blocks the reverse", () => {
    const state = withOneWay(createInitialGameState(), [
      { x: 8, y: 8, oneWay: "east" },
    ]);
    // Forward: (7,8) -> (9,8) crosses (8,8) heading east.
    expect(
      findTilePath(state.map, { x: 7, y: 8 }, { x: 9, y: 8 }, "bus"),
    ).toEqual([
      { x: 7, y: 8 },
      { x: 8, y: 8 },
      { x: 9, y: 8 },
    ]);
    // Reverse is impossible: y=8 is the only horizontal road, and (8,8) may
    // only be exited eastward, so there is no way back west.
    expect(
      findTilePath(state.map, { x: 9, y: 8 }, { x: 7, y: 8 }, "bus"),
    ).toBeNull();
  });

  it("leaves two-way roads traversable in both directions", () => {
    const state = createInitialGameState();
    expect(
      findTilePath(state.map, { x: 9, y: 8 }, { x: 7, y: 8 }, "bus"),
    ).toEqual([
      { x: 9, y: 8 },
      { x: 8, y: 8 },
      { x: 7, y: 8 },
    ]);
  });

  it("ignores one-way direction for metro/track pathing", () => {
    let state = withTrack(createInitialGameState(), trackRow(8, 7, 9));
    state = withOneWay(state, [{ x: 8, y: 8, oneWay: "east" }]);
    // (8,8) is a road+track crossing; oneWay constrains buses only, so metro
    // still traverses it in reverse.
    expect(
      findTilePath(state.map, { x: 9, y: 8 }, { x: 7, y: 8 }, "metro"),
    ).toHaveLength(3);
  });

  it("routes a two-way corridor built from opposing one-way lanes", () => {
    // Rectangle loop between the x=7 and x=15 road columns: top row y=8 and a
    // new parallel bottom row y=9 (interior x=8..14; (7,9) and (15,9) are
    // already road from the columns). Top interior = one-way east, bottom
    // interior = one-way west; the x=7/x=15 corners stay two-way.
    const interiorXs = [8, 9, 10, 11, 12, 13, 14];
    let state = withRoad(
      createInitialGameState(),
      interiorXs.map((x) => ({ x, y: 9 })),
    );
    state = withOneWay(state, [
      ...interiorXs.map((x) => ({ x, y: 8, oneWay: "east" as const })),
      ...interiorXs.map((x) => ({ x, y: 9, oneWay: "west" as const })),
    ]);

    const forward = findTilePath(state.map, { x: 7, y: 8 }, { x: 15, y: 8 }, "bus");
    expect(forward).not.toBeNull();
    expect(forward?.every((p) => p.y === 8)).toBe(true);

    const reverse = findTilePath(state.map, { x: 15, y: 8 }, { x: 7, y: 8 }, "bus");
    expect(reverse).not.toBeNull();
    // The return trip cannot use the eastbound top row, so it drops to y=9.
    expect(reverse?.some((p) => p.y === 9)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: FAIL — TypeScript error that `RoadDirection` / `oneWay` do not exist, and the one-way assertions fail (reverse currently returns a path).

- [ ] **Step 3: Add the data model to `src/domain/types.ts`**

Add the type and offset map. Place `RoadDirection` near `TileKind` (after line 7) and add `oneWay?` to `Tile`:

```ts
export type RoadDirection = "north" | "east" | "south" | "west";
```

```ts
export interface Tile extends Point {
  id: string;
  kind: TileKind;
  districtId?: string;
  /** Track is a layer, not a TileKind: a road tile with track is a level crossing. */
  hasTrack?: boolean;
  /** One-way constraint on a road lane. Undefined = two-way (default). */
  oneWay?: RoadDirection;
}
```

Add the shared offset mapping (single source of truth for direction vectors). Put it just after the `Point` interface so `Point` is in scope:

```ts
export const ROAD_DIRECTION_OFFSET: Record<RoadDirection, Point> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};
```

- [ ] **Step 4: Add the exit constraint to `legacy-ts-simulation/network.ts`**

Import the offset map (add to the existing type import on line 1):

```ts
import type { GameMap, Point, Tile } from "../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../domain/types";
```

In `findTilePath`, inside the `for (let head ...)` loop, look up the current tile once and skip neighbour offsets that violate a one-way exit. Replace the start of the loop body:

```ts
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const currentTile = tileByKey.get(positionKey(current.x, current.y));

    for (const offset of neighborOffsets) {
      // One-way roads constrain buses only: a directed road tile may be left
      // only along its arrow. Metro ignores it (tracks have no direction).
      if (
        mode === "bus" &&
        currentTile?.kind === "road" &&
        currentTile.oneWay !== undefined
      ) {
        const allowed = ROAD_DIRECTION_OFFSET[currentTile.oneWay];
        if (offset.x !== allowed.x || offset.y !== allowed.y) {
          continue;
        }
      }

      const next = { x: current.x + offset.x, y: current.y + offset.y };
      const nextKey = positionKey(next.x, next.y);
```

Leave the rest of the loop body unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: PASS (all `findTilePath` tests, new and existing).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts legacy-ts-simulation/network.ts tests/simulation/network.test.ts
git commit -m "feat: one-way road exit constraint in bus pathfinding"
```

---

## Task 2: Map helpers — `setTileOneWay` and `oneWay` clearing

**Files:**
- Modify: `legacy-ts-simulation/map.ts`
- Test: `tests/simulation/map.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/simulation/map.test.ts`. Extend the import on line 5–13 to include `setTileKind`, `setTileOneWay`:

```ts
import {
  applyDueGrowthWaves,
  getTile,
  isValidBusStopPlacement,
  isValidCivicAnchorPlacement,
  isValidMetroStationPlacement,
  isValidRoadPlacement,
  isValidTrackPlacement,
  setTileKind,
  setTileOneWay,
} from "../../legacy-ts-simulation/map";
```

```ts
describe("road direction helpers", () => {
  it("sets a one-way direction on a tile", () => {
    const state = createInitialGameState();
    const map = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    expect(getTile(map, { x: 8, y: 8 })?.oneWay).toBe("east");
  });

  it("clears the one-way direction when set to undefined", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const cleared = setTileOneWay(withDir, { x: 8, y: 8 }, undefined);
    const tile = getTile(cleared, { x: 8, y: 8 });
    expect(tile?.oneWay).toBeUndefined();
    expect("oneWay" in (tile as object)).toBe(false);
  });

  it("drops one-way when a road tile stops being a road", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const emptied = setTileKind(withDir, { x: 8, y: 8 }, "empty");
    const tile = getTile(emptied, { x: 8, y: 8 });
    expect(tile?.kind).toBe("empty");
    expect("oneWay" in (tile as object)).toBe(false);
  });

  it("keeps one-way when the tile stays a road", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const stillRoad = setTileKind(withDir, { x: 8, y: 8 }, "road");
    expect(getTile(stillRoad, { x: 8, y: 8 })?.oneWay).toBe("east");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/simulation/map.test.ts`
Expected: FAIL — `setTileOneWay` is not exported, and `setTileKind` does not yet drop `oneWay`.

- [ ] **Step 3: Update `setTileKind` and add `setTileOneWay` in `legacy-ts-simulation/map.ts`**

Add `RoadDirection` to the type import (lines 2–9). Replace the existing `setTileKind` so non-road kinds drop `oneWay`, and add `setTileOneWay` after it:

```ts
export function setTileKind(
  map: GameMap,
  point: Point,
  kind: TileKind,
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) => {
      if (!samePoint(tile, point)) {
        return tile;
      }
      if (kind === "road") {
        return { ...tile, kind };
      }
      // oneWay is only meaningful on roads; drop it when the tile changes kind.
      const { oneWay: _oneWay, ...rest } = tile;
      return { ...rest, kind };
    }),
  };
}

export function setTileOneWay(
  map: GameMap,
  point: Point,
  oneWay: RoadDirection | undefined,
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) => {
      if (!samePoint(tile, point)) {
        return tile;
      }
      if (oneWay === undefined) {
        const { oneWay: _oneWay, ...rest } = tile;
        return rest;
      }
      return { ...tile, oneWay };
    }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run tests/simulation/map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add legacy-ts-simulation/map.ts tests/simulation/map.test.ts
git commit -m "feat: setTileOneWay helper and oneWay clearing on kind change"
```

---

## Task 3: `cycleRoadDirection` action + route revalidation

**Files:**
- Modify: `legacy-ts-simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/simulation/transit.test.ts`. Ensure the import from `../../legacy-ts-simulation/transit` includes `addBusRoute`, `addBusStop`, and `cycleRoadDirection`, and import `getTile`:

```ts
import { getTile } from "../../legacy-ts-simulation/map";
import { cycleRoadDirection } from "../../legacy-ts-simulation/transit";
```

```ts
describe("cycleRoadDirection", () => {
  it("cycles two-way -> N -> E -> S -> W -> two-way on a road tile", () => {
    const state = createInitialGameState();
    const order = ["north", "east", "south", "west", undefined];
    let next = state;
    for (const expected of order) {
      next = cycleRoadDirection(next, { x: 8, y: 8 });
      expect(getTile(next.map, { x: 8, y: 8 })?.oneWay).toBe(expected);
    }
  });

  it("ignores tiles that are not roads", () => {
    const state = createInitialGameState();
    // (2,3) is residential.
    const next = cycleRoadDirection(state, { x: 2, y: 3 });
    expect(next).toBe(state);
  });

  it("breaks a route's loop when a one-way severs it and restores it when reversed", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    expect(state.transit.routes[0].pathBroken).toBe(false);

    // One cycle -> north: (8,8) may now only be exited northward, so the
    // 7<->15 legs along y=8 can no longer pass through it.
    const broken = cycleRoadDirection(state, { x: 8, y: 8 });
    expect(getTile(broken.map, { x: 8, y: 8 })?.oneWay).toBe("north");
    expect(broken.transit.routes[0].pathBroken).toBe(true);

    // Four more cycles return the tile to two-way and repair the route.
    let restored = broken;
    for (let i = 0; i < 4; i += 1) {
      restored = cycleRoadDirection(restored, { x: 8, y: 8 });
    }
    expect(getTile(restored.map, { x: 8, y: 8 })?.oneWay).toBeUndefined();
    expect(restored.transit.routes[0].pathBroken).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/simulation/transit.test.ts`
Expected: FAIL — `cycleRoadDirection` is not exported.

- [ ] **Step 3: Implement `cycleRoadDirection` in `legacy-ts-simulation/transit.ts`**

Add `RoadDirection` to the type import (lines 2–13), add `setTileOneWay` to the map import (lines 14–22). Add the function next to `layRoad` (after the `layTrack` function, near line 728):

```ts
// two-way -> north -> east -> south -> west -> two-way. The cardinal order
// matches network.ts neighborOffsets for consistency.
const ROAD_DIRECTION_CYCLE: readonly (RoadDirection | undefined)[] = [
  undefined,
  "north",
  "east",
  "south",
  "west",
];

export function cycleRoadDirection(state: GameState, point: Point): GameState {
  const tile = getTile(state.map, point);
  if (tile === null || tile.kind !== "road") {
    return state;
  }
  const index = ROAD_DIRECTION_CYCLE.indexOf(tile.oneWay);
  const next = ROAD_DIRECTION_CYCLE[(index + 1) % ROAD_DIRECTION_CYCLE.length];
  return recomputeRoutePaths({
    ...state,
    map: setTileOneWay(state.map, point, next),
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run tests/simulation/transit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add legacy-ts-simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: cycleRoadDirection action with route revalidation"
```

---

## Task 4: Road tool wiring (cycle on click)

**Files:**
- Modify: `src/ui/actions.ts`
- Test: `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/ui/actions.test.ts`. Add a small tile lookup helper near the top-level helpers (after `trackRow`):

```ts
function tileAt(state: GameState, x: number, y: number) {
  return state.map.tiles.find((t) => t.x === x && t.y === y)!;
}
```

```ts
describe("road tool direction", () => {
  it("lays a two-way road on an empty tile and charges COSTS.road", () => {
    const state = createInitialGameState();
    const ui = { ...createUiState(), activeTool: "road" as const };
    // (8,7) is empty, directly above the y=8 road.
    const result = handleTileClick(state, ui, { x: 8, y: 7 });
    expect(tileAt(result.state, 8, 7).kind).toBe("road");
    expect(tileAt(result.state, 8, 7).oneWay).toBeUndefined();
    expect(result.state.budget).toBe(state.budget - 100);
  });

  it("cycles direction (free) when clicking an existing road with the road tool", () => {
    const state = createInitialGameState();
    const ui = { ...createUiState(), activeTool: "road" as const };
    const order = ["north", "east", "south", "west", undefined];
    let result = { state, ui };
    for (const expected of order) {
      result = handleTileClick(result.state, result.ui, { x: 8, y: 8 });
      expect(tileAt(result.state, 8, 8).oneWay).toBe(expected);
    }
    // Cycling never spends budget (only laying does).
    expect(result.state.budget).toBe(state.budget);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: FAIL — clicking an existing road currently no-ops (`layRoad` rejects a non-empty tile), so `oneWay` stays undefined.

- [ ] **Step 3: Wire the Road tool in `src/ui/actions.ts`**

Add `getTile` to imports (it is not currently imported here):

```ts
import { getTile } from "../legacy-ts-simulation/map";
```

Add `cycleRoadDirection` to the existing `../legacy-ts-simulation/transit` import list (alongside `layRoad`, `layTrack`, etc.).

Replace the `road` tool branch in `handleTileClick`:

```ts
  if (ui.activeTool === "road") {
    const tile = getTile(state.map, point);
    if (tile?.kind === "road") {
      return { state: cycleRoadDirection(state, point), ui };
    }
    return { state: layRoad(state, point), ui };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/actions.ts tests/ui/actions.test.ts
git commit -m "feat: road tool cycles one-way direction on existing roads"
```

---

## Task 5: Render direction arrows

**Files:**
- Modify: `src/render/colors.ts`
- Modify: `src/render/mapRenderer.ts`
- Test: `tests/render/mapRenderer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/render/mapRenderer.test.ts`. Add a single-tile one-way helper next to `withTrack`:

```ts
function withOneWay(
  state: GameState,
  point: Point,
  oneWay: "north" | "east" | "south" | "west",
): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y ? { ...tile, oneWay } : tile,
      ),
    },
  };
}
```

```ts
describe("renderMap one-way arrows", () => {
  it("draws a direction arrow shaft for a one-way road tile", () => {
    // (8,8) is a road tile; make it one-way east.
    const state = withOneWay(createInitialGameState(), { x: 8, y: 8 }, "east");

    const context = ctx();
    renderMap(context, state);

    // tileSize=32: center (8,8) = (272, 272). The shaft runs from tail to tip
    // along the arrow axis by tileSize/4 = 8 either side of center.
    expect(context.moveTo).toHaveBeenCalledWith(264, 272); // tail (west of center)
    expect(context.lineTo).toHaveBeenCalledWith(280, 272); // tip (east of center)
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/render/mapRenderer.test.ts`
Expected: FAIL — no arrow is drawn, so the shaft `moveTo(264, 272)` / `lineTo(280, 272)` calls never happen.

- [ ] **Step 3: Add the arrow colour to `src/render/colors.ts`**

Add a key to the `colors` object (e.g. after `track`):

```ts
  oneWayArrow: "#e8eef0",
```

- [ ] **Step 4: Add the arrow render pass to `src/render/mapRenderer.ts`**

Add the offset import at the top:

```ts
import { ROAD_DIRECTION_OFFSET } from "../domain/types";
```

Append a new pass at the end of `renderMap`, after the track block (before the function's closing brace):

```ts
  const oneWayTiles = state.map.tiles.filter(
    (tile) => tile.kind === "road" && tile.oneWay !== undefined,
  );

  if (oneWayTiles.length > 0) {
    ctx.save();
    ctx.strokeStyle = colors.oneWayArrow;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const tile of oneWayTiles) {
      const offset = ROAD_DIRECTION_OFFSET[tile.oneWay!];
      const cx = tile.x * tileSize + tileSize / 2;
      const cy = tile.y * tileSize + tileSize / 2;
      const half = tileSize / 4;
      const tipX = cx + offset.x * half;
      const tipY = cy + offset.y * half;
      const tailX = cx - offset.x * half;
      const tailY = cy - offset.y * half;

      // Shaft.
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // Chevron head: two short barbs from the tip, angled back along the
      // perpendicular axis.
      const perpX = offset.y;
      const perpY = -offset.x;
      const head = tileSize / 6;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - offset.x * head + perpX * head, tipY - offset.y * head + perpY * head);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - offset.x * head - perpX * head, tipY - offset.y * head - perpY * head);
      ctx.stroke();
    }

    ctx.restore();
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run tests/render/mapRenderer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/colors.ts src/render/mapRenderer.ts tests/render/mapRenderer.test.ts
git commit -m "feat: render one-way road direction arrows"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check and lint**

Run: `bun run check && bun run lint`
Expected: no errors. (Note: any unused binding must be `_`-prefixed — the destructures use `_oneWay`.)

- [ ] **Step 2: Run the full unit suite**

Run: `bun run test`
Expected: all `ui`, `runtime`, `simulation` projects PASS, including pre-existing scenario/route/path tests (unchanged because default `oneWay === undefined` reproduces today's behavior).

- [ ] **Step 3: Format check**

Run: `bun run format:check`
Expected: PASS. If it fails, run `bunx prettier --write .` and re-check, then amend the last commit.

- [ ] **Step 4: Final commit (only if Step 3 reformatted anything)**

```bash
git add -A
git commit -m "chore: format road direction changes"
```

---

## Self-Review

**Spec coverage:**
- Data model (`oneWay?`, `RoadDirection`) → Task 1, Step 3. ✓
- One-way exit constraint, bus-only, metro ignores, two-way unchanged → Task 1. ✓
- Multilane = adjacent lanes / opposing-pair two-way corridor → Task 1 corridor test (no new field needed, as designed). ✓
- Editing: empty → lay (costs), existing road → cycle (free), order two-way→N→E→S→W→two-way → Tasks 3 & 4. ✓
- `recomputeRoutePaths` revalidation (pathBroken / restore) → Task 3. ✓
- `oneWay` cleared on road removal → Task 2 (`setTileKind` drop), which `removeInfrastructureAtTile` already routes through. ✓
- Rendering arrows; two-way unchanged; lane-divider striping out of scope → Task 5. ✓
- Regression safety for existing tests → Task 6, Step 2. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `RoadDirection` ("north"|"east"|"south"|"west") used identically in types, network, map, transit, and tests. `ROAD_DIRECTION_OFFSET` defined once in `types.ts`, imported by `network.ts` and `mapRenderer.ts`. `setTileOneWay(map, point, RoadDirection | undefined)` and `cycleRoadDirection(state, point)` signatures match their call sites. Cycle order constant matches the click/cycle tests. ✓
