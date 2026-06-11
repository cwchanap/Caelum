# Road/Track Route Restrictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buses may only run along connected roads and metros along player-laid track: routes are validated against the network, vehicles visibly follow the tile path, and travel time scales with path length.

**Architecture:** Track is a boolean layer on tiles (`hasTrack`), so road+track tiles are level crossings with no new `TileKind`. A deterministic BFS (`src/simulation/network.ts`) computes each route's per-segment tile paths once at build time; the paths are stored on `Route`/`MetroLine` (`segments`, `pathBroken`) and recomputed only when the road/track network changes. Simulation, renderer, and router all read the stored paths.

**Tech Stack:** TypeScript (pure sim), Svelte 5 runes (UI), Vitest (`simulation`/`runtime` node projects, `ui`/`render` jsdom), Playwright (e2e). Bun for all commands.

**Spec:** `docs/superpowers/specs/2026-06-09-route-restrictions-design.md` (including the endpoint-exception amendment: BFS treats the `from`/`to` tiles as always traversable, because building-placed stops sit on empty tiles beside the network).

**Conventions that bind every task:**
- Never mutate `GameState`/`UiState`; invalid actions return the *same reference*.
- No `Math.random`/wall-clock in sim code; BFS neighbor order is fixed N,E,S,W.
- Unused vars prefixed `_`. `bun run lint` is strict.
- Run a task's tests with `bunx vitest run <file>`; full project gates at the end.

---

## File structure

| File | Change |
| --- | --- |
| `src/domain/types.ts` | `Tile.hasTrack?`, `Tool` += `"road" \| "track"`, `Route`/`MetroLine` += `segments`, `pathBroken` |
| `src/simulation/network.ts` | **New.** `findTilePath`, `computeRouteSegments`, `hasBrokenSegment` (pure pathfinding; imports only domain types) |
| `src/simulation/map.ts` | `isValidRoadPlacement`, `isValidTrackPlacement`, `setTileKind`, `setTileTrack`, growth-wave skip, validator updates |
| `src/simulation/transit.ts` | `COSTS.road/track`, `TILES_PER_SECOND`, `layRoad`, `layTrack`, `removeInfrastructureAtTile`, `recomputeRoutePaths`, segments in `addBusRoute`/`addMetroLine`, distance-based `tickVehicles` |
| `src/simulation/buildings.ts` | `canPlaceBuilding` track rules |
| `src/simulation/router.ts` | Path-length ride estimates, exclude `pathBroken` |
| `src/ui/uiState.ts` | `draftStopPaths`, `draftStationPaths` |
| `src/ui/actions.ts` | road/track tool branches, draft path validation, `removeDraftStop(state, ui, index)`, bulldoze infrastructure |
| `src/runtime/createGameRuntime.ts` | clear draft paths in `nextToolUiState`/`nextBuildingUiState`, `removeDraftStop` call site |
| `src/render/colors.ts` | `track` color |
| `src/render/mapRenderer.ts` | draw track layer |
| `src/render/transitRenderer.ts` | path-following lines/vehicles/draft preview |
| `src/components/hud/panels/BuildPanel.svelte` | Network section (Road/Track buttons) |
| Tests | New: `tests/simulation/network.test.ts`, `tests/ui/buildPanel.test.ts`. Modified: `tests/simulation/{map,transit,router,citizens}.test.ts`, `tests/ui/actions.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/render/{transitRenderer,canvas}.test.ts`, `tests/e2e/routes.spec.ts` |

**Shared test helper** (repo style is local helpers per test file — copy this into each test file that needs track; do not create a shared module):

```ts
import type { GameState, Point } from "../../src/domain/types";

function withTrack(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((p) => `${p.x},${p.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, hasTrack: true } : tile,
      ),
    },
  };
}

function trackRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, i) => ({ x: fromX + i, y }));
}
```

**Map facts used throughout tests:** the Growing Suburb map is 28×18; roads are the full row `y=8` and full columns `x=7`, `x=15`, `x=22`. `(7,8)`, `(15,8)`, `(22,8)` are road tiles 8 and 7 steps apart along the row. Row `y=2`, `x=8..12` is empty ground. Budget starts at $120,000.

---

### Task 1: `Tile.hasTrack` + deterministic BFS (`findTilePath`)

**Files:**
- Modify: `src/domain/types.ts` (Tile interface, ~line 45)
- Create: `src/simulation/network.ts`
- Create: `tests/simulation/network.test.ts`

- [ ] **Step 1: Add `hasTrack` to `Tile`**

In `src/domain/types.ts` change:

```ts
export interface Tile extends Point {
  id: string;
  kind: TileKind;
  districtId?: string;
  /** Track is a layer, not a TileKind: a road tile with track is a level crossing. */
  hasTrack?: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/simulation/network.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GameState, Point } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { findTilePath } from "../../src/simulation/network";

function withTrack(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((p) => `${p.x},${p.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, hasTrack: true } : tile,
      ),
    },
  };
}

function trackRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, i) => ({ x: fromX + i, y }));
}

describe("findTilePath", () => {
  it("finds the straight shortest bus path along the y=8 road row", () => {
    const state = createInitialGameState();

    const path = findTilePath(state.map, { x: 7, y: 8 }, { x: 11, y: 8 }, "bus");

    expect(path).toEqual([
      { x: 7, y: 8 },
      { x: 8, y: 8 },
      { x: 9, y: 8 },
      { x: 10, y: 8 },
      { x: 11, y: 8 },
    ]);
  });

  it("is deterministic when two equal shortest paths exist (N,E,S,W expansion)", () => {
    // The road network has only one row, so equal alternatives need a track
    // ring: a 2x3 loop where (5,2)->(7,4) has two 4-step paths (across-then-
    // down vs down-then-across). BFS discovery order must always pick the
    // across-then-down one.
    const ring = [
      ...trackRow(2, 5, 7),
      ...trackRow(4, 5, 7),
      { x: 5, y: 3 },
      { x: 7, y: 3 },
    ];
    const state = withTrack(createInitialGameState(), ring);

    const path = findTilePath(state.map, { x: 5, y: 2 }, { x: 7, y: 4 }, "metro");

    expect(path).toEqual([
      { x: 5, y: 2 },
      { x: 6, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 3 },
      { x: 7, y: 4 },
    ]);
  });

  it("returns null when no bus path exists", () => {
    const state = createInitialGameState();

    // (2,3) is a residential tile with no road under or near the endpoint's
    // immediate connectivity requirement: its neighbors are residential/empty.
    expect(findTilePath(state.map, { x: 2, y: 3 }, { x: 7, y: 8 }, "bus")).toBeNull();
  });

  it("treats endpoints as traversable so off-road stops connect via an adjacent road", () => {
    const state = createInitialGameState();

    // (8,7) and (16,7) are empty tiles directly above the y=8 road (the e2e
    // flow places Bus Stop buildings there).
    const path = findTilePath(state.map, { x: 8, y: 7 }, { x: 16, y: 7 }, "bus");

    expect(path).not.toBeNull();
    expect(path?.[0]).toEqual({ x: 8, y: 7 });
    expect(path?.[1]).toEqual({ x: 8, y: 8 });
    expect(path?.at(-2)).toEqual({ x: 16, y: 8 });
    expect(path?.at(-1)).toEqual({ x: 16, y: 7 });
  });

  it("routes metro along track tiles only, including crossings over roads", () => {
    // Track row y=2 from x=5 to x=9 crosses the x=7 road column at (7,2).
    const state = withTrack(createInitialGameState(), trackRow(2, 5, 9));

    const metro = findTilePath(state.map, { x: 5, y: 2 }, { x: 9, y: 2 }, "metro");
    expect(metro).toHaveLength(5);

    // The same tiles are not traversable for buses (except endpoints).
    expect(findTilePath(state.map, { x: 5, y: 2 }, { x: 9, y: 2 }, "bus")).toBeNull();
  });

  it("returns a single-tile path when from equals to", () => {
    const state = createInitialGameState();
    expect(findTilePath(state.map, { x: 7, y: 8 }, { x: 7, y: 8 }, "bus")).toEqual([
      { x: 7, y: 8 },
    ]);
  });

  it("returns null for out-of-bounds endpoints", () => {
    const state = createInitialGameState();
    expect(findTilePath(state.map, { x: -1, y: 8 }, { x: 7, y: 8 }, "bus")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: FAIL — `Cannot find module '../../src/simulation/network'` (or similar).

- [ ] **Step 4: Implement `findTilePath`**

Create `src/simulation/network.ts`:

```ts
import type { GameMap, Point, Tile } from "../domain/types";

export type NetworkMode = "bus" | "metro";

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isTraversable(tile: Tile, mode: NetworkMode): boolean {
  return mode === "bus" ? tile.kind === "road" : tile.hasTrack === true;
}

// Fixed N, E, S, W expansion order keeps BFS — and therefore the chosen
// shortest path — fully deterministic (a scenario contract).
const neighborOffsets: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Shortest 4-connected tile path for the given mode, or null when none
 * exists. The from/to endpoints are always traversable regardless of tile
 * kind/track so that stops placed beside the network (building footprints
 * sit on empty tiles) can connect through an adjacent road/track tile.
 */
export function findTilePath(
  map: GameMap,
  from: Point,
  to: Point,
  mode: NetworkMode,
): Point[] | null {
  const tileByKey = new Map(map.tiles.map((tile) => [positionKey(tile.x, tile.y), tile]));
  const fromKey = positionKey(from.x, from.y);
  const toKey = positionKey(to.x, to.y);

  if (!tileByKey.has(fromKey) || !tileByKey.has(toKey)) {
    return null;
  }
  if (fromKey === toKey) {
    return [{ x: from.x, y: from.y }];
  }

  const parents = new Map<string, string | null>([[fromKey, null]]);
  const queue: Point[] = [{ x: from.x, y: from.y }];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];

    for (const offset of neighborOffsets) {
      const next = { x: current.x + offset.x, y: current.y + offset.y };
      const nextKey = positionKey(next.x, next.y);

      if (parents.has(nextKey)) {
        continue;
      }

      const tile = tileByKey.get(nextKey);
      if (tile === undefined) {
        continue;
      }
      if (nextKey !== toKey && !isTraversable(tile, mode)) {
        continue;
      }

      parents.set(nextKey, positionKey(current.x, current.y));

      if (nextKey === toKey) {
        const path: Point[] = [];
        let cursor: string | null = nextKey;
        while (cursor !== null) {
          const [x, y] = cursor.split(",").map(Number);
          path.push({ x, y });
          cursor = parents.get(cursor) ?? null;
        }
        return path.reverse();
      }

      queue.push(next);
    }
  }

  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/simulation/network.ts tests/simulation/network.test.ts
git commit -m "feat: add hasTrack tile layer and deterministic findTilePath BFS"
```

---

### Task 2: `computeRouteSegments` + `hasBrokenSegment`

**Files:**
- Modify: `src/simulation/network.ts`
- Modify: `tests/simulation/network.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the `network.test.ts` describe file, importing the new functions)

