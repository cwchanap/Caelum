# HPA-696 — Dock panels on the right — Implementation plan

**Spec:** [2026-11-11-hpa-696-docked-workspaces-design.md](../specs/2026-11-11-hpa-696-docked-workspaces-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-696/dock-the-panels-on-the-right  
**Baseline:** main @ 0168a57d59387286fea0fae8c97495b97efc9a5a  
**Delivery:** **One PR for HPA-696, including implementation and tests.** This initial draft contains design/plan only. Do not create another PR for code. Do not combine HPA-677, and do not generate new art.

## Change ownership

| Responsibility | Existing files / expected changes | Preserve |
| --- | --- | --- |
| Active-city stage and dock | src/App.svelte; src/styles.css; src/components/hud/CommandPanel.svelte | Runtime/UI snapshot destinations, route-draft gate, command focus and keyboard handling |
| Measured board and camera | src/components/GameCanvas.svelte; existing src/render/boardTransform.ts and src/runtime/createWebGpuHost.ts | One transform for WebGPU, pointer pick, DOM map text; no Rust or new camera model |
| Map inspection anchor | GameCanvas.svelte; App.svelte; src/components/hud/panels/InspectPanel.svelte; src/styles.css | Existing ShellInspectorState and inspect actions |
| Build art and cards | BuildPanel.svelte; CommandPlateGrid.svelte if it still earns its keep; src/assets/sunny-diorama/build-categories/ and build-items/; delete src/assets/command-plates/ | Existing BUILD_GROUPS, BUILDING_CATALOG, tool actions, rotation and cursor cost preview |
| Lines presentation | LinesPanel.svelte; RouteEditor.svelte; styles.css; small presentation-only state in App.svelte if needed | Route preview validity, Save & run nominal price, source/edit distinction, service/fleet actions |
| Other panels | DataPanel.svelte; CityPanel.svelte; styles.css | Existing UI content and semantics |
| Proof | tests/ui/appShell.test.ts, commandPanel.test.ts, buildPanel.test.ts, linesPanel.test.ts, routeEditor.test.ts, inspectPanel.test.ts; tests/e2e/commandShelf.spec.ts, routes.spec.ts, mapInspection.spec.ts; relevant transform/host tests | Player-visible actions over styling internals |

Only touch a file when needed; the list is a change map, not a mandate to edit every file.

## Task 1 — Make one dock and keep all map tiles clickable

1. In **App.svelte**, group the board/MapTextOverlay, bottom shelf, zoom controls and feedback under a relative game-stage. Keep the topbar full-width above both columns to avoid compressing the three status clusters into the narrowed board. Render a workspace-dock sibling **only** when activeCommandDestination is non-null; put the current CommandPanel there.
2. In **styles.css**, make game-workspace a one-column layout when closed and a minmax(0, 1fr) + roughly 360–400px right column when open, with min-width:0 on the stage, and dock top/bottom margins respecting HUD_INSET. Remove centred absolute command panel widths, pinned-right exception and viewport-based panel body height assumptions. Keep header/Close and content scrolling; no full-screen backdrop.
3. Keep CommandShelf and +/−/Fit attached to the stage. Add a dock-open compact treatment for shelf controls at narrower stage widths (labels, padding, mode text) without hiding the actual Build/Lines/Data/City/Select/Demolish actions or their accessible labels. Set maximum shelf width based on stage, not viewport.
4. Verify the **existing** GPU host's ResizeObserver follows the board element after its column shrinks. Let the current boardTransform's width and HUD_INSET compute Fit and picking. Do **not** introduce a second right-side safeRect inset, dynamic HUD geometry, manual canvas remount, or camera persistence. When the dock closes, full-width Fit must recover.
5. Keep destination close/Escape focus behavior in App.svelte. Route drafts remain pinned to Lines until Save/Cancel; no new gate implementation.

**Proof:** UI test checks destination toggles, stage/dock presence, focus and route gate. Playwright at 1440x900 opens a Small-map route draft, selects a bottom-row stop from the visible board and sees its waypoint appear. At 1024px Fit and edge clicks remain correct. Verify pan/zoom/cursor badge still align with tiles.

## Task 2 — Convert Inspect to a bounded click popover

1. Add one optional callback from GameCanvas to App for an **actual click on the canvas surface**. Capture CSS-local coordinates only when the active inspect tool can select a target; ignore the zoom buttons, pan/drag, and clicks in the dock. Do not modify WebGPU hit-testing; the runtime still decides which entity was selected.
2. Keep a local last-click anchor in App. Place InspectPanel as a stage-local absolute popover next to that anchor with a simple clamp/flip to keep it within the stage safe area; show a fixed top-right fallback when runtime opens an inspector through navigation instead of a click. No ongoing vehicle tracking.
3. Retain the current stop/vehicle/building content and action callbacks. Clear the anchor when leaving the city, and make Escape/Select selection changes dismiss the existing inspector normally.

**Proof:** focused UI test for click-based anchor and navigation fallback; existing inspect tests for platform reassignment, route service jump, vehicle load and building details still pass. E2E on map inspection verifies the popover does not block unrelated tiles.

## Task 3 — Build category images, item cards and footer

1. In BuildPanel.svelte, change the four category images to the existing Sunny Diorama build-categories files. Map the BuildMenuItem.id values to already-existing build-items WebP thumbnails via a small file-local static lookup/import. Keep BUILD_GROUPS as the single item/action catalogue; no separate asset-management abstraction.
2. Render one item card per catalogue entry with image, name, placement/footprint cue, and a truthful nominal cost label. Use BUILDING_CATALOG and getRotatedFootprintSize for buildings. For variable or context-dependent actions show a concise **Cost shown at cursor** hint if no reliable per-unit quote is available; do not replace authoritative placement previews with UI arithmetic.
3. Render number-key chips for the visible first nine items, and handle the same numbers only while that Build group is open. Do not intercept text input, modifiers, other command panels or route drafts. Preserve global 1/2/3 road presets where they already apply, and keep mouse/touch availability for extra items.
4. Move Rotate and the armed-item description into a sticky or always-visible footer within the dock. Use the existing selected building, rotation, group hint and price data; no new runtime fields.
5. Delete src/assets/command-plates/ and remove dead imports/CSS/tests only after the new categories render. If CommandPlateGrid is no longer shared/useful, simplify or remove it in this **same** PR rather than leave unused plumbing.

**Proof:** Build UI test covers category drilldown, all item image IDs, selection/number shortcuts, rotating a footprint and correct handling of variable-cost hints; existing build tool/cursor feedback tests still pass.

## Task 4 — Tighten the Lines editor without changing service rules

1. In RouteEditor.svelte, restyle the waypoint list to numbered nodes on a vertical rail; keep the current label and selected/missing statuses, clicking and scrolling. In LinesPanel, supply a line colour from the current selected ShellRouteListItem when editing; use a theme accent for an unsaved route. Keep move/remove controls by each relevant row.
2. Group the **current** Append/Replace/Insert after, Reverse, Undo, Redo and move controls into a compact toolbar; do not change their event handlers, disable gates or keyboard semantics. Keep the loop/shuttle service-pattern selector, preview status, failures/warnings, and Reload saved route action.
3. Reorganize existing saved-route cards for dock width while preserving name/colour editing, active toggle, headway input, initial deployment, add/retire actions, wait-location links, and deletion confirmation.
4. Preserve the **existing** Save & run pricing expression from initialFleetCost and existing Save route edit label exactly. For an accepted save, show a small post-save summary of assigned fleet, target interval and daily operating cost from ShellRouteListItem.service. If a newly created route must be identified, compare route IDs before and after the resolved save in App and keep only a local recentlySavedRouteId. Clear on new draft/city change; avoid a generic message/event layer. Do not make a summary on rejected save.
5. If a requested summary value is null or not in the existing selector, **omit that row**. Do not add wire fields, reconstruct prices, or alter the fleet/deployment dispatch sequence.

**Proof:** UI tests keep Append/Replace/Insert after, move/remove/reverse, undo/redo, preview errors, Save & run price, disabled save, route edit and service actions. E2E creates/edits a line with the dock open and verifies post-save service values come from the selected line.

## Task 5 — Move Data and City into the same visual system

1. Verify DataPanel and CityPanel work in the dock without changing their event/data props. Apply card/input spacing and responsive truncation where necessary; preserve overlays, budget metrics, list/save/rename/delete/loading gates.
2. Audit z-index and pointer-events for Topbar, ActionFeedback, CommandShelf, Inspect, and the right dock. The bare map region must remain clickable, especially when a route draft is active.
3. Check that every close button, keyboard action, save control and scrolling panel has a visible focus state; do not turn the dock into an aria-modal dialog or a trapped-focus region.

**Proof:** Existing Data/City tests, city workflow E2E and a keyboard-only open/close flow remain working.

## Task 6 — Targeted verification and one-pass UAT

Run after implementation:

1. **bun run check** and **bun run format:check**.
2. **bun run lint:svelte** and **bun run lint:css**.
3. **bun run test:unit** (or focused Vitest files while developing).
4. **bun run test:e2e** (notably routes, command shelf, map inspection and the Small-map bottom-row click). Use the repo's normal WASM dev build prerequisite.
5. Browser manual UAT at **1440x900** and **1024x768/900**, with Small 28x18 and Medium 56x36 maps: dock closed/open Fit, pan/zoom, bottom/right edge clicks, route drafting with several stops, Build image and selection, inspector, saved route summary, Data/City actions and Escape.
6. If a relevant test fails, fix it on **this branch/PR** and update the spec only if the behavior decision changes. Do not create a standalone cleanup PR or an exhaustive screenshot test matrix.

## Exit criteria

- With a Lines draft open, every visible map stop remains clickable; the new route includes the actual bottom-row target.
- Board width and GPU click mapping agree after dock open/close; Fit uses the true narrower stage with no hidden right edge.
- Build uses all shipped art assets and no command-plates remain; its cost/footprint text and shortcuts are meaningful.
- Route editing and service management retain existing functionality and cost rules; the post-save summary is honest and data-only.
- Data/City and anchored Inspect work in the new layout; no Rust, WebGPU shader, WASM/Tauri wire, or persistence change was needed.
- The PR stays **draft** for review until implementation and tests have been committed to the same PR.
