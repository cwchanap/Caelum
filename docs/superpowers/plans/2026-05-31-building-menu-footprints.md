# Building Menu Footprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new Build menu workflow with rotatable multi-tile buildings, active house effects, bus terminals, and a separate Route Planning menu.

**Architecture:** Add a focused building simulation module that owns the catalog, footprints, placement validation, and placement effects. Keep route creation in the existing transit path, extend the runtime/UI state for selected building and rotation, and add canvas rendering for placed building footprints plus placement preview.

**Tech Stack:** TypeScript, Svelte 5, Vite, Vitest, Playwright, Tauri shell unchanged.

---

## File Structure

- Create `src/simulation/buildings.ts`: building catalog, rotated footprint calculation, placement validation, deterministic citizen creation, and building placement.
- Create `src/render/buildingRenderer.ts`: placed building drawing and hover footprint preview drawing.
- Modify `src/domain/types.ts`: add `BuildingType`, `BuildingRotation`, `PlacedBuilding`, extend `Stop`, narrow `Tool`, and add `GameState.buildings`.
- Modify `src/domain/ids.ts`: add a helper for next numeric entity id so building and transit ids remain unique after removal.
- Modify `src/simulation/gameState.ts`: initialize `buildings: []`.
- Modify `src/simulation/transit.ts`: add stop kind support, expose coverage radius, and keep legacy stop/station helper behavior for existing simulation tests.
- Modify `src/simulation/map.ts`: keep current map helpers; no ownership move is needed.
- Modify `src/ui/uiState.ts`: add selected building and building rotation.
- Modify `src/ui/actions.ts`: route tile clicks through building placement first, keep route planning behavior, and remove full building footprints.
- Modify `src/runtime/createGameRuntime.ts`: add building selection and rotation intents, clear drafts when switching modes.
- Modify `src/runtime/runtimeSelectors.ts`: display selected building and rotation in the details panel.
- Modify `src/runtime/types.ts`: expose `setBuilding` and `rotateBuilding`.
- Modify `src/render/canvas.ts`: render buildings between map and overlays.
- Modify `src/render/overlayRenderer.ts`: use bus terminal coverage radius and remove single-tile hover-only behavior for building mode.
- Modify `src/render/colors.ts`: add building and preview colors.
- Modify `src/components/ControlTower.svelte`: split Build, Route Planning, Global tools, and Overlay controls.
- Modify `src/App.svelte`: pass selected building, rotation, and new runtime intents into Control Tower.
- Modify `src/styles.css`: fit the extra Control Tower sections and style rotate/build controls.
- Modify tests under `tests/simulation`, `tests/ui`, `tests/runtime`, `tests/render`, and `tests/e2e` to cover the new behavior.

## Task 1: Domain Types, Catalog, And Footprints

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ids.ts`
- Create: `src/simulation/buildings.ts`
- Modify: `src/simulation/gameState.ts`
- Test: `tests/simulation/buildings.test.ts`

- [ ] **Step 1: Write failing tests for catalog and rotated footprints**

Create `tests/simulation/buildings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BuildingRotation } from "../../src/domain/types";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
  getRotatedFootprintSize,
} from "../../src/simulation/buildings";

