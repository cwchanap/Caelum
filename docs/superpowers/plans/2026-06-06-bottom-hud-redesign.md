# Bottom HUD Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic `ControlTower.svelte` bottom panel with a slim always-docked HUD bar plus an on-demand category drawer (Build · Routes · Manage · Data · Brief, with a contextual Inspect).

**Architecture:** The runtime stays the single source of truth. `UiState` gains `activeHudCategory: HudCategory | null` (replacing `controlTowerOpen`). The runtime exposes `setHudCategory`; clicking a map node auto-sets `"inspect"`. `runtimeSelectors` derives a `ShellHudState` (tool chip, badges, cancel flag) so Svelte stays a pure renderer. The 470-line `ControlTower.svelte` is split into `BottomHud.svelte` (slim bar), `HudDrawer.svelte` (container), and six focused `panels/*.svelte`.

**Tech Stack:** Svelte 5 (runes mode), TypeScript, Vite, Vitest (jsdom/node projects), Playwright e2e, Bun.

---

## File Structure

**Create:**
- `src/components/hud/BottomHud.svelte` — slim bar: category buttons, tool chip, badges, Cancel.
- `src/components/hud/HudDrawer.svelte` — sliding container; renders the active panel.
- `src/components/hud/panels/BuildPanel.svelte` — Inspect/Remove + build tools + Rotate.
- `src/components/hud/panels/RoutesPanel.svelte` — Bus Route / Metro Line tools + live route draft.
- `src/components/hud/panels/ManagePanel.svelte` — route list (rename/recolor/toggle/delete/select).
- `src/components/hud/panels/DataPanel.svelte` — overlay toggles.
- `src/components/hud/panels/BriefPanel.svelte` — scenario brief + tool/target readout.
- `src/components/hud/panels/InspectPanel.svelte` — platforms + route reassignment.
- `tests/ui/bottomHud.test.ts`, `tests/ui/hudPanels.test.ts` — replace `controlTower.test.ts`.

**Modify:**
- `src/ui/uiState.ts` — add `HudCategory`, `activeHudCategory`; remove `controlTowerOpen`.
- `src/ui/actions.ts` — inspect branch sets/clears `activeHudCategory`.
- `src/runtime/types.ts` — `ShellHudState`, drop `controlTowerOpen`, swap `toggleControlTower`→`setHudCategory`.
- `src/runtime/createGameRuntime.ts` — implement `setHudCategory`; helpers keep `activeHudCategory`.
- `src/runtime/runtimeSelectors.ts` — build `ShellHudState`.
- `src/components/App.svelte` — compose `BottomHud` + `HudDrawer`; `data-hud-category` attr.
- `src/components/Topbar.svelte` — remove the "Control Tower" toggle button.
- `src/styles.css` — HUD bar + drawer styles.
- `tests/ui/appShell.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`.
- `tests/e2e/helpers.ts`, `tests/e2e/routes.spec.ts`, `tests/e2e/smoke.spec.ts`.

**Delete:**
- `src/components/ControlTower.svelte`, `tests/ui/controlTower.test.ts`.

---

## Task 1: UiState — HudCategory + activeHudCategory

**Files:**
- Modify: `src/ui/uiState.ts`
- Test: `tests/runtime/gameRuntime.test.ts` (added in Task 3)

- [ ] **Step 1: Replace `controlTowerOpen` with `activeHudCategory`**

In `src/ui/uiState.ts`, add the type above `UiState` and swap the field:

```ts
export type HudCategory =
  | "build"
  | "routes"
  | "manage"
  | "data"
  | "brief"
  | "inspect";

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
  activeHudCategory: HudCategory | null;
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
    activeHudCategory: "brief",
  };
}
```

- [ ] **Step 2: Run the type check to find every break site**

Run: `bun run check`
Expected: FAIL — errors in `createGameRuntime.ts`, `runtimeSelectors.ts`, `runtime/types.ts`, `ControlTower.svelte`, and tests referencing `controlTowerOpen`. These are fixed in later tasks. Do not fix `.svelte`/test files yet; proceed to Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/ui/uiState.ts
git commit -m "feat: add activeHudCategory to UiState, drop controlTowerOpen"
```

---

## Task 2: actions.ts — inspect auto-opens / empty click dismisses drawer

**Files:**
- Modify: `src/ui/actions.ts:325-351` (the `inspect` branch of `handleTileClick`)
- Test: `tests/ui/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/ui/actions.test.ts` inside the top-level (after the existing `describe` blocks):

```ts
describe("inspect drawer auto-open", () => {
  it("opens the inspect drawer when a node is clicked", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 8, y: 7 });
    const ui = { ...createUiState(), activeTool: "inspect" as const };

    const result = handleTileClick(state, ui, { x: 8, y: 7 });

    expect(result.ui.activeHudCategory).toBe("inspect");
    expect(result.ui.selectedId).toBe("8,7");
  });

  it("dismisses the inspect drawer when empty map is clicked", () => {
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      activeHudCategory: "inspect" as const,
    };

    const result = handleTileClick(state, ui, { x: 0, y: 0 });

    expect(result.ui.activeHudCategory).toBeNull();
    expect(result.ui.selectedId).toBe("0,0");
  });

  it("leaves a non-inspect drawer untouched on empty map click", () => {
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      activeHudCategory: "brief" as const,
    };

    const result = handleTileClick(state, ui, { x: 0, y: 0 });

    expect(result.ui.activeHudCategory).toBe("brief");
  });
});
```

Ensure the file imports `addBusStop`. If not already imported, add it to the existing import from `"../../src/simulation/transit"`.

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/ui/actions.test.ts -t "inspect drawer auto-open"`
Expected: FAIL — `activeHudCategory` is `undefined`/unchanged.

- [ ] **Step 3: Update the inspect branch**

In `src/ui/actions.ts`, replace the whole `if (ui.activeTool === "inspect") { ... }` block (lines ~325-351) with:

```ts
  if (ui.activeTool === "inspect") {
    const nodes = resolveNodesAtTile(state, point);
    if (nodes.length === 0) {
      return {
        state,
        ui: {
          ...ui,
          selectedId: `${point.x},${point.y}`,
          selectedNodeKind: null,
          activeHudCategory:
            ui.activeHudCategory === "inspect" ? null : ui.activeHudCategory,
        },
      };
    }

    const isSameTile = ui.selectedId === `${point.x},${point.y}`;
    let selectedNodeKind: "stop" | "station";
    if (isSameTile && nodes.length > 1) {
      const otherNode = nodes.find((n) => n.kind !== ui.selectedNodeKind);
      selectedNodeKind = otherNode?.kind ?? nodes[0].kind;
    } else {
      selectedNodeKind = nodes[0].kind;
    }

    return {
      state,
      ui: {
        ...ui,
        selectedId: `${point.x},${point.y}`,
        selectedNodeKind,
        activeHudCategory: "inspect",
      },
    };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run tests/ui/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/actions.ts tests/ui/actions.test.ts
git commit -m "feat: inspect tool auto-opens drawer, empty click dismisses it"
```

