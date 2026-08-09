# Desktop Command Shelf UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caelum's crowded six-category HUD drawer with the approved desktop-only Signal Console command shelf, four illustrated Build groups, one Lines workspace, contextual inspection, and one recoverable-feedback strip.

**Architecture:** Rust remains authoritative for gameplay, costs, route validity, previews, and simulation. TypeScript changes only local `UiState`, selector-derived shell views, Svelte composition, canvas-host focus, and checked-in presentation assets; the browser/WASM and native/Tauri gameplay boundaries remain untouched. Route drafts form one runtime-enforced pinned Lines workflow, while every other command panel is non-modal presentation state over the existing canvas.

**Tech Stack:** TypeScript 5.8, Svelte 5 runes, Vite, Vitest 3 (`ui` and `runtime` projects), Playwright Chromium, Bun, Rust-backed `GameBackend`, Tauri 2, WebP assets.

## Global Constraints

- Prefix every shell command in this repository with `rtk`.
- Use Bun only; do not use npm or yarn.
- Desktop only. Support exactly `1024 × 768`, `1280 × 800`, and `1440 × 900`; add no mobile, tablet, portrait, hamburger, or touch-navigation design.
- Keep `crates/caelum-core`, `crates/caelum-wasm`, `src-tauri`, gameplay intents, snapshot schema/version, save contracts, and host method surfaces unchanged.
- Keep Svelte 5 runes (`$state`, `$props`, `$derived`, `$effect`); do not introduce legacy stores or `export let` props.
- Preserve immutable runtime state and reference-equality commits. Runtime gates must return the existing `ui` reference for rejected/no-op navigation intents.
- Breaking development cutover: remove old fields, methods, selectors, component files, fixtures, and assertions in the same branch; add no aliases or compatibility adapters.
- Permanent destinations are exactly Build, Lines, Data, and City. Select maps to internal `inspect`; Demolish maps to internal `remove`.
- Initial state is Select with `activeCommandDestination: null`, `activeBuildGroup: null`, and no automatically opened Brief/City panel.
- Enforce `routeDraft !== null` → `activeCommandDestination === "lines"` in the runtime. Conflicting destinations, tools, and shortcuts are no-ops until Save or Cancel.
- Build root order is exactly Roads, Transit, Zones, Buildings. Every leaf uses an existing runtime arming path; no gameplay action or cost is added.
- The replacement Data UI exposes Coverage, Crowding, Demand, and Lateness only. Keep the underlying `Overlay` union/renderer intact, but do not rebuild a Growth control.
- Crop and ship exactly four local `256 × 256` WebP command plates. Keep visible text labels and CSS-owned interaction states; add no asset URL to domain models or Rust snapshots.
- Shelf controls and command plates have at least 44px hit areas. Focus rings are 2–3px cyan and never removed.
- Panels are conditional, labelled, non-modal regions with one scroll owner; no focus trap or nested scrolling.
- Route-editor feedback remains local. Global feedback precedence is gameplay rejection, road-preview host error, road-preview rejection, then material road impact/cost.
- `prefers-reduced-motion: reduce` removes transforms and nonessential pulses.
- Do not add a command registry, manager/service class, event bus, context provider, dependency-injection layer, icon library, image pipeline, or new runtime dependency.
- Every implementation task gets a fresh worker and reviewer. After the final task, run a whole-branch architecture review and a scoped re-review for any integration fixes.

---

## File Map

### Create

- `src/domain/catalog/buildGroups.ts` — four Build groups, visual sections, and existing leaf actions.
- `src/assets/command-plates/roads.webp`
- `src/assets/command-plates/transit.webp`
- `src/assets/command-plates/zones.webp`
- `src/assets/command-plates/buildings.webp`
- `src/components/hud/CommandShelf.svelte` — four destinations plus Select/Demolish and focus return.
- `src/components/hud/CommandPanel.svelte` — focused, non-modal anchored region.
- `src/components/hud/CommandPlateGrid.svelte` — four illustrated buttons and 2×2 arrow navigation.
- `src/components/hud/panels/LinesPanel.svelte` — create/list/manage/edit line workspace.
- `src/components/hud/panels/CityPanel.svelte` — concise sandbox/city overview.
- `src/components/ActionFeedback.svelte` — sole global recoverable outcome strip.
- `tests/runtime/buildGroups.test.ts`
- `tests/ui/commandShelf.test.ts`
- `tests/ui/commandPanel.test.ts`
- `tests/ui/commandPlateGrid.test.ts`
- `tests/ui/linesPanel.test.ts`
- `tests/ui/cityPanel.test.ts`
- `tests/ui/actionFeedback.test.ts`
- `tests/ui/routeEditor.test.ts` — retained RouteEditor coverage extracted from the old drawer suite.
- `tests/ui/gameCanvas.test.ts`
- `tests/e2e/commandShelf.spec.ts`

### Modify

- `src/ui/uiState.ts`
- `src/ui/actions.ts`
- `src/runtime/types.ts`
- `src/runtime/createGameRuntime.ts`
- `src/runtime/runtimeSelectors.ts`
- `src/App.svelte`
- `src/components/Topbar.svelte`
- `src/components/GameCanvas.svelte`
- `src/components/hud/panels/BuildPanel.svelte`
- `src/components/hud/panels/DataPanel.svelte`
- `src/components/hud/panels/InspectPanel.svelte` — change the old drawer wrapper into the contextual `.inspection-card` root.
- `src/styles.css`
- `playwright.config.ts`
- `tests/ui/actions.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/ui/buildPanel.test.ts`
- `tests/ui/uiState.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/runtimeSelectors.test.ts`
- `tests/e2e/helpers.ts`
- `tests/e2e/smoke.spec.ts`
- `tests/e2e/routes.spec.ts`
- `tests/e2e/roundabouts.spec.ts`
- `CLAUDE.md`
- `docs/architecture.md`

### Delete during the atomic cutover

- `src/domain/catalog/buildMenu.ts`
- `src/components/hud/BottomHud.svelte`
- `src/components/hud/HudDrawer.svelte`
- `src/components/hud/panels/AreaPanel.svelte`
- `src/components/hud/panels/RoutesPanel.svelte`
- `src/components/hud/panels/ManagePanel.svelte`
- `src/components/hud/panels/BriefPanel.svelte`
- `src/components/RoadMutationNotice.svelte`
- `tests/ui/areaPanel.test.ts`
- `tests/ui/bottomHud.test.ts`
- `tests/ui/managePanel.test.ts`
- Drawer-routing assertions from `tests/ui/hudPanels.test.ts`; move its RouteEditor assertions to `tests/ui/routeEditor.test.ts`, then delete `tests/ui/hudPanels.test.ts`.

---

### Task 1: Four-group Build catalog and approved production artwork

**Files:**
- Create: `src/domain/catalog/buildGroups.ts`
- Create: `src/assets/command-plates/roads.webp`
- Create: `src/assets/command-plates/transit.webp`
- Create: `src/assets/command-plates/zones.webp`
- Create: `src/assets/command-plates/buildings.webp`
- Test: `tests/runtime/buildGroups.test.ts`
- Source asset: `docs/superpowers/assets/2026-08-08-command-plates-concept-v1.png`

**Interfaces:**
- Produces: `BuildGroup`, `BuildItemAction`, `BuildMenuItem`, `BuildMenuSection`, `BuildMenuGroup`, `BUILD_GROUPS`, and `findBuildGroup()`.
- Consumes later: `BuildPanel.svelte`, `UiState.activeBuildGroup`, and `RuntimeController.setBuildGroup()`.
- Asset imports remain presentation-only Vite imports from `BuildPanel.svelte`.

- [ ] **Step 1: Write the failing catalog tests**

Create `tests/runtime/buildGroups.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AREA_KINDS } from "../../src/domain/catalog/areas";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import { BUILD_GROUPS } from "../../src/domain/catalog/buildGroups";

const items = () =>
  BUILD_GROUPS.flatMap((group) =>
    group.sections.flatMap((section) => section.items),
  );

describe("BUILD_GROUPS", () => {
  it("orders exactly the four approved root groups", () => {
    expect(BUILD_GROUPS.map((group) => group.id)).toEqual([
      "roads",
      "transit",
      "zones",
      "buildings",
    ]);
  });

  it("keeps the current road and transit inventory", () => {
    const roads = BUILD_GROUPS[0].sections[0].items;
    const transit = BUILD_GROUPS[1].sections[0].items;
    expect(roads.map((item) => item.id)).toEqual([
      "road-twoWay",
      "road-oneWay",
      "road-dual",
      "compactRoundabout",
      "standardRoundabout",
    ]);
    expect(transit.map((item) => item.id)).toEqual([
      "track",
      "busStop",
      "busTerminal",
      "metroStation",
    ]);
  });

  it("maps all six area paints into Zones", () => {
    const zones = BUILD_GROUPS[2].sections[0].items;
    expect(
      zones.flatMap((item) =>
        item.action.kind === "area" ? [item.action.area] : [],
      ),
    ).toEqual(AREA_KINDS);
  });

  it("groups every area-bound building exactly once", () => {
    const buildings = BUILD_GROUPS[3].sections.flatMap(
      (section) => section.items,
    );
    const expected = Object.values(BUILDING_CATALOG)
      .filter((definition) => definition.allowedArea !== undefined)
      .map((definition) => definition.type)
      .sort();
    const actual = buildings
      .flatMap((item) =>
        item.action.kind === "building" ? [item.action.building] : [],
      )
      .sort();
    expect(actual).toEqual(expected);
    expect(new Set(items().map((item) => item.id)).size).toBe(items().length);
  });
});
```

- [ ] **Step 2: Run the catalog test to verify RED**

Run:

```bash
rtk bunx vitest run --project runtime tests/runtime/buildGroups.test.ts
```

Expected: FAIL because `src/domain/catalog/buildGroups.ts` does not exist.

