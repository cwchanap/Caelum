# Bottom HUD Redesign — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)

## Problem

The current `ControlTower.svelte` is a single ~470-line bottom overlay that crams
seven sections — Global tools, Build, Route Planning, Overlay, Brief, Routes, and
the contextual Platforms inspector — into one ~34vh panel with a 6–7 column grid.
Everything is visible at once, the panel is dense and hard to scan, and the single
component is too large to test or reason about in isolation.

We want a **bottom HUD**: a slim, always-docked bar that lets the player pick a
category (Build, Routes, Manage, Data, Brief), with the selected category's
controls sliding up in a focused drawer. The map stays maximized by default.

## Goals

- Replace the monolithic always-on panel with a slim bar + on-demand drawer.
- One focused panel visible at a time — no multi-column cram.
- Keep the runtime as the single source of truth (per `CLAUDE.md`); Svelte renders
  snapshots and emits intents only.
- Break the giant component into small, independently testable panels.

## Non-Goals (YAGNI)

- No new gameplay or simulation changes.
- No drag-to-resize drawer.
- No keyboard number-shortcuts beyond the existing Esc.
- No persistence of the last-open category across reloads (always start at default).

## Interaction Model

**Persistent bar + drawer.** A slim bar is always docked at the bottom. Clicking a
category button slides up a drawer above the bar containing only that category's
controls. Clicking the active category again collapses the drawer back to the slim
bar.

**Categories:** Build · Routes · Manage · Data · Brief, plus a contextual
**Inspect** context that is only entered by clicking a stop/station on the map
(never via a bar button).

- **Build** — placement tools (bus stop, bus terminal, metro station, small/large
  house) + Rotate, plus the global Inspect / Remove tools.
- **Routes** — Bus Route / Metro Line creation tools + the live route draft
  (stop list, cost readout, Finish/Cancel).
- **Manage** — the route list: rename, recolor, pause/resume, delete, select.
- **Data** — overlay toggles (coverage, crowding, demand, lateness, growth).
- **Brief** — scenario title/status/goal/note/next-wave + active tool/target.
- **Inspect** (contextual) — platform occupancy + per-platform route reassignment
  (the existing inspector).

**Inspector behavior:** clicking a node auto-opens the drawer in the Inspect
context. Clicking empty map, pressing Esc, or closing the drawer dismisses it. The
Inspect affordance only appears on the bar (as a chip) while a node is selected.

## Topbar

Keep the live stats (Budget, Clock, Population, Late, Unserved, Avg Wait) and the
Pause/Speed controls in the topbar. **Remove** the now-redundant "Control Tower"
toggle button — categories live in the bottom bar. The Brief drawer covers
scenario goal/status text only, not the live numbers (which remain in the topbar).

## Slim Bar Contents

Left → right:

1. Five category buttons (icon + label), each carrying a live badge:
   - **Routes** — a dot when a route draft is in progress.
   - **Manage** — the current route count.
   - **Data** — the active overlay's name (or none).
   - **Inspect** — appears as a chip only while a node is selected.
2. The **active-tool chip** — a readout of the currently armed tool/building
   (reusing `formatActiveTool`) so the player always knows what a map click does,
   even with the drawer collapsed.
3. A **Cancel/Esc** affordance, enabled only when something is cancellable
   (a draft in progress or a non-default tool armed).

## Architecture

### State model — `src/ui/uiState.ts`

```ts
export type HudCategory =
  | "build" | "routes" | "manage" | "data" | "brief" | "inspect";

// in UiState:
activeHudCategory: HudCategory | null;   // null = drawer collapsed (slim bar only)
// remove: controlTowerOpen
```

- Default on load: `"brief"` (greet the player with the scenario objectives).
- `"inspect"` is only ever set by `handleTileClick` resolving a node, never by a
  bar button.

### Runtime intents — `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts`

