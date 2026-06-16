# Road-building tool UX — Design

Date: 2026-06-16

## Problem

Placing and editing roads today is click-by-click and low-feedback:

- Selecting a tool/building leaves the Build drawer open, covering the board.
- Roads are laid one tile per click; direction is changed by repeatedly
  clicking a tile to cycle through `undefined → north → east → south → west`.
- There is no fast way to build a one-way pair (a divided road).
- Build vs. delete mode is only conveyed by a small text chip in the bottom HUD.
- There are no keyboard shortcuts for tool selection.

This design improves the road-building UX without changing the simulation model
or the determinism contract. It builds entirely on the existing road tile model
introduced in `2026-06-14-road-direction-multilane-design.md`: a road is a tile
with `kind: "road"` and an optional `oneWay: RoadDirection` constraint
(`undefined` = two-way).

## Goals

1. Selecting a building / road / track closes the Build drawer and shows the
   active type on the cursor.
2. Build or change road direction by dragging across multiple tiles.
3. Three road presets: 1-lane two-way, 1-lane one-way, 2-lane bidirectional.
4. A clear build-mode vs. delete-mode indicator.
5. Keyboard shortcuts for the tool/build menu.

## Non-goals (YAGNI)

- No road **capacity / throughput** model. "Lanes" are tile geometry only; the
  simulation, router, and citizens are unchanged. A "2-lane" road is literally
  two parallel one-way tiles.
- No curved / L-shaped / free-path drags. Drags are axis-locked straight lines.
- No diagonal roads.
- No configurable keybindings.
- No traffic-side toggle. Right-hand-traffic convention is fixed.

## Key model fact

The road model has **no lane/capacity concept**. A road tile is
`kind: "road"` + optional `oneWay: RoadDirection`. Therefore the presets map
directly onto existing semantics:

| Preset                | Tile result                                            |
| --------------------- | ------------------------------------------------------ |
| `twoWay` (1 lane)     | single row, `oneWay: undefined`                        |
| `oneWay` (1 lane)     | single row, `oneWay: <drag axis direction>`            |
| `dualBidirectional`   | two parallel rows, opposite one-way directions         |

No `GameState` or simulation changes are required.

## A. UiState changes

Add two fields to `UiState` (`src/ui/uiState.ts`):

```ts
roadPreset: "twoWay" | "oneWay" | "dualBidirectional"; // default "twoWay"
dragStart: Point | null; // pressed tile during an active drag; null otherwise
```

A `RoadPreset` type alias is added to `src/domain/types.ts` next to the other
tool/road types.

The drag preview is **derived, not stored**: it is `axisLockedLine(dragStart,
hoverTile)`. Storing only `dragStart` keeps the preview flowing through the
normal snapshot → `renderGame` path, with no out-of-band rendering and no risk
of the preview drifting from committed state.

`createUiState()` initializes `roadPreset: "twoWay"` and `dragStart: null`.
`nextToolUiState` / `nextBuildingUiState` (in `createGameRuntime.ts`) preserve
`roadPreset` across tool switches and reset `dragStart` to `null`.

## B. Road presets UI

`BuildPanel.svelte` gains a preset selector under the Network/Road section: a
three-button group bound to `ui.roadPreset`, shown for the Road tool. Each
button calls a new `onSetRoadPreset(preset)` callback. Labels: "1-Lane",
"1-Lane One-Way", "2-Lane". The buttons carry `01/02/03` numbering to match the
existing panel style and the `1/2/3` hotkeys.

Selecting a preset does **not** close the drawer (so presets can be compared).
Selecting a tool or building does (section F).

## C. Drag gesture

Road, Track, and Remove become **press-drag** tools driven by pointer events;
the legacy `click` handler is suppressed for exactly these three tools so a tap
does not double-fire (a `click` event always follows `pointerup`). `click`
continues to drive Inspect, bus stop / metro station placement, route drafting,
and building placement unchanged.

