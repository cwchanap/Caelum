# HPA-977 — Finish the docked panels from the revamp — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-977/finish-the-docked-panels-from-the-revamp  
**Repository:** cwchanap/Caelum  
**Baseline inspected:** main at d143036ecc08907c6c8ba9a26a1c74aa09bcb8ce (2026-11-20)  
**Delivery:** One HPA-977 PR, initially design/plan-only and later updated with implementation and tests. Do **not** open a separate implementation PR.  
**Visual source of truth:** Linear attachments t2-route-editor-low-money.png, t2-lines-list.png, t2-data-panel.png, t2-city-panel.png, t2-zone-popover.png, 03-route-editor-vs-mockup.png and revamp-mockup-game.png, plus uat-fix-mockups.html?screen=lowmoney|lines|data|city|zone&anno=1.

## Outcome and constraints

Finish the Sunny Diorama right-dock experience while preserving the existing playable transit operations loop. A player can compose and edit a route, understand the first fleet purchase *before* committing, manage saved services through compact controls, inspect map objects (including vacant zoned land), and switch Build/Lines/Data/City without the map unexpectedly sliding or zooming.

- Keep Svelte 5 as presentation, TypeScript runtime as UI orchestration, and Rust caelum-core as the authority for route validation, initial-fleet sizing, purchase, operations and growth. No Rust, persistence-schema, backend API or new renderer pipeline is planned.
- Use the existing runtime snapshot, route-draft generation/selection methods, service metrics, overlay catalog and city rename action. Add only small view projections/actions needed for new controls. No extra modal/dialog framework, generic store, derived pricing formula, art, or dependency.
- A route draft continues to gate workspace switching; keyboard focus, Save/Cancel/Reload semantics, wait-location navigation, existing error announcements and two-click Delete protections remain intact.
- CityList row styling, New City, City Library, top bar, markers and map art are HPA-978/HPA-979 work and must not be changed here.

## Verified baseline

| Area | Current implementation | Gap addressed by HPA-977 |
| --- | --- | --- |
| Route editor | src/components/hud/panels/RouteEditor.svelte: native pattern radios, one selectable button per waypoint, three toolbar groups with shared Move/Remove, priced Save button | Segmented pattern; per-waypoint actions; one compact toolbar; before-save summary and low-money affordance |
| Lines | LinesPanel.svelte: route mode instead of line name chip, persistent name input, Target label plus repeated value/input, separate Add and Retire controls | Compact named cards, pencil-activated rename, a single target editor and stepper, action icons |
| Inspect | InspectPanel.svelte and inspectorPlacement.ts: anchored card for transit/building/vehicle, but old 07 headings and no Close; runtimeSelectors.buildInspector returns null for empty land | Context title, dismiss, pointer and queue bar; zoned-land hint |
| Data and City | DataPanel.svelte and CityPanel.svelte: numbered headings, overlay names without inline explanations, active city name without rename pencil | Light cards, linked metrics, named city header/edit, no numbered section chrome |
| Dock resize | App.svelte swaps the stage/dock CSS grid; createGameHost.ts ResizeObserver redraws; boardTransform.ts stores camera.zoom relative to current fitScale | A narrower stage silently changes CSS pixels per tile and cursor tile, even when the camera object stays unchanged |
| Fleet quote | RouteEditorView.initialFleetCost is a current-generation Rust nominal quote; runtime.saveRouteDraft already creates first and attempts deployment, then selects new line | Standard budget is available but not compared *for display* before save; an unaffordable save currently surprises the player with a toast |

## 1. Route editor

Use the established dock and existing RouteEditorView rather than another draft model.

- Render Loop/Shuttle as two accessible segmented buttons with aria-pressed, preserving onPattern and exact existing route semantics.
- Render each numbered waypoint on the existing vertical rail. Row click calls onSelectWaypoint(index, interaction) and visually highlights it. Each row owns accessible move-up, move-down and remove buttons. The button first selects its row, then calls the existing move/remove handler; those runtime methods are synchronous, and selection-only changes do not restart the preview. Disable bounds actions and keep missing-stop guidance. Remove the shared Move/Remove toolbar controls.
- One compact, wrapping toolbar contains Append, Replace, Insert after, Reverse, Undo and Redo. Replace/Insert still require a selected row, and clicking the map after choosing Insert after inserts after that row. Preserve all preview warnings, rejected-draft state, route repair guidance, reload-edit-conflict, Cancel and history.
- Add a restrained **After saving** summary below the preview. For existing line edits, show the currently known assigned fleet, target interval and daily cost *as current values*, not falsely as post-edit predictions. For new lines, show that first fleet/target will be finalized by Rust on Save and that the actual running cost appears in the selected Lines card after saving; show the known nominal fleet quote, or no quote when unavailable. Never reconstruct required fleet or daily operating cost from draft travelSeconds in TypeScript: that would disagree with Rust's congestion-aware service metrics. The saved line is already selected by the runtime and its existing service card shows authoritative fleet, target and daily cost after the Save.
- Keep one large primary button. A new, valid route with a nominal quote displays Save & run plus the formatted quote when the first fleet is affordable; otherwise the Standard-mode editor shows an inline warning (needs X, available Y) and the visible label **Save without fleet**. Edit remains Save route; unavailable quotes keep the existing Save & run fallback, not a new disabled gate.
- The warning is a non-authoritative presentation derived from *current* state.budget, rules.economyPreset and the current-generation initialFleetCost. Creative still displays nominal prices but never warns based on budget; do not subtract cost or authorize in the UI. The backend keeps its unconditional attempt to deploy for a quoted newly saved line. Capture whether a shortage was already warned at Save invocation so the expected insufficientBudget rejection does not also produce a surprise toast; preserve the existing toast as a fallback when budget changes between the preview and dispatch. Keep saved-without-fleet cards navigable and show the actual deployment recovery action.

