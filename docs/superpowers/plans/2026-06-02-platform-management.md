# Platform-Based Stop/Station Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each transit node a fixed set of platforms (bus stop 1, metro station 2, bus terminal 3), each with a hard waiting capacity (bus 50 / metro 300), let routes be assigned to platforms (auto on create, rebalanced via an Inspect panel), and enforce the cap at boarding so overflow citizens queue off-platform.

**Architecture:** Platforms are logical slots stored on `Stop`/`Station` as `platforms: Platform[]` (each with `routeIds` + `capacity`). The *only* new persistent state is the route→platform assignment; on/off-platform occupancy is derived each tick from citizens (single source of truth). A new pure module `src/simulation/platforms.ts` owns platform construction and all derivations. The trip router is unchanged; the hard cap is enforced solely in `tickVehicles` via a board-eligibility snapshot computed once per tick (deterministic, iteration-order-independent).

**Tech Stack:** TypeScript (pure simulation), Svelte 5 runes (UI), Vitest (`bun run test`), `bun run check` for types. Package manager: **Bun** (never npm/yarn).

**Spec:** `docs/superpowers/specs/2026-06-02-platform-management-design.md`

---

## File Structure

**Create:**
- `src/simulation/platforms.ts` — platform constants, builders, and all derivations (waiter grouping, occupancy, on-platform set).
- `tests/simulation/platforms.test.ts` — unit tests for the new module.

**Modify:**
- `src/domain/types.ts` — add `Platform`; replace `queueCitizenIds` with `platforms` on `Stop` and `Station`.
- `src/simulation/transit.ts` — init platforms in `addBusStop`/`addMetroStation`; auto-assign routes in `addBusRoute`/`addMetroLine`; `assignRouteToPlatform` helper; on-platform gate in `tickVehicles`/`citizenCanBoard`/`boardVehicle`.
- `src/simulation/buildings.ts` — init platforms in `placeBuilding`.
- `src/ui/actions.ts` — `resolveNodeAtTile`; strip removed route ids from surviving platforms in `removeAtTile`.
- `src/render/overlayRenderer.ts` — rewrite crowding branch using `selectPlatformOccupancy`.
- `src/runtime/types.ts` — inspector view-model types; `assignRouteToPlatform` on `RuntimeController`.
- `src/runtime/runtimeSelectors.ts` — build `inspector` in `selectShellState`.
- `src/runtime/createGameRuntime.ts` — implement `assignRouteToPlatform` controller method.
- `src/components/ControlTower.svelte` — render the platform panel + move buttons.
- `src/App.svelte` — wire `onAssignRouteToPlatform` down to `ControlTower`.
- Test fixtures replacing `queueCitizenIds: []` with `platforms: [...]` (see Task 1, Step 12).

---

## Task 1: Platform data model, builders, derivations, and fixture migration

This task introduces the `Platform` type, the `platforms.ts` module, initializes platforms at every node-creation site, rewrites the crowding overlay to use derived occupancy, and migrates all fixtures — ending with a green type-check and test suite.

**Files:**
- Create: `src/simulation/platforms.ts`, `tests/simulation/platforms.test.ts`
- Modify: `src/domain/types.ts`, `src/simulation/transit.ts`, `src/simulation/buildings.ts`, `src/render/overlayRenderer.ts`, and all test fixtures listed in Step 12.

- [ ] **Step 1: Write the failing test for platform builders**

Create `tests/simulation/platforms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { busPlatforms, metroPlatforms } from "../../src/simulation/platforms";

describe("platform builders", () => {
  it("creates one capacity-50 platform for a bus stop", () => {
    const platforms = busPlatforms("stop-001", "busStop");
    expect(platforms).toEqual([
      { id: "stop-001-p0", label: "A", capacity: 50, routeIds: [] },
    ]);
  });

  it("creates three capacity-50 platforms for a bus terminal", () => {
    const platforms = busPlatforms("stop-002", "busTerminal");
    expect(platforms.map((p) => p.label)).toEqual(["A", "B", "C"]);
    expect(platforms.every((p) => p.capacity === 50)).toBe(true);
    expect(platforms.map((p) => p.id)).toEqual([
      "stop-002-p0",
      "stop-002-p1",
      "stop-002-p2",
    ]);
  });

  it("creates two capacity-300 platforms for a metro station", () => {
    const platforms = metroPlatforms("station-001");
    expect(platforms.map((p) => p.label)).toEqual(["A", "B"]);
    expect(platforms.every((p) => p.capacity === 300)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/simulation/platforms.test.ts`
Expected: FAIL — cannot resolve `../../src/simulation/platforms`.

- [ ] **Step 3: Add the `Platform` type and update `Stop`/`Station`**

In `src/domain/types.ts`, add the interface above `Stop` (after `Point`/`Tile` block is fine; place it right before `Stop`):

```ts
export interface Platform {
  id: string;
  label: string;
  capacity: number;
  routeIds: string[];
}
```

Then change `Stop` and `Station`: replace the `queueCitizenIds: string[];` line in each with `platforms: Platform[];`:

```ts
export interface Stop {
  id: string;
  kind: StopKind;
  position: Point;
  platforms: Platform[];
}

export interface Station {
  id: string;
  position: Point;
  platforms: Platform[];
}
```

- [ ] **Step 4: Create `src/simulation/platforms.ts` with builders**

```ts
import type { GameState, Platform, StopKind } from "../domain/types";

export const PLATFORM_CAPACITY = { bus: 50, metro: 300 } as const;

const PLATFORM_LABELS = ["A", "B", "C", "D", "E", "F"] as const;

function buildPlatforms(
  nodeId: string,
  count: number,
  capacity: number,
): Platform[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${nodeId}-p${index}`,
    label: PLATFORM_LABELS[index] ?? String(index),
    capacity,
    routeIds: [],
  }));
}

export function busPlatforms(nodeId: string, kind: StopKind): Platform[] {
  return buildPlatforms(
    nodeId,
    kind === "busTerminal" ? 3 : 1,
    PLATFORM_CAPACITY.bus,
  );
}

export function metroPlatforms(nodeId: string): Platform[] {
  return buildPlatforms(nodeId, 2, PLATFORM_CAPACITY.metro);
}
```

- [ ] **Step 5: Run the builder test to verify it passes**

Run: `bunx vitest run tests/simulation/platforms.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Initialize platforms in `transit.ts` creation paths**

In `src/simulation/transit.ts`, add the import near the other simulation imports:

```ts
import { busPlatforms, metroPlatforms } from "./platforms";
```

In `addBusStop`, the new stop literal currently sets `queueCitizenIds: []`. The `id` is created inline via `nextEntityId(...)`. Refactor so the id is computed first, then used for both the stop id and its platforms:

```ts
export function addBusStop(
  state: GameState,
  point: Point,
  kind: StopKind = "busStop",
): GameState {
  if (
    !canAfford(state, COSTS.busStop) ||
    !isValidBusStopPlacement(state, point)
  ) {
    return state;
  }

  const stopId = nextEntityId(
    "stop",
    state.transit.stops.map((stop) => stop.id),
  );

  return {
    ...state,
    budget: state.budget - COSTS.busStop,
    transit: {
      ...state.transit,
      stops: [
        ...state.transit.stops,
        {
          id: stopId,
          kind,
          position: clonePoint(point),
          platforms: busPlatforms(stopId, kind),
        },
      ],
    },
  };
}
```

In `addMetroStation`, do the same — compute `stationId` first, then:

```ts
  const stationId = nextEntityId(
    "station",
    state.transit.stations.map((station) => station.id),
  );

  return {
    ...state,
    budget: state.budget - COSTS.metroStation,
    transit: {
      ...state.transit,
      stations: [
        ...state.transit.stations,
        {
          id: stationId,
          position: clonePoint(point),
          platforms: metroPlatforms(stationId),
        },
      ],
    },
  };
```

- [ ] **Step 7: Initialize platforms in `buildings.ts`**

In `src/simulation/buildings.ts`, add the import:

```ts
import { busPlatforms, metroPlatforms } from "./platforms";
```

In `placeBuilding`, the bus branch already computes `transitNodeId` before building the stop. Replace `queueCitizenIds: []` in the stop literal with `platforms: busPlatforms(transitNodeId, definition.effect)`. Note `definition.effect` is `"busStop" | "busTerminal"` here, which matches `StopKind`:

```ts
  if (definition.effect === "busStop" || definition.effect === "busTerminal") {
    transitNodeId = nextEntityId(
      "stop",
      state.transit.stops.map((stop) => stop.id),
    );
    transit = {
      ...transit,
      stops: [
        ...transit.stops,
        {
          id: transitNodeId,
          kind: definition.effect,
          position: clonePoint(origin),
          platforms: busPlatforms(transitNodeId, definition.effect),
        },
      ],
    };
  }
```

And the metro branch — replace `queueCitizenIds: []` with `platforms: metroPlatforms(transitNodeId)`:

```ts
  if (definition.effect === "metroStation") {
    transitNodeId = nextEntityId(
      "station",
      state.transit.stations.map((station) => station.id),
    );
    transit = {
      ...transit,
      stations: [
        ...transit.stations,
        {
          id: transitNodeId,
          position: clonePoint(origin),
          platforms: metroPlatforms(transitNodeId),
        },
      ],
    };
  }
```

- [ ] **Step 8: Write the failing test for occupancy derivations**

Append to `tests/simulation/platforms.test.ts`:

```ts
import {
  onPlatformCitizenIds,
  selectPlatformOccupancy,
} from "../../src/simulation/platforms";
import type { Citizen, GameState, Stop } from "../../src/domain/types";

function waitingCitizen(
  id: string,
  position: { x: number; y: number },
  lineId: string,
  patienceRemaining: number,
): Citizen {
  return {
    id,
    home: position,
    destination: { x: 0, y: 0 },
    position,
    status: "waiting",
    patienceRemaining,
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [{ mode: "bus", from: position, to: { x: 0, y: 0 }, lineId }],
    },
    currentLegIndex: 0,
  };
}

function stateWithStop(stop: Stop, citizens: Citizen[]): GameState {
  return {
    time: 0,
    speed: 1,
    paused: false,
    budget: 0,
    map: { width: 20, height: 20, tiles: [] },
    buildings: [],
    scenario: {
      name: "t",
      growthWaves: [],
      objectives: {
        maxLateRatio: 1,
        maxUnservedRatio: 1,
        maxAverageWait: 9_999,
        rollingWindowSeconds: 1,
        survivalTime: 1,
      },
    },
    transit: {
      stops: [stop],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    citizens,
    metrics: {
      lateTrips: 0,
      completedTrips: 0,
      unservedTrips: 0,
      totalWaitSeconds: 0,
      waitingCitizenCount: 0,
      averageWaitSeconds: 0,
      tripOutcomes: [],
      state: "running",
      lossReason: null,
    },
  };
}

describe("platform occupancy derivations", () => {
  const stop: Stop = {
    id: "stop-001",
    kind: "busStop",
    position: { x: 5, y: 5 },
    platforms: [
      { id: "stop-001-p0", label: "A", capacity: 2, routeIds: ["route-001"] },
    ],
  };

  it("counts waiting citizens whose line is on the platform", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("c1", { x: 5, y: 5 }, "route-001", 100),
      waitingCitizen("c2", { x: 5, y: 5 }, "route-001", 90),
      waitingCitizen("c3", { x: 5, y: 5 }, "route-002", 80), // different line
    ]);
    expect(selectPlatformOccupancy(state).get("stop-001-p0")).toEqual({
      count: 2,
      capacity: 2,
    });
  });

  it("includes only the first `capacity` waiters (longest-waiting first) on the platform", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("c1", { x: 5, y: 5 }, "route-001", 100), // most patience -> overflow
      waitingCitizen("c2", { x: 5, y: 5 }, "route-001", 50),
      waitingCitizen("c3", { x: 5, y: 5 }, "route-001", 10), // least patience -> on platform
    ]);
    const onPlatform = onPlatformCitizenIds(state);
    expect(onPlatform.has("c3")).toBe(true);
    expect(onPlatform.has("c2")).toBe(true);
    expect(onPlatform.has("c1")).toBe(false);
  });
});
```

- [ ] **Step 9: Run the occupancy test to verify it fails**

Run: `bunx vitest run tests/simulation/platforms.test.ts`
Expected: FAIL — `selectPlatformOccupancy`/`onPlatformCitizenIds` are not exported.

- [ ] **Step 10: Implement the derivations in `platforms.ts`**

Append to `src/simulation/platforms.ts`:

