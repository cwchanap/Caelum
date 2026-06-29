# Route Creation & Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-committing 2-stop route flow with an explicit add-stops-then-Finish flow (with mid-draft stop removal), and add a Control Tower panel to list, rename, recolor, pause, delete, and highlight routes/metro lines.

**Architecture:** UI-only state additions (`selectedRouteId` + existing draft arrays no longer auto-commit). New pure mutators in `simulation/transit.ts` and draft helpers in `ui/actions.ts`, each returning a new `GameState`/`UiState` and preserving reference equality when unchanged. New `RuntimeController` methods wrap these and `commit`. New selectors derive a draft sub-panel and a route-list shell shape consumed by `ControlTower.svelte`. Additive render passes highlight the selected route and the in-progress draft.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (projects: `simulation`/`runtime` node, `ui`/`render` jsdom), Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-06-03-route-creation-management-design.md`

---

## File Structure

**Modify:**
- `legacy-ts-simulation/transit.ts` — add `renameRoute`, `setRouteColor`, `setRouteActive`, `deleteRoute` pure mutators.
- `src/ui/actions.ts` — change route/line branches to accumulate (no auto-commit); add `removeDraftStop`, `finishDraftRoute`, `cancelDraftRoute`; refactor `removeAtTile` to call shared `deleteRoute`.
- `src/ui/uiState.ts` — add `selectedRouteId: string | null`.
- `src/runtime/createGameRuntime.ts` — new controller methods; reset `selectedRouteId` in tool/building transitions.
- `src/runtime/types.ts` — extend `RuntimeController`, add `ShellRouteDraftState` / `ShellRouteListState` / `ShellRouteListItem`, add fields to `ShellState`.
- `src/runtime/runtimeSelectors.ts` — derive draft + route-list shell shapes.
- `src/components/ControlTower.svelte` — draft sub-panel + Routes management section + new props.
- `src/App.svelte` — wire new controller callbacks into `ControlTower`.
- `src/render/transitRenderer.ts` + `src/render/canvas.ts` — selected-route highlight + draft preview (pass `ui`).

**Create:**
- `src/ui/routePalette.ts` — shared `ROUTE_COLOR_PALETTE` constant.

**Test (modify/create):**
- `tests/simulation/transit.test.ts`, `tests/simulation/router.test.ts`
- `tests/ui/actions.test.ts`
- `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`
- `tests/ui/controlTower.test.ts`
- `tests/render/` (new file `tests/render/transitRenderer.test.ts` if absent)
- `tests/e2e/` (new `tests/e2e/routes.spec.ts`)

---

## Task 1: Pure route mutators (rename / color / active)

**Files:**
- Modify: `legacy-ts-simulation/transit.ts`
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/simulation/transit.test.ts` (uses the existing `createBusState` / metro helpers in that file):

```typescript
import {
  renameRoute,
  setRouteColor,
  setRouteActive,
} from "../../legacy-ts-simulation/transit";

describe("route mutators", () => {
  it("renames a bus route and leaves others untouched", () => {
    const state = createBusState();
    const next = renameRoute(state, "route-001", "Airport Express");
    expect(next.transit.routes[0].name).toBe("Airport Express");
    expect(next).not.toBe(state);
  });

  it("falls back to the auto-name when the new name is blank", () => {
    const state = createBusState();
    const next = renameRoute(state, "route-001", "   ");
    expect(next.transit.routes[0].name).toBe("Bus 1");
  });

  it("renames a metro line by id", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const next = renameRoute(state, "metro-001", "Blue Line");
    expect(next.transit.metroLines[0].name).toBe("Blue Line");
  });

  it("sets a route color", () => {
    const state = createBusState();
    const next = setRouteColor(state, "route-001", "#123456");
    expect(next.transit.routes[0].color).toBe("#123456");
  });

  it("returns the same reference for an unknown id", () => {
    const state = createBusState();
    expect(renameRoute(state, "route-999", "X")).toBe(state);
    expect(setRouteColor(state, "route-999", "#000")).toBe(state);
    expect(setRouteActive(state, "route-999", false)).toBe(state);
  });

  it("deactivates and reactivates a route flag", () => {
    const state = createBusState();
    const off = setRouteActive(state, "route-001", false);
    expect(off.transit.routes[0].active).toBe(false);
    const on = setRouteActive(off, "route-001", true);
    expect(on.transit.routes[0].active).toBe(true);
  });

  it("returns the same reference when active is unchanged", () => {
    const state = createBusState();
    expect(setRouteActive(state, "route-001", true)).toBe(state);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "route mutators"`
Expected: FAIL — `renameRoute`/`setRouteColor`/`setRouteActive` are not exported.

- [ ] **Step 3: Implement the mutators**

Add to `legacy-ts-simulation/transit.ts` (after `addMetroLine`). They resolve the id against both `routes` and `metroLines`, and reuse the existing `entityNumberFromId` for the auto-name fallback:

```typescript
function autoName(prefix: "Bus" | "Metro", idPrefix: string, id: string): string {
  return `${prefix} ${entityNumberFromId(idPrefix, id)}`;
}

export function renameRoute(
  state: GameState,
  routeId: string,
  name: string,
): GameState {
  const trimmed = name.trim();

  const routeIndex = state.transit.routes.findIndex((r) => r.id === routeId);
  if (routeIndex !== -1) {
    const finalName = trimmed === "" ? autoName("Bus", "route", routeId) : trimmed;
    if (state.transit.routes[routeIndex].name === finalName) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) =>
          route.id === routeId ? { ...route, name: finalName } : route,
        ),
      },
    };
  }

  const lineIndex = state.transit.metroLines.findIndex((l) => l.id === routeId);
  if (lineIndex !== -1) {
    const finalName = trimmed === "" ? autoName("Metro", "metro", routeId) : trimmed;
    if (state.transit.metroLines[lineIndex].name === finalName) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((line) =>
          line.id === routeId ? { ...line, name: finalName } : line,
        ),
      },
    };
  }

  return state;
}

export function setRouteColor(
  state: GameState,
  routeId: string,
  color: string,
): GameState {
  if (state.transit.routes.some((r) => r.id === routeId)) {
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) =>
          route.id === routeId && route.color !== color
            ? { ...route, color }
            : route,
        ),
      },
    };
  }
  if (state.transit.metroLines.some((l) => l.id === routeId)) {
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((line) =>
          line.id === routeId && line.color !== color
            ? { ...line, color }
            : line,
        ),
      },
    };
  }
  return state;
}

export function setRouteActive(
  state: GameState,
  routeId: string,
  active: boolean,
): GameState {
  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    if (route.active === active) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((r) =>
          r.id === routeId ? { ...r, active } : r,
        ),
      },
    };
  }
  const line = state.transit.metroLines.find((l) => l.id === routeId);
  if (line !== undefined) {
    if (line.active === active) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((l) =>
          l.id === routeId ? { ...l, active } : l,
        ),
      },
    };
  }
  return state;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "route mutators"`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add legacy-ts-simulation/transit.ts tests/simulation/transit.test.ts