- [ ] **Step 3: Implement the four-group catalog**

Create `src/domain/catalog/buildGroups.ts` with these public shapes and inventory:

```ts
import type {
  AreaKind,
  BuildingType,
  RoadPreset,
  RoundaboutSize,
  Tool,
} from "../types";
import { AREA_KINDS, AREA_LABELS } from "./areas";
import { BUILDING_CATALOG } from "./buildings";

export type BuildGroup = "roads" | "transit" | "zones" | "buildings";

export type BuildItemAction =
  | { kind: "road"; roadPreset: RoadPreset }
  | { kind: "roundabout"; size: RoundaboutSize }
  | { kind: "track" }
  | { kind: "tool"; tool: Extract<Tool, "busStop" | "metroStation"> }
  | { kind: "area"; area: AreaKind }
  | { kind: "building"; building: BuildingType };

export interface BuildMenuItem {
  id: string;
  label: string;
  action: BuildItemAction;
}

export interface BuildMenuSection {
  id: string;
  label: string | null;
  items: BuildMenuItem[];
}

export interface BuildMenuGroup {
  id: BuildGroup;
  label: string;
  sections: BuildMenuSection[];
}

const buildingItem = (building: BuildingType): BuildMenuItem => ({
  id: building,
  label: BUILDING_CATALOG[building].label,
  action: { kind: "building", building },
});

const areaSections: BuildMenuSection[] = AREA_KINDS.map((area) => ({
  id: area,
  label: AREA_LABELS[area],
  items: Object.values(BUILDING_CATALOG)
    .filter((definition) => definition.allowedArea === area)
    .map((definition) => buildingItem(definition.type)),
}));

export const BUILD_GROUPS: BuildMenuGroup[] = [
  {
    id: "roads",
    label: "Roads",
    sections: [
      {
        id: "roads",
        label: null,
        items: [
          { id: "road-twoWay", label: "1-Lane", action: { kind: "road", roadPreset: "twoWay" } },
          { id: "road-oneWay", label: "1-Lane One-Way", action: { kind: "road", roadPreset: "oneWay" } },
          { id: "road-dual", label: "2-Lane", action: { kind: "road", roadPreset: "dualBidirectional" } },
          { id: "compactRoundabout", label: "Compact Roundabout", action: { kind: "roundabout", size: "compact2x2" } },
          { id: "standardRoundabout", label: "Standard Roundabout", action: { kind: "roundabout", size: "standard3x3" } },
        ],
      },
    ],
  },
  {
    id: "transit",
    label: "Transit",
    sections: [
      {
        id: "transit",
        label: null,
        items: [
          { id: "track", label: "Track", action: { kind: "track" } },
          { id: "busStop", label: "Bus Stop", action: { kind: "tool", tool: "busStop" } },
          buildingItem("busTerminal"),
          { id: "metroStation", label: "Metro Station", action: { kind: "tool", tool: "metroStation" } },
        ],
      },
    ],
  },
  {
    id: "zones",
    label: "Zones",
    sections: [
      {
        id: "zones",
        label: null,
        items: AREA_KINDS.map((area) => ({
          id: area,
          label: AREA_LABELS[area],
          action: { kind: "area" as const, area },
        })),
      },
    ],
  },
  { id: "buildings", label: "Buildings", sections: areaSections },
];

export function findBuildGroup(id: BuildGroup | null): BuildMenuGroup | null {
  return id === null
    ? null
    : (BUILD_GROUPS.find((group) => group.id === id) ?? null);
}
```

Run Prettier after creating the file; do not hand-preserve the compact array formatting shown above.

- [ ] **Step 4: Run the catalog test to verify GREEN**

Run:

```bash
rtk bunx vitest run --project runtime tests/runtime/buildGroups.test.ts
```

Expected: PASS.

- [ ] **Step 5: Export exactly the four approved top-row subjects**

Run these one-off commands. `cwebp` is already installed locally; the checked-in outputs are consumed by Vite, so CI gains no image-tool dependency.

```bash
rtk mkdir -p src/assets/command-plates
rtk cwebp -quiet -q 90 -m 6 -sharp_yuv -crop 25 26 410 410 -resize 256 256 docs/superpowers/assets/2026-08-08-command-plates-concept-v1.png -o src/assets/command-plates/roads.webp
rtk cwebp -quiet -q 90 -m 6 -sharp_yuv -crop 462 26 410 410 -resize 256 256 docs/superpowers/assets/2026-08-08-command-plates-concept-v1.png -o src/assets/command-plates/transit.webp
rtk cwebp -quiet -q 90 -m 6 -sharp_yuv -crop 899 26 410 410 -resize 256 256 docs/superpowers/assets/2026-08-08-command-plates-concept-v1.png -o src/assets/command-plates/zones.webp
rtk cwebp -quiet -q 90 -m 6 -sharp_yuv -crop 1337 26 410 410 -resize 256 256 docs/superpowers/assets/2026-08-08-command-plates-concept-v1.png -o src/assets/command-plates/buildings.webp
```

- [ ] **Step 6: Verify and visually inspect the four assets**

Run:

```bash
rtk webpinfo -summary src/assets/command-plates/roads.webp
rtk webpinfo -summary src/assets/command-plates/transit.webp
rtk webpinfo -summary src/assets/command-plates/zones.webp
rtk webpinfo -summary src/assets/command-plates/buildings.webp
rtk sips -g pixelWidth -g pixelHeight src/assets/command-plates/roads.webp src/assets/command-plates/transit.webp src/assets/command-plates/zones.webp src/assets/command-plates/buildings.webp
```

Expected: every file decodes successfully and reports `256 × 256`. Inspect all four with `view_image` at original detail; each crop must contain one complete neutral plate frame and the correct Roads/Transit/Zones/Buildings subject with no neighboring card.

- [ ] **Step 7: Format, stage, and commit Task 1**

```bash
rtk bunx prettier --write src/domain/catalog/buildGroups.ts tests/runtime/buildGroups.test.ts
rtk git add src/domain/catalog/buildGroups.ts src/assets/command-plates tests/runtime/buildGroups.test.ts
rtk git commit -m "feat(ui): add command build groups and artwork"
```

---

### Task 2: Command shelf, panel, and command-plate primitives

**Files:**
- Modify: `src/ui/uiState.ts` only to export `CommandDestination` in this preparatory task.
- Modify: `src/runtime/types.ts` only to add target shell view types beside the still-live old types; Task 4 removes the old types atomically.
- Create: `src/components/hud/CommandShelf.svelte`
- Create: `src/components/hud/CommandPanel.svelte`
- Create: `src/components/hud/CommandPlateGrid.svelte`
- Create: `tests/ui/commandShelf.test.ts`
- Create: `tests/ui/commandPanel.test.ts`
- Create: `tests/ui/commandPlateGrid.test.ts`

**Interfaces:**
- Produces: `CommandDestination`, `ShellCommandState`, `ShellCityState`.
- `CommandShelf` consumes `ShellCommandState` and emits exact destination/tool intents.
- `CommandPanel` consumes one active destination and a Svelte `Snippet`.
- `CommandPlateGrid` consumes presentation-only `{ id, label, image }` records and emits `BuildGroup`.

- [ ] **Step 1: Add the target type contracts**

Add to `src/ui/uiState.ts`, above the old HUD types:

```ts
export type CommandDestination = "build" | "lines" | "data" | "city";
```

Add the import and target views to `src/runtime/types.ts`. Do not add fields to `UiState` yet:

```ts
import type { CommandDestination } from "../ui/uiState";

export interface ShellCommandState {
  activeDestination: CommandDestination | null;
  activeModeLabel: string;
  routeDraftActive: boolean;
  selectActive: boolean;
  demolishActive: boolean;
  lineCount: number;
  activeOverlayLabel: string | null;
}

export interface ShellCityState {
  title: string;
  template: string;
  simulation: "Running" | "Paused";
  population: string;
  lineCount: string;
  networkSummary: string;
}
```

- [ ] **Step 2: Write failing shelf, panel, and grid tests**

In `tests/ui/commandShelf.test.ts`, cover exact destinations, labels, ARIA, pinning, and callbacks:

```ts
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CommandShelf from "../../src/components/hud/CommandShelf.svelte";

const command = {
  activeDestination: null,
  activeModeLabel: "SELECT",
  routeDraftActive: false,
  selectActive: true,
  demolishActive: false,
  lineCount: 2,
  activeOverlayLabel: null,
} as const;

describe("CommandShelf", () => {
  it("renders exactly four destinations plus Select and Demolish", () => {
    render(CommandShelf, {
      command,
      onSetDestination: vi.fn(),
      onSetTool: vi.fn(),
    });
    expect(
      screen.getAllByTestId(/^command-destination-/).map((node) => node.textContent?.trim()),
    ).toEqual(["Build", "Lines2", "Data", "City"]);
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Demolish" })).toBeTruthy();
  });

  it("blocks every conflicting activation while a route draft pins Lines", async () => {
    const onSetDestination = vi.fn();
    const onSetTool = vi.fn();
    render(CommandShelf, {
      command: { ...command, activeDestination: "lines", routeDraftActive: true },
      onSetDestination,
      onSetTool,
    });
    const build = screen.getByRole("button", { name: "Build" });
    expect(build.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(build);
    await fireEvent.click(screen.getByRole("button", { name: "Demolish" }));
    expect(onSetDestination).not.toHaveBeenCalled();
    expect(onSetTool).not.toHaveBeenCalled();
  });
});
```

In `tests/ui/commandPanel.test.ts`, assert a labelled `role="region"`, programmatic focus after `tick()`, close callback, and a disabled close control when `canClose` is false.

In `tests/ui/commandPlateGrid.test.ts`, render four fake plates and assert:

```ts
const plates = [
  { id: "roads", label: "Roads", image: "/roads.webp" },
  { id: "transit", label: "Transit", image: "/transit.webp" },
  { id: "zones", label: "Zones", image: "/zones.webp" },
  { id: "buildings", label: "Buildings", image: "/buildings.webp" },
] as const;

const { container } = render(CommandPlateGrid, { plates, onSelect: vi.fn() });
expect(
  container.querySelectorAll('img[alt=""][aria-hidden="true"]'),
).toHaveLength(4);
expect(screen.getByRole("button", { name: "Roads" })).toBeTruthy();
```

Focus Roads, send `ArrowRight`, `ArrowDown`, `ArrowLeft`, and `ArrowUp`, and assert focus moves within the corresponding row/column of the 2×2 grid while all four buttons retain native Tab order.

- [ ] **Step 3: Run the three tests to verify RED**

```bash
rtk bunx vitest run --project ui tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts
```

Expected: FAIL because the three components do not exist.

- [ ] **Step 4: Implement `CommandShelf.svelte`**

Use a local, fixed destination array with inline SVG paths; add no icon package. The component contract and gate are:

```svelte
<script lang="ts">
  import type { Tool } from "../../domain/types";
  import type { ShellCommandState } from "../../runtime/types";
  import type { CommandDestination } from "../../ui/uiState";

  interface Props {
    command: ShellCommandState;
    onSetDestination: (destination: CommandDestination | null) => void;
    onSetTool: (tool: Extract<Tool, "inspect" | "remove">) => void;
  }

  let { command, onSetDestination, onSetTool }: Props = $props();
  let triggers: Partial<Record<CommandDestination, HTMLButtonElement>> = {};

  const destinations = [
    { id: "build", label: "Build", path: "M4 20h16M6 20V8l6-4 6 4v12M9 20v-6h6v6" },
    { id: "lines", label: "Lines", path: "M5 5h4v4H5zM15 15h4v4h-4zM9 7h4a4 4 0 0 1 4 4v4" },
    { id: "data", label: "Data", path: "M5 19V9M12 19V5M19 19v-7" },
    { id: "city", label: "City", path: "M4 20V8h7v12M11 20V4h9v16M7 12h1M7 16h1M15 8h1M15 12h1M15 16h1" },
  ] as const;

  function activate(destination: CommandDestination): void {
    if (command.routeDraftActive) return;
    onSetDestination(
      command.activeDestination === destination ? null : destination,
    );
  }

  function activateTool(tool: "inspect" | "remove"): void {
    if (command.routeDraftActive) return;
    onSetTool(tool);
  }

  export function focusDestination(destination: CommandDestination): void {
    triggers[destination]?.focus();
  }
</script>
```

Render `<nav aria-label="Game commands" data-testid="command-shelf">`, four destination buttons with visible text, `aria-expanded`, `aria-controls="command-panel-{id}"`, `data-testid="command-destination-{id}"`, a Lines count badge, a Data overlay badge, a visible active-mode readout, and separate Select/Demolish buttons with `data-testid="command-tool-select"`/`command-tool-demolish` and `aria-pressed`. Bind each destination button into `triggers[id]`. While `routeDraftActive`, set `aria-disabled="true"` and `aria-describedby="route-draft-gate"` on all destination/tool controls, keep them focusable/visible, and let the click guards prevent activation.

- [ ] **Step 5: Implement `CommandPanel.svelte`**

Use conditional mounting from App; this component itself never keeps a closed panel inert:

```svelte
<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { CommandDestination } from "../../ui/uiState";

  interface Props {
    destination: CommandDestination;
    title: string;
    canClose: boolean;
    onClose: () => void;
    children?: Snippet;
  }

  let { destination, title, canClose, onClose, children }: Props = $props();
  let region: HTMLElement | null = $state(null);

  $effect(() => {
    const openedDestination = destination;
    void tick().then(() => {
      if (destination === openedDestination) region?.focus();
    });
  });
</script>

<section
  bind:this={region}
  id={`command-panel-${destination}`}
  class="command-panel"
  data-testid="command-panel"
  data-command-panel={destination}
  role="region"
  aria-labelledby={`command-panel-title-${destination}`}
  tabindex="-1"
>
  <header class="command-panel__header">
    <h2 id={`command-panel-title-${destination}`}>{title}</h2>
    <button type="button" disabled={!canClose} onclick={onClose} aria-label={`Close ${title}`}>×</button>
  </header>
  <div class="command-panel__body">
    {#if children}{@render children()}{/if}
  </div>
</section>
```

- [ ] **Step 6: Implement `CommandPlateGrid.svelte`**

Define a `Plate` prop using `BuildGroup`, render the images with `alt=""` and `aria-hidden="true"`, keep visible labels, and implement row/column arrow focus without changing `tabindex`:

```ts
function nextIndex(index: number, key: string): number {
  const row = Math.floor(index / 2);
  const column = index % 2;
  if (key === "ArrowRight" || key === "ArrowLeft") {
    return row * 2 + (column === 0 ? 1 : 0);
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    return (row === 0 ? 1 : 0) * 2 + column;
  }
  return index;
}

function handleKeydown(index: number, event: KeyboardEvent): void {
  const target = nextIndex(index, event.key);
  if (target === index) return;
  event.preventDefault();
  buttons[target]?.focus();
}
```

- [ ] **Step 7: Run focused tests and type-check the preparatory components**

```bash
rtk bunx vitest run --project ui tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts
rtk bun run check
```

Expected: PASS. The old shell remains wired until Task 4, but the new primitives and target view types compile independently.

- [ ] **Step 8: Format and commit Task 2**

```bash
rtk bunx prettier --write src/ui/uiState.ts src/runtime/types.ts src/components/hud/CommandShelf.svelte src/components/hud/CommandPanel.svelte src/components/hud/CommandPlateGrid.svelte tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts
rtk git add src/ui/uiState.ts src/runtime/types.ts src/components/hud/CommandShelf.svelte src/components/hud/CommandPanel.svelte src/components/hud/CommandPlateGrid.svelte tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts
rtk git commit -m "feat(ui): add command shelf primitives"
```

---

### Task 3: Consolidated Lines workspace and concise City overview

**Files:**
- Create: `src/components/hud/panels/LinesPanel.svelte`
- Create: `src/components/hud/panels/CityPanel.svelte`
- Create: `tests/ui/linesPanel.test.ts`
- Create: `tests/ui/cityPanel.test.ts`
- Create: `tests/ui/routeEditor.test.ts`
- Reference: `src/components/hud/panels/RoutesPanel.svelte`
- Reference: `src/components/hud/panels/ManagePanel.svelte`
- Reference: `tests/ui/hudPanels.test.ts`

**Interfaces:**
- `LinesPanel` consumes the existing `RouteEditorView`, `ShellRouteListState`, route-edit callbacks, and `RouteEditor.svelte`; it adds no route state of its own beyond rename inputs and delete confirmation.
- `CityPanel` consumes the `ShellCityState` introduced in Task 2 plus a presentation-only `cityName: string | null` prop.
- Runtime wiring remains on the old shell until Task 4, so these components must be directly testable without importing `App.svelte`.

- [ ] **Step 1: Extract the retained RouteEditor tests before deleting the old drawer suite**

Move every assertion in `tests/ui/hudPanels.test.ts` that mounts `RouteEditor.svelte` into `tests/ui/routeEditor.test.ts`. Preserve the existing preview status, waypoint selection, undo/redo, reverse, pattern, Save, Cancel, and Reload coverage verbatim. Do not copy the old `HudDrawer`, Routes, Manage, Area, Data, Brief, or Inspect routing assertions.

Run the extracted file while the original still exists:

```bash
rtk bunx vitest run --project ui tests/ui/routeEditor.test.ts
```

Expected: PASS. Temporary duplicate coverage is acceptable until Task 4 deletes `tests/ui/hudPanels.test.ts`.

- [ ] **Step 2: Write failing `LinesPanel` component tests**

Create `tests/ui/linesPanel.test.ts` with fixtures for one running bus route, one broken metro line, and one active `RouteEditorView`. Add exact cases for:

- New Bus/New Metro and a full line list with name, mode, stop count, status, Edit, Pause/Resume, palette controls, repair Focus where applicable, and Delete;
- the labelled primary row calling `onEditRoute(route.id)` once;
- Enter committing a rename once and the ensuing blur not duplicating it;
- input Escape restoring the canonical value, blurring, avoiding rename, and stopping a parent Escape spy;
- the first Delete click changing text to `Delete?` and the second calling `onDeleteRoute` once;
- active draft rendering only gate copy plus `RouteEditor`, with creation/list controls absent;
- rerendering draft to `null`, awaiting `tick()`, and focusing the labelled Lines list region.

Use `@testing-library/svelte`, `userEvent`, and callback spies. Give the list region `aria-label="Lines list"`, `tabindex="-1"`, and `data-testid="lines-list"` so the focus assertion tests the intended contract rather than a CSS selector.

- [ ] **Step 3: Write failing `CityPanel` component tests**

Create `tests/ui/cityPanel.test.ts` with this fixture and exact content contract:

```ts
const city = {
  title: "Standard Sandbox",
  template: "Crossroads",
  simulation: "Running",
  population: "128",
  lineCount: "3",
  networkSummary: "4 late · 2 unserved",
} satisfies ShellCityState;

```

Assert `cityName: "Harbour Loop"` is the heading and every fixture field renders; `cityName: null` falls back to `Standard Sandbox`; and Objective, Note, Wave, Win, Loss, Save, Load, Rename, and Delete controls are absent.

- [ ] **Step 4: Run the new component tests to verify RED**

```bash
rtk bunx vitest run --project ui tests/ui/linesPanel.test.ts tests/ui/cityPanel.test.ts
```

Expected: FAIL because both components are absent.

- [ ] **Step 5: Implement `LinesPanel.svelte` by merging current behavior, not by nesting old panels**

Use one props interface:

```ts
interface Props {
  activeTool: Tool;
  selectedBuilding: BuildingType | null;
  routeDraft: RouteEditorView | null;
  routes: ShellRouteListState;
  onSetTool: (tool: Extract<Tool, "busRoute" | "metroLine">) => void;
  onSelectWaypoint: (index: number | null, interaction: RouteDraft["interaction"]) => void;
  onRemove: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onMove: (delta: -1 | 1) => void;
  onReverse: () => void;
  onPattern: (pattern: ServicePattern) => void;
  onSave: () => void;
  onCancel: () => void;
  onReload: () => void;
  onRenameRoute: (routeId: string, name: string) => void;
  onRecolorRoute: (routeId: string, color: string) => void;
  onToggleRouteActive: (routeId: string) => void;
  onDeleteRoute: (routeId: string) => void;
  onFocusRouteFailure: (routeId: string, legIndex: number) => void;
  onEditRoute: (routeId: string) => void;
}
```

When `routeDraft !== null`, render only a short pinned-workflow note with `id="route-draft-gate"` that explicitly says “Save or Cancel this line before changing commands,” plus `RouteEditor`; the normal New Bus/New Metro actions and line list must not remain interactive behind it. When no draft exists, render the creation buttons and a single list containing both bus and metro rows.

Keep the current color palette, status badges, repair guidance, pause/resume, and two-click delete behavior. Make the route's labelled primary button call `onEditRoute(route.id)`; `startRouteEdit` will select and pin it in Task 4.

Contain input Escape exactly:

```ts
function cancelRouteName(
  routeId: string,
  canonical: string,
  event: KeyboardEvent & { currentTarget: HTMLInputElement },
): void {
  delete routeNameDrafts[routeId];
  event.currentTarget.value = canonical;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.blur();
}
```

Track the draft transition, not every render:

```ts
let listRegion: HTMLElement | null = $state(null);
let previousDraftActive = $state(routeDraft !== null);

$effect(() => {
  const draftActive = routeDraft !== null;
  if (previousDraftActive && !draftActive) {
    void tick().then(() => listRegion?.focus());
  }
  previousDraftActive = draftActive;
});
```

- [ ] **Step 6: Implement `CityPanel.svelte` as a read-only overview**

Render `cityName ?? shell.title` as the panel heading. When `cityName` exists, render `shell.title` immediately below as the sandbox identity; then render a compact definition list for Template, Simulation, Population, Lines, and Network. Do not import the save runtime, campaign objectives, growth waves, or gameplay metrics directly; all formatting belongs in `runtimeSelectors.ts` in Task 4.

- [ ] **Step 7: Run, format, and commit Task 3**

```bash
rtk bunx vitest run --project ui tests/ui/routeEditor.test.ts tests/ui/linesPanel.test.ts tests/ui/cityPanel.test.ts
rtk bun run check
rtk bunx prettier --write src/components/hud/panels/LinesPanel.svelte src/components/hud/panels/CityPanel.svelte tests/ui/linesPanel.test.ts tests/ui/cityPanel.test.ts tests/ui/routeEditor.test.ts
rtk git add src/components/hud/panels/LinesPanel.svelte src/components/hud/panels/CityPanel.svelte tests/ui/linesPanel.test.ts tests/ui/cityPanel.test.ts tests/ui/routeEditor.test.ts
rtk git commit -m "feat(ui): add Lines and City workspaces"
```

---

### Task 4: Atomic runtime, selector, Build, Data, and App cutover

**Files:**
- Modify: `src/ui/uiState.ts`
- Modify: `src/ui/actions.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Modify: `src/components/hud/panels/DataPanel.svelte`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/ui/actions.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/ui/buildPanel.test.ts`
- Modify: `tests/ui/uiState.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Delete: `src/domain/catalog/buildMenu.ts`
- Delete: `src/components/hud/BottomHud.svelte`
- Delete: `src/components/hud/HudDrawer.svelte`
- Delete: `src/components/hud/panels/AreaPanel.svelte`
- Delete: `src/components/hud/panels/RoutesPanel.svelte`
- Delete: `src/components/hud/panels/ManagePanel.svelte`
- Delete: `src/components/hud/panels/BriefPanel.svelte`
- Delete: `tests/ui/areaPanel.test.ts`
- Delete: `tests/ui/bottomHud.test.ts`
- Delete: `tests/ui/managePanel.test.ts`
- Delete: `tests/ui/hudPanels.test.ts`

**Interfaces:**
- Replaces `activeHudCategory`/`buildCategory` with `activeCommandDestination`/`activeBuildGroup`.
- Replaces `setHudCategory()`/`setBuildCategory()` with `setCommandDestination()`/`setBuildGroup()`.
- Replaces `ShellHudState` and `ShellBriefState` with the `ShellCommandState` and `ShellCityState` introduced in Task 2.
- Preserves every backend method, gameplay intent, snapshot field, persistence contract, route draft type, and route preview generation rule.

- [ ] **Step 1: Replace old shell-state assertions with failing destination-state assertions**

In `tests/ui/uiState.test.ts`, assert the initial state and exact new field names:

```ts
expect(createUiState()).toMatchObject({
  activeTool: "inspect",
  activeCommandDestination: null,
  activeBuildGroup: null,
});
expect("activeHudCategory" in createUiState()).toBe(false);
expect("buildCategory" in createUiState()).toBe(false);
```

In `tests/ui/actions.test.ts`, replace Inspect-drawer assertions with two named cases: “selects an empty tile without opening or closing a destination” and “cycles co-located stop and station selection without changing the destination.” Each case compares `activeCommandDestination` before and after the click and retains the current exact `selectedId`/`selectedNodeKind` assertions.

- [ ] **Step 2: Add failing runtime tests for the navigation and Escape state machine**

In `tests/runtime/gameRuntime.test.ts`, add focused cases named “starts in Select with no command panel open,” “opens one destination and resets Build drill-down when leaving Build,” “ignores destination, overlay, tool, Build leaf, and second edit changes while a route draft is active,” “pins new and edited drafts to Lines,” “returns to Select and the Lines list after successful Save,” “returns to Select and the Lines list after Cancel,” “Cancel clears only the editor-owned rejection,” and “keeps the route tool and Lines editor after Save rejection or Reload.” Assert the complete affected `UiState` subset in every case, plus exact object identity for every guarded no-op.

Add one parameterized Escape table with a fresh runtime per row:

```ts
const cases = [
  { name: "drag", first: { tool: "road", destination: null } },
  { name: "draft", first: { tool: "inspect", destination: "lines" } },
  { name: "panel", first: { tool: "inspect", destination: null } },
  {
    name: "placement",
    first: { tool: "road", destination: null },
    second: { tool: "inspect", destination: null },
  },
  {
    name: "demolish",
    first: { tool: "remove", destination: null },
    second: { tool: "inspect", destination: null },
  },
] as const;
```

For `drag`, assert only the drag clears and the road tool remains. For `draft`, assert the draft clears, tool becomes `inspect`, and Lines remains open. For `panel`, assert only the destination closes. For `placement` and `demolish`, call Escape twice when a panel is also open: the first closes only the panel and keeps the tool; the second returns to Select. Add a separate idle-Select case asserting the exact `ui` object reference is unchanged and contextual `selectedId` plus `activeOverlay` survive.

- [ ] **Step 3: Add failing selector tests for the replacement shell views**

Replace the `brief`/`hud` describe blocks in `tests/runtime/runtimeSelectors.test.ts` with `ShellCommandState` cases for Select/Demolish, line count, draft pin, active overlay, and the single active-placement label, plus a `ShellCityState` case for sandbox title, template, simulation, population, lines, and network. Use exact expected values, including `networkSummary: "4 late · 2 unserved"`, `activeModeLabel: "SELECT"`, and `activeModeLabel: "DEMOLISH"`, and assert `brief` and `hud` are absent from the result. Update the three `gameRuntime.test.ts` assertions that currently read `shell.brief`/`shell.hud` to read `shell.city`/`shell.command`.

- [ ] **Step 4: Add failing Build and App shell tests before changing components**

Replace `tests/ui/buildPanel.test.ts` with tests that assert:

- the root has exactly four plates in Roads, Transit, Zones, Buildings order;
- every plate has a visible label and a decorative checked-in WebP;
- selecting a root calls `onSetBuildGroup` and reveals the correct leaf inventory;
- Back returns to the four-plate root;
- selecting a leaf calls `onSelectItem` once;
- Zones includes all six area actions;
- Buildings remain grouped under visible area headings;
- Rotate is enabled only for an armed building.

Update `tests/ui/appShell.test.ts` to assert initial Select/no panel, one command panel at a time, contextual Inspect only when no destination is open, retained platform occupancy and reassignment callbacks inside that card, Data's four overlays/empty hint/metrics, City's active name, and Lines draft pinning. Migrate the existing B/R/T/X/V and road-preset shortcut cases to `setCommandDestination`, Road, Track, Demolish, Select, and the guarded runtime calls. Keep the existing fatal shell-error and runtime-disposal tests. Task 6 adds the focus-handoff assertions with the concrete canvas component handle.

Run the targeted suite and verify RED:

```bash
rtk bunx vitest run --project ui tests/ui/uiState.test.ts tests/ui/actions.test.ts tests/ui/buildPanel.test.ts tests/ui/appShell.test.ts
rtk bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts
```

- [ ] **Step 5: Make the `UiState` and click-selection cutover**

In `src/ui/uiState.ts`, delete `PrimaryHudCategory` and `HudCategory`, import `BuildGroup`, and replace the old fields:

```ts
export type CommandDestination = "build" | "lines" | "data" | "city";

