# Area Zoning And Building Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build player-painted areas, area-gated buildings, a destination-building catalog, and a mostly empty starter scenario with a small prebuilt two-lane arterial cross.

**Architecture:** Add an explicit `AreaKind` field to map tiles and keep roads/tracks as infrastructure. Area painting follows the existing runtime-owned drag lifecycle but uses rectangle geometry; building placement reuses the existing selected-building path with area-aware validation. Scenario and tests stop relying on prebuilt district tiles and instead create roads/areas in local fixtures when needed.

**Tech Stack:** TypeScript, Svelte 5 runes, Vite, Vitest projects (`ui`, `runtime`, `simulation`), Playwright e2e, Bun.

---

## File Structure

- `src/domain/types.ts`
  - Add `AreaKind`.
  - Add `area?: AreaKind` to `Tile`.
  - Extend `BuildingType`.
  - Add `"area"` to `Tool`.
- `src/simulation/areas.ts`
  - Own area constants, labels, rectangle geometry, paint preview planning, validity checks, and immutable area-paint commits.
- `src/simulation/map.ts`
  - Keep infrastructure placement helpers area-aware without making areas a second map kind.
- `src/scenario/growingSuburb.ts`
  - Replace prebuilt districts and road grid with an empty map plus a starter arterial cross.
  - Remove starting citizens and growth waves for this pass.
- `src/simulation/buildings.ts`
  - Add area-gated catalog entries.
  - Add deterministic destination-building selection.
  - Retain transit buildings as infrastructure entries.
- `src/ui/uiState.ts`
  - Add `selectedArea`.
  - Extend drag gestures with an area drag variant.
- `src/runtime/createGameRuntime.ts`
  - Add `setArea`.
  - Start and commit area drags.
- `src/runtime/types.ts`
  - Expose `setArea`.
- `src/runtime/runtimeSelectors.ts`
  - Format `AREA RESIDENTIAL` active-tool labels and cancel state.
- `src/components/hud/panels/BuildPanel.svelte`
  - Add Area buttons and catalog building buttons.
- `src/components/hud/HudDrawer.svelte`, `src/App.svelte`
  - Thread `selectedArea` and `onSetArea`.
- `src/render/colors.ts`, `src/render/mapRenderer.ts`, `src/render/overlayRenderer.ts`, `src/render/cursorBadge.ts`, `src/render/buildingRenderer.ts`
  - Render area colors, area drag previews, area cursor badges, and new building colors.
- `tests/helpers/mapFixtures.ts`
  - Shared test helpers for road, track, and area fixtures.
- Existing tests under `tests/simulation`, `tests/runtime`, `tests/render`, `tests/ui`, and `tests/e2e`
  - Migrate assumptions from seeded districts/roads to explicit fixtures.

---

### Task 1: Area Domain And Paint Helper

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/simulation/areas.ts`
- Modify: `src/simulation/map.ts`
- Test: `tests/simulation/areas.test.ts`

- [ ] **Step 1: Write the failing area helper tests**

Create `tests/simulation/areas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GameState, Point } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  AREA_KINDS,
  isAreaPaintable,
  paintAreaRectangle,
  planAreaPaintPreview,
  rectanglePoints,
} from "../../src/simulation/areas";

function withRoad(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((point) => `${point.x},${point.y}`));
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

function withTrack(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((point) => `${point.x},${point.y}`));
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

function areaAt(state: GameState, x: number, y: number) {
  return state.map.tiles.find((tile) => tile.x === x && tile.y === y)?.area;
}

