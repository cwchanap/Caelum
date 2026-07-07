# Build Menu Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the Build drawer into two first-class HUD categories — **Build** (a category→item drill-down) and **Area** (flat zone paints) — and move the global Inspect/Remove tools to a persistent HUD toggle cluster.

**Architecture:** Rust stays the gameplay source of truth; this is a UI + runtime-boundary change only. A new read-only catalog (`buildMenu.ts`) defines the Build drill-down as data. One new `UiState` field (`buildCategory`) tracks the open Build category. Leaf selection reuses existing setters (which already close the drawer); category navigation is a new pure-UI commit that keeps the drawer open.

**Tech Stack:** TypeScript, Svelte 5 (runes mode), Vitest (jsdom `ui` + node `runtime` projects), Playwright (e2e), Bun.

## Global Constraints

- Package manager is **Bun** (`bun install`, `bunx vitest`); never npm/yarn.
- **Svelte 5 runes mode** — use `$state`/`$props`/`$derived`; never `export let`/stores.
- **Immutable state, reference-equality dispatch** — return new objects; the runtime re-renders only when `nextState !== state` or ui changed. Never mutate in place.
- **Determinism is a contract** — no `Math.random`/wall-clock in gameplay code (not touched here, but do not introduce it).
- Lint is strict: eslint + `tsc --noEmit` + svelte-check; unused vars must be prefixed `_`.
- `tests/` mirrors `src/`: DOM/Svelte tests under `tests/ui`, node tests under `tests/runtime`, Playwright under `tests/e2e`.
- Road preset ids are exactly `"twoWay" | "oneWay" | "dualBidirectional"` with labels `"1-Lane" | "1-Lane One-Way" | "2-Lane"`.
- Building labels come from `BUILDING_CATALOG[type].label` — never hardcode a second copy.
- Full verification gate before finishing: `bun run check`, `bun run lint`, `bun run test`.

---

## File Structure

**Create:**
- `src/domain/catalog/buildMenu.ts` — the Build drill-down catalog (categories → items → actions).
- `src/components/hud/panels/AreaPanel.svelte` — flat 6-zone paint panel.
- `tests/ui/buildMenu.test.ts` — catalog integrity tests.
- `tests/ui/areaPanel.test.ts` — AreaPanel component tests.

**Modify:**
- `src/ui/uiState.ts` — add `"area"` to `PrimaryHudCategory`; add `buildCategory` field.
- `src/runtime/types.ts` — `RuntimeController.setBuildCategory` + `armRoad`; `ShellHudState` new fields.
- `src/runtime/createGameRuntime.ts` — reset `buildCategory` in the three UI-transition factories; add `setBuildCategory` + `armRoad` methods.
- `src/runtime/runtimeSelectors.ts` — populate the new `ShellHudState` fields.
- `src/components/hud/panels/BuildPanel.svelte` — rewrite as the drill-down.
- `src/components/hud/BottomHud.svelte` — add Area button + persistent Inspect/Remove cluster.
- `src/components/hud/HudDrawer.svelte` — route `area` → AreaPanel; wire new BuildPanel props.
- `src/App.svelte` — new handlers; thread through to drawer + bottom HUD.
- `src/styles.css` — styles for the Build back/breadcrumb and the persistent tool cluster.
- Tests: `tests/ui/uiState.test.ts`, `tests/ui/buildPanel.test.ts`, `tests/ui/bottomHud.test.ts`, `tests/ui/hudPanels.test.ts`, `tests/ui/appShell.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/e2e/helpers.ts`, `tests/e2e/routes.spec.ts`.

---

## Task 1: UiState — `buildCategory` field + `area` category

**Files:**
- Modify: `src/ui/uiState.ts`
- Test: `tests/ui/uiState.test.ts`

**Interfaces:**
- Produces: `PrimaryHudCategory` now includes `"area"`; `UiState.buildCategory: BuildCategoryId | null`; `createUiState()` returns `buildCategory: null`.

- [ ] **Step 1: Write the failing test** — append to `tests/ui/uiState.test.ts`:

```ts
describe("createUiState build menu defaults", () => {
  it("defaults buildCategory to null", () => {
    const ui = createUiState();
    expect(ui.buildCategory).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/uiState.test.ts`
Expected: FAIL — `buildCategory` does not exist on the returned object / type error.

- [ ] **Step 3: Implement** — edit `src/ui/uiState.ts`:

Add the import (top of file, alongside the other domain-catalog-free imports — `buildMenu` imports only from `domain/types`, so no cycle):

```ts
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
```

Extend `PrimaryHudCategory`:

```ts
export type PrimaryHudCategory =
  | "build"
  | "area"
  | "routes"
  | "manage"
  | "data"
  | "brief";
```

Add the field to the `UiState` interface (next to `selectedArea`):

```ts
  selectedArea: AreaKind | null;
  /** Open Build drill-down category, or null when showing the category root. */
  buildCategory: BuildCategoryId | null;
```

Add the default in `createUiState()` (next to `selectedArea: null`):

```ts
    selectedArea: null,
    buildCategory: null,
```

> Note: `BuildCategoryId` lives in `buildMenu.ts`, created in Task 2. Both the `import type` and the `buildCategory: BuildCategoryId | null` annotation are erased by esbuild when vitest transpiles, so this task's test (Step 4) passes standalone. A full `bun run check` (tsc) won't pass until Task 2 lands the catalog — that whole-project type gate is deferred to Task 11, by which point the file exists. Do not run `bun run check` as this task's gate; the vitest run below is the gate.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/uiState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/uiState.ts tests/ui/uiState.test.ts
git commit -m "feat(ui): add buildCategory state and area HUD category"
```

---

## Task 2: Build menu catalog

**Files:**
- Create: `src/domain/catalog/buildMenu.ts`
- Test: `tests/ui/buildMenu.test.ts`

**Interfaces:**
- Consumes: `BUILDING_CATALOG` from `./buildings`; `BuildingType`, `RoadPreset` from `../types`.
- Produces:
  - `type BuildCategoryId = "road" | "rail" | "bus" | "metro" | "residential" | "commercial" | "industrial" | "office" | "civic" | "park"`
  - `type BuildItemAction = { kind: "road"; roadPreset: RoadPreset } | { kind: "track" } | { kind: "building"; building: BuildingType }`
  - `interface BuildMenuItem { id: string; label: string; action: BuildItemAction }`
  - `interface BuildMenuCategory { id: BuildCategoryId; label: string; items: BuildMenuItem[] }`
  - `const BUILD_MENU: BuildMenuCategory[]` (ordered: road, rail, bus, metro, residential, commercial, industrial, office, civic, park)

- [ ] **Step 1: Write the failing test** — create `tests/ui/buildMenu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUILD_MENU } from "../../src/domain/catalog/buildMenu";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type { BuildingType } from "../../src/domain/types";