```ts
import type { Citizen } from "../domain/types";

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function waitingLineId(citizen: Citizen): string | undefined {
  const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
  return leg !== undefined && leg.mode !== "walk" ? leg.lineId : undefined;
}

// Map of `${posKey}|${lineId}` -> platformId across all nodes.
function platformIndex(state: GameState): Map<string, string> {
  const index = new Map<string, string>();
  const nodes = [...state.transit.stops, ...state.transit.stations];

  for (const node of nodes) {
    const posKey = positionKey(node.position.x, node.position.y);
    for (const platform of node.platforms) {
      for (const routeId of platform.routeIds) {
        index.set(`${posKey}|${routeId}`, platform.id);
      }
    }
  }

  return index;
}

// Ordered (longest-waiting first, id tiebreak) waiter ids per platform id.
export function platformWaiterIds(state: GameState): Map<string, string[]> {
  const index = platformIndex(state);
  const groups = new Map<string, Citizen[]>();

  for (const citizen of state.citizens) {
    if (citizen.status !== "waiting") {
      continue;
    }

    const lineId = waitingLineId(citizen);
    if (lineId === undefined) {
      continue;
    }

    const platformId = index.get(
      `${positionKey(citizen.position.x, citizen.position.y)}|${lineId}`,
    );
    if (platformId === undefined) {
      continue;
    }

    const group = groups.get(platformId);
    if (group === undefined) {
      groups.set(platformId, [citizen]);
    } else {
      group.push(citizen);
    }
  }

  const ordered = new Map<string, string[]>();
  for (const [platformId, citizens] of groups) {
    ordered.set(
      platformId,
      citizens
        .slice()
        .sort(
          (left, right) =>
            left.patienceRemaining - right.patienceRemaining ||
            left.id.localeCompare(right.id),
        )
        .map((citizen) => citizen.id),
    );
  }

  return ordered;
}

function platformCapacities(state: GameState): Map<string, number> {
  const capacities = new Map<string, number>();
  const nodes = [...state.transit.stops, ...state.transit.stations];

  for (const node of nodes) {
    for (const platform of node.platforms) {
      capacities.set(platform.id, platform.capacity);
    }
  }

  return capacities;
}

export function selectPlatformOccupancy(
  state: GameState,
): Map<string, { count: number; capacity: number }> {
  const capacities = platformCapacities(state);
  const waiters = platformWaiterIds(state);
  const occupancy = new Map<string, { count: number; capacity: number }>();

  for (const [platformId, capacity] of capacities) {
    occupancy.set(platformId, {
      count: waiters.get(platformId)?.length ?? 0,
      capacity,
    });
  }

  return occupancy;
}

export function onPlatformCitizenIds(state: GameState): Set<string> {
  const capacities = platformCapacities(state);
  const waiters = platformWaiterIds(state);
  const onPlatform = new Set<string>();

  for (const [platformId, ids] of waiters) {
    const capacity = capacities.get(platformId) ?? 0;
    for (const id of ids.slice(0, capacity)) {
      onPlatform.add(id);
    }
  }

  return onPlatform;
}
```

Note: merge the new `import type { Citizen }` into the existing top-of-file `import type { GameState, Platform, StopKind } from "../domain/types";` so there is a single import line: `import type { Citizen, GameState, Platform, StopKind } from "../domain/types";`.

- [ ] **Step 11: Run the occupancy test to verify it passes**

Run: `bunx vitest run tests/simulation/platforms.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 12: Rewrite the crowding overlay and migrate all fixtures**

In `src/render/overlayRenderer.ts`, add the import:

```ts
import { selectPlatformOccupancy } from "../simulation/platforms";
```

Replace the entire `if (ui.activeOverlay === "crowding") { ... }` block (the one iterating `state.transit.stops`/`stations` and reading `queueCitizenIds`) with:

```ts
  if (ui.activeOverlay === "crowding") {
    const occupancy = selectPlatformOccupancy(state);
    const nodes = [...state.transit.stops, ...state.transit.stations];

    for (const node of nodes) {
      let maxRatio = 0;
      for (const platform of node.platforms) {
        const entry = occupancy.get(platform.id);
        if (entry !== undefined && entry.capacity > 0) {
          maxRatio = Math.max(maxRatio, entry.count / entry.capacity);
        }
      }

      if (maxRatio <= 0.5) {
        continue;
      }

      ctx.save();
      ctx.globalAlpha = maxRatio >= 1 ? 0.55 : 0.3;
      ctx.fillStyle = colors.crowding;
      fillTile(ctx, node.position);
      ctx.restore();
    }
  }
```

Now fix every remaining compile error from the field rename. Run `bun run check` and update each `Stop`/`Station` object literal that still uses `queueCitizenIds: []` to use `platforms: []` instead (an empty array is a valid `Platform[]` for fixtures that don't assert on platforms). The known fixture locations:

- `tests/simulation/buildings.test.ts` (lines ~114, ~121)
- `tests/ui/actions.test.ts` (lines ~70, ~95, ~160)
- `tests/render/canvas.test.ts` (lines ~145, ~153, ~227)
- `tests/simulation/router.test.ts` (lines ~105, ~111, ~115, ~119)
- `tests/simulation/map.test.ts` (lines ~43, ~69)
- `tests/simulation/transit.test.ts` (lines ~43, ~55, ~63)

For each, replace `queueCitizenIds: []` with `platforms: []`. Confirm none remain:

Run: `grep -rn "queueCitizenIds" src tests`
Expected: no output.

- [ ] **Step 13: Run the full check + test suite**

Run: `bun run check && bun run test`
Expected: type-check passes; all vitest projects pass.

- [ ] **Step 14: Commit**

```bash
git add src/domain/types.ts src/simulation/platforms.ts src/simulation/transit.ts src/simulation/buildings.ts src/render/overlayRenderer.ts tests/simulation/platforms.test.ts tests/simulation/buildings.test.ts tests/ui/actions.test.ts tests/render/canvas.test.ts tests/simulation/router.test.ts tests/simulation/map.test.ts tests/simulation/transit.test.ts
git commit -m "feat: add platform data model, builders, and occupancy derivations"
```

---

## Task 2: Auto-assign routes to least-loaded platforms on create

When a route/line is created, register its id on the least-loaded platform of each distinct node it serves.

**Files:**
- Modify: `src/simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/simulation/transit.test.ts` (import `addBusRoute`, `addBusStop` if not already imported at top):

```ts
import { addBusRoute, addBusStop } from "../../src/simulation/transit";

describe("auto-assign routes to platforms", () => {
  it("registers a new bus route on each served stop's least-loaded platform", () => {
    let state = makeBaseState(); // existing helper in this file that returns a GameState with budget
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 2, y: 2 });
    state = addBusStop(state, { x: 6, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);

    state = addBusRoute(state, stopIds);
    const routeId = state.transit.routes.at(-1)!.id;

    for (const stop of state.transit.stops) {
      const holding = stop.platforms.filter((p) =>
        p.routeIds.includes(routeId),
      );
      expect(holding).toHaveLength(1);
    }
  });

  it("spreads two routes across a terminal's platforms (least-loaded first)", () => {
    let state = makeBaseState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 2, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 6, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);

    state = addBusRoute(state, stopIds);
    const routeA = state.transit.routes.at(-1)!.id;
    state = addBusRoute(state, stopIds);
    const routeB = state.transit.routes.at(-1)!.id;

    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const platformOf = (routeId: string) =>
      terminal.platforms.find((p) => p.routeIds.includes(routeId))!.label;
    expect(platformOf(routeA)).toBe("A");
    expect(platformOf(routeB)).toBe("B");
  });
});
```

If `makeBaseState` does not exist in this test file, use the existing state-construction helper present in `tests/simulation/transit.test.ts` (it already builds `GameState` fixtures for the other tests) — reuse that exact constructor and add stops via `addBusStop`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "auto-assign"`
Expected: FAIL — routes are not registered on any platform.