git commit -m "feat: pure route rename/color/active mutators"
```

---

## Task 2: Extract `deleteRoute` and refactor `removeAtTile`

**Files:**
- Modify: `legacy-ts-simulation/transit.ts` (add `deleteRoute`)
- Modify: `src/ui/actions.ts` (use it in `removeAtTile`)
- Test: `tests/simulation/transit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/simulation/transit.test.ts`:

```typescript
import { deleteRoute } from "../../legacy-ts-simulation/transit";

describe("deleteRoute", () => {
  it("removes a bus route, its vehicles, and its platform assignments", () => {
    const state = createBusState(); // route-001 across stop-001/stop-002 + vehicle-001
    const assignedBefore = state.transit.stops
      .flatMap((s) => s.platforms)
      .some((p) => p.routeIds.includes("route-001"));
    expect(assignedBefore).toBe(true);

    const next = deleteRoute(state, "route-001");

    expect(next.transit.routes).toEqual([]);
    expect(next.transit.vehicles).toEqual([]);
    expect(
      next.transit.stops
        .flatMap((s) => s.platforms)
        .some((p) => p.routeIds.includes("route-001")),
    ).toBe(false);
  });

  it("removes a metro line, its vehicles, and its platform assignments", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = assignVehicle(state, "metro", "metro-001");

    const next = deleteRoute(state, "metro-001");

    expect(next.transit.metroLines).toEqual([]);
    expect(next.transit.vehicles).toEqual([]);
    expect(
      next.transit.stations
        .flatMap((s) => s.platforms)
        .some((p) => p.routeIds.includes("metro-001")),
    ).toBe(false);
  });

  it("returns the same reference for an unknown id", () => {
    const state = createBusState();
    expect(deleteRoute(state, "route-999")).toBe(state);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "deleteRoute"`
Expected: FAIL — `deleteRoute` is not exported.

- [ ] **Step 3: Implement `deleteRoute`**

Add to `legacy-ts-simulation/transit.ts`. It strips the id from every platform on both stops and stations, removes its vehicles, and removes the route/line. Reuse the existing local `stripRoutesFromPlatforms` pattern — but that helper currently lives in `actions.ts`. Add a local copy here scoped to transit (the two files do not import each other's privates):

```typescript
function stripRouteFromPlatforms<
  T extends { platforms: { routeIds: string[] }[] },
>(nodes: T[], routeId: string): T[] {
  let anyChanged = false;
  const mapped = nodes.map((node) => {
    let changed = false;
    const platforms = node.platforms.map((platform) => {
      if (!platform.routeIds.includes(routeId)) {
        return platform;
      }
      changed = true;
      return {
        ...platform,
        routeIds: platform.routeIds.filter((id) => id !== routeId),
      };
    });
    if (changed) {
      anyChanged = true;
      return { ...node, platforms };
    }
    return node;
  });
  return anyChanged ? mapped : nodes;
}

export function deleteRoute(state: GameState, routeId: string): GameState {
  const isRoute = state.transit.routes.some((r) => r.id === routeId);
  const isLine = state.transit.metroLines.some((l) => l.id === routeId);
  if (!isRoute && !isLine) {
    return state;
  }

  return {
    ...state,
    transit: {
      ...state.transit,
      stops: isRoute
        ? stripRouteFromPlatforms(state.transit.stops, routeId)
        : state.transit.stops,
      stations: isLine
        ? stripRouteFromPlatforms(state.transit.stations, routeId)
        : state.transit.stations,
      routes: isRoute
        ? state.transit.routes.filter((r) => r.id !== routeId)
        : state.transit.routes,
      metroLines: isLine
        ? state.transit.metroLines.filter((l) => l.id !== routeId)
        : state.transit.metroLines,
      vehicles: state.transit.vehicles.filter((v) => v.lineId !== routeId),
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/simulation/transit.test.ts -t "deleteRoute"`
Expected: PASS.

- [ ] **Step 5: Refactor `removeAtTile` to reuse `deleteRoute`**

In `src/ui/actions.ts`, import `deleteRoute` and apply each removed route/line through it so the platform-stripping + vehicle removal stays in one place. Replace the final `return { ...state, ... }` block of `removeAtTile` (the object that filters `stops`/`stations`/`routes`/`metroLines`/`vehicles`) with:

```typescript
  // Remove the node(s) first.
  let next: GameState = {
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
    },
  };

  // Then delete every dependent route/line via the shared helper, which also
  // strips platform assignments and removes vehicles.
  for (const routeId of removedRouteIds) {
    next = deleteRoute(next, routeId);
  }
  for (const lineId of removedMetroLineIds) {
    next = deleteRoute(next, lineId);
  }

  return next;
```

Update the import at the top of `actions.ts`:

```typescript
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
  deleteRoute,
} from "../legacy-ts-simulation/transit";
```

The now-unused local `stripRoutesFromPlatforms` in `actions.ts` should be deleted (eslint will flag it). The `removedRouteIds` / `removedMetroLineIds` computations above this block stay as-is.

- [ ] **Step 6: Run the affected suites to verify the refactor is behavior-preserving**

Run: `bunx vitest run tests/ui/actions.test.ts tests/simulation/transit.test.ts`
Expected: PASS — existing "removes stops and dependent routes", "removes stations and dependent metro lines", and "removes a building transit node and dependent routes and vehicles" still pass.

- [ ] **Step 7: Commit**

```bash
git add legacy-ts-simulation/transit.ts src/ui/actions.ts tests/simulation/transit.test.ts
git commit -m "refactor: shared deleteRoute used by removeAtTile"
```

---

## Task 3: Stop auto-commit — drafts accumulate

**Files:**
- Modify: `src/ui/uiState.ts` (add `selectedRouteId`)
- Modify: `src/ui/actions.ts` (`handleTileClick` route/line branches)
- Test: `tests/ui/actions.test.ts`

- [ ] **Step 1: Add `selectedRouteId` to UiState**

In `src/ui/uiState.ts`, add the field to the interface and factory:

```typescript
export interface UiState {
  activeTool: Tool;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  selectedNodeKind: "stop" | "station" | null;
  selectedBuilding: BuildingType | null;
  buildingRotation: BuildingRotation;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
  selectedRouteId: string | null;
  controlTowerOpen: boolean;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    activeOverlay: null,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    buildingRotation: 0,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: [],
    selectedRouteId: null,
    controlTowerOpen: true,
  };
}
```

- [ ] **Step 2: Write the failing tests for accumulation**

Replace the two existing affordability tests at the top of `tests/ui/actions.test.ts` ("preserves a bus route draft when the bus cannot be afforded" and "preserves a metro line draft when the train cannot be afforded") and migrate the "drafts bus routes from any occupied terminal tile" test. New tests:

```typescript
it("accumulates bus route stops without committing at two stops", () => {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 15, y: 8 });

  let result = handleTileClick(
    state,
    { ...createUiState(), activeTool: "busRoute" as const },
    { x: 7, y: 8 },
  );
  result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

  expect(result.ui.draftStopIds).toEqual(["stop-001", "stop-002"]);
  expect(result.state.transit.routes).toEqual([]);
});

it("accumulates a third bus stop into the draft", () => {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 15, y: 8 });
  state = addBusStop(state, { x: 22, y: 8 });

  let result = handleTileClick(
    state,
    { ...createUiState(), activeTool: "busRoute" as const },
    { x: 7, y: 8 },
  );
  result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });
  result = handleTileClick(result.state, result.ui, { x: 22, y: 8 });

  expect(result.ui.draftStopIds).toEqual(["stop-001", "stop-002", "stop-003"]);
});