describe("building catalog and footprints", () => {
  it("defines the first Build menu catalog", () => {
    expect(Object.keys(BUILDING_CATALOG)).toEqual([
      "busStop",
      "busTerminal",
      "metroStation",
      "smallHouse",
      "largeHouse",
    ]);
    expect(BUILDING_CATALOG.busTerminal).toMatchObject({
      label: "Bus Terminal",
      width: 3,
      height: 2,
      cost: 12_000,
      effect: "busTerminal",
    });
    expect(BUILDING_CATALOG.smallHouse).toMatchObject({
      label: "Small House",
      width: 2,
      height: 1,
      cost: 4_000,
      citizenCount: 4,
      effect: "housing",
    });
  });

  it.each([
    [0, { width: 3, height: 2 }],
    [90, { width: 2, height: 3 }],
    [180, { width: 3, height: 2 }],
    [270, { width: 2, height: 3 }],
  ] satisfies Array<[BuildingRotation, { width: number; height: number }]>)(
    "rotates a 3x2 footprint at %s degrees",
    (rotation, size) => {
      expect(getRotatedFootprintSize("busTerminal", rotation)).toEqual(size);
    },
  );

  it("expands a rotated footprint from its origin", () => {
    expect(getBuildingFootprint("smallHouse", { x: 4, y: 5 }, 90)).toEqual([
      { x: 4, y: 5 },
      { x: 4, y: 6 },
    ]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bunx vitest run tests/simulation/buildings.test.ts`

Expected: FAIL with import errors for `../../src/simulation/buildings` and missing domain types.

- [ ] **Step 3: Add domain types and initialized state**

Modify `src/domain/types.ts` with these type changes:

```ts
export type BuildingType =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "smallHouse"
  | "largeHouse";
export type BuildingRotation = 0 | 90 | 180 | 270;
export type StopKind = "busStop" | "busTerminal";
export type Tool = "inspect" | "busRoute" | "metroLine" | "remove";

export interface PlacedBuilding {
  id: string;
  type: BuildingType;
  origin: Point;
  rotation: BuildingRotation;
  occupiedTiles: Point[];
  transitNodeId?: string;
}

export interface Stop {
  id: string;
  kind: StopKind;
  position: Point;
  queueCitizenIds: string[];
}

export interface GameState {
  time: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  scenario: Scenario;
  transit: TransitNetwork;
  citizens: Citizen[];
  metrics: Metrics;
}
```

Modify `src/simulation/gameState.ts` so `createInitialGameState()` includes:

```ts
export function createInitialGameState(): GameState {
  return {
    time: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: createGrowingSuburbMap(),
    buildings: [],
    scenario: createGrowingSuburbScenario(),
    transit: createEmptyTransitNetwork(),
    citizens: createStartingCitizens(),
    metrics: createInitialMetrics(),
  };
}
```

- [ ] **Step 4: Add a unique id helper**

Modify `src/domain/ids.ts`:

```ts
export function tileId(x: number, y: number): string {
  return `tile-${x}-${y}`;
}

export function entityId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

export function nextEntityId(prefix: string, existingIds: string[]): string {
  const nextIndex =
    existingIds.reduce((max, id) => {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
      return match === null ? max : Math.max(max, Number(match[1]));
    }, 0) + 1;

  return entityId(prefix, nextIndex);
}
```

- [ ] **Step 5: Add the catalog and footprint helpers**

Create `src/simulation/buildings.ts`:

```ts
import type {
  BuildingRotation,
  BuildingType,
  GameState,
  Point,
} from "../domain/types";

export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  citizenCount?: number;
}

export const BUILDING_CATALOG: Record<BuildingType, BuildingDefinition> = {
  busStop: {
    type: "busStop",
    label: "Bus Stop",
    width: 1,
    height: 1,
    cost: 2_000,
    effect: "busStop",
  },
  busTerminal: {
    type: "busTerminal",
    label: "Bus Terminal",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "busTerminal",
  },
  metroStation: {
    type: "metroStation",
    label: "Metro Station",
    width: 1,
    height: 1,
    cost: 25_000,
    effect: "metroStation",
  },
  smallHouse: {
    type: "smallHouse",
    label: "Small House",
    width: 2,
    height: 1,
    cost: 4_000,
    effect: "housing",
    citizenCount: 4,
  },
  largeHouse: {
    type: "largeHouse",
    label: "Large House",
    width: 3,
    height: 2,
    cost: 10_000,
    effect: "housing",
    citizenCount: 10,
  },
};

export function getRotatedFootprintSize(
  type: BuildingType,
  rotation: BuildingRotation,
): { width: number; height: number } {
  const definition = BUILDING_CATALOG[type];
  return rotation === 90 || rotation === 270
    ? { width: definition.height, height: definition.width }
    : { width: definition.width, height: definition.height };
}

export function getBuildingFootprint(
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): Point[] {
  const size = getRotatedFootprintSize(type, rotation);
  const points: Point[] = [];

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      points.push({ x: origin.x + x, y: origin.y + y });
    }
  }

  return points;
}

export function canPlaceBuilding(
  _state: GameState,
  _type: BuildingType,
  _origin: Point,
  _rotation: BuildingRotation,
): boolean {
  return getBuildingFootprint(_type, _origin, _rotation).length > 0;
}
```

The initial `canPlaceBuilding` export keeps imports stable while full validation is built in Task 2.

- [ ] **Step 6: Run the focused test and verify it passes**

Run: `bunx vitest run tests/simulation/buildings.test.ts`

Expected: PASS for the catalog and footprint tests.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/domain/types.ts src/domain/ids.ts src/simulation/buildings.ts src/simulation/gameState.ts tests/simulation/buildings.test.ts
git commit -m "feat: add building catalog footprints"
```

## Task 2: Placement Validation, Effects, And Removal

**Files:**
- Modify: `src/simulation/buildings.ts`
- Modify: `src/simulation/transit.ts`
- Modify: `src/ui/actions.ts`
- Modify: `tests/simulation/buildings.test.ts`
- Modify: `tests/ui/actions.test.ts`

- [ ] **Step 1: Add failing placement and effect tests**

Append to `tests/simulation/buildings.test.ts`:

```ts
import { createInitialGameState } from "../../src/simulation/gameState";
import { canPlaceBuilding, placeBuilding } from "../../src/simulation/buildings";

describe("building placement", () => {
  it("allows a full footprint on empty in-bounds tiles", () => {
    const state = createInitialGameState();

    expect(canPlaceBuilding(state, "busTerminal", { x: 0, y: 0 }, 0)).toBe(
      true,
    );
  });

  it("blocks non-empty, out-of-bounds, and overlapping footprints", () => {
    let state = createInitialGameState();
    state = placeBuilding(state, "smallHouse", { x: 0, y: 0 }, 0);

    expect(canPlaceBuilding(state, "busStop", { x: 0, y: 0 }, 0)).toBe(false);
    expect(canPlaceBuilding(state, "largeHouse", { x: 27, y: 17 }, 0)).toBe(
      false,
    );
    expect(canPlaceBuilding(state, "metroStation", { x: 7, y: 8 }, 0)).toBe(
      false,
    );
  });

  it("places transit buildings with building records and transit nodes", () => {
    let state = createInitialGameState();
    state = placeBuilding(state, "busTerminal", { x: 0, y: 0 }, 90);
    state = placeBuilding(state, "metroStation", { x: 3, y: 0 }, 0);

    expect(state.budget).toBe(83_000);
    expect(state.buildings).toEqual([
      {
        id: "building-001",
        type: "busTerminal",
        origin: { x: 0, y: 0 },
        rotation: 90,
        occupiedTiles: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 0, y: 2 },
          { x: 1, y: 2 },
        ],
        transitNodeId: "stop-001",
      },
      {
        id: "building-002",
        type: "metroStation",
        origin: { x: 3, y: 0 },
        rotation: 0,
        occupiedTiles: [{ x: 3, y: 0 }],
        transitNodeId: "station-001",
      },
    ]);
    expect(state.transit.stops).toEqual([
      {
        id: "stop-001",
        kind: "busTerminal",
        position: { x: 0, y: 0 },
        queueCitizenIds: [],
      },
    ]);
    expect(state.transit.stations).toEqual([
      { id: "station-001", position: { x: 3, y: 0 }, queueCitizenIds: [] },
    ]);
  });

  it("adds deterministic citizens for houses", () => {
    const state = placeBuilding(
      createInitialGameState(),
      "largeHouse",
      { x: 0, y: 0 },
      0,
    );

    expect(state.citizens).toHaveLength(46);
    expect(state.citizens.at(36)).toMatchObject({
      id: "citizen-037",
      home: { x: 0, y: 0 },
      destination: { x: 10, y: 4 },
      position: { x: 0, y: 0 },
      status: "idle",
      patienceRemaining: 240,
      deadline: 900,
    });
  });

  it("returns the original state for invalid or unaffordable placement", () => {
    const state = { ...createInitialGameState(), budget: 1_999 };
    const baseState = createInitialGameState();

    expect(placeBuilding(state, "busStop", { x: 0, y: 0 }, 0)).toBe(state);
    expect(placeBuilding(baseState, "smallHouse", { x: 7, y: 8 }, 0)).toBe(
      baseState,
    );
  });
});
```

- [ ] **Step 2: Add failing UI removal tests**

Update `tests/ui/actions.test.ts` by replacing Civic Anchor expectations with building removal coverage:

```ts
it("removes a whole placed building footprint from any occupied tile", () => {
  const placed = handleTileClick(
    createInitialGameState(),
    {
      ...createUiState(),
      selectedBuilding: "largeHouse",
      buildingRotation: 0,
    },
    { x: 0, y: 0 },
  );

  const removed = handleTileClick(
    placed.state,
    { ...createUiState(), activeTool: "remove" },
    { x: 2, y: 1 },
  );

  expect(removed.state.buildings).toEqual([]);
  expect(removed.state.citizens).toHaveLength(46);
});

it("removes terminal stops and dependent routes at a clicked footprint tile", () => {
  let result = handleTileClick(
    createInitialGameState(),
    {
      ...createUiState(),
      selectedBuilding: "busTerminal",
      buildingRotation: 0,
    },
    { x: 0, y: 0 },
  );
  result = handleTileClick(
    result.state,
    {
      ...createUiState(),
      selectedBuilding: "busStop",
      buildingRotation: 0,
    },
    { x: 4, y: 0 },
  );
  result = handleTileClick(
    result.state,
    { ...createUiState(), activeTool: "busRoute" },
    { x: 0, y: 0 },
  );
  result = handleTileClick(result.state, result.ui, { x: 4, y: 0 });

  const removed = handleTileClick(
    result.state,
    { ...createUiState(), activeTool: "remove" },
    { x: 2, y: 1 },
  );

  expect(removed.state.buildings.map((building) => building.id)).toEqual([
    "building-002",
  ]);
  expect(removed.state.transit.stops).toEqual([
    {
      id: "stop-002",
      kind: "busStop",
      position: { x: 4, y: 0 },
      queueCitizenIds: [],
    },
  ]);
  expect(removed.state.transit.routes).toEqual([]);
  expect(removed.state.transit.vehicles).toEqual([]);
});
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run: `bunx vitest run tests/simulation/buildings.test.ts tests/ui/actions.test.ts`

Expected: FAIL because `placeBuilding`, real placement validation, `selectedBuilding`, and stop `kind` behavior are not implemented.

- [ ] **Step 4: Implement placement validation and effects**

Replace `src/simulation/buildings.ts` with:

```ts
import { nextEntityId } from "../domain/ids";
import type {
  BuildingRotation,
  BuildingType,
  Citizen,
  GameState,
  PlacedBuilding,
  Point,
} from "../domain/types";
import { getTile } from "./map";

export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  citizenCount?: number;
}

export const BUILDING_CATALOG: Record<BuildingType, BuildingDefinition> = {
  busStop: {
    type: "busStop",
    label: "Bus Stop",
    width: 1,
    height: 1,
    cost: 2_000,
    effect: "busStop",
  },
  busTerminal: {
    type: "busTerminal",
    label: "Bus Terminal",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "busTerminal",
  },
  metroStation: {
    type: "metroStation",
    label: "Metro Station",
    width: 1,
    height: 1,
    cost: 25_000,
    effect: "metroStation",
  },
  smallHouse: {
    type: "smallHouse",
    label: "Small House",
    width: 2,
    height: 1,
    cost: 4_000,
    effect: "housing",
    citizenCount: 4,
  },
  largeHouse: {
    type: "largeHouse",
    label: "Large House",
    width: 3,
    height: 2,
    cost: 10_000,
    effect: "housing",
    citizenCount: 10,
  },
};

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function destinationTiles(state: GameState): Point[] {
  return state.map.tiles
    .filter((tile) => tile.kind === "jobs" || tile.kind === "civic")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(clonePoint);
}

function createHousingCitizens(
  state: GameState,
  building: PlacedBuilding,
  citizenCount: number,
): Citizen[] {
  const destinations = destinationTiles(state);
  const fallbackDestination = building.occupiedTiles[0] ?? building.origin;

  return Array.from({ length: citizenCount }, (_, index) => {
    const home = clonePoint(
      building.occupiedTiles[index % building.occupiedTiles.length] ??
        building.origin,
    );
    const destination = clonePoint(
      destinations[index % destinations.length] ?? fallbackDestination,
    );

    return {
      id: `citizen-${String(state.citizens.length + index + 1).padStart(3, "0")}`,
      home,
      destination,
      position: clonePoint(home),
      status: "idle",
      patienceRemaining: 240,
      deadline: state.time + 900,
      routePlan: null,
      currentLegIndex: 0,
    };
  });
}

export function getRotatedFootprintSize(
  type: BuildingType,
  rotation: BuildingRotation,
): { width: number; height: number } {
  const definition = BUILDING_CATALOG[type];
  return rotation === 90 || rotation === 270
    ? { width: definition.height, height: definition.width }
    : { width: definition.width, height: definition.height };
}

export function getBuildingFootprint(
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): Point[] {
  const size = getRotatedFootprintSize(type, rotation);
  const points: Point[] = [];

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      points.push({ x: origin.x + x, y: origin.y + y });
    }
  }

  return points;
}