describe("area painting", () => {
  it("defines the player-facing area types in HUD order", () => {
    expect(AREA_KINDS).toEqual([
      "residential",
      "commercial",
      "industrial",
      "office",
      "civic",
      "park",
    ]);
  });

  it("returns inclusive rectangle points in row-major order", () => {
    expect(rectanglePoints({ x: 3, y: 2 }, { x: 1, y: 4 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
  });

  it("paints valid empty tiles and skips roads and tracks", () => {
    let state = createInitialGameState();
    state = withRoad(state, [{ x: 2, y: 1 }]);
    state = withTrack(state, [{ x: 3, y: 1 }]);

    const next = paintAreaRectangle(
      state,
      "residential",
      { x: 1, y: 1 },
      { x: 3, y: 2 },
    );

    expect(areaAt(next, 1, 1)).toBe("residential");
    expect(areaAt(next, 2, 1)).toBeUndefined();
    expect(areaAt(next, 3, 1)).toBeUndefined();
    expect(areaAt(next, 1, 2)).toBe("residential");
    expect(next).not.toBe(state);
  });

  it("returns the same state reference when nothing can be painted", () => {
    const state = withRoad(createInitialGameState(), [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);

    expect(
      paintAreaRectangle(state, "commercial", { x: 1, y: 1 }, { x: 2, y: 1 }),
    ).toBe(state);
  });

  it("plans per-tile preview validity for the rectangle", () => {
    const state = withRoad(createInitialGameState(), [{ x: 2, y: 1 }]);

    expect(
      planAreaPaintPreview(state, "office", { x: 1, y: 1 }, { x: 2, y: 1 }),
    ).toEqual([
      { point: { x: 1, y: 1 }, paintable: true },
      { point: { x: 2, y: 1 }, paintable: false },
    ]);
  });

  it("rejects off-map points", () => {
    expect(isAreaPaintable(createInitialGameState(), { x: -1, y: 0 })).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the area helper tests and verify they fail**

Run:

```sh
bunx vitest run tests/simulation/areas.test.ts --project simulation
```

Expected: FAIL because `src/simulation/areas.ts` and `Tile.area` do not exist.

- [ ] **Step 3: Add the area domain types**

In `src/domain/types.ts`, add:

```ts
export type AreaKind =
  | "residential"
  | "commercial"
  | "industrial"
  | "office"
  | "civic"
  | "park";
```

Change `Tile` to include an optional area:

```ts
export interface Tile extends Point {
  id: string;
  kind: TileKind;
  districtId?: string;
  area?: AreaKind;
  /** Track is a layer, not a TileKind: a road tile with track is a level crossing. */
  hasTrack?: boolean;
  /** One-way constraint on a road lane. Undefined = two-way (default). */
  oneWay?: RoadDirection;
}
```

Keep legacy `TileKind` values for this task so existing code still compiles. The scenario migration later stops producing `residential`, `jobs`, `civic`, and `park` tile kinds.

- [ ] **Step 4: Implement `src/simulation/areas.ts`**

Create `src/simulation/areas.ts`:

```ts
import type { AreaKind, GameState, Point } from "../domain/types";
import { getTile } from "./map";

export const AREA_KINDS = [
  "residential",
  "commercial",
  "industrial",
  "office",
  "civic",
  "park",
] as const satisfies AreaKind[];

export const AREA_LABELS: Record<AreaKind, string> = {
  residential: "Residential",
  commercial: "Commercial",
  industrial: "Industrial",
  office: "Office",
  civic: "Civic",
  park: "Park",
};

export interface AreaPreviewTile {
  point: Point;
  paintable: boolean;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

export function rectanglePoints(start: Point, end: Point): Point[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const points: Point[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      points.push({ x, y });
    }
  }

  return points;
}

export function isAreaPaintable(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function planAreaPaintPreview(
  state: GameState,
  area: AreaKind,
  start: Point,
  end: Point,
): AreaPreviewTile[] {
  void area;
  return rectanglePoints(start, end).map((point) => ({
    point,
    paintable: isAreaPaintable(state, point),
  }));
}

export function paintAreaRectangle(
  state: GameState,
  area: AreaKind,
  start: Point,
  end: Point,
): GameState {
  const paintableKeys = new Set(
    rectanglePoints(start, end)
      .filter((point) => isAreaPaintable(state, point))
      .map((point) => `${point.x},${point.y}`),
  );

  if (paintableKeys.size === 0) {
    return state;
  }

  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        paintableKeys.has(`${tile.x},${tile.y}`) ? { ...tile, area } : tile,
      ),
    },
  };
}
```

- [ ] **Step 5: Preserve area state when infrastructure changes**

In `src/simulation/map.ts`, keep `setTileKind` from deleting `area`. The relevant body should be:

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
      const { oneWay: _oneWay, ...rest } = tile;
      return { ...rest, kind };
    }),
  };
}
```

- [ ] **Step 6: Run the focused tests**

Run:

```sh
bunx vitest run tests/simulation/areas.test.ts --project simulation
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/domain/types.ts src/simulation/areas.ts src/simulation/map.ts tests/simulation/areas.test.ts
git commit -m "feat(simulation): add area painting model"
```

---

### Task 2: Empty Scenario And Starter Arterial Cross

**Files:**
- Modify: `src/scenario/growingSuburb.ts`
- Modify: `tests/simulation/scenario.test.ts`
- Modify: `tests/simulation/map.test.ts`
- Test: `tests/simulation/scenario.test.ts`
- Test: `tests/simulation/map.test.ts`

- [ ] **Step 1: Update scenario tests for the new starting map**

In `tests/simulation/scenario.test.ts`, update the initial-map test to assert no areas and the exact arterial cross:

```ts
it("starts mostly empty with only a two-lane arterial cross", () => {
  const map = createGrowingSuburbMap();
  const roadTiles = map.tiles.filter((tile) => tile.kind === "road");

  expect(map.tiles.filter((tile) => tile.area !== undefined)).toEqual([]);
  expect(roadTiles).toHaveLength(88);

  for (let x = 0; x < MAP_WIDTH; x += 1) {
    expect(tileAt(x, 8)?.kind).toBe("road");
    expect(tileAt(x, 9)?.kind).toBe("road");
  }

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    expect(tileAt(14, y)?.kind).toBe("road");
    expect(tileAt(15, y)?.kind).toBe("road");
  }

  expect(tileAt(7, 8)?.oneWay).toBe("west");
  expect(tileAt(7, 9)?.oneWay).toBe("east");
  expect(tileAt(14, 3)?.oneWay).toBe("south");
  expect(tileAt(15, 3)?.oneWay).toBe("north");
  expect(tileAt(14, 8)?.oneWay).toBeUndefined();
  expect(tileAt(15, 9)?.oneWay).toBeUndefined();
});

it("starts without citizens or growth waves", () => {
  const state = createInitialGameState();

  expect(state.citizens).toEqual([]);
  expect(state.scenario.growthWaves).toEqual([]);
});
```

Replace old assertions that expected `(2,3)` residential, `(10,4)` jobs, `(18,10)` civic, `(4,12)` park, 36 starting citizens, or growth-wave citizen creation.

- [ ] **Step 2: Run the scenario tests and verify they fail**

Run:

```sh
bunx vitest run tests/simulation/scenario.test.ts --project simulation
```

Expected: FAIL because the scenario still seeds old districts, roads, citizens, and growth waves.

- [ ] **Step 3: Implement the starter road helper**

In `src/scenario/growingSuburb.ts`, add `RoadDirection` to the existing type import from `../domain/types`, then replace `kindFor` with a tile factory that encodes the arterial cross:

```ts
function starterRoadDirection(x: number, y: number): RoadDirection | undefined {
  const horizontal = y === 8 || y === 9;
  const vertical = x === 14 || x === 15;

  if (horizontal && vertical) {
    return undefined;
  }
  if (y === 8) return "west";
  if (y === 9) return "east";
  if (x === 14) return "south";
  if (x === 15) return "north";
  return undefined;
}

function isStarterRoad(x: number, y: number): boolean {
  return y === 8 || y === 9 || x === 14 || x === 15;
}

function createTile(x: number, y: number): Tile {
  const oneWay = starterRoadDirection(x, y);
  return {
    id: tileId(x, y),
    x,
    y,
    kind: isStarterRoad(x, y) ? "road" : "empty",
    ...(oneWay === undefined ? {} : { oneWay }),
  };
}
```

Change `createGrowingSuburbMap()` to push `createTile(x, y)`.

- [ ] **Step 4: Remove starting citizens and timed growth for this pass**

In `src/scenario/growingSuburb.ts`, make these functions deterministic empties:

```ts
export function createStartingCitizens(): Citizen[] {
  return [];
}

export function createGrowingSuburbWaves(): GrowthWave[] {
  return [];
}
```

Remove the now-unused `entityId` import. Keep `GrowthWave` imported because the return type still uses it.

- [ ] **Step 5: Update map placement tests that assumed old seeded districts**

In `tests/simulation/map.test.ts`, replace old seeded-district assertions with explicit fixtures. Use this helper in the test file:

```ts
function withArea(
  state: GameState,
  area: AreaKind,
  points: Point[],
): GameState {
  const keys = new Set(points.map((point) => `${point.x},${point.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, area } : tile,
      ),
    },
  };
}
```

Use explicit non-road empty points such as `{ x: 1, y: 1 }`, `{ x: 2, y: 1 }`, and explicit starter road points such as `{ x: 7, y: 8 }`. Do not assert any `kind` equals `"residential"`, `"jobs"`, `"civic"`, or `"park"` in this file.

- [ ] **Step 6: Run the scenario and map tests**

Run:

```sh
bunx vitest run tests/simulation/scenario.test.ts tests/simulation/map.test.ts --project simulation
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/scenario/growingSuburb.ts tests/simulation/scenario.test.ts tests/simulation/map.test.ts
git commit -m "feat(scenario): start from empty zonable map"
```

---

### Task 3: Area-Gated Building Catalog And Destination Buildings

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/simulation/buildings.ts`
- Modify: `src/render/colors.ts`
- Modify: `src/render/buildingRenderer.ts`
- Test: `tests/simulation/buildings.test.ts`

- [ ] **Step 1: Update building tests for area gating and destination buildings**

In `tests/simulation/buildings.test.ts`, add helpers:

```ts
import type { AreaKind } from "../../src/domain/types";

function withArea(
  state: GameState,
  area: AreaKind,
  points: Point[],
): GameState {
  const keys = new Set(points.map((point) => `${point.x},${point.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, area } : tile,
      ),
    },
  };
}
```

Add tests:

```ts
it("defines zoned destination buildings in the catalog", () => {
  expect(BUILDING_CATALOG.supermarket).toMatchObject({
    label: "Supermarket",
    width: 2,
    height: 2,
    allowedArea: "commercial",
    effect: "destination",
  });
  expect(BUILDING_CATALOG.officeTower).toMatchObject({
    label: "Office Tower",
    allowedArea: "office",
    effect: "destination",
  });
  expect(BUILDING_CATALOG.parkPlaza).toMatchObject({
    label: "Park Plaza",
    allowedArea: "park",
    effect: "destination",
  });
});

it("requires matching area for zoned building footprints", () => {
  const base = createInitialGameState();
  const residential = withArea(base, "residential", [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
  const commercial = withArea(base, "commercial", [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);

  expect(canPlaceBuilding(base, "smallHouse", { x: 1, y: 1 }, 0)).toBe(false);
  expect(canPlaceBuilding(commercial, "smallHouse", { x: 1, y: 1 }, 0)).toBe(
    false,
  );
  expect(canPlaceBuilding(residential, "smallHouse", { x: 1, y: 1 }, 0)).toBe(
    true,
  );
});

it("uses home as a fallback destination when no destination building exists", () => {
  const state = placeBuilding(
    withArea(createInitialGameState(), "residential", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]),
    "smallHouse",
    { x: 1, y: 1 },
    0,
  );

  expect(state.citizens).toHaveLength(4);
  expect(state.citizens[0]).toMatchObject({
    id: "citizen-001",
    home: { x: 1, y: 1 },
    destination: { x: 1, y: 1 },
  });
});

it("uses placed destination buildings for later housing citizens", () => {
  let state = withArea(createInitialGameState(), "commercial", [
    { x: 5, y: 1 },
    { x: 6, y: 1 },
    { x: 5, y: 2 },
    { x: 6, y: 2 },
  ]);
  state = placeBuilding(state, "supermarket", { x: 5, y: 1 }, 0);
  state = withArea(state, "residential", [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]);
  state = placeBuilding(state, "smallHouse", { x: 1, y: 1 }, 0);

  expect(state.citizens[0].destination).toEqual({ x: 5, y: 1 });
  expect(state.citizens[1].destination).toEqual({ x: 6, y: 1 });
  expect(state.citizens[2].destination).toEqual({ x: 5, y: 2 });
  expect(state.citizens[3].destination).toEqual({ x: 6, y: 2 });
});
```

Update existing house placement expectations from 36 starting citizens to 0 starting citizens.

- [ ] **Step 2: Run building tests and verify they fail**

Run:

```sh
bunx vitest run tests/simulation/buildings.test.ts --project simulation
```

Expected: FAIL because catalog entries, `allowedArea`, and destination selection are not implemented.

- [ ] **Step 3: Extend building domain types**

In `src/domain/types.ts`, extend `BuildingType`:

```ts
export type BuildingType =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "smallHouse"
  | "largeHouse"
  | "supermarket"
  | "cinema"
  | "factory"
  | "warehouse"
  | "officeTower"
  | "businessPark"
  | "clinic"
  | "school"
  | "parkPlaza";
```

- [ ] **Step 4: Extend the catalog and placement definitions**

In `src/simulation/buildings.ts`, change definitions:

```ts
export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing"
  | "destination";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  allowedArea?: AreaKind;
  citizenCount?: number;
}
```

Add catalog entries:

```ts
smallHouse: {
  type: "smallHouse",
  label: "Small House",
  width: 2,
  height: 1,
  cost: 4_000,
  effect: "housing",
  allowedArea: "residential",
  citizenCount: 4,
},
largeHouse: {
  type: "largeHouse",
  label: "Large House",
  width: 3,
  height: 2,
  cost: 10_000,
  effect: "housing",
  allowedArea: "residential",
  citizenCount: 10,
},
supermarket: {
  type: "supermarket",
  label: "Supermarket",
  width: 2,
  height: 2,
  cost: 8_000,
  effect: "destination",
  allowedArea: "commercial",
},
cinema: {
  type: "cinema",
  label: "Cinema",
  width: 3,
  height: 2,
  cost: 14_000,
  effect: "destination",
  allowedArea: "commercial",
},
factory: {
  type: "factory",
  label: "Factory",
  width: 3,
  height: 2,
  cost: 16_000,
  effect: "destination",
  allowedArea: "industrial",
},
warehouse: {
  type: "warehouse",
  label: "Warehouse",
  width: 3,
  height: 2,
  cost: 12_000,
  effect: "destination",
  allowedArea: "industrial",
},
officeTower: {
  type: "officeTower",
  label: "Office Tower",
  width: 2,
  height: 2,
  cost: 18_000,
  effect: "destination",
  allowedArea: "office",
},
businessPark: {
  type: "businessPark",
  label: "Business Park",
  width: 3,
  height: 2,
  cost: 15_000,
  effect: "destination",
  allowedArea: "office",
},
clinic: {
  type: "clinic",
  label: "Clinic",
  width: 2,
  height: 2,
  cost: 12_000,
  effect: "destination",
  allowedArea: "civic",
},
school: {
  type: "school",
  label: "School",
  width: 3,
  height: 2,
  cost: 18_000,
  effect: "destination",
  allowedArea: "civic",
},
parkPlaza: {
  type: "parkPlaza",
  label: "Park Plaza",
  width: 2,
  height: 2,
  cost: 6_000,
  effect: "destination",
  allowedArea: "park",
},
```

Do not add `allowedArea` to `busStop`, `busTerminal`, or `metroStation`; those remain infrastructure buildings governed by existing road/track rules.

- [ ] **Step 5: Add destination selection**

Replace the old `destinationTiles` helper in `src/simulation/buildings.ts` with:

```ts
export function destinationPoints(state: GameState): Point[] {
  return state.buildings
    .filter((building) => BUILDING_CATALOG[building.type].effect === "destination")
    .flatMap((building) => building.occupiedTiles.map(clonePoint));
}
```

Change `createHousingCitizens` to use destination buildings:

```ts
function createHousingCitizens(
  state: GameState,
  occupiedTiles: Point[],
  citizenCount: number,
): Citizen[] {
  const destinations = destinationPoints(state);
  const fallbackHome = occupiedTiles[0] ?? { x: 0, y: 0 };

  return Array.from({ length: citizenCount }, (_, index) => {
    const home = occupiedTiles[index % occupiedTiles.length] ?? fallbackHome;
    const destination = destinations[index % destinations.length] ?? home;

    return {
      id: entityId("citizen", state.citizens.length + index + 1),
      home: clonePoint(home),
      destination: clonePoint(destination),
      position: clonePoint(home),
      status: "idle",
      patienceRemaining: 240,
      deadline: state.time + 900,
      routePlan: null,
      currentLegIndex: 0,
    };
  });
}
```

- [ ] **Step 6: Gate zoned buildings by area**

In `canPlaceBuilding`, add area validation inside the `footprint.every` callback:

```ts
const definition = BUILDING_CATALOG[type];
const areaOk =
  definition.allowedArea === undefined || tile?.area === definition.allowedArea;
```

Include `areaOk` in the final return:

```ts
return (
  kindOk &&
  trackOk &&
  areaOk &&
  !buildingOccupied &&
  !stopOccupied &&
  !stationOccupied
);
```

- [ ] **Step 7: Add rendering colors for new buildings**

In `src/render/colors.ts`, add:

```ts
  buildingCommercial: "#cfa24a",
  buildingIndustrial: "#776a84",
  buildingOffice: "#4e87c8",
  buildingCivic: "#429987",
  buildingPark: "#3f844f",
```

In `src/render/buildingRenderer.ts`, extend `buildingColors`:

```ts
const buildingColors = {
  busStop: colors.buildingBus,
  busTerminal: colors.buildingTerminal,
  metroStation: colors.buildingMetro,
  smallHouse: colors.buildingHouse,
  largeHouse: colors.buildingHouse,
  supermarket: colors.buildingCommercial,
  cinema: colors.buildingCommercial,
  factory: colors.buildingIndustrial,
  warehouse: colors.buildingIndustrial,
  officeTower: colors.buildingOffice,
  businessPark: colors.buildingOffice,
  clinic: colors.buildingCivic,
  school: colors.buildingCivic,
  parkPlaza: colors.buildingPark,
} satisfies Record<BuildingType, string>;
```

- [ ] **Step 8: Run building tests**

Run:

```sh
bunx vitest run tests/simulation/buildings.test.ts --project simulation
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add src/domain/types.ts src/simulation/buildings.ts src/render/colors.ts src/render/buildingRenderer.ts tests/simulation/buildings.test.ts
git commit -m "feat(simulation): gate buildings by area"
```

---

### Task 4: Runtime-Owned Area Drag

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/ui/uiState.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`
- Test: `tests/ui/uiState.test.ts`

- [ ] **Step 1: Write failing runtime tests for area selection and paint commit**

In `tests/runtime/gameRuntime.test.ts`, add:

```ts
describe("runtime area drag", () => {
  function areaAt(
    runtime: ReturnType<typeof createGameRuntime>,
    x: number,
    y: number,
  ) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((tile) => tile.x === x && tile.y === y)?.area;
  }

  it("selects an area independently from buildings and tools", () => {
    const runtime = createGameRuntime();

    runtime.setArea("residential");

    expect(runtime.getSnapshot().ui).toMatchObject({
      activeTool: "area",
      selectedArea: "residential",
      selectedBuilding: null,
      drag: null,
    });
    expect(runtime.getSnapshot().shell.hud.activeToolChip).toBe(
      "AREA RESIDENTIAL",
    );
  });

  it("paints an area rectangle from startDrag -> move -> commitDrag", () => {
    const runtime = createGameRuntime();
    runtime.setArea("commercial");
    runtime.startDrag({ x: 1, y: 1 });
    runtime.setDragCurrent({ x: 2, y: 2 });

    const snap = runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("commercial");
    expect(areaAt(runtime, 2, 2)).toBe("commercial");
    expect(snap.ui.drag).toBeNull();
  });

  it("paints a single tile area drag", () => {
    const runtime = createGameRuntime();
    runtime.setArea("office");
    runtime.startDrag({ x: 1, y: 1 });

    runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("office");
  });

  it("clears area selection when a building is selected", () => {
    const runtime = createGameRuntime();
    runtime.setArea("residential");
    runtime.setBuilding("smallHouse");

    expect(runtime.getSnapshot().ui.selectedArea).toBeNull();
  });
});
```

In `tests/ui/uiState.test.ts`, update the default test:

```ts
expect(ui.selectedArea).toBeNull();
```

- [ ] **Step 2: Run runtime tests and verify they fail**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts tests/ui/uiState.test.ts --project runtime --project ui
```

Expected: FAIL because `setArea`, `selectedArea`, and area drag support do not exist.

- [ ] **Step 3: Add area tool and UI state**

In `src/domain/types.ts`, extend `Tool`:

```ts
export type Tool =
  | "inspect"
  | "busStop"
  | "busRoute"
  | "metroStation"
  | "metroLine"
  | "civicAnchor"
  | "area"
  | "road"
  | "track"
  | "remove";
```

In `src/ui/uiState.ts`, add `AreaKind` to the existing type import from `../domain/types`, then change drag types:

```ts
export type DragTool = "road" | "track" | "remove" | "area";

export type DragGesture =
  | {
      tool: "road" | "track" | "remove";
      start: Point;
      current: Point;
    }
  | {
      tool: "area";
      area: AreaKind;
      start: Point;
      current: Point;
    };
```

Add to `UiState`:

```ts
selectedArea: AreaKind | null;
```

Add to `createUiState()`:

```ts
selectedArea: null,
```

- [ ] **Step 4: Add runtime controller API**

In `src/runtime/types.ts`, import `AreaKind` and add:

```ts
setArea: (area: AreaKind) => RuntimeSnapshot;
```

In `src/runtime/createGameRuntime.ts`, import `AreaKind` and `paintAreaRectangle`.

Add helper:

```ts
function nextAreaUiState(area: AreaKind, current = createUiState()) {
  return {
    ...current,
    activeTool: "area" as const,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    selectedArea: area,
    buildingRotation: 0 as const,
    draftStopIds: [],
    draftStationIds: [],
    draftStopPaths: [],
    draftStationPaths: [],
    selectedRouteId: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeHudCategory: null,
  };
}
```

Update `nextToolUiState` and `nextBuildingUiState` to set `selectedArea: null`.

Change:

```ts
const DRAG_TOOLS = new Set<Tool>(["road", "track", "remove", "area"]);
```

Add API method:

```ts
setArea(area) {
  return commit(state, nextAreaUiState(area, ui));
},
```

- [ ] **Step 5: Start and commit area drags**

In `startDrag`, add:

```ts
if (tool === "area") {
  if (ui.selectedArea === null) {
    return commit(state, ui);
  }
  return commit(state, {
    ...ui,
    drag: { tool, area: ui.selectedArea, start: point, current: point },
  });
}
```

Keep the road/track/remove branch after that.

In `commitDrag`, add this branch before axis-locked road handling:

```ts
if (gesture.tool === "area") {
  return commit(
    paintAreaRectangle(state, gesture.area, gesture.start, gesture.current),
    { ...ui, drag: null },
  );
}
```

- [ ] **Step 6: Update active-tool formatting**

In `src/runtime/runtimeSelectors.ts`, import `AREA_LABELS` and add this before selected-building formatting:

```ts
if (ui.selectedArea !== null) {
  return `AREA ${AREA_LABELS[ui.selectedArea].toUpperCase()}`;
}
```

Update `canCancel`:

```ts
canCancel:
  draftActive ||
  ui.activeTool !== "inspect" ||
  ui.selectedBuilding !== null ||
  ui.selectedArea !== null ||
  ui.activeOverlay !== null ||
  ui.selectedRouteId !== null,
```

- [ ] **Step 7: Run focused runtime tests**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/uiState.test.ts --project runtime --project ui
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/domain/types.ts src/ui/uiState.ts src/runtime/types.ts src/runtime/createGameRuntime.ts src/runtime/runtimeSelectors.ts tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/uiState.test.ts
git commit -m "feat(runtime): support area paint drags"
```

---

### Task 5: Build Panel Area Controls

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Modify: `src/components/hud/HudDrawer.svelte`
- Modify: `src/App.svelte`
- Test: `tests/ui/buildPanel.test.ts`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Write failing UI tests for area controls**

In `tests/ui/buildPanel.test.ts`, update `renderPanel` props to include:

```ts
selectedArea: null,
onSetArea: vi.fn(),
```

Add:

```ts
describe("BuildPanel area tools", () => {
  it("renders area buttons and reports selection", async () => {
    const onSetArea = vi.fn();
    render(BuildPanel, {
      props: {
        activeTool: "inspect" as const,
        selectedArea: null,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetArea,
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));

    expect(screen.getByRole("button", { name: "Commercial" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Industrial" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Office" })).toBeVisible();
    expect(onSetArea).toHaveBeenCalledWith("residential");
  });

  it("marks the selected area active", () => {
    render(BuildPanel, {
      props: {
        activeTool: "area" as const,
        selectedArea: "office" as const,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetArea: vi.fn(),
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset: vi.fn(),
      },
    });

    expect(screen.getByRole("button", { name: "Office" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
```

In `tests/ui/appShell.test.ts`, extend the runtime harness with `selectedArea` and `setArea`. Add:

```ts
it("wires area selection into the runtime", async () => {
  const { runtime } = createRuntimeHarness();
  render(App, { props: { runtime } });

  await openCategory("build");
  await fireEvent.click(screen.getByRole("button", { name: "Commercial" }));

  expect(runtime.setArea).toHaveBeenCalledWith("commercial");
  expect(screen.getByText("AREA COMMERCIAL")).toBeVisible();
});
```

- [ ] **Step 2: Run UI tests and verify they fail**

Run:

```sh
bunx vitest run tests/ui/buildPanel.test.ts tests/ui/appShell.test.ts --project ui
```

Expected: FAIL because BuildPanel, HudDrawer, App, and the harness do not accept area props.

- [ ] **Step 3: Add BuildPanel area props and buttons**

In `src/components/hud/panels/BuildPanel.svelte`, import `AreaKind`, `AREA_KINDS`, and `AREA_LABELS`.

Extend props:

```ts
selectedArea: AreaKind | null;
onSetArea: (area: AreaKind) => void;
```

Add after Global:

```svelte
<section class="panel-section">
  <h3 class="section-head"><span class="num">02</span> Areas</h3>
  <div class="toolbar toolbar--compact" aria-label="Area tools">
    {#each AREA_KINDS as area, index (area)}
      <button
        type="button"
        data-area={area}
        aria-pressed={selectedArea === area}
        aria-label={AREA_LABELS[area]}
        class:active={selectedArea === area}
        onclick={() => onSetArea(area)}
      >
        <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
        <span class="tool-label" aria-hidden="true">{AREA_LABELS[area]}</span>
      </button>
    {/each}
  </div>
</section>
```

Renumber Network to `03` and Build to `04`.

- [ ] **Step 4: Show the expanded building catalog**

In `BuildPanel.svelte`, change `buildToolIds`:

```ts
const buildToolIds: BuildingType[] = [
  "busStop",
  "busTerminal",
  "metroStation",
  "smallHouse",
  "largeHouse",
  "supermarket",
  "cinema",
  "factory",
  "warehouse",
  "officeTower",
  "businessPark",
  "clinic",
  "school",
  "parkPlaza",
];
```

- [ ] **Step 5: Thread props through HudDrawer and App**

In `src/components/hud/HudDrawer.svelte`, add `selectedArea` and `onSetArea` to props, then pass both to `BuildPanel`.

In `src/App.svelte`, import `AreaKind`, add:

```ts
function handleSetArea(area: AreaKind): void {
  setSnapshot(runtime.setArea(area));
}
```

Pass:

```svelte
selectedArea={snapshot.ui.selectedArea}
onSetArea={handleSetArea}
```

- [ ] **Step 6: Update app-shell runtime harness**

In `tests/ui/appShell.test.ts`, import `AreaKind`. Add to the fake runtime:

```ts
setArea: vi.fn((area: AreaKind) => {
  ui = {
    ...ui,
    activeTool: "area",
    selectedArea: area,
    selectedBuilding: null,
    buildingRotation: 0,
    draftStopIds: [],
    draftStationIds: [],
  };
  return publish();
}),
```

Ensure fake `setTool` and `setBuilding` both set `selectedArea: null`.

- [ ] **Step 7: Run UI tests**

Run:

```sh
bunx vitest run tests/ui/buildPanel.test.ts tests/ui/appShell.test.ts --project ui
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/components/hud/panels/BuildPanel.svelte src/components/hud/HudDrawer.svelte src/App.svelte tests/ui/buildPanel.test.ts tests/ui/appShell.test.ts
git commit -m "feat(ui): add area controls to build panel"
```

---

### Task 6: Area And Building Rendering

**Files:**
- Modify: `src/render/colors.ts`
- Modify: `src/render/mapRenderer.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/cursorBadge.ts`
- Modify: `src/render/buildingRenderer.ts`
- Test: `tests/render/overlayRenderer.test.ts`
- Test: `tests/render/canvas.test.ts`
- Test: `tests/render/cursorBadge.test.ts`

- [ ] **Step 1: Write failing render tests**

In `tests/render/overlayRenderer.test.ts`, extend the local `drag` helper:

```ts
const areaDrag = (
  area: "residential" | "commercial",
  start: { x: number; y: number },
  current: { x: number; y: number },
) => ({ tool: "area" as const, area, start, current });
```

Add:

```ts
it("previews an area drag as a rectangle with per-tile validity", () => {
  const { ctx, fillStyles } = recordingFillCtx();
  const state = createInitialGameState();
  const ui = {
    ...createUiState(),
    activeTool: "area" as const,
    selectedArea: "residential" as const,
    drag: areaDrag("residential", { x: 13, y: 7 }, { x: 14, y: 8 }),
  };

  renderOverlays(ctx, state, ui);

  expect(fillStyles).toContain(colors.previewValid);
  expect(fillStyles).toContain(colors.previewInvalid);
});
```

In `tests/render/canvas.test.ts`, add a map-rendering assertion using a recorder context or extend the existing recorder:

```ts
// Extend createContextRecorder() with no-op path methods used by starter-road
// arrows: save, restore, beginPath, moveTo, lineTo, stroke, arc.

it("renders area color on empty area tiles", () => {
  const { ctx, calls } = createContextRecorder();
  const base = createInitialGameState();
  const state = {
    ...base,
    map: {
      ...base.map,
      tiles: base.map.tiles.map((tile) =>
        tile.x === 1 && tile.y === 1 ? { ...tile, area: "office" as const } : tile,
      ),
    },
  };

  renderMap(ctx, state);

  expect(calls.fillRects).toContainEqual({
    fillStyle: "#82a7d8",
    x: 32,
    y: 32,
    width: 32,
    height: 32,
  });
});
```

Import `renderMap` in that test file.

- [ ] **Step 2: Run render tests and verify they fail**

Run:

```sh
bunx vitest run tests/render/overlayRenderer.test.ts tests/render/canvas.test.ts --project ui
```

Expected: FAIL because area colors and area preview rendering are not implemented.

- [ ] **Step 3: Add colors**

In `src/render/colors.ts`, add:

```ts
  areaResidential: "#8bcf8b",
  areaCommercial: "#d8b45f",
  areaIndustrial: "#8d7f99",
  areaOffice: "#82a7d8",
  areaCivic: "#5fb8a6",
  areaPark: "#4f9a61",
```

Below `colors`, export:

```ts
export const areaColors = {
  residential: colors.areaResidential,
  commercial: colors.areaCommercial,
  industrial: colors.areaIndustrial,
  office: colors.areaOffice,
  civic: colors.areaCivic,
  park: colors.areaPark,
} as const;
```

- [ ] **Step 4: Render area colors on empty tiles**

In `src/render/mapRenderer.ts`, import `areaColors` and change the tile fill:

```ts
for (const tile of state.map.tiles) {
  ctx.fillStyle =
    tile.kind === "empty" && tile.area !== undefined
      ? areaColors[tile.area]
      : colors[tile.kind];
  ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
}
```

- [ ] **Step 5: Render area drag preview**

In `src/render/overlayRenderer.ts`, import `planAreaPaintPreview`.

At the top of `renderDragPreview`, after computing `gesture`, add:

```ts
if (gesture.tool === "area") {
  for (const { point, paintable } of planAreaPaintPreview(
    state,
    gesture.area,
    gesture.start,
    gesture.current,
  )) {
    ctx.fillStyle = paintable ? colors.previewValid : colors.previewInvalid;
    ctx.strokeStyle = paintable
      ? colors.previewValidStroke
      : colors.previewInvalidStroke;
    fillTile(ctx, point);
    strokeTile(ctx, point);
  }
  return;
}
```

- [ ] **Step 6: Render cursor badge for area mode**

In `src/render/cursorBadge.ts`, import `AREA_LABELS` and `isAreaPaintable`. Add a switch case:

```ts
case "area": {
  if (ui.selectedArea === null) {
    return null;
  }
  const ok = isAreaPaintable(state, cursor);
  return `⦿ Area ${AREA_LABELS[ui.selectedArea]}${ok ? "" : " ⊘"}`;
}
```

- [ ] **Step 7: Run render tests**

Run:

```sh
bunx vitest run tests/render/overlayRenderer.test.ts tests/render/canvas.test.ts tests/render/cursorBadge.test.ts --project ui
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/render/colors.ts src/render/mapRenderer.ts src/render/overlayRenderer.ts src/render/cursorBadge.ts src/render/buildingRenderer.ts tests/render/overlayRenderer.test.ts tests/render/canvas.test.ts tests/render/cursorBadge.test.ts
git commit -m "feat(render): show areas and area previews"
```

---

### Task 7: Test Fixture Migration For New Scenario Semantics

**Files:**
- Create: `tests/helpers/mapFixtures.ts`
- Modify: `tests/simulation/network.test.ts`
- Modify: `tests/simulation/router.test.ts`
- Modify: `tests/simulation/transit.test.ts`
- Modify: `tests/simulation/citizens.test.ts`
- Modify: `tests/ui/actions.test.ts`
- Modify: `tests/runtime/roadDrag.test.ts`
- Modify: `tests/render/transitRenderer.test.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`

- [ ] **Step 1: Create shared map fixture helpers**

Create `tests/helpers/mapFixtures.ts`:

```ts
import type {
  AreaKind,
  GameState,
  Point,
  RoadDirection,
} from "../../src/domain/types";

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function pointsOnRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, index) => ({
    x: fromX + index,
    y,
  }));
}

export function pointsOnColumn(x: number, fromY: number, toY: number): Point[] {
  return Array.from({ length: toY - fromY + 1 }, (_, index) => ({
    x,
    y: fromY + index,
  }));
}

export function withRoads(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        if (!keys.has(pointKey(tile))) {
          return tile;
        }
        const { oneWay: _oneWay, ...rest } = tile;
        return { ...rest, kind: "road" as const };
      }),
    },
  };
}

export function withTracks(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(pointKey(tile)) ? { ...tile, hasTrack: true } : tile,
      ),
    },
  };
}

export function withAreas(
  state: GameState,
  area: AreaKind,
  points: Point[],
): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(pointKey(tile)) ? { ...tile, area } : tile,
      ),
    },
  };
}

export function withOneWayRoads(
  state: GameState,
  entries: Array<Point & { oneWay: RoadDirection }>,
): GameState {
  const oneWayByKey = new Map(entries.map((entry) => [pointKey(entry), entry.oneWay]));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        const oneWay = oneWayByKey.get(pointKey(tile));
        return oneWay === undefined
          ? tile
          : { ...tile, kind: "road" as const, oneWay };
      }),
    },
  };
}
```

- [ ] **Step 2: Run stale scenario-dependency search**

Run:

```sh
rg -n 'toBe\("residential"\)|toBe\("jobs"\)|toBe\("civic"\)|toBe\("park"\)|getByText\("36"\)|toHaveLength\(36\)|citizen-037|destination: \{ x: 10, y: 4 \}' tests
```

Expected before migration: matches in tests that still rely on old prebuilt districts or 36 starting citizens.

- [ ] **Step 3: Replace old district assumptions**

Apply these replacements:

- Assertions about district tile kinds become assertions about `tile.area`.
- Tests that need a residential building footprint call `withAreas(state, "residential", points)`.
- Tests that need destination buildings place a commercial/office/civic/industrial/park area and then place a matching destination building.
- Tests that expected `citizen-037` after house placement now expect `citizen-001`.
- Tests that expected initial population `36` now expect `0`.

Concrete replacement for the old road-drag skip test in `tests/runtime/roadDrag.test.ts`:

```ts
it("skips non-empty tiles in the line and only charges placed tiles", () => {
  const state = withAreas(createInitialGameState(), "residential", [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
  ]);
  const line = axisLockedLine({ x: 1, y: 3 }, { x: 4, y: 3 });
  const next = applyDragGesture(state, roadUi("twoWay"), line);

  expect(tileAt(next, 1, 3).kind).toBe("road");
  expect(tileAt(next, 2, 3).kind).toBe("empty");
  expect(tileAt(next, 2, 3).area).toBe("residential");
  expect(tileAt(next, 4, 3).kind).toBe("road");
  expect(next.budget).toBe(state.budget - 4 * COSTS.road);
});
```

If roads are allowed to cross area-assigned empty ground, the test should assert the road is laid and the `area` remains. Use `isAreaPaintable` tests for area-paint skipping instead of using road placement to prove area blocking.

- [ ] **Step 4: Replace old road assumptions with explicit roads**

For tests that need a two-way bus path, create roads in the test fixture:

```ts
let state = createInitialGameState();
state = withRoads(state, pointsOnRow(4, 1, 8));
state = addBusStop(state, { x: 1, y: 4 });
state = addBusStop(state, { x: 8, y: 4 });
```

For tests that need one-way constraints, create them explicitly:

```ts
state = withOneWayRoads(state, [
  { x: 1, y: 4, oneWay: "east" },
  { x: 2, y: 4, oneWay: "east" },
  { x: 3, y: 4, oneWay: "east" },
]);
```

For metro tests, create track explicitly:

```ts
state = withTracks(withRoads(state, pointsOnRow(4, 1, 8)), pointsOnRow(4, 1, 8));
```

Keep tests that are specifically about starter roads in `scenario.test.ts`; other tests should not depend on the scenario's road cross.

- [ ] **Step 5: Run stale search again**

Run:

```sh
rg -n 'toBe\("residential"\)|toBe\("jobs"\)|toBe\("civic"\)|toBe\("park"\)|getByText\("36"\)|toHaveLength\(36\)|citizen-037|destination: \{ x: 10, y: 4 \}' tests
```

Expected: no matches.

- [ ] **Step 6: Run simulation, runtime, render, and UI unit tests**

Run:

```sh
bun run test:unit
```

Expected: PASS. If failures remain, fix only stale fixture assumptions or legitimate compile errors introduced by the area model.

- [ ] **Step 7: Commit**

```sh
git add tests/helpers/mapFixtures.ts tests/simulation tests/runtime tests/render tests/ui
git commit -m "test: decouple fixtures from seeded districts"
```

---

### Task 8: E2E Smoke Flow For Painted Areas And Zoned Buildings

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`