```ts
import {
  computeRouteSegments,
  findTilePath,
  hasBrokenSegment,
} from "../../src/simulation/network";

describe("computeRouteSegments", () => {
  it("returns one segment per consecutive pair plus the closing loop segment", () => {
    const state = createInitialGameState();
    const positions = [
      { x: 7, y: 8 },
      { x: 15, y: 8 },
      { x: 22, y: 8 },
    ];

    const segments = computeRouteSegments(state.map, positions, "bus");

    expect(segments).toHaveLength(3);
    expect(segments[0]).toHaveLength(9); // 7..15 along y=8
    expect(segments[1]).toHaveLength(8); // 15..22
    expect(segments[2]).toHaveLength(16); // 22..7 closing loop
    expect(hasBrokenSegment(segments)).toBe(false);
  });

  it("marks unpathable pairs as empty segments and reports them broken", () => {
    const state = createInitialGameState();
    const positions = [
      { x: 7, y: 8 },
      { x: 2, y: 3 }, // residential island, unreachable by road
    ];

    const segments = computeRouteSegments(state.map, positions, "bus");

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual([]);
    expect(segments[1]).toEqual([]);
    expect(hasBrokenSegment(segments)).toBe(true);
  });

  it("returns no segments for fewer than two positions, which is not broken", () => {
    const state = createInitialGameState();
    expect(computeRouteSegments(state.map, [{ x: 7, y: 8 }], "bus")).toEqual([]);
    expect(hasBrokenSegment([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: FAIL — `computeRouteSegments` is not exported.

- [ ] **Step 3: Implement** (append to `src/simulation/network.ts`)

```ts
/**
 * Tile path for every consecutive position pair, including the closing
 * loop segment (last -> first); vehicles cycle the whole loop. An
 * unpathable pair is stored as an empty array.
 */
export function computeRouteSegments(
  map: GameMap,
  positions: Point[],
  mode: NetworkMode,
): Point[][] {
  if (positions.length < 2) {
    return [];
  }

  return positions.map((from, index) => {
    const to = positions[(index + 1) % positions.length];
    return findTilePath(map, from, to, mode) ?? [];
  });
}

export function hasBrokenSegment(segments: Point[][]): boolean {
  return segments.some((segment) => segment.length === 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/simulation/network.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/network.ts tests/simulation/network.test.ts
git commit -m "feat: compute per-segment route paths with closing loop"
```

---

### Task 3: Route schema — `segments` + `pathBroken` on `Route`/`MetroLine`

**Files:**
- Modify: `src/domain/types.ts` (Route ~line 86, MetroLine ~line 95)
- Modify: `src/simulation/transit.ts` (`addBusRoute`, `addMetroLine`, `assignedLinePositions`, `assignVehicle`)
- Modify: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing tests** (add to `tests/simulation/transit.test.ts`; the file's existing `createBusState` helper places stops at (7,8) and (15,8))

```ts
describe("route path segments", () => {
  it("stores segments and pathBroken=false for a road-connected bus route", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });

    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const route = state.transit.routes[0];
    expect(route.pathBroken).toBe(false);
    expect(route.segments).toHaveLength(2); // out + closing loop
    expect(route.segments[0][0]).toEqual({ x: 7, y: 8 });
    expect(route.segments[0].at(-1)).toEqual({ x: 15, y: 8 });
  });

  it("creates a metro line with pathBroken=true when stations have no track between them", () => {
    let state = createInitialGameState();
    // Direct API call bypasses placement rules on purpose: stations exist
    // but no track connects them.
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    expect(state.transit.metroLines[0].pathBroken).toBe(true);
    expect(state.transit.metroLines[0].segments).toEqual([[], []]);
  });

  it("does not move vehicles on a pathBroken line and rejects new vehicles for it", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const rejected = assignVehicle(state, "metro", "metro-001");
    expect(rejected).toBe(state);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/transit.test.ts`
Expected: FAIL — `pathBroken` is `undefined`, `segments` missing, `assignVehicle` succeeds.

- [ ] **Step 3: Extend the types**

In `src/domain/types.ts`:

```ts
export interface Route {
  id: string;
  name: string;
  color: string;
  stopIds: string[];
  vehicleIds: string[];
  active: boolean;
  /** Tile path per consecutive stop pair, closing the loop (last -> first).
   *  An unpathable pair is an empty array. */
  segments: Point[][];
  /** True when any segment is unpathable. Runs only when active && !pathBroken;
   *  network damage never touches the player's `active` toggle. */
  pathBroken: boolean;
}

export interface MetroLine {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  vehicleIds: string[];
  active: boolean;
  segments: Point[][];
  pathBroken: boolean;
}
```

- [ ] **Step 4: Compute segments at creation and gate vehicles**

In `src/simulation/transit.ts`:

Add to the imports:

```ts
import { computeRouteSegments, hasBrokenSegment } from "./network";
```

In `addBusRoute`, before the `return`:

```ts
  const stopPositionById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  const positions = stopIds
    .map((stopId) => stopPositionById.get(stopId))
    .filter((position): position is Point => position !== undefined)
    .map(clonePoint);
  const segments =
    positions.length === stopIds.length
      ? computeRouteSegments(state.map, positions, "bus")
      : [];
```

and extend the created route object:

```ts
        {
          id: routeId,
          name: `Bus ${routeNumber}`,
          color: "#e04f39",
          stopIds: [...stopIds],
          vehicleIds: [],
          active,
          segments,
          pathBroken: hasBrokenSegment(segments),
        },
```

Mirror the same in `addMetroLine` (stations, `"metro"` mode, `metroLines` entry).

In `assignedLinePositions` add the `pathBroken` gate to both branches — change `route.active` to `route.active && !route.pathBroken`, and `metroLine.active` to `metroLine.active && !metroLine.pathBroken`.

In `assignVehicle` change both activity checks the same way:

```ts
    if (route === undefined || !route.active || route.pathBroken) {
      return state;
    }
```

```ts
  if (metroLine === undefined || !metroLine.active || metroLine.pathBroken) {
    return state;
  }
```

- [ ] **Step 5: Run the whole simulation project**

Run: `bunx vitest run --project simulation`
Expected: the three new tests PASS. Some existing tests may fail on strict `toEqual` route comparisons — add `segments`/`pathBroken` to those expected objects (`toMatchObject` call sites need no change). Fix only equality-shape failures here; timing behavior is untouched in this task.

- [ ] **Step 6: Type-check the whole repo**

Run: `bun run check`
Expected: PASS (selectors and renderer don't touch the new fields yet; object spreads keep them).

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: store route path segments and pathBroken on routes and metro lines"
```

---

### Task 4: `recomputeRoutePaths` + break transition (park, disembark, replan)

**Files:**
- Modify: `src/simulation/transit.ts`
- Modify: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { recomputeRoutePaths } from "../../src/simulation/transit";

function removeRoadAt(state: GameState, point: Point): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y
          ? { ...tile, kind: "empty" as const }
          : tile,
      ),
    },
  };
}