export function canPlaceBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): boolean {
  const footprint = getBuildingFootprint(type, origin, rotation);

  return footprint.every((point) => {
    const tile = getTile(state.map, point);
    const overlapsBuilding = state.buildings.some((building) =>
      building.occupiedTiles.some((occupiedTile) =>
        samePoint(occupiedTile, point),
      ),
    );
    const overlapsStop = state.transit.stops.some((stop) =>
      samePoint(stop.position, point),
    );
    const overlapsStation = state.transit.stations.some((station) =>
      samePoint(station.position, point),
    );

    return (
      tile?.kind === "empty" &&
      !overlapsBuilding &&
      !overlapsStop &&
      !overlapsStation
    );
  });
}

export function placeBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): GameState {
  const definition = BUILDING_CATALOG[type];

  if (
    state.budget < definition.cost ||
    !canPlaceBuilding(state, type, origin, rotation)
  ) {
    return state;
  }

  const footprint = getBuildingFootprint(type, origin, rotation);
  const transitNodeId =
    definition.effect === "busStop" || definition.effect === "busTerminal"
      ? nextEntityId(
          "stop",
          state.transit.stops.map((stop) => stop.id),
        )
      : definition.effect === "metroStation"
        ? nextEntityId(
            "station",
            state.transit.stations.map((station) => station.id),
          )
        : undefined;
  const building: PlacedBuilding = {
    id: nextEntityId(
      "building",
      state.buildings.map((candidate) => candidate.id),
    ),
    type,
    origin: clonePoint(origin),
    rotation,
    occupiedTiles: footprint.map(clonePoint),
    ...(transitNodeId === undefined ? {} : { transitNodeId }),
  };
  const baseState: GameState = {
    ...state,
    budget: state.budget - definition.cost,
    buildings: [...state.buildings, building],
  };

  if (definition.effect === "busStop" || definition.effect === "busTerminal") {
    return {
      ...baseState,
      transit: {
        ...baseState.transit,
        stops: [
          ...baseState.transit.stops,
          {
            id: transitNodeId!,
            kind: definition.effect,
            position: clonePoint(origin),
            queueCitizenIds: [],
          },
        ],
      },
    };
  }

  if (definition.effect === "metroStation") {
    return {
      ...baseState,
      transit: {
        ...baseState.transit,
        stations: [
          ...baseState.transit.stations,
          {
            id: transitNodeId!,
            position: clonePoint(origin),
            queueCitizenIds: [],
          },
        ],
      },
    };
  }

  return {
    ...baseState,
    citizens: [
      ...baseState.citizens,
      ...createHousingCitizens(
        baseState,
        building,
        definition.citizenCount ?? 0,
      ),
    ],
  };
}
```

This keeps ids deterministic for the current numeric id format and avoids broad id-system changes inside citizen generation.

- [ ] **Step 5: Add stop kind and coverage radius support**

Modify `src/simulation/transit.ts`:

```ts
import type {
  Citizen,
  GameState,
  Point,
  Route,
  MetroLine,
  Stop,
  StopKind,
  Vehicle,
} from "../domain/types";

