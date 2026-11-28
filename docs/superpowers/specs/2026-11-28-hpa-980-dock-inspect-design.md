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
- `createGameRuntime.ts::handleTileClick` treats `activeTool === "inspect" && selectedBuilding === null` as Select; building placement also uses the internal inspect tool identifier. Route drafts have their own click handling.
- `runtimeSelectors.ts::buildInspector` derives generic `nodeLabel` for transit; `waypointLabel` already supplies stable alphabetic Stop/Station names for route editing. `zoneRunningHint` derives a nearby present node with a running line, not authoritative footprint/growth eligibility.

## Player contract

| Situation | Expected |
| --- | --- |
| Select a physical stop, station, inspectable building or vacant growth-zone tile, with no dock or Build/Lines/Data/City open | Show the anchored Inspect card; keep the current destination, selection and overlay. |
| Activate Select (button or V) with a dock already open, outside an active draft | Disarm any placement tool and keep the current dock; subsequent Select clicks can inspect beside it. Existing build leaf/demolish activation still closes the dock. |
| Click Inspect close | Clear only contextual selection, not dock, camera, route selection or overlay. |
| Escape with a dock and Inspect both visible | Preserve existing priority: active gesture/draft first, then dock, then tool/selection. Inspect stays visible after dock close if its anchor is visible. |
| Route draft or building/road/track/area/demolish tool | Clicks remain exclusively draft/build intents, not Inspect; no stale popover from an earlier selection. Draft command locks stay unchanged. |
| Select a committed route path or vehicle | Preserve existing pick priority, repeat-click cycling of co-located stop/station and current dedicated route/vehicle navigation (route opens Lines and clears incompatible selection; vehicle selection currently closes the dock). Explicit wait-location focus and service-control actions retain their existing semantics. Vehicle/readability redesign is HPA-986. |
| Canonical Fit; dock opens, closes, changes destination or actual available stage size changes | Whole map fits, centered in the safe stage. Fit remains disabled/active as appropriate (camera null), without an extra Fit click. |
| Framed camera (non-null, zoomed/panned or retained), dock changes or viewport resizes | Preserve rendered CSS scale and offsets for visible map points; no implicit clamp/recenter. Cropping a framed view is allowed. Explicit Fit returns to canonical Fit using the current stage. |
| Selected anchor leaves the visible safe stage | Hide the anchored popover rather than detach/pin it to an unrelated edge; selection stays until ordinary clear/change. It can reappear when anchor is visible. |

## Minimal design

### 1. Inspect is independent of command destinations

Make the frontend runtime selector own inspector availability: only derive an inspector when Select is truly active (internal inspect tool, no selected building, no route draft). Keep the actual selection resolution in the existing `buildInspector` and `ui/actions.ts`; do not add per-dock conditions or bypass the pick path. In App render any non-null shell inspector, without checking activeCommandDestination. In `nextToolUiState`, preserve the existing destination when switching to Select only; keep current group reset, route draft guard and other tool transition semantics. Avoid rewriting click or keyboard handling.

Keep Inspect inside the existing `.game-stage`. `InspectPanel.svelte` uses the actual stage dimensions, card measurements and camera through `placeInspectorPopover`, which already flips/clamps to the safe region and hides an off-stage anchor. Keep card width bounded by stage, max height and inner scrolling; if necessary adjust only that component's CSS/placement bounds (including arrow clearance at the dock edge). No dock width subtraction: the stage is already narrower. Retain measured stage synchronization and ensure remeasure/anchor updates after refit, dock switch and card content changes, without introducing a per-frame layout poll. Do not elevate the card over the dock.

### 2. Canonical Fit remains Fit

