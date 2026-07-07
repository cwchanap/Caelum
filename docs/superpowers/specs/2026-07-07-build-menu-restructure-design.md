# Build Menu Restructure — Design

**Date:** 2026-07-07
**Status:** Approved (pending spec review)

## Problem

The **Build** drawer panel (`src/components/hud/panels/BuildPanel.svelte`) stacks
four unrelated sections into one scrolling column:

1. **Global** — Inspect, Remove
2. **Areas** — 6 zone paints
3. **Network** — Road, Track (+ road presets)
4. **Build** — all 14 buildings in one flat, undifferentiated grid that mixes
   transit infrastructure (Bus Stop, Bus Terminal, Metro Station) with
   zone-specific buildings (houses, shops, factories, offices, civic, park).

The flat 14-item grid is hard to scan, and unrelated concerns (global tools, zone
painting, network, buildings) share one panel. We want the placement UI organized
into clear categories with a shallow, predictable navigation.

## Goals

- Promote the two "building" concerns to first-class bottom-HUD categories:
  **Build** and **Area**, alongside Routes · Manage · Data · Brief.
- Reorganize everything you *place* under **Build** as a two-level
  **category → item** drill-down (e.g. Build → Road → 2-Lane, Build → Bus →
  Bus Stop, Build → Residential → Small House).
- Move the always-used **Inspect** / **Remove** global tools out of the drawer and
  onto the HUD bar as a persistent toggle cluster.
- Keep the runtime as the single source of truth (per `CLAUDE.md`); Svelte renders
  snapshots and emits intents only. No gameplay/simulation changes.
- Drive the Build panel from a data catalog, not a hardcoded flat list.

## Non-Goals (YAGNI)

- No changes to `crates/caelum-core` — this is a UI/runtime-boundary change only.
- No new buildings, tools, costs, or placement rules.
- No search/filter box in the Build panel.
- No keyboard shortcuts beyond existing Esc.
- No persistence of the last-open Build category across reloads (Build reopens at
  its category root).
- No merge of Area into Build; they stay distinct top-level categories.

## Interaction Model

### Top-level bottom HUD

The permanent category buttons become:

**Build · Area · Routes · Manage · Data · Brief** (+ contextual **Inspect**).

`area` is added to `PrimaryHudCategory`. Build and Area each open their own drawer
panel above the bar; clicking the active category again collapses the drawer (the
existing toggle behavior in `BottomHud.toggle`).

**Persistent Inspect / Remove cluster.** Inspect and Remove move from the old
"Global" section to always-visible toggle buttons docked on the HUD status area
(right of the bar, near the tool-chip and Cancel). They call `setTool("inspect")`
/ `setTool("remove")` and reflect pressed state. They are one click, no drawer.
The **contextual Inspect detail panel** (opened by clicking a stop/station on the
map, gated by `badges.inspectActive`) is unchanged.

### Build panel — drill-down (root ↔ detail)

- **Root view** (`buildCategory === null`): a grid of category buttons —
  Road · Rail · Bus · Metro · Residential · Commercial · Industrial · Office ·
  Civic · Park. Clicking a category calls `setBuildCategory(id)` (pure UI; the
  drawer stays open).
- **Detail view** (`buildCategory !== null`): a `‹ Back` control + a
  `Build › <Category>` breadcrumb, then that category's item buttons. Back calls
  `setBuildCategory(null)` to return to the root.