---

## Task 3: Runtime — setHudCategory intent

**Files:**
- Modify: `src/runtime/types.ts:101-133` (controller interface)
- Modify: `src/runtime/createGameRuntime.ts`
- Test: `tests/runtime/gameRuntime.test.ts:60-95,245-250`

- [ ] **Step 1: Update the failing runtime tests**

In `tests/runtime/gameRuntime.test.ts`, replace the three `controlTowerOpen` / `toggleControlTower` usages.

Around line 60-95, the test asserting reset behaviour — replace the toggle/assert lines:

```ts
    runtime.setHudCategory("manage");
```
and
```ts
    expect(beforeReset.ui.activeHudCategory).toBe("manage");
```
and
```ts
    expect(snapshot.ui.activeHudCategory).toBe("brief");
```

Around line 245-250, replace the toggle test body with:

```ts
    const before = runtime.getSnapshot().ui.activeHudCategory;
    runtime.setHudCategory("data");
    const after = runtime.getSnapshot().ui.activeHudCategory;
    expect(before).toBe("brief");
    expect(after).toBe("data");
```

Add a dedicated test at the end of the file's top-level `describe`:

```ts
  it("collapses the drawer when setHudCategory(null) is dispatched", () => {
    const runtime = createGameRuntime();
    runtime.setHudCategory("build");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");
    runtime.setHudCategory(null);
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: FAIL — `runtime.setHudCategory is not a function`.

- [ ] **Step 3: Update the controller interface**

In `src/runtime/types.ts`, change the import to include the type and replace the `toggleControlTower` line:

```ts
import type { HudCategory, UiState } from "../ui/uiState";
```
```ts
  setHudCategory: (category: HudCategory | null) => RuntimeSnapshot;