export function stopCoverageRadius(stop: Stop): number {
  return stop.kind === "busTerminal" ? 4 : 2;
}
```

Update `addBusStop` to create kinded stops:

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

  return {
    ...state,
    budget: state.budget - COSTS.busStop,
    transit: {
      ...state.transit,
      stops: [
        ...state.transit.stops,
        {
          id: entityId("stop", state.transit.stops.length + 1),
          kind,
          position: clonePoint(point),
          queueCitizenIds: [],
        },
      ],
    },
  };
}
```

Update all inline stop fixtures in tests to include `kind: "busStop"` unless they represent a terminal.

- [ ] **Step 6: Route UI actions through building placement and full-footprint removal**

Modify `src/ui/actions.ts`:

```ts
import type { GameState, Point } from "../domain/types";
import { placeBuilding } from "../simulation/buildings";
import {
  addBusRoute,
  addMetroLine,
  assignVehicle,
} from "../simulation/transit";
import type { UiState } from "./uiState";
```

Remove `addBusStop`, `addMetroStation`, and Civic Anchor imports and helper code. Replace the start of `handleTileClick` with:

```ts
export function handleTileClick(
  state: GameState,
  ui: UiState,
  point: Point,
): { state: GameState; ui: UiState } {
  if (ui.selectedBuilding !== null) {
    return {
      state: placeBuilding(
        state,
        ui.selectedBuilding,
        point,
        ui.buildingRotation,
      ),
      ui,
    };
  }
```

Replace `removeAtTile` with a version that removes a building by any occupied tile before falling back to legacy stop/station removal:

```ts
function removeAtTile(state: GameState, point: Point): GameState {
  const removedBuilding = state.buildings.find((building) =>
    building.occupiedTiles.some((occupiedTile) => samePoint(occupiedTile, point)),
  );
  const explicitStopIds =
    removedBuilding?.transitNodeId !== undefined &&
    (removedBuilding.type === "busStop" || removedBuilding.type === "busTerminal")
      ? new Set([removedBuilding.transitNodeId])
      : new Set<string>();
  const explicitStationIds =
    removedBuilding?.transitNodeId !== undefined &&
    removedBuilding.type === "metroStation"
      ? new Set([removedBuilding.transitNodeId])
      : new Set<string>();
  const removedStopIds = new Set([
    ...explicitStopIds,
    ...state.transit.stops
      .filter((stop) => samePoint(stop.position, point))
      .map((stop) => stop.id),
  ]);
  const removedStationIds = new Set([
    ...explicitStationIds,
    ...state.transit.stations
      .filter((station) => samePoint(station.position, point))
      .map((station) => station.id),
  ]);
  const removedRouteIds = new Set(
    state.transit.routes
      .filter((route) =>
        route.stopIds.some((stopId) => removedStopIds.has(stopId)),
      )
      .map((route) => route.id),
  );
  const removedMetroLineIds = new Set(
    state.transit.metroLines
      .filter((metroLine) =>
        metroLine.stationIds.some((stationId) =>
          removedStationIds.has(stationId),
        ),
      )
      .map((metroLine) => metroLine.id),
  );

  if (
    removedBuilding === undefined &&
    removedStopIds.size === 0 &&
    removedStationIds.size === 0
  ) {
    return state;
  }

  return {
    ...state,
    buildings:
      removedBuilding === undefined
        ? state.buildings
        : state.buildings.filter(
            (building) => building.id !== removedBuilding.id,
          ),
    transit: {
      ...state.transit,
      stops: state.transit.stops.filter((stop) => !removedStopIds.has(stop.id)),
      stations: state.transit.stations.filter(
        (station) => !removedStationIds.has(station.id),
      ),
      routes: state.transit.routes.filter(
        (route) => !removedRouteIds.has(route.id),
      ),
      metroLines: state.transit.metroLines.filter(
        (metroLine) => !removedMetroLineIds.has(metroLine.id),
      ),
      vehicles: state.transit.vehicles.filter(
        (vehicle) =>
          !removedRouteIds.has(vehicle.lineId) &&
          !removedMetroLineIds.has(vehicle.lineId),
      ),
    },
  };
}
```

- [ ] **Step 7: Run focused tests and reconcile exact fixture changes**

Run: `bunx vitest run tests/simulation/buildings.test.ts tests/ui/actions.test.ts tests/simulation/transit.test.ts tests/simulation/router.test.ts`

Expected: PASS after stop fixtures include `kind: "busStop"` and old Civic Anchor tests are removed or rewritten around placed buildings.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/simulation/buildings.ts src/simulation/transit.ts src/ui/actions.ts tests/simulation/buildings.test.ts tests/ui/actions.test.ts tests/simulation/transit.test.ts tests/simulation/router.test.ts
git commit -m "feat: place active buildings"
```

## Task 3: Runtime And UI State Intents

**Files:**
- Modify: `src/ui/uiState.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write failing runtime tests for building selection and rotation**

Append to `tests/runtime/gameRuntime.test.ts`:

```ts
it("selects buildings separately from route tools and rotates them", () => {
  const runtime = createGameRuntime();

  runtime.setBuilding("busTerminal");
  runtime.rotateBuilding();
  runtime.rotateBuilding();

  const snapshot = runtime.getSnapshot();
  expect(snapshot.ui.activeTool).toBe("inspect");
  expect(snapshot.ui.selectedBuilding).toBe("busTerminal");
  expect(snapshot.ui.buildingRotation).toBe(180);
  expect(snapshot.shell.controlTower.activeTool).toBe("BUS TERMINAL 180");
});

it("clears building selection when switching to route or remove tools", () => {
  const runtime = createGameRuntime();

  runtime.setBuilding("largeHouse");
  runtime.rotateBuilding();
  runtime.setTool("busRoute");

  expect(runtime.getSnapshot().ui).toMatchObject({
    activeTool: "busRoute",
    selectedBuilding: null,
    buildingRotation: 0,
  });
});
```

- [ ] **Step 2: Run focused runtime tests and verify they fail**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`

Expected: FAIL because `selectedBuilding`, `buildingRotation`, `setBuilding`, and `rotateBuilding` are missing.

- [ ] **Step 3: Extend UI state**

Modify `src/ui/uiState.ts`:

```ts
import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  Tool,
} from "../domain/types";

export interface UiState {
  activeTool: Tool;
  selectedBuilding: BuildingType | null;
  buildingRotation: BuildingRotation;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
  controlTowerOpen: boolean;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    selectedBuilding: null,
    buildingRotation: 0,
    activeOverlay: null,
    selectedId: null,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: [],
    controlTowerOpen: true,
  };
}
```

- [ ] **Step 4: Extend runtime API and selectors**

Modify `src/runtime/types.ts`:

```ts
import type {
  BuildingType,
  GameState,
  Overlay,
  Point,
  Tool,
} from "../domain/types";

export interface RuntimeController {
  getSnapshot: () => RuntimeSnapshot;
  subscribe: (listener: RuntimeListener) => () => void;
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  tick: (deltaSeconds: number) => RuntimeSnapshot;
  reset: () => RuntimeSnapshot;
  resetUi: () => RuntimeSnapshot;
  setTool: (tool: Tool) => RuntimeSnapshot;
  setBuilding: (building: BuildingType) => RuntimeSnapshot;
  rotateBuilding: () => RuntimeSnapshot;
  setOverlay: (overlay: Overlay | null) => RuntimeSnapshot;
  togglePause: () => RuntimeSnapshot;
  setSpeed: (speed: GameState["speed"]) => RuntimeSnapshot;
  toggleControlTower: () => RuntimeSnapshot;
  handleTileClick: (point: Point) => RuntimeSnapshot;
  setHoverTile: (point: Point | null) => RuntimeSnapshot;
  mountCanvas: (host: HTMLElement) => () => void;
}
```

Modify `src/runtime/createGameRuntime.ts` helpers:

```ts
import type { BuildingType, Point, Tool } from "../domain/types";

const rotations = [0, 90, 180, 270] as const;

function nextToolUiState(activeTool: Tool, current = createUiState()) {
  return {
    ...current,
    activeTool,
    selectedBuilding: null,
    buildingRotation: 0,
    draftStopIds: activeTool === "busRoute" ? current.draftStopIds : [],
    draftStationIds: activeTool === "metroLine" ? current.draftStationIds : [],
  };
}

