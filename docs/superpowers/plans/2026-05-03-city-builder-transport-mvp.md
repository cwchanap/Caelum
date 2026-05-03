# City Builder Transport MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-first MVP of a 2D tile-based growing-suburb transport simulation game with buses, metro, civic anchors, individual citizens, overlays, and win/loss objectives.

**Architecture:** Use a small TypeScript architecture with pure simulation modules separated from canvas rendering and DOM UI. Core state changes happen through typed game actions, deterministic seeded scenario data, and testable simulation ticks.

**Tech Stack:** Bun, Vite, TypeScript, HTML canvas, Vitest, Playwright, CSS modules by file convention using plain CSS.

---

## Source Spec

Design spec: `docs/superpowers/specs/2026-05-03-city-builder-transport-mvp-design.md`

## File Structure

Create these files:

- `package.json` - scripts and dependencies.
- `tsconfig.json` - strict TypeScript config for app, tests, and tooling.
- `vite.config.ts` - Vite and Vitest configuration.
- `playwright.config.ts` - browser smoke test configuration.
- `index.html` - app shell mounting point.
- `src/main.ts` - app bootstrap, game loop, event wiring.
- `src/styles.css` - full-screen game board, toolbar, side panel, top bar.
- `src/domain/types.ts` - shared domain types and constants.
- `src/domain/ids.ts` - deterministic id helpers.
- `src/scenario/growingSuburb.ts` - seeded map, growth waves, starting budget, objectives.
- `src/simulation/gameState.ts` - create initial game state and selectors.
- `src/simulation/map.ts` - tile lookup, placement validation, growth application.
- `src/simulation/transit.ts` - stops, stations, routes, lines, vehicles, actions, stats.
- `src/simulation/router.ts` - deterministic multimodal path finding.
- `src/simulation/citizens.ts` - citizen spawning, trip lifecycle, waiting, transfer, arrival.
- `src/simulation/objectives.ts` - rolling metrics, win/loss state.
- `src/simulation/simulation.ts` - tick orchestration.
- `src/ui/uiState.ts` - active tool, selection, overlays, pointer previews.
- `src/ui/actions.ts` - translate UI intents into validated game actions.
- `src/render/colors.ts` - fixed visual palette for tiles, overlays, routes, entities.
- `src/render/canvas.ts` - canvas setup, coordinate conversion, render entry point.
- `src/render/mapRenderer.ts` - tiles, roads, districts, growth preview.
- `src/render/transitRenderer.ts` - stops, stations, routes, vehicles, crowding.
- `src/render/citizenRenderer.ts` - citizens and trip status markers.
- `src/render/overlayRenderer.ts` - coverage, demand, lateness, crowding overlays.
- `src/ui/panels.ts` - top bar, toolbar, side panel, scenario panel DOM updates.
- `tests/simulation/map.test.ts` - placement and growth tests.
- `tests/simulation/transit.test.ts` - route, line, vehicle, capacity tests.
- `tests/simulation/router.test.ts` - walking, bus, metro, transfer path tests.
- `tests/simulation/citizens.test.ts` - trip lifecycle tests.
- `tests/simulation/objectives.test.ts` - rolling threshold tests.
- `tests/simulation/scenario.test.ts` - seeded scenario integration test.
- `tests/e2e/smoke.spec.ts` - browser smoke test.
- `docs/architecture.md` - short architecture notes for future work.

## Task 1: Project Scaffold And Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `playwright.config.ts`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/styles.css`

- [ ] **Step 1: Create package scripts and dependencies**

Create `package.json`:

```json
{
  "name": "caelum",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc --noEmit && vite build",
    "check": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run tests/simulation",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@vitejs/plugin-legacy": "^6.0.0",
    "vite": "^7.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.52.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create strict TypeScript and Vite config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  test: {
    environment: "node",
    globals: true
  }
});
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
```

- [ ] **Step 3: Create the browser shell**

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Caelum</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `src/main.ts`:

```ts
import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <main class="shell" data-testid="game-shell">
    <section class="topbar" data-testid="topbar">Caelum loading...</section>
    <canvas class="board" data-testid="game-canvas" width="1280" height="800"></canvas>
    <aside class="panel" data-testid="side-panel">Select a tool</aside>
  </main>
`;
```

Create `src/styles.css`:

```css
:root {
  color: #17202a;
  background: #eef1f4;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 960px;
  min-height: 100vh;
  overflow: hidden;
}

.shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  grid-template-rows: 48px minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
}

.topbar {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: #f8fafb;
  border-bottom: 1px solid #cad2db;
  font-size: 14px;
}

.board {
  width: 100%;
  height: 100%;
  background: #dde5ec;
  display: block;
}

.panel {
  border-left: 1px solid #cad2db;
  background: #f8fafb;
  padding: 14px;
  overflow: auto;
}
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`

Expected: dependencies install and `bun.lock` is created.

- [ ] **Step 5: Verify shell builds**

Run: `bun run check`

Expected: PASS with no TypeScript errors.

Run: `bun run build`

Expected: PASS and Vite emits a production build.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock tsconfig.json vite.config.ts playwright.config.ts index.html src/main.ts src/styles.css
git commit -m "chore: scaffold browser game project"
```

## Task 2: Domain Types And Seed Scenario

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/ids.ts`
- Create: `src/scenario/growingSuburb.ts`
- Create: `src/simulation/gameState.ts`
- Test: `tests/simulation/scenario.test.ts`

- [ ] **Step 1: Write failing scenario tests**

Create `tests/simulation/scenario.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";