it("ignores clicking the same stop twice in a row", () => {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });

  let result = handleTileClick(
    state,
    { ...createUiState(), activeTool: "busRoute" as const },
    { x: 7, y: 8 },
  );
  const afterFirst = result.ui;
  result = handleTileClick(result.state, result.ui, { x: 7, y: 8 });

  expect(result.ui.draftStopIds).toEqual(["stop-001"]);
  expect(result.ui).toBe(afterFirst);
});

it("accumulates metro line stations without committing", () => {
  let state = createInitialGameState();
  state = addMetroStation(state, { x: 7, y: 8 });
  state = addMetroStation(state, { x: 15, y: 8 });

  let result = handleTileClick(
    state,
    { ...createUiState(), activeTool: "metroLine" as const },
    { x: 7, y: 8 },
  );
  result = handleTileClick(result.state, result.ui, { x: 15, y: 8 });

  expect(result.ui.draftStationIds).toEqual(["station-001", "station-002"]);
  expect(result.state.transit.metroLines).toEqual([]);
});
```

Also migrate the two `removeAtTile` tests that built a route via two clicks ("removes stops and dependent routes…", "removes stations and dependent metro lines…") to create the route directly with the sim helpers, since two clicks no longer commit. Change their setup to:

```typescript
// bus version
let state = createInitialGameState();
state = addBusStop(state, { x: 7, y: 8 });
state = addBusStop(state, { x: 15, y: 8 });
state = addBusRoute(state, ["stop-001", "stop-002"]);
state = assignVehicle(state, "bus", "route-001");
const removed = handleTileClick(
  state,
  { ...createUiState(), activeTool: "remove" as const },
  { x: 7, y: 8 },
);
```

```typescript
// metro version (add addMetroLine to the import from transit)
let state = createInitialGameState();
state = addMetroStation(state, { x: 7, y: 8 });
state = addMetroStation(state, { x: 15, y: 8 });
state = addMetroLine(state, ["station-001", "station-002"]);
state = assignVehicle(state, "metro", "metro-001");
const removed = handleTileClick(
  state,
  { ...createUiState(), activeTool: "remove" as const },
  { x: 7, y: 8 },
);
```

Add `addMetroLine` to the existing `transit` import in this test file.

- [ ] **Step 3: Run the tests to verify the accumulation cases fail**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: FAIL — current code commits at 2 stops, so `routes` is non-empty and `draftStopIds` is `[]`.

- [ ] **Step 4: Rewrite the route/line branches in `handleTileClick`**

In `src/ui/actions.ts`, replace the entire `if (ui.activeTool === "busRoute") { ... }` block with:

```typescript
  if (ui.activeTool === "busRoute") {
    const stop = resolveStopAtTile(state, point);
    if (stop === undefined) {
      return { state, ui };
    }
    if (ui.draftStopIds.at(-1) === stop.id) {
      return { state, ui };
    }
    return { state, ui: { ...ui, draftStopIds: [...ui.draftStopIds, stop.id] } };
  }
```

Replace the entire `if (ui.activeTool === "metroLine") { ... }` block with:

```typescript
  if (ui.activeTool === "metroLine") {
    const station = state.transit.stations.find((candidate) =>
      samePoint(candidate.position, point),
    );
    if (station === undefined) {
      return { state, ui };
    }
    if (ui.draftStationIds.at(-1) === station.id) {
      return { state, ui };
    }
    return {
      state,
      ui: { ...ui, draftStationIds: [...ui.draftStationIds, station.id] },
    };
  }
```

Remove the now-unused `BUS_VEHICLE_COST` / `METRO_VEHICLE_COST` constants and the unused `assignVehicle`/`addBusRoute`/`addMetroLine` imports **only if** they are no longer referenced after Task 4 (they will be used by `finishDraftRoute` in Task 4, so keep them for now).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/uiState.ts src/ui/actions.ts tests/ui/actions.test.ts
git commit -m "feat: route drafts accumulate instead of auto-committing"
```

---

## Task 4: Draft finish / remove-stop / cancel helpers

**Files:**
- Modify: `src/ui/actions.ts`
- Test: `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui/actions.test.ts` (import the new helpers in the existing `actions` import: `finishDraftRoute`, `removeDraftStop`, `cancelDraftRoute`):

```typescript
import {
  cancelDraftRoute,
  finishDraftRoute,
  removeDraftStop,
} from "../../src/ui/actions";

describe("draft route helpers", () => {
  function busDraft() {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    return { state, ui };
  }

  it("finishes a bus route, assigns a vehicle, and clears the draft", () => {
    const { state, ui } = busDraft();
    const result = finishDraftRoute(state, ui);

    expect(result.state.transit.routes[0]).toMatchObject({
      id: "route-001",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    expect(result.ui.draftStopIds).toEqual([]);
  });

  it("does not finish when fewer than two distinct stops", () => {
    const { state } = busDraft();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
    };
    const result = finishDraftRoute(state, ui);
    expect(result.state).toBe(state);
    expect(result.ui).toBe(ui);
  });

  it("does not finish when the vehicle is unaffordable", () => {
    const draft = busDraft();
    const state = { ...draft.state, budget: 7_999 };
    const result = finishDraftRoute(state, draft.ui);
    expect(result.state).toBe(state);
    expect(result.ui).toBe(draft.ui);
  });

  it("removes a specific draft stop by index", () => {
    const { ui } = busDraft();
    const next = removeDraftStop(ui, 0);
    expect(next.draftStopIds).toEqual(["stop-002"]);
  });

  it("removes a metro draft station by index", () => {
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      draftStationIds: ["station-001", "station-002"],
    };
    const next = removeDraftStop(ui, 1);
    expect(next.draftStationIds).toEqual(["station-001"]);
  });

  it("cancels both drafts", () => {
    const ui = {
      ...createUiState(),
      draftStopIds: ["stop-001"],
      draftStationIds: ["station-001"],
    };
    const next = cancelDraftRoute(ui);
    expect(next.draftStopIds).toEqual([]);
    expect(next.draftStationIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/ui/actions.test.ts -t "draft route helpers"`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

Add to `src/ui/actions.ts` (keep the `BUS_VEHICLE_COST` / `METRO_VEHICLE_COST` constants and the `addBusRoute`/`addMetroLine`/`assignVehicle` imports for these):