function nextBuildingUiState(
  selectedBuilding: BuildingType,
  current = createUiState(),
) {
  return {
    ...current,
    activeTool: "inspect" as const,
    selectedBuilding,
    buildingRotation: 0 as const,
    draftStopIds: [],
    draftStationIds: [],
    selectedId: null,
  };
}
```

Add controller methods:

```ts
setBuilding(building) {
  return commit(state, nextBuildingUiState(building, ui));
},
rotateBuilding() {
  const currentIndex = rotations.indexOf(ui.buildingRotation);
  return commit(state, {
    ...ui,
    buildingRotation: rotations[(currentIndex + 1) % rotations.length],
  });
},
```

Modify `src/runtime/runtimeSelectors.ts`:

```ts
import { BUILDING_CATALOG } from "../simulation/buildings";

function formatActiveTool(ui: UiState): string {
  if (ui.selectedBuilding !== null) {
    return `${BUILDING_CATALOG[ui.selectedBuilding].label.toUpperCase()} ${ui.buildingRotation}`;
  }

  return ui.activeTool.toUpperCase();
}
```

Use `activeTool: formatActiveTool(ui)` in `selectShellState`.

- [ ] **Step 5: Run focused runtime tests**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit runtime state changes**

```bash
git add src/ui/uiState.ts src/runtime/types.ts src/runtime/createGameRuntime.ts src/runtime/runtimeSelectors.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat: add building selection runtime state"
```

## Task 4: Rendering, Preview, And Coverage Radius

**Files:**
- Create: `src/render/buildingRenderer.ts`
- Modify: `src/render/canvas.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/colors.ts`
- Test: `tests/render/canvas.test.ts`

- [ ] **Step 1: Add render-facing tests for preview calculation**

Append to `tests/render/canvas.test.ts`:

```ts
import { getBuildingFootprint } from "../../src/simulation/buildings";
import { stopCoverageRadius } from "../../src/simulation/transit";

it("uses the building footprint helper for preview geometry", () => {
  expect(getBuildingFootprint("busTerminal", { x: 1, y: 2 }, 270)).toEqual([
    { x: 1, y: 2 },
    { x: 2, y: 2 },
    { x: 1, y: 3 },
    { x: 2, y: 3 },
    { x: 1, y: 4 },
    { x: 2, y: 4 },
  ]);
});

it("uses larger coverage for bus terminals than bus stops", () => {
  expect(
    stopCoverageRadius({
      id: "stop-001",
      kind: "busStop",
      position: { x: 0, y: 0 },
      queueCitizenIds: [],
    }),
  ).toBe(2);
  expect(
    stopCoverageRadius({
      id: "stop-002",
      kind: "busTerminal",
      position: { x: 0, y: 0 },
      queueCitizenIds: [],
    }),
  ).toBe(4);
});
```

- [ ] **Step 2: Run render tests**

Run: `bunx vitest run tests/render/canvas.test.ts`

Expected: PASS because Task 2 added `stopCoverageRadius`.

- [ ] **Step 3: Add colors**

Modify `src/render/colors.ts`:

```ts
export const colors = {
  empty: "#d7e2df",
  road: "#5f6d75",
  residential: "#8bcf8b",
  jobs: "#d8b45f",
  civic: "#82a7d8",
  park: "#4f9a61",
  buildingBus: "#e8734f",
  buildingTerminal: "#c7472f",
  buildingMetro: "#3d7fd4",
  buildingHouse: "#7bbf72",
  previewValid: "rgba(200, 255, 92, 0.32)",
  previewInvalid: "rgba(255, 91, 91, 0.32)",
  previewValidStroke: "#c8ff5c",
  previewInvalidStroke: "#ff5b5b",
  grid: "#b6c2c8",
  bus: "#e04f39",
  metro: "#2867b2",
  citizen: "#1e2a32",
  walking: "#1e2a32",
  waiting: "#f0a33a",
  riding: "#2867b2",
  late: "#b92e35",
  unserved: "#6f2c8f",
  coverage: "rgba(40, 103, 178, 0.18)",
  crowding: "rgba(224, 79, 57, 0.2)",
  demand: "rgba(216, 180, 95, 0.24)",
  lateness: "rgba(185, 46, 53, 0.24)",
  growth: "rgba(79, 154, 97, 0.25)",
  hover: "#111820",
} as const;
```

- [ ] **Step 4: Create building renderer**

Create `src/render/buildingRenderer.ts`:

```ts
import type { GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function colorForBuilding(type: GameState["buildings"][number]["type"]): string {
  if (type === "busStop") return colors.buildingBus;
  if (type === "busTerminal") return colors.buildingTerminal;
  if (type === "metroStation") return colors.buildingMetro;
  return colors.buildingHouse;
}

export function renderBuildings(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  for (const building of state.buildings) {
    ctx.fillStyle = colorForBuilding(building.type);

    for (const tile of building.occupiedTiles) {
      ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    }

    ctx.strokeStyle = "rgba(17, 24, 32, 0.45)";
    ctx.lineWidth = 2;
    for (const tile of building.occupiedTiles) {
      ctx.strokeRect(
        tile.x * tileSize + 2,
        tile.y * tileSize + 2,
        tileSize - 4,
        tileSize - 4,
      );
    }
  }
}
```

- [ ] **Step 5: Render buildings and previews**

Modify `src/render/canvas.ts`:

```ts
import { renderBuildings } from "./buildingRenderer";

export function renderGame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const transform = getBoardTransform(ctx.canvas, state.map);

  ctx.save();
  ctx.translate(transform.offsetX, transform.offsetY);
  ctx.scale(transform.scale, transform.scale);
  renderMap(ctx, state);
  renderBuildings(ctx, state);
  renderOverlays(ctx, state, ui);
  renderTransit(ctx, state);
  renderCitizens(ctx, state);
  ctx.restore();
}
```

Modify `src/render/overlayRenderer.ts`:

```ts
import {
  canPlaceBuilding,
  getBuildingFootprint,
} from "../simulation/buildings";
import { stopCoverageRadius } from "../simulation/transit";
```

Use terminal coverage:

```ts
for (const stop of state.transit.stops) {
  fillCoverageArea(ctx, stop.position, stopCoverageRadius(stop));
}
```

Add preview rendering after overlay-specific blocks and before plain hover fallback:

```ts
if (ui.hoverTile !== null && ui.selectedBuilding !== null) {
  const valid = canPlaceBuilding(
    state,
    ui.selectedBuilding,
    ui.hoverTile,
    ui.buildingRotation,
  );
  const footprint = getBuildingFootprint(
    ui.selectedBuilding,
    ui.hoverTile,
    ui.buildingRotation,
  );

  ctx.fillStyle = valid ? colors.previewValid : colors.previewInvalid;
  ctx.strokeStyle = valid
    ? colors.previewValidStroke
    : colors.previewInvalidStroke;
  ctx.lineWidth = 2;

  for (const point of footprint) {
    fillTile(ctx, point);
    ctx.strokeRect(
      point.x * tileSize + 2,
      point.y * tileSize + 2,
      tileSize - 4,
      tileSize - 4,
    );
  }

  return;
}
```

Keep the existing single-tile hover outline for inspect, route, and remove modes.

- [ ] **Step 6: Run render and unit tests**

Run: `bunx vitest run tests/render/canvas.test.ts tests/simulation/buildings.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/render/buildingRenderer.ts src/render/canvas.ts src/render/overlayRenderer.ts src/render/colors.ts tests/render/canvas.test.ts
git commit -m "feat: render building footprints"
```

## Task 5: Control Tower Menu Split

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/ControlTower.svelte`
- Modify: `src/styles.css`
- Modify: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Write failing shell tests for the new Control Tower contract**