- [ ] **Step 1: Update the e2e smoke test**

Replace the test body in `tests/e2e/smoke.spec.ts` with this flow:

```ts
test("loads the svelte shell and supports area painting and zoned buildings", async ({
  page,
}) => {
  await page.goto(appUrl);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(populationReadout.getByText("0")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Residential" }).click();
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 2 });

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Commercial" }).click();
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 7, y: 3 });

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Supermarket" }).click();
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$112,000")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Small House" }).click();
  await clickMapTile(canvas, { x: 1, y: 1 });

  await expect(topbar.getByText("$108,000")).toBeVisible();
  await expect(populationReadout.getByText("4")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await dragMapTiles(page, canvas, { x: 1, y: 0 }, { x: 3, y: 0 });
  await expect(topbar.getByText("$107,700")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");
});
```

- [ ] **Step 2: Run e2e smoke**

Run:

```sh
bun run test:e2e -- tests/e2e/smoke.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/smoke.spec.ts
git commit -m "test(e2e): cover area zoning smoke flow"
```

---

### Task 9: Final Verification And Cleanup

**Files:**
- Review all changed files from Tasks 1-8.

- [ ] **Step 1: Run type and Svelte checks**

Run:

```sh
bun run check
```

Expected: PASS.

- [ ] **Step 2: Run unit tests**