describe("recomputeRoutePaths", () => {
  it("marks a route broken when a road tile on its path is removed, parks the vehicle, and disembarks passengers", () => {
    let state = createBusState(); // stops at (7,8) and (15,8), one vehicle
    // Put a rider on board: simulate a citizen mid-ride.
    const rider: Citizen = {
      ...state.citizens[0],
      status: "riding",
      routePlan: {
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
        estimatedSeconds: 60,
      },
      currentLegIndex: 0,
    };
    state = {
      ...state,
      citizens: [rider, ...state.citizens.slice(1)],
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((v) => ({
          ...v,
          passengerIds: [rider.id],
          progress: 0.5,
        })),
      },
    };

    // Sever the road between the stops, then recompute.
    const severed = recomputeRoutePaths(removeRoadAt(state, { x: 11, y: 8 }));

    const route = severed.transit.routes[0];
    expect(route.pathBroken).toBe(true);
    expect(route.active).toBe(true); // player toggle untouched

    const vehicle = severed.transit.vehicles[0];
    expect(vehicle.passengerIds).toEqual([]);
    expect(vehicle.progress).toBe(0);

    const citizen = severed.citizens[0];
    expect(citizen.status).toBe("idle");
    expect(citizen.routePlan).toBeNull();
    expect(citizen.position).toEqual({ x: 7, y: 8 }); // segment-start stop
  });

  it("clears pathBroken when the network is restored", () => {
    const state = createBusState();
    const severed = recomputeRoutePaths(removeRoadAt(state, { x: 11, y: 8 }));
    expect(severed.transit.routes[0].pathBroken).toBe(true);

    // Restore the tile and recompute again.
    const restored = recomputeRoutePaths({
      ...severed,
      map: {
        ...severed.map,
        tiles: severed.map.tiles.map((tile) =>
          tile.x === 11 && tile.y === 8 ? { ...tile, kind: "road" as const } : tile,
        ),
      },
    });

    expect(restored.transit.routes[0].pathBroken).toBe(false);
    expect(restored.transit.routes[0].segments[0]).toHaveLength(9);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/transit.test.ts -t recomputeRoutePaths`
Expected: FAIL — `recomputeRoutePaths` not exported.

- [ ] **Step 3: Implement `recomputeRoutePaths`** (in `src/simulation/transit.ts`, after `invalidatePlansForLine`)

```ts
/**
 * Refresh segments/pathBroken on every route and metro line against the
 * current map. On the transition into broken, vehicles park at their current
 * segment's starting stop with no passengers, and every citizen whose plan
 * references the line replans from where they are (riders from the parked
 * stop). Call after any road/track change. Always returns a new state; only
 * call when the map actually changed.
 */
export function recomputeRoutePaths(state: GameState): GameState {
  const stopPositionById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  const stationPositionById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );

  let citizens = state.citizens;
  let vehicles = state.transit.vehicles;

  const refreshLine = <T extends Route | MetroLine>(
    line: T,
    nodeIds: string[],
    positionById: Map<string, Point>,
    mode: "bus" | "metro",
  ): T => {
    const positions = nodeIds
      .map((nodeId) => positionById.get(nodeId))
      .filter((position): position is Point => position !== undefined)
      .map(clonePoint);
    const segments =
      positions.length === nodeIds.length
        ? computeRouteSegments(state.map, positions, mode)
        : [];
    const pathBroken = hasBrokenSegment(segments);

    if (pathBroken && !line.pathBroken) {
      const parkedPositionByCitizenId = new Map<string, Point>();
      vehicles = vehicles.map((vehicle) => {
        if (vehicle.lineId !== line.id) {
          return vehicle;
        }
        const parkedAt =
          positions.length === 0
            ? undefined
            : positions[vehicle.segmentIndex % positions.length];
        if (parkedAt !== undefined) {
          for (const passengerId of vehicle.passengerIds) {
            parkedPositionByCitizenId.set(passengerId, parkedAt);
          }
        }
        return { ...vehicle, passengerIds: [], progress: 0 };
      });
      citizens = invalidatePlansForLine(citizens, line.id).map((citizen) => {
        const parkedAt = parkedPositionByCitizenId.get(citizen.id);
        return parkedAt === undefined
          ? citizen
          : { ...citizen, position: clonePoint(parkedAt) };
      });
    }

    return { ...line, segments, pathBroken };
  };

  const routes = state.transit.routes.map((route) =>
    refreshLine(route, route.stopIds, stopPositionById, "bus"),
  );
  const metroLines = state.transit.metroLines.map((line) =>
    refreshLine(line, line.stationIds, stationPositionById, "metro"),
  );

  return {
    ...state,
    citizens,
    transit: { ...state.transit, routes, metroLines, vehicles },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run tests/simulation/transit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: recompute route paths on network change with break-transition handling"
```

---

### Task 5: Road/track tools — `Tool` union, costs, validators, lay/bulldoze, growth-wave skip

**Files:**
- Modify: `src/domain/types.ts` (Tool union, ~line 25)
- Modify: `src/simulation/map.ts`
- Modify: `src/simulation/transit.ts`
- Modify: `src/ui/actions.ts` (`removeAtTile`, `handleTileClick`)
- Modify: `tests/simulation/map.test.ts`, `tests/simulation/transit.test.ts`, `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/simulation/map.test.ts` (uses the `withTrack` helper from the file-structure section):

```ts
import {
  isValidRoadPlacement,
  isValidTrackPlacement,
} from "../../src/simulation/map";

describe("road and track placement validation", () => {
  it("allows road only on bare empty tiles", () => {
    const state = createInitialGameState();
    expect(isValidRoadPlacement(state, { x: 8, y: 2 })).toBe(true); // empty
    expect(isValidRoadPlacement(state, { x: 7, y: 8 })).toBe(false); // road
    expect(isValidRoadPlacement(state, { x: 2, y: 3 })).toBe(false); // residential
  });

  it("allows track on empty and road tiles (crossings) but not zones or duplicates", () => {
    const state = createInitialGameState();
    expect(isValidTrackPlacement(state, { x: 8, y: 2 })).toBe(true); // empty
    expect(isValidTrackPlacement(state, { x: 7, y: 8 })).toBe(true); // road -> crossing
    expect(isValidTrackPlacement(state, { x: 2, y: 3 })).toBe(false); // residential
    const tracked = withTrack(state, [{ x: 8, y: 2 }]);
    expect(isValidTrackPlacement(tracked, { x: 8, y: 2 })).toBe(false); // already tracked
  });
});

describe("growth waves skip player infrastructure", () => {
  it("does not convert a wave tile the player laid road on, and skips its citizens", () => {
    let state = createInitialGameState();
    // wave-north converts (8,2)..(10,2) to residential at t=240.
    state = {
      ...state,
      time: 240,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 8 && tile.y === 2 ? { ...tile, kind: "road" as const } : tile,
        ),
      },
    };

    const next = applyDueGrowthWaves(state);

    const tile = next.map.tiles.find((t) => t.x === 8 && t.y === 2);
    expect(tile?.kind).toBe("road");
    // Only the two untouched wave tiles spawn citizens (8 each).
    expect(next.citizens.length).toBe(state.citizens.length + 16);
  });
});
```

In `tests/simulation/transit.test.ts`:

```ts
import { layRoad, layTrack, removeInfrastructureAtTile } from "../../src/simulation/transit";

describe("laying and removing infrastructure", () => {
  it("lays a road on an empty tile and charges $100", () => {
    const state = createInitialGameState();
    const next = layRoad(state, { x: 8, y: 2 });

    expect(next.map.tiles.find((t) => t.x === 8 && t.y === 2)?.kind).toBe("road");
    expect(next.budget).toBe(119_900);
  });

  it("lays track on a road tile to form a crossing and charges $500", () => {
    const state = createInitialGameState();
    const next = layTrack(state, { x: 9, y: 8 });

    const tile = next.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.kind).toBe("road");
    expect(tile?.hasTrack).toBe(true);
    expect(next.budget).toBe(119_500);
  });

  it("rejects invalid placements unchanged", () => {
    const state = createInitialGameState();
    expect(layRoad(state, { x: 7, y: 8 })).toBe(state); // already road
    expect(layTrack(state, { x: 2, y: 3 })).toBe(state); // residential
  });

  it("re-laying a severed road tile restores a broken route", () => {
    let state = createBusState(); // stops (7,8) and (15,8)
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    state = layRoad(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(false);
  });

  it("bulldozes track before road on a crossing tile", () => {
    let state = layTrack(createInitialGameState(), { x: 9, y: 8 });

    state = removeInfrastructureAtTile(state, { x: 9, y: 8 });
    let tile = state.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.hasTrack).toBe(false);
    expect(tile?.kind).toBe("road");

    state = removeInfrastructureAtTile(state, { x: 9, y: 8 });
    tile = state.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.kind).toBe("empty");
  });
});
```

In `tests/ui/actions.test.ts`:

```ts
it("lays road and track via their tools and bulldozes bare infrastructure", () => {
  const state = createInitialGameState();
  const ui = createUiState();

  const road = handleTileClick(state, { ...ui, activeTool: "road" }, { x: 8, y: 2 });
  expect(road.state.map.tiles.find((t) => t.x === 8 && t.y === 2)?.kind).toBe("road");

  const track = handleTileClick(road.state, { ...ui, activeTool: "track" }, { x: 9, y: 2 });
  expect(track.state.map.tiles.find((t) => t.x === 9 && t.y === 2)?.hasTrack).toBe(true);

  const removed = handleTileClick(
    track.state,
    { ...ui, activeTool: "remove" },
    { x: 9, y: 2 },
  );
  expect(removed.state.map.tiles.find((t) => t.x === 9 && t.y === 2)?.hasTrack).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/map.test.ts tests/simulation/transit.test.ts tests/ui/actions.test.ts`
Expected: FAIL — missing exports and tool branches.

- [ ] **Step 3: Extend `Tool` and `COSTS`**

`src/domain/types.ts`:

```ts
export type Tool =
  | "inspect"
  | "busStop"
  | "busRoute"
  | "metroStation"
  | "metroLine"
  | "civicAnchor"
  | "road"
  | "track"
  | "remove";
```

`src/simulation/transit.ts`:

```ts
export const COSTS = {
  busStop: 2_000,
  metroStation: 25_000,
  bus: 8_000,
  metro: 50_000,
  road: 100,
  track: 500,
} as const;
```

- [ ] **Step 4: Validators and tile mutators in `src/simulation/map.ts`**

```ts
function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

export function isValidRoadPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function isValidTrackPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    (tile?.kind === "empty" || tile?.kind === "road") &&
    tile?.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function setTileKind(map: GameMap, point: Point, kind: TileKind): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? { ...tile, kind } : tile,
    ),
  };
}