export interface UiState {
  // existing gameplay/UI fields remain unchanged
  activeCommandDestination: CommandDestination | null;
  activeBuildGroup: BuildGroup | null;
}
```

`createUiState()` initializes both fields to `null`. Do not leave deprecated aliases.

In `src/ui/actions.ts`, keep the existing tile/node resolution and route-draft behavior, but remove every `activeHudCategory` write. Inspect clicks update only `selectedId` and `selectedNodeKind`; selection no longer owns destination navigation.

- [ ] **Step 6: Implement the runtime-enforced destination and route-draft state machine**

Update the public controller surface exactly:

```ts
setCommandDestination: (
  destination: CommandDestination | null,
) => RuntimeSnapshot;
setBuildGroup: (group: BuildGroup | null) => RuntimeSnapshot;
```

Delete `setHudCategory` and `setBuildCategory`. Apply these rules in `createGameRuntime.ts`:

1. `setCommandDestination()` returns the current snapshot without a new `UiState` when a draft exists. Otherwise it opens the requested destination; any destination other than Build clears `activeBuildGroup`. Closing or leaving Build also clears its group.
2. `setBuildGroup()` changes state only when Build is open and no draft exists; invalid direct calls are reference-preserving no-ops.
3. `nextToolUiState`, `nextAreaUiState`, and `nextBuildingUiState` use the new fields, close the command panel, clear the Build group, and clear `selectedId`/`selectedNodeKind` for placement and Demolish. Selecting `inspect` preserves the current selection.
4. `setTool("busRoute" | "metroLine")` creates a draft and sets `activeCommandDestination: "lines"`; every other tool setter, `setArea`, `setBuilding`, `setRoadPreset`, `armRoad`, `armRoundabout`, `setOverlay`, and `startRouteEdit` is a reference-preserving no-op while a draft exists.
5. Split the current private edit implementation into `openRouteEdit(routeId)`, which replaces the draft, and a public `startRouteEdit(routeId)` guard. The public path is a no-op if any draft already exists; `reloadRouteDraft()` calls `openRouteEdit()` so a stale edit can still refresh in place. Both successful paths set `selectedRouteId`, the matching route tool, and Lines.
6. Successful route Save and Cancel both clear draft/history/notices/errors, set `activeTool: "inspect"`, clear placement selections, keep `activeCommandDestination: "lines"`, and leave the line selected after an edit. Cancel also clears a global rejection that is mirrored by the active editor, while preserving an unrelated pre-existing gameplay rejection. A rejected Save and Reload keep the matching route tool and Lines pinned.
7. Preserve all current request-token, revision, superseded-save, preview-generation, and host-error branches; change only the UI state committed by their existing success/cancel paths.

Make `handleEscape()` the sole state-machine owner:

```ts
const handleEscape = (): RuntimeSnapshot => {
  if (workingSave.isBusy()) return getSnapshot();
  if (ui.drag !== null) return api.cancelDrag();
  if (ui.routeDraft !== null) return cancelRouteDraft();
  if (ui.activeCommandDestination !== null) {
    return commit(state, {
      ...ui,
      activeCommandDestination: null,
      activeBuildGroup: null,
    });
  }
  if (
    ui.activeTool !== "inspect" ||
    ui.selectedBuilding !== null ||
    ui.selectedArea !== null
  ) {
    clearHoverPreviewTimer();
    invalidateRoadPreview();
    return commit(state, nextToolUiState("inspect", ui));
  }
  return commit(state, ui);
};
```

Do not clear `activeOverlay` in this function. Keep `resetUi()` as the explicit full reset API, but stop calling it from Escape.

- [ ] **Step 7: Replace the selector output without adding a second source of truth**

In `src/runtime/types.ts`, delete `BuildCategoryId`, `HudCategory`, `ShellHudBadges`, `ShellHudState`, and `ShellBriefState` imports/types. Make `ShellState` expose:

```ts
export interface ShellState {
  topbar: ShellTopbarState;
  command: ShellCommandState;
  city: ShellCityState;
  inspector: ShellInspectorState | null;
  routeDraft: RouteEditorView | null;
  routes: ShellRouteListState;
  roadMutationPreview: RoadMutationPreviewView | null;
}
```

In `runtimeSelectors.ts`, remove `ObjectiveThresholds`, `formatObjective()`, and all Brief-only campaign/growth derivation. Derive one shared network string:

```ts
const lineCount = state.transit.routes.length + state.transit.metroLines.length;
const networkSummary = `${state.metrics.lateTrips} late · ${state.metrics.unservedTrips} unserved`;
```

Update `formatActiveTool()` so internal camel-case names do not leak into the shelf. Retain the current area and building/rotation branches, then use an exhaustive `Record<Tool, string>` mapping: inspect → `SELECT`, busStop → `BUS STOP`, busRoute → `BUS LINE`, metroStation → `METRO STATION`, metroLine → `METRO LINE`, area → `AREA`, road → `ROAD`, roundabout → `ROUNDABOUT`, track → `TRACK`, and remove → `DEMOLISH`.

Return the target command and city shapes:

```ts
command: {
  activeDestination: ui.activeCommandDestination,
  activeModeLabel: formatActiveTool(ui),
  routeDraftActive: ui.routeDraft !== null,
  selectActive:
    ui.activeTool === "inspect" &&
    ui.selectedBuilding === null &&
    ui.selectedArea === null,
  demolishActive: ui.activeTool === "remove",
  lineCount,
  activeOverlayLabel:
    ui.activeOverlay === null ? null : OVERLAY_LABELS[ui.activeOverlay],
},
city: {
  title:
    state.rules.economyPreset === "creative"
      ? "Creative Sandbox"
      : "Standard Sandbox",
  template: SANDBOX_TEMPLATE_LABELS[state.rules.sandbox.templateId],
  simulation: state.paused ? "Paused" : "Running",
  population: `${state.sims?.length ?? 0}`,
  lineCount: `${lineCount}`,
  networkSummary,
},
```

- [ ] **Step 8: Rebuild `BuildPanel` around the four command plates and existing leaf actions**

Import `BUILD_GROUPS`, `findBuildGroup`, `CommandPlateGrid`, and the four WebPs directly in `BuildPanel.svelte`. Keep asset URLs out of `buildGroups.ts`. The root plates array is explicit and ordered:

```ts
const plates = [
  { id: "roads", label: "Roads", image: roadsPlate },
  { id: "transit", label: "Transit", image: transitPlate },
  { id: "zones", label: "Zones", image: zonesPlate },
  { id: "buildings", label: "Buildings", image: buildingsPlate },
] satisfies Array<{ id: BuildGroup; label: string; image: string }>;
```

Use `activeBuildGroup`/`onSetBuildGroup`. At the root, render only `CommandPlateGrid`; at a detail level, render Back, the group name, every section heading whose `label` is non-null, the group's leaf buttons, and Rotate. Extend `isItemActive()` for `area`; retain the exact road preset, roundabout size, transit, and building checks.

- [ ] **Step 9: Restrict `DataPanel` to the four approved overlays**

Render controls for `coverage`, `crowding`, `demand`, and `lateness` in that order. Add `metrics: Pick<ShellTopbarState, "late" | "unserved" | "avgWait">` to the props and render one read-only metrics row labelled Late, Unserved, and Avg Wait; App passes `snapshot.shell.topbar`. When no overlay is active, show “Choose an overlay to inspect the network.” rather than an empty detail area. Reuse selector-formatted values rather than inventing a gameplay score. Do not change `Overlay`, the Growth renderer, snapshot fields, or backend contracts; merely stop presenting Growth as a selectable command.

- [ ] **Step 10: Replace the App shell composition in one compile-safe edit**

Remove imports and handlers for `BottomHud`, `HudDrawer`, `HudCategory`, `BuildCategoryId`, and `BUILD_MENU`. Import and render `CommandShelf`, `CommandPanel`, `BuildPanel`, `LinesPanel`, `DataPanel`, `CityPanel`, and the existing `InspectPanel`.

Change `InspectPanel.svelte`'s old `.hud-panel` wrapper into a semantic `<aside class="inspection-card" data-testid="panel-inspect">` root; retain the platform occupancy and reassignment content exactly.

Composition order inside `.shell` is:

1. `Topbar`
2. existing rejection/road notices temporarily retained until Task 5
3. `.game-workspace` containing `GameCanvas` and the conditional right-aligned contextual Inspect card only when `shell.inspector !== null && ui.activeCommandDestination === null`
4. conditional `CommandPanel` for exactly one active destination
5. always-mounted `CommandShelf`

Pass `snapshot.persistence.activeCity?.name ?? null` directly to `CityPanel`; do not broaden `selectShellState()` or the save runtime with city metadata. The Lines close button is disabled while `routeDraft !== null`. Clicking an already-open destination closes it unless a route draft is pinned. Wire every callback in the Task 3 `LinesPanel` contract and remove App's now-unused `handleSelectRoute`; leave the existing tested `RuntimeController.selectRoute()` seam unchanged in this UI-focused cutover.

Replace keyboard `B` with Build destination toggling. Keep R/T/X/V and road-preset shortcuts, but route them through the guarded runtime methods; remove App-side drawer/cancel gates. Escape calls `runtime.handleEscape()` once. Retain the input guard and route-editor undo/redo/Delete shortcuts.

Build leaf handling remains exhaustive over `BuildItemAction` and adds the `area` branch. Commit the returned snapshot in this task; Task 6 adds the concrete post-commit canvas focus handle and its tests.

- [ ] **Step 11: Delete the obsolete shell and catalog files, then run the cutover tests**

Delete the files listed for this task only after all imports have moved. Run:

```bash
rtk bunx vitest run --project ui tests/ui/uiState.test.ts tests/ui/actions.test.ts tests/ui/buildPanel.test.ts tests/ui/appShell.test.ts tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts tests/ui/linesPanel.test.ts tests/ui/cityPanel.test.ts tests/ui/routeEditor.test.ts
rtk bunx vitest run --project runtime tests/runtime/buildGroups.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts
rtk bun run check
rtk bun run lint
```

Expected: PASS with no references to the old field/type/component names.

- [ ] **Step 12: Scan the atomic cutover, format, and commit Task 4**

```bash
rtk rg -n "activeHudCategory|buildCategory|setHudCategory|setBuildCategory|BuildCategoryId|ShellHudState|ShellBriefState|BUILD_MENU" src tests
rtk bunx prettier --write src/ui/uiState.ts src/ui/actions.ts src/runtime/types.ts src/runtime/createGameRuntime.ts src/runtime/runtimeSelectors.ts src/components/hud/panels/BuildPanel.svelte src/components/hud/panels/DataPanel.svelte src/components/hud/panels/InspectPanel.svelte src/App.svelte tests/ui/actions.test.ts tests/ui/appShell.test.ts tests/ui/buildPanel.test.ts tests/ui/uiState.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts
rtk git add src/ui/uiState.ts src/ui/actions.ts src/runtime/types.ts src/runtime/createGameRuntime.ts src/runtime/runtimeSelectors.ts src/components/hud/panels/BuildPanel.svelte src/components/hud/panels/DataPanel.svelte src/components/hud/panels/InspectPanel.svelte src/App.svelte tests/ui/actions.test.ts tests/ui/appShell.test.ts tests/ui/buildPanel.test.ts tests/ui/uiState.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/runtimeSelectors.test.ts src/domain/catalog/buildMenu.ts src/components/hud/BottomHud.svelte src/components/hud/HudDrawer.svelte src/components/hud/panels/AreaPanel.svelte src/components/hud/panels/RoutesPanel.svelte src/components/hud/panels/ManagePanel.svelte src/components/hud/panels/BriefPanel.svelte tests/ui/areaPanel.test.ts tests/ui/bottomHud.test.ts tests/ui/managePanel.test.ts tests/ui/hudPanels.test.ts
rtk git commit -m "feat(ui): cut over to desktop command destinations"
```

Expected `rg`: no output. `git add` records both modifications and deletions.

---

### Task 5: One selector-owned recoverable action feedback strip

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Create: `src/components/ActionFeedback.svelte`
- Modify: `src/App.svelte`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Create: `tests/ui/actionFeedback.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Delete: `src/components/RoadMutationNotice.svelte`