```
(remove the `toggleControlTower: () => RuntimeSnapshot;` line.)

- [ ] **Step 4: Implement in the runtime**

In `src/runtime/createGameRuntime.ts`:

1. Update the import: `import { createUiState, type HudCategory } from "../ui/uiState";`
2. In `nextToolUiState` and `nextBuildingUiState`, the spread `...current` already carries `activeHudCategory`, so building/route tools keep the open drawer — no change needed there.
3. Replace the `toggleControlTower` method with:

```ts
    setHudCategory(category: HudCategory | null) {
      return commit(
        state,
        category === ui.activeHudCategory
          ? ui
          : { ...ui, activeHudCategory: category },
      );
    },
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run tests/runtime/gameRuntime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat: runtime setHudCategory intent replaces toggleControlTower"
```

---

## Task 4: Selectors — ShellHudState

**Files:**
- Modify: `src/runtime/types.ts` (shell types)
- Modify: `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`

- [ ] **Step 1: Write the failing selector tests**

Append to `tests/runtime/runtimeSelectors.test.ts`:

```ts
describe("ShellHudState", () => {
  it("derives the active tool chip and default cancel state", () => {
    const state = createInitialGameState();
    const ui = createUiState();
    const shell = selectShellState(state, ui);

    expect(shell.hud.activeCategory).toBe("brief");
    expect(shell.hud.activeToolChip).toBe("INSPECT");
    expect(shell.hud.canCancel).toBe(false);
    expect(shell.hud.badges.routeDraftActive).toBe(false);
    expect(shell.hud.badges.routeCount).toBe(0);
    expect(shell.hud.badges.activeOverlayLabel).toBeNull();
    expect(shell.hud.badges.inspectActive).toBe(false);
  });

  it("flags cancellable state and overlay label", () => {
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      activeOverlay: "coverage" as const,
      draftStopIds: ["stop-001"],
    };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
    expect(shell.hud.badges.routeDraftActive).toBe(true);
    expect(shell.hud.badges.activeOverlayLabel).toBe("Coverage");
  });

  it("counts routes and metro lines together", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 8, y: 7 });
    state = addBusStop(state, { x: 16, y: 7 });
    const stopIds = state.transit.stops.map((s) => s.id);
    state = addBusRoute(state, stopIds);
    const shell = selectShellState(state, createUiState());

    expect(shell.hud.badges.routeCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts -t "ShellHudState"`
Expected: FAIL — `shell.hud` is undefined.

- [ ] **Step 3: Add the shell types**

In `src/runtime/types.ts`:

1. Remove `controlTowerOpen: boolean;` from `ShellControlTowerState`.
2. Add the import for `HudCategory` (already added in Task 3).
3. Add after `ShellControlTowerState`:

```ts
export interface ShellHudBadges {
  routeDraftActive: boolean;
  routeCount: number;
  activeOverlayLabel: string | null;
  inspectActive: boolean;
}

export interface ShellHudState {
  activeCategory: HudCategory | null;
  activeToolChip: string;
  canCancel: boolean;
  badges: ShellHudBadges;
}
```

4. Add `hud: ShellHudState;` to `ShellState`.

- [ ] **Step 4: Build the hud slice in the selector**

In `src/runtime/runtimeSelectors.ts`:

1. Add an `Overlay` import: `import type { GameState, Overlay } from "../domain/types";`
2. Add a label map near the top (after the imports):

```ts
const OVERLAY_LABELS: Record<Overlay, string> = {
  coverage: "Coverage",
  crowding: "Crowding",
  demand: "Demand",
  lateness: "Lateness",
  growth: "Growth",
};
```
3. In `selectShellState`, compute the inspector once and reuse it, then add `hud`:

```ts
export function selectShellState(state: GameState, ui: UiState): ShellState {
  const inspector = buildInspector(state, ui);
  const draftActive = ui.draftStopIds.length > 0 || ui.draftStationIds.length > 0;

  return {
    topbar: {
      budget: formatBudget(state.budget),
      signalState: state.paused ? "Hold" : "Live",
      time: formatTime(state.time),
      population: `${state.citizens.length}`,
      late: `${state.metrics.lateTrips}`,
      unserved: `${state.metrics.unservedTrips}`,
      avgWait: `${Math.floor(state.metrics.averageWaitSeconds)}s`,
    },
    controlTower: {
      title: state.scenario.name,
      status: state.metrics.state.toUpperCase(),
      objective: formatObjective(state),
      lossNote: state.metrics.lossReason ?? "Within tolerances. Hold the line.",
      nextGrowth:
        state.scenario.growthWaves.find((wave) => !wave.applied)?.message ??
        "All growth waves resolved.",
      selectedId: ui.selectedId ?? "—",
      activeTool: formatActiveTool(ui),
    },
    hud: {
      activeCategory: ui.activeHudCategory,
      activeToolChip: formatActiveTool(ui),
      canCancel:
        draftActive || ui.activeTool !== "inspect" || ui.selectedBuilding !== null,
      badges: {
        routeDraftActive: draftActive,
        routeCount:
          state.transit.routes.length + state.transit.metroLines.length,
        activeOverlayLabel:
          ui.activeOverlay === null ? null : OVERLAY_LABELS[ui.activeOverlay],
        inspectActive: inspector !== null,
      },
    },
    inspector,
    routeDraft: buildRouteDraft(state, ui),
    routes: buildRouteList(state, ui),
  };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run tests/runtime/runtimeSelectors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime/runtimeSelectors.test.ts
git commit -m "feat: derive ShellHudState (tool chip, badges, cancel flag)"
```

---

## Task 5: BuildPanel.svelte

**Files:**
- Create: `src/components/hud/panels/BuildPanel.svelte`
- Test: covered in Task 16 (`tests/ui/hudPanels.test.ts`)

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { BuildingRotation, BuildingType, Tool } from "../../../domain/types";
  import { BUILDING_CATALOG } from "../../../simulation/buildings";

  type GlobalTool = Extract<Tool, "inspect" | "remove">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
  }

  let {
    activeTool,
    selectedBuilding,
    buildingRotation,
    onSetTool,
    onSetBuilding,
    onRotateBuilding,
  }: Props = $props();

  const globalTools: Array<{ id: GlobalTool; label: string }> = [
    { id: "inspect", label: "Inspect" },
    { id: "remove", label: "Remove" },
  ];

  const buildToolIds: BuildingType[] = [
    "busStop",
    "busTerminal",
    "metroStation",
    "smallHouse",
    "largeHouse",
  ];

  const buildTools = buildToolIds.map((id) => ({
    id,
    label: BUILDING_CATALOG[id].label,
  }));

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }
</script>

<div class="hud-panel" data-testid="panel-build">
  <section class="panel-section">
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

- [ ] **Step 2: Type-check the new file**

Run: `bun run check`
Expected: still FAILS on not-yet-migrated files, but no NEW errors mentioning `BuildPanel.svelte`.

- [ ] **Step 3: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte
git commit -m "feat: add BuildPanel hud component"
```

---

## Task 6: RoutesPanel.svelte

**Files:**
- Create: `src/components/hud/panels/RoutesPanel.svelte`
- Test: Task 16

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { Tool } from "../../../domain/types";
  import type { ShellRouteDraftState } from "../../../runtime/types";

  type RouteTool = Extract<Tool, "busRoute" | "metroLine">;

  interface Props {
    activeTool: Tool;
    selectedBuilding: string | null;
    routeDraft: ShellRouteDraftState | null;
    onSetTool: (tool: Tool) => void;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
  }

  let {
    activeTool,
    selectedBuilding,
    routeDraft,
    onSetTool,
    onRemoveDraftStop,
    onFinishRoute,
    onCancelRoute,
  }: Props = $props();

  const routeTools: Array<{ id: RouteTool; label: string }> = [
    { id: "busRoute", label: "Bus Route" },
    { id: "metroLine", label: "Metro Line" },
  ];

  function pad2(value: number): string {
    return value.toString().padStart(2, "0");
  }

  function formatCost(value: number): string {
    return `$${value.toLocaleString("en-US")}`;
  }
</script>

<div class="hud-panel" data-testid="panel-routes">
  <section class="panel-section">
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
        <p class="draft-readout" data-testid="route-draft-readout">
          {routeDraft.stops.length}
          {routeDraft.stops.length === 1 ? "stop" : "stops"} · {formatCost(
            routeDraft.vehicleCost,
          )} vehicle
        </p>
        <div class="draft-actions">
          <button
            type="button"
            class="draft-finish"
            disabled={!routeDraft.canFinish}
            onclick={onFinishRoute}
          >
            {routeDraft.canFinish
              ? "Finish Route"
              : `Finish Route — ${routeDraft.finishHint}`}
          </button>
          <button type="button" class="draft-cancel" onclick={onCancelRoute}>
            Cancel Route
          </button>
        </div>
      </div>
    {/if}
  </section>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/panels/RoutesPanel.svelte
git commit -m "feat: add RoutesPanel hud component"
```

---

## Task 7: ManagePanel.svelte

**Files:**
- Create: `src/components/hud/panels/ManagePanel.svelte`
- Test: Task 16

- [ ] **Step 1: Create the component** (route-list logic lifted verbatim from `ControlTower.svelte:114-148,335-422`)

```svelte
<script lang="ts">
  import type { ShellRouteListState } from "../../../runtime/types";
  import { ROUTE_COLOR_PALETTE } from "../../../ui/routePalette";

  interface Props {
    routes: ShellRouteListState;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
  }

  let {
    routes,
    onRenameRoute,
    onRecolorRoute,
    onToggleRouteActive,
    onDeleteRoute,
    onSelectRoute,
  }: Props = $props();

  let pendingDeleteId = $state<string | null>(null);
  // Local drafts for route-name inputs so live snapshots don't reset the input
  // mid-keystroke. Drafts read first; committed on blur/Enter then cleared.
  let routeNameDrafts = $state<Record<string, string>>({});

  function routeNameFor(routeId: string, canonical: string): string {
    return routeNameDrafts[routeId] ?? canonical;
  }

  function handleRouteNameInput(
    routeId: string,
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): void {
    routeNameDrafts[routeId] = event.currentTarget.value;
  }

  function commitRouteName(routeId: string, value: string): void {
    delete routeNameDrafts[routeId];
    onRenameRoute(routeId, value);
  }

  function handleDeleteClick(routeId: string): void {
    if (pendingDeleteId === routeId) {
      pendingDeleteId = null;
      onDeleteRoute(routeId);
    } else {
      pendingDeleteId = routeId;
    }
  }
</script>

<div class="hud-panel" data-testid="panel-manage">
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
                onclick={() => {
                  pendingDeleteId = null;
                  onSelectRoute(route.id);
                }}
              >
                <span class="route-swatch" aria-hidden="true"></span>
                <span class="route-mode"
                  >{route.mode === "bus" ? "Bus" : "Metro"}</span
                >
                <span class="route-stops">{route.stopCount} stops</span>
              </button>
              <input
                type="text"
                class="route-name"
                data-testid={`route-name-${route.id}`}
                value={routeNameFor(route.id, route.name)}
                aria-label={`Rename ${route.name}`}
                oninput={(event) =>
                  handleRouteNameInput(
                    route.id,
                    event as Event & {
                      currentTarget: EventTarget & HTMLInputElement;
                    },
                  )}
                onblur={(event) =>
                  commitRouteName(route.id, event.currentTarget.value)}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    commitRouteName(route.id, event.currentTarget.value);
                    event.currentTarget.blur();
                  }
                }}
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
              <div class="route-colors" role="group" aria-label="Route color">
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
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/panels/ManagePanel.svelte
git commit -m "feat: add ManagePanel hud component"
```

---

## Task 8: DataPanel.svelte

**Files:**
- Create: `src/components/hud/panels/DataPanel.svelte`
- Test: Task 16

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { Overlay } from "../../../domain/types";

  interface Props {
    activeOverlay: Overlay | null;
    onSetOverlay: (overlay: Overlay | null) => void;
  }

  let { activeOverlay, onSetOverlay }: Props = $props();

  const overlays: Array<{ id: Overlay; label: string }> = [
    { id: "coverage", label: "Coverage" },
    { id: "crowding", label: "Crowding" },
    { id: "demand", label: "Demand" },
    { id: "lateness", label: "Lateness" },
    { id: "growth", label: "Growth" },
  ];
</script>

<div class="hud-panel" data-testid="panel-data">
  <section class="panel-section overlay-section">
    <h3 class="section-head"><span class="num">04</span> Overlay</h3>
    <div class="overlays" aria-label="Overlays">
      {#each overlays as overlay (overlay.id)}
        <button
          type="button"
          data-overlay={overlay.id}
          aria-pressed={activeOverlay === overlay.id}
          class:active={activeOverlay === overlay.id}
          onclick={() =>
            onSetOverlay(activeOverlay === overlay.id ? null : overlay.id)}
        >
          {overlay.label}
        </button>
      {/each}
    </div>
  </section>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/panels/DataPanel.svelte
git commit -m "feat: add DataPanel hud component"
```