```typescript
function distinctCount(ids: string[]): number {
  return new Set(ids).size;
}

export function finishDraftRoute(
  state: GameState,
  ui: UiState,
): { state: GameState; ui: UiState } {
  if (ui.activeTool === "busRoute") {
    if (
      distinctCount(ui.draftStopIds) < 2 ||
      state.budget < BUS_VEHICLE_COST
    ) {
      return { state, ui };
    }
    const withRoute = addBusRoute(state, ui.draftStopIds);
    const routeId = withRoute.transit.routes.at(-1)?.id;
    const next =
      routeId === undefined
        ? withRoute
        : assignVehicle(withRoute, "bus", routeId);
    return { state: next, ui: { ...ui, draftStopIds: [] } };
  }

  if (ui.activeTool === "metroLine") {
    if (
      distinctCount(ui.draftStationIds) < 2 ||
      state.budget < METRO_VEHICLE_COST
    ) {
      return { state, ui };
    }
    const withLine = addMetroLine(state, ui.draftStationIds);
    const lineId = withLine.transit.metroLines.at(-1)?.id;
    const next =
      lineId === undefined
        ? withLine
        : assignVehicle(withLine, "metro", lineId);
    return { state: next, ui: { ...ui, draftStationIds: [] } };
  }

  return { state, ui };
}

export function removeDraftStop(ui: UiState, index: number): UiState {
  if (ui.activeTool === "metroLine") {
    if (index < 0 || index >= ui.draftStationIds.length) {
      return ui;
    }
    return {
      ...ui,
      draftStationIds: ui.draftStationIds.filter((_, i) => i !== index),
    };
  }
  if (index < 0 || index >= ui.draftStopIds.length) {
    return ui;
  }
  return {
    ...ui,
    draftStopIds: ui.draftStopIds.filter((_, i) => i !== index),
  };
}

export function cancelDraftRoute(ui: UiState): UiState {
  if (ui.draftStopIds.length === 0 && ui.draftStationIds.length === 0) {
    return ui;
  }
  return { ...ui, draftStopIds: [], draftStationIds: [] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run tests/ui/actions.test.ts -t "draft route helpers"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/actions.ts tests/ui/actions.test.ts
git commit -m "feat: finish/remove-stop/cancel draft route helpers"
```

---

## Task 5: Controller methods