Implementation seam: project an affordability indication and compact summary fields in runtimeSelectors.ts/RouteEditorView, or pass the few needed display-only values via LinesPanel. Reuse existing formatBudget and route service data. No extra Rust quote request, no new save command, no parallel state machine.

## 2. Lines cards

Restyle the current list rather than replacing it. Show a colored chip labeled with **route.name**, a pencil that toggles an inline name input, status pill, estimated running interval (e.g. Every 6.5 min), one target-headway input, assigned fleet, Daily cost and no-fleet reason/recommendation/deploy affordance.

- A compact − / fleet count / + stepper invokes **onRetireServiceVehicle** and **onAddServiceVehicle** only when their respective existing Rust-derived canRetireVehicle / nextVehicleCost gates allow them. Keep pendingServiceActions so rapid clicks or panel switches cannot duplicate a command. Show next vehicle nominal cost and no-refund retirement in accessible labels/hints.
- Pencil activates the established routeNameDrafts edit behavior: Enter or blur commits once, Escape restores without triggering dock Escape. Do not rename just by selecting the line.
- Keep headway validation, no-fleet manual Deploy, wait-location diagnostics, route color palette, two-step deletion, Edit/Pause/Resume controls, and test IDs. Icons can be lightweight inline symbols/SVGs with explicit aria-labels; do not add an icon package.
- Continue the existing once-per-selection scroll into view, including immediately after Save & run; do not add a duplicate saved-route summary cache.

## 3. Inspect and vacant zoned land

Keep the popover *stage-local*, tied to ui.selectedId and placeInspectorPopover; do not add DOM click-coordinate state or move it into the dock.

- Replace numbered section headings with the actual selected stop, station, building or vehicle title; retain route chips, platform reassignment, live load/destination and workplace status. Provide a Close button that clears the selected map tile/vehicle/node kind through one minimal RuntimeController action, without closing a dock, mutating gameplay or clearing an unrelated selected line. Extend runtime keyboard semantics so dismissal is also accessible where appropriate.
- On stop/station, aggregate displayed platform occupancy and capacity to an accessible queue bar plus numeric text, while preserving per-platform occupancy and serving-route wait information.
- Add a small pointer/arrow using CSS, oriented toward the selected tile based on the existing placement result. If required, extend the small placement helper's return data with a horizontal/vertical placement side; avoid a second positioning system. Keep its existing off-screen hide, edge-flip, safe-area and zero-size behavior.
- Select already records the tile ID on vacant land. In runtimeSelectors.buildInspector, after testing real vehicles/nodes/buildings, return a small **zone** inspector variant for tiles with kind=empty and a non-null area. Show readable zone type and a careful general hint about growth requiring service. Reuse an existing exact running-stop reach projection *only if readily available*; otherwise do not claim a location is covered, and do not add a Rust coverage algorithm.
- Unzoned empty tiles continue to have no inspector. Selected map and route interactions keep their existing precedence.

## 4. Data and City

- Use OVERLAY_CATALOG descriptions as concise inline helper text on the Coverage/Crowding/Demand/Traffic tiles. Existing legend remains on the map. Preserve toggle-to-clear and active state.
- Style the existing metric links as cards with Late → Traffic, Unserved → Coverage, Avg Wait → Crowding. Keep their true metric values and accessibility, no misleading new calculations or duplicate overlay legend. Drop the 04/05 section labels.
- City panel header uses activeCity.name, pencil-activated rename (existing onRename and busy gate), save-status text and Save action; the existing overview and local city list still work. Keep onRetryList, dirty/unsaved navigation gates and status labels, and remove the 04 label. Do not restyle the shared CityList rows; HPA-978 owns those.

