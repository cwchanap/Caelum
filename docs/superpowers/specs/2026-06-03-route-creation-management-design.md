# Route Creation & Management — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## Summary

Replace the current auto-committing route-creation flow with an explicit,
step-by-step flow: select a route tool, add stops one at a time (with the
ability to remove a mis-added stop), then explicitly **Finish** to commit a
route of any length (≥2 stops). Add a **route management panel** to the Control
Tower for listing, renaming, recoloring, pausing, deleting, and highlighting
existing routes and metro lines.

This is a UI/UX + frontend-state feature. The simulation data model
(`GameState`) is unchanged; all new state is UI-only.

## Motivation

Today (`src/ui/actions.ts`), the `busRoute` / `metroLine` tools accumulate stop
ids in `UiState.draftStopIds` / `draftStationIds` and **auto-commit the instant
the 2nd stop is clicked**, immediately assigning a vehicle and clearing the
draft. Consequences:

- Routes can never have more than 2 stops.
- No way to undo a mis-clicked stop mid-draft.
- No naming/color control.
- No management: the only way to remove a route is to delete one of its stop
  buildings; routes cannot be renamed, recolored, paused, or inspected as a
  list.

## Decisions (from brainstorming)

1. **Finalization:** explicit **Finish** step; routes can be any length (≥2
   distinct stops). Players can **remove a specific mis-added stop** while
   drafting.
2. **Naming/color:** auto-assigned on Finish (existing "Bus N" / default
   color); editable afterward in the management panel.
3. **Management panel scope (in):** list all routes; rename/recolor; toggle
   active/inactive; delete; select/highlight on map. **Deferred (out):**
   editing a committed route's stops; adjusting per-route vehicle count.
4. **Draft controls placement:** inside the Control Tower's existing Route
   Planning section, expanding into a draft sub-panel while a draft is in
   progress.
5. **Management placement:** a new numbered Control Tower section.
6. **Approach:** extend existing patterns (UiState draft arrays + pure
   `transit.ts` mutators + selectors + Control Tower sections), rather than a
   `routeDraft` state-machine refactor or a standalone floating panel.

## Architecture

All changes follow the existing pipeline:

```
Svelte (Control Tower) → RuntimeController method → pure helper (transit.ts / actions.ts)
   → commit() swaps GameState/UiState → selectShellState() re-derives ShellState
   → re-render canvas + publish snapshot
```

### State model

No changes to `src/domain/types.ts` — `Route` and `MetroLine` already carry
`name`, `color`, and `active`. New state is UI-only, in `src/ui/uiState.ts`:

- Reuse existing `draftStopIds` / `draftStationIds`. Behavior change only: they
  accumulate until an explicit Finish instead of auto-committing at 2.
- **`selectedRouteId: string | null`** (new) — the route highlighted from the
  management panel. Added to `createUiState()` as `null`. Cleared on tool
  change / remove / reset like other selection fields.

### Pure functions (`legacy-ts-simulation/transit.ts`)

Each takes `GameState`, returns a new `GameState`, and **preserves reference
equality when nothing changes** (per the determinism / reference-equality
dispatch contract). Each resolves the id against **both** `routes` and
`metroLines` so one function covers both modes.

- `renameRoute(state, routeId, name)` — sets `name`; empty/whitespace name
  falls back to the existing auto-name (`Bus N` / `Metro N`).
- `setRouteColor(state, routeId, color)` — sets `color`.
- `setRouteActive(state, routeId, active)` — flips `active`.
- `deleteRoute(state, routeId)` — removes the route/line, removes its vehicles,
  and strips its id from every platform's `routeIds`. This is **extracted from
  the route-removal logic currently inline in `removeAtTile`** (`actions.ts`);
  `removeAtTile` is refactored to call the shared helper, removing duplication.
  Unknown id → same-reference no-op.

### Controller methods (`src/runtime/types.ts` + `createGameRuntime.ts`)

New `RuntimeController` methods, each a thin wrapper that calls a pure helper
and `commit`s:

- `removeDraftStop(index: number)` — remove the draft entry at `index` from the
  active mode's draft array.
- `finishRoute()` — commit the current draft (see flow below).
- `cancelRoute()` — clear the active draft array.
- `renameRoute(routeId, name)`
- `recolorRoute(routeId, color)`
- `toggleRouteActive(routeId)`
- `deleteRoute(routeId)`
- `selectRoute(routeId | null)` — set/clear `selectedRouteId` (clicking the
  selected route again clears it).

### Selectors (`src/runtime/runtimeSelectors.ts` + `runtime/types.ts`)

Two new derived shell shapes:

- **`ShellRouteDraftState | null`** — present when the active tool is a route
  tool and the draft is non-empty:
  - `mode: "bus" | "metro"`
  - `stops: Array<{ index: number; label: string; coord: string }>` — ordered.
  - `distinctCount: number`
  - `vehicleCost: number`
  - `canFinish: boolean` and `finishHint: string` (reason when disabled:
    "Add another stop" when `<2` distinct, "Need $X" when unaffordable).
- **`ShellRouteListState`** — `Array<ShellRouteListItem>` where each item is:
  - `id`, `name`, `color`, `mode: "bus" | "metro"`, `stopCount: number`,
    `active: boolean`, `selected: boolean`.
  - Derived from `state.transit.routes` (bus) and `state.transit.metroLines`
    (metro), concatenated.
  - Plus the available recolor palette (shared constant).