- [ ] **Step 3: Implement auto-assignment in `transit.ts`**

Add this helper near the top of `src/simulation/transit.ts` (below the existing small helpers):

```ts
function assignRouteToLeastLoaded<T extends { id: string; platforms: Platform[] }>(
  nodes: T[],
  nodeIds: string[],
  routeId: string,
): T[] {
  const targetIds = new Set(nodeIds);

  return nodes.map((node) => {
    if (!targetIds.has(node.id) || node.platforms.length === 0) {
      return node;
    }

    let bestIndex = 0;
    for (let index = 1; index < node.platforms.length; index += 1) {
      if (
        node.platforms[index].routeIds.length <
        node.platforms[bestIndex].routeIds.length
      ) {
        bestIndex = index;
      }
    }

    return {
      ...node,
      platforms: node.platforms.map((platform, index) =>
        index === bestIndex
          ? { ...platform, routeIds: [...platform.routeIds, routeId] }
          : platform,
      ),
    };
  });
}
```

Add `Platform` to the existing `import type { ... } from "../domain/types";` at the top of `transit.ts`.

In `addBusRoute`, after computing `routeId`/`routeNumber` and before the `return`, assign the route to each distinct served stop. Change the returned `transit` object to update `stops`:

```ts
  const distinctStopIds = Array.from(new Set(stopIds));

  return {
    ...state,
    transit: {
      ...state.transit,
      stops: assignRouteToLeastLoaded(
        state.transit.stops,
        distinctStopIds,
        routeId,
      ),
      routes: [
        ...state.transit.routes,
        {
          id: routeId,
          name: `Bus ${routeNumber}`,
          color: "#e04f39",
          stopIds: [...stopIds],
          vehicleIds: [],
          active: distinctValidStopCount(state, stopIds) >= 2,
        },
      ],
    },
  };
```

In `addMetroLine`, do the analogous change — add `const distinctStationIds = Array.from(new Set(stationIds));` and set `stations: assignRouteToLeastLoaded(state.transit.stations, distinctStationIds, lineId)` in the returned `transit`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "auto-assign"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full transit suite to check for regressions**

Run: `bunx vitest run tests/simulation/transit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: auto-assign routes to least-loaded platform on create"
```

---

## Task 3: `resolveNodeAtTile` and route-removal platform cleanup

Add a node resolver (used later by the selector) and ensure removing a node strips its routes' ids from surviving platforms.

**Files:**
- Modify: `src/ui/actions.ts`
- Test: `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing test for `resolveNodeAtTile`**

Add to `tests/ui/actions.test.ts`:

```ts
import { resolveNodeAtTile } from "../../src/ui/actions";

describe("resolveNodeAtTile", () => {
  it("resolves a bus stop at its exact tile", () => {
    let state = makeBaseState(); // existing helper in this test file
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 4, y: 4 });
    const resolved = resolveNodeAtTile(state, { x: 4, y: 4 });
    expect(resolved?.kind).toBe("stop");
    expect(resolved?.node.id).toBe(state.transit.stops[0].id);
  });

  it("resolves a metro station at its exact tile", () => {
    let state = makeBaseState();
    state = { ...state, budget: 1_000_000 };
    state = addMetroStation(state, { x: 7, y: 7 });
    const resolved = resolveNodeAtTile(state, { x: 7, y: 7 });
    expect(resolved?.kind).toBe("station");
  });

  it("returns null on an empty tile", () => {
    const state = makeBaseState();
    expect(resolveNodeAtTile(state, { x: 0, y: 0 })).toBeNull();
  });
});
```

Use the test file's existing imports for `addBusStop`/`addMetroStation`/`makeBaseState`; add them if missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/ui/actions.test.ts -t "resolveNodeAtTile"`
Expected: FAIL — `resolveNodeAtTile` is not exported.

- [ ] **Step 3: Implement `resolveNodeAtTile`**

In `src/ui/actions.ts`, add types to the existing `import type { GameState, Point, Stop } from "../domain/types";` so it reads `import type { GameState, Point, Station, Stop } from "../domain/types";`. Then add:

```ts
export type ResolvedNode =
  | { kind: "stop"; node: Stop }
  | { kind: "station"; node: Station };

function resolveStationAtTile(
  state: GameState,
  point: Point,
): Station | undefined {
  const exactStation = state.transit.stations.find((candidate) =>
    samePoint(candidate.position, point),
  );
  if (exactStation !== undefined) {
    return exactStation;
  }

  const building = state.buildings.find(
    (candidate) =>
      candidate.type === "metroStation" &&
      candidate.transitNodeId !== undefined &&
      candidate.occupiedTiles.some((tile) => samePoint(tile, point)),
  );

  return building?.transitNodeId === undefined
    ? undefined
    : state.transit.stations.find(
        (station) => station.id === building.transitNodeId,
      );
}

export function resolveNodeAtTile(
  state: GameState,
  point: Point,
): ResolvedNode | null {
  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined) {
    return { kind: "stop", node: stop };
  }

  const station = resolveStationAtTile(state, point);
  if (station !== undefined) {
    return { kind: "station", node: station };
  }

  return null;
}
```

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `bunx vitest run tests/ui/actions.test.ts -t "resolveNodeAtTile"`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for removal cleanup**

Add to `tests/ui/actions.test.ts`:

```ts
import { handleTileClick } from "../../src/ui/actions";

describe("removal strips routes from surviving platforms", () => {
  it("removes a deleted route's id from a shared terminal's platforms", () => {
    let state = makeBaseState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 2, y: 2 }, "busTerminal"); // survives
    state = addBusStop(state, { x: 6, y: 2 }); // will be removed
    const [terminalId] = state.transit.stops.map((s) => s.id);
    const stopIds = state.transit.stops.map((s) => s.id);
    state = addBusRoute(state, stopIds);
    const routeId = state.transit.routes.at(-1)!.id;

    // Remove the second stop via the remove tool.
    const ui = { ...makeBaseUi(), activeTool: "remove" as const };
    const result = handleTileClick(state, ui, { x: 6, y: 2 });

    const terminal = result.state.transit.stops.find((s) => s.id === terminalId)!;
    const stillHolding = terminal.platforms.some((p) =>
      p.routeIds.includes(routeId),
    );
    expect(result.state.transit.routes).toHaveLength(0); // route deleted
    expect(stillHolding).toBe(false); // and scrubbed from the surviving terminal
  });
});
```