export function setTileTrack(map: GameMap, point: Point, hasTrack: boolean): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? { ...tile, hasTrack } : tile,
    ),
  };
}
```

(Add `TileKind` to the type imports at the top of `map.ts`.)

- [ ] **Step 5: Growth-wave skip in `applyDueGrowthWaves`**

Replace the tile-conversion map call:

```ts
  const nextMap: GameMap = {
    ...state.map,
    tiles: state.map.tiles.map((tile) => {
      const waveTile = waveTilesById.get(tile.id);
      // Player infrastructure wins: a wave tile only converts while it is
      // still bare empty ground.
      const blocked = tile.kind !== "empty" || tile.hasTrack === true;
      return waveTile === undefined || blocked
        ? { ...tile }
        : { ...tile, kind: waveTile.kind, districtId: waveTile.districtId };
    }),
  };
```

And in the citizen-creation loop, extend the skip:

```ts
    for (const tile of wave.tiles) {
      const preWaveTile = getTile(state.map, { x: tile.x, y: tile.y });
      const blocked =
        preWaveTile === null ||
        preWaveTile.kind !== "empty" ||
        preWaveTile.hasTrack === true;
      if (blocked || isBuildingOccupied(state, { x: tile.x, y: tile.y })) {
        continue;
      }
      // ... existing citizen creation unchanged
```

- [ ] **Step 6: `layRoad`/`layTrack`/`removeInfrastructureAtTile` in `src/simulation/transit.ts`**

Extend the map.ts import line:

```ts
import {
  getTile,
  isValidBusStopPlacement,
  isValidMetroStationPlacement,
  isValidRoadPlacement,
  isValidTrackPlacement,
  setTileKind,
  setTileTrack,
} from "./map";
```

```ts
export function layRoad(state: GameState, point: Point): GameState {
  if (!canAfford(state, COSTS.road) || !isValidRoadPlacement(state, point)) {
    return state;
  }
  return recomputeRoutePaths({
    ...state,
    budget: state.budget - COSTS.road,
    map: setTileKind(state.map, point, "road"),
  });
}

export function layTrack(state: GameState, point: Point): GameState {
  if (!canAfford(state, COSTS.track) || !isValidTrackPlacement(state, point)) {
    return state;
  }
  return recomputeRoutePaths({
    ...state,
    budget: state.budget - COSTS.track,
    map: setTileTrack(state.map, point, true),
  });
}

/** Bulldoze priority for bare tiles: track first, then road. No refunds. */
export function removeInfrastructureAtTile(state: GameState, point: Point): GameState {
  const tile = getTile(state.map, point);
  if (tile === null) {
    return state;
  }
  if (tile.hasTrack === true) {
    return recomputeRoutePaths({
      ...state,
      map: setTileTrack(state.map, point, false),
    });
  }
  if (tile.kind === "road") {
    return recomputeRoutePaths({
      ...state,
      map: setTileKind(state.map, point, "empty"),
    });
  }
  return state;
}
```

- [ ] **Step 7: Wire `handleTileClick` and `removeAtTile` in `src/ui/actions.ts`**

Extend the transit import with `layRoad, layTrack, removeInfrastructureAtTile`.

After the `metroStation` branch in `handleTileClick`:

```ts
  if (ui.activeTool === "road") {
    return { state: layRoad(state, point), ui };
  }

  if (ui.activeTool === "track") {
    return { state: layTrack(state, point), ui };
  }
```

In `removeAtTile`, change the nothing-found early return:

```ts
  if (
    removedBuilding === undefined &&
    removedStopIds.size === 0 &&
    removedStationIds.size === 0
  ) {
    // Bare tile: bulldoze track, then road (two clicks on a crossing).
    return removeInfrastructureAtTile(state, point);
  }
```

- [ ] **Step 8: Run the affected projects**

Run: `bunx vitest run --project simulation --project ui`
Expected: new tests PASS; fix any strict-equality fixtures still missing `segments`/`pathBroken`.

- [ ] **Step 9: Commit**

```bash
git add src/domain/types.ts src/simulation/map.ts src/simulation/transit.ts src/ui/actions.ts tests/simulation/map.test.ts tests/simulation/transit.test.ts tests/ui/actions.test.ts
git commit -m "feat: road and track tools with bulldoze and growth-wave protection"
```

---

### Task 6: Placement rule changes — stations need track, no nodes/buildings on conflicting tiles

**Files:**
- Modify: `src/simulation/map.ts` (`isValidBusStopPlacement`, `isValidMetroStationPlacement`)
- Modify: `src/simulation/buildings.ts` (`canPlaceBuilding`)
- Modify: `tests/simulation/map.test.ts`, plus existing fixtures in `tests/simulation/{transit,router,citizens}.test.ts`, `tests/ui/actions.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/render/transitRenderer.test.ts`

- [ ] **Step 1: Write the failing tests** (in `tests/simulation/map.test.ts`)

```ts
describe("station and stop placement with track rules", () => {
  it("requires track under a metro station", () => {
    const state = createInitialGameState();
    expect(isValidMetroStationPlacement(state, { x: 8, y: 2 })).toBe(false); // empty, no track
    expect(isValidMetroStationPlacement(state, { x: 7, y: 8 })).toBe(false); // road, no track

    const tracked = withTrack(state, [{ x: 8, y: 2 }, { x: 7, y: 8 }]);
    expect(isValidMetroStationPlacement(tracked, { x: 8, y: 2 })).toBe(true);
    expect(isValidMetroStationPlacement(tracked, { x: 7, y: 8 })).toBe(true); // crossing OK
  });

  it("rejects bus stops on crossings", () => {
    const state = withTrack(createInitialGameState(), [{ x: 9, y: 8 }]);
    expect(isValidBusStopPlacement(state, { x: 9, y: 8 })).toBe(false);
    expect(isValidBusStopPlacement(state, { x: 10, y: 8 })).toBe(true);
  });
});
```

In `tests/simulation/buildings.test.ts`:

```ts
it("requires track under a metro station building and rejects other buildings on track", () => {
  const bare = createInitialGameState();
  expect(canPlaceBuilding(bare, "metroStation", { x: 8, y: 2 }, 0)).toBe(false);

  const tracked = withTrack(bare, [{ x: 8, y: 2 }]);
  expect(canPlaceBuilding(tracked, "metroStation", { x: 8, y: 2 }, 0)).toBe(true);
  expect(canPlaceBuilding(tracked, "smallHouse", { x: 8, y: 2 }, 0)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/map.test.ts tests/simulation/buildings.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the rule changes**

`src/simulation/map.ts`:

```ts
export function isValidBusStopPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  const occupied =
    isBuildingOccupied(state, point) ||
    state.transit.stops.some((stop) => samePoint(stop.position, point));

  return tile?.kind === "road" && tile.hasTrack !== true && !occupied;
}

export function isValidMetroStationPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  const occupied =
    isBuildingOccupied(state, point) ||
    state.transit.stations.some((station) => samePoint(station.position, point));

  return (
    (tile?.kind === "road" || tile?.kind === "empty") &&
    tile?.hasTrack === true &&
    !occupied
  );
}
```

`src/simulation/buildings.ts`, inside the `footprint.every(...)` callback of `canPlaceBuilding`, change the return to:

```ts
    // No building may sit on track, except the Metro Station building whose
    // (1x1) tile must have track — mirroring the station tool rule.
    const trackOk =
      type === "metroStation" ? tile?.hasTrack === true : tile?.hasTrack !== true;

    return (
      tile?.kind === "empty" &&
      trackOk &&
      !buildingOccupied &&
      !stopOccupied &&
      !stationOccupied
    );
```

- [ ] **Step 4: Update existing fixtures that place stations without track**

Run: `bunx vitest run` and fix every failure of this shape: any test calling `addMetroStation(state, p)` or `canPlaceBuilding(state, "metroStation", ...)` must first wrap the state with `withTrack(state, [...])` covering the station tiles **and a connecting run when a metro line is also created**. Known call sites (copy the `withTrack`/`trackRow` helpers into each file):

- `tests/simulation/transit.test.ts` — stations at `(7,8)`/`(22,8)`: use `withTrack(state, trackRow(8, 7, 22))` so lines created on them are pathable where the test expects active service. **Exception:** Task 3's "pathBroken=true when stations have no track between them" test must stay broken — wrap with `withTrack(state, [{ x: 7, y: 8 }, { x: 22, y: 8 }])` (track under the station tiles only, no connecting run; the line still has no path between them).
- `tests/simulation/router.test.ts` lines ~72-73, ~180-181 — same `trackRow(8, 7, 22)`.
- `tests/ui/actions.test.ts` — stations at `(7,8)`,`(15,8)`: `trackRow(8, 7, 15)`; stations at `(7,2)`,`(22,2)`: `trackRow(2, 7, 22)`.
- `tests/runtime/runtimeSelectors.test.ts` — stations at `(7,2)`,`(22,2)`: `trackRow(2, 7, 22)`; at `(3,0)`,`(9,0)`: `trackRow(0, 3, 9)`.
- `tests/render/transitRenderer.test.ts` — wherever stations back a drawn metro line, lay a track run covering the span.
- `tests/simulation/citizens.test.ts` — if it builds metro states, same treatment.

Expected after fixes: `bunx vitest run` PASS (vehicle-timing tests are still on the old fixed-speed model in this task; only placement fixtures change).

- [ ] **Step 5: Commit**

```bash
git add src/simulation/map.ts src/simulation/buildings.ts tests/
git commit -m "feat: metro stations require track; no buildings or stops on conflicting tiles"
```

---

### Task 7: Draft validation + draft paths in `UiState`

**Files:**
- Modify: `src/ui/uiState.ts`
- Modify: `src/ui/actions.ts` (`handleTileClick` busRoute/metroLine branches, `removeDraftStop`, `cancelDraftRoute`, `finishDraftRoute`, remove-tool ui resets)
- Modify: `src/runtime/createGameRuntime.ts` (`nextToolUiState`, `nextBuildingUiState`, `removeDraftStop` call)
- Modify: `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing tests** (in `tests/ui/actions.test.ts`; bus stops at `(7,8)`, `(15,8)`, `(22,8)` are road-connected)

```ts
describe("draft route path validation", () => {
  function busDraftState(): { state: GameState; ui: UiState } {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    return { state, ui: { ...createUiState(), activeTool: "busRoute" as const } };
  }

  it("appends a stop and its connecting path when a road path exists", () => {
    const { state, ui } = busDraftState();

    let result = handleTileClick(state, ui, { x: 7, y: 8 });
    expect(result.ui.draftStopIds).toEqual(["stop-001"]);
    expect(result.ui.draftStopPaths).toEqual([]);

    result = handleTileClick(state, result.ui, { x: 15, y: 8 });
    expect(result.ui.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(result.ui.draftStopPaths).toHaveLength(1);
    expect(result.ui.draftStopPaths[0][0]).toEqual({ x: 7, y: 8 });
    expect(result.ui.draftStopPaths[0].at(-1)).toEqual({ x: 15, y: 8 });
  });

  it("rejects adding a stop with no road path from the previous stop", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    // A stop stranded on the severed far end: cut the row between them.
    state = addBusStop(state, { x: 15, y: 8 });
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    // Other grid roads still connect them? x=7 and x=15 columns join rows;
    // sever those too so no path remains. y=8 is the only row, so cutting
    // the two column crossings is not needed — but the columns themselves
    // bridge via y=8 only through (11,8). Verify rejection:
    const ui = { ...createUiState(), activeTool: "busRoute" as const };

    let result = handleTileClick(state, ui, { x: 7, y: 8 });
    const before = result.ui;
    result = handleTileClick(state, before, { x: 15, y: 8 });

    expect(result.ui).toBe(before); // silent no-op
  });

  it("merges legs when removing a middle draft stop and keeps paths in sync", () => {
    const { state, ui } = busDraftState();
    let result = handleTileClick(state, ui, { x: 7, y: 8 });
    result = handleTileClick(state, result.ui, { x: 15, y: 8 });
    result = handleTileClick(state, result.ui, { x: 22, y: 8 });
    expect(result.ui.draftStopPaths).toHaveLength(2);

    const merged = removeDraftStop(state, result.ui, 1);
    expect(merged.draftStopIds).toEqual(["stop-001", "stop-003"]);
    expect(merged.draftStopPaths).toHaveLength(1);
    expect(merged.draftStopPaths[0][0]).toEqual({ x: 7, y: 8 });
    expect(merged.draftStopPaths[0].at(-1)).toEqual({ x: 22, y: 8 });
  });
});
```

Note: `removeDraftStop` gains a `state` parameter — update every existing call in this test file from `removeDraftStop(ui, i)` to `removeDraftStop(state, ui, i)`.

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: FAIL — `draftStopPaths` missing, signature mismatch.

- [ ] **Step 3: Extend `UiState`** (`src/ui/uiState.ts`)

Add to the interface (after `draftStationIds`):

```ts
  /** Tile path per consecutive draft pair; paths[i] connects ids[i] -> ids[i+1].
   *  Invariant: paths.length === max(0, ids.length - 1). */
  draftStopPaths: Point[][];
  draftStationPaths: Point[][];
```

and to `createUiState()`:

```ts
    draftStopPaths: [],
    draftStationPaths: [],
```

- [ ] **Step 4: Validate drafts in `handleTileClick`** (`src/ui/actions.ts`)

Add `import { findTilePath } from "../simulation/network";` and replace the `busRoute` branch:

```ts
  if (ui.activeTool === "busRoute") {
    const stop = resolveStopAtTile(state, point);
    if (stop === undefined || ui.draftStopIds.at(-1) === stop.id) {
      return { state, ui };
    }

    const previousId = ui.draftStopIds.at(-1);
    if (previousId === undefined) {
      return { state, ui: { ...ui, draftStopIds: [stop.id] } };
    }

    const previous = state.transit.stops.find((s) => s.id === previousId);
    const path =
      previous === undefined
        ? null
        : findTilePath(state.map, previous.position, stop.position, "bus");
    if (path === null) {
      return { state, ui };
    }
    return {
      state,
      ui: {
        ...ui,
        draftStopIds: [...ui.draftStopIds, stop.id],
        draftStopPaths: [...ui.draftStopPaths, path],
      },
    };
  }
```

Replace the `metroLine` branch the same way (stations, `draftStationIds`/`draftStationPaths`, mode `"metro"`).

- [ ] **Step 5: Rework `removeDraftStop` with the merge rule**

```ts
export function removeDraftStop(
  state: GameState,
  ui: UiState,
  index: number,
): UiState {
  const isMetro = ui.activeTool === "metroLine";
  const isBus = ui.activeTool === "busRoute";
  if (!isMetro && !isBus) {
    return ui;
  }

  const ids = isMetro ? ui.draftStationIds : ui.draftStopIds;
  const paths = isMetro ? ui.draftStationPaths : ui.draftStopPaths;
  if (index < 0 || index >= ids.length) {
    return ui;
  }

  let nextPaths: Point[][];
  if (index === 0) {
    nextPaths = paths.slice(1);
  } else if (index === ids.length - 1) {
    nextPaths = paths.slice(0, -1);
  } else {
    // Interior removal merges two legs; reject if the merged pair no longer
    // connects, so the draft invariant "every consecutive pair has a path"
    // always holds (the player can still cancel the whole draft).
    const nodes: Array<Stop | Station> = isMetro
      ? state.transit.stations
      : state.transit.stops;
    const before = nodes.find((node) => node.id === ids[index - 1]);
    const after = nodes.find((node) => node.id === ids[index + 1]);
    const merged =
      before === undefined || after === undefined
        ? null
        : findTilePath(
            state.map,
            before.position,
            after.position,
            isMetro ? "metro" : "bus",
          );
    if (merged === null) {
      return ui;
    }
    nextPaths = [...paths.slice(0, index - 1), merged, ...paths.slice(index + 1)];
  }

  const nextIds = ids.filter((_, i) => i !== index);
  return isMetro
    ? { ...ui, draftStationIds: nextIds, draftStationPaths: nextPaths }
    : { ...ui, draftStopIds: nextIds, draftStopPaths: nextPaths };
}
```

- [ ] **Step 6: Clear paths everywhere ids are cleared**

- `cancelDraftRoute`: return `{ ...ui, draftStopIds: [], draftStationIds: [], draftStopPaths: [], draftStationPaths: [] }`.
- `finishDraftRoute`: bus branch returns `ui: { ...ui, draftStopIds: [], draftStopPaths: [] }`; metro branch `ui: { ...ui, draftStationIds: [], draftStationPaths: [] }`.
- Both `nextUi` objects in the `remove`-tool branch of `handleTileClick`: add `draftStopPaths: [], draftStationPaths: []`.
- `src/runtime/createGameRuntime.ts` `nextToolUiState`: add

```ts
    draftStopPaths: activeTool === "busRoute" ? current.draftStopPaths : [],
    draftStationPaths: activeTool === "metroLine" ? current.draftStationPaths : [],
```

- `nextBuildingUiState`: add `draftStopPaths: [], draftStationPaths: [],`.
- Controller `removeDraftStop(index)` body: `return commit(state, applyRemoveDraftStop(state, ui, index));`

- [ ] **Step 7: Run ui + runtime projects**

Run: `bunx vitest run --project ui --project runtime`
Expected: PASS after updating remaining `removeDraftStop` call sites and any `createUiState()` shape assertions.

- [ ] **Step 8: Commit**

```bash
git add src/ui/uiState.ts src/ui/actions.ts src/runtime/createGameRuntime.ts tests/ui/actions.test.ts
git commit -m "feat: validate draft route legs against the network and track draft paths"
```

---

### Task 8: Distance-based vehicle movement

**Files:**
- Modify: `src/simulation/transit.ts` (`TILES_PER_SECOND`, `assignedLinePositions` → `assignedLineData`, `tickVehicles`)
- Modify: `tests/simulation/transit.test.ts`, `tests/simulation/citizens.test.ts` (timing expectations)

- [ ] **Step 1: Write the failing test**

```ts
describe("distance-based vehicle movement", () => {
  it("advances progress by speed/steps so longer segments take longer", () => {
    // createBusState: stops (7,8)->(15,8), 8 steps per segment.
    const state = createBusState();

    const after1s = tickVehicles(state, 1);
    // bus 0.8 tiles/s over 8 steps -> 0.1 progress/s
    expect(after1s.transit.vehicles[0].progress).toBeCloseTo(0.1, 5);

    const after10s = tickVehicles(state, 10);
    // Segment completed exactly at 10s: vehicle disembarks and advances.
    expect(after10s.transit.vehicles[0].segmentIndex).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "distance-based"`
Expected: FAIL — progress is `0.08` (old fixed speed).

- [ ] **Step 3: Implement**

In `src/simulation/transit.ts` add near `COSTS`:

```ts
/** Vehicle speeds in tiles per second; ride time = path steps / speed. */
export const TILES_PER_SECOND = { bus: 0.8, metro: 1.6 } as const;
```

Rename `assignedLinePositions` to `assignedLineData` and return segments too (the active/pathBroken gates from Task 3 stay):

```ts
function assignedLineData(
  state: GameState,
  vehicle: Vehicle,
): { positions: Point[]; segments: Point[][] } | null {
  if (vehicle.mode === "bus") {
    const route = state.transit.routes.find((c) => c.id === vehicle.lineId);
    if (route === undefined || !route.active || route.pathBroken) {
      return null;
    }
    const stopById = new Map(state.transit.stops.map((s) => [s.id, s.position]));
    const positions = route.stopIds.map((stopId) => stopById.get(stopId));
    if (positions.some((position) => position === undefined)) {
      return null;
    }
    return {
      positions: (positions as Point[]).map(clonePoint),
      segments: route.segments,
    };
  }

  const metroLine = state.transit.metroLines.find((c) => c.id === vehicle.lineId);
  if (metroLine === undefined || !metroLine.active || metroLine.pathBroken) {
    return null;
  }
  const stationById = new Map(
    state.transit.stations.map((s) => [s.id, s.position]),
  );
  const positions = metroLine.stationIds.map((id) => stationById.get(id));
  if (positions.some((position) => position === undefined)) {
    return null;
  }
  return {
    positions: (positions as Point[]).map(clonePoint),
    segments: metroLine.segments,
  };
}
```

In `tickVehicles` replace the per-vehicle body's opening and speed lines:

```ts
    const lineData = assignedLineData(state, vehicle);

    if (lineData === null || lineData.positions.length < 2) {
      return vehicle;
    }
    const { positions: linePositions, segments } = lineData;
```

and replace `const speed = vehicle.mode === "bus" ? 0.08 : 0.14;` + the progress line with:

```ts
    const segment = segments[vehicle.segmentIndex % segments.length];
    const steps = Math.max(1, segment.length - 1);
    const progress =
      boarded.vehicle.progress +
      (TILES_PER_SECOND[vehicle.mode] * deltaSeconds) / steps;
```

(The rest — boarding at `progress === 0`, `progress < 1` early return, disembark with `% 1` carry, `segmentIndex` wrap — is unchanged.)

- [ ] **Step 4: Re-time existing tests**

Run: `bunx vitest run --project simulation`
Update every timing assertion with the formula `progressPerSecond = TILES_PER_SECOND[mode] / steps` where `steps = segment path length − 1`:
- `createBusState` segments (7,8)↔(15,8): 8 steps ⇒ 0.1 progress/s, full segment in 10s (was 12.5s).
- `createThreeStopBusState` segments: 8, 7, and 15 (closing) steps.
- Metro lines over `trackRow(8, 7, 22)`: 15 steps ⇒ 1.6/15 ≈ 0.10667/s.
- `tests/simulation/citizens.test.ts` end-to-end trip outcomes shift with ride times; recompute expected times/status with the same formula plus unchanged walk (20 s/tile) and boarding behavior.

Expected: PASS after updates.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/
git commit -m "feat: vehicles travel stored paths at tiles-per-second speeds"
```

---

### Task 9: Router uses real path lengths and skips broken routes

**Files:**
- Modify: `src/simulation/router.ts`
- Modify: `tests/simulation/router.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import {
  removeInfrastructureAtTile,
  TILES_PER_SECOND,
} from "../../src/simulation/transit";

describe("path-length ride estimates", () => {
  it("estimates bus rides from stored segment steps, not Manhattan distance", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    const plan = findRoutePlan(state, { x: 7, y: 8 }, { x: 22, y: 8 });

    expect(plan).not.toBeNull();
    const busLeg = plan?.legs.find((leg) => leg.mode === "bus");
    expect(busLeg).toBeDefined();
    // 15 steps at 0.8 tiles/s + 90s boarding = 108.75s
    expect(plan?.estimatedSeconds).toBeCloseTo(90 + 15 / TILES_PER_SECOND.bus, 5);
  });

  it("ignores pathBroken routes when planning", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    const plan = findRoutePlan(state, { x: 7, y: 8 }, { x: 22, y: 8 });
    expect(plan?.legs.every((leg) => leg.mode === "walk")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/simulation/router.test.ts`
Expected: FAIL — estimate is `90 + 15*12 = 270` (old Manhattan model) and broken route still proposed.

- [ ] **Step 3: Implement**

In `src/simulation/router.ts`:

Add the import:

```ts
import { TILES_PER_SECOND } from "./transit";
```

Replace `busSeconds`/`metroSeconds`/`transitSeconds` with:

```ts
function rideSteps(segments: Point[][], fromIndex: number, toIndex: number): number {
  const count = segments.length;
  if (count === 0 || fromIndex === toIndex) {
    return 0;
  }
  let steps = 0;
  let index = fromIndex;
  while (index !== toIndex) {
    steps += Math.max(1, segments[index].length - 1);
    index = (index + 1) % count;
  }
  return steps;
}

function rideSeconds(mode: "bus" | "metro", steps: number): number {
  return (mode === "bus" ? 90 : 120) + steps / TILES_PER_SECOND[mode];
}
```

Extend `TransitService` and `activeServices` (skip unusable lines; anchors stay in stop order so anchor index i ↔ `segments[i]`):

```ts
interface TransitService {
  mode: "bus" | "metro";
  lineId: string;
  anchors: Point[];
  segments: Point[][];
}
```

In `activeServices`, for routes: skip when `!route.active || route.pathBroken`; build `anchors` as today but **skip the route when `anchors.length !== route.stopIds.length`** (a dangling stopId would desync anchor indexes from segments); push `{ mode: "bus", lineId: route.id, anchors, segments: route.segments }`. Mirror for metro lines.

Rework the single-route candidate loops to go through `activeServices(state)` instead of iterating routes/lines separately (one loop replaces both):

```ts
  const services = activeServices(state);

  for (const service of services) {
    let originIndex = -1;
    let destinationIndex = -1;
    let originDistance = Number.POSITIVE_INFINITY;
    let destinationDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < service.anchors.length; index += 1) {
      const anchor = service.anchors[index];
      const fromOrigin = manhattanDistance(anchor, origin);
      const toDestination = manhattanDistance(anchor, destination);
      if (fromOrigin < originDistance) {
        originDistance = fromOrigin;
        originIndex = index;
      }
      if (toDestination < destinationDistance) {
        destinationDistance = toDestination;
        destinationIndex = index;
      }
    }

    if (originIndex === -1 || originIndex === destinationIndex) {
      continue;
    }

    const boardAt = service.anchors[originIndex];
    const alightAt = service.anchors[destinationIndex];
    const steps = rideSteps(service.segments, originIndex, destinationIndex);

    candidates.push({
      legs: [
        walkLeg(origin, boardAt),
        transitLeg(service.mode, boardAt, alightAt, service.lineId),
        walkLeg(alightAt, destination),
      ],
      estimatedSeconds:
        walkSeconds(origin, boardAt) +
        rideSeconds(service.mode, steps) +
        walkSeconds(alightAt, destination),
    });
  }
```

(Delete the now-redundant standalone `for (const route of ...)` and `for (const line of ...)` candidate blocks and the `nearestByPosition` usages they contained; keep `nearestByPosition` only if still referenced, otherwise remove it.)

For the transfer loop, replace `nearestAnchor`/`bestTransferPair` with index-returning variants:

```ts
function nearestAnchorIndex(anchors: Point[], target: Point): number {
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < anchors.length; index += 1) {
    const distance = manhattanDistance(anchors[index], target);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  }
  return nearest;
}

function bestTransferIndexes(
  first: TransitService,
  second: TransitService,
): { first: number; second: number } | null {
  let best: { first: number; second: number; distance: number } | null = null;
  for (let i = 0; i < first.anchors.length; i += 1) {
    for (let j = 0; j < second.anchors.length; j += 1) {
      const distance = manhattanDistance(first.anchors[i], second.anchors[j]);
      if (best === null || distance < best.distance) {
        best = { first: i, second: j, distance };
      }
    }
  }
  return best === null ? null : { first: best.first, second: best.second };
}
```

and in the transfer candidate construction use anchor indexes for both the leg endpoints and `rideSteps(first.segments, firstStartIndex, transfer.first)` / `rideSteps(second.segments, transfer.second, secondEndIndex)`, with `rideSeconds(...)` replacing `transitSeconds(...)`. Skip a candidate when `firstStartIndex === transfer.first` or `transfer.second === secondEndIndex` contributes zero-step rides only if both legs collapse (keep behavior simple: skip when `firstStartIndex === -1 || secondEndIndex === -1`).

- [ ] **Step 4: Run and fix estimates in older router tests**

Run: `bunx vitest run tests/simulation/router.test.ts tests/simulation/citizens.test.ts`
Update older expected `estimatedSeconds` values with `rideSeconds`: bus `90 + steps/0.8`, metro `120 + steps/1.6`, walk unchanged `20 × Manhattan`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/router.ts tests/simulation/
git commit -m "feat: router estimates rides from stored path lengths and skips broken routes"
```

---

### Task 10: Rendering — track layer, path-following lines, vehicles, draft preview

**Files:**
- Modify: `src/render/colors.ts`, `src/render/mapRenderer.ts`, `src/render/transitRenderer.ts`
- Modify: `tests/render/transitRenderer.test.ts` (and `tests/render/canvas.test.ts` if it snapshots draw calls)

- [ ] **Step 1: Write the failing test** (in `tests/render/transitRenderer.test.ts` — the file's existing `ctx()` helper builds a `vi.fn()` method stub, so draw calls are assertable through the mocks)

```ts
it("draws the route line through the road path tiles, not stop-to-stop", () => {
  // Stops at (7,8) and (15,4): the path runs along y=8 then up x=15, so the
  // polyline must include the corner tile (15,8) — a straight line would not.
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 15, y: 4 });
  state = addBusRoute(state, ["stop-001", "stop-002"]);

  const context = ctx();
  renderTransit(context, state, createUiState());

  // tileSize=32: corner tile (15,8) centre = (15*32+16, 8*32+16) = (496, 272).
  expect(context.lineTo).toHaveBeenCalledWith(496, 272);
});
```

(`ctx()`'s methods are `vi.fn()` mocks, so `toHaveBeenCalledWith` works directly. `(15,4)` is a road tile on the x=15 column, so the bus stop placement is valid.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/render/transitRenderer.test.ts`
Expected: the new test FAILS (straight line skips the corner).

- [ ] **Step 3: Track color and map layer**

`src/render/colors.ts` — add to the object:

```ts
  track: "#33302b",
```

`src/render/mapRenderer.ts` — after the existing tile loop:

```ts
  const trackKeys = new Set(
    state.map.tiles
      .filter((tile) => tile.hasTrack === true)
      .map((tile) => `${tile.x},${tile.y}`),
  );

  if (trackKeys.size > 0) {
    ctx.strokeStyle = colors.track;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";

    for (const tile of state.map.tiles) {
      if (tile.hasTrack !== true) {
        continue;
      }
      const cx = tile.x * tileSize + tileSize / 2;
      const cy = tile.y * tileSize + tileSize / 2;
      let connected = false;

      for (const offset of [
        { x: 0, y: -1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
      ]) {
        if (!trackKeys.has(`${tile.x + offset.x},${tile.y + offset.y}`)) {
          continue;
        }
        connected = true;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (offset.x * tileSize) / 2, cy + (offset.y * tileSize) / 2);
        ctx.stroke();
      }

      if (!connected) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
```

- [ ] **Step 4: Path-following lines, vehicles, and draft preview** (`src/render/transitRenderer.ts`)

Add a helper and use it for route/line/halo drawing; broken routes fall back to the straight stop-to-stop polyline as a visible "off the network" cue:

```ts
function lineDrawPositions(
  state: GameState,
  line: { segments: Point[][]; pathBroken: boolean },
  fallbackIds: string[],
  kind: "stops" | "stations",
): Array<Point | null> {
  if (line.pathBroken || line.segments.length === 0) {
    return kind === "stops"
      ? routePositions(state, fallbackIds)
      : stationPositions(state, fallbackIds);
  }
  return line.segments.flat();
}
```

- Halo block: `drawPolyline(ctx, lineDrawPositions(state, route, route.stopIds, "stops"), "#ffffffaa", 9)` and the metro equivalent.
- Main loops: same call with the route/line color and existing widths.
- Replace `vehiclePosition` with the path interpolation:

```ts
function vehiclePosition(state: GameState, vehicle: Vehicle): Point | null {
  const line =
    vehicle.mode === "bus"
      ? state.transit.routes.find((route) => route.id === vehicle.lineId)
      : state.transit.metroLines.find((l) => l.id === vehicle.lineId);
  if (line === undefined) {
    return null;
  }
  const ids = vehicle.mode === "bus" ? (line as Route).stopIds : (line as MetroLine).stationIds;
  const nodePositions =
    vehicle.mode === "bus" ? routePositions(state, ids) : stationPositions(state, ids);
  if (nodePositions.length < 2) {
    return null;
  }

  const segmentCount = line.segments.length > 0 ? line.segments.length : nodePositions.length;
  const segmentIndex =
    ((vehicle.segmentIndex % segmentCount) + segmentCount) % segmentCount;
  const segment = line.segments[segmentIndex];

  if (line.pathBroken || segment === undefined || segment.length === 0) {
    // Parked at the segment-start stop while the network is broken.
    const parked = nodePositions[segmentIndex % nodePositions.length];
    return parked === null ? null : center(parked);
  }

  const steps = segment.length - 1;
  if (steps <= 0) {
    return center(segment[0]);
  }
  const along = Math.max(0, Math.min(1, vehicle.progress)) * steps;
  const tileIndex = Math.min(Math.floor(along), steps - 1);
  return interpolate(segment[tileIndex], segment[tileIndex + 1], along - tileIndex);
}
```

- Draft preview block: replace the `draftIds`/positions logic with the stored paths:

```ts
  const draftPaths =
    ui.activeTool === "busRoute"
      ? ui.draftStopPaths
      : ui.activeTool === "metroLine"
        ? ui.draftStationPaths
        : [];
  if (draftPaths.length >= 1) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    drawPolyline(ctx, draftPaths.flat(), "#f4d35e", 3);
    ctx.restore();
  }
```

(Add `Route`, `MetroLine` to the type imports.)

- [ ] **Step 5: Run render tests**

Run: `bunx vitest run --project ui` (the `ui` vitest project includes `tests/render`)
Expected: new test PASSES; update existing transitRenderer expectations that asserted straight stop-to-stop draw calls (they now follow paths) and any draft-preview assertions (now read `draftStopPaths`).

- [ ] **Step 6: Commit**

```bash
git add src/render/ tests/render/
git commit -m "feat: render track layer and path-following routes, vehicles, drafts"
```

---

### Task 11: BuildPanel — Road and Track tool buttons

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Create: `tests/ui/buildPanel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/buildPanel.test.ts`:

```ts
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";

function renderPanel(onSetTool = vi.fn()) {
  render(BuildPanel, {
    props: {
      activeTool: "inspect" as const,
      selectedBuilding: null,
      buildingRotation: 0 as const,
      onSetTool,
      onSetBuilding: vi.fn(),
      onRotateBuilding: vi.fn(),
    },
  });
  return onSetTool;
}

describe("BuildPanel network tools", () => {
  it("renders Road and Track buttons", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Road" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Track" })).toBeVisible();
  });

  it("activates the road and track tools on click", async () => {
    const onSetTool = renderPanel();
    await fireEvent.click(screen.getByRole("button", { name: "Road" }));
    expect(onSetTool).toHaveBeenCalledWith("road");
    await fireEvent.click(screen.getByRole("button", { name: "Track" }));
    expect(onSetTool).toHaveBeenLastCalledWith("track");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/ui/buildPanel.test.ts`
Expected: FAIL — no Road/Track buttons.

- [ ] **Step 3: Add the Network section**

In `BuildPanel.svelte` add after the `globalTools` array:

```ts
  type NetworkTool = Extract<Tool, "road" | "track">;

  const networkTools: Array<{ id: NetworkTool; label: string }> = [
    { id: "road", label: "Road" },
    { id: "track", label: "Track" },
  ];
```

Insert a new section between Global (01) and Build, and renumber Build's heading to `03`:

```svelte
  <section class="panel-section">
    <h3 class="section-head"><span class="num">02</span> Network</h3>
    <div class="toolbar toolbar--compact" aria-label="Network tools">
      {#each networkTools as tool, index (tool.id)}
        <button
          type="button"
          data-tool={tool.id}
          aria-pressed={selectedBuilding === null && activeTool === tool.id}
          aria-label={tool.label}
          class:active={selectedBuilding === null && activeTool === tool.id}
          onclick={() => onSetTool(tool.id)}
        >
          <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
          <span class="tool-label" aria-hidden="true">{tool.label}</span>
        </button>
      {/each}
    </div>
  </section>
```

```svelte
    <h3 class="section-head"><span class="num">03</span> Build</h3>
```

- [ ] **Step 4: Run ui tests**

Run: `bunx vitest run --project ui`
Expected: PASS (fix any hudPanels/appShell snapshot that asserts the Build section number).

- [ ] **Step 5: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte tests/ui/buildPanel.test.ts
git commit -m "feat: add Road and Track tools to the build panel"
```

---

### Task 12: E2E metro flow + full verification

**Files:**
- Modify: `tests/e2e/routes.spec.ts`

- [ ] **Step 1: Confirm the metro UI labels** (the draft/finish controls live in RoutesPanel)

Run: `grep -n "Metro Line\|finish route\|Finish" src/components/hud/panels/RoutesPanel.svelte`
Expected: a "Metro Line" tool button and the same finish control the bus e2e uses (`/finish route/i`). If the labels differ, use the actual ones in the test below.

- [ ] **Step 2: Add the e2e test** (append to `tests/e2e/routes.spec.ts`)

Budget check: 5 track tiles ($2,500) + 2 Metro Station buildings ($50,000) + metro vehicle ($50,000) = $102,500 ≤ $120,000. Row y=2, x=8..12 is empty ground and the game starts paused, so growth waves never fire mid-test.

```ts
test("create a metro line on laid track", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a 5-tile track run on empty ground.
  await openHudCategory(page, "build");
  await page.locator("[data-tool='track']").click();
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Stations on the track ends (Metro Station building requires track).
  await page.getByRole("button", { name: "Metro Station" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });

  // Connect them with a metro line.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Metro Line" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /finish route/i }).click();

  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-name-metro-001")).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `bun run test:e2e`
Expected: both routes specs PASS — the existing bus flow exercises the endpoint exception (its stops are Bus Stop buildings on empty tiles beside the y=8 road), the new one exercises track + stations + line.

- [ ] **Step 4: Full gates**

```bash
bun run check
bun run lint
bun run format:check
bun run test
bun run test:e2e
bun run build
```

Expected: all PASS. Fix anything outstanding before committing.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/routes.spec.ts
git commit -m "test: e2e metro line over laid track"
```

---

## Out of scope (per spec)

Drag-to-paint, refunds, one-way roads/track capacity, force-disembark for *manually* deactivated routes, road-aware citizen walking.