- Selecting a **leaf item** commits the tool/building/preset via the existing
  setters and closes the drawer (today's behavior — see State & Data Flow). The
  next time Build opens it shows the root, because the tool/area/building
  transitions reset `buildCategory` to `null`.

**Category → item → action map:**

| Category | Items | Leaf action |
|---|---|---|
| Road | 1-Lane, 1-Lane One-Way, 2-Lane | `setTool("road")` + `setRoadPreset(twoWay / oneWay / dualBidirectional)` |
| Rail | Track | `setTool("track")` |
| Bus | Bus Stop, Bus Terminal | `setBuilding("busStop" / "busTerminal")` |
| Metro | Metro Station | `setBuilding("metroStation")` |
| Residential | Small House, Large House | `setBuilding(...)` |
| Commercial | Supermarket, Cinema | `setBuilding(...)` |
| Industrial | Factory, Warehouse | `setBuilding(...)` |
| Office | Office Tower, Business Park | `setBuilding(...)` |
| Civic | Clinic, School | `setBuilding(...)` |
| Park | Park Plaza | `setBuilding(...)` |

Road is the only category whose leaf carries a preset. A Road leaf must set both
the tool and the preset in one commit so a single click fully arms the tool.

The **Rotate** control (currently at the bottom of the Build section) stays in the
Build panel, shown in the detail view when the selected item is a rotatable
building (i.e. `selectedBuilding !== null`).

### Area panel

A new flat single-level `AreaPanel.svelte`, extracted verbatim from the old Areas
section: 6 zone buttons (Residential · Commercial · Industrial · Office · Civic ·
Park) calling `setArea`. No drill-down.

## Architecture

### New data catalog: `src/domain/catalog/buildMenu.ts`

The single source of truth for the Build drill-down. Read-only, UI-layer catalog
(consistent with `domain/catalog/*` being read-only TS shared by UI/render).

```ts
export type BuildCategoryId =
  | "road" | "rail" | "bus" | "metro"
  | "residential" | "commercial" | "industrial"
  | "office" | "civic" | "park";

// A leaf's effect, expressed as a discriminated union the panel maps to setters.
export type BuildItemAction =
  | { kind: "tool"; tool: Extract<Tool, "road" | "track">; roadPreset?: RoadPreset }
  | { kind: "building"; building: BuildingType };

export interface BuildMenuItem { id: string; label: string; action: BuildItemAction }
export interface BuildMenuCategory { id: BuildCategoryId; label: string; items: BuildMenuItem[] }

export const BUILD_MENU: BuildMenuCategory[]; // ordered as in the table above
```

Item labels reuse `BUILDING_CATALOG[type].label` for buildings and the existing
road-preset labels ("1-Lane", "1-Lane One-Way", "2-Lane"). `BuildPanel` renders
entirely from `BUILD_MENU`; adding a building later is a catalog edit.

### State: `src/ui/uiState.ts`

- Add `"area"` to `PrimaryHudCategory` (so it gets a permanent bar chip;
  `HudCategory` and the drawer title map extend automatically).
- Add `buildCategory: BuildCategoryId | null` to `UiState`, defaulting to `null`
  in `createUiState()`. It is the *only* new UI field; it tracks which Build
  category the drill-down is showing.

### Runtime: `src/runtime/createGameRuntime.ts`

- `nextToolUiState`, `nextAreaUiState`, `nextBuildingUiState` each additionally set
  `buildCategory: null`. This guarantees committing a leaf (which routes through
  one of these) collapses the drill-down back to root and the drawer closes as it
  does today (`activeHudCategory: null` is already set by all three).
- New controller method `setBuildCategory(id: BuildCategoryId | null)`: commits
  `{ ...ui, buildCategory: id }` **without** touching `activeHudCategory`, so the
  drawer stays open during category navigation. No-op commit when unchanged.
- A Road leaf is applied as `setTool("road")` then `setRoadPreset(preset)` from the
  panel's click handler (two existing setters), or a small helper that sets both in
  one commit to avoid an intermediate render. Either is acceptable; prefer the
  single-commit helper for reference-equality cleanliness.

### Runtime boundary types: `src/runtime/types.ts`

- Add `setBuildCategory: (id: BuildCategoryId | null) => RuntimeSnapshot` to
  `RuntimeController`.
- Extend `ShellHudState` (or add a small `ShellBuildState`) so the shell can render
  the Build panel and the persistent cluster:
  - `buildCategory: BuildCategoryId | null`
  - `inspectToolActive: boolean` / `removeToolActive: boolean` (pressed state for
    the persistent toggles; derived from `activeTool` with no building/area
    selected).

### Selectors: `src/runtime/runtimeSelectors.ts`

Populate the new `ShellHudState` fields from `ui`. `activeToolChip`
(`formatActiveTool`) already covers Road/Track/building/area labels and needs no
change. No new badges for Area (it has no count/draft state).

### Components

- **Rework** `src/components/hud/panels/BuildPanel.svelte` — replace the four
  stacked sections with the root/detail drill-down driven by `BUILD_MENU`. Props:
  `buildCategory`, `selectedTool/selectedBuilding/roadPreset/buildingRotation`
  (for active-state highlighting), and callbacks `onSetBuildCategory`,
  `onSelectItem` (dispatches the leaf action), `onRotateBuilding`. Drops Global,
  Areas, and Network sections.
- **New** `src/components/hud/panels/AreaPanel.svelte` — the extracted 6-zone
  paint grid. Props: `selectedArea`, `onSetArea`.
- **Edit** `src/components/hud/BottomHud.svelte` — add the **Area** category button
  to the `categories` list; add the persistent **Inspect** / **Remove** toggle
  cluster in the `hud-status` region with pressed state from `hud`.
- **Edit** `src/components/hud/HudDrawer.svelte` — add `"area"` to the `titles`
  map and render `AreaPanel` for `category === "area"`; wire the new
  `buildCategory` / `onSetBuildCategory` / `onSelectItem` props into `BuildPanel`;
  keep the other branches unchanged.
- **Edit** `src/App.svelte` (or wherever the drawer is composed) — thread the new
  controller callbacks and shell fields through.

### Data flow (unchanged shape)

Component → `RuntimeController` method → `commit()` swaps UI state → publishes a
`RuntimeSnapshot`. Category navigation (`setBuildCategory`) mutates only
`buildCategory`; leaf selection reuses `setTool` / `setBuilding` / `setRoadPreset`,
which already close the drawer and reset selection. No new dispatch to the Rust
backend; these are all local UI helpers, exactly as the current tool/area/building
selection is.

## Testing

Unit / component (Vitest):

- `tests/ui/uiState.test.ts` — `createUiState()` includes `buildCategory: null`;
  `PrimaryHudCategory` includes `area`.
- `tests/ui/buildPanel.test.ts` — root shows 10 categories; clicking a category
  calls `onSetBuildCategory`; detail shows that category's items + Back; Back
  returns to root; selecting a leaf dispatches the correct action (building vs
  road+preset vs track); Rotate appears only for a selected building.
- New/updated tests for `AreaPanel.svelte` — 6 zones, `onSetArea` fires.
- `tests/ui/bottomHud.test.ts` — Area chip present; persistent Inspect/Remove
  toggles render and reflect pressed state; toggling calls `setTool`.
- `tests/ui/hudPanels.test.ts` / `tests/ui/appShell.test.ts` — drawer routes
  `area` → AreaPanel, `build` → reworked BuildPanel; drawer title for Area.
- `tests/runtime/gameRuntime.test.ts` — `setBuildCategory` keeps the drawer open
  and only changes `buildCategory`; `setTool`/`setArea`/`setBuilding` reset
  `buildCategory` to `null`.
- `tests/runtime/runtimeSelectors.test.ts` — new `ShellHudState` fields
  (`buildCategory`, `inspectToolActive`, `removeToolActive`) derive correctly.

E2E (Playwright), `tests/e2e/routes.spec.ts`:

- Road: open Build → click **Road** category → click **2-Lane** → drag. (Was a
  single "Road" click.)
- Track: Build → **Rail** → **Track**.
- Bus Stop: Build → **Bus** → **Bus Stop**.
- Metro Station: Build → **Metro** → **Metro Station**.
- Update comments that reference the old flat drawer. `openHudCategory` helper is
  unchanged; add a small `buildItem(page, category, item)` helper if it reduces
  duplication.

## Risks / Notes

- **Extra clicks.** Drill-down adds one click per category switch vs the old flat
  list. Accepted per the chosen design (option C); Back + a persistent tool cluster
  keep common actions shallow.
- **Selector churn.** Several UI/e2e tests assert the old section structure; the
  spec lists each. Expect a moderate test diff, but no runtime-logic risk since the
  leaf actions reuse existing, tested setters.
- **Aesthetic continuity.** Preserve the existing HUD look (mono labels, numbered
  feel, active-state styling). Category buttons and item buttons should reuse the
  current `.toolbar` / button styles; the breadcrumb/Back is the only new element.
```