**Interfaces:**
- Adds one derived `ShellActionFeedback | null` to `ShellState`.
- Consumes existing `RuntimeSnapshot.rejection`, `UiState.roadMutationPreviewError`, and `RoadMutationPreviewView`; no new mutable feedback state is introduced.
- Keeps route-editor preview and revision feedback inside `RouteEditor.svelte`.

- [ ] **Step 1: Write failing selector precedence tests**

Add the target type to `src/runtime/types.ts` before writing the tests:

```ts
export interface ShellActionFeedback {
  source: "rejection" | "roadHostError" | "roadRejection" | "roadImpact";
  tone: "error" | "warning" | "info";
  message: string;
  details: string[];
  dismissible: boolean;
  announce: boolean;
}
```

In `tests/runtime/runtimeSelectors.test.ts`, build a state/UI fixture that can carry all four candidates. Add exact cases proving that a global gameplay rejection wins over every road outcome; `routeChangedWhileEditing` stays inside a reloadable editor; the current route Save rejection stays inside its editor; road host error wins over road rejection/impact; road rejection wins over cost/impact; material cost formats every affected route; and empty or stale previews produce `null`.

For the material-impact fixture, assert exactly:

```ts
expect(feedback).toEqual({
  source: "roadImpact",
  tone: "info",
  message: "Preview cost $1,200",
  details: ["Loop 1 will reroute", "Metro A will become broken"],
  dismissible: false,
  announce: false,
});
```

Pin the other winning rows as `rejection/error/"Needs $1,200; only $0 is available."/dismissible/announced`, `roadHostError/warning/"Road preview unavailable: host timed out"/not dismissible/not announced`, and `roadRejection/warning/"That tile is blocked."/not dismissible/not announced`. Editor-owned cases expect `actionFeedback` to be `null` when no road source is present.

- [ ] **Step 2: Write failing `ActionFeedback` accessibility tests**

Create `tests/ui/actionFeedback.test.ts` with named cases for null feedback, announced/dismissible gameplay rejection, non-live continuous road hover feedback, and every material-impact detail.

For `announce: true`, assert `role="status"` and `aria-live="polite"`. For `announce: false`, assert neither attribute exists. Assert `data-source` and `data-tone` mirror the view, the decorative tone icon has `aria-hidden="true"`, and the dismiss button is rendered only when `dismissible` is true and calls `onDismiss` once.

Run both new slices and verify RED:

```bash
rtk bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
rtk bunx vitest run --project ui tests/ui/actionFeedback.test.ts
```

- [ ] **Step 3: Derive feedback once in `runtimeSelectors.ts`**

Add a pure helper that receives the already generation-checked road preview:

```ts
function selectActionFeedback(
  rejection: GameplayRejection | null,
  editorOwnsRejection: boolean,
  roadHostError: string | null,
  roadPreview: RoadMutationPreviewView | null,
): ShellActionFeedback | null {
  if (rejection !== null && !editorOwnsRejection) {
    return {
      source: "rejection",
      tone: "error",
      message: rejectionMessage(rejection),
      details: [],
      dismissible: true,
      announce: true,
    };
  }
  if (roadHostError !== null) {
    return {
      source: "roadHostError",
      tone: "warning",
      message: `Road preview unavailable: ${roadHostError}`,
      details: [],
      dismissible: false,
      announce: false,
    };
  }
  if (roadPreview !== null && roadPreview.rejection !== null) {
    return {
      source: "roadRejection",
      tone: "warning",
      message: rejectionMessage(roadPreview.rejection),
      details: [],
      dismissible: false,
      announce: false,
    };
  }
  if (
    roadPreview !== null &&
    (roadPreview.cost > 0 || roadPreview.routeImpacts.length > 0)
  ) {
    return {
      source: "roadImpact",
      tone: "info",
      message:
        roadPreview.cost > 0
          ? `Preview cost ${roadPreview.costLabel}`
          : "Road network impact",
      details: roadPreview.routeImpacts.map(
        (impact) =>
          `${impact.routeName} will ${
            impact.kind === "broken" ? "become broken" : "reroute"
          }`,
      ),
      dismissible: false,
      announce: false,
    };
  }
  return null;
}
```

Within `selectShellState()`, compute `routeDraft` and `roadMutationPreview` once. The editor owns a rejection when a draft exists and either `routeDraft.canReload` is true or `ui.routePreviewError` matches the global rejection's code and route identity. Feed that boolean and the same derived preview values into the helper, then return `actionFeedback`. Do not recompute either preview or inspect mutable runtime fields from Svelte.

- [ ] **Step 4: Implement `ActionFeedback.svelte` and replace both old App notices**

Use this prop surface:

```ts
interface Props {
  feedback: ShellActionFeedback | null;
  onDismiss: () => void;
}
```

Conditionally render one `<aside data-testid="action-feedback" data-source={feedback.source} data-tone={feedback.tone}>`; set `role` and `aria-live` only when `feedback.announce` is true. Render one tone-specific inline SVG with `aria-hidden="true"`, the message, an optional `<ul>` for details, and the dismiss button only when allowed. Keep the icon semantic through adjacent visible text rather than adding an icon library, and add no timeout/auto-dismiss state.

In `App.svelte`, replace the rejection banner and `RoadMutationNotice` with one `ActionFeedback` bound to `snapshot.shell.actionFeedback` and the existing `handleDismissRejection`. Remove the now-unused `rejectionMessage` import. Delete `RoadMutationNotice.svelte` and replace its App test assertions with feedback source/tone/content assertions.

- [ ] **Step 5: Verify, format, and commit Task 5**

```bash
rtk bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
rtk bunx vitest run --project ui tests/ui/actionFeedback.test.ts tests/ui/appShell.test.ts
rtk bun run check
rtk bun run lint
rtk bunx prettier --write src/runtime/types.ts src/runtime/runtimeSelectors.ts src/components/ActionFeedback.svelte src/App.svelte tests/runtime/runtimeSelectors.test.ts tests/ui/actionFeedback.test.ts tests/ui/appShell.test.ts
rtk git add src/runtime/types.ts src/runtime/runtimeSelectors.ts src/components/ActionFeedback.svelte src/App.svelte tests/runtime/runtimeSelectors.test.ts tests/ui/actionFeedback.test.ts tests/ui/appShell.test.ts src/components/RoadMutationNotice.svelte
rtk git commit -m "feat(ui): unify recoverable action feedback"
```

---

### Task 6: Signal Console layout, desktop responsiveness, and deterministic focus

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/Topbar.svelte`
- Modify: `src/components/GameCanvas.svelte`
- Modify: `src/components/hud/CommandShelf.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Create: `tests/ui/gameCanvas.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`

**Interfaces:**
- `GameCanvas` exports a DOM-only `focus(): void` component method; the runtime controller remains unchanged.
- `CommandShelf.focusDestination()` is the only shelf focus-return seam.
- `ShellTopbarState` drops only the obsolete signal label, adds the grouped Network string, and retains the detailed values reused by Data.

- [ ] **Step 1: Write failing focus and compact-topbar tests**

Create `tests/ui/gameCanvas.test.ts` with a fake `mountCanvas()` that clears the host and appends a child canvas. Bind the component instance, assert the host has `tabindex="-1"`, `aria-label`, and `aria-describedby`, call its exported `focus()`, assert the host is `document.activeElement`, and assert the referenced description still exists after mount.

The description must be a sibling of the host, not a child, because `createCanvasHost()` clears `host.innerHTML`.

In `tests/ui/appShell.test.ts`, add tests that:

- select a Build leaf and observe focus on `game-canvas-host` after `tick()`;
- open Data, press Escape, and observe focus returned to the Data shelf button;
- close City with its close button and observe focus returned to the City shelf button;
- cancel a route draft and observe focus on `lines-list`, not the shelf;
- find Money, Time, Network, Pause/Resume, and all three speed buttons in the Topbar;
- verify the obsolete Hold/Live signal label is absent.