Runtime pointer handling (`createGameRuntime.ts` `mountCanvas`) adds
`pointerdown` and `pointerup` listeners alongside the existing `pointermove` /
`pointerleave`:

- `pointerdown` on an in-map tile, when `activeTool` ∈ {road, track, remove}:
  call `startDrag(point)` → sets `ui.dragStart`.
- `pointermove`: existing `setHoverTile` (unchanged). The preview is derived
  from `dragStart` + `hoverTile`.
- `pointerup`: call `commitDrag()` → applies the line, clears `dragStart`.
- `pointerleave` mid-drag and `Esc` mid-drag: call `cancelDrag()` → clears
  `dragStart` with no commit. `pointerleave` still also clears `hoverTile`.
- The `click` handler early-returns when `activeTool` ∈ {road, track, remove}.

New runtime controller methods: `setRoadPreset(preset)`, `startDrag(point)`,
`commitDrag()`, `cancelDrag()`. `cancelDrag()` is also folded into the existing
`Esc` / Cancel path in `App.svelte` so an in-flight drag is abandoned first.

### Single-tile parity rule

A zero-/one-tile drag (a tap: `pointerdown` and `pointerup` on the same tile)
reproduces today's exact click behavior:

- Road: lay a two-way tile on empty, **cycle direction** on existing road.
- Track: lay track.
- Remove: bulldoze one tile (track first, then road — existing priority).

**Preset direction is applied only when the line spans ≥2 tiles** (i.e. the
drag has a defined axis). This keeps single-tile UX byte-for-byte identical to
today and preserves the existing `cycleRoadDirection` tests.

### Pure drag module

A new pure module `src/ui/roadDrag.ts` holds the gesture logic, keeping the
already-large `actions.ts` focused:

```ts
export function axisLockedLine(start: Point, end: Point): Point[];
export function applyDragGesture(
  state: GameState,
  ui: UiState,
  line: Point[],
): GameState;
```

- `axisLockedLine` locks to the dominant axis (greater of |dx|, |dy|; ties pick
  horizontal) and returns the inclusive straight tile line from `start`.
- `applyDragGesture` routes by `ui.activeTool` and `ui.roadPreset`, composing
  existing pure helpers (`layRoad`, `setTileOneWay`, `layTrack`,
  `removeInfrastructureAtTile`, `cycleRoadDirection`). It folds the line into a
  single new `GameState`. Each road/track tile costs the existing
  `COSTS.road` / `COSTS.track`; an invalid tile in the line is skipped (no-op),
  exactly as `layRoad` is a no-op on an invalid tile today. Budget is consumed
  per tile actually laid, in line order, stopping naturally when funds run out
  (each helper is already a no-op when unaffordable).

