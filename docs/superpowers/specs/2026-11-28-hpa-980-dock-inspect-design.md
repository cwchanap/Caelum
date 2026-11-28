# HPA-980 — Inspect and map usability with a dock open — Design specification

**Ticket:** [HPA-980](https://linear.app/cwchanap/issue/HPA-980/keep-inspect-and-the-map-usable-with-a-dock-open)  
**Baseline:** `701d9b58da53f372ffaa5e582dc57573206aa9a9` (main, third UAT).  
**Implementation:** [Implementation plan](../plans/2026-11-28-hpa-980-dock-inspect.md)  
**Delivery:** One draft PR, including these documents, code and tests.

## Problem and scope

HPA-977 intentionally preserved a manually framed map across dock changes, but also preserved pixels from canonical Fit, leaving an edge clipped when the stage narrows and a smaller, left-positioned map when the dock closes. The shell independently hides Inspect whenever any command destination is open. Third UAT findings M2, M3, L1 and L10 belong here.

The current main confirms:
- `src/App.svelte` mounts Inspect only when `snapshot.shell.inspector !== null && snapshot.ui.activeCommandDestination === null`. Inspect already lives within the measured `.game-stage`; CSS reserves a grid column for the dock. No second overlay, new panel, dock-width token or global layout system is required.
- `src/runtime/createGameHost.ts::rebaseForResize` calls `src/render/boardTransform.ts::rebaseCameraForResize` for actual board size changes, and the helper rebases even null camera. Contrary to the ticket's suggestion of a tagged fit mode, the actual contract is `Camera | null`: null is canonical Fit, non-null is a framed camera (possibly `retained`). Fit button/key 0 and normal zoom-out-to-fit already use null.
- Select checks have drifted: `createGameRuntime.ts::handleTileClick` and `createGameHost.ts` picking use inspect + no building; `runtimeSelectors.ts::selectShellState` also checks no selected area. Building placement uses the internal inspect tool identifier. `createGameRuntime.ts::handleEscape` also uses the negation of the shelf predicate. Route drafts set `busRoute`/`metroLine`.
- `ui/actions.ts` vehicle pick and `createGameRuntime.ts::focusWaitLocation` explicitly close the dock so the old gated inspector can mount. Both are obsolete with dock-independent Inspect; the latter also changes the stage after computing the camera against its old size.
- `runtimeSelectors.ts::buildInspector` derives generic `nodeLabel` for transit; `waypointLabel` already supplies stable alphabetic Stop/Station names for route editing. `zoneRunningHint` derives a nearby present node with a running line, not authoritative footprint/growth eligibility.

## Player contract

| Situation | Expected |
| --- | --- |
| Select a physical stop, station, inspectable building or vacant growth-zone tile, with no dock or Build/Lines/Data/City open | Show the anchored Inspect card; keep the current destination, selection and overlay. |
| Activate Select (button or V) with a dock already open, outside an active draft | Disarm any placement tool while keeping the current dock and selected route (including reselecting an already-active Select tool); subsequent Select clicks can inspect beside it. Non-Select tool activation retains existing route deselection and dock behavior. |
| Click Inspect close | Clear only contextual selection, not dock, camera, route selection or overlay. |
| Escape with a dock and Inspect both visible | Preserve existing priority: active gesture/draft first, then dock, then tool/selection. Inspect stays visible after dock close if its anchor is visible. |
| Route draft or building/road/track/area/demolish tool | Clicks remain exclusively draft/build intents, not Inspect; no stale popover from an earlier selection. Draft command locks stay unchanged. |
| Select a committed route path or vehicle | Preserve pick priority and co-located stop/station cycling. A route path opens Lines and clears incompatible selection; a vehicle opens Inspect without closing the current dock. Vehicle/readability redesign is HPA-986. |
| Follow a wait-location row from Lines | Keep Lines open, select the node and its line, disarm placement, and center the camera against the current docked stage in the existing single commit. The serving-line chip still selects/opens Lines without dismissing Inspect. |
| Canonical Fit; dock opens, closes, changes destination or actual available stage size changes | Whole map fits, centered in the safe stage. Fit remains disabled/active as appropriate (camera null), without an extra Fit click. |
| Framed camera (non-null, zoomed/panned or retained), dock changes or viewport resizes | Preserve rendered CSS scale and offsets for visible map points; no implicit clamp/recenter. Cropping a framed view is allowed. Explicit Fit returns to canonical Fit using the current stage. |
| Selected anchor leaves the visible safe stage | Hide the anchored popover rather than detach/pin it to an unrelated edge; selection stays until ordinary clear/change. It can reappear when anchor is visible. |

## Minimal design

### 1. Inspect is independent of command destinations

Define one pure `isSelectMode(ui)` in `src/ui/uiState.ts`: `activeTool === "inspect" && selectedBuilding === null && selectedArea === null`. Do not add a separate routeDraft clause: draft entry points set a route tool. Use the predicate for shell `selectActive`, inspector derivation (`buildInspector`), `handleTileClick`, the host pick gate and the tile-click reducer's Select branch. In `handleEscape` replace the inline negation with `!isSelectMode(ui)`, after the existing gesture/draft/dock checks. Keep selection resolution and precedence in the existing reducer; no dock-specific conditions. In App render any non-null shell inspector without checking activeCommandDestination. In `nextToolUiState`, preserve both `activeCommandDestination` and `selectedRouteId` when choosing Select (even when already active); non-Select transitions still clear route selection and keep existing dock rules. Keep the existing group reset, transient `routeFailureFocus` reset, route draft guard and other tool transition semantics. Delete the explicit `activeCommandDestination: null` assignments in the vehicle-pick branch of `ui/actions.ts` and `focusWaitLocation` in `createGameRuntime.ts`; this removes exceptions to dock-independent Inspect without changing vehicle picking, wait-focus camera logic or service navigation. Keep Escape priority and the existing single camera/selection commit. Avoid rewriting click or keyboard handling.

Keep Inspect inside the existing `.game-stage`. `InspectPanel.svelte` uses the actual stage dimensions, card measurements and camera through `placeInspectorPopover`, which already flips/clamps to the safe region and hides an off-stage anchor. Keep card width bounded by stage, max height and inner scrolling; if necessary adjust only that component's CSS/placement bounds (including arrow clearance at the dock edge). No dock width subtraction: the stage is already narrower. Retain measured stage synchronization and ensure remeasure/anchor updates after refit, dock switch and card content changes, without introducing a per-frame layout poll. Do not elevate the card over the dock.

### 2. Canonical Fit remains Fit

Modify `rebaseCameraForResize` to return null for a null camera, letting `getBoardTransform(newBoard, map, null)` fit and center to the current safe viewport. Keep the existing non-null rebase/retained/clamp logic, including exact canonical coalescing, no-op clamping and navigation rules. Do not infer Fit from zoom <= 1 (retained noncanonical views can have that zoom). No new mode flag, runtime API or layout-cause plumbing. Treat real window resizes in Fit the same as dock resizes: this follows the meaning of Fit and avoids needing to detect a resize cause.

No host resize logic change: `rebaseForResize` already updates `boardCssWidth/Height` before checking camera identity and both resize paths call `render()`. Null-to-null therefore needs no publish. Update its doc comment only for resize; its separate Select pick gate uses the shared predicate. Keep existing device-pixel/zero-size guards, scheduling, draw-authoritative mapping, and gesture pinning. Map text and Inspect already measure the same stage. Do not set camera from Svelte effects. No renderer implementation changes. Update the camera paragraph in `docs/architecture.md` (currently line 396) to state that canonical Fit remains null and refits on passive resize, whereas non-null framed cameras preserve rendered scale and offsets (using retained state when necessary), with existing canonical coalescing and explicit Fit semantics.

### 3. Transit identity and zone copy

Set transit inspector `nodeLabel` via existing `waypointLabel(state, node.id)` (same route-editor logic, including terminal naming convention). Rename or replace the old generic `nodeLabel` helper with a kind label; expose `nodeKindLabel` on frontend-only `ShellTransitInspectorState` (Bus stop, Bus terminal, Metro station). Reuse existing platform labels: subtitle e.g. “Bus stop · Platform A”; for multiple platforms, use “Bus terminal · 2 platforms” (actual count), retaining all individual rows and reassignment controls. No invented selected platform. Keep queue bar/count, route chips, wait evidence and service links, including current time formatting (HPA-981 owns clock-time conversion). Do not relabel building or vehicle headers.

For vacant zoned land, retain `zoneRunningHint` and describe coverage of the inspected tile, not its growth outcome. The hint tests whether the tile itself is inside a running node’s coverage square; Rust growth can place a multi-tile footprint merely touching the square and also depends on capacity balance and placement constraints. Do not infer that uncovered land cannot grow or that covered land will grow.
- Uncovered: “Outside running transit coverage.” Action: “Place a stop within walking reach of this land, then run a line through it.”
- Covered: “Covered by [line]. Land near running transit can develop over time.” Keep the line chip and existing node-kind information. No guarantee or per-lot schedule.

Keep the existing zone title or equivalent zone-type land label and a simple “Zoned land · Empty” subtitle, not a made-up 2×2 footprint. Reuse existing `--warning` (amber) and `--accent` (teal) visual tokens; do not add an `--info` variable. No Rust check, expanded radius, growth-rule copy in TS, or simulation mutation.

## Visual target

Open the actual Linear attachments `r3-dock-inspect.png` (1440×900, Lines dock and Inspect visible simultaneously), `t2-zone-popover.png` (unserved zone status plus action), and optionally `uat3-fix-mockups.html?screen=dock&anno=1`. Reviewed the two PNGs: the docked map is fully framed to the left, the card anchors near Stop C, title and kind/platform subtitle are distinct, and queue information remains readable; unserved zoned land has an amber status and separate teal actionable guidance. Match these scoped elements, not the incidental Lines card sizes, wait units, topbar or HUD/art from other tickets. Use actual current map and data instead of copying illustrative mock values. Do not commit reference uploads or verification screenshots.

## Tests and non-goals

Use one representative open Lines dock for Inspect tests (the player contract applies to all destinations; there is no per-dock implementation branch). Cover the shared Select gate, draft/armed-building negatives, vehicle and wait-location dock retention, reactivating Select with a selected route, names and coverage copy at the appropriate unit/DOM boundary. Rewrite superseded Fit expectations in the existing host/transform and browser dock-geometry tests, tightening `expectMapFitsCanvas` to `HUD_INSET` safe bounds and center agreement within 1 CSS px; retain existing framed retention, offstage and scroll regressions without duplicating them. Add one paused Fit resize with a far-edge pick and one dock-edge Inspect bounds check. Perform actual browser/WASM MCP visual parity for the two attached mockups at 1440×900 and one compact edge check; do not replay Playwright geometry or draft cases via MCP. No native-device acceptance or human acceptance gate. See implementation plan for measurable checks.

No Rust/WASM API, save schema, simulation, topology, new art/SFX, package, renderer-specific UI, generic framework, HPA-981 Lines layout/time conversion, HPA-982 road repair, HPA-984 main layout redesign or HPA-986 vehicle redesign.