- Replace `toggleControlTower()` with `setHudCategory(cat: HudCategory | null)`.
  The component decides toggle-collapse semantics (clicking the active category
  passes `null`); the runtime just applies what it's told.
- `handleTileClick`, when it resolves a node for inspection, sets
  `activeHudCategory = "inspect"` so the inspector auto-opens.
- `cancelRoute` / `resetUi` (Esc) remain the quick-cancel wiring.

### Selectors — `src/runtime/runtimeSelectors.ts`, `src/runtime/types.ts`

Add a derived `ShellHudState` to the snapshot so the slim bar stays a pure
renderer:

```ts
interface ShellHudBadges {
  routeDraftActive: boolean;          // dot on "Routes"
  routeCount: number;                 // count on "Manage"
  activeOverlayLabel: string | null;  // name on "Data"
  inspectActive: boolean;             // node selected → show Inspect chip
}

interface ShellHudState {
  activeCategory: HudCategory | null;
  activeToolChip: string;             // reuse formatActiveTool()
  canCancel: boolean;                 // draft in progress OR non-default tool armed
  badges: ShellHudBadges;
}
```

`ShellControlTowerState` loses `controlTowerOpen`. The brief fields stay available
to the Brief panel (same data, regrouped); the existing `selectShellState` keeps
producing them.

### Components — `src/components/`

```
components/
  Topbar.svelte          keep stats + Pause/Speed; remove tower toggle button
  GameCanvas.svelte      unchanged
  hud/
    BottomHud.svelte     slim bar: 5 category buttons + tool chip + badges + Cancel
    HudDrawer.svelte     sliding container; renders the active panel
    panels/
      BuildPanel.svelte    build tools + rotate + Inspect/Remove (global)
      RoutesPanel.svelte   Bus Route / Metro Line tools + live route draft
      ManagePanel.svelte   route list (rename/recolor/toggle/delete/select)
      DataPanel.svelte     overlay toggles
      BriefPanel.svelte    scenario title/status/goal/note/wave + tool/target
      InspectPanel.svelte  platforms + route reassignment (the old inspector)
```

`ControlTower.svelte` is deleted. `App.svelte` composes `BottomHud` + `HudDrawer`,
passing the relevant shell slices and intent handlers to each.

## Layout & Styling

- **Slim bar:** fixed ~56px strip docked to the bottom (`left/right: 16px`, matching
  the current panel insets). Reuses the existing dark-console design language
  (`styles.css` variables, signal accents, mono readouts).
- **Drawer:** slides up *above* the slim bar when a category is active
  (≈ `min(40vh, 360px)`), single-column or a simple grid sized to that one panel's
  content — no more six-column cram. Slide/opacity transition reusing the existing
  `.control-tower--closed` transition language.
- Active category button renders visually pressed; clicking it again collapses the
  drawer.

## Testing

- **Unit (runtime):** `setHudCategory` transitions; auto-`inspect` on node click;
  `canCancel` and badge derivation in selectors.
- **UI (jsdom):** each panel renders its controls; `BottomHud` shows badges and the
  tool chip; clicking a category opens the matching panel; Cancel is disabled when
  nothing is cancellable.
- **E2E (Playwright):** migrate the existing flows that reference the old tower
  toggle. Preserve `data-testid`s where behavior is unchanged (`route-select-*`,
  `route-delete-*`, `platform-panel`, `route-draft`, route color/toggle testids,
  etc.). Add `data-testid="bottom-hud"` and per-category ids (`hud-cat-build`,
  `hud-cat-routes`, …). The old `data-action="toggle-tower"` / `close-tower` and
  `data-testid="control-tower"` are removed; those references are migrated to the
  new bar/drawer testids.

## Migration Notes

- `App.svelte` `data-tower-open` attribute (driven by `controlTowerOpen`) is
  replaced by a drawer-state attribute (e.g. `data-hud-category`) if any test/style
  depends on it.
- `formatActiveTool` is reused for the tool chip; no duplicate formatting logic.