Update `tests/ui/appShell.test.ts` harness type imports to include `BuildingType`:

```ts
import type {
  BuildingType,
  GameState,
  Overlay,
  Point,
  Tool,
} from "../../src/domain/types";
```

Inside `createRuntimeHarness`, add runtime methods:

```ts
setBuilding: vi.fn((building: BuildingType) => {
  ui = {
    ...ui,
    activeTool: "inspect",
    selectedBuilding: building,
    buildingRotation: 0,
    draftStopIds: [],
    draftStationIds: [],
  };
  return publish();
}),
rotateBuilding: vi.fn(() => {
  const rotations = [0, 90, 180, 270] as const;
  const currentIndex = rotations.indexOf(ui.buildingRotation);
  ui = {
    ...ui,
    buildingRotation: rotations[(currentIndex + 1) % rotations.length],
  };
  return publish();
}),
```

Add a test:

```ts
it("wires Build and Route Planning menus separately", async () => {
  const { runtime } = createRuntimeHarness();
  render(App, { props: { runtime } });

  await fireEvent.click(screen.getByRole("button", { name: "Large House" }));
  expect(runtime.setBuilding).toHaveBeenCalledWith("largeHouse");
  expect(screen.getByRole("button", { name: "Large House" })).toHaveAttribute(
    "data-building",
    "largeHouse",
  );
  expect(screen.getByText("LARGE HOUSE 0")).toBeVisible();

  await fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
  expect(runtime.rotateBuilding).toHaveBeenCalledTimes(1);

  await fireEvent.click(screen.getByRole("button", { name: "Bus Route" }));
  expect(runtime.setTool).toHaveBeenCalledWith("busRoute");
  expect(screen.getByRole("button", { name: "Bus Route" })).toHaveAttribute(
    "data-tool",
    "busRoute",
  );
});
```

Run: `bunx vitest run tests/ui/appShell.test.ts`

Expected: FAIL on missing `Large House`, `Rotate`, or separated menu behavior.

- [ ] **Step 2: Pass building handlers through App**

Modify `src/App.svelte` imports and handlers:

```svelte
<script lang="ts">
  import type { BuildingType, Overlay, Tool } from "./domain/types";

  function handleSetBuilding(building: BuildingType): void {
    setSnapshot(runtime.setBuilding(building));
  }

  function handleRotateBuilding(): void {
    setSnapshot(runtime.rotateBuilding());
  }
</script>
```

Pass into `<ControlTower />`:

```svelte
<ControlTower
  shell={snapshot.shell.controlTower}
  activeTool={snapshot.ui.activeTool}
  selectedBuilding={snapshot.ui.selectedBuilding}
  buildingRotation={snapshot.ui.buildingRotation}
  activeOverlay={snapshot.ui.activeOverlay}
  onToggleControlTower={handleToggleControlTower}
  onSetTool={handleSetTool}
  onSetBuilding={handleSetBuilding}
  onRotateBuilding={handleRotateBuilding}
  onSetOverlay={handleSetOverlay}
/>
```

- [ ] **Step 3: Rewrite Control Tower control groups**

Modify `src/components/ControlTower.svelte` script:

```svelte
<script lang="ts">
  import { BUILDING_CATALOG } from "../simulation/buildings";
  import type {
    BuildingRotation,
    BuildingType,
    Overlay,
    Tool,
  } from "../domain/types";
  import type { ShellControlTowerState } from "../runtime/types";

  interface Props {
    shell: ShellControlTowerState;
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    activeOverlay: Overlay | null;
    onToggleControlTower: () => void;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  const globalTools: Array<{ id: Tool; label: string }> = [
    { id: "inspect", label: "Inspect" },
    { id: "remove", label: "Remove" },
  ];

  const buildTools: Array<{ id: BuildingType; label: string }> = [
    { id: "busStop", label: BUILDING_CATALOG.busStop.label },
    { id: "busTerminal", label: BUILDING_CATALOG.busTerminal.label },
    { id: "metroStation", label: BUILDING_CATALOG.metroStation.label },
    { id: "smallHouse", label: BUILDING_CATALOG.smallHouse.label },
    { id: "largeHouse", label: BUILDING_CATALOG.largeHouse.label },
  ];

  const routeTools: Array<{ id: Tool; label: string }> = [
    { id: "busRoute", label: "Bus Route" },
    { id: "metroLine", label: "Metro Line" },
  ];

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
    { id: "growth", label: "Growth" },
  ];

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }

  let {
    shell,
    activeTool,
    selectedBuilding,
    buildingRotation,
    activeOverlay,
    onToggleControlTower,
    onSetTool,
    onSetBuilding,
    onRotateBuilding,
    onSetOverlay,
  }: Props = $props();
</script>
```