Use the test file's existing UI fixture helper (named `makeBaseUi` here; if the file uses `createUiState()` from `../../src/ui/uiState`, use that instead and spread `activeTool: "remove"`).

- [ ] **Step 6: Run the cleanup test to verify it fails**

Run: `bunx vitest run tests/ui/actions.test.ts -t "removal strips"`
Expected: FAIL — the route id remains on the terminal's platform.

- [ ] **Step 7: Implement removal cleanup in `removeAtTile`**

In `src/ui/actions.ts`, inside `removeAtTile`, after `removedRouteIds` and `removedMetroLineIds` are computed and before the final `return`, build a scrubbing helper and apply it to the surviving stops/stations. Add this helper function at module scope (above `removeAtTile`):

```ts
function stripRoutesFromPlatforms<
  T extends { platforms: { routeIds: string[] }[] },
>(nodes: T[], removedIds: Set<string>): T[] {
  if (removedIds.size === 0) {
    return nodes;
  }

  return nodes.map((node) => ({
    ...node,
    platforms: node.platforms.map((platform) => {
      const filtered = platform.routeIds.filter((id) => !removedIds.has(id));
      return filtered.length === platform.routeIds.length
        ? platform
        : { ...platform, routeIds: filtered };
    }),
  }));
}
```

Then in the returned object of `removeAtTile`, wrap the already-filtered `stops`/`stations` with the scrub (routes removed from bus stops, metro lines removed from stations):

```ts
      stops: stripRoutesFromPlatforms(
        state.transit.stops.filter((stop) => !removedStopIds.has(stop.id)),
        removedRouteIds,
      ),
      stations: stripRoutesFromPlatforms(
        state.transit.stations.filter(
          (station) => !removedStationIds.has(station.id),
        ),
        removedMetroLineIds,
      ),
```

- [ ] **Step 8: Run the cleanup test to verify it passes**

Run: `bunx vitest run tests/ui/actions.test.ts -t "removal strips"`
Expected: PASS.

- [ ] **Step 9: Run the full actions suite**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ui/actions.ts tests/ui/actions.test.ts
git commit -m "feat: resolveNodeAtTile and scrub removed routes from platforms"
```

---

## Task 4: Enforce the cap at boarding (on-platform gate)

`tickVehicles` computes the on-platform snapshot once per tick; `citizenCanBoard` requires membership.

**Files:**
- Modify: `src/simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/simulation/transit.test.ts`. This builds a stop with a capacity-1 platform, two waiting citizens for the same line, and one bus at the stop; only the lower-patience citizen should board.

```ts
import { tickVehicles } from "../../src/simulation/transit";
import type { Citizen, Stop, Vehicle } from "../../src/domain/types";