The runtime's `commitDrag` calls `applyDragGesture(state, ui,
axisLockedLine(ui.dragStart, ui.hoverTile))` and commits the result with
`dragStart` cleared.

## D. 2-lane bidirectional geometry & direction

For a ≥2-tile drag with the `dualBidirectional` preset:

- The dragged row/column is the **forward** lane, carrying the drag-axis
  direction.
- A second parallel lane is added on the **left-hand side of travel**, carrying
  the **reverse** direction (right-hand-traffic convention).

Worked examples:

- Drag **east**: dragged row = eastbound; lane to the **north** (y−1) =
  westbound.
- Drag **west**: dragged row = westbound; lane to the **south** (y+1) =
  eastbound.
- Drag **south**: dragged column = southbound; lane to the **east** (x+1) =
  northbound.
- Drag **north**: dragged column = northbound; lane to the **west** (x−1) =
  southbound.

The left-of-travel offset is computed from the axis direction via a fixed
left-perpendicular vector. Per-tile validity is respected independently: if a
second-lane tile is off-map / occupied / already non-empty, that single tile is
skipped rather than failing the whole drag.

## E. Cursor badge + mode tint (rendering)

**Tint** — the drag/hover preview is tinted by intent, reusing existing color
tokens:

- Build (valid): `colors.previewValid` fill / `previewValidStroke`.
- Delete or invalid placement: `colors.previewInvalid` / `previewInvalidStroke`.

`overlayRenderer.ts` is extended to draw the **drag line preview**: for an
active drag it strokes/fills every tile in `axisLockedLine(dragStart,
hoverTile)`, with one-way arrows for the `oneWay` preset and both lanes (with
opposing arrows) for `dualBidirectional`. When no drag is active, the existing
single-tile hover/building preview is used.

**Cursor badge** — a small screen-space label anchored to the hovered tile,
drawn as a new pass in `renderGame` **after** the world transform is restored,
so its text is rendered at crisp screen pixels rather than scaled board units.
It is snapshot-driven and tile-anchored (recomputed per hovered tile —
deterministic and testable). Content by mode:

- Road: `⦿ Road`, `⦿ Road →` (one-way), `⦿ Road ⇄` (2-lane).
- Track: `⦿ Track`.
- Remove: `⦿ Demolish`.
- Building selected: `⦿ <Building label>`.
- Invalid target under cursor: trailing `⊘`.

The badge position is computed from `getBoardTransform` + `tileSize` (the same
math `canvasToTile` inverts). It is hidden when `hoverTile` is null or the
active tool is Inspect with nothing to place.

A couple of color tokens are added to `colors.ts` for the badge background /
text and (if needed) a distinct demolish red; preview tints reuse existing
tokens.

## F. Auto-hide build drawer

Selecting a tool or a building closes the drawer: `setTool` and `setBuilding`
set `activeHudCategory = null`. The cursor badge + preview tint now carry the
active-mode feedback that the open drawer used to. Selecting a road **preset**
(`setRoadPreset`) leaves the drawer open.

## G. Hotkeys

Handled in `App.svelte`'s existing `handleWindowKeydown`, extended and guarded
so shortcuts never fire while typing in an input / textarea / contenteditable
(e.g. the route-rename field):

| Key       | Action                                       |
| --------- | -------------------------------------------- |
| `B`       | Toggle the Build drawer                      |
| `R`       | Select Road tool                             |
| `T`       | Select Track tool                            |
| `X`       | Select Remove tool                           |
| `V`       | Select Inspect tool                          |
| `1`/`2`/`3` | Select road preset (when Road tool active) |
| `Esc`     | Cancel — abandon drag, then existing reset   |

Keys are matched case-insensitively and ignored when a modifier (Ctrl/Cmd/Alt)
is held.

## H. Testing

- `tests/runtime` (node, pure logic):
  - `axisLockedLine`: dominant-axis lock, tie → horizontal, inclusive endpoints,
    single-tile.
  - `applyDragGesture`: `twoWay` / `oneWay` / `dualBidirectional` over ≥2-tile
    lines; dual-lane direction + left-offset for all four axes; per-tile
    skip on invalid tiles; budget exhaustion mid-line; track-line; bulldoze-line.
  - Single-tile parity: tap reproduces `layRoad` / `cycleRoadDirection` /
    `layTrack` / `removeInfrastructureAtTile`.
  - Runtime: `setRoadPreset` updates state and persists across `setTool`;
    `startDrag` / `commitDrag` / `cancelDrag`; `setTool` / `setBuilding` close
    the drawer; preset selection keeps it open.
- `tests/render` (jsdom): drag-line preview tint (valid green / invalid red),
  one-way and dual arrows in preview, cursor badge text + screen anchor per
  mode.
- `tests/e2e` (Playwright, optional smoke): drag to build a road line; `B`
  hotkey toggles the drawer; `R` then drag builds road.

## I. Risk / compatibility notes

- Determinism: untouched. All new logic is pure and composes existing
  deterministic helpers; nothing enters the `tickSimulation` pipeline.
- Existing single-click road/track/remove tests remain valid via the
  single-tile parity rule.
- Pointer-based gesture handling lives in `mountCanvas` (DOM); its tests run in
  the jsdom-backed render/ui projects where a canvas host is available, matching
  existing patterns.