In `tests/runtime/runtimeSelectors.test.ts`, replace individual `late` and `unserved` topbar assertions with `networkSummary: "4 late · 2 unserved"`.

Run and verify RED:

```bash
rtk bunx vitest run --project ui tests/ui/gameCanvas.test.ts tests/ui/appShell.test.ts
rtk bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
```

- [ ] **Step 2: Add the canvas host focus seam without changing runtime ownership**

Update `GameCanvas.svelte`:

```svelte
<div
  class="board"
  data-testid="game-canvas-host"
  bind:this={host}
  tabindex="-1"
  aria-label="City map"
  aria-describedby="game-canvas-description"
></div>
<p id="game-canvas-description" class="sr-only">
  Build and inspect the transport sandbox on the city map.
</p>
```

Export the structural component handle:

```ts
export function focus(): void {
  host?.focus();
}
```

Do not add keyboard tile navigation, a canvas focus API to `RuntimeController`, or a hidden live description inside the mount host.

- [ ] **Step 3: Complete App focus handoffs around runtime-authoritative state changes**

Bind component instances structurally:

```ts
let gameCanvas: { focus: () => void } | null = $state(null);
let commandShelf: {
  focusDestination: (destination: CommandDestination) => void;
} | null = $state(null);

function focusCanvasAfterCommit(): void {
  void tick().then(() => gameCanvas?.focus());
}

function focusShelfAfterClose(destination: CommandDestination): void {
  void tick().then(() => commandShelf?.focusDestination(destination));
}
```

After an exhaustive Build leaf action commits, call `focusCanvasAfterCommit()`. For a close-button handler, capture its destination, commit `setCommandDestination(null)`, then call `focusShelfAfterClose(destination)`. For Escape, compare the pre-call destination to the returned snapshot: only when a generic panel changed from non-null to null should App return focus to that destination button. Route draft Cancel leaves Lines open and relies on `LinesPanel`'s draft-transition focus effect.

- [ ] **Step 4: Compact the Topbar contract and component**

Change `ShellTopbarState` to exactly:

```ts
export interface ShellTopbarState {
  budget: string;
  time: string;
  population: string;
  late: string;
  unserved: string;
  networkSummary: string;
  avgWait: string;
}
```

Delete `signalState`. Retain `late` and `unserved` because Data consumes them, and populate `networkSummary` from the shared selector string introduced in Task 4. Render:

- brand;
- Money (`budget`);
- Time;
- Network (`networkSummary`);
- Population and Avg Wait marked with `.topbar-readout--wide`;
- Pause/Resume and 1x/2x/4x controls.

At 1024–1199px CSS hides only `.topbar-readout--wide`; at 1200px and above it shows both. The controls remain at least 44px tall at every supported width.

- [ ] **Step 5: Replace old drawer CSS with the approved Signal Console layout**

Keep the existing font stack and canvas/render styles, but normalize the primary tokens exactly:

```css
:root {
  --bg-deep: #050a0c;
  --surface: #0d171b;
  --surface-sunk: #071013;
  --ink: #e7f2f4;
  --cyan: #3fe0c5;
  --amber: #ffb627;
  --magenta: #ff4d8a;
  --red: #ff5b5b;
  --topbar-height: 64px;
  --command-shelf-height: 92px;
  --feedback-slot-height: 56px;
}

body {
  min-width: 1024px;
  min-height: 100vh;
  overflow: hidden;
}

.shell {
  display: grid;
  grid-template-rows:
    var(--topbar-height)
    minmax(0, 1fr)
    var(--command-shelf-height);
  width: 100vw;
  height: 100vh;
}

.game-workspace {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.command-panel {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  bottom: calc(
    var(--command-shelf-height) + var(--feedback-slot-height) + 16px
  );
  width: calc(100vw - 32px);
  max-width: 920px;
  max-height: calc(
    100vh - var(--topbar-height) - var(--command-shelf-height) -
      var(--feedback-slot-height) - 32px
  );
  margin-inline: auto;
  overflow: hidden;
}

.command-panel[data-command-panel="build"] {
  max-width: 760px;
}

.command-panel[data-command-panel="data"],
.command-panel[data-command-panel="city"] {
  max-width: 520px;
}

.action-feedback {
  position: absolute;
  z-index: 25;
  right: 16px;
  bottom: calc(var(--command-shelf-height) + 8px);
  min-height: 44px;
  max-width: min(640px, calc(100vw - 32px));
}

.inspection-card {
  position: absolute;
  z-index: 10;
  top: 16px;
  right: 16px;
  width: min(360px, calc(100% - 32px));
  max-height: calc(100% - 32px);
  overflow-y: auto;
}

.command-panel__body {
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

Make `CommandShelf` the final grid row, center its four destination buttons, keep Select and Demolish visually separate, and reserve the shelf footprint rather than covering the canvas. Place `CommandPanel` above that footprint and below the Topbar. The panel body is its sole scroll owner. Place `.inspection-card` at the workspace's right edge without overlapping an open command panel.

Style the Build root as a fixed 2×2 grid, crop images with `object-fit: cover`, keep labels outside the art's essential details, and express hover/pressed/focus with CSS borders, tint, and 150ms color/opacity/transform transitions. Do not bake selected labels or glows into new image files.

Delete obsolete selectors for `.bottom-hud`, `.hud-drawer`, old category bars, Brief, Area, Routes, Manage, `.rejection-banner`, and `.road-mutation-notice`. Retain and rename route-list/editor rules used by `LinesPanel`, but remove any route-list/Build-detail `overflow` or fixed-height rule so `.command-panel__body` remains the only command-panel scroll owner. Do not copy these rules into a second stylesheet.

Apply one global keyboard focus rule and one reduced-motion rule:

```css
button:focus-visible,
[tabindex="-1"]:focus-visible {
  outline: 3px solid var(--cyan);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .command-plate:hover,
  .command-shelf button:hover,
  .command-panel button:hover {
    transform: none !important;
  }
}
```

- [ ] **Step 6: Run UI, selector, static, and production-build verification**

```bash
rtk bunx vitest run --project ui tests/ui/gameCanvas.test.ts tests/ui/appShell.test.ts tests/ui/commandShelf.test.ts tests/ui/commandPanel.test.ts tests/ui/commandPlateGrid.test.ts tests/ui/buildPanel.test.ts tests/ui/linesPanel.test.ts tests/ui/actionFeedback.test.ts
rtk bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
rtk bun run check
rtk bun run lint
rtk bun run format:check
rtk bun run build
```

Expected: PASS. `src/styles.css` contains no 1100px minimum and no old drawer selectors.

- [ ] **Step 7: Format and commit Task 6**

```bash
rtk bunx prettier --write src/runtime/types.ts src/runtime/runtimeSelectors.ts src/components/Topbar.svelte src/components/GameCanvas.svelte src/components/hud/CommandShelf.svelte src/App.svelte src/styles.css tests/ui/gameCanvas.test.ts tests/ui/appShell.test.ts tests/runtime/runtimeSelectors.test.ts
rtk git add src/runtime/types.ts src/runtime/runtimeSelectors.ts src/components/Topbar.svelte src/components/GameCanvas.svelte src/components/hud/CommandShelf.svelte src/App.svelte src/styles.css tests/ui/gameCanvas.test.ts tests/ui/appShell.test.ts tests/runtime/runtimeSelectors.test.ts
rtk git commit -m "feat(ui): finish Signal Console desktop layout"
```

---

### Task 7: Playwright migration, desktop acceptance, documentation, and final verification

**Files:**
- Modify: `playwright.config.ts`
- Modify: `tests/e2e/helpers.ts`
- Create: `tests/e2e/commandShelf.spec.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/e2e/roundabouts.spec.ts`
- Test unchanged: `tests/runtime/e2eHelpers.test.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Replaces E2E navigation by old HUD categories with destination/group/leaf helpers.
- Keeps the Vite development server because E2E relies on the development-only `window.__caelumRuntime` seam.
- Adds no screenshot baseline suite and does not multiply the full test suite across viewport projects.

- [ ] **Step 1: Replace E2E helpers before migrating flows**

Delete `openHudCategory()`, `buildItem()`, `removeMapTile()`'s old HUD selector, `AppServer`, `startAppServer()`, and the now-unused Vite imports from `tests/e2e/helpers.ts`. Retain `runtimeSnapshot`, board-transform helpers, map click/drag helpers, road rebuild, and `debugSetBudget`.

Add these exact navigation helpers:

```ts
import type { BuildGroup } from "../../src/domain/catalog/buildGroups";
import type { CommandDestination } from "../../src/ui/uiState";

export async function openCommandDestination(
  page: Page,
  destination: CommandDestination,
): Promise<void> {
  const trigger = page.getByTestId(`command-destination-${destination}`);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("command-panel")).toHaveAttribute(
    "data-command-panel",
    destination,
  );
}

export async function selectBuildLeaf(
  page: Page,
  group: BuildGroup,
  item: string,
): Promise<void> {
  await openCommandDestination(page, "build");
  const back = page.getByTestId("build-back");
  if (await back.isVisible()) await back.click();
  await page.getByTestId(`build-group-${group}`).click();
  await page.getByTestId(`build-item-${item}`).click();
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
}

export async function selectTool(
  page: Page,
  tool: "select" | "demolish",
): Promise<void> {
  const trigger = page.getByTestId(`command-tool-${tool}`);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
}
```

Add `hoverMapTile(canvas, tile)` beside `clickMapTile()`: reuse `boardTransform(box)` and call `canvas.hover({ position: { x, y } })` at the exact tile center without clicking. `removeMapTile()` calls `selectTool(page, "demolish")`; `rebuildRoadTile()` calls `selectBuildLeaf(page, "roads", "road-twoWay")`.

Run the helper unit test and the TypeScript check to expose every stale import:

```bash
rtk bunx vitest run --project runtime tests/runtime/e2eHelpers.test.ts
rtk bun run check
```

Expected initially: FAIL until the three E2E files are migrated in Step 3.

- [ ] **Step 2: Set one primary desktop viewport and add the three-width acceptance spec**

In `playwright.config.ts`, keep one Chromium project and put the viewport after the device spread so it is not overwritten:

```ts
projects: [
  {
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1280, height: 800 },
    },
  },
],
```

Create `tests/e2e/commandShelf.spec.ts` with a local table:

```ts
const desktopViewports = [
  { name: "compact", width: 1024, height: 768 },
  { name: "primary", width: 1280, height: 800 },
  { name: "wide", width: 1440, height: 900 },
] as const;
```

For each viewport, call `page.setViewportSize()` before navigation and assert:

1. `document.documentElement.scrollWidth <= window.innerWidth` and `scrollHeight <= innerHeight`.
2. Select is pressed, all four destinations are visible, and no command panel exists initially.
3. Every shelf destination, Select, Demolish, Pause/Resume, and speed button has a bounding box at least 44px high and wholly inside the viewport.
4. The visible runtime canvas bounding box ends at or above the shelf's top edge.
5. After opening Build, the panel top is at or below the Topbar bottom and its bottom is at or above the shelf top; its left/right bounds are inside the viewport.
6. The four command-plate images have `naturalWidth === 256`, `naturalHeight === 256`, and loaded successfully.
7. Build's four labels remain in Roads, Transit, Zones, Buildings order.
8. At 1024px, Population and Avg Wait are not visible in Topbar; at 1280px and 1440px they are visible.

Use numeric `boundingBox()` assertions with a one-pixel tolerance; do not compare screenshots.

Add a primary-width keyboard test that Tabs through all four destination buttons in DOM order, opens Build with Enter, arrows right/down/left/up through the 2×2 plate grid, and closes the panel with Escape while verifying focus returns to Build.

- [ ] **Step 3: Migrate current E2E gameplay flows to the new vocabulary**

Update all imports and selectors in `smoke.spec.ts`, `routes.spec.ts`, and `roundabouts.spec.ts`:

- `openHudCategory(page, "routes")` and `openHudCategory(page, "manage")` become `openCommandDestination(page, "lines")`.
- the route creation labels become `New Bus` and `New Metro`;
- the Lines panel stays pinned while a draft exists, so delete every old “reopen the drawer” step;
- Area category selection becomes `selectBuildLeaf(page, "zones", areaId)`;
- Road, Transit, and Building calls use their exact Build group and `BuildMenuItem.id`, not visible text;
- old global Remove tooling becomes `selectTool(page, "demolish")`; keep RouteEditor's waypoint `Remove` button unchanged;
- Brief assertions move to City only where the sandbox overview is actually relevant;
- route-list management remains in Lines and keeps the two-click Delete flow;
- Late, Unserved, and Avg Wait assertions move from Topbar into Data's metrics region after `openCommandDestination(page, "data")`.

Preserve all current gameplay assertions, map coordinates, route preview waits, route revision/reload flows, structure ownership, and deterministic state checks. This is a selector/navigation migration, not weaker E2E coverage.

- [ ] **Step 4: Add one complete primary-width Lines lifecycle to the acceptance spec**

At `1280 × 800`, cover this player-visible sequence in `commandShelf.spec.ts` using the same deterministic map helpers as `routes.spec.ts`:

1. Build a short two-way road and two bus stops.
2. Open Lines and choose New Bus.
3. Verify every other destination and Select/Demolish is `aria-disabled="true"` while the draft is active.
4. Add both stops, verify the connected editor, and Save.
5. Verify the runtime returns to Select, Lines remains open, and `lines-list` has focus.
6. Commit the name `Harbour Shuttle` with Enter, choose a different palette color, Pause the line, and assert all three committed values through `runtimeSnapshot()`.
7. Edit the created line from its primary row, press global Escape to Cancel, and verify Lines remains open with focus returned to the list.
8. Type a temporary rename, press Escape inside the input, and verify `Harbour Shuttle` is restored without closing Lines.
9. Press Escape once to close Lines, click one of the stops to show contextual Inspect, then click an empty tile and verify the card closes without opening a destination.
10. Reopen Lines, Resume the line, use the two-click Delete control, and verify the row and runtime line both disappear.

Do not repeat this full lifecycle at compact and wide widths; the layout table already covers those geometries.

Add a separate primary-width outcome-strip test:

1. Arm Roads with the default budget and `hoverMapTile()` over an empty tile; expect exactly one `action-feedback` with `data-source="roadImpact"` and a preview cost.
2. Set budget to zero through `debugSetBudget()`, commit the same one-tile road gesture, and expect the same sole strip to switch to `data-source="rejection"` with the insufficient-budget message and one Dismiss control.
3. Assert `rejection-banner` and `road-mutation-notice` do not exist at either point.
4. Dismiss the rejection, then press Escape to return the armed road tool to Select and invalidate any underlying road preview; verify the strip clears and no destination opens.

- [ ] **Step 5: Run targeted Playwright while iterating, then the full browser suite**

```bash
rtk bunx playwright test tests/e2e/commandShelf.spec.ts --project=chromium
rtk bunx playwright test tests/e2e/smoke.spec.ts tests/e2e/routes.spec.ts tests/e2e/roundabouts.spec.ts --project=chromium
rtk bun run test:e2e
```

Expected: PASS. Keep traces only on first retry per the existing config; do not add committed screenshot baselines.

- [ ] **Step 6: Perform a manual visual pass at the three approved desktop sizes**

Run the dev server and inspect the actual rendered shell, not only DOM boxes:

```bash
rtk bun run dev
```

At `1024 × 768`, `1280 × 800`, and `1440 × 900`, visually inspect initial Select, Build root artwork, each Build detail group, Lines list, active Lines editor, Data, City, contextual Inspect, Demolish, a road cost/impact strip, and a gameplay rejection. Confirm readable labels, no clipping, one panel scroll owner, canvas separation from the shelf, visible focus rings, and no hover transform when reduced motion is emulated. Stop the dev server after inspection. Save no visual baseline files.

- [ ] **Step 7: Update live architecture documentation only**

In `CLAUDE.md`, replace the `components/` layer description with the current command shelf composition: `Topbar`, `GameCanvas`, `CommandShelf`, one `CommandPanel`, Build/Lines/Data/City panels, contextual Inspect, and `ActionFeedback`.

In `docs/architecture.md` under **UI shell**, replace the BottomHud/HudDrawer bullets with:

- `CommandShelf.svelte` owns four permanent desktop destinations plus Select and Demolish.
- `CommandPanel.svelte` hosts one non-modal Build, Lines, Data, or City workspace; a route draft pins Lines until Save or Cancel.
- `BuildPanel.svelte` uses four checked-in presentation-only command plates and existing runtime arming paths.
- contextual Inspect and `ActionFeedback.svelte` are independent of destination navigation.
- `GameCanvas.svelte` provides the imperative canvas host and DOM focus handoff while rendering stays in `src/render`.

Do not edit historical approved specs. They describe decisions at their point in time.

- [ ] **Step 8: Run the complete repository verification gate**

```bash
rtk bun run check
rtk bun run lint
rtk bun run format:check
rtk bun run test
rtk bun run build
rtk bun run test:e2e
rtk bun run tauri:build
```

Expected: every command exits 0. Do not run independent Rust tests unless a Rust, WASM, Tauri command, snapshot, or host file appears in `git diff`; this UI-only plan must not touch those boundaries.

- [ ] **Step 9: Audit scope, format documentation, and commit Task 7**

```bash
rtk git diff --name-only 4d6692f
rtk rg -n "BottomHud|HudDrawer|activeHudCategory|buildCategory|setHudCategory|setBuildCategory|BUILD_MENU|hud-cat-" src tests CLAUDE.md docs/architecture.md
rtk bunx prettier --write playwright.config.ts tests/e2e/helpers.ts tests/e2e/commandShelf.spec.ts tests/e2e/smoke.spec.ts tests/e2e/routes.spec.ts tests/e2e/roundabouts.spec.ts CLAUDE.md docs/architecture.md
rtk git diff --check
rtk git add playwright.config.ts tests/e2e/helpers.ts tests/e2e/commandShelf.spec.ts tests/e2e/smoke.spec.ts tests/e2e/routes.spec.ts tests/e2e/roundabouts.spec.ts CLAUDE.md docs/architecture.md
rtk git commit -m "test(ui): verify desktop command shelf flows"
```

Expected scope audit: only the implementation plan plus planned TypeScript, Svelte, CSS, WebP, tests, and live docs changed since the approved-design commit; no Rust, WASM wrapper, Tauri command, schema, save, or host-boundary file appears. Expected `rg`: no output.

---

## Execution Review Gate

- [ ] Give each task to a fresh implementation worker using the repository's `worker` route (`gpt-5.6-luna`, max reasoning). Do not let two workers edit the same files concurrently.
- [ ] After Tasks 1, 2, 3, 5, and 6, run a fresh small reviewer (`reviewer`, `gpt-5.6-luna`, max) against that task's requirements and diff; fix concrete findings and rerun the task's focused verification before continuing.
- [ ] After the atomic multi-file cutover in Task 4 and the E2E/docs integration in Task 7, use a multi-file reviewer (`reviewer`, `gpt-5.6-terra`, max), then perform a scoped re-review of every applied fix.
- [ ] After Task 7 is green, run one final whole-branch architecture/correctness review (`reviewer`, `gpt-5.6-sol`, high) against this plan, the approved design spec, and the full diff from the plan base.
- [ ] Apply only concrete final-review fixes within approved scope, rerun their focused tests, obtain a scoped re-review, then rerun the complete repository verification gate from Task 7 Step 8.
- [ ] Confirm `rtk git status --short` is clean and report the final commit range plus all verification evidence. Do not claim completion from per-task green alone.