**Files:**
- Modify: `src/runtime/types.ts` (extend `RuntimeController`)
- Modify: `src/runtime/createGameRuntime.ts`
- Test: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime/gameRuntime.test.ts`:

```typescript
describe("route creation and management", () => {
  function withTwoStops() {
    const runtime = createGameRuntime();
    runtime.setBuilding("busStop");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
    return runtime;
  }

  it("finishes a drafted route and clears the draft", () => {
    const runtime = withTwoStops();
    expect(runtime.getSnapshot().ui.draftStopIds).toHaveLength(2);

    const snapshot = runtime.finishRoute();

    expect(snapshot.state.transit.routes).toHaveLength(1);
    expect(snapshot.ui.draftStopIds).toEqual([]);
  });

  it("removes a draft stop and cancels a draft", () => {
    const runtime = withTwoStops();
    expect(runtime.removeDraftStop(0).ui.draftStopIds).toEqual(["stop-002"]);
    expect(runtime.cancelRoute().ui.draftStopIds).toEqual([]);
  });

  it("renames, recolors, toggles, selects, and deletes a route", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();

    expect(runtime.renameRoute("route-001", "Loop").state.transit.routes[0].name).toBe("Loop");
    expect(runtime.recolorRoute("route-001", "#abcdef").state.transit.routes[0].color).toBe("#abcdef");
    expect(runtime.toggleRouteActive("route-001").state.transit.routes[0].active).toBe(false);
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe("route-001");
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe(null);
    expect(runtime.deleteRoute("route-001").state.transit.routes).toEqual([]);
  });

  it("clears the selected route when switching tools", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();
    runtime.selectRoute("route-001");
    expect(runtime.setTool("inspect").ui.selectedRouteId).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts -t "route creation and management"`
Expected: FAIL — methods do not exist on the controller.

- [ ] **Step 3: Extend the `RuntimeController` interface**

In `src/runtime/types.ts`, add to `RuntimeController` (after `assignRouteToPlatform`):

```typescript
  removeDraftStop: (index: number) => RuntimeSnapshot;
  finishRoute: () => RuntimeSnapshot;
  cancelRoute: () => RuntimeSnapshot;
  renameRoute: (routeId: string, name: string) => RuntimeSnapshot;
  recolorRoute: (routeId: string, color: string) => RuntimeSnapshot;
  toggleRouteActive: (routeId: string) => RuntimeSnapshot;
  deleteRoute: (routeId: string) => RuntimeSnapshot;
  selectRoute: (routeId: string | null) => RuntimeSnapshot;
```

- [ ] **Step 4: Implement the methods in `createGameRuntime`**

Update imports at the top of `src/runtime/createGameRuntime.ts`:

```typescript
import {
  assignRouteToPlatform as applyAssignRouteToPlatform,
  deleteRoute as applyDeleteRoute,
  renameRoute as applyRenameRoute,
  setRouteActive as applySetRouteActive,
  setRouteColor as applySetRouteColor,
} from "../legacy-ts-simulation/transit";
import {
  cancelDraftRoute,
  finishDraftRoute,
  handleTileClick as applyTileClick,
  removeDraftStop as applyRemoveDraftStop,
} from "../ui/actions";
```

Add `selectedRouteId: null` to the resets in `nextToolUiState` and `nextBuildingUiState` (both return objects):

```typescript
    // inside nextToolUiState's returned object:
    selectedRouteId: null,
```
```typescript
    // inside nextBuildingUiState's returned object:
    selectedRouteId: null,
```

Add the methods to the `api` object (after `assignRouteToPlatform`):

```typescript
    removeDraftStop(index) {
      return commit(state, applyRemoveDraftStop(ui, index));
    },
    finishRoute() {
      const result = finishDraftRoute(state, ui);
      return commit(result.state, result.ui);
    },
    cancelRoute() {
      return commit(state, cancelDraftRoute(ui));
    },
    renameRoute(routeId, name) {
      return commit(applyRenameRoute(state, routeId, name), ui);
    },
    recolorRoute(routeId, color) {
      return commit(applySetRouteColor(state, routeId, color), ui);
    },
    toggleRouteActive(routeId) {
      const route =
        state.transit.routes.find((r) => r.id === routeId) ??
        state.transit.metroLines.find((l) => l.id === routeId);
      if (route === undefined) {
        return commit(state, ui);
      }
      return commit(applySetRouteActive(state, routeId, !route.active), ui);
    },
    deleteRoute(routeId) {
      const nextUi =
        ui.selectedRouteId === routeId
          ? { ...ui, selectedRouteId: null }
          : ui;
      return commit(applyDeleteRoute(state, routeId), nextUi);
    },
    selectRoute(routeId) {
      const nextId = ui.selectedRouteId === routeId ? null : routeId;
      return commit(
        state,
        nextId === ui.selectedRouteId ? ui : { ...ui, selectedRouteId: nextId },
      );
    },
```

Note: fix the `deleteRoute` snippet's line break — write it as `const nextUi = ui.selectedRouteId === routeId ? { ...ui, selectedRouteId: null } : ui;`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts -t "route creation and management"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat: runtime controller methods for route creation and management"
```

---

## Task 6: Route palette + selectors

**Files:**
- Create: `src/ui/routePalette.ts`
- Modify: `src/runtime/types.ts` (shell shapes)
- Modify: `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`

- [ ] **Step 1: Create the palette constant**

Create `src/ui/routePalette.ts`:

```typescript
export const ROUTE_COLOR_PALETTE: readonly string[] = [
  "#e04f39",
  "#2867b2",
  "#2e9e5b",
  "#d98a1f",
  "#7a4fbf",
  "#1fa8a8",
] as const;
```

- [ ] **Step 2: Add shell shapes to `types.ts`**

In `src/runtime/types.ts`, add:

```typescript
export interface ShellRouteDraftStop {
  index: number;
  label: string;
  coord: string;
}

export interface ShellRouteDraftState {
  mode: "bus" | "metro";
  stops: ShellRouteDraftStop[];
  distinctCount: number;
  vehicleCost: number;
  canFinish: boolean;
  finishHint: string;
}

export interface ShellRouteListItem {
  id: string;
  name: string;
  color: string;
  mode: "bus" | "metro";
  stopCount: number;
  active: boolean;
  selected: boolean;
}

export type ShellRouteListState = ShellRouteListItem[];
```

Add the two fields to `ShellState`:

```typescript
export interface ShellState {
  topbar: ShellTopbarState;
  controlTower: ShellControlTowerState;
  inspector: ShellInspectorState | null;
  routeDraft: ShellRouteDraftState | null;
  routes: ShellRouteListState;
}
```

- [ ] **Step 3: Write the failing selector tests**

Append to `tests/runtime/runtimeSelectors.test.ts` (mirror the imports already in that file; it imports `selectShellState`, `createInitialGameState`, `createUiState`, and transit helpers — add any missing):

```typescript
import { addBusRoute, addBusStop, addMetroStation, addMetroLine } from "../../legacy-ts-simulation/transit";

describe("route selectors", () => {
  function twoStops() {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    return state;
  }

  it("returns null draft when not drafting", () => {
    const shell = selectShellState(createInitialGameState(), createUiState());
    expect(shell.routeDraft).toBe(null);
  });

  it("derives a bus draft with stop labels and a finish gate", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
    };
    const shell = selectShellState(state, ui);
    expect(shell.routeDraft?.mode).toBe("bus");
    expect(shell.routeDraft?.stops).toEqual([
      { index: 0, label: "Bus Stop", coord: "(7,8)" },
    ]);
    expect(shell.routeDraft?.canFinish).toBe(false);
    expect(shell.routeDraft?.finishHint).toBe("Add another stop");
  });

  it("enables finish at two affordable stops", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(selectShellState(state, ui).routeDraft?.canFinish).toBe(true);
  });

  it("blocks finish when unaffordable with a cost hint", () => {
    const state = { ...twoStops(), budget: 1_000 };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.canFinish).toBe(false);
    expect(draft?.finishHint).toBe("Need $8,000");
  });

  it("lists routes and metro lines with selection state", () => {
    let state = twoStops();
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = addMetroStation(state, { x: 3, y: 3 });
    state = addMetroStation(state, { x: 9, y: 3 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    const shell = selectShellState(state, ui);
    expect(shell.routes).toEqual([
      {
        id: "route-001",
        name: "Bus 1",
        color: "#e04f39",
        mode: "bus",
        stopCount: 2,
        active: true,
        selected: true,
      },
      {
        id: "metro-001",
        name: "Metro 1",
        color: "#2867b2",
        mode: "metro",
        stopCount: 2,
        active: true,
        selected: false,
      },
    ]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts -t "route selectors"`
Expected: FAIL — `routeDraft` / `routes` not on the shell.

- [ ] **Step 5: Implement the selectors**

In `src/runtime/runtimeSelectors.ts`, add helpers and wire them into `selectShellState`. `formatBudget` is already defined in this file — call it directly, do not import it. Add these constants and helpers above `selectShellState`:

```typescript
const BUS_VEHICLE_COST = 8_000;
const METRO_VEHICLE_COST = 50_000;

function stopLabel(state: GameState, stopId: string): { label: string; coord: string } {
  const stop = state.transit.stops.find((s) => s.id === stopId);
  if (stop !== undefined) {
    return {
      label: stop.kind === "busTerminal" ? "Bus Terminal" : "Bus Stop",
      coord: `(${stop.position.x},${stop.position.y})`,
    };
  }
  const station = state.transit.stations.find((s) => s.id === stopId);
  if (station !== undefined) {
    return {
      label: "Metro Station",
      coord: `(${station.position.x},${station.position.y})`,
    };
  }
  return { label: stopId, coord: "" };
}

function buildRouteDraft(
  state: GameState,
  ui: UiState,
): ShellRouteDraftState | null {
  const isBus = ui.activeTool === "busRoute";
  const isMetro = ui.activeTool === "metroLine";
  if (!isBus && !isMetro) {
    return null;
  }
  const ids = isBus ? ui.draftStopIds : ui.draftStationIds;
  if (ids.length === 0) {
    return null;
  }
  const vehicleCost = isBus ? BUS_VEHICLE_COST : METRO_VEHICLE_COST;
  const distinct = new Set(ids).size;
  const affordable = state.budget >= vehicleCost;
  const canFinish = distinct >= 2 && affordable;
  const finishHint =
    distinct < 2
      ? "Add another stop"
      : affordable
        ? "Ready"
        : `Need ${formatBudget(vehicleCost)}`;

  return {
    mode: isBus ? "bus" : "metro",
    stops: ids.map((id, index) => {
      const { label, coord } = stopLabel(state, id);
      return { index, label, coord };
    }),
    distinctCount: distinct,
    vehicleCost,
    canFinish,
    finishHint,
  };
}

function buildRouteList(state: GameState, ui: UiState): ShellRouteListState {
  const buses: ShellRouteListState = state.transit.routes.map((route) => ({
    id: route.id,
    name: route.name,
    color: route.color,
    mode: "bus",
    stopCount: route.stopIds.length,
    active: route.active,
    selected: ui.selectedRouteId === route.id,
  }));
  const metros: ShellRouteListState = state.transit.metroLines.map((line) => ({
    id: line.id,
    name: line.name,
    color: line.color,
    mode: "metro",
    stopCount: line.stationIds.length,
    active: line.active,
    selected: ui.selectedRouteId === line.id,
  }));
  return [...buses, ...metros];
}
```

Add the imports for the new types at the top of the file:

```typescript
import type {
  ShellInspectorState,
  ShellPlatform,
  ShellRouteDraftState,
  ShellRouteListState,
  ShellState,
} from "./types";
```

Then add the two fields to the object returned by `selectShellState`:

```typescript
    inspector: buildInspector(state, ui),
    routeDraft: buildRouteDraft(state, ui),
    routes: buildRouteList(state, ui),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts -t "route selectors"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/routePalette.ts src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime/runtimeSelectors.test.ts
git commit -m "feat: route draft and route list selectors"
```

---

## Task 7: Control Tower — draft sub-panel

**Files:**
- Modify: `src/components/ControlTower.svelte`
- Test: `tests/ui/controlTower.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui/controlTower.test.ts`. Extend the `props()` helper to supply the new props with defaults (`routeDraft: null`, `routes: []`, and the new callbacks as `vi.fn()`), then:

```typescript
import type {
  ShellRouteDraftState,
  ShellRouteListState,
} from "../../src/runtime/types";

const busDraft: ShellRouteDraftState = {
  mode: "bus",
  stops: [
    { index: 0, label: "Bus Stop", coord: "(7,8)" },
    { index: 1, label: "Bus Stop", coord: "(15,8)" },
  ],
  distinctCount: 2,
  vehicleCost: 8000,
  canFinish: true,
  finishHint: "Ready",
};

describe("ControlTower route draft", () => {
  it("renders the draft stop list and fires finish/remove/cancel", () => {
    const onFinishRoute = vi.fn();
    const onRemoveDraftStop = vi.fn();
    const onCancelRoute = vi.fn();
    const { getByTestId, getByRole } = render(ControlTower, {
      props: props({
        routeDraft: busDraft,
        activeTool: "busRoute",
        onFinishRoute,
        onRemoveDraftStop,
        onCancelRoute,
      }),
    });

    fireEvent.click(getByRole("button", { name: /finish route/i }));
    expect(onFinishRoute).toHaveBeenCalled();

    fireEvent.click(getByTestId("remove-draft-stop-0"));
    expect(onRemoveDraftStop).toHaveBeenCalledWith(0);

    fireEvent.click(getByRole("button", { name: /cancel route/i }));
    expect(onCancelRoute).toHaveBeenCalled();
  });

  it("disables finish with the hint when not finishable", () => {
    const { getByRole } = render(ControlTower, {
      props: props({
        routeDraft: { ...busDraft, canFinish: false, finishHint: "Add another stop" },
        activeTool: "busRoute",
      }),
    });
    const finish = getByRole("button", { name: /finish route/i });
    expect(finish).toBeDisabled();
    expect(finish).toHaveTextContent(/add another stop/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/ui/controlTower.test.ts -t "route draft"`
Expected: FAIL — props/markup do not exist.

- [ ] **Step 3: Add the props and draft markup**

In `src/components/ControlTower.svelte`, extend the `Props` interface and `$props()` destructure with:

```typescript
    routeDraft: ShellRouteDraftState | null;
    routes: ShellRouteListState;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
```

Add to the imports:

```typescript
  import type {
    ShellControlTowerState,
    ShellInspectorState,
    ShellRouteDraftState,
    ShellRouteListState,
  } from "../runtime/types";
  import { ROUTE_COLOR_PALETTE } from "../ui/routePalette";
```

Inside the existing `03 · Route Planning` `<section>`, after the route-tools `<div class="toolbar">`, add the draft sub-panel:

```svelte
    {#if routeDraft !== null}
      <div class="route-draft" data-testid="route-draft">
        <ol class="draft-stops">
          {#each routeDraft.stops as stop (stop.index)}
            <li class="draft-stop">
              <span class="draft-stop-label"
                >{stop.index + 1} · {stop.label} {stop.coord}</span
              >
              <button
                type="button"
                class="draft-stop-remove"
                data-testid={`remove-draft-stop-${stop.index}`}
                aria-label={`Remove stop ${stop.index + 1}`}
                onclick={() => onRemoveDraftStop(stop.index)}
              >
                ×
              </button>
            </li>
          {/each}
        </ol>
        <div class="draft-actions">
          <button
            type="button"
            class="draft-finish"
            disabled={!routeDraft.canFinish}
            onclick={onFinishRoute}
          >
            {routeDraft.canFinish ? "Finish Route" : `Finish Route — ${routeDraft.finishHint}`}
          </button>
          <button type="button" class="draft-cancel" onclick={onCancelRoute}>
            Cancel Route
          </button>
        </div>
      </div>
    {/if}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/ui/controlTower.test.ts -t "route draft"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ControlTower.svelte tests/ui/controlTower.test.ts
git commit -m "feat: control tower route draft sub-panel"
```

---

## Task 8: Control Tower — Routes management section

**Files:**
- Modify: `src/components/ControlTower.svelte`
- Test: `tests/ui/controlTower.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/ui/controlTower.test.ts`:

```typescript
const routeList: ShellRouteListState = [
  {
    id: "route-001",
    name: "Bus 1",
    color: "#e04f39",
    mode: "bus",
    stopCount: 3,
    active: true,
    selected: false,
  },
];

describe("ControlTower route management", () => {
  it("lists routes and fires select / toggle / recolor", () => {
    const onSelectRoute = vi.fn();
    const onToggleRouteActive = vi.fn();
    const onRecolorRoute = vi.fn();
    const { getByTestId } = render(ControlTower, {
      props: props({
        routes: routeList,
        onSelectRoute,
        onToggleRouteActive,
        onRecolorRoute,
      }),
    });

    fireEvent.click(getByTestId("route-select-route-001"));
    expect(onSelectRoute).toHaveBeenCalledWith("route-001");

    fireEvent.click(getByTestId("route-toggle-route-001"));
    expect(onToggleRouteActive).toHaveBeenCalledWith("route-001");

    fireEvent.click(getByTestId("route-color-route-001-#2867b2"));
    expect(onRecolorRoute).toHaveBeenCalledWith("route-001", "#2867b2");
  });

  it("renames on blur and requires confirm before delete", () => {
    const onRenameRoute = vi.fn();
    const onDeleteRoute = vi.fn();
    const { getByTestId } = render(ControlTower, {
      props: props({ routes: routeList, onRenameRoute, onDeleteRoute }),
    });

    const input = getByTestId("route-name-route-001") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Loop" } });
    fireEvent.blur(input);
    expect(onRenameRoute).toHaveBeenCalledWith("route-001", "Loop");

    // First click arms confirm; second confirms.
    fireEvent.click(getByTestId("route-delete-route-001"));
    expect(onDeleteRoute).not.toHaveBeenCalled();
    fireEvent.click(getByTestId("route-delete-route-001"));
    expect(onDeleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("shows an empty hint when there are no routes", () => {
    const { getByText } = render(ControlTower, { props: props({ routes: [] }) });
    expect(getByText(/no routes yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/ui/controlTower.test.ts -t "route management"`
Expected: FAIL.

- [ ] **Step 3: Add the Routes section markup + confirm state**

In `src/components/ControlTower.svelte` `<script>`, add a local confirm-arming state keyed by route id:

```typescript
  let pendingDeleteId = $state<string | null>(null);

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }
```

Add the section after the `05 · Brief` section (before the conditional inspector section). Renumber the inspector section's `<span class="num">06</span>` to `07` and use `06` here:

```svelte
  <section class="panel-section routes-section" data-testid="routes-panel">
    <h3 class="section-head"><span class="num">06</span> Routes</h3>
    {#if routes.length === 0}
      <p class="brief-id">No routes yet</p>
    {:else}
      <ul class="route-list">
        {#each routes as route (route.id)}
          <li class="route-item" class:route-item--inactive={!route.active}>
            <div class="route-item-head">
              <button
                type="button"
                class="route-select"
                class:active={route.selected}
                data-testid={`route-select-${route.id}`}
                aria-pressed={route.selected}
                style={`--route-color: ${route.color}`}
                onclick={() => onSelectRoute(route.id)}
              >
                <span class="route-swatch" aria-hidden="true"></span>
                <span class="route-mode">{route.mode === "bus" ? "Bus" : "Metro"}</span>
                <span class="route-stops">{route.stopCount} stops</span>
              </button>
              <input
                type="text"
                class="route-name"
                data-testid={`route-name-${route.id}`}
                value={route.name}
                aria-label={`Rename ${route.name}`}
                onblur={(event) =>
                  onRenameRoute(route.id, event.currentTarget.value)}
              />
            </div>
            <div class="route-item-controls">
              <button
                type="button"
                class="route-toggle"
                data-testid={`route-toggle-${route.id}`}
                aria-label={`${route.active ? "Pause" : "Resume"} ${route.name}`}
                onclick={() => onToggleRouteActive(route.id)}
              >
                {route.active ? "Pause" : "Resume"}
              </button>
              <div class="route-colors" aria-label="Route color">
                {#each ROUTE_COLOR_PALETTE as color (color)}
                  <button
                    type="button"
                    class="route-color"
                    class:active={route.color === color}
                    data-testid={`route-color-${route.id}-${color}`}
                    style={`--route-color: ${color}`}
                    aria-label={`Set color ${color}`}
                    onclick={() => onRecolorRoute(route.id, color)}
                  ></button>
                {/each}
              </div>
              <button
                type="button"
                class="route-delete"
                class:route-delete--armed={pendingDeleteId === route.id}
                data-testid={`route-delete-${route.id}`}
                onclick={() => handleDeleteClick(route.id)}
              >
                {pendingDeleteId === route.id ? "Delete?" : "Delete"}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
```

Add `routes`, `pendingDeleteId`, and the new callbacks to the `$props()` destructure (the prop types were added in Task 7).

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/ui/controlTower.test.ts -t "route management"`
Expected: PASS.

- [ ] **Step 5: Run the full Control Tower suite (catch the renumber regression)**

Run: `bunx vitest run tests/ui/controlTower.test.ts`
Expected: PASS — if a test asserted the inspector header was `06`, update it to `07`.

- [ ] **Step 6: Commit**

```bash
git add src/components/ControlTower.svelte tests/ui/controlTower.test.ts
git commit -m "feat: control tower route management section"
```

---

## Task 9: Wire App.svelte

**Files:**
- Modify: `src/App.svelte`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Inspect current wiring**

Open `src/App.svelte`. Find the `<ControlTower ... />` usage and the existing handler pattern (each handler calls a runtime method and `setSnapshot(...)`). The new handlers follow the exact same shape.

- [ ] **Step 2: Add handlers and pass props**

In the `<script>` of `src/App.svelte`, add (matching the existing `handleAssignRouteToPlatform` style):

```typescript
  function handleRemoveDraftStop(index: number): void {
    setSnapshot(runtime.removeDraftStop(index));
  }
  function handleFinishRoute(): void {
    setSnapshot(runtime.finishRoute());
  }
  function handleCancelRoute(): void {
    setSnapshot(runtime.cancelRoute());
  }
  function handleRenameRoute(routeId: string, name: string): void {
    setSnapshot(runtime.renameRoute(routeId, name));
  }
  function handleRecolorRoute(routeId: string, color: string): void {
    setSnapshot(runtime.recolorRoute(routeId, color));
  }
  function handleToggleRouteActive(routeId: string): void {
    setSnapshot(runtime.toggleRouteActive(routeId));
  }
  function handleDeleteRoute(routeId: string): void {
    setSnapshot(runtime.deleteRoute(routeId));
  }
  function handleSelectRoute(routeId: string | null): void {
    setSnapshot(runtime.selectRoute(routeId));
  }
```

On the `<ControlTower ... />` element, pass the new props (drawing `routeDraft` and `routes` from `shell`):

```svelte
        routeDraft={shell.routeDraft}
        routes={shell.routes}
        onRemoveDraftStop={handleRemoveDraftStop}
        onFinishRoute={handleFinishRoute}
        onCancelRoute={handleCancelRoute}
        onRenameRoute={handleRenameRoute}
        onRecolorRoute={handleRecolorRoute}
        onToggleRouteActive={handleToggleRouteActive}
        onDeleteRoute={handleDeleteRoute}
        onSelectRoute={handleSelectRoute}
```

(`shell` is the derived `ShellState` already used to feed `ControlTower`; confirm the local variable name in App.svelte and match it.)

- [ ] **Step 3: Run the app-shell suite**

Run: `bunx vitest run tests/ui/appShell.test.ts`
Expected: PASS (no prop-type errors; existing shell rendering unaffected).

- [ ] **Step 4: Type-check the whole frontend**

Run: `bun run check`
Expected: PASS — no missing-prop or type errors across `App.svelte` / `ControlTower.svelte`.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte
git commit -m "feat: wire route creation/management controls into App"
```

---

## Task 10: Render — selected-route highlight + draft preview

**Files:**
- Modify: `src/render/transitRenderer.ts`
- Modify: `src/render/canvas.ts` (pass `ui` to `renderTransit`)
- Test: `tests/render/transitRenderer.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `tests/render/transitRenderer.test.ts` (jsdom project):

```typescript
import { describe, expect, it } from "vitest";
import { renderTransit } from "../../src/render/transitRenderer";
import { createInitialGameState } from "../../legacy-ts-simulation/gameState";
import { createUiState } from "../../src/ui/uiState";
import {
  addBusRoute,
  addBusStop,
  assignVehicle,
} from "../../legacy-ts-simulation/transit";

function ctx(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("no 2d context");
  }
  return context;
}

describe("renderTransit highlight", () => {
  function busState() {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    return assignVehicle(state, "bus", "route-001");
  }

  it("renders without a selection or draft", () => {
    expect(() => renderTransit(ctx(), busState(), createUiState())).not.toThrow();
  });

  it("renders with a selected route", () => {
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    expect(() => renderTransit(ctx(), busState(), ui)).not.toThrow();
  });

  it("renders a draft preview", () => {
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(() => renderTransit(ctx(), busState(), ui)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run tests/render/transitRenderer.test.ts`
Expected: FAIL — `renderTransit` currently takes only `(ctx, state)` (TypeScript arity error / no `ui` highlight).

- [ ] **Step 3: Extend `renderTransit` and update the call site**

In `src/render/transitRenderer.ts`, import `UiState` and add highlight passes. Change the signature and append draws after the existing route/line polylines:

```typescript
import type { GameState, Point, Vehicle } from "../domain/types";
import type { UiState } from "../ui/uiState";
```

```typescript
export function renderTransit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  for (const route of state.transit.routes) {
    drawPolyline(ctx, routePositions(state, route.stopIds), route.color, 5);
  }

  for (const line of state.transit.metroLines) {
    drawPolyline(ctx, stationPositions(state, line.stationIds), line.color, 8);
  }

  // Highlight the selected route/line with a wide translucent halo stroke.
  if (ui.selectedRouteId !== null) {
    const route = state.transit.routes.find((r) => r.id === ui.selectedRouteId);
    if (route !== undefined) {
      drawPolyline(ctx, routePositions(state, route.stopIds), "#ffffffaa", 9);
    }
    const line = state.transit.metroLines.find(
      (l) => l.id === ui.selectedRouteId,
    );
    if (line !== undefined) {
      drawPolyline(ctx, stationPositions(state, line.stationIds), "#ffffffaa", 12);
    }
  }

  // Draft preview: dashed stroke through the in-progress stops.
  const draftIds =
    ui.activeTool === "busRoute"
      ? ui.draftStopIds
      : ui.activeTool === "metroLine"
        ? ui.draftStationIds
        : [];
  if (draftIds.length >= 1) {
    const positions =
      ui.activeTool === "busRoute"
        ? routePositions(state, draftIds)
        : stationPositions(state, draftIds);
    ctx.save();
    ctx.setLineDash([6, 6]);
    drawPolyline(ctx, positions, "#f4d35e", 3);
    ctx.restore();
  }

  // ...existing stop / station / vehicle drawing stays unchanged below...
```

Keep the remaining body (stops, stations, vehicles) exactly as-is. Confirm `routePositions` and `stationPositions` are the existing helpers in this file (used by the polyline calls above); reuse them.

In `src/render/canvas.ts`, update the call in `renderGame`:

```typescript
  renderTransit(ctx, state, ui);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run tests/render/transitRenderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/transitRenderer.ts src/render/canvas.ts tests/render/transitRenderer.test.ts
git commit -m "feat: render selected-route highlight and draft preview"
```

---

## Task 11: Router inactive confirmation + e2e smoke

**Files:**
- Test: `tests/simulation/router.test.ts`
- Test: `tests/e2e/routes.spec.ts` (create)

Note: `tests/simulation/router.test.ts` already has `"ignores inactive routes and lines deterministically"` (line ~174), which constructs inactive state manually. The new test below instead exercises the **`setRouteActive` mutator** path so the management toggle is covered end-to-end. It mirrors the existing `"creates a bus route when stops connect the origin and destination"` test (line ~46) for the active assertion.

- [ ] **Step 1: Write the router test through `setRouteActive`**

Append inside the `describe("route planning", ...)` block in `tests/simulation/router.test.ts`. The file already imports `findRoutePlan`, `createInitialGameState`, and `addBusStop`/`addBusRoute`; add `setRouteActive` to the transit import:

```typescript
import { setRouteActive } from "../../legacy-ts-simulation/transit";

it("drops the bus leg once the route is toggled inactive via setRouteActive", () => {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 22, y: 8 });
  state = addBusRoute(state, ["stop-001", "stop-002"]);

  const active = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });
  expect(active?.legs.map((leg) => leg.mode)).toEqual(["walk", "bus", "walk"]);

  const inactiveState = setRouteActive(state, "route-001", false);
  const inactive = findRoutePlan(inactiveState, { x: 6, y: 8 }, { x: 23, y: 8 });
  expect(inactive?.legs.some((leg) => leg.mode === "bus")).toBe(false);
});
```

- [ ] **Step 2: Run the router test**

Run: `bunx vitest run tests/simulation/router.test.ts -t "toggled inactive"`
Expected: PASS — the behavior already exists in `activeServices`; this locks in the mutator path.

- [ ] **Step 3: Write the e2e smoke flow**

Create `tests/e2e/routes.spec.ts`, copying the dev-server harness and `clickMapTile` helper from `tests/e2e/smoke.spec.ts` (same `beforeAll`/`afterAll` and `mapWidth`/`mapHeight`/`tileSize` constants). Build tools are selected by their visible label (e.g. `getByRole("button", { name: "Bus Stop" })`); the route tool button has aria-label `Bus Route`. The full body:

```typescript
import { expect, test, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let appUrl: string;

const mapWidth = 28;
const mapHeight = 18;
const tileSize = 32;

async function clickMapTile(
  canvas: Locator,
  tile: { x: number; y: number },
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
  await canvas.click({
    position: {
      x: offsetX + (tile.x + 0.5) * tileSize * scale,
      y: offsetY + (tile.y + 0.5) * tileSize * scale,
    },
  });
}

test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.config.ts",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const resolved = server.resolvedUrls?.local[0];
  if (!resolved) throw new Error("Vite dev server did not expose a local URL");
  appUrl = resolved;
});

test.afterAll(async () => {
  await server.close();
});

test("create, manage, and delete a bus route", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Place three bus stops. Coordinates must satisfy isValidBusStopPlacement;
  // run the test and adjust these tiles if placement is rejected (no stop
  // appears / budget unchanged). The default Growing Suburb map has road tiles
  // these are chosen to be adjacent to.
  await page.getByRole("button", { name: "Bus Stop" }).click();
  await clickMapTile(canvas, { x: 7, y: 8 });
  await clickMapTile(canvas, { x: 15, y: 8 });
  await clickMapTile(canvas, { x: 22, y: 8 });

  // Draft a route: add three stops, remove the middle one, then finish.
  await page.getByRole("button", { name: "Bus Route" }).click();
  await clickMapTile(canvas, { x: 7, y: 8 });
  await clickMapTile(canvas, { x: 15, y: 8 });
  await clickMapTile(canvas, { x: 22, y: 8 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByTestId("remove-draft-stop-1").click();
  await page.getByRole("button", { name: /finish route/i }).click();

  // The route now appears in the management panel.
  await expect(page.getByTestId("routes-panel")).toBeVisible();
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Toggle inactive, then delete (two clicks for confirm).
  await page.getByTestId("route-toggle-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await expect(page.getByTestId("route-name-route-001")).toHaveCount(0);
});
```

If a `clickMapTile` placement is rejected by `isValidBusStopPlacement`, adjust the three stop coordinates to valid tiles (run with `--headed` to see the board) — the rest of the flow is independent of the exact tiles.

- [ ] **Step 4: Run the e2e suite**

Run: `bun run test:e2e`
Expected: PASS for `routes.spec.ts` (and no regressions in `smoke.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add tests/simulation/router.test.ts tests/e2e/routes.spec.ts
git commit -m "test: router inactive exclusion via setRouteActive + route lifecycle e2e"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full check + lint + tests**

Run:
```bash
bun run check
bun run lint
bun run test
```
Expected: all PASS. Common follow-ups to fix if they fail:
- eslint unused-var: ensure the old `stripRoutesFromPlatforms` in `actions.ts` was deleted and any now-unused imports removed.
- a stale test asserting auto-commit at 2 stops: migrate it to the explicit-finish flow.
- inspector section header renumber (`06` → `07`) if a test asserted the old number.

- [ ] **Step 2: Run e2e**

Run: `bun run test:e2e`
Expected: PASS.

- [ ] **Step 3: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for route creation/management"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** creation flow (Tasks 3–5, 7), naming/color auto + edit (Tasks 1, 6, 8), management ops list/rename/recolor/toggle/delete/highlight (Tasks 1, 2, 5, 6, 8, 10), draft placement in Route Planning (Task 7), Routes section (Task 8), render highlight + draft preview (Task 10), router inactive exclusion (Task 11), tests across all five tiers (Tasks 1–11).
- **Deferred (out of scope, per spec):** editing a committed route's stops, per-route vehicle count, free-form color picker.
- **Type consistency:** controller methods (`finishRoute`, `cancelRoute`, `removeDraftStop`, `renameRoute`, `recolorRoute`, `toggleRouteActive`, `deleteRoute`, `selectRoute`) match `types.ts`, `createGameRuntime.ts`, and the `App.svelte` handlers. Shell shapes (`ShellRouteDraftState`, `ShellRouteListItem`/`ShellRouteListState`) match the selector output and the Control Tower props.