Both are surfaced on `ShellState` (and consumed by `ControlTower.svelte`).

## Creation (draft) flow

1. **Entry:** click "Bus Route" / "Metro Line" in Route Planning → sets the
   tool and clears any existing draft (unchanged `nextToolUiState` behavior).
2. **Add stops:** clicking a valid stop/station appends its id to the draft.
   `handleTileClick`'s `busRoute` / `metroLine` branches **no longer
   auto-commit at 2** — they accumulate. Clicking a tile with no matching node
   is a no-op. Clicking the same stop as the immediately previous entry is
   rejected (no consecutive duplicate).
3. **Draft sub-panel** (Route Planning section, visible while draft non-empty),
   from `ShellRouteDraftState`:
   - Ordered stop list `1 · Bus Stop (3,4)`, each with an **✕** →
     `removeDraftStop(index)`.
   - **Finish** — enabled only when `distinctCount ≥ 2` **and** the player can
     afford one vehicle ($8,000 bus / $50,000 metro). Disabled shows
     `finishHint`.
   - **Cancel** → `cancelRoute()`.
   - Live readout: stop count + vehicle cost.
4. **Finish** (`finishRoute`): call `addBusRoute` / `addMetroLine` with the
   draft ids, then `assignVehicle` for the new line (the same two-step the old
   auto-commit performed), then clear the draft. The new route gets its
   auto-name and default color. Affordability is gated by the disabled Finish
   button, keeping behavior deterministic; `finishRoute` also re-checks and is
   a no-op if called when not finishable.

## Management panel

A new always-present Control Tower section, **`Routes`**, placed after `05 ·
Brief`. Because the existing `Platforms` inspector section is conditional, the
section numerals are reflowed so they stay sequential (Routes and Platforms
take `06`/`07`); the exact numerals are finalized during implementation. Driven
by `ShellRouteListState`, it lists all routes and metro lines together. Each
row:

- Color swatch + name; Mode tag (Bus / Metro); stop count; active/inactive.

Per-row controls:

- **Rename** — inline text field; commits on blur/Enter via
  `renameRoute(routeId, name)`. Empty → auto-name fallback.
- **Recolor** — a small fixed palette of swatches (the same palette new routes
  draw from) → `recolorRoute(routeId, color)`. No external color-picker
  dependency; keeps the value set deterministic.
- **Active toggle** → `toggleRouteActive(routeId)`. Inactive rows render
  dimmed; their vehicles already idle (`assignedLinePositions` returns `null`
  for inactive lines).
- **Delete** — two-step confirm (click → "Delete?" → confirm) →
  `deleteRoute(routeId)`.
- **Select/highlight** — clicking the row → `selectRoute(routeId)`; clicking
  the selected row again clears it.
- **Empty state:** "No routes yet" hint when no routes/lines exist.

### Render highlight (`src/render/` transit renderer)

Additive passes in the existing transit renderer:

- When `ui.selectedRouteId` is set, emphasize that route's stops and connecting
  path (brighter stroke / halo on its stops).
- While a draft is in progress, draw a preview stroke through the draft's
  current stops so the player sees the shape as they build.

Both are keyed off `ui.selectedRouteId` and the draft arrays; no simulation
involvement.

### Open item to verify during implementation

Confirm `legacy-ts-simulation/router.ts` trip planning already excludes **inactive**
routes/lines from new trip plans. If it does not, `setRouteActive(…, false)`
must also exclude the line from routing so "pause" truly pauses. Include the
fix if needed.

## Testing

`tests/` mirrors `src/` by domain.

**`tests/simulation/` (node):**
- `renameRoute` / `setRouteColor` update only the target line; empty name →
  auto-name fallback; reference equality preserved when unchanged.
- `setRouteActive` flips the flag; reactivating restores vehicle motion;
  inactive line's vehicles idle.
- `deleteRoute` removes the route + its vehicles + strips its id from every
  platform's `routeIds`; unknown id is a same-reference no-op. Both bus and
  metro.
- Regression: `removeAtTile` still removes routes when a stop building is
  deleted (now via shared `deleteRoute`).
- Router excludes a route toggled inactive from new trip plans.

**`tests/runtime/` (node):**
- Route tool accumulates stops without committing; draft survives past 2 stops.
- `removeDraftStop` drops the correct entry; `cancelRoute` clears the draft.
- `finishRoute` creates the line + assigns a vehicle + clears the draft; no-op
  when `<2` distinct stops or unaffordable.
- `selectRoute` toggles `selectedRouteId`.
- Migrate existing "auto-commit at 2 stops" expectations to the explicit-finish
  flow.

**`tests/ui/` (jsdom):**
- Draft sub-panel renders the ordered stop list; ✕ calls `removeDraftStop`;
  Finish disabled with the right reason when `<2` stops / unaffordable.
- Routes section lists rows with swatch/name/mode/stop-count; rename, recolor,
  toggle, delete (with confirm), and row-select fire the right callbacks; empty
  state shows the hint.

**`tests/render/` (jsdom):** selected-route highlight and draft preview draw
without throwing and only when `selectedRouteId` / a draft is set.

**`tests/e2e/` (Playwright):** one smoke flow — pick Bus Route, click 3 stops,
remove one, finish; then rename, toggle inactive, and delete it from the panel.

## Out of scope (future work)

- Editing a committed route's stop list (add/remove/reorder).
- Adjusting per-route vehicle count.
- Free-form color picker (palette only for now).