describe("Growing Suburb scenario", () => {
  it("creates a deterministic starting city", () => {
    const state = createInitialGameState();

    expect(state.scenario.name).toBe("Growing Suburb");
    expect(state.map.width).toBe(28);
    expect(state.map.height).toBe(18);
    expect(state.budget).toBe(120_000);
    expect(state.citizens.length).toBe(36);
    expect(state.scenario.growthWaves).toHaveLength(3);
  });

  it("has residential, job, road, and empty tiles", () => {
    const state = createInitialGameState();
    const kinds = new Set(state.map.tiles.map((tile) => tile.kind));

    expect(kinds.has("residential")).toBe(true);
    expect(kinds.has("jobs")).toBe(true);
    expect(kinds.has("road")).toBe(true);
    expect(kinds.has("empty")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `bun run test:unit -- scenario.test.ts`

Expected: FAIL because `src/simulation/gameState.ts` does not exist.

- [ ] **Step 3: Create shared domain types**

Create `src/domain/types.ts`:

```ts
export type TileKind = "empty" | "road" | "residential" | "jobs" | "civic" | "park";
export type TransitMode = "walk" | "bus" | "metro";
export type CitizenStatus = "idle" | "walking" | "waiting" | "riding" | "arrived" | "late" | "unserved";
export type Tool = "inspect" | "busStop" | "busRoute" | "metroStation" | "metroLine" | "civicAnchor" | "remove";
export type Overlay = "coverage" | "crowding" | "demand" | "lateness" | "growth";

export interface Point {
  x: number;
  y: number;
}

export interface Tile extends Point {
  id: string;
  kind: TileKind;
  districtId?: string;
}

export interface GameMap {
  width: number;
  height: number;
  tiles: Tile[];
}

export interface Stop {
  id: string;
  position: Point;
  queueCitizenIds: string[];
}

export interface Station {
  id: string;
  position: Point;
  queueCitizenIds: string[];
}

export interface Route {
  id: string;
  name: string;
  color: string;
  stopIds: string[];
  vehicleIds: string[];
  active: boolean;
}

export interface MetroLine {
  id: string;
  name: string;
  color: string;
  stationIds: string[];
  vehicleIds: string[];
  active: boolean;
}

export interface Vehicle {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  capacity: number;
  passengerIds: string[];
  segmentIndex: number;
  progress: number;
}

export interface Citizen {
  id: string;
  home: Point;
  destination: Point;
  position: Point;
  status: CitizenStatus;
  patienceRemaining: number;
  deadline: number;
  routePlan: RoutePlan | null;
  currentLegIndex: number;
}

export interface RouteLeg {
  mode: TransitMode;
  from: Point;
  to: Point;
  lineId?: string;
}

export interface RoutePlan {
  legs: RouteLeg[];
  estimatedSeconds: number;
}

export interface GrowthWave {
  id: string;
  triggerTime: number;
  tiles: Array<Tile & { createsCitizens: number }>;
  message: string;
  applied: boolean;
}

export interface Scenario {
  name: string;
  growthWaves: GrowthWave[];
  objectives: {
    maxLateRatio: number;
    maxUnservedRatio: number;
    maxAverageWait: number;
    rollingWindowSeconds: number;
    survivalTime: number;
  };
}

export interface Metrics {
  lateTrips: number;
  completedTrips: number;
  unservedTrips: number;
  totalWaitSeconds: number;
  waitingCitizenCount: number;
  averageWaitSeconds: number;
  state: "running" | "won" | "lost";
  lossReason: string | null;
}

export interface TransitNetwork {
  stops: Stop[];
  stations: Station[];
  routes: Route[];
  metroLines: MetroLine[];
  vehicles: Vehicle[];
}

export interface GameState {
  time: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  scenario: Scenario;
  transit: TransitNetwork;
  citizens: Citizen[];
  metrics: Metrics;
}
```

Create `src/domain/ids.ts`:

```ts
export function tileId(x: number, y: number): string {
  return `tile-${x}-${y}`;
}

export function entityId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}
```

- [ ] **Step 4: Create the Growing Suburb seed**

Create `src/scenario/growingSuburb.ts` with deterministic map generation:

```ts
import { entityId, tileId } from "../domain/ids";
import type { Citizen, GameMap, GrowthWave, Scenario, Tile, TileKind } from "../domain/types";

const width = 28;
const height = 18;

function kindFor(x: number, y: number): TileKind {
  if (y === 8 || x === 7 || x === 15 || x === 22) return "road";
  if (x >= 2 && x <= 5 && y >= 3 && y <= 6) return "residential";
  if (x >= 10 && x <= 13 && y >= 4 && y <= 7) return "jobs";
  if (x >= 18 && x <= 20 && y >= 10 && y <= 12) return "civic";
  if (x >= 4 && x <= 6 && y >= 12 && y <= 14) return "park";
  return "empty";
}

export function createGrowingSuburbMap(): GameMap {
  const tiles: Tile[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({ id: tileId(x, y), x, y, kind: kindFor(x, y) });
    }
  }

  return { width, height, tiles };
}

export function createStartingCitizens(): Citizen[] {
  const homes = [
    { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 },
    { x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 },
    { x: 2, y: 5 }, { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 }
  ];
  const destinations = [
    { x: 10, y: 4 }, { x: 11, y: 4 }, { x: 12, y: 4 },
    { x: 10, y: 5 }, { x: 11, y: 5 }, { x: 12, y: 5 },
    { x: 18, y: 10 }, { x: 19, y: 10 }, { x: 20, y: 10 }
  ];

  return Array.from({ length: 36 }, (_, index) => {
    const home = homes[index % homes.length];
    const destination = destinations[index % destinations.length];
    return {
      id: entityId("citizen", index + 1),
      home,
      destination,
      position: home,
      status: "idle",
      patienceRemaining: 240,
      deadline: 900,
      routePlan: null,
      currentLegIndex: 0
    };
  });
}

export function createGrowingSuburbWaves(): GrowthWave[] {
  return [
    {
      id: "wave-north",
      triggerTime: 240,
      message: "North homes open",
      applied: false,
      tiles: [
        { id: tileId(8, 2), x: 8, y: 2, kind: "residential", createsCitizens: 8 },
        { id: tileId(9, 2), x: 9, y: 2, kind: "residential", createsCitizens: 8 },
        { id: tileId(10, 2), x: 10, y: 2, kind: "residential", createsCitizens: 8 }
      ]
    },
    {
      id: "wave-east-jobs",
      triggerTime: 540,
      message: "East office park opens",
      applied: false,
      tiles: [
        { id: tileId(23, 5), x: 23, y: 5, kind: "jobs", createsCitizens: 0 },
        { id: tileId(24, 5), x: 24, y: 5, kind: "jobs", createsCitizens: 0 }
      ]
    },
    {
      id: "wave-south",
      triggerTime: 840,
      message: "South suburb opens",
      applied: false,
      tiles: [
        { id: tileId(16, 14), x: 16, y: 14, kind: "residential", createsCitizens: 10 },
        { id: tileId(17, 14), x: 17, y: 14, kind: "residential", createsCitizens: 10 }
      ]
    }
  ];
}

export function createGrowingSuburbScenario(): Scenario {
  return {
    name: "Growing Suburb",
    growthWaves: createGrowingSuburbWaves(),
    objectives: {
      maxLateRatio: 0.25,
      maxUnservedRatio: 0.2,
      maxAverageWait: 180,
      rollingWindowSeconds: 300,
      survivalTime: 1_200
    }
  };
}
```

- [ ] **Step 5: Create initial game state**

Create `src/simulation/gameState.ts`:

```ts
import type { GameState, Metrics, TransitNetwork } from "../domain/types";
import { createGrowingSuburbMap, createGrowingSuburbScenario, createStartingCitizens } from "../scenario/growingSuburb";

function createEmptyTransitNetwork(): TransitNetwork {
  return {
    stops: [],
    stations: [],
    routes: [],
    metroLines: [],
    vehicles: []
  };
}

function createInitialMetrics(): Metrics {
  return {
    lateTrips: 0,
    completedTrips: 0,
    unservedTrips: 0,
    totalWaitSeconds: 0,
    waitingCitizenCount: 0,
    averageWaitSeconds: 0,
    state: "running",
    lossReason: null
  };
}

export function createInitialGameState(): GameState {
  return {
    time: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: createGrowingSuburbMap(),
    scenario: createGrowingSuburbScenario(),
    transit: createEmptyTransitNetwork(),
    citizens: createStartingCitizens(),
    metrics: createInitialMetrics()
  };
}
```

- [ ] **Step 6: Verify test passes**

Run: `bun run test:unit -- scenario.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/domain/ids.ts src/scenario/growingSuburb.ts src/simulation/gameState.ts tests/simulation/scenario.test.ts
git commit -m "feat: add deterministic growing suburb scenario"
```

## Task 3: Map Rules, Growth Waves, And Placement Validation

**Files:**
- Modify: `src/simulation/map.ts`
- Modify: `src/simulation/gameState.ts`
- Test: `tests/simulation/map.test.ts`

- [ ] **Step 1: Write failing map tests**

Create `tests/simulation/map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { applyDueGrowthWaves, getTile, isValidBusStopPlacement, isValidCivicAnchorPlacement, isValidMetroStationPlacement } from "../../src/simulation/map";

describe("map rules", () => {
  it("finds tiles by coordinate", () => {
    const state = createInitialGameState();
    expect(getTile(state.map, { x: 7, y: 8 })?.kind).toBe("road");
    expect(getTile(state.map, { x: -1, y: 8 })).toBeNull();
  });

  it("allows bus stops only on road tiles", () => {
    const state = createInitialGameState();
    expect(isValidBusStopPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidBusStopPlacement(state, { x: 2, y: 3 })).toBe(false);
  });

  it("allows metro stations on road or empty tiles", () => {
    const state = createInitialGameState();
    expect(isValidMetroStationPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 2, y: 3 })).toBe(false);
  });

  it("allows civic anchors on empty tiles only", () => {
    const state = createInitialGameState();
    expect(isValidCivicAnchorPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidCivicAnchorPlacement(state, { x: 7, y: 8 })).toBe(false);
  });

  it("applies due growth waves once", () => {
    const state = createInitialGameState();
    const grown = applyDueGrowthWaves({ ...state, time: 250 });
    const grownAgain = applyDueGrowthWaves({ ...grown, time: 300 });

    expect(getTile(grown.map, { x: 8, y: 2 })?.kind).toBe("residential");
    expect(grown.citizens.length).toBe(60);
    expect(grownAgain.citizens.length).toBe(60);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- map.test.ts`

Expected: FAIL because `src/simulation/map.ts` does not exist.

- [ ] **Step 3: Implement map helpers**

Create `src/simulation/map.ts`:

```ts
import { entityId } from "../domain/ids";
import type { Citizen, GameMap, GameState, Point, Tile } from "../domain/types";

export function getTile(map: GameMap, point: Point): Tile | null {
  if (point.x < 0 || point.y < 0 || point.x >= map.width || point.y >= map.height) {
    return null;
  }
  return map.tiles.find((tile) => tile.x === point.x && tile.y === point.y) ?? null;
}

export function isValidBusStopPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  const occupied = state.transit.stops.some((stop) => stop.position.x === point.x && stop.position.y === point.y);
  return tile?.kind === "road" && !occupied;
}

export function isValidMetroStationPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  const occupied = state.transit.stations.some((station) => station.position.x === point.x && station.position.y === point.y);
  return (tile?.kind === "road" || tile?.kind === "empty") && !occupied;
}

export function isValidCivicAnchorPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return tile?.kind === "empty";
}

function createWaveCitizens(state: GameState, waveTile: Tile & { createsCitizens: number }): Citizen[] {
  if (waveTile.createsCitizens <= 0) return [];

  const destinations = state.map.tiles.filter((tile) => tile.kind === "jobs" || tile.kind === "civic");
  return Array.from({ length: waveTile.createsCitizens }, (_, index) => {
    const destination = destinations[index % destinations.length] ?? waveTile;
    return {
      id: entityId("citizen", state.citizens.length + index + 1),
      home: { x: waveTile.x, y: waveTile.y },
      destination: { x: destination.x, y: destination.y },
      position: { x: waveTile.x, y: waveTile.y },
      status: "idle",
      patienceRemaining: 240,
      deadline: state.time + 900,
      routePlan: null,
      currentLegIndex: 0
    };
  });
}

export function applyDueGrowthWaves(state: GameState): GameState {
  let changed = false;
  let citizens = state.citizens;
  const tiles = state.map.tiles.map((tile) => ({ ...tile }));

  const growthWaves = state.scenario.growthWaves.map((wave) => {
    if (wave.applied || state.time < wave.triggerTime) {
      return wave;
    }

    changed = true;
    for (const waveTile of wave.tiles) {
      const tile = tiles.find((candidate) => candidate.id === waveTile.id);
      if (tile) {
        tile.kind = waveTile.kind;
      }
      citizens = citizens.concat(createWaveCitizens(state, waveTile));
    }
    return { ...wave, applied: true };
  });

  if (!changed) {
    return state;
  }

  return {
    ...state,
    citizens,
    map: { ...state.map, tiles },
    scenario: { ...state.scenario, growthWaves }
  };
}
```

- [ ] **Step 4: Verify map tests**

Run: `bun run test:unit -- map.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/map.ts tests/simulation/map.test.ts
git commit -m "feat: add map placement and growth rules"
```

## Task 4: Transit Network Actions

**Files:**
- Create: `src/simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write failing transit tests**

Create `tests/simulation/transit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation, assignVehicle } from "../../src/simulation/transit";

describe("transit actions", () => {
  it("adds bus stops and spends budget", () => {
    const state = createInitialGameState();
    const next = addBusStop(state, { x: 7, y: 8 });

    expect(next.transit.stops).toHaveLength(1);
    expect(next.budget).toBe(118_000);
  });

  it("blocks invalid bus stop placement without changing state", () => {
    const state = createInitialGameState();
    expect(addBusStop(state, { x: 2, y: 3 })).toBe(state);
  });

  it("creates an active bus route with two stops and one assigned bus", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    expect(state.transit.routes[0].active).toBe(true);
    expect(state.transit.routes[0].vehicleIds).toEqual(["vehicle-001"]);
    expect(state.transit.vehicles[0].capacity).toBe(18);
  });

  it("creates a metro line and train", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = assignVehicle(state, "metro", "metro-001");

    expect(state.transit.metroLines[0].active).toBe(true);
    expect(state.transit.vehicles[0].capacity).toBe(90);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- transit.test.ts`

Expected: FAIL because `src/simulation/transit.ts` does not exist.

- [ ] **Step 3: Implement transit actions**

Create `src/simulation/transit.ts`:

```ts
import { entityId } from "../domain/ids";
import type { GameState, MetroLine, Point, Route, Station, Stop, Vehicle } from "../domain/types";
import { isValidBusStopPlacement, isValidMetroStationPlacement } from "./map";

const costs = {
  busStop: 2_000,
  metroStation: 25_000,
  bus: 8_000,
  metro: 50_000
};

export function addBusStop(state: GameState, position: Point): GameState {
  if (!isValidBusStopPlacement(state, position) || state.budget < costs.busStop) return state;
  const stop: Stop = {
    id: entityId("stop", state.transit.stops.length + 1),
    position,
    queueCitizenIds: []
  };
  return {
    ...state,
    budget: state.budget - costs.busStop,
    transit: { ...state.transit, stops: [...state.transit.stops, stop] }
  };
}

export function addMetroStation(state: GameState, position: Point): GameState {
  if (!isValidMetroStationPlacement(state, position) || state.budget < costs.metroStation) return state;
  const station: Station = {
    id: entityId("station", state.transit.stations.length + 1),
    position,
    queueCitizenIds: []
  };
  return {
    ...state,
    budget: state.budget - costs.metroStation,
    transit: { ...state.transit, stations: [...state.transit.stations, station] }
  };
}

export function addBusRoute(state: GameState, stopIds: string[]): GameState {
  const validStopIds = new Set(state.transit.stops.map((stop) => stop.id));
  const active = stopIds.length >= 2 && stopIds.every((id) => validStopIds.has(id));
  const route: Route = {
    id: entityId("route", state.transit.routes.length + 1),
    name: `Bus ${state.transit.routes.length + 1}`,
    color: "#e04f39",
    stopIds,
    vehicleIds: [],
    active
  };
  return { ...state, transit: { ...state.transit, routes: [...state.transit.routes, route] } };
}

export function addMetroLine(state: GameState, stationIds: string[]): GameState {
  const validStationIds = new Set(state.transit.stations.map((station) => station.id));
  const active = stationIds.length >= 2 && stationIds.every((id) => validStationIds.has(id));
  const line: MetroLine = {
    id: entityId("metro", state.transit.metroLines.length + 1),
    name: `Metro ${state.transit.metroLines.length + 1}`,
    color: "#2867b2",
    stationIds,
    vehicleIds: [],
    active
  };
  return { ...state, transit: { ...state.transit, metroLines: [...state.transit.metroLines, line] } };
}

export function assignVehicle(state: GameState, mode: "bus" | "metro", lineId: string): GameState {
  const cost = mode === "bus" ? costs.bus : costs.metro;
  if (state.budget < cost) return state;

  const vehicle: Vehicle = {
    id: entityId("vehicle", state.transit.vehicles.length + 1),
    mode,
    lineId,
    capacity: mode === "bus" ? 18 : 90,
    passengerIds: [],
    segmentIndex: 0,
    progress: 0
  };

  const routes = state.transit.routes.map((route) =>
    route.id === lineId ? { ...route, vehicleIds: [...route.vehicleIds, vehicle.id] } : route
  );
  const metroLines = state.transit.metroLines.map((line) =>
    line.id === lineId ? { ...line, vehicleIds: [...line.vehicleIds, vehicle.id] } : line
  );

  const lineExists = routes.some((route) => route.id === lineId) || metroLines.some((line) => line.id === lineId);
  if (!lineExists) return state;

  return {
    ...state,
    budget: state.budget - cost,
    transit: {
      ...state.transit,
      routes,
      metroLines,
      vehicles: [...state.transit.vehicles, vehicle]
    }
  };
}
```

- [ ] **Step 4: Verify transit tests**

Run: `bun run test:unit -- transit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: add transit network actions"
```

## Task 5: Multimodal Router

**Files:**
- Create: `src/simulation/router.ts`
- Test: `tests/simulation/router.test.ts`

- [ ] **Step 1: Write failing router tests**

Create `tests/simulation/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { findRoutePlan } from "../../src/simulation/router";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation } from "../../src/simulation/transit";

describe("router", () => {
  it("returns a walking route for nearby destinations", () => {
    const state = createInitialGameState();
    const plan = findRoutePlan(state, { x: 2, y: 3 }, { x: 4, y: 3 });

    expect(plan?.legs).toEqual([{ mode: "walk", from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }]);
  });

  it("uses a bus line when stops connect origin and destination", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 16, y: 8 });

    expect(plan?.legs.map((leg) => leg.mode)).toEqual(["walk", "bus", "walk"]);
    expect(plan?.legs[1].lineId).toBe("route-001");
  });

  it("prefers metro for long station-connected trips", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });

    expect(plan?.legs.map((leg) => leg.mode)).toEqual(["walk", "metro", "walk"]);
    expect(plan?.legs[1].lineId).toBe("metro-001");
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- router.test.ts`

Expected: FAIL because `findRoutePlan` is not defined.

- [ ] **Step 3: Implement deterministic routing**

Create `src/simulation/router.ts`:

```ts
import type { GameState, Point, RouteLeg, RoutePlan, TransitMode } from "../domain/types";

function distance(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function secondsFor(mode: TransitMode, distanceTiles: number): number {
  if (mode === "walk") return distanceTiles * 20;
  if (mode === "bus") return 90 + distanceTiles * 12;
  return 120 + distanceTiles * 7;
}

function walkingPlan(origin: Point, destination: Point): RoutePlan {
  const dist = distance(origin, destination);
  return {
    legs: [{ mode: "walk", from: origin, to: destination }],
    estimatedSeconds: secondsFor("walk", dist)
  };
}

export function findRoutePlan(state: GameState, origin: Point, destination: Point): RoutePlan | null {
  const candidates: RoutePlan[] = [walkingPlan(origin, destination)];

  for (const route of state.transit.routes.filter((candidate) => candidate.active)) {
    const stops = route.stopIds
      .map((id) => state.transit.stops.find((stop) => stop.id === id))
      .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop));
    if (stops.length < 2) continue;

    const start = stops.reduce((best, stop) => distance(origin, stop.position) < distance(origin, best.position) ? stop : best, stops[0]);
    const end = stops.reduce((best, stop) => distance(destination, stop.position) < distance(destination, best.position) ? stop : best, stops[0]);
    if (start.id === end.id) continue;

    const legs: RouteLeg[] = [
      { mode: "walk", from: origin, to: start.position },
      { mode: "bus", from: start.position, to: end.position, lineId: route.id },
      { mode: "walk", from: end.position, to: destination }
    ];
    candidates.push({
      legs,
      estimatedSeconds: legs.reduce((sum, leg) => sum + secondsFor(leg.mode, distance(leg.from, leg.to)), 0)
    });
  }

  for (const line of state.transit.metroLines.filter((candidate) => candidate.active)) {
    const stations = line.stationIds
      .map((id) => state.transit.stations.find((station) => station.id === id))
      .filter((station): station is NonNullable<typeof station> => Boolean(station));
    if (stations.length < 2) continue;

    const start = stations.reduce((best, station) => distance(origin, station.position) < distance(origin, best.position) ? station : best, stations[0]);
    const end = stations.reduce((best, station) => distance(destination, station.position) < distance(destination, best.position) ? station : best, stations[0]);
    if (start.id === end.id) continue;

    const legs: RouteLeg[] = [
      { mode: "walk", from: origin, to: start.position },
      { mode: "metro", from: start.position, to: end.position, lineId: line.id },
      { mode: "walk", from: end.position, to: destination }
    ];
    candidates.push({
      legs,
      estimatedSeconds: legs.reduce((sum, leg) => sum + secondsFor(leg.mode, distance(leg.from, leg.to)), 0)
    });
  }

  return candidates.sort((a, b) => a.estimatedSeconds - b.estimatedSeconds)[0] ?? null;
}
```

- [ ] **Step 4: Verify router tests**

Run: `bun run test:unit -- router.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/router.ts tests/simulation/router.test.ts
git commit -m "feat: add deterministic multimodal routing"
```

## Task 6: Citizen Trip Lifecycle

**Files:**
- Create: `src/simulation/citizens.ts`
- Test: `tests/simulation/citizens.test.ts`

- [ ] **Step 1: Write failing citizen tests**

Create `tests/simulation/citizens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { tickCitizens } from "../../src/simulation/citizens";

describe("citizen lifecycle", () => {
  it("plans a route and starts walking from idle", () => {
    const state = createInitialGameState();
    const next = tickCitizens(state, 1);

    expect(next.citizens[0].routePlan).not.toBeNull();
    expect(next.citizens[0].status).toBe("walking");
  });

  it("marks unreachable long trips unserved when no transit exists", () => {
    const state = createInitialGameState();
    const next = tickCitizens({
      ...state,
      time: 101,
      citizens: state.citizens.map((citizen, index) =>
        index === 0 ? { ...citizen, deadline: 100, destination: { x: 27, y: 17 } } : citizen
      )
    }, 1);

    expect(next.citizens.some((citizen) => citizen.status === "unserved")).toBe(true);
    expect(next.metrics.unservedTrips).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- citizens.test.ts`

Expected: FAIL because `tickCitizens` is not defined.

- [ ] **Step 3: Implement citizen lifecycle**

Create `src/simulation/citizens.ts`:

```ts
import type { Citizen, GameState, Point } from "../domain/types";
import { findRoutePlan } from "./router";

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function stepToward(position: Point, target: Point): Point {
  if (position.x < target.x) return { x: position.x + 1, y: position.y };
  if (position.x > target.x) return { x: position.x - 1, y: position.y };
  if (position.y < target.y) return { x: position.x, y: position.y + 1 };
  if (position.y > target.y) return { x: position.x, y: position.y - 1 };
  return position;
}

function walkingOnlyTooLong(citizen: Citizen): boolean {
  return citizen.routePlan?.legs.length === 1 && citizen.routePlan.estimatedSeconds > citizen.deadline;
}

export function tickCitizens(state: GameState, deltaSeconds: number): GameState {
  let unservedTrips = state.metrics.unservedTrips;
  let lateTrips = state.metrics.lateTrips;
  let completedTrips = state.metrics.completedTrips;
  let totalWaitSeconds = state.metrics.totalWaitSeconds;

  const citizens = state.citizens.map((citizen) => {
    if (citizen.status === "arrived" || citizen.status === "late" || citizen.status === "unserved") {
      return citizen;
    }

    let next: Citizen = citizen;

    if (!next.routePlan) {
      const routePlan = findRoutePlan(state, next.home, next.destination);
      if (!routePlan) {
        unservedTrips += 1;
        return { ...next, status: "unserved" };
      }
      next = { ...next, routePlan, status: "walking", currentLegIndex: 0 };
      if (walkingOnlyTooLong(next) && state.time >= next.deadline) {
        unservedTrips += 1;
        return { ...next, status: "unserved" };
      }
    }

    const leg = next.routePlan.legs[next.currentLegIndex];
    if (!leg) {
      completedTrips += 1;
      const arrivedStatus = state.time <= next.deadline ? "arrived" : "late";
      if (arrivedStatus === "late") lateTrips += 1;
      return { ...next, status: arrivedStatus, position: next.destination };
    }

    if (leg.mode === "walk") {
      const position = stepToward(next.position, leg.to);
      if (samePoint(position, leg.to)) {
        return { ...next, position, currentLegIndex: next.currentLegIndex + 1, status: "waiting" };
      }
      return { ...next, position, status: "walking" };
    }

    totalWaitSeconds += deltaSeconds;
    const patienceRemaining = next.patienceRemaining - deltaSeconds;
    if (patienceRemaining <= 0 || state.time > next.deadline + 300) {
      unservedTrips += 1;
      return { ...next, patienceRemaining: 0, status: "unserved" };
    }
    return { ...next, patienceRemaining, status: "waiting" };
  });

  const waitingCitizenCount = citizens.filter((citizen) => citizen.status === "waiting").length;
  return {
    ...state,
    citizens,
    metrics: {
      ...state.metrics,
      unservedTrips,
      lateTrips,
      completedTrips,
      totalWaitSeconds,
      waitingCitizenCount,
      averageWaitSeconds: waitingCitizenCount === 0 ? 0 : totalWaitSeconds / waitingCitizenCount
    }
  };
}
```

- [ ] **Step 4: Verify citizen tests**

Run: `bun run test:unit -- citizens.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/simulation/citizens.ts tests/simulation/citizens.test.ts
git commit -m "feat: add citizen trip lifecycle"
```

## Task 7: Vehicle Movement, Boarding, And Transfers

**Files:**
- Modify: `src/simulation/transit.ts`
- Modify: `src/simulation/citizens.ts`
- Test: `tests/simulation/transit.test.ts`
- Test: `tests/simulation/citizens.test.ts`

- [ ] **Step 1: Extend failing tests for boarding**

Append to `tests/simulation/transit.test.ts`:

```ts
import { tickVehicles } from "../../src/simulation/transit";

describe("vehicle movement", () => {
  it("moves vehicles along their assigned line", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    const next = tickVehicles(state, 30);

    expect(next.transit.vehicles[0].progress).toBeGreaterThan(0);
  });

  it("boards waiting citizens up to capacity", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");
    state = {
      ...state,
      citizens: state.citizens.map((citizen, index) =>
        index < 20
          ? {
              ...citizen,
              position: { x: 7, y: 8 },
              status: "waiting",
              routePlan: {
                estimatedSeconds: 240,
                legs: [
                  { mode: "walk", from: citizen.home, to: { x: 7, y: 8 } },
                  { mode: "bus", from: { x: 7, y: 8 }, to: { x: 15, y: 8 }, lineId: "route-001" },
                  { mode: "walk", from: { x: 15, y: 8 }, to: citizen.destination }
                ]
              },
              currentLegIndex: 1
            }
          : citizen
      )
    };

    const next = tickVehicles(state, 1);

    expect(next.transit.vehicles[0].passengerIds).toHaveLength(18);
    expect(next.citizens.filter((citizen) => citizen.status === "riding")).toHaveLength(18);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- transit.test.ts`

Expected: FAIL because `tickVehicles` is not defined.

- [ ] **Step 3: Implement vehicle tick and boarding**

Append to `src/simulation/transit.ts`:

```ts
import type { Citizen, RouteLeg } from "../domain/types";

function legMatchesVehicle(leg: RouteLeg | undefined, lineId: string): boolean {
  return Boolean(leg && (leg.mode === "bus" || leg.mode === "metro") && leg.lineId === lineId);
}

function boardWaitingCitizens(state: GameState, vehicle: Vehicle): { vehicle: Vehicle; citizens: Citizen[] } {
  const availableSeats = vehicle.capacity - vehicle.passengerIds.length;
  if (availableSeats <= 0) return { vehicle, citizens: state.citizens };

  const boardingIds: string[] = [];
  const citizens = state.citizens.map((citizen) => {
    const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
    if (
      boardingIds.length < availableSeats &&
      citizen.status === "waiting" &&
      legMatchesVehicle(leg, vehicle.lineId)
    ) {
      boardingIds.push(citizen.id);
      return { ...citizen, status: "riding" as const };
    }
    return citizen;
  });

  return {
    vehicle: { ...vehicle, passengerIds: [...vehicle.passengerIds, ...boardingIds] },
    citizens
  };
}

function routeForVehicle(state: GameState, vehicle: Vehicle): Route | MetroLine | null {
  return state.transit.routes.find((route) => route.id === vehicle.lineId) ??
    state.transit.metroLines.find((line) => line.id === vehicle.lineId) ??
    null;
}

export function tickVehicles(state: GameState, deltaSeconds: number): GameState {
  let citizens = state.citizens;
  const vehicles = state.transit.vehicles.map((vehicle) => {
    const boarded = boardWaitingCitizens({ ...state, citizens }, vehicle);
    citizens = boarded.citizens;
    const assigned = routeForVehicle(state, boarded.vehicle);
    if (!assigned || !assigned.active) return boarded.vehicle;

    const speed = boarded.vehicle.mode === "bus" ? 0.08 : 0.14;
    const progress = boarded.vehicle.progress + speed * deltaSeconds;
    if (progress < 1) {
      return { ...boarded.vehicle, progress };
    }

    const stopCount = "stopIds" in assigned ? assigned.stopIds.length : assigned.stationIds.length;
    const segmentIndex = (boarded.vehicle.segmentIndex + 1) % Math.max(1, stopCount);
    citizens = citizens.map((citizen) =>
      boarded.vehicle.passengerIds.includes(citizen.id)
        ? { ...citizen, status: "walking" as const, currentLegIndex: citizen.currentLegIndex + 1 }
        : citizen
    );
    return { ...boarded.vehicle, passengerIds: [], progress: 0, segmentIndex };
  });

  return { ...state, citizens, transit: { ...state.transit, vehicles } };
}
```

- [ ] **Step 4: Verify vehicle tests**

Run: `bun run test:unit -- transit.test.ts`

Expected: PASS.

- [ ] **Step 5: Run citizen tests to catch lifecycle regressions**

Run: `bun run test:unit -- citizens.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/simulation/transit.ts src/simulation/citizens.ts tests/simulation/transit.test.ts tests/simulation/citizens.test.ts
git commit -m "feat: move vehicles and board passengers"
```

## Task 8: Objectives And Simulation Tick

**Files:**
- Create: `src/simulation/objectives.ts`
- Create: `src/simulation/simulation.ts`
- Test: `tests/simulation/objectives.test.ts`
- Modify: `tests/simulation/scenario.test.ts`

- [ ] **Step 1: Write objective tests**

Create `tests/simulation/objectives.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { evaluateObjectives } from "../../src/simulation/objectives";

describe("objectives", () => {
  it("wins after survival time when thresholds are healthy", () => {
    const state = createInitialGameState();
    const next = evaluateObjectives({ ...state, time: 1_201 });

    expect(next.metrics.state).toBe("won");
  });

  it("loses when unserved ratio is too high", () => {
    const state = createInitialGameState();
    const next = evaluateObjectives({
      ...state,
      metrics: { ...state.metrics, completedTrips: 10, unservedTrips: 10 }
    });

    expect(next.metrics.state).toBe("lost");
    expect(next.metrics.lossReason).toBe("Too many unserved citizens");
  });
});
```

Append to `tests/simulation/scenario.test.ts`:

```ts
import { tickSimulation } from "../../src/simulation/simulation";

describe("simulation tick", () => {
  it("advances time and applies growth", () => {
    const state = createInitialGameState();
    const next = tickSimulation({ ...state, paused: false }, 250);

    expect(next.time).toBe(250);
    expect(next.citizens.length).toBe(60);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `bun run test:unit -- objectives.test.ts scenario.test.ts`

Expected: FAIL because `objectives.ts` and `simulation.ts` do not exist.

- [ ] **Step 3: Implement objectives**

Create `src/simulation/objectives.ts`:

```ts
import type { GameState } from "../domain/types";

export function evaluateObjectives(state: GameState): GameState {
  if (state.metrics.state !== "running") return state;

  const totalTrips = state.metrics.completedTrips + state.metrics.lateTrips + state.metrics.unservedTrips;
  const lateRatio = totalTrips === 0 ? 0 : state.metrics.lateTrips / totalTrips;
  const unservedRatio = totalTrips === 0 ? 0 : state.metrics.unservedTrips / totalTrips;

  if (totalTrips >= 10 && unservedRatio > state.scenario.objectives.maxUnservedRatio) {
    return {
      ...state,
      metrics: { ...state.metrics, state: "lost", lossReason: "Too many unserved citizens" }
    };
  }

  if (totalTrips >= 10 && lateRatio > state.scenario.objectives.maxLateRatio) {
    return {
      ...state,
      metrics: { ...state.metrics, state: "lost", lossReason: "Too many late arrivals" }
    };
  }

  if (
    state.metrics.waitingCitizenCount > 0 &&
    state.metrics.averageWaitSeconds > state.scenario.objectives.maxAverageWait
  ) {
    return {
      ...state,
      metrics: { ...state.metrics, state: "lost", lossReason: "Average wait time is too high" }
    };
  }

  if (state.time >= state.scenario.objectives.survivalTime) {
    return {
      ...state,
      metrics: { ...state.metrics, state: "won", lossReason: null }
    };
  }

  return state;
}
```

- [ ] **Step 4: Implement simulation tick**

Create `src/simulation/simulation.ts`:

```ts
import type { GameState } from "../domain/types";
import { tickCitizens } from "./citizens";
import { applyDueGrowthWaves } from "./map";
import { evaluateObjectives } from "./objectives";
import { tickVehicles } from "./transit";

export function tickSimulation(state: GameState, deltaSeconds: number): GameState {
  if (state.paused || state.metrics.state !== "running" || state.speed === 0) {
    return state;
  }

  const scaledDelta = deltaSeconds * state.speed;
  const advanced = { ...state, time: state.time + scaledDelta };
  const grown = applyDueGrowthWaves(advanced);
  const movedVehicles = tickVehicles(grown, scaledDelta);
  const movedCitizens = tickCitizens(movedVehicles, scaledDelta);
  return evaluateObjectives(movedCitizens);
}
```

- [ ] **Step 5: Verify objectives and scenario tests**

Run: `bun run test:unit -- objectives.test.ts scenario.test.ts`

Expected: PASS.

- [ ] **Step 6: Run all unit tests**

Run: `bun run test:unit`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/simulation/objectives.ts src/simulation/simulation.ts tests/simulation/objectives.test.ts tests/simulation/scenario.test.ts
git commit -m "feat: add simulation tick and objectives"
```

## Task 9: Canvas Rendering

**Files:**
- Create: `src/render/colors.ts`
- Create: `src/render/canvas.ts`
- Create: `src/render/mapRenderer.ts`
- Create: `src/render/transitRenderer.ts`
- Create: `src/render/citizenRenderer.ts`
- Create: `src/render/overlayRenderer.ts`

- [ ] **Step 1: Add render palette**

Create `src/render/colors.ts`:

```ts
export const colors = {
  empty: "#d7e2df",
  road: "#5f6d75",
  residential: "#8bcf8b",
  jobs: "#d8b45f",
  civic: "#82a7d8",
  park: "#4f9a61",
  grid: "#b6c2c8",
  bus: "#e04f39",
  metro: "#2867b2",
  citizen: "#1e2a32",
  late: "#b92e35",
  unserved: "#6f2c8f",
  coverage: "rgba(40, 103, 178, 0.18)",
  crowding: "rgba(224, 79, 57, 0.2)",
  demand: "rgba(216, 180, 95, 0.24)",
  lateness: "rgba(185, 46, 53, 0.24)",
  growth: "rgba(79, 154, 97, 0.25)"
};
```

- [ ] **Step 2: Add canvas infrastructure**

Create `src/render/canvas.ts`:

```ts
import type { GameState, Point } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { renderCitizens } from "./citizenRenderer";
import { renderMap } from "./mapRenderer";
import { renderOverlays } from "./overlayRenderer";
import { renderTransit } from "./transitRenderer";

export const tileSize = 32;

export function canvasToTile(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.floor(((clientX - rect.left) * scaleX) / tileSize),
    y: Math.floor(((clientY - rect.top) * scaleY) / tileSize)
  };
}

export function renderGame(ctx: CanvasRenderingContext2D, state: GameState, ui: UiState): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  renderMap(ctx, state);
  renderOverlays(ctx, state, ui);
  renderTransit(ctx, state);
  renderCitizens(ctx, state);
}
```

- [ ] **Step 3: Add map renderer**

Create `src/render/mapRenderer.ts`:

```ts
import type { GameState } from "../domain/types";
import { colors } from "./colors";
import { tileSize } from "./canvas";

export function renderMap(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const tile of state.map.tiles) {
    ctx.fillStyle = colors[tile.kind];
    ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }
}
```

- [ ] **Step 4: Add transit renderer**

Create `src/render/transitRenderer.ts`:

```ts
import type { GameState, Point } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function center(point: Point): Point {
  return { x: point.x * tileSize + tileSize / 2, y: point.y * tileSize + tileSize / 2 };
}

export function renderTransit(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const route of state.transit.routes) {
    ctx.strokeStyle = route.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    route.stopIds.forEach((id, index) => {
      const stop = state.transit.stops.find((candidate) => candidate.id === id);
      if (!stop) return;
      const point = center(stop.position);
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }

  for (const line of state.transit.metroLines) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 8;
    ctx.beginPath();
    line.stationIds.forEach((id, index) => {
      const station = state.transit.stations.find((candidate) => candidate.id === id);
      if (!station) return;
      const point = center(station.position);
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
  }

  for (const stop of state.transit.stops) {
    const point = center(stop.position);
    ctx.fillStyle = colors.bus;
    ctx.fillRect(point.x - 5, point.y - 5, 10, 10);
  }

  for (const station of state.transit.stations) {
    const point = center(station.position);
    ctx.fillStyle = colors.metro;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const vehicle of state.transit.vehicles) {
    ctx.fillStyle = vehicle.mode === "bus" ? colors.bus : colors.metro;
    const anchor = vehicle.mode === "bus" ? state.transit.stops[vehicle.segmentIndex]?.position : state.transit.stations[vehicle.segmentIndex]?.position;
    if (!anchor) continue;
    const point = center(anchor);
    ctx.fillRect(point.x - 7, point.y - 14, 14, 8);
  }
}
```

- [ ] **Step 5: Add citizen renderer**

Create `src/render/citizenRenderer.ts`:

```ts
import type { GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

export function renderCitizens(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const citizen of state.citizens) {
    if (citizen.status === "arrived") continue;
    ctx.fillStyle = citizen.status === "late" ? colors.late : citizen.status === "unserved" ? colors.unserved : colors.citizen;
    ctx.beginPath();
    ctx.arc(citizen.position.x * tileSize + 10, citizen.position.y * tileSize + 10, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
```

- [ ] **Step 6: Add overlay renderer**

Create `src/render/overlayRenderer.ts`:

```ts
import type { GameState } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";

export function renderOverlays(ctx: CanvasRenderingContext2D, state: GameState, ui: UiState): void {
  if (ui.activeOverlay === "coverage") {
    ctx.fillStyle = colors.coverage;
    for (const stop of state.transit.stops) {
      ctx.fillRect((stop.position.x - 2) * tileSize, (stop.position.y - 2) * tileSize, tileSize * 5, tileSize * 5);
    }
    for (const station of state.transit.stations) {
      ctx.fillRect((station.position.x - 4) * tileSize, (station.position.y - 4) * tileSize, tileSize * 9, tileSize * 9);
    }
  }

  if (ui.activeOverlay === "lateness") {
    ctx.fillStyle = colors.lateness;
    for (const citizen of state.citizens.filter((candidate) => candidate.status === "late" || candidate.status === "unserved")) {
      ctx.fillRect(citizen.position.x * tileSize, citizen.position.y * tileSize, tileSize, tileSize);
    }
  }

  if (ui.hoverTile) {
    ctx.strokeStyle = "#111820";
    ctx.lineWidth = 2;
    ctx.strokeRect(ui.hoverTile.x * tileSize + 2, ui.hoverTile.y * tileSize + 2, tileSize - 4, tileSize - 4);
  }
}
```

- [ ] **Step 7: Type check render modules**

Run: `bun run check`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/render/colors.ts src/render/canvas.ts src/render/mapRenderer.ts src/render/transitRenderer.ts src/render/citizenRenderer.ts src/render/overlayRenderer.ts
git commit -m "feat: render tile city and transit canvas"
```

## Task 10: UI State, Panels, And Tool Actions

**Files:**
- Create: `src/ui/uiState.ts`
- Create: `src/ui/actions.ts`
- Create: `src/ui/panels.ts`
- Modify: `src/main.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Create UI state**

Create `src/ui/uiState.ts`:

```ts
import type { Overlay, Point, Tool } from "../domain/types";

export interface UiState {
  activeTool: Tool;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    activeOverlay: null,
    selectedId: null,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: []
  };
}
```

- [ ] **Step 2: Create game action dispatcher**

Create `src/ui/actions.ts`:

```ts
import type { GameState, Point } from "../domain/types";
import type { UiState } from "./uiState";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation, assignVehicle } from "../simulation/transit";
import { isValidCivicAnchorPlacement } from "../simulation/map";

export function handleTileClick(state: GameState, ui: UiState, point: Point): { state: GameState; ui: UiState } {
  if (ui.activeTool === "busStop") {
    return { state: addBusStop(state, point), ui };
  }

  if (ui.activeTool === "metroStation") {
    return { state: addMetroStation(state, point), ui };
  }

  if (ui.activeTool === "civicAnchor" && isValidCivicAnchorPlacement(state, point)) {
    const tiles = state.map.tiles.map((tile) =>
      tile.x === point.x && tile.y === point.y ? { ...tile, kind: "civic" as const } : tile
    );
    return { state: { ...state, budget: state.budget - 12_000, map: { ...state.map, tiles } }, ui };
  }

  if (ui.activeTool === "busRoute") {
    const stop = state.transit.stops.find((candidate) => candidate.position.x === point.x && candidate.position.y === point.y);
    if (!stop) return { state, ui };
    const draftStopIds = [...ui.draftStopIds, stop.id];
    if (draftStopIds.length >= 2) {
      const withRoute = addBusRoute(state, draftStopIds);
      const routeId = withRoute.transit.routes.at(-1)?.id;
      return {
        state: routeId ? assignVehicle(withRoute, "bus", routeId) : withRoute,
        ui: { ...ui, draftStopIds: [] }
      };
    }
    return { state, ui: { ...ui, draftStopIds } };
  }

  if (ui.activeTool === "metroLine") {
    const station = state.transit.stations.find((candidate) => candidate.position.x === point.x && candidate.position.y === point.y);
    if (!station) return { state, ui };
    const draftStationIds = [...ui.draftStationIds, station.id];
    if (draftStationIds.length >= 2) {
      const withLine = addMetroLine(state, draftStationIds);
      const lineId = withLine.transit.metroLines.at(-1)?.id;
      return {
        state: lineId ? assignVehicle(withLine, "metro", lineId) : withLine,
        ui: { ...ui, draftStationIds: [] }
      };
    }
    return { state, ui: { ...ui, draftStationIds } };
  }

  return { state, ui: { ...ui, selectedId: `${point.x},${point.y}` } };
}
```

- [ ] **Step 3: Create panel rendering**

Create `src/ui/panels.ts`:

```ts
import type { GameState, Overlay, Tool } from "../domain/types";
import type { UiState } from "./uiState";

const tools: Array<{ id: Tool; label: string }> = [
  { id: "inspect", label: "Inspect" },
  { id: "busStop", label: "Bus Stop" },
  { id: "busRoute", label: "Bus Route" },
  { id: "metroStation", label: "Metro Station" },
  { id: "metroLine", label: "Metro Line" },
  { id: "civicAnchor", label: "Civic" },
  { id: "remove", label: "Remove" }
];

const overlays: Array<{ id: Overlay; label: string }> = [
  { id: "coverage", label: "Coverage" },
  { id: "crowding", label: "Crowding" },
  { id: "demand", label: "Demand" },
  { id: "lateness", label: "Lateness" },
  { id: "growth", label: "Growth" }
];

export function renderPanels(root: HTMLElement, state: GameState, ui: UiState): void {
  root.querySelector<HTMLElement>("[data-testid='topbar']")!.innerHTML = `
    <strong>Caelum</strong>
    <span>$${state.budget.toLocaleString()}</span>
    <span>Time ${Math.floor(state.time)}s</span>
    <span>Pop ${state.citizens.length}</span>
    <span>Late ${state.metrics.lateTrips}</span>
    <span>Unserved ${state.metrics.unservedTrips}</span>
    <span>Avg Wait ${Math.floor(state.metrics.averageWaitSeconds)}s</span>
    <button data-action="pause">${state.paused ? "Resume" : "Pause"}</button>
    <button data-speed="1">1x</button>
    <button data-speed="2">2x</button>
    <button data-speed="4">4x</button>
  `;

  root.querySelector<HTMLElement>("[data-testid='side-panel']")!.innerHTML = `
    <section class="toolbar">
      ${tools.map((tool) => `<button data-tool="${tool.id}" class="${ui.activeTool === tool.id ? "active" : ""}">${tool.label}</button>`).join("")}
    </section>
    <section class="overlays">
      ${overlays.map((overlay) => `<button data-overlay="${overlay.id}" class="${ui.activeOverlay === overlay.id ? "active" : ""}">${overlay.label}</button>`).join("")}
    </section>
    <section class="details">
      <h2>${state.scenario.name}</h2>
      <p>Status: ${state.metrics.state}</p>
      <p>${state.metrics.lossReason ?? "Keep late and unserved trips below limits."}</p>
      <p>Next growth: ${state.scenario.growthWaves.find((wave) => !wave.applied)?.message ?? "No more waves"}</p>
      <p>Tool: ${ui.activeTool}</p>
    </section>
  `;
}
```

- [ ] **Step 4: Wire app loop and interactions**

Replace `src/main.ts`:

```ts
import "./styles.css";
import { canvasToTile, renderGame } from "./render/canvas";
import { createInitialGameState } from "./simulation/gameState";
import { tickSimulation } from "./simulation/simulation";
import { handleTileClick } from "./ui/actions";
import { renderPanels } from "./ui/panels";
import { createUiState } from "./ui/uiState";
import type { Overlay, Tool } from "./domain/types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <main class="shell" data-testid="game-shell">
    <section class="topbar" data-testid="topbar"></section>
    <canvas class="board" data-testid="game-canvas" width="1280" height="800"></canvas>
    <aside class="panel" data-testid="side-panel"></aside>
  </main>
`;

const canvas = app.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']");
const ctx = canvas?.getContext("2d");

if (!canvas || !ctx) {
  throw new Error("Canvas is unavailable");
}

let state = createInitialGameState();
let ui = createUiState();
let lastFrame = performance.now();

function frame(now: number): void {
  const deltaSeconds = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  state = tickSimulation(state, deltaSeconds);
  renderGame(ctx!, state, ui);
  renderPanels(app!, state, ui);
  requestAnimationFrame(frame);
}

canvas.addEventListener("mousemove", (event) => {
  ui = { ...ui, hoverTile: canvasToTile(canvas, event.clientX, event.clientY) };
});

canvas.addEventListener("click", (event) => {
  const result = handleTileClick(state, ui, canvasToTile(canvas, event.clientX, event.clientY));
  state = result.state;
  ui = result.ui;
});

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const tool = target.dataset.tool as Tool | undefined;
  const overlay = target.dataset.overlay as Overlay | undefined;
  const speed = target.dataset.speed;

  if (tool) ui = { ...ui, activeTool: tool };
  if (overlay) ui = { ...ui, activeOverlay: ui.activeOverlay === overlay ? null : overlay };
  if (target.dataset.action === "pause") state = { ...state, paused: !state.paused };
  if (speed) state = { ...state, speed: Number(speed) as 1 | 2 | 4, paused: false };
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") ui = createUiState();
});

requestAnimationFrame(frame);
```

- [ ] **Step 5: Add button styling**

Append to `src/styles.css`:

```css
button {
  border: 1px solid #aeb9c2;
  background: #ffffff;
  color: #17202a;
  min-height: 32px;
  border-radius: 6px;
  padding: 0 10px;
  font: inherit;
  cursor: pointer;
}

button.active {
  border-color: #2867b2;
  background: #dce9f7;
}

.toolbar,
.overlays {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}

.details h2 {
  font-size: 18px;
  margin: 0 0 10px;
}

.details p {
  margin: 8px 0;
  font-size: 14px;
  line-height: 1.4;
}
```

- [ ] **Step 6: Verify app compiles**

Run: `bun run check`

Expected: PASS.

Run: `bun run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/uiState.ts src/ui/actions.ts src/ui/panels.ts src/main.ts src/styles.css
git commit -m "feat: wire playable UI tools"
```

## Task 11: Browser Smoke Test

**Files:**
- Create: `tests/e2e/smoke.spec.ts`
- Modify: `src/main.ts`
- Modify: `src/ui/panels.ts`

- [ ] **Step 1: Write failing smoke test**

Create `tests/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("loads board and supports basic controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("game-shell")).toBeVisible();
  await expect(page.getByTestId("game-canvas")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await page.getByRole("button", { name: "Bus Stop" }).click();
  await page.getByTestId("game-canvas").click({ position: { x: 7 * 32 + 16, y: 8 * 32 + 16 } });

  await page.getByRole("button", { name: "Coverage" }).click();
  await page.getByRole("button", { name: "2x" }).click();

  await expect(page.getByText(/Pop 36/)).toBeVisible();
});
```

- [ ] **Step 2: Run failing smoke test**

Run: `bun run test:e2e`

Expected: FAIL if Playwright browser dependencies are not installed or if the app lacks required accessible controls.

- [ ] **Step 3: Install Playwright browser when needed**

If the failure says a browser executable is missing, run:

```bash
bunx playwright install chromium
```

Expected: Chromium browser is installed for Playwright.

- [ ] **Step 4: Fix accessibility labels if needed**

If Playwright cannot find a button by role/name, update `src/ui/panels.ts` so each button includes the same visible label and an explicit `type="button"`:

```ts
`<button type="button" data-tool="${tool.id}" class="${ui.activeTool === tool.id ? "active" : ""}">${tool.label}</button>`
```

Apply the same pattern for overlay, pause, and speed buttons.

- [ ] **Step 5: Verify smoke test**

Run: `bun run test:e2e`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/smoke.spec.ts src/main.ts src/ui/panels.ts
git commit -m "test: add browser smoke coverage"
```

## Task 12: Documentation And Final Verification

**Files:**
- Create: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Create architecture notes**

Create `docs/architecture.md`:

```md
# Caelum Architecture

Caelum is a browser-first TypeScript canvas game. Simulation modules are pure TypeScript and do not depend on DOM or canvas APIs. Rendering reads game state and UI state, then draws the current frame.

Main flow:

1. UI events create validated game actions.
2. Game actions update state.
3. `tickSimulation` advances growth, vehicles, citizens, and objectives.
4. Renderers draw map, overlays, transit, and citizens.
5. Panels display derived metrics and current tools.

The first scenario is `Growing Suburb`. It is deterministic so unit tests and browser tests can assert stable behavior.
```

- [ ] **Step 2: Create README**

Create `README.md`:

```md
# Caelum

Caelum is an MVP 2D city and public transport simulation game. The first scenario, Growing Suburb, challenges the player to keep a growing city moving with buses, metro, and civic anchors.

## Run

```bash
bun install
bun run dev
```

Open `http://127.0.0.1:5173`.

## Test

```bash
bun run check
bun run test
bun run test:e2e
```

## Architecture

See `docs/architecture.md`.
```

- [ ] **Step 3: Run full verification**

Run: `bun run check`

Expected: PASS.

Run: `bun run test`

Expected: PASS.

Run: `bun run build`

Expected: PASS.

Run: `bun run test:e2e`

Expected: PASS.

- [ ] **Step 4: Start local dev server**

Run: `bun run dev`

Expected: Vite serves the app at `http://127.0.0.1:5173`.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: document game architecture"
```

## Self-Review Notes

Spec coverage:

- Browser-first 2D tile board: Tasks 1, 9, 10, 11.
- Growing Suburb scenario with three growth waves: Tasks 2, 3, 8.
- Buses, stops, routes, vehicle count through assigned vehicles: Tasks 4, 7, 10.
- Metro stations, lines, trains: Tasks 4, 7, 10.
- Civic anchors influencing city shape: Tasks 3 and 10.
- Individual citizens and trip lifecycle: Tasks 2, 5, 6, 7.
- Demand pressure, wait, late, unserved, win/loss: Tasks 6 and 8.
- Overlays and management UI: Tasks 9 and 10.
- Unit and browser testing: Tasks 2 through 8 and 11.

Type consistency:

- `GameState`, `Citizen`, `TransitNetwork`, `RoutePlan`, `Tool`, and `Overlay` are defined in Task 2 and reused consistently in later tasks.
- `tickSimulation`, `tickCitizens`, `tickVehicles`, `evaluateObjectives`, and `findRoutePlan` have single definitions and one call pattern each.
- Entity ids use `entityId(prefix, index)` and match test expectations such as `stop-001`, `route-001`, `metro-001`, and `vehicle-001`.