describe("BUILD_MENU", () => {
  it("orders the ten categories as specified", () => {
    expect(BUILD_MENU.map((c) => c.id)).toEqual([
      "road", "rail", "bus", "metro",
      "residential", "commercial", "industrial", "office", "civic", "park",
    ]);
  });

  it("covers every building in BUILDING_CATALOG exactly once", () => {
    const placed = BUILD_MENU.flatMap((c) =>
      c.items.flatMap((i) => (i.action.kind === "building" ? [i.action.building] : [])),
    );
    const catalogTypes = Object.keys(BUILDING_CATALOG) as BuildingType[];
    expect([...placed].sort()).toEqual([...catalogTypes].sort());
  });

  it("labels building items from BUILDING_CATALOG", () => {
    for (const category of BUILD_MENU) {
      for (const item of category.items) {
        if (item.action.kind === "building") {
          expect(item.label).toBe(BUILDING_CATALOG[item.action.building].label);
        }
      }
    }
  });

  it("maps the three road presets under the road category", () => {
    const road = BUILD_MENU.find((c) => c.id === "road");
    expect(road?.items.map((i) => (i.action.kind === "road" ? i.action.roadPreset : null))).toEqual([
      "twoWay", "oneWay", "dualBidirectional",
    ]);
  });

  it("puts a single track item under rail", () => {
    const rail = BUILD_MENU.find((c) => c.id === "rail");
    expect(rail?.items).toHaveLength(1);
    expect(rail?.items[0]?.action.kind).toBe("track");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/buildMenu.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/catalog/buildMenu`.

- [ ] **Step 3: Implement** — create `src/domain/catalog/buildMenu.ts`:

```ts
import type { BuildingType, RoadPreset } from "../types";
import { BUILDING_CATALOG } from "./buildings";

export type BuildCategoryId =
  | "road"
  | "rail"
  | "bus"
  | "metro"
  | "residential"
  | "commercial"
  | "industrial"
  | "office"
  | "civic"
  | "park";

/** What committing a Build leaf does. Roads carry a preset; track and buildings
 *  do not. The panel dispatches these to the matching runtime setter. */
export type BuildItemAction =
  | { kind: "road"; roadPreset: RoadPreset }
  | { kind: "track" }
  | { kind: "building"; building: BuildingType };

export interface BuildMenuItem {
  /** Stable id, unique within a category (used as the render key + data attr). */
  id: string;
  label: string;
  action: BuildItemAction;
}

export interface BuildMenuCategory {
  id: BuildCategoryId;
  label: string;
  items: BuildMenuItem[];
}

function buildingItem(building: BuildingType): BuildMenuItem {
  return {
    id: building,
    label: BUILDING_CATALOG[building].label,
    action: { kind: "building", building },
  };
}

export const BUILD_MENU: BuildMenuCategory[] = [
  {
    id: "road",
    label: "Road",
    items: [
      { id: "road-twoWay", label: "1-Lane", action: { kind: "road", roadPreset: "twoWay" } },
      { id: "road-oneWay", label: "1-Lane One-Way", action: { kind: "road", roadPreset: "oneWay" } },
      { id: "road-dual", label: "2-Lane", action: { kind: "road", roadPreset: "dualBidirectional" } },
    ],
  },
  { id: "rail", label: "Rail", items: [{ id: "track", label: "Track", action: { kind: "track" } }] },
  { id: "bus", label: "Bus", items: [buildingItem("busStop"), buildingItem("busTerminal")] },
  { id: "metro", label: "Metro", items: [buildingItem("metroStation")] },
  { id: "residential", label: "Residential", items: [buildingItem("smallHouse"), buildingItem("largeHouse")] },
  { id: "commercial", label: "Commercial", items: [buildingItem("supermarket"), buildingItem("cinema")] },
  { id: "industrial", label: "Industrial", items: [buildingItem("factory"), buildingItem("warehouse")] },
  { id: "office", label: "Office", items: [buildingItem("officeTower"), buildingItem("businessPark")] },
  { id: "civic", label: "Civic", items: [buildingItem("clinic"), buildingItem("school")] },
  { id: "park", label: "Park", items: [buildingItem("parkPlaza")] },
];

export function findBuildCategory(id: BuildCategoryId | null): BuildMenuCategory | null {
  return id === null ? null : (BUILD_MENU.find((c) => c.id === id) ?? null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/buildMenu.test.ts tests/ui/uiState.test.ts`
Expected: PASS (both files — Task 1's import now resolves).

- [ ] **Step 5: Commit**

```bash
git add src/domain/catalog/buildMenu.ts tests/ui/buildMenu.test.ts src/ui/uiState.ts tests/ui/uiState.test.ts
git commit -m "feat(catalog): add build menu drill-down catalog"
```

---

## Task 3: Runtime — `setBuildCategory`, `armRoad`, reset `buildCategory`

**Files:**
- Modify: `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`
- Test: `tests/runtime/gameRuntime.test.ts`, and update the `tests/ui/appShell.test.ts` harness stub (same task, to keep types green).

**Interfaces:**
- Consumes: `BuildCategoryId` from `domain/catalog/buildMenu`; `RoadPreset` from `domain/types`.
- Produces (on `RuntimeController`):
  - `setBuildCategory: (category: BuildCategoryId | null) => RuntimeSnapshot`
  - `armRoad: (preset: RoadPreset) => RuntimeSnapshot` — selects the road tool AND sets `roadPreset` in one commit (closes the drawer).
  - `setTool`/`setArea`/`setBuilding` now also reset `buildCategory` to `null`.

- [ ] **Step 1: Write the failing test** — append to `tests/runtime/gameRuntime.test.ts`. The file already imports `createGameRuntime` and defines a `backendSpy()` helper (both used by the existing tests, e.g. `const runtime = await createGameRuntime({ backend: backendSpy() })`); reuse them:

```ts
describe("build category navigation", () => {
  it("setBuildCategory changes buildCategory without closing the drawer", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setHudCategory("build");
    const snap = runtime.setBuildCategory("bus");
    expect(snap.ui.buildCategory).toBe("bus");
    expect(snap.ui.activeHudCategory).toBe("build");
  });

  it("setBuildCategory(null) returns to the category root", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setBuildCategory("bus");
    expect(runtime.setBuildCategory(null).ui.buildCategory).toBeNull();
  });

  it("selecting a tool/area/building resets buildCategory to null", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setBuildCategory("residential");
    expect(runtime.setBuilding("smallHouse").ui.buildCategory).toBeNull();
    runtime.setBuildCategory("road");
    expect(runtime.setTool("track").ui.buildCategory).toBeNull();
    runtime.setBuildCategory("residential");
    expect(runtime.setArea("residential").ui.buildCategory).toBeNull();
  });

  it("armRoad selects the road tool with the given preset and closes the drawer", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setHudCategory("build");
    const snap = runtime.armRoad("dualBidirectional");
    expect(snap.ui.activeTool).toBe("road");
    expect(snap.ui.roadPreset).toBe("dualBidirectional");
    expect(snap.ui.selectedBuilding).toBeNull();
    expect(snap.ui.activeHudCategory).toBeNull();
    expect(snap.ui.buildCategory).toBeNull();
  });
});
```

> `backendSpy()` is the in-file backend stub; if a given assertion needs the drawer open first, call `runtime.setHudCategory("build")` as shown. The assertions are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts -t "build category navigation"`
Expected: FAIL — `setBuildCategory`/`armRoad` are not functions.

- [ ] **Step 3: Implement** — edit `src/runtime/createGameRuntime.ts`:

Add to the imports (with the other `domain/catalog` type imports if any, else a new line):

```ts
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
```

In `nextToolUiState`, `nextAreaUiState`, and `nextBuildingUiState`, add `buildCategory: null` to each returned object (place it next to the existing `selectedArea: null` / `selectedArea: area` line):

```ts
    selectedArea: null,
    buildCategory: null,
```

(For `nextAreaUiState` the line reads `selectedArea: area,` — add `buildCategory: null,` right after it.)

Add the two methods to the returned controller object (place next to `setArea` / `setRoadPreset`, around line 576):

```ts
    setBuildCategory(category: BuildCategoryId | null) {
      return commit(
        state,
        ui.buildCategory === category ? ui : { ...ui, buildCategory: category },
      );
    },
    armRoad(preset) {
      // Single commit: switch to the road tool (which clears building/area and
      // closes the drawer via nextToolUiState) and set the preset together, so
      // one click fully arms the tool with no intermediate render.
      return commit(state, { ...nextToolUiState("road", ui), roadPreset: preset });
    },
```

Edit `src/runtime/types.ts` — add the import and the two `RuntimeController` members (next to `setRoadPreset`):

```ts
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
```

```ts
  setRoadPreset: (preset: RoadPreset) => RuntimeSnapshot;
  setBuildCategory: (category: BuildCategoryId | null) => RuntimeSnapshot;
  armRoad: (preset: RoadPreset) => RuntimeSnapshot;
```

Edit `tests/ui/appShell.test.ts` — add matching mocks to the harness controller object (next to `setRoadPreset`, around line 146) so the stub still satisfies `RuntimeController`:

```ts
    setBuildCategory: vi.fn((category) => {
      ui = { ...ui, buildCategory: category };
      return publish();
    }),
    armRoad: vi.fn((preset: RoadPreset) => {
      ui = {
        ...ui,
        activeTool: "road",
        selectedBuilding: null,
        selectedArea: null,
        buildCategory: null,
        roadPreset: preset,
        activeHudCategory: null,
      };
      return publish();
    }),
```

Also add `buildCategory: null` to the harness's `setTool`, `setBuilding`, and `setArea` mocks (each rebuilds `ui` explicitly; add the field alongside their `selectedArea` line) so they mirror production.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/createGameRuntime.ts src/runtime/types.ts tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
git commit -m "feat(runtime): add setBuildCategory and armRoad; reset buildCategory on tool switch"
```

---

## Task 4: Selectors — expose `buildCategory` + tool pressed states

**Files:**
- Modify: `src/runtime/types.ts` (`ShellHudState`), `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`, and update `tests/ui/bottomHud.test.ts` `hud()` factory (same task, to keep types green).

**Interfaces:**
- Produces: `ShellHudState` gains `buildCategory: BuildCategoryId | null`, `inspectToolActive: boolean`, `removeToolActive: boolean`.

- [ ] **Step 1: Write the failing test** — append to `tests/runtime/runtimeSelectors.test.ts` (reuse the file's existing state/ui builders — typically `createTestGameState()` and `createUiState()`):

```ts
describe("selectShellState build HUD fields", () => {
  it("exposes buildCategory from ui", () => {
    const hud = selectShellState(createTestGameState(), {
      ...createUiState(),
      buildCategory: "bus",
    }).hud;
    expect(hud.buildCategory).toBe("bus");
  });

  it("marks inspect active only when inspect tool with no building/area", () => {
    const base = createTestGameState();
    expect(
      selectShellState(base, { ...createUiState(), activeTool: "inspect" }).hud
        .inspectToolActive,
    ).toBe(true);
    expect(
      selectShellState(base, {
        ...createUiState(),
        activeTool: "inspect",
        selectedBuilding: "smallHouse",
      }).hud.inspectToolActive,
    ).toBe(false);
  });

  it("marks remove active when the remove tool is selected", () => {
    const hud = selectShellState(createTestGameState(), {
      ...createUiState(),
      activeTool: "remove",
    }).hud;
    expect(hud.removeToolActive).toBe(true);
    expect(hud.inspectToolActive).toBe(false);
  });
});
```

> Import `selectShellState`, `createTestGameState`, `createUiState` as the sibling tests in the file already do; if the file uses different helper names, match them.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts -t "build HUD fields"`
Expected: FAIL — properties missing on `hud`.

- [ ] **Step 3: Implement** — edit `src/runtime/types.ts`, extend `ShellHudState`:

```ts
export interface ShellHudState {
  activeCategory: HudCategory | null;
  activeToolChip: string;
  canCancel: boolean;
  buildCategory: BuildCategoryId | null;
  inspectToolActive: boolean;
  removeToolActive: boolean;
  badges: ShellHudBadges;
}
```

(The `BuildCategoryId` import was added to this file in Task 3.)

Edit `src/runtime/runtimeSelectors.ts` — in the `hud` object literal inside `selectShellState`, add the three fields (after `canCancel: … ,`):

```ts
    canCancel:
      draftActive ||
      ui.activeTool !== "inspect" ||
      ui.selectedBuilding !== null ||
      ui.selectedArea !== null ||
      ui.activeOverlay !== null ||
      ui.selectedRouteId !== null,
    buildCategory: ui.buildCategory,
    inspectToolActive:
      ui.activeTool === "inspect" &&
      ui.selectedBuilding === null &&
      ui.selectedArea === null,
    removeToolActive: ui.activeTool === "remove",
```

Edit `tests/ui/bottomHud.test.ts` — extend the `hud()` factory defaults so the hand-built `ShellHudState` stays valid:

```ts
function hud(overrides: Partial<ShellHudState> = {}): ShellHudState {
  return {
    activeCategory: "brief",
    activeToolChip: "INSPECT",
    canCancel: false,
    buildCategory: null,
    inspectToolActive: true,
    removeToolActive: false,
    badges: {
      routeDraftActive: false,
      routeCount: 0,
      activeOverlayLabel: null,
      inspectActive: false,
    },
    ...overrides,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts tests/ui/bottomHud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime/runtimeSelectors.test.ts tests/ui/bottomHud.test.ts
git commit -m "feat(runtime): expose buildCategory and tool pressed states on ShellHudState"
```

---

## Task 5: AreaPanel component

**Files:**
- Create: `src/components/hud/panels/AreaPanel.svelte`
- Test: `tests/ui/areaPanel.test.ts`

**Interfaces:**
- Produces: `AreaPanel` with props `{ selectedArea: AreaKind | null; onSetArea: (area: AreaKind) => void }`. Renders one `data-area` button per `AREA_KINDS`, marks the selected one `aria-pressed`/`active`, and fires `onSetArea` on click.

- [ ] **Step 1: Write the failing test** — create `tests/ui/areaPanel.test.ts`:

```ts
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AreaPanel from "../../src/components/hud/panels/AreaPanel.svelte";

describe("AreaPanel", () => {
  it("renders the six zones and reports selection", async () => {
    const onSetArea = vi.fn();
    render(AreaPanel, { props: { selectedArea: null, onSetArea } });

    for (const label of [
      "Residential", "Commercial", "Industrial", "Office", "Civic", "Park",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }

    await fireEvent.click(screen.getByRole("button", { name: "Commercial" }));
    expect(onSetArea).toHaveBeenCalledWith("commercial");
  });

  it("marks the selected zone active", () => {
    render(AreaPanel, { props: { selectedArea: "office", onSetArea: vi.fn() } });
    expect(screen.getByRole("button", { name: "Office" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/areaPanel.test.ts`
Expected: FAIL — cannot resolve `AreaPanel.svelte`.

- [ ] **Step 3: Implement** — create `src/components/hud/panels/AreaPanel.svelte`:

```svelte
<script lang="ts">
  import type { AreaKind } from "../../../domain/types";
  import { AREA_KINDS, AREA_LABELS } from "../../../domain/catalog/areas";

  interface Props {
    selectedArea: AreaKind | null;
    onSetArea: (area: AreaKind) => void;
  }

  let { selectedArea, onSetArea }: Props = $props();

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-area">
  <section class="panel-section">
    <h3 class="section-head"><span class="num">01</span> Area</h3>
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
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/areaPanel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/hud/panels/AreaPanel.svelte tests/ui/areaPanel.test.ts
git commit -m "feat(hud): add AreaPanel with the six zone paints"
```

---

## Task 6: Rewrite BuildPanel as the drill-down

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`, `src/styles.css`
- Test: `tests/ui/buildPanel.test.ts` (rewrite)

**Interfaces:**
- Consumes: `BUILD_MENU`, `findBuildCategory`, `BuildCategoryId`, `BuildItemAction` from `domain/catalog/buildMenu`.
- Produces: `BuildPanel` with props:
  ```ts
  {
    buildCategory: BuildCategoryId | null;
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    roadPreset: RoadPreset;
    buildingRotation: BuildingRotation;
    onSetBuildCategory: (id: BuildCategoryId | null) => void;
    onSelectItem: (action: BuildItemAction) => void;
    onRotateBuilding: () => void;
  }
  ```
  Root view: `data-build-category` buttons. Detail view: a `data-action="build-back"` button, a `Build › <label>` breadcrumb, and `data-build-item` buttons (building items also carry `data-building`). The Rotate control is always rendered at the panel bottom, disabled when `selectedBuilding === null`.

- [ ] **Step 1: Write the failing test** — replace the entire contents of `tests/ui/buildPanel.test.ts`:

```ts
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";
import type { BuildCategoryId } from "../../src/domain/catalog/buildMenu";

type Overrides = Partial<{
  buildCategory: BuildCategoryId | null;
  activeTool: "inspect" | "road" | "track";
  selectedBuilding: string | null;
  roadPreset: "twoWay" | "oneWay" | "dualBidirectional";
}>;

function renderPanel(overrides: Overrides = {}) {
  const props = {
    buildCategory: null as BuildCategoryId | null,
    activeTool: "inspect" as const,
    selectedBuilding: null,
    roadPreset: "twoWay" as const,
    buildingRotation: 0 as const,
    onSetBuildCategory: vi.fn(),
    onSelectItem: vi.fn(),
    onRotateBuilding: vi.fn(),
    ...overrides,
  };
  render(BuildPanel, { props });
  return props;
}

describe("BuildPanel root view", () => {
  it("lists the ten categories and drills in on click", async () => {
    const props = renderPanel();
    for (const label of [
      "Road", "Rail", "Bus", "Metro",
      "Residential", "Commercial", "Industrial", "Office", "Civic", "Park",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    await fireEvent.click(screen.getByRole("button", { name: "Bus" }));
    expect(props.onSetBuildCategory).toHaveBeenCalledWith("bus");
  });

  it("disables Rotate when no building is selected", () => {
    renderPanel();
    expect(
      screen.getByRole("button", { name: /Rotate building/i }),
    ).toBeDisabled();
  });
});

describe("BuildPanel detail view", () => {
  it("shows the category's items with a back control", async () => {
    const props = renderPanel({ buildCategory: "bus" });
    expect(screen.getByRole("button", { name: "Bus Stop" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Bus Terminal" })).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(props.onSetBuildCategory).toHaveBeenCalledWith(null);
  });

  it("dispatches a building action for a building item", async () => {
    const props = renderPanel({ buildCategory: "residential" });
    await fireEvent.click(screen.getByRole("button", { name: "Small House" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({
      kind: "building",
      building: "smallHouse",
    });
  });

  it("dispatches a road action carrying the preset", async () => {
    const props = renderPanel({ buildCategory: "road" });
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({
      kind: "road",
      roadPreset: "dualBidirectional",
    });
  });

  it("dispatches a track action", async () => {
    const props = renderPanel({ buildCategory: "rail" });
    await fireEvent.click(screen.getByRole("button", { name: "Track" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({ kind: "track" });
  });

  it("marks the selected building active and enables Rotate", () => {
    renderPanel({ buildCategory: "residential", selectedBuilding: "smallHouse" });
    expect(screen.getByRole("button", { name: "Small House" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /Rotate building/i })).toBeEnabled();
  });

  it("marks the active road preset when the road tool is armed", () => {
    renderPanel({
      buildCategory: "road",
      activeTool: "road",
      roadPreset: "oneWay",
    });
    expect(
      screen.getByRole("button", { name: "1-Lane One-Way" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/buildPanel.test.ts`
Expected: FAIL — old props/markup; new expectations unmet.

- [ ] **Step 3: Implement** — replace the entire contents of `src/components/hud/panels/BuildPanel.svelte`:

```svelte
<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    RoadPreset,
    Tool,
  } from "../../../domain/types";
  import type {
    BuildCategoryId,
    BuildItemAction,
  } from "../../../domain/catalog/buildMenu";
  import { BUILD_MENU, findBuildCategory } from "../../../domain/catalog/buildMenu";

  interface Props {
    buildCategory: BuildCategoryId | null;
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    roadPreset: RoadPreset;
    buildingRotation: BuildingRotation;
    onSetBuildCategory: (id: BuildCategoryId | null) => void;
    onSelectItem: (action: BuildItemAction) => void;
    onRotateBuilding: () => void;
  }

  let {
    buildCategory,
    activeTool,
    selectedBuilding,
    roadPreset,
    buildingRotation,
    onSetBuildCategory,
    onSelectItem,
    onRotateBuilding,
  }: Props = $props();

  const activeCategory = $derived(findBuildCategory(buildCategory));

  function isItemActive(action: BuildItemAction): boolean {
    if (action.kind === "building") {
      return selectedBuilding === action.building;
    }
    if (action.kind === "road") {
      return (
        selectedBuilding === null &&
        activeTool === "road" &&
        roadPreset === action.roadPreset
      );
    }
    return selectedBuilding === null && activeTool === "track";
  }

  function itemBuilding(action: BuildItemAction): BuildingType | undefined {
    return action.kind === "building" ? action.building : undefined;
  }

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-build">
  <section class="panel-section build-section">
    {#if activeCategory === null}
      <h3 class="section-head"><span class="num">01</span> Build</h3>
      <div class="toolbar" aria-label="Build categories">
        {#each BUILD_MENU as category, index (category.id)}
          <button
            type="button"
            data-build-category={category.id}
            aria-label={category.label}
            onclick={() => onSetBuildCategory(category.id)}
          >
            <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
            <span class="tool-label" aria-hidden="true">{category.label}</span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="build-nav">
        <button
          type="button"
          class="build-back"
          data-action="build-back"
          aria-label="Back to build categories"
          onclick={() => onSetBuildCategory(null)}
        >
          ‹ Back
        </button>
        <span class="build-crumb">Build › {activeCategory.label}</span>
      </div>
      <div class="toolbar" aria-label={`${activeCategory.label} items`}>
        {#each activeCategory.items as item, index (item.id)}
          <button
            type="button"
            data-build-item={item.id}
            data-building={itemBuilding(item.action)}
            aria-pressed={isItemActive(item.action)}
            aria-label={item.label}
            class:active={isItemActive(item.action)}
            onclick={() => onSelectItem(item.action)}
          >
            <span class="tool-num" aria-hidden="true">{pad2(index + 1)}</span>
            <span class="tool-label" aria-hidden="true">{item.label}</span>
          </button>
        {/each}
      </div>
    {/if}

    <button
      type="button"
      class="rotate-control"
      aria-label={`Rotate building, current rotation ${buildingRotation} degrees`}
      disabled={selectedBuilding === null}
      onclick={onRotateBuilding}
    >
      <span>Rotate</span>
      <span class="rotate-value">{buildingRotation}</span>
    </button>
  </section>
</div>
```

Add to `src/styles.css` (after the `.rotate-control` block, near line 728):

```css
.build-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.build-back {
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid var(--cyan);
  background: var(--surface-sunk);
  color: var(--ink-mid);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
}

.build-back:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.build-crumb {
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--ink);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/buildPanel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte src/styles.css tests/ui/buildPanel.test.ts
git commit -m "feat(hud): rebuild BuildPanel as a category drill-down"
```

---

## Task 7: BottomHud — Area button + persistent Inspect/Remove cluster

**Files:**
- Modify: `src/components/hud/BottomHud.svelte`, `src/styles.css`
- Test: `tests/ui/bottomHud.test.ts`

**Interfaces:**
- Consumes: `ShellHudState.buildCategory/inspectToolActive/removeToolActive` (Task 4).
- Produces: `BottomHud` gains an `onSetTool: (tool: Tool) => void` prop; renders an **Area** category chip (`hud-cat-area`) and a persistent tool cluster with `data-testid="hud-tool-inspect"` / `hud-tool-remove` that fire `onSetTool("inspect")` / `onSetTool("remove")` and reflect the active flags.

- [ ] **Step 1: Write the failing test** — add to `tests/ui/bottomHud.test.ts`:

Update the first test's category loop to include `area`:

```ts
    for (const id of ["build", "area", "routes", "manage", "data", "brief"]) {
      expect(screen.getByTestId(`hud-cat-${id}`)).toBeVisible();
    }
```

Add `onSetTool: vi.fn()` to every `render(BottomHud, …)` props object in the file, then add this describe block:

```ts
describe("BottomHud persistent tools", () => {
  it("renders Inspect/Remove toggles and fires onSetTool", async () => {
    const onSetTool = vi.fn();
    render(BottomHud, {
      props: {
        hud: hud({ inspectToolActive: true, removeToolActive: false }),
        onSetHudCategory: vi.fn(),
        onCancel: vi.fn(),
        onSetTool,
      },
    });

    const inspect = screen.getByTestId("hud-tool-inspect");
    const remove = screen.getByTestId("hud-tool-remove");
    expect(inspect).toHaveClass("active");
    expect(remove).not.toHaveClass("active");

    await fireEvent.click(remove);
    expect(onSetTool).toHaveBeenCalledWith("remove");
    await fireEvent.click(inspect);
    expect(onSetTool).toHaveBeenLastCalledWith("inspect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/bottomHud.test.ts`
Expected: FAIL — no `hud-cat-area`, no tool toggles, `onSetTool` prop unknown.

- [ ] **Step 3: Implement** — edit `src/components/hud/BottomHud.svelte`:

Add `Tool` to the type import and the `onSetTool` prop:

```svelte
  import type { Tool } from "../../domain/types";
  import type { ShellHudState } from "../../runtime/types";
  import type { HudCategory, PrimaryHudCategory } from "../../ui/uiState";

  interface Props {
    hud: ShellHudState;
    onSetHudCategory: (category: HudCategory | null) => void;
    onCancel: () => void;
    onSetTool: (tool: Tool) => void;
  }

  let { hud, onSetHudCategory, onCancel, onSetTool }: Props = $props();
```

Add Area to the `categories` array (right after `build`):

```ts
  const categories: CategoryButton[] = [
    { id: "build", label: "Build" },
    { id: "area", label: "Area" },
    { id: "routes", label: "Routes" },
    { id: "manage", label: "Manage" },
    { id: "data", label: "Data" },
    { id: "brief", label: "Brief" },
  ];
```

In the `.hud-status` block, add the tool cluster before the tool chip:

```svelte
  <div class="hud-status">
    <div class="hud-tools" aria-label="Global tools">
      <button
        type="button"
        class="hud-tool"
        class:active={hud.inspectToolActive}
        data-testid="hud-tool-inspect"
        aria-pressed={hud.inspectToolActive}
        onclick={() => onSetTool("inspect")}
      >
        Inspect
      </button>
      <button
        type="button"
        class="hud-tool"
        class:active={hud.removeToolActive}
        data-testid="hud-tool-remove"
        aria-pressed={hud.removeToolActive}
        onclick={() => onSetTool("remove")}
      >
        Remove
      </button>
    </div>
    <span class="hud-tool-chip" data-testid="hud-tool-chip">{hud.activeToolChip}</span>
    <!-- existing Cancel button unchanged -->
```

Add to `src/styles.css` (after the `.hud-cancel:disabled` block, near line 1545):

```css
.hud-tools {
  display: flex;
  gap: 6px;
}

.hud-tool {
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--surface-sunk);
  color: var(--ink-mid);
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background 0.12s ease;
}

.hud-tool:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.hud-tool.active {
  color: var(--bg-deep);
  background: var(--amber);
  border-color: var(--amber);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/bottomHud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/hud/BottomHud.svelte src/styles.css tests/ui/bottomHud.test.ts
git commit -m "feat(hud): add Area category and persistent Inspect/Remove tools to the bottom bar"
```

---

## Task 8: HudDrawer — route `area`, wire new BuildPanel props

**Files:**
- Modify: `src/components/hud/HudDrawer.svelte`
- Test: `tests/ui/hudPanels.test.ts`

**Interfaces:**
- Consumes: `AreaPanel` (Task 5), reworked `BuildPanel` (Task 6), `BuildCategoryId`/`BuildItemAction` (Task 2).
- Produces: `HudDrawer` gains props `buildCategory: BuildCategoryId | null`, `onSetBuildCategory: (id: BuildCategoryId | null) => void`, `onSelectBuildItem: (action: BuildItemAction) => void`; drops the now-unused `onSetRoadPreset` from the BuildPanel wiring (keep the prop on HudDrawer only if other panels use it — they don't, so remove it). Renders `AreaPanel` for `category === "area"`, drawer title "Area".

- [ ] **Step 1: Write the failing test** — in `tests/ui/hudPanels.test.ts`, update `drawerProps` to include the new props and add an Area routing test.

Add to the `drawerProps` return object:

```ts
    buildCategory: null,
    onSetBuildCategory: vi.fn(),
    onSelectBuildItem: vi.fn(),
```

Add a test (place near the other drawer routing tests):

```ts
it("routes the area category to the AreaPanel", () => {
  render(HudDrawer, { props: drawerProps({ category: "area" }) });
  expect(screen.getByTestId("panel-area")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Residential" })).toBeVisible();
});

it("shows Build categories then drills in", async () => {
  const onSetBuildCategory = vi.fn();
  render(HudDrawer, {
    props: drawerProps({ category: "build", onSetBuildCategory }),
  });
  await fireEvent.click(screen.getByRole("button", { name: "Bus" }));
  expect(onSetBuildCategory).toHaveBeenCalledWith("bus");
});
```

> If `drawerProps` still lists `onSetRoadPreset`/`onSetArea`, keep `onSetArea` (AreaPanel uses it) and remove `onSetRoadPreset` (nothing consumes it after the rewrite). Ensure the `category` type union in `drawerProps` allows `"area"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/hudPanels.test.ts`
Expected: FAIL — no `panel-area`; BuildPanel prop mismatch.

- [ ] **Step 3: Implement** — edit `src/components/hud/HudDrawer.svelte`:

Add imports:

```ts
  import AreaPanel from "./panels/AreaPanel.svelte";
  import type { BuildCategoryId, BuildItemAction } from "../../domain/catalog/buildMenu";
```

In the `Props` interface: remove `onSetRoadPreset` and `onSetTool`'s BuildPanel usage is retained only if still needed elsewhere (RoutesPanel uses `onSetTool` — keep it). Add:

```ts
    buildCategory: BuildCategoryId | null;
    onSetBuildCategory: (id: BuildCategoryId | null) => void;
    onSelectBuildItem: (action: BuildItemAction) => void;
```

Extend the `titles` map:

```ts
  const titles: Record<HudCategory, string> = {
    build: "Build",
    area: "Area",
    routes: "Routes",
    manage: "Manage",
    data: "Data",
    brief: "Brief",
    inspect: "Inspect",
  };
```

Replace the `build` branch and add an `area` branch in the body:

```svelte
    {#if p.category === "build"}
      <BuildPanel
        buildCategory={p.buildCategory}
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        roadPreset={p.roadPreset}
        buildingRotation={p.buildingRotation}
        onSetBuildCategory={p.onSetBuildCategory}
        onSelectItem={p.onSelectBuildItem}
        onRotateBuilding={p.onRotateBuilding}
      />
    {:else if p.category === "area"}
      <AreaPanel selectedArea={p.selectedArea} onSetArea={p.onSetArea} />
    {:else if p.category === "routes"}
      <!-- unchanged -->
```

Remove `onSetRoadPreset` from the `Props` interface and any BuildPanel wiring (the road preset now travels inside `onSelectBuildItem`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/ui/hudPanels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/hud/HudDrawer.svelte tests/ui/hudPanels.test.ts
git commit -m "feat(hud): route Area panel and wire BuildPanel drill-down through HudDrawer"
```

---

## Task 9: App.svelte wiring

**Files:**
- Modify: `src/App.svelte`
- Test: `tests/ui/appShell.test.ts`

**Interfaces:**
- Consumes: `runtime.setBuildCategory`, `runtime.armRoad`, `runtime.setBuilding`, `runtime.setTool` (Tasks 3); `BuildItemAction`/`BuildCategoryId` (Task 2); reworked `HudDrawer`/`BottomHud` (Tasks 7–8).
- Produces: App passes `buildCategory`, `onSetBuildCategory`, `onSelectBuildItem` to `HudDrawer`, and `onSetTool` to `BottomHud`.

- [ ] **Step 1: Update the existing failing test** — in `tests/ui/appShell.test.ts`, rewrite the "wires Build and Route Planning menus separately" test (around line 366) so the Large-House flow drills through Residential:

```ts
  it("wires Build and Route Planning menus separately", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("build");
    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));
    await fireEvent.click(screen.getByRole("button", { name: "Large House" }));
    expect(runtime.setBuilding).toHaveBeenCalledWith("largeHouse");

    // Selecting a building closes the drawer and resets buildCategory; reopen and
    // re-drill to assert the selection persisted in the panel.
    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));
    const largeHouse = screen.getByRole("button", { name: "Large House" });
    expect(largeHouse).toHaveAttribute("data-building", "largeHouse");
    expect(largeHouse).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeEnabled();
  });
```

Add a test for the persistent tools and Area routing (place in the same describe):

```ts
  it("selects the remove tool from the persistent HUD cluster", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("hud-tool-remove"));
    expect(runtime.setTool).toHaveBeenCalledWith("remove");
  });

  it("arms the road tool with a preset from Build → Road → 2-Lane", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Road" }));
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(runtime.armRoad).toHaveBeenCalledWith("dualBidirectional");
  });

  it("paints a zone from the Area category", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await openCategory("area");
    await fireEvent.click(screen.getByRole("button", { name: "Industrial" }));
    expect(runtime.setArea).toHaveBeenCalledWith("industrial");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/ui/appShell.test.ts -t "wires Build"`
Expected: FAIL — App does not yet pass the new props; `armRoad`/`onSetTool` not wired.

- [ ] **Step 3: Implement** — edit `src/App.svelte`:

Add to the `domain/types` import: `BuildingType` is already imported; ensure `Tool` is too (it is). Add a `BuildItemAction`/`BuildCategoryId` import:

```ts
  import type { BuildCategoryId, BuildItemAction } from "./domain/catalog/buildMenu";
```

Add handlers (next to `handleSetRoadPreset`):

```ts
  function handleSetBuildCategory(category: BuildCategoryId | null): void {
    if (runtime !== null) {
      setSnapshot(runtime.setBuildCategory(category));
    }
  }

  function handleSelectBuildItem(action: BuildItemAction): void {
    if (runtime === null) {
      return;
    }
    if (action.kind === "road") {
      setSnapshot(runtime.armRoad(action.roadPreset));
    } else if (action.kind === "track") {
      setSnapshot(runtime.setTool("track"));
    } else {
      setSnapshot(runtime.setBuilding(action.building));
    }
  }
```

In the `<HudDrawer … />` usage: remove `onSetRoadPreset={handleSetRoadPreset}` and add:

```svelte
        buildCategory={snapshot.ui.buildCategory}
        onSetBuildCategory={handleSetBuildCategory}
        onSelectBuildItem={handleSelectBuildItem}
```

In the `<BottomHud … />` usage, add:

```svelte
        onSetTool={handleSetTool}
```

`handleSetRoadPreset` is still used by the `1/2/3` hotkeys — keep it. `handleSetTool`, `handleSetArea`, `handleRotateBuilding` remain.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/ui/appShell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte tests/ui/appShell.test.ts
git commit -m "feat(app): wire Build drill-down, Area panel, and persistent tools"
```

---

## Task 10: E2E — drill-down build flows

**Files:**
- Modify: `tests/e2e/helpers.ts`, `tests/e2e/routes.spec.ts`

**Interfaces:**
- Consumes: `openHudCategory` (unchanged), the reworked panels.
- Produces: a `buildItem(page, category, item)` helper; both route specs updated to drill Build → category → item.

- [ ] **Step 1: Add the helper** — in `tests/e2e/helpers.ts`, add:

```ts
import type { Page } from "@playwright/test";

export async function buildItem(
  page: Page,
  category: string,
  item: string,
): Promise<void> {
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: category, exact: true }).click();
  await page.getByRole("button", { name: item, exact: true }).click();
}
```

> Reuse the existing `openHudCategory` in the file; if `Page` is already imported, don't re-import it.

- [ ] **Step 2: Update `routes.spec.ts`** — replace the build interactions:

Bus-route test — replace the road + bus-stop block (around lines 51–59):

```ts
  // Lay a two-way road and place three bus stops beside it.
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 11, y: 6 });

  await buildItem(page, "Bus", "Bus Stop");
  await clickMapTile(canvas, { x: 3, y: 5 });
  await clickMapTile(canvas, { x: 7, y: 5 });
  await clickMapTile(canvas, { x: 11, y: 5 });
```

Metro-line test — replace the track + metro-station block (around lines 99–110):

```ts
  // Lay a 5-tile track run on empty ground.
  await buildItem(page, "Rail", "Track");
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Stations on the track ends (Metro Station building requires track).
  await buildItem(page, "Metro", "Metro Station");
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
```

Import `buildItem` in `routes.spec.ts` (add to the existing `./helpers` import). Delete now-stale comments that say "The track tool auto-hides the build drawer; reopen it…" if the reopen is no longer needed (each `buildItem` reopens Build itself).

- [ ] **Step 3: Run the e2e suite**

Run: `bun run test:e2e`
Expected: PASS (both route specs). If Playwright browsers aren't installed, run `bunx playwright install` first.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/helpers.ts tests/e2e/routes.spec.ts
git commit -m "test(e2e): drive build flows through the category drill-down"
```

---

## Task 11: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Type check**

Run: `bun run check`
Expected: PASS (no TS/svelte-check errors). Common miss: a stale `onSetRoadPreset` reference in `HudDrawer` or `App`, or a `ShellHudState` literal missing a new field.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: PASS (eslint + `cargo clippy` — Rust is untouched so clippy is a no-op pass).

- [ ] **Step 3: Full unit suite**

Run: `bun run test`
Expected: PASS across `ui` and `runtime` projects.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `bun run dev`, open `http://127.0.0.1:5281`, then:
- Click **Build** → see 10 categories → click **Road** → click **2-Lane** → drawer closes, tool chip shows the road tool → drag a road.
- Click **Build** → **Bus** → **Bus Stop** → place one.
- Click **Area** → **Residential** → paint a zone.
- Click the persistent **Inspect** / **Remove** toggles → chip updates, no drawer opens.

- [ ] **Step 5: Final commit (if smoke fixes anything)**

```bash
git add -A
git commit -m "chore: verification pass for build menu restructure"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Top-level Build + Area categories → Tasks 1 (`area` in `PrimaryHudCategory`), 7 (Area chip), 8 (routing).
  - Build drill-down (root/detail, breadcrumb, Back) → Tasks 2 (catalog), 6 (panel).
  - Category→item→action map → Task 2 (`BUILD_MENU`) + Task 9 (`handleSelectBuildItem` maps road/track/building).
  - Persistent Inspect/Remove cluster → Tasks 4 (pressed-state selectors), 7 (BottomHud).
  - Area panel → Tasks 5, 8.
  - `buildCategory` state + `setBuildCategory` + reset on transitions → Tasks 1, 3.
  - Single-commit road arming → Task 3 (`armRoad`).
  - Testing (unit + e2e) → Tasks 1–10; verification → Task 11.
- **Deviation from spec (documented):** the Rotate control is rendered at the panel bottom in **both** root and detail views (disabled when `selectedBuilding === null`), rather than only in the detail view. Rationale: selecting a building closes the drawer and resets `buildCategory`, so on reopen the panel shows the root — the control must be reachable there to rotate the still-selected building. Behavior matches the current always-present, conditionally-disabled Rotate.
- **Type consistency:** `BuildItemAction` is the single shared shape across catalog (Task 2), BuildPanel `onSelectItem` (Task 6), HudDrawer `onSelectBuildItem` (Task 8), and App `handleSelectBuildItem` (Task 9). `setBuildCategory`/`armRoad` signatures match between `types.ts`, `createGameRuntime.ts`, and the appShell harness stub (Task 3).
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
```