Replace the old Build section markup with:

```svelte
<section class="panel-section tools-section">
  <h3 class="section-head"><span class="num">01</span> Global</h3>
  <div class="toolbar toolbar--compact" aria-label="Global tools">
    {#each globalTools as tool, index (tool.id)}
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

<section class="panel-section build-section">
  <h3 class="section-head"><span class="num">02</span> Build</h3>
  <div class="toolbar" aria-label="Build tools">
    {#each buildTools as building, index (building.id)}
      <button
        type="button"
        data-building={building.id}
        aria-pressed={selectedBuilding === building.id}
        aria-label={building.label}
        class:active={selectedBuilding === building.id}
        onclick={() => onSetBuilding(building.id)}
      >
        <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
        <span class="tool-label" aria-hidden="true">{building.label}</span>
      </button>
    {/each}
  </div>
  <button
    type="button"
    class="rotate-control"
    aria-label="Rotate"
    disabled={selectedBuilding === null}
    onclick={onRotateBuilding}
  >
    Rotate <span>{buildingRotation}</span>
  </button>
</section>

<section class="panel-section route-section">
  <h3 class="section-head"><span class="num">03</span> Route Planning</h3>
  <div class="toolbar toolbar--compact" aria-label="Route planning tools">
    {#each routeTools as tool, index (tool.id)}
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

Renumber the Overlay heading to `04` and Brief heading to `05`.

- [ ] **Step 4: Update panel grid and rotate styles**

Modify the `.panel` rule in `src/styles.css`:

```css
.panel {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 16px;
  display: grid;
  grid-template-columns:
    150px minmax(160px, 0.45fr) minmax(360px, 1fr)
    minmax(210px, 0.6fr) minmax(230px, 0.65fr) minmax(300px, 0.8fr);
  height: min(36vh, 340px);
  border: 1px solid var(--line-strong);
  background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
  padding: 0;
  overflow: hidden;
  z-index: 8;
  box-shadow: 0 -18px 48px rgba(0, 0, 0, 0.45);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
```

Add:

```css
.toolbar--compact {
  grid-template-columns: 1fr;
}

.build-section .toolbar {
  grid-template-columns: repeat(2, minmax(126px, 1fr));
}

.rotate-control {
  width: 100%;
  margin-top: 8px;
  min-height: 34px;
  border: 1px solid var(--line-strong);
  background: var(--surface-sunk);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
}

.rotate-control:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.rotate-control:disabled {
  cursor: default;
  opacity: 0.38;
}
```

- [ ] **Step 5: Run shell tests**

Run: `bunx vitest run tests/ui/appShell.test.ts tests/runtime/gameRuntime.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/App.svelte src/components/ControlTower.svelte src/styles.css tests/ui/appShell.test.ts
git commit -m "feat: split control tower menus"
```

## Task 6: End-To-End Smoke And Full Verification

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`

- [ ] **Step 1: Update e2e smoke test to use Build menu empty-tile placement**

Modify `tests/e2e/smoke.spec.ts`:

```ts
test("loads the svelte shell and supports active building placement", async ({
  page,
}) => {
  await page.goto(appUrl);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await page.getByRole("button", { name: "Small House" }).click();
  await canvas.click({ position: { x: 40, y: 40 } });

  await expect(topbar.getByText("$116,000")).toBeVisible();
  await expect(topbar.getByText("40")).toBeVisible();

  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.getByRole("button", { name: "Rotate" }).click();
  await expect(page.getByText("BUS TERMINAL 90")).toBeVisible();
});
```

- [ ] **Step 2: Run focused e2e test**

Run: `bun run test:e2e`

Expected: PASS. If the click at `{ x: 40, y: 40 }` lands outside the map on the local viewport, compute the board origin from the canvas bounds in the test and click the center of tile `(0, 0)` using the same `tileSize` scaling logic from `src/render/canvas.ts`.

- [ ] **Step 3: Run the full frontend verification suite**

Run these commands:

```bash
bun run check
bun run lint:svelte
bun run format:check
bun run test
bun run test:e2e
bun run build
```

Expected:

- `bun run check`: PASS with no TypeScript or Svelte errors.
- `bun run lint:svelte`: PASS with no ESLint errors.
- `bun run format:check`: PASS with no Prettier errors.
- `bun run test`: PASS across ui, runtime, simulation, and render projects.
- `bun run test:e2e`: PASS.
- `bun run build`: PASS and Vite emits the production build.

- [ ] **Step 4: Commit final verification updates**

```bash
git add tests/e2e/smoke.spec.ts
git commit -m "test: update building placement smoke"
```

## Self-Review Notes

- Spec coverage: Build menu split is covered by Task 5; Route Planning split by Task 5; rotatable footprints by Tasks 1, 3, and 4; empty full-footprint placement by Task 2; active houses by Task 2; Bus Terminal route compatibility and coverage by Tasks 2 and 4; removal by Task 2; smoke verification by Task 6.
- Scope check: Civic Anchor placement is intentionally omitted from the new menu per the spec. Existing scenario civic tiles remain untouched.
- Type consistency: `BuildingType`, `BuildingRotation`, `PlacedBuilding`, `selectedBuilding`, `buildingRotation`, `setBuilding`, and `rotateBuilding` are the canonical names across tasks.