---

## Task 9: BriefPanel.svelte

**Files:**
- Create: `src/components/hud/panels/BriefPanel.svelte`
- Test: Task 16

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { ShellControlTowerState } from "../../../runtime/types";

  interface Props {
    shell: ShellControlTowerState;
  }

  let { shell }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-brief">
  <section class="panel-section details">
    <h3 class="section-head"><span class="num">05</span> Brief</h3>
    <h2>{shell.title}</h2>
    <p class="brief-id">Scenario · 001</p>

    <div class="dispatch-row">
      <span class="dispatch-key">Status</span>
      <span class="dispatch-val dispatch-val--mono">{shell.status}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Goal</span>
      <span class="dispatch-val">{shell.objective}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Note</span>
      <span class="dispatch-val dispatch-val--mono">{shell.lossNote}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Wave</span>
      <span class="dispatch-val">{shell.nextGrowth}</span>
    </div>

    <div class="dispatch-divider" aria-hidden="true"></div>

    <div class="dispatch-row">
      <span class="dispatch-key">Tool</span>
      <span class="dispatch-val dispatch-val--ok">{shell.activeTool}</span>
    </div>
    <div class="dispatch-row">
      <span class="dispatch-key">Target</span>
      <span class="dispatch-val dispatch-val--mono">{shell.selectedId}</span>
    </div>
  </section>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/panels/BriefPanel.svelte
git commit -m "feat: add BriefPanel hud component"
```

---

## Task 10: InspectPanel.svelte

**Files:**
- Create: `src/components/hud/panels/InspectPanel.svelte`
- Test: Task 16

- [ ] **Step 1: Create the component** (lifted from `ControlTower.svelte:424-471`)

```svelte
<script lang="ts">
  import type { ShellInspectorState } from "../../../runtime/types";

  interface Props {
    inspector: ShellInspectorState;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
  }

  let { inspector, onAssignRouteToPlatform }: Props = $props();
</script>