describe("on-platform boarding gate", () => {
  it("boards only the on-platform citizen when capacity is 1", () => {
    const stopA: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 0, y: 0 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };
    const stopB: Stop = {
      id: "stop-002",
      kind: "busStop",
      position: { x: 4, y: 0 },
      platforms: [
        { id: "stop-002-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      id,
      home: { x: 0, y: 0 },
      destination: { x: 4, y: 0 },
      position: { x: 0, y: 0 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 0, y: 0 },
            to: { x: 4, y: 0 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const vehicle: Vehicle = {
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    };

    const state = {
      ...makeBaseState(),
      transit: {
        stops: [stopA, stopB],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#000",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001"],
            active: true,
          },
        ],
        metroLines: [],
        vehicles: [vehicle],
      },
      citizens: [mkWaiter("c-high", 100), mkWaiter("c-low", 10)],
    };

    const next = tickVehicles(state, 0.1);
    const boarded = next.transit.vehicles[0].passengerIds;
    expect(boarded).toEqual(["c-low"]); // lower patience is on-platform
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "on-platform boarding gate"`
Expected: FAIL — both citizens board (no cap enforced), so `boarded` contains `c-high` too.

- [ ] **Step 3: Implement the gate**

In `src/simulation/transit.ts`, import the snapshot helper:

```ts
import { onPlatformCitizenIds } from "./platforms";
```

Change `citizenCanBoard` to accept and check the on-platform set:

```ts
function citizenCanBoard(
  citizen: Citizen,
  vehicle: Vehicle,
  currentPosition: Point,
  occupiedPassengerIds: Set<string>,
  onPlatform: Set<string>,
): boolean {
  if (
    citizen.status !== "waiting" ||
    occupiedPassengerIds.has(citizen.id) ||
    !onPlatform.has(citizen.id)
  ) {
    return false;
  }

  const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
  return (
    leg !== undefined &&
    leg.mode === vehicle.mode &&
    leg.lineId === vehicle.lineId &&
    samePoint(citizen.position, currentPosition)
  );
}
```

Thread the set through `boardVehicle`: add an `onPlatform: Set<string>` parameter and pass it into the `citizenCanBoard(...)` call inside the boarding loop:

```ts
function boardVehicle(
  citizens: Citizen[],
  vehicle: Vehicle,
  currentPosition: Point,
  occupiedPassengerIds: Set<string>,
  onPlatform: Set<string>,
): { citizens: Citizen[]; vehicle: Vehicle } {
  // ...unchanged until the loop...
    if (
      citizenCanBoard(
        citizen,
        vehicle,
        currentPosition,
        occupiedPassengerIds,
        onPlatform,
      )
    ) {
      boardingCitizenIds.push(citizen.id);
      occupiedPassengerIds.add(citizen.id);
    }
  // ...unchanged after...
}
```

In `tickVehicles`, compute the snapshot once at the top (right after `let citizens = state.citizens;`) and pass it into `boardVehicle`:

```ts
  const onPlatform = onPlatformCitizenIds(state);
```

and update the boarding call:

```ts
    const boarded =
      vehicle.progress === 0
        ? boardVehicle(
            citizens,
            vehicle,
            currentPosition,
            occupiedPassengerIds,
            onPlatform,
          )
        : { citizens, vehicle };
```

- [ ] **Step 4: Run the gate test to verify it passes**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "on-platform boarding gate"`
Expected: PASS.

- [ ] **Step 5: Run the full simulation suite for regressions**

Run: `bunx vitest run --project simulation`
Expected: PASS. (If any pre-existing boarding test now fails because its fixture platform has `routeIds` that don't include the boarding line, update that fixture's stop/station `platforms` so the boarding route id is present on a platform with sufficient `capacity` — the route must be assigned to a platform for its riders to be on-platform.)

- [ ] **Step 6: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: enforce platform waiting cap at boarding"
```

---

## Task 5: `assignRouteToPlatform` reassignment helper

A pure helper to move a route between platforms on a node.

**Files:**
- Modify: `src/simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/simulation/transit.test.ts`:

```ts
import { assignRouteToPlatform } from "../../src/simulation/transit";

describe("assignRouteToPlatform", () => {
  function terminalState() {
    let state = { ...makeBaseState(), budget: 1_000_000 };
    state = addBusStop(state, { x: 2, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 6, y: 2 });
    state = addBusRoute(state, state.transit.stops.map((s) => s.id));
    return state;
  }

  it("moves a route from its current platform to the target", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;
    const fromPlatform = terminal.platforms.find((p) =>
      p.routeIds.includes(routeId),
    )!;
    const target = terminal.platforms.find((p) => p.id !== fromPlatform.id)!;

    const next = assignRouteToPlatform(state, terminal.id, routeId, target.id);
    const movedTerminal = next.transit.stops.find((s) => s.id === terminal.id)!;
    expect(
      movedTerminal.platforms.find((p) => p.id === fromPlatform.id)!.routeIds,
    ).not.toContain(routeId);
    expect(
      movedTerminal.platforms.find((p) => p.id === target.id)!.routeIds,
    ).toContain(routeId);
  });

  it("is a no-op when the platform does not belong to the node", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;
    const next = assignRouteToPlatform(
      state,
      terminal.id,
      routeId,
      "nonexistent-platform",
    );
    expect(next).toBe(state);
  });

  it("is a no-op when the route does not serve the node", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const target = terminal.platforms[1].id;
    const next = assignRouteToPlatform(state, terminal.id, "route-999", target);
    expect(next).toBe(state);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "assignRouteToPlatform"`
Expected: FAIL — `assignRouteToPlatform` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/simulation/transit.ts`:

```ts
function reassignWithinNode<
  T extends { id: string; platforms: Platform[] },
>(nodes: T[], nodeId: string, routeId: string, platformId: string): T[] | null {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return null;
  }

  const target = node.platforms.find((platform) => platform.id === platformId);
  const holdsRoute = node.platforms.some((platform) =>
    platform.routeIds.includes(routeId),
  );
  if (target === undefined || !holdsRoute || target.routeIds.includes(routeId)) {
    return null;
  }

  return nodes.map((candidate) =>
    candidate.id !== nodeId
      ? candidate
      : {
          ...candidate,
          platforms: candidate.platforms.map((platform) => {
            if (platform.id === platformId) {
              return { ...platform, routeIds: [...platform.routeIds, routeId] };
            }
            return platform.routeIds.includes(routeId)
              ? {
                  ...platform,
                  routeIds: platform.routeIds.filter((id) => id !== routeId),
                }
              : platform;
          }),
        },
  );
}

export function assignRouteToPlatform(
  state: GameState,
  nodeId: string,
  routeId: string,
  platformId: string,
): GameState {
  const stops = reassignWithinNode(
    state.transit.stops,
    nodeId,
    routeId,
    platformId,
  );
  if (stops !== null) {
    return { ...state, transit: { ...state.transit, stops } };
  }

  const stations = reassignWithinNode(
    state.transit.stations,
    nodeId,
    routeId,
    platformId,
  );
  if (stations !== null) {
    return { ...state, transit: { ...state.transit, stations } };
  }

  return state;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "assignRouteToPlatform"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: add assignRouteToPlatform reassignment helper"
```

---

## Task 6: Inspector view-model in the selector

`selectShellState` produces an `inspector` block when the selected tile resolves to a transit node.

**Files:**
- Modify: `src/runtime/types.ts`, `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts` (create if absent)

- [ ] **Step 1: Add the view-model types**

In `src/runtime/types.ts`, add above `ShellState`:

```ts
export interface ShellPlatformMoveTarget {
  platformId: string;
  label: string;
}

export interface ShellPlatformRoute {
  id: string;
  name: string;
  color: string;
  moveTargets: ShellPlatformMoveTarget[];
}

export interface ShellPlatform {
  id: string;
  label: string;
  occupancy: number;
  capacity: number;
  routes: ShellPlatformRoute[];
}

export interface ShellInspectorState {
  nodeId: string;
  nodeLabel: string;
  canReassign: boolean;
  platforms: ShellPlatform[];
}
```

Add `inspector` to `ShellState`:

```ts
export interface ShellState {
  topbar: ShellTopbarState;
  controlTower: ShellControlTowerState;
  inspector: ShellInspectorState | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/runtime/runtimeSelectors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addBusRoute,
  addBusStop,
} from "../../src/simulation/transit";
import { createInitialGameState } from "../../src/simulation/gameState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import { createUiState } from "../../src/ui/uiState";

describe("selectShellState inspector", () => {
  it("emits an inspector block for a selected terminal with route chips", () => {
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = addBusStop(state, { x: 2, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 6, y: 2 });
    state = addBusRoute(state, state.transit.stops.map((s) => s.id));
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;

    const ui = { ...createUiState(), activeTool: "inspect" as const, selectedId: "2,2" };
    const shell = selectShellState(state, ui);

    expect(shell.inspector).not.toBeNull();
    expect(shell.inspector!.nodeId).toBe(terminal.id);
    expect(shell.inspector!.canReassign).toBe(true);
    const routeIds = shell.inspector!.platforms.flatMap((p) =>
      p.routes.map((r) => r.id),
    );
    expect(routeIds).toContain(routeId);
    // The route on platform A can move to B and C.
    const routeChip = shell.inspector!.platforms
      .flatMap((p) => p.routes)
      .find((r) => r.id === routeId)!;
    expect(routeChip.moveTargets.map((t) => t.label).sort()).toEqual(["B", "C"]);
  });

  it("emits null inspector for an empty tile", () => {
    const state = createInitialGameState();
    const ui = { ...createUiState(), selectedId: "0,0" };
    expect(selectShellState(state, ui).inspector).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts`
Expected: FAIL — `inspector` is missing from the returned shell.

- [ ] **Step 4: Implement the inspector builder**

In `src/runtime/runtimeSelectors.ts`, add imports:

```ts
import { resolveNodeAtTile } from "../ui/actions";
import { selectPlatformOccupancy } from "../simulation/platforms";
import type {
  ShellInspectorState,
  ShellPlatform,
  ShellState,
} from "./types";
```

(Merge `ShellState` into the existing `import type { ShellState } from "./types";` if it is already imported — keep a single import line.)

Add helpers and a builder above `selectShellState`:

```ts
function parseSelectedPoint(selectedId: string | null): {
  x: number;
  y: number;
} | null {
  if (selectedId === null) {
    return null;
  }
  const match = /^(-?\d+),(-?\d+)$/.exec(selectedId);
  return match === null
    ? null
    : { x: Number(match[1]), y: Number(match[2]) };
}

function nodeLabel(state: GameState, nodeId: string): string {
  const stop = state.transit.stops.find((candidate) => candidate.id === nodeId);
  if (stop !== undefined) {
    return stop.kind === "busTerminal" ? "Bus Terminal" : "Bus Stop";
  }
  return "Metro Station";
}

function routeNameAndColor(
  state: GameState,
  routeId: string,
): { name: string; color: string } {
  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    return { name: route.name, color: route.color };
  }
  const line = state.transit.metroLines.find((l) => l.id === routeId);
  return line !== undefined
    ? { name: line.name, color: line.color }
    : { name: routeId, color: "#888888" };
}

function buildInspector(
  state: GameState,
  ui: UiState,
): ShellInspectorState | null {
  const point = parseSelectedPoint(ui.selectedId);
  if (point === null) {
    return null;
  }

  const resolved = resolveNodeAtTile(state, point);
  if (resolved === null) {
    return null;
  }

  const node = resolved.node;
  const occupancy = selectPlatformOccupancy(state);

  const platforms: ShellPlatform[] = node.platforms.map((platform) => ({
    id: platform.id,
    label: platform.label,
    occupancy: occupancy.get(platform.id)?.count ?? 0,
    capacity: platform.capacity,
    routes: platform.routeIds.map((routeId) => {
      const { name, color } = routeNameAndColor(state, routeId);
      return {
        id: routeId,
        name,
        color,
        moveTargets: node.platforms
          .filter((other) => other.id !== platform.id)
          .map((other) => ({ platformId: other.id, label: other.label })),
      };
    }),
  }));

  return {
    nodeId: node.id,
    nodeLabel: nodeLabel(state, node.id),
    canReassign: node.platforms.length > 1,
    platforms,
  };
}
```

In `selectShellState`, add `inspector: buildInspector(state, ui),` to the returned object (alongside `topbar` and `controlTower`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full check to catch any `ShellState` consumers**

Run: `bun run check`
Expected: PASS. (`inspector` is required on `ShellState`; the only constructor is `selectShellState`, so no other call sites need updating.)

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime/runtimeSelectors.test.ts
git commit -m "feat: build platform inspector view-model in selector"
```

---

## Task 7: Runtime controller method `assignRouteToPlatform`

Expose the reassignment through the runtime so the UI can call it.

**Files:**
- Modify: `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`
- Test: `tests/runtime/createGameRuntime.test.ts` (add a case; create if absent)

- [ ] **Step 1: Add the method to `RuntimeController`**

In `src/runtime/types.ts`, add to the `RuntimeController` interface (after `handleTileClick`):

```ts
  assignRouteToPlatform: (
    nodeId: string,
    routeId: string,
    platformId: string,
  ) => RuntimeSnapshot;
```

- [ ] **Step 2: Write the failing test**

Create or append to `tests/runtime/createGameRuntime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";

describe("runtime assignRouteToPlatform", () => {
  it("moves a route between platforms and publishes a new snapshot", () => {
    const runtime = createGameRuntime();
    // Reach into the controller surface to build state deterministically:
    // place a terminal + stop and a route via tile clicks would require pixels,
    // so assert the method exists and is a no-op-safe call on empty state.
    const before = runtime.getSnapshot();
    const after = runtime.assignRouteToPlatform("stop-001", "route-001", "stop-001-p1");
    expect(after.state).toBe(before.state); // no such node -> unchanged state
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run tests/runtime/createGameRuntime.test.ts -t "assignRouteToPlatform"`
Expected: FAIL — `runtime.assignRouteToPlatform` is not a function.

- [ ] **Step 4: Implement the controller method**

In `src/runtime/createGameRuntime.ts`, add the import:

```ts
import { assignRouteToPlatform as applyAssignRouteToPlatform } from "../simulation/transit";
```

Add the method inside the `api: RuntimeController` object (after `handleTileClick`):

```ts
    assignRouteToPlatform(nodeId, routeId, platformId) {
      return commit(
        applyAssignRouteToPlatform(state, nodeId, routeId, platformId),
        ui,
      );
    },
```

- [ ] **Step 5: Update the runtime mock in `tests/ui/appShell.test.ts`**

`assignRouteToPlatform` is now a required member of `RuntimeController`, so the full mock controller in `tests/ui/appShell.test.ts` no longer type-checks. Add this method to the harness's returned controller (next to the other `vi.fn()` methods such as `resetUi`):

```ts
    assignRouteToPlatform: vi.fn(() => getSnapshot()),
```

- [ ] **Step 6: Run the tests and type-check to verify green**

Run: `bunx vitest run tests/runtime/createGameRuntime.test.ts -t "assignRouteToPlatform" && bun run check`
Expected: PASS — both the new test and the type-check (mock now satisfies the interface).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime/createGameRuntime.test.ts tests/ui/appShell.test.ts
git commit -m "feat: expose assignRouteToPlatform on the runtime controller"
```

---

## Task 8: Control Tower platform panel + App wiring

Render the inspector panel and wire the move action through Svelte.

**Files:**
- Modify: `src/components/ControlTower.svelte`, `src/App.svelte`
- Test: `tests/ui/controlTower.test.ts` (create; jsdom project)

- [ ] **Step 1: Write the failing component test**

Create `tests/ui/controlTower.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import ControlTower from "../../src/components/ControlTower.svelte";
import type {
  ShellControlTowerState,
  ShellInspectorState,
} from "../../src/runtime/types";

const baseShell: ShellControlTowerState = {
  title: "Scenario",
  status: "RUNNING",
  objective: "obj",
  lossNote: "note",
  nextGrowth: "wave",
  selectedId: "2,2",
  activeTool: "INSPECT",
  controlTowerOpen: true,
};

const inspector: ShellInspectorState = {
  nodeId: "stop-001",
  nodeLabel: "Bus Terminal",
  canReassign: true,
  platforms: [
    {
      id: "stop-001-p0",
      label: "A",
      occupancy: 3,
      capacity: 50,
      routes: [
        {
          id: "route-001",
          name: "Bus 1",
          color: "#e04f39",
          moveTargets: [{ platformId: "stop-001-p1", label: "B" }],
        },
      ],
    },
    { id: "stop-001-p1", label: "B", occupancy: 0, capacity: 50, routes: [] },
  ],
};

function props(overrides = {}) {
  return {
    shell: baseShell,
    inspector,
    activeTool: "inspect" as const,
    activeOverlay: null,
    selectedBuilding: null,
    buildingRotation: 0 as const,
    onToggleControlTower: vi.fn(),
    onSetTool: vi.fn(),
    onSetBuilding: vi.fn(),
    onRotateBuilding: vi.fn(),
    onSetOverlay: vi.fn(),
    onAssignRouteToPlatform: vi.fn(),
    ...overrides,
  };
}

describe("ControlTower platform panel", () => {
  it("renders platforms with occupancy and a move button", () => {
    const { getByText, getByTestId } = render(ControlTower, props());
    expect(getByText("Bus Terminal")).toBeTruthy();
    expect(getByText("3/50")).toBeTruthy();
    expect(getByTestId("move-route-001-stop-001-p1")).toBeTruthy();
  });

  it("calls onAssignRouteToPlatform when a move button is clicked", async () => {
    const onAssignRouteToPlatform = vi.fn();
    const { getByTestId } = render(
      ControlTower,
      props({ onAssignRouteToPlatform }),
    );
    await fireEvent.click(getByTestId("move-route-001-stop-001-p1"));
    expect(onAssignRouteToPlatform).toHaveBeenCalledWith(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/ui/controlTower.test.ts`
Expected: FAIL — `ControlTower` does not accept `inspector`/`onAssignRouteToPlatform` and renders no panel.

- [ ] **Step 3: Extend `ControlTower.svelte` props and render the panel**

In `src/components/ControlTower.svelte`, update the import of runtime types and `Props`:

```ts
  import type {
    ShellControlTowerState,
    ShellInspectorState,
  } from "../runtime/types";
```

Add to the `Props` interface:

```ts
    inspector: ShellInspectorState | null;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
```

Add `inspector` and `onAssignRouteToPlatform` to the destructured `$props()` block.

Then add a new section to the markup, immediately before the closing `</aside>`:

```svelte
  {#if inspector !== null}
    <section class="panel-section platform-panel" data-testid="platform-panel">
      <h3 class="section-head"><span class="num">06</span> Platforms</h3>
      <p class="brief-id">{inspector.nodeLabel}</p>
      {#each inspector.platforms as platform (platform.id)}
        <div class="platform-row">
          <div class="platform-head">
            <span class="platform-label">Platform {platform.label}</span>
            <span class="platform-occupancy"
              >{platform.occupancy}/{platform.capacity}</span
            >
          </div>
          {#if platform.routes.length === 0}
            <p class="platform-empty">No routes</p>
          {:else}
            <ul class="platform-routes">
              {#each platform.routes as route (route.id)}
                <li class="platform-route">
                  <span
                    class="route-chip"
                    style={`--route-color: ${route.color}`}>{route.name}</span
                  >
                  {#if inspector.canReassign}
                    {#each route.moveTargets as target (target.platformId)}
                      <button
                        type="button"
                        class="move-route"
                        data-testid={`move-${route.id}-${target.platformId}`}
                        onclick={() =>
                          onAssignRouteToPlatform(
                            inspector.nodeId,
                            route.id,
                            target.platformId,
                          )}
                      >
                        → {target.label}
                      </button>
                    {/each}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </section>
  {/if}
```

- [ ] **Step 4: Wire the props in `App.svelte`**

In `src/App.svelte`, add a handler near the other handlers:

```ts
  function handleAssignRouteToPlatform(
    nodeId: string,
    routeId: string,
    platformId: string,
  ): void {
    setSnapshot(runtime.assignRouteToPlatform(nodeId, routeId, platformId));
  }
```

Pass the new props to `<ControlTower ... />`:

```svelte
        inspector={snapshot.shell.inspector}
        onAssignRouteToPlatform={handleAssignRouteToPlatform}
```

(The `tests/ui/appShell.test.ts` runtime mock already gained `assignRouteToPlatform` in Task 7, so no further mock change is needed here.)

- [ ] **Step 5: Run the component test to verify it passes**

Run: `bunx vitest run tests/ui/controlTower.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full check + UI project**

Run: `bun run check && bunx vitest run --project ui`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ControlTower.svelte src/App.svelte tests/ui/controlTower.test.ts
git commit -m "feat: Control Tower platform panel with route reassignment"
```

---

## Task 9: Crowding overlay render test + full verification

Lock in the overlay behavior and run the whole gate.

**Files:**
- Test: `tests/render/overlayRenderer.test.ts` (create if absent)

- [ ] **Step 1: Write the failing render test**

Create `tests/render/overlayRenderer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { renderOverlays } from "../../src/render/overlayRenderer";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";
import type { Citizen, Stop } from "../../src/domain/types";

function fakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe("crowding overlay", () => {
  it("fills a node tile when a platform is at capacity", () => {
    const stop: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 3, y: 3 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };
    const waiter: Citizen = {
      id: "c1",
      home: { x: 3, y: 3 },
      destination: { x: 9, y: 9 },
      position: { x: 3, y: 3 },
      status: "waiting",
      patienceRemaining: 100,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 3, y: 3 },
            to: { x: 9, y: 9 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    };

    const state = {
      ...createInitialGameState(),
      transit: {
        stops: [stop],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
      citizens: [waiter],
    };
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };

    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);
    expect((ctx.fillRect as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
```

Note: confirm the exported function name in `src/render/overlayRenderer.ts`. If it is not `renderOverlays`, use the actual exported overlay entry-point name (check the file's `export function` line and the import in `src/render/canvas.ts`).

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `bunx vitest run tests/render/overlayRenderer.test.ts`
Expected: PASS if the overlay export name is correct (the crowding rewrite from Task 1 already provides the behavior). If it FAILS to import, fix the import name per the note, then re-run. This test guards the Task 1 rewrite against regressions.

- [ ] **Step 3: Run the entire gate**

Run: `bun run check && bun run lint && bun run test`
Expected: All pass. If `lint` flags an unused variable, prefix it with `_`.

- [ ] **Step 4: Commit**

```bash
git add tests/render/overlayRenderer.test.ts
git commit -m "test: crowding overlay lights nodes with full platforms"
```

---

## Self-Review Notes (resolved during planning)

- **Spec coverage:** data model (T1), per-mode capacity + counts (T1), auto-assign (T2), removal cleanup (T3), on-platform overflow gate (T4), reassignment helper (T5), inspector selector (T6), controller method (T7), Inspect panel UI (T8), crowding overlay (T1 impl + T9 test), router unchanged (no task — intentional), determinism (T1/T4 ordering by `patienceRemaining` then `id`), fixture migration (T1 Step 12). All spec sections map to a task.
- **Type consistency:** `Platform` fields (`id`, `label`, `capacity`, `routeIds`) are identical across T1, T5, T6, T8. `assignRouteToPlatform(state, nodeId, routeId, platformId)` signature is identical in T5 (pure), T7 (controller), and T8 (UI handler order: nodeId, routeId, platformId). `selectPlatformOccupancy` returns `Map<string, {count, capacity}>` in T1 and is consumed the same way in T6 and the overlay.
- **Determinism:** no `Math.random`/wall-clock introduced; all ordering uses `patienceRemaining` then `id.localeCompare`.
- **Risk:** Task 4 Step 5 and Task 1 Step 12 may surface pre-existing fixtures whose stops/stations now need `platforms` containing the boarding route id; instructions cover updating them.
```text