Modify `rebaseCameraForResize` to return null for a null camera, letting `getBoardTransform(newBoard, map, null)` fit and center to the current safe viewport. Keep the existing non-null rebase/retained/clamp logic, including exact canonical coalescing, no-op clamping and navigation rules. Do not infer Fit from zoom <= 1 (retained noncanonical views can have that zoom). No new mode flag, runtime API or layout-cause plumbing. Treat real window resizes in Fit the same as dock resizes: this follows the meaning of Fit and avoids needing to detect a resize cause.

`createGameHost` keeps owning observation and latest usable size; update the commentary/contract to distinguish canonical and framed views. Preserve its device-pixel equality, zero-fit/first mount guards, both ResizeObserver and fallback resize handling, redraw scheduling, draw-authoritative pick/hover mapping, and gesture pinning. For null-to-null resize no camera publish is needed; size and redraw still must update. The resized render, map text and Inspect all consume the same transform and stage dimensions. Do not set camera from Svelte effects. No renderer implementation changes. Preserve pinned in-progress drag coordinates rather than silently remapping an already-started build stroke; subsequent gestures use the newly drawn map.

### 3. Transit identity and zone copy

Set transit inspector `nodeLabel` via existing `waypointLabel(state, node.id)` (same route-editor logic, including terminal naming convention). Rename or replace the old generic `nodeLabel` helper with a kind label; expose `nodeKindLabel` on frontend-only `ShellTransitInspectorState` (Bus stop, Bus terminal, Metro station). Reuse existing platform labels: subtitle e.g. “Bus stop · Platform A”; for multiple platforms, use “Bus terminal · 2 platforms” (actual count), retaining all individual rows and reassignment controls. No invented selected platform. Keep queue bar/count, route chips, wait evidence and service links, including current time formatting (HPA-981 owns clock-time conversion). Do not relabel building or vehicle headers.

For eligible vacant zoned land, retain `zoneRunningHint` and use it to drive two clear states:
- Unserved: “Not growing yet. No running line stops within walking reach.” Action: “Place a stop within walking reach of this land, then run a line through it.”
- Served: “Served by [line]. A nearby stop/station is on a running line. This land can grow when a suitable building fits.” Keep line chip and explain growth is conditional, not a guarantee or an immediate promise. The simulation evaluates growth in six-game-hour waves; avoid implying each particular lot grows every six hours. Keep the existing zone title or use the equivalent zone-type land label and a simple “Zoned land · Empty” subtitle, not a made-up 2×2 footprint (the selector represents one tile). Reuse existing warning/info visual tokens. No Rust check, expanded radius, growth-rule copy in TS, or simulation mutation.

## Visual target

Open the actual Linear attachments `r3-dock-inspect.png` (1440×900, Lines dock and Inspect visible simultaneously), `t2-zone-popover.png` (unserved zone status plus action), and optionally `uat3-fix-mockups.html?screen=dock&anno=1`. Reviewed the two PNGs: the docked map is fully framed to the left, the card anchors near Stop C, title and kind/platform subtitle are distinct, and queue information remains readable; unserved zoned land has an amber status and separate teal actionable guidance. Match these scoped elements, not the incidental Lines card sizes, wait units, topbar or HUD/art from other tickets. Use actual current map and data instead of copying illustrative mock values. Do not commit reference uploads or verification screenshots.

## Tests and non-goals

Regression tests cover Select plus all four destinations, route draft and building armed (internal inspect tool but not Select), close/dismiss, stop/station/terminal naming including co-location, served/unserved zone feedback, Fit round trips and non-null frame retention. Validate placement on both stage edges and offstage anchors, existing inner scroll and safe viewport. Keep unit/render tests for the shared geometry; extend existing browser Playwright flows and perform actual browser/WASM MCP screenshot visual parity at 1440×900. No native-device acceptance or human acceptance gate. See implementation plan for measurable checks.

No Rust/WASM API, save schema, simulation, topology, new art/SFX, package, renderer-specific UI, generic framework, HPA-981 Lines layout/time conversion, HPA-982 road repair, HPA-984 main layout redesign or HPA-986 vehicle redesign.