## 5. Preserve view and pointer mapping during dock resize

**Problem:** Camera.zoom is a multiplier of fitScale(stage,map). A dock resize changes fitScale, so a constant camera no longer denotes constant screen scale or selected world point. Both WebGPU and Canvas2D now use createGameHost.ts; fix the shared host/boardTransform logic once.

- Add a small pure **rebaseCameraForResize(oldBoard, newBoard, map, currentCamera, anchor)** helper next to getBoardTransform. When an already-mounted board changes measured size, calculate old pixels-per-tile and the world point beneath the last pointer (when it remains within both stage rectangles), otherwise use the visible viewport center as anchor. Construct a new camera with zoom = oldAbsoluteScale / newFitScale and center adjusted so that same world point projects to the same stage-local CSS coordinate. Respect map-edge clamping; if a pointer is now under the dock/outside the new board, preserve the map-center point rather than an impossible offstage anchor.
- Non-Fit rebased views may need **zoom below 1** after a dock closes, because the old pixel scale can be smaller than the new full-map Fit scale. Permit that for camera *preservation* while keeping explicit Fit as the only action that resets camera to null. Update the “fittedAsNull”/clamping helpers consistently so a deliberate zoom command can still return to Fit without silently dropping a below-fit retained view. This is a local view-only adjustment, not a persistence or Rust change.
- Only rebase when both old and new board sizes are real, the map/city did not change, and the CSS dimensions actually changed. On first mount or new/load city, retain normal Fit behavior. Do not rebase on ordinary simulation ticks.
- Apply the rebase exactly once in the existing ResizeObserver/size-change seam before drawing and pointer remapping, and synchronize the drawn transform and picking target across that resize; prevent observer/render recursion by comparing sizes. Do not add parallel transforms to App, MapTextOverlay, WebGPU or Canvas2D.
- Explicit **Fit** must intentionally refit to the current available stage, including dock width. Once Fit has been applied, any *subsequent* dock resize is still preserved until the next user Fit. Pan, zoom, cursor wheel anchor, selected popovers, hover and route-line picking keep using the same resolved transform.

The strict invariant is that toggling or switching a dock does not itself request camera zoom/pan or reframe the player's view. Exact under-cursor anchoring is geometrically possible for interior points and is bounded by existing map-edge clamps at extremes; tests should exercise representative interior positions plus constrained edges.

## Out of scope and risk controls

- No new marker art, sprite pipeline, New City/Library/topbar polish, autosave or Crossroads changes.
- No new backend API, Rust service quote calculator, save schema/version, UI global store, modal system or generalized camera framework.
- Preserve data-driven headway/fleet/status/queue content; a visual mockup must not cause invented service figures.
- New UI affordances must have accessible names and keyboard behavior; do not silently weaken route draft and busy/pending guards.
- Camera behavior is more important than a cosmetic pixel match: prevent regressions in pointer hit-testing after layout resize and in both existing render paths.

## Acceptance (fully automated / MCP)

1. **Visual:** Using Playwright through MCP, capture at 1440×900 the new route editor (including low money), saved Lines, Data, City, Inspect stop/building and zone popover. Compare screenshots visually against the Linear t2 mockups, 03-route-editor-vs-mockup.png and revamp-mockup-game.png. A small layout difference is acceptable; hierarchy, controls, labels and palette must match. Capture a narrow viewport (1280×720) to verify readable, scrollable cards and no map obstruction.
2. **Gameplay end to end:** Via browser MCP test create a Standard city, build a valid line, observe the *pre-save* under-budget warning/Save without fleet, save it, verify the line persisted with no fleet and usable Deploy recovery; separately verify affordable Save & run creates and deploys, Creative does not warn on nominal prices, edit/undo/redo/insert/reorder/delete and route selection remain functional.
3. **Map end to end:** With pointer over an interior map tile at Fit and zoomed views, open/close/switch Build, Lines, Data and City and open Lines by clicking a route stroke. Assert unchanged tile under cursor and unchanged displayed CSS tile scale before any explicit Fit, correct picking, and intentional re-fit only after Fit. Verify edge cases do not crash and pointer/hover follow the displayed map.
4. **Panel end to end:** Select a stop/station to inspect queue and open its service controls; select and dismiss a building and vacant zoned tile; click metric cards to change overlays; rename a line/city; use fleet add/retire only when authorized; confirm Save, Escape and two-click Delete gates.
5. **Verification:** Updated Vitest unit/component/pure-camera tests, TypeScript/Svelte check, lint, format, and targeted Playwright in Chromium pass, then repository CI green. One browser platform is enough for shared logic; no native-only acceptance is needed unless the implementation introduces platform-specific behavior. There is no separate human approval gate.
