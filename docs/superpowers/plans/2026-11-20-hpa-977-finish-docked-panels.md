# HPA-977 — Finish the docked panels — Implementation plan

**Spec:** [2026-11-20-hpa-977-finish-docked-panels-design.md](../specs/2026-11-20-hpa-977-finish-docked-panels-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-977/finish-the-docked-panels-from-the-revamp  
**Baseline:** main @ d143036ecc08907c6c8ba9a26a1c74aa09bcb8ce, 2026-11-20  
**Delivery:** **Exactly one HPA-977 PR.** This initial draft commits docs only; commit all code, tests and screenshot evidence to **this PR/branch** before marking ready. Do not open an implementation PR. No new art/SFX.

## What is already present

- The HPA-696 dock structure lives in App.svelte, CommandPanel.svelte and styles.css. Do not rebuild it.
- RouteEditor.svelte already has selection, undo/redo, pattern and Save callbacks. The current-generation Rust initial-fleet quote is available at RouteEditorView.initialFleetCost, and Standard/Creative plus budget are available from the game state.
- saveRouteDraft in createGameRuntime.ts already keeps create → attempt initial deployment ordered, reports late insufficient-budget feedback, and selects the newly created line. LinesPanel's selected card already shows the *actual* assigned fleet, target headway and operating cost.
- LinesPanel already has route rename, headway update, Rust-priced Add, allowed Retire, Deploy, Pause/Resume, delete confirmation, wait-location focus and action pending guards.
- Selecting an empty tile records ui.selectedId, so a zoned-land popover needs only a selector case, not another pointer pipeline.
- DataPanel already uses the overlay catalog and linked metrics. CityPanel already receives the active city, persistence state, city rename callback and shared CityList.
- createGameHost.ts and boardTransform.ts are now shared across WebGPU and Canvas2D (HPA-1144): change view-resize behavior once, here.

## Implementation ownership / smallest change map

| Focus | Primary files | Guardrails |
| --- | --- | --- |
| Route editor affordability, after-save guidance and row controls | src/runtime/runtimeSelectors.ts, src/runtime/types.ts, src/components/hud/panels/RouteEditor.svelte, LinesPanel.svelte, src/runtime/createGameRuntime.ts | Preserve Rust pricing/deploy authority and all preview generation/save tokens |
| Saved line cards | src/components/hud/panels/LinesPanel.svelte, src/styles.css | Reuse existing callbacks/guard fields; preserve selected-card scroll and diagnostics |
| Inspect popover / zone | src/runtime/runtimeSelectors.ts, src/runtime/types.ts, src/runtime/createGameRuntime.ts, src/ui/actions.ts only if necessary, InspectPanel.svelte, src/render/inspectorPlacement.ts, src/App.svelte | Selected tile is already present; no DOM click coordinate, no Rust coverage work |
| Data and City | DataPanel.svelte, CityPanel.svelte, src/styles.css | Reuse overlayCatalog and existing CityList/rename, no shared-list restyle |
| Camera | src/render/boardTransform.ts, src/runtime/createGameHost.ts | One shared transform for visual render, labels, picker and both renderers |
| Tests / screenshots | tests/ui/routeEditor.test.ts, linesPanel.test.ts, inspectPanel.test.ts, cityPanel.test.ts, tests/runtime/runtimeSelectors.test.ts, tests/render/boardTransform.test.ts or existing equivalent, tests/e2e/routes.spec.ts, mapInspection.spec.ts, commandShelf.spec.ts | Update targeted existing tests first; no duplicate E2E framework |

This is a change map, not a mandate to edit every listed file. Avoid new libraries/components unless repeating markup becomes demonstrably worse.

## Task 1 — Freeze existing behavior in focused regression tests

1. Start from current main and update existing RouteEditor and LinesPanel tests for the proposed interface, preserving Save & run quoted/unquoted, edit Save route, selected row, missing waypoints, Delete confirm, fleet pending controls, wait-location focus and once-only selected card scroll.
2. Add a test showing a valid new Standard draft with an authoritative initialFleetCost greater than state.budget. Assert pre-save warning and primary button label, and that Creative with the same nominal quote has no budget warning. Add a test that an unquoted/rejected/stale draft does not fabricate a warning. Assert runtime Save still calls create then deployment as before.
3. Add a pure camera resize contract test that currently reproduces the bug: shrinking/expanding the stage changes the fit multiplier, but the same interior world point must remain under the anchored cursor and the CSS tile scale must stay fixed until explicit Fit.
4. Add zone inspector selector test for an empty zoned tile and no zone popup on unzoned/road tiles.
5. Run the focused tests to establish the baseline failure as each feature is implemented. Do not merge test-only fixes that weaken existing behavior.

**Gate:** New failing assertions reproduce missing behavior without breaking already-supported actions.

## Task 2 — Complete route drafting and the before-save fleet warning

1. Derive only **display-only** values in selectRouteEditorView: current Standard-vs-Creative budget warning from current-generation Rust quote; reuse selected saved route metrics for current edit summary when available. Keep the canSave and previewPending logic untouched.
2. Restyle Loop/Shuttle as an accessible segmented control, replace the waypoint's single button with a selectable row plus per-row move/remove controls, and combine Append/Replace/Insert after/Reverse/Undo/Redo into a single toolbar that wraps in a narrow dock. Use existing selection + move/remove callbacks, no second draft state.
3. Render the After saving section; quote nominal first fleet cost if provided, indicate target/allocation information without inventing post-save daily cost, and link conceptually to the selected saved-line card for actual service cost. Edited routes show current actual service metrics marked as current, never as a guaranteed forecast.
4. For known Standard shortage, show inline reason and label **Save without fleet** *before* Save. The click still invokes the single existing saveRouteDraft path and backend still attempts deployment. Capture known-shortage-at-click only to avoid redundant expected error toast; leave the insufficient-budget fallback for a new late change and preserve non-budget rejections.
5. Ensure missing quote remains Save & run, edit stays Save route, rejected drafts keep current gates, and Save/Cancel/Reload/Undo/Redo keyboard behavior survives.

**Acceptance evidence:** UI tests on row-specific controls, Insert after semantics, reorder boundaries and new/edit/pending/affordable/short-budget states; browser test of quoted Standard low budget shows warning before click, creates the line without fleet, and still allows Deploy recovery. A normal affordable route still runs after Save; Creative with a nominal quote does not trigger the Standard shortage warning.

## Task 3 — Compact Lines cards without deleting service operations

1. Make the colored chip show route.name, with a pencil-activated edit input. Reuse the existing routeNameDrafts commit-on-blur/Enter/Escape logic, preserving one rename dispatch.
2. Show current status, the live/estimated Every X min interval, one target input, the assigned fleet, Daily cost and no-fleet explanation. Eliminate duplicated Target label/value. Use a single Add/Retire stepper and preserve nextVehicleCost/canRetireVehicle/pendingServiceActions gates (the plus/minus visually hide or disable unsupported actions rather than implying authorization).
3. Restyle Edit, Pause/Resume and two-step Delete with accessible icon controls, keeping their existing callbacks/test IDs. Preserve route color swatches, leg warnings, wait-location diagnostics, manual deployment and selected-card scrolling.
4. Ensure the newly saved line selected by createGameRuntime shows actual fleet/target/cost rather than a pre-save pseudo-summary.

**Acceptance evidence:** Updated LinesPanel UI tests cover rename commit/escape, status, a usable live target, disabled Add/Retire gates, pending-click deduplication, no-fleet reason and manual Deploy. MCP browser E2E follows create → save → selected line → add/retire (where allowed) → edit/pause/delete without needing a new page.

## Task 4 — Inspect title, close, queue and vacant zone

1. Add a small controller action to clear the selected tile/node/vehicle only; wire it through App to InspectPanel Close. Keep route selection, map camera and service action state intact. Do not turn the popover into a modal.
2. Present inspector.nodeLabel/buildingLabel/vehicleLabel as the header. Remove old 07 numbered headings. Render one queue bar from platform occupancy/total capacity for transit nodes while keeping the existing exact queue text, platform rows, route chips and vehicle/workplace details.
3. Reuse placeInspectorPopover with a CSS arrow/pointer, adding only the minimal side hint needed to point toward the selected tile; retain off-screen hiding and clamping.
4. In buildInspector, after existing node/building lookup fails, project a zoned empty tile into a new narrow zone variant with readable zone name and general service/growth explanation. Avoid claiming exact stop reach unless the existing state already gives a trustworthy answer. Leave unzoned empty tiles invisible.
5. Keep clicking serving routes in Inspect opening their existing Lines controls.

**Acceptance evidence:** UI/selector unit tests for queue ratios, close, generic zone hint, no blank popup, edge flip and offscreen hide. MCP browser clicks a stop, a building, a zoned vacant tile and a blank tile; verifies the correct popover state and dismiss. Route chip opens Lines and selected line persists.

## Task 5 — Data/City visual cleanup and active-city rename

1. Replace old section-number headings with neutral readable titles, consistent Sunny Diorama cards and spacing. Pull overlay meaning text straight from OVERLAY_CATALOG; do not create a second legend.
2. Keep metric-button links Late→Traffic, Unserved→Coverage and Avg Wait→Crowding. Active state remains visible; selecting an active overlay tile can still clear it.
3. In CityPanel add a pencil-activated inline editor for the active city (reuse onRename and busy state), keep save status and Save button adjacent to the name; preserve dirty/unsaved navigation restrictions, Retry city list and overview. Avoid touching CityList row markup/styling because HPA-978 owns shared rows.
4. Check keyboard navigation, aria labels and dock scrolling at 1440×900 and 1280×720.

**Acceptance evidence:** Updated CityPanel tests for Enter, blur and Escape rename and Save; DataPanel tests for overlay meaning, metric links and toggles. MCP E2E verifies city renaming and overlay navigation, including screenshot checks for Data/City.

## Task 6 — Keep map scale and cursor tile stable across dock changes

1. Implement one pure resize-rebase helper in boardTransform.ts. Inputs: old and new positive stage CSS sizes, map size, camera (possibly Fit/null), last pointer stage-local anchor when inside both stage rectangles, else old/new visible center. Compute the old absolute pixel scale using getBoardTransform and recover the world point at the anchor.
2. Compute the camera zoom relative to the *new* fit scale, adjust center to keep the world point at the same local CSS coordinate, then clamp against map bounds. Permit non-null rebased camera.zoom below 1 after expansion; explicit Fit still resets to null. Update the helper that currently turns every zoom <=1 into null so resize-preserved views do not silently become Fit. Keep normal zoom/pan/fit button behavior.
3. In createGameHost.ts observe positive size changes exactly once, rebase before rendering and before computing the new click mapping, and avoid change-notification loops. Do not rebase initial mount/new-city view or non-layout simulation ticks. Make host's drawn-frame pick transform invalidate/update after resize so the visible geometry and action target agree. App.svelte should not implement a second camera adjustment.
4. Verify the same resize path for a normal WebGPU browser and the existing Canvas2D fallback if an already-running focused fallback test is available; no renderer fork or duplicate camera logic.

**Acceptance evidence:** Pure tests for old/new viewport scale, fitted null view, zoomed view, below-one retained zoom on expansion, no-op equal size, explicit Fit, anchored interior point, edge clamping and first mount. Playwright MCP geometry E2E at 1440×900 (also 1280×720 if needed) positions a pointer over an interior tile at Fit and zoomed levels, toggles Build/Lines/Data/City and closes them, and asserts (a) displayed CSS tile size remains within small pixel tolerance, (b) world tile beneath the fixed cursor is unchanged, (c) map hit/hover matches actual drawing, and (d) pressing Fit *does* use the current reduced stage. Include clicking a non-stop route stroke that opens Lines. Do not require an impossible fixed anchor after it has moved under the dock.

## Task 7 — MCP end-to-end visual and CI gate

Implement and verify all changes on **this branch/PR**; no future separate code PR.

| Area | MCP / automated end-to-end acceptance |
| --- | --- |
| Draft | Browser builds two stops and a valid bus line; Standard budget reduced below quoted fleet price → warning and Save without fleet visible before click; after click line exists, no fleet, expected warning not duplicated as a surprise toast; manually deploy after replenishing budget. Affordable and Creative cases preserve Save & run. |
| Lines | Saved line is selected; name pencil, target, status, fleet stepper, Edit, Pause/Resume and two-click Delete work with the Rust authorization gates. |
| Inspect | Stop/station queue with bar, vehicle/building content, vacant zone hint, close/reopen, route chip to Lines, no empty-land ghost inspector. |
| Data / City | Overlay tiles and linked metrics select real overlays; city Rename/Save respects existing busy/dirty behavior. |
| Camera | Dock open/close/switch at Fit and zoomed views, including map-line-triggered Lines, do not change tile scale or tile under in-stage pointer; explicit Fit is the only recenter/resize intent. |
| Visual | Capture Playwright screenshots via MCP at **1440×900** for RouteEditor normal/low-money, Lines, Inspect, zoned popover, Data and City. Compare against the Linear attachments and HTML mockup; retain screenshot evidence and inspect for card overlap, typography, arrow positioning and button readability. At **1280×720**, verify dock content is scrollable and no control is clipped or overlaying the map. |

Run focused **Vitest UI/runtime/camera** while coding, then **bun run check**, **bun run format:check**, **bun run lint**, **bun run test:unit**, and focused **bun run test:e2e -- --project=chromium** (or the equivalent Playwright invocation). Confirm full required GitHub CI checks pass; record the actual MCP E2E and visual evidence in this PR. No native acceptance run is required for a shared, non-native-specific change. If a backend/Rust change becomes unavoidable despite the current design, add a real browser-MCP end-to-end scenario for that change in the same PR; do not treat a unit test as its substitute.

## Risks / decisions not to expand

- A nominal fleet quote is not an operating-cost forecast. Display actual cost on the selected saved line; do not duplicate the service calculation in TypeScript or add another preview API merely to fill a decorative number.
- In Creative, nominal prices are informational; Standard-mode budget warning does not block create or bypass Rust authorization.
- Rebased zoom below 1 is allowed only as part of preserving a view, so a CSS dock resize cannot silently force Fit. Maintain one viewport source of truth.
- Vacant zone reach wording remains generic if no existing exact reach data is exposed; avoid new Rust routing/coverage logic.
- Art creation is a *different* ticket (HPA-979), and menu/marker styling is HPA-978; do not fold either into this PR.

## Definition of done

HPA-977 is complete when its Svelte panels are functional and visually consistent with the referenced mockups, the low-money warning occurs *before* saving, the player can still recover/deploy a saved no-fleet route, dock transitions keep the view stable, all targeted UI/runtime/MCP E2E and screenshot checks succeed, and GitHub CI is green **on the single HPA-977 PR**. No human approval step is an acceptance criterion.