Run:

```sh
bun run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run e2e tests**

Run:

```sh
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```sh
bun run build
```

Expected: PASS.

- [ ] **Step 5: Inspect remaining old district references**

Run:

```sh
rg -n '"jobs"|"residential"|"civic"|"park"|districtId|createGrowingSuburbWaves|createStartingCitizens' src tests
```

Expected:
- `residential`, `civic`, and `park` may appear as `AreaKind` values.
- `createGrowingSuburbWaves` and `createStartingCitizens` may appear as exported empty scenario helpers.
- No production logic should use `tile.kind === "jobs"` or `tile.kind === "civic"` for destinations.

- [ ] **Step 6: Commit any final fixes**

If Step 1-5 required changes:

```sh
git add src tests
git commit -m "fix: finish area zoning integration"
```

If Step 1-5 required no changes, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Area model: Tasks 1, 4, 6.
  - Empty scenario and starter roads: Task 2.
  - Area drag UX: Tasks 4, 5, 6, 8.
  - Building catalog and area-gated placement: Task 3.
  - Destination-building demand: Task 3.
  - Test migration and e2e coverage: Tasks 7 and 8.
- Type consistency:
  - `AreaKind`, `selectedArea`, `setArea`, area drag gesture, and `AREA_LABELS` are introduced before UI and rendering tasks use them.
  - New `BuildingType` values are introduced before BuildPanel and rendering catalog usage.
- Scope:
  - Automatic growth, land-value systems, and new art assets remain out of scope.