<div class="hud-panel" data-testid="panel-inspect">
  <section class="panel-section platform-panel" data-testid="platform-panel">
    <h3 class="section-head"><span class="num">07</span> Platforms</h3>
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
                <span class="route-chip" style={`--route-color: ${route.color}`}
                  >{route.name}</span
                >
                {#if inspector.canReassign}
                  {#each route.moveTargets as target (target.platformId)}
                    <button
                      type="button"
                      class="move-route"
                      aria-label={`Move ${route.name} to Platform ${target.label}`}
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
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/panels/InspectPanel.svelte
git commit -m "feat: add InspectPanel hud component"
```

---

## Task 11: HudDrawer.svelte

**Files:**
- Create: `src/components/hud/HudDrawer.svelte`
- Test: Task 16

- [ ] **Step 1: Create the container**

```svelte
<script lang="ts">
  import type {
    BuildingRotation,
    BuildingType,
    Overlay,
    Tool,
  } from "../../domain/types";
  import type {
    ShellControlTowerState,
    ShellInspectorState,
    ShellRouteDraftState,
    ShellRouteListState,
  } from "../../runtime/types";
  import type { HudCategory } from "../../ui/uiState";
  import BuildPanel from "./panels/BuildPanel.svelte";
  import RoutesPanel from "./panels/RoutesPanel.svelte";
  import ManagePanel from "./panels/ManagePanel.svelte";
  import DataPanel from "./panels/DataPanel.svelte";
  import BriefPanel from "./panels/BriefPanel.svelte";
  import InspectPanel from "./panels/InspectPanel.svelte";

  interface Props {
    category: HudCategory | null;
    brief: ShellControlTowerState;
    activeTool: Tool;
    activeOverlay: Overlay | null;
    selectedBuilding: BuildingType | null;
    buildingRotation: BuildingRotation;
    inspector: ShellInspectorState | null;
    routeDraft: ShellRouteDraftState | null;
    routes: ShellRouteListState;
    onCloseDrawer: () => void;
    onSetTool: (tool: Tool) => void;
    onSetBuilding: (building: BuildingType) => void;
    onRotateBuilding: () => void;
    onSetOverlay: (overlay: Overlay | null) => void;
    onAssignRouteToPlatform: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    onRemoveDraftStop: (index: number) => void;
    onFinishRoute: () => void;
    onCancelRoute: () => void;
    onRenameRoute: (routeId: string, name: string) => void;
    onRecolorRoute: (routeId: string, color: string) => void;
    onToggleRouteActive: (routeId: string) => void;
    onDeleteRoute: (routeId: string) => void;
    onSelectRoute: (routeId: string | null) => void;
  }

  let p: Props = $props();

  const titles: Record<HudCategory, string> = {
    build: "Build",
    routes: "Route Planning",
    manage: "Routes",
    data: "Overlays",
    brief: "Mission Brief",
    inspect: "Inspector",
  };
</script>

<aside
  class="hud-drawer panel"
  class:hud-drawer--closed={p.category === null}
  data-testid="hud-drawer"
  data-hud-category={p.category ?? "none"}
  aria-hidden={p.category === null}
>
  <header class="panel-head">
    <button
      type="button"
      class="panel-close"
      data-action="close-drawer"
      aria-label="Close drawer"
      onclick={p.onCloseDrawer}
    >
      ×
    </button>
    <span class="panel-head-mark" aria-hidden="true">⌬</span>
    <span class="panel-head-title"
      >{p.category === null ? "" : titles[p.category]}</span
    >
    <span class="panel-head-id">CTRL · 07</span>
  </header>

  <div class="hud-drawer-body">
    {#if p.category === "build"}
      <BuildPanel
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        buildingRotation={p.buildingRotation}
        onSetTool={p.onSetTool}
        onSetBuilding={p.onSetBuilding}
        onRotateBuilding={p.onRotateBuilding}
      />
    {:else if p.category === "routes"}
      <RoutesPanel
        activeTool={p.activeTool}
        selectedBuilding={p.selectedBuilding}
        routeDraft={p.routeDraft}
        onSetTool={p.onSetTool}
        onRemoveDraftStop={p.onRemoveDraftStop}
        onFinishRoute={p.onFinishRoute}
        onCancelRoute={p.onCancelRoute}
      />
    {:else if p.category === "manage"}
      <ManagePanel
        routes={p.routes}
        onRenameRoute={p.onRenameRoute}
        onRecolorRoute={p.onRecolorRoute}
        onToggleRouteActive={p.onToggleRouteActive}
        onDeleteRoute={p.onDeleteRoute}
        onSelectRoute={p.onSelectRoute}
      />
    {:else if p.category === "data"}
      <DataPanel activeOverlay={p.activeOverlay} onSetOverlay={p.onSetOverlay} />
    {:else if p.category === "brief"}
      <BriefPanel shell={p.brief} />
    {:else if p.category === "inspect" && p.inspector !== null}
      <InspectPanel
        inspector={p.inspector}
        onAssignRouteToPlatform={p.onAssignRouteToPlatform}
      />
    {/if}
  </div>
</aside>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/HudDrawer.svelte
git commit -m "feat: add HudDrawer container that renders the active panel"
```

---

## Task 12: BottomHud.svelte

**Files:**
- Create: `src/components/hud/BottomHud.svelte`
- Test: Task 16 (`tests/ui/bottomHud.test.ts`)

- [ ] **Step 1: Create the slim bar**

```svelte
<script lang="ts">
  import type { ShellHudState } from "../../runtime/types";
  import type { HudCategory } from "../../ui/uiState";

  interface Props {
    hud: ShellHudState;
    onSetHudCategory: (category: HudCategory | null) => void;
    onCancel: () => void;
  }

  let { hud, onSetHudCategory, onCancel }: Props = $props();

  type CategoryButton = { id: HudCategory; label: string };

  const categories: CategoryButton[] = [
    { id: "build", label: "Build" },
    { id: "routes", label: "Routes" },
    { id: "manage", label: "Manage" },
    { id: "data", label: "Data" },
    { id: "brief", label: "Brief" },
  ];

  function toggle(category: HudCategory): void {
    onSetHudCategory(hud.activeCategory === category ? null : category);
  }
</script>

<nav class="bottom-hud" data-testid="bottom-hud" aria-label="HUD categories">
  <div class="hud-categories">
    {#each categories as category (category.id)}
      <button
        type="button"
        class="hud-cat"
        class:active={hud.activeCategory === category.id}
        data-testid={`hud-cat-${category.id}`}
        aria-pressed={hud.activeCategory === category.id}
        onclick={() => toggle(category.id)}
      >
        <span class="hud-cat-label">{category.label}</span>
        {#if category.id === "routes" && hud.badges.routeDraftActive}
          <span class="hud-badge hud-badge--dot" data-testid="hud-badge-draft"
            >●</span
          >
        {/if}
        {#if category.id === "manage" && hud.badges.routeCount > 0}
          <span class="hud-badge" data-testid="hud-badge-count"
            >{hud.badges.routeCount}</span
          >
        {/if}
        {#if category.id === "data" && hud.badges.activeOverlayLabel !== null}
          <span class="hud-badge" data-testid="hud-badge-overlay"
            >{hud.badges.activeOverlayLabel}</span
          >
        {/if}
      </button>
    {/each}

    {#if hud.badges.inspectActive}
      <button
        type="button"
        class="hud-cat hud-cat--inspect"
        class:active={hud.activeCategory === "inspect"}
        data-testid="hud-cat-inspect"
        aria-pressed={hud.activeCategory === "inspect"}
        onclick={() => toggle("inspect")}
      >
        <span class="hud-cat-label">Inspect</span>
      </button>
    {/if}
  </div>

  <div class="hud-status">
    <span class="hud-tool-chip" data-testid="hud-tool-chip"
      >{hud.activeToolChip}</span
    >
    <button
      type="button"
      class="hud-cancel"
      data-testid="hud-cancel"
      disabled={!hud.canCancel}
      onclick={onCancel}
    >
      Cancel · Esc
    </button>
  </div>
</nav>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/hud/BottomHud.svelte
git commit -m "feat: add BottomHud slim bar with badges, tool chip, cancel"
```

---

## Task 13: Wire App.svelte + trim Topbar

**Files:**
- Modify: `src/components/App.svelte`
- Modify: `src/components/Topbar.svelte`
- Delete: `src/components/ControlTower.svelte`

- [ ] **Step 1: Remove the tower toggle from Topbar**

In `src/components/Topbar.svelte`:
1. Delete the `controlTowerOpen` and `onToggleControlTower` entries from `Props` and the destructured `$props()`.
2. Delete the entire `<button ... class="ctrl-tower" ...>` block (lines ~65-74).

Resulting `Props`:
```ts
  interface Props {
    shell: ShellTopbarState;
    paused: boolean;
    speed: GameState["speed"];
    onTogglePause: () => void;
    onSetSpeed: (speed: 1 | 2 | 4) => void;
  }
```

- [ ] **Step 2: Rewire App.svelte**

In `src/components/App.svelte`:
1. Replace the `ControlTower` import with:
```ts
  import BottomHud from "./components/hud/BottomHud.svelte";
  import HudDrawer from "./components/hud/HudDrawer.svelte";
```
2. Add `HudCategory` to the type import:
```ts
  import type { HudCategory } from "./ui/uiState";
```
3. Replace `handleToggleControlTower` with:
```ts
  function handleSetHudCategory(category: HudCategory | null): void {
    setSnapshot(runtime.setHudCategory(category));
  }
```
4. In the template, change the `<Topbar>` usage to drop `controlTowerOpen`/`onToggleControlTower`:
```svelte
      <Topbar
        shell={snapshot.shell.topbar}
        paused={snapshot.state.paused}
        speed={snapshot.state.speed}
        onTogglePause={handleTogglePause}
        onSetSpeed={handleSetSpeed}
      />
```
5. Change the shell wrapper attribute:
```svelte
  <main
    class="shell"
    data-testid="game-shell"
    data-hud-category={snapshot?.ui.activeHudCategory ?? "none"}
  >
```
6. Replace the entire `<ControlTower ... />` block with:
```svelte
      <HudDrawer
        category={snapshot.ui.activeHudCategory}
        brief={snapshot.shell.controlTower}
        activeTool={snapshot.ui.activeTool}
        activeOverlay={snapshot.ui.activeOverlay}
        selectedBuilding={snapshot.ui.selectedBuilding}
        buildingRotation={snapshot.ui.buildingRotation}
        inspector={snapshot.shell.inspector}
        routeDraft={snapshot.shell.routeDraft}
        routes={snapshot.shell.routes}
        onCloseDrawer={() => handleSetHudCategory(null)}
        onSetTool={handleSetTool}
        onSetBuilding={handleSetBuilding}
        onRotateBuilding={handleRotateBuilding}
        onSetOverlay={handleSetOverlay}
        onAssignRouteToPlatform={handleAssignRouteToPlatform}
        onRemoveDraftStop={handleRemoveDraftStop}
        onFinishRoute={handleFinishRoute}
        onCancelRoute={handleCancelRoute}
        onRenameRoute={handleRenameRoute}
        onRecolorRoute={handleRecolorRoute}
        onToggleRouteActive={handleToggleRouteActive}
        onDeleteRoute={handleDeleteRoute}
        onSelectRoute={handleSelectRoute}
      />

      <BottomHud
        hud={snapshot.shell.hud}
        onSetHudCategory={handleSetHudCategory}
        onCancel={() => setSnapshot(runtime.resetUi())}
      />
```

- [ ] **Step 3: Delete the old component**

```bash
git rm src/components/ControlTower.svelte
```

- [ ] **Step 4: Type-check**

Run: `bun run check`
Expected: PASS for `src/` (test files still reference old API — fixed in Tasks 15-18). If `check` includes tests and fails only there, that's expected; production code must be clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/App.svelte src/components/Topbar.svelte
git commit -m "feat: compose BottomHud + HudDrawer, remove ControlTower and tower toggle"
```

---

## Task 14: Styles — HUD bar + drawer

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add HUD styles**

The existing `.panel`, `.panel-head`, `.panel-section`, `.toolbar`, `.route-*`, `.draft-*`, `.platform-*`, `.dispatch-*`, `.overlays`, `.brief-id` rules are reused by the panels unchanged. Add the new bar/drawer rules. Append after the existing `CONTROL TOWER` block (after `src/styles.css:479`):

```css
/* ──────────────────────────────────────────────────────────────────────────
   BOTTOM HUD — slim category bar + sliding drawer
   ────────────────────────────────────────────────────────────────────────── */

.bottom-hud {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 16px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  background: linear-gradient(180deg, var(--surface-raised) 0%, var(--surface) 100%);
  box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.4);
  z-index: 9;
}

.hud-categories {
  display: flex;
  gap: 6px;
}

.hud-cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--line);
  background: var(--surface-sunk);
  color: var(--ink-mid);
  font-family: var(--font-display);
  font-size: 13px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease,
    background 0.12s ease;
}

.hud-cat:hover {
  color: var(--ink);
  border-color: var(--line-strong);
}

.hud-cat.active {
  color: var(--bg-deep);
  background: var(--cyan);
  border-color: var(--cyan);
}

.hud-cat--inspect.active {
  background: var(--amber);
  border-color: var(--amber);
}

.hud-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--ink);
}

.hud-cat.active .hud-badge {
  background: rgba(0, 0, 0, 0.2);
  color: var(--bg-deep);
}

.hud-badge--dot {
  background: transparent;
  color: var(--amber);
  padding: 0;
  font-size: 12px;
}

.hud-status {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hud-tool-chip {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--cyan);
  padding: 4px 10px;
  border: 1px solid var(--line);
  background: var(--surface-sunk);
}

.hud-cancel {
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line);
  background: var(--surface-sunk);
  color: var(--ink-mid);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
}

.hud-cancel:enabled:hover {
  color: var(--red);
  border-color: var(--red);
}

.hud-cancel:disabled {
  opacity: 0.35;
  cursor: default;
}

/* Drawer docks above the slim bar (56px bar + 16px inset + 12px gap). */
.hud-drawer {
  bottom: 84px;
  display: flex;
  flex-direction: column;
  grid-template-columns: none;
  height: min(40vh, 360px);
}

.hud-drawer-body {
  flex: 1;
  overflow: auto;
  padding: 0;
}

.hud-drawer-body .hud-panel {
  height: 100%;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(220px, 1fr);
  gap: 0;
}

.hud-drawer--closed {
  opacity: 0;
  pointer-events: none;
  transform: translateY(calc(100% + 24px));
}
```

- [ ] **Step 2: Remove dead control-tower-only rules**

Delete rules now unused: `.control-tower`, `.control-tower--closed`, `.panel--with-inspector`. Keep `.panel`, `.panel::before`, `.panel > *`, `.panel-head*`, `.panel-close`, and all `.panel-section`/content rules (the drawer + panels reuse them). Search `src/styles.css` for `control-tower` and `panel--with-inspector` and remove those blocks only.

- [ ] **Step 3: Verify build compiles styles**

Run: `bun run build`
Expected: PASS (production code only; if it runs svelte-check over tests it may flag tests — those are fixed next; the vite build itself should succeed).

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "style: bottom HUD bar + sliding drawer styling"
```

---

## Task 15: Migrate appShell.test.ts

**Files:**
- Modify: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Update the runtime harness mock**

In `createRuntimeHarness`, replace the `toggleControlTower` mock (lines ~104-107) with:

```ts
    setHudCategory: vi.fn((category) => {
      ui = { ...ui, activeHudCategory: category };
      return publish();
    }),
```

- [ ] **Step 2: Add a category-opening helper**

Add near the top of the file (after imports):

```ts
async function openCategory(name: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`hud-cat-${name}`));
}
```

- [ ] **Step 3: Update each test for the new structure**

Rewrite the assertions that referenced the tower. Key changes:

1. **"renders runtime-driven topbar, canvas host, and control tower"** — rename to "...and bottom HUD". The harness ui has `activeHudCategory: "brief"` by default, but the test sets `activeTool: "busRoute"`. To assert the Bus Route button, open routes first. Replace the control-tower block with:
```ts
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "brief",
    );
    // topbar + brief-panel assertions (brief is the default open drawer)
    expect(screen.getByText("Growing Suburb")).toBeVisible();
    expect(
      screen.getByText(
        /Hold late trips below 25%, unserved below 20%, average wait under 180s\./,
      ),
    ).toBeVisible();
    expect(screen.getByText("North homes open")).toBeVisible();
    // tool chip lives on the slim bar, always visible
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("BUSROUTE");

    const drawer = screen.getByTestId("hud-drawer");
    await openCategory("routes");
    expect(
      within(drawer).getByRole("button", { name: "Bus Route" }),
    ).toHaveAttribute("data-tool", "busRoute");
    expect(
      within(drawer).getByRole("button", { name: "Bus Route" }),
    ).toHaveAttribute("aria-pressed", "true");
    await openCategory("data");
    expect(
      within(drawer).getByRole("button", { name: "Growth" }),
    ).toHaveAttribute("aria-pressed", "true");
```
   Make this test `async`. Remove the `screen.getByText("BUSROUTE")` / `route-001` lines that relied on the brief Tool/Target rows (the chip assertion covers the tool; `route-001` target is in the brief panel and stays visible — keep `expect(screen.getByText("route-001")).toBeVisible();`).

2. **"wires topbar controls into the runtime and reflects subscription updates"** — delete the entire "Control Tower" toggle section (lines ~217-241). Keep Pause/Speed assertions.

3. **"wires Build and Route Planning menus separately"** — at the start, `await openCategory("build");` before the Rotate/Large House assertions; `await openCategory("routes");` before the Bus Route assertion. Note: after opening routes, "Large House" is no longer mounted — replace the final cross-check:
```ts
    await openCategory("routes");
    await fireEvent.click(
      within(screen.getByTestId("hud-drawer")).getByRole("button", {
        name: "Bus Route",
      }),
    );
    expect(runtime.setTool).toHaveBeenCalledWith("busRoute");
```
   (Drop the now-impossible "Large House aria-pressed false" assertion since it unmounts.)

4. **"wires tool, overlay, and close interactions with exact runtime ids"** — `await openCategory("routes");` then Metro Line; `await openCategory("data");` then Coverage. Replace the "Close Control Tower" section with the drawer close button:
```ts
    await fireEvent.click(
      screen.getByRole("button", { name: "Close drawer" }),
    );
    expect(runtime.setHudCategory).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("hud-drawer")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
```

5. **"resets transient ui state when Escape is pressed"** — change the seeded `controlTowerOpen: false` to `activeHudCategory: "routes"`. After Escape, assert reset reopens brief:
```ts
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "brief",
    );
```
   The "Inspect"/"Growth" aria-pressed assertions referenced buttons in the drawer; after reset the drawer shows brief (no Inspect/Growth buttons). Replace with tool-chip + target assertions:
```ts
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("INSPECT");
    expect(screen.getByText("—")).toBeVisible();
```

6. **Error-state tests** ("renders a shell error...", "renders error state...") — replace `queryByTestId("control-tower")` with `queryByTestId("bottom-hud")` (both must be null).

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run tests/ui/appShell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ui/appShell.test.ts
git commit -m "test: migrate appShell tests to bottom HUD bar + drawer"
```

---

## Task 16: Replace controlTower.test.ts with panel + BottomHud tests

**Files:**
- Delete: `tests/ui/controlTower.test.ts`
- Create: `tests/ui/bottomHud.test.ts`
- Create: `tests/ui/hudPanels.test.ts`

- [ ] **Step 1: Delete the old test**

```bash
git rm tests/ui/controlTower.test.ts
```

- [ ] **Step 2: Create `tests/ui/bottomHud.test.ts`**

```ts
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BottomHud from "../../src/components/hud/BottomHud.svelte";
import type { ShellHudState } from "../../src/runtime/types";

function hud(overrides: Partial<ShellHudState> = {}): ShellHudState {
  return {
    activeCategory: "brief",
    activeToolChip: "INSPECT",
    canCancel: false,
    badges: {
      routeDraftActive: false,
      routeCount: 0,
      activeOverlayLabel: null,
      inspectActive: false,
    },
    ...overrides,
  };
}

describe("BottomHud", () => {
  it("renders the five category buttons and the tool chip", () => {
    render(BottomHud, {
      props: { hud: hud(), onSetHudCategory: vi.fn(), onCancel: vi.fn() },
    });

    for (const id of ["build", "routes", "manage", "data", "brief"]) {
      expect(screen.getByTestId(`hud-cat-${id}`)).toBeVisible();
    }
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("INSPECT");
  });

  it("toggles the active category to null when clicked again", async () => {
    const onSetHudCategory = vi.fn();
    render(BottomHud, {
      props: {
        hud: hud({ activeCategory: "build" }),
        onSetHudCategory,
        onCancel: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId("hud-cat-build"));
    expect(onSetHudCategory).toHaveBeenCalledWith(null);

    await fireEvent.click(screen.getByTestId("hud-cat-data"));
    expect(onSetHudCategory).toHaveBeenLastCalledWith("data");
  });

  it("shows badges and the inspect chip from state", () => {
    render(BottomHud, {
      props: {
        hud: hud({
          badges: {
            routeDraftActive: true,
            routeCount: 3,
            activeOverlayLabel: "Coverage",
            inspectActive: true,
          },
        }),
        onSetHudCategory: vi.fn(),
        onCancel: vi.fn(),
      },
    });

    expect(screen.getByTestId("hud-badge-draft")).toBeVisible();
    expect(screen.getByTestId("hud-badge-count")).toHaveTextContent("3");
    expect(screen.getByTestId("hud-badge-overlay")).toHaveTextContent(
      "Coverage",
    );
    expect(screen.getByTestId("hud-cat-inspect")).toBeVisible();
  });

  it("disables cancel unless cancellable", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(BottomHud, {
      props: { hud: hud(), onSetHudCategory: vi.fn(), onCancel },
    });
    expect(screen.getByTestId("hud-cancel")).toBeDisabled();

    await rerender({
      hud: hud({ canCancel: true }),
      onSetHudCategory: vi.fn(),
      onCancel,
    });
    await fireEvent.click(screen.getByTestId("hud-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Create `tests/ui/hudPanels.test.ts`**

```ts
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import HudDrawer from "../../src/components/hud/HudDrawer.svelte";
import type {
  ShellControlTowerState,
  ShellInspectorState,
  ShellRouteListState,
} from "../../src/runtime/types";

const brief: ShellControlTowerState = {
  title: "Scenario",
  status: "RUNNING",
  objective: "obj",
  lossNote: "note",
  nextGrowth: "wave",
  selectedId: "2,2",
  activeTool: "INSPECT",
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

function drawerProps(overrides: Record<string, unknown> = {}) {
  return {
    category: "build" as const,
    brief,
    activeTool: "inspect" as const,
    activeOverlay: null,
    selectedBuilding: null,
    buildingRotation: 0 as const,
    inspector: null,
    routeDraft: null,
    routes: [] as ShellRouteListState,
    onCloseDrawer: vi.fn(),
    onSetTool: vi.fn(),
    onSetBuilding: vi.fn(),
    onRotateBuilding: vi.fn(),
    onSetOverlay: vi.fn(),
    onAssignRouteToPlatform: vi.fn(),
    onRemoveDraftStop: vi.fn(),
    onFinishRoute: vi.fn(),
    onCancelRoute: vi.fn(),
    onRenameRoute: vi.fn(),
    onRecolorRoute: vi.fn(),
    onToggleRouteActive: vi.fn(),
    onDeleteRoute: vi.fn(),
    onSelectRoute: vi.fn(),
    ...overrides,
  };
}

describe("HudDrawer panel routing", () => {
  it("renders the build panel and wires set building", async () => {
    const onSetBuilding = vi.fn();
    render(HudDrawer, { props: drawerProps({ onSetBuilding }) });

    expect(screen.getByTestId("panel-build")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Small House" }));
    expect(onSetBuilding).toHaveBeenCalledWith("smallHouse");
  });

  it("renders the data panel toggles", async () => {
    const onSetOverlay = vi.fn();
    render(HudDrawer, {
      props: drawerProps({ category: "data", onSetOverlay }),
    });

    expect(screen.getByTestId("panel-data")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(onSetOverlay).toHaveBeenCalledWith("coverage");
  });

  it("renders the manage panel route list and delete confirm", async () => {
    const onDeleteRoute = vi.fn();
    render(HudDrawer, {
      props: drawerProps({
        category: "manage",
        onDeleteRoute,
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            mode: "bus",
            stopCount: 3,
            active: true,
            selected: false,
          },
        ],
      }),
    });

    const del = screen.getByTestId("route-delete-route-001");
    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    await fireEvent.click(del);
    expect(onDeleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("renders the inspect panel and wires platform reassignment", async () => {
    const onAssignRouteToPlatform = vi.fn();
    render(HudDrawer, {
      props: drawerProps({
        category: "inspect",
        inspector,
        onAssignRouteToPlatform,
      }),
    });

    const move = screen.getByTestId("move-route-001-stop-001-p1");
    await fireEvent.click(move);
    expect(onAssignRouteToPlatform).toHaveBeenCalledWith(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
  });

  it("renders the brief panel scenario text", () => {
    render(HudDrawer, { props: drawerProps({ category: "brief" }) });
    const panel = screen.getByTestId("panel-brief");
    expect(within(panel).getByText("Scenario")).toBeVisible();
  });

  it("hides the drawer when category is null", () => {
    render(HudDrawer, { props: drawerProps({ category: null }) });
    expect(screen.getByTestId("hud-drawer")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run tests/ui/bottomHud.test.ts tests/ui/hudPanels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ui/bottomHud.test.ts tests/ui/hudPanels.test.ts
git commit -m "test: BottomHud + HudDrawer panel coverage, drop controlTower test"
```

---

## Task 17: Confirm runtime/selector test suite is green

**Files:**
- Verify only (changes already made in Tasks 3-4).

- [ ] **Step 1: Run the node projects**

Run: `bunx vitest run --project runtime --project simulation`
Expected: PASS. If any lingering `controlTowerOpen`/`toggleControlTower` reference remains, grep and fix:

Run: `grep -rn "controlTowerOpen\|toggleControlTower" src tests`
Expected: no output.

- [ ] **Step 2: Commit (only if fixes were needed)**

```bash
git add -A && git commit -m "test: drop remaining controlTowerOpen references"
```

---

## Task 18: Migrate e2e specs

**Files:**
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`

- [ ] **Step 1: Add an openCategory helper**

Append to `tests/e2e/helpers.ts`:

```ts
import type { Page } from "@playwright/test";

export async function openHudCategory(
  page: Page,
  category: "build" | "routes" | "manage" | "data" | "brief" | "inspect",
): Promise<void> {
  await page.getByTestId(`hud-cat-${category}`).click();
}
```
(If `helpers.ts` already imports from `@playwright/test`, merge the `Page` type into the existing import instead of adding a duplicate line.)

- [ ] **Step 2: Update smoke.spec.ts**

In `tests/e2e/smoke.spec.ts`:
1. Import the helper: `import { clickMapTile, openHudCategory } from "./helpers";`
2. Before `getByRole("button", { name: "Small House" })` (line 45), add `await openHudCategory(page, "build");`.
3. The Bus Terminal / Rotate buttons (lines 51-52) are in the same Build panel — already open, no extra step.
4. Line 54 `getByText("BUS TERMINAL 90")` is the always-visible tool chip — change to:
```ts
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");
```
5. Line 39 `getByText("Growing Suburb")` is in the default-open Brief drawer — keep as-is.

- [ ] **Step 3: Update routes.spec.ts**

In `tests/e2e/routes.spec.ts`:
1. Import the helper: `import { clickMapTile, openHudCategory } from "./helpers";`
2. Before placing bus stops (line 33), add `await openHudCategory(page, "build");`.
3. Before "Bus Route" (line 39), add `await openHudCategory(page, "routes");`.
4. After finishing the route (line 45), the route list is in Manage — before line 48, add `await openHudCategory(page, "manage");`.

- [ ] **Step 4: Run the e2e suite**

Run: `bun run test:e2e`
Expected: PASS (both specs).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers.ts tests/e2e/smoke.spec.ts tests/e2e/routes.spec.ts
git commit -m "test: open HUD categories in e2e flows"
```

---

## Task 19: Full verification

**Files:**
- Verify only.

- [ ] **Step 1: Type check + lint + format**

Run: `bun run check && bun run lint && bun run format:check`
Expected: PASS. (If format fails, run `bunx prettier --write src tests` and re-check, then commit.)

- [ ] **Step 2: Full unit suite**

Run: `bun run test:unit`
Expected: PASS across ui/runtime/simulation projects.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 4: e2e**

Run: `bun run test:e2e`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run: `bun run dev`, open the URL, verify: slim bar with 5 categories; clicking each opens the matching drawer; clicking the active category collapses it; placing a stop then switching to Routes shows the draft; clicking a stop with Inspect auto-opens the Inspect chip + drawer; tool chip updates; Cancel enables only with a draft/non-default tool.

- [ ] **Step 6: Final commit (if any format/lint fixups)**

```bash
git add -A
git commit -m "chore: bottom HUD redesign verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** persistent bar + drawer (Tasks 11-13), 5 categories + contextual inspect (Tasks 5-12), auto-open inspect (Task 2), topbar keeps stats / drops toggle (Task 13), slim-bar tool chip + badges + cancel (Tasks 4, 12), state in UiState (Task 1), `setHudCategory` intent (Task 3), derived `ShellHudState` (Task 4), component split + delete ControlTower (Tasks 5-13), styling (Task 14), testid preservation + migrations (Tasks 15-18). All spec sections map to a task.
- **Default category:** `"brief"` (matches spec).
- **Testid continuity:** `route-draft`, `routes-panel`, `route-name/-toggle/-delete/-select/-color-*`, `remove-draft-stop-*`, `platform-panel`, `move-*` preserved; new `bottom-hud`, `hud-cat-*`, `hud-drawer`, `hud-tool-chip`, `hud-cancel`, `panel-*` added; `control-tower`, `data-tower-open`, `toggle-tower`, `close-tower` removed and all references migrated.
- **Type consistency:** `HudCategory` defined in `uiState.ts` and imported by `types.ts`, `createGameRuntime.ts`, `BottomHud.svelte`, `HudDrawer.svelte`. `ShellHudState`/`ShellHudBadges` field names match between selector, types, and component usage.
