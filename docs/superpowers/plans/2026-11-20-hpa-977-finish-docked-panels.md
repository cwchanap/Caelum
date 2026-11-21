# HPA-977 — Finish the docked panels — Implementation plan

**Spec:** [2026-11-20-hpa-977-finish-docked-panels-design.md](../specs/2026-11-20-hpa-977-finish-docked-panels-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-977/finish-the-docked-panels-from-the-revamp  
**Baseline:** main @ d143036ecc08907c6c8ba9a26a1c74aa09bcb8ce, 2026-11-20  
**Delivery:** **Exactly one HPA-977 PR.** This initial draft commits docs only; commit all code, tests and screenshot evidence to **this PR/branch** before marking ready. Do not open an implementation PR. No new art/SFX.

## What is already present

- The HPA-696 dock structure lives in App.svelte, CommandPanel.svelte and styles.css. Do not rebuild it.
- RouteEditor.svelte already has selection, undo/redo, pattern and Save callbacks. The current-generation Rust initial-fleet nominal cost is available at RouteEditorView.initialFleetCost; its count is thrown away in preview.rs. Extend that **existing** Rust result to provide fleet count, default headway and estimated daily cost, while Standard/Creative and budget remain UI-visible.
- saveRouteDraft in createGameRuntime.ts already keeps create → attempt initial deployment ordered, reports late insufficient-budget feedback, and selects the newly created line. LinesPanel's selected card already shows the *actual* assigned fleet, target headway and operating cost.
- LinesPanel already has route rename, headway update, Rust-priced Add, allowed Retire, Deploy, Pause/Resume, delete confirmation, wait-location focus and action pending guards.
- Selecting an empty tile records ui.selectedId, so a zoned-land popover needs only a selector case, not another pointer pipeline.
- DataPanel already uses the overlay catalog and linked metrics. CityPanel already receives the active city, persistence state, city rename callback and shared CityList.
- createGameHost.ts and boardTransform.ts are now shared across WebGPU and Canvas2D (HPA-1144): change view-resize behavior once, here.

## Implementation ownership / smallest change map

| Focus | Primary files | Guardrails |
| --- | --- | --- |
| Route editor and fleet preview | crates/caelum-core/src/preview.rs + preview response struct/tests, src/runtime/backend/types.ts and shared.ts, src/runtime/runtimeSelectors.ts, src/runtime/types.ts, RouteEditor.svelte, LinesPanel.svelte, createGameRuntime.ts | One replacement preview field, no new API; preserve authoritative Rust purchase and token safety |
| Saved line cards | src/components/hud/panels/LinesPanel.svelte, src/components/city/InlineNameEditor.svelte (new small shared editor), src/styles.css | Reuse existing callbacks/guard fields; preserve selected-card scroll and diagnostics |
| Inspect popover / zone | src/runtime/runtimeSelectors.ts, src/runtime/types.ts, src/runtime/createGameRuntime.ts, src/ui/actions.ts only if necessary, InspectPanel.svelte, src/render/inspectorPlacement.ts, src/App.svelte | Selected tile is already present; no DOM click coordinate, no Rust coverage work |
| Data and City | DataPanel.svelte, CityPanel.svelte, CityList.svelte (active-row read-only prop only), InlineNameEditor.svelte, src/styles.css | Reuse overlayCatalog; active-city header owns rename; no shared-list visual restyle |
| Camera | src/render/boardTransform.ts, src/runtime/createGameHost.ts | One shared transform for visual render, labels, picker and both renderers |
| Tests / screenshots | focused tests/ui and tests/runtime, existing boardTransform tests and FakeResizeObserver in tests/render/webGpuHost.test.ts, tests/e2e/routes.spec.ts, commandShelf.spec.ts, mapInspection.spec.ts | **Commit** low-budget and geometry Playwright tests for CI; execute through MCP for E2E acceptance and screenshot comparison |

This is a change map, not a mandate to edit every listed file. Avoid new libraries/components unless repeating markup becomes demonstrably worse.

## Task 1 — Fix passive dock resize without moving the map (highest risk)

**Decision:** The original HPA-977 acceptance requires no map jump even at default Fit. The review's suggested simple rebase + normal `clampCamera` fails this requirement on letterboxed Fit; it is *not* enough to loosen the test. Make **passive layout** preserve the same rendered CSS scale and offsets, while intentional Fit continues to recenter into the available viewport.

1. Write **one failing focused test** on the existing transform helpers and a failing geometry assertion in `tests/e2e/commandShelf.spec.ts`; then implement and re-run immediately (red/green). Do not write a giant matrix of failures up front.
2. In `boardTransform.ts`, implement a pure `rebaseCameraForResize(oldBoard, newBoard, map, camera)` using the old `getBoardTransform` scale and **offsetX/offsetY**. Derive zoom relative to the new `fitScale` and center from the new safe midpoint. **No pointer anchor, pointer state or fallback.** Represent a passive retained camera with a tiny flag/variant that skips ordinary recentering/clamping *only when projecting that retained view*. This is necessary for letterboxed Fit and possible zoom below 1 on stage expansion; leave the existing user-directed clamp policy intact. Collapse back to `null` only if the **whole** new transform equals canonical Fit.
3. Ensure user-requested pan/zoom transitions from any retained sub-Fit view remain sensible (Zoom Out must not enlarge the map). Explicit Fit resets to `null`; it *intentionally* resizes/recenters into the current stage.
4. In shared `createGameHost.ts`, apply rebase once for a positive size change using the old rendered board dimensions in **both** the ResizeObserver path and window-resize fallback. Exclude first mount, equal-size events and fresh city/reset. Render and hit-test with the same new transform without an observer/publication loop; no App renderer-specific or Canvas2D fork.
5. **Replace**, do not duplicate, `commandShelf.spec.ts:71`'s HPA-696 `expectMapFitsCanvas("dock open")` assertion with map-stability checks using existing `runtimeSnapshot`, `mapTileViewportPoint`, `mapWorldViewportPoint` and `hoverMapTile` helpers. Retain explicit Fit and rightmost-clickability tests but invoke Fit before asking that the whole map fits the docked stage.

**Focused acceptance:** Three pure camera tests: (a) zoomed open/close preserves scale and viewport offsets; (b) default Fit → dock open → close preserves every still-visible map point and eventually coalesces to `null` when the original canonical Fit is restored; (c) press Fit *inside* a dock then close: preserves that smaller absolute scale/margins rather than sliding the map. One `FakeResizeObserver` host test covers no rebase on first mount or unchanged size; run existing fallback path test. **Committed Playwright E2E executed through MCP** verifies unchanged tile under in-stage cursor at Fit and zoomed levels for open/close/switch/route-path click → Lines, correct picking, and intentional Fit behaviour. Run at 1440×900; use a second narrow screenshot where useful. No human acceptance step.

## Task 2 — Complete route drafting and the before-save fleet warning

1. Extend the **existing** Rust route preview from `initial_fleet_cost: Option<i32>` to `initial_fleet: Option<InitialFleetPreview { vehicles, target_headway_seconds, cost, estimated_daily_operating_cost }>`. In `preview.rs` reuse `initial_fleet`'s already-computed required count and `operating_cost::estimated_line_daily_operating_cost(mode, 0, Some(vehicles))`; wire the struct through the existing WASM/Tauri serde response, `src/runtime/backend/types.ts`, one `backend/shared.ts` normalizer and `RouteEditorView`. No new preview endpoint, TS pricing math or persistence migration; update Rust/TS fixture tests in this PR.
2. Restyle Loop/Shuttle as an accessible segmented control, replace the waypoint's single button with a selectable row plus per-row move/remove controls, and combine Append/Replace/Insert after/Reverse/Undo/Redo into a single toolbar that wraps in a narrow dock. Use existing selection + move/remove callbacks, no second draft state.
3. Render **After saving** for **new drafts only**, using the Rust preview for Fleet, Target and estimated Running cost. When a Standard shortage is already known, show **None yet / target / $0/day**, matching `t2-route-editor-low-money.png`; affordable/Creative drafts show expected fleet, target and *nominal* projected daily cost. Hide After saving for edits, because current metrics would falsely look like an edit forecast. Actual values live in the selected Lines card after Save.
4. Export one pure `initialFleetShortfall(state, quotedCost)` predicate (**Standard only, budget < cost**) reused by `selectRouteEditorView` and at Save click. Show an inline reason and **Save without fleet** before a known shortage. Save still creates the line then attempts Rust fleet deployment. A Save-invocation-local boolean suppresses only the expected duplicate insufficient-budget toast by restoring prior feedback in its existing rejection branch; a shortage that occurs *after* click still emits the fallback toast. No new persistent capture state, affordability gate or backend command.
5. Ensure missing quote remains Save & run, edit stays Save route, rejected drafts keep current gates, and Save/Cancel/Reload/Undo/Redo keyboard behavior survives.

**Acceptance evidence:** Rust preview test asserts first-fleet count, cost, default target and estimated daily cost match actual service formula. Focused UI tests cover per-row controls, Insert after/reorder and preview-generation gates, and Standard/Creative shortfall. **Commit a Playwright E2E in `tests/e2e/routes.spec.ts`**: set Standard budget below quote, see warning **before** click, save real line with no fleet and no redundant toast, replenish budget and deploy; affordable + Creative Save & run still operate. Execute it through MCP and in CI. Test an unanticipated late shortage keeps the fallback toast.

## Task 3 — Compact Lines cards without deleting service operations

1. Show `route.name` in the colored chip with a pencil activated **`InlineNameEditor.svelte`** shared with the City header. Props: value, label, disabled, onCommit; focus upon activation, trim nonempty names, commit once on Enter/blur, Escape restores and stops propagation. Migrate the persistent Lines name input into this one component; leave CityList's pre-existing editor in place for HPA-978. Add one component test for keyboard/commit behaviour and panel wiring tests; avoid four copies of handlers.
2. Show current status, the live/estimated Every X min interval, one target input, the assigned fleet, Daily cost and no-fleet explanation. Eliminate duplicated Target label/value. Use a single Add/Retire stepper and preserve nextVehicleCost/canRetireVehicle/pendingServiceActions gates (the plus/minus visually hide or disable unsupported actions rather than implying authorization).
3. Restyle Edit, Pause/Resume and two-step Delete with accessible icon controls, keeping their existing callbacks/test IDs. Preserve route color swatches, leg warnings, wait-location diagnostics, manual deployment and selected-card scrolling.
4. Ensure the newly saved line selected by createGameRuntime shows actual fleet/target/cost rather than a pre-save pseudo-summary.

**Acceptance evidence:** Updated LinesPanel UI tests cover rename commit/escape, status, live target, disabled Add/Retire gates, pending-click deduplication, no-fleet reason and manual Deploy. Reuse/extend `tests/e2e/routes.spec.ts` for create → saved selected line → add/retire (when allowed) → edit/pause/delete; run via MCP and CI, no new page/test harness.

## Task 4 — Inspect title, close, queue and vacant zone

1. Add the small `clearSelection` controller action for selected tile/node/vehicle only, wire App to InspectPanel Close, and call it from **the final `handleEscape` branch** after drag/draft/dock/tool handling. Keep route selection, camera, current service controls and gameplay intact; do not turn the popover into a modal.
2. Present inspector.nodeLabel/buildingLabel/vehicleLabel as the header. Remove old 07 numbered headings. Render one queue bar from platform occupancy/total capacity for transit nodes while keeping the existing exact queue text, platform rows, route chips and vehicle/workplace details.
3. Reuse placeInspectorPopover with a CSS arrow/pointer, adding only the minimal side hint needed to point toward the selected tile; retain off-screen hiding and clamping.
4. In `buildInspector`, after the existing node/building lookup fails, project a zoned empty tile into a narrow zone variant. Compute **near a running stop/station** using existing `stopCoverageRadius` and `METRO_STATION_COVERAGE_RADIUS`, present nodes and a route whose existing `routeServiceStatus(...).primary === "running"`, within Chebyshev radius. Call it a proximity hint, **not a guarantee of growth** (Rust active-services and building footprint checks still govern outcomes). No Rust coverage rewrite. Unzoned/occupied tiles do not get phantom popovers.
5. Keep clicking serving routes in Inspect opening their existing Lines controls.

**Acceptance evidence:** UI/selector tests for queue ratios, close/Escape precedence, near/far running stop hints, empty/occupied tiles, edge flip and offscreen hide. Extend existing `tests/e2e/mapInspection.spec.ts` for stop/building/zoned/blank click + dismiss and route-chip → Lines. Execute via MCP and CI; no new pointer pipeline.

## Task 5 — Data/City visual cleanup and active-city rename

1. Replace old section-number headings with neutral readable titles, consistent Sunny Diorama cards and spacing. Pull overlay meaning text straight from OVERLAY_CATALOG; do not create a second legend.
2. Keep metric-button links Late→Traffic, Unserved→Coverage and Avg Wait→Crowding. Active state remains visible; selecting an active overlay tile can still clear it.
3. In CityPanel reuse the same small `InlineNameEditor` for the header pencil, keep Save/status adjacent and preserve onRename, busy/dirty, Retry city list and overview. **Mockup checked:** `t2-city-panel.png` shows a single header rename; the active row in Your cities is a read-only **Playing** row. Add one optional `CityList` prop for this dock-only active-row behavior (no active-row rename or Delete); leave shared row **styling** and City Library behavior to HPA-978.
4. Check keyboard navigation, aria labels and dock scrolling at 1440×900 and 1280×720.

**Acceptance evidence:** Updated CityPanel/InlineNameEditor tests for Enter/blur/Escape, active-row Playing and Save; update existing `tests/e2e/commandShelf.spec.ts` metric → overlay assertions (no need for a new DataPanel test file). Run city-rename and overlay navigation through MCP and CI; compare Data/City screenshots.

## Task 6 — Committed E2E, MCP visual checks and CI gate

Implement and verify all changes on **this branch/PR**; no future separate code PR.

| Area | MCP / automated end-to-end acceptance |
| --- | --- |
| Draft | Browser builds two stops and a valid bus line; Standard budget reduced below quoted fleet price → warning and Save without fleet visible before click; after click line exists, no fleet, expected warning not duplicated as a surprise toast; manually deploy after replenishing budget. Affordable and Creative cases preserve Save & run. |
| Lines | Saved line is selected; name pencil, target, status, fleet stepper, Edit, Pause/Resume and two-click Delete work with the Rust authorization gates. |
| Inspect | Stop/station queue with bar, vehicle/building content, vacant zone hint, close/reopen, route chip to Lines, no empty-land ghost inspector. |
| Data / City | Overlay tiles and linked metrics select real overlays; city Rename/Save respects existing busy/dirty behavior. |
| Camera | Dock open/close/switch at Fit and zoomed views, including map-line-triggered Lines, preserve CSS tile scale and absolute map offsets for still-visible points; temporary clipping/letterboxing is allowed; **only intentional Fit** reframes the map. |
| Visual | Capture Playwright screenshots via MCP at **1440×900** for RouteEditor normal/low-money, Lines, Inspect, zoned popover, Data and City. Compare against the Linear attachments and HTML mockup; retain screenshot evidence and inspect for card overlap, typography, arrow positioning and button readability. At **1280×720**, verify dock content is scrollable and no control is clipped or overlaying the map. |

**Every task uses red/green on that task's existing tests before proceeding**; commit each cohesive task separately **within this same PR**, not as separate PRs. Keep the low-money and dock geometry regressions as committed Playwright specs so GitHub CI gates them; **execute the browser E2E acceptance through MCP** and use MCP screenshots against Linear images for visual verification. Then run focused Vitest and `bun run rust:test`, `bun run check`, `bun run format:check`, `bun run lint`, `bun run test:unit`, focused `bun run test:e2e -- --project=chromium` (or equivalent), and required GitHub CI. One browser target suffices; no native acceptance unless platform-specific code is changed. The small Rust preview DTO change **must** have end-to-end proof through the real WASM browser gameplay flow, not only Rust unit tests. No human acceptance step.

## Risks / decisions not to expand

- New initial-fleet preview estimates **do** include Rust-derived fleet size, default target and nominal daily cost. Display them as projections, not guarantees; after Save the selected card shows actual values. Do not add a second API or TS service formula.
- In Creative, nominal prices are informational; Standard-mode budget warning does not block create or bypass Rust authorization.
- The passive retained camera can carry a below-Fit relative zoom or letterboxed offset solely to prevent silent dock-induced movement. Ordinary user pan/zoom clamping remains deliberate; Fit always re-centers into the available dock-adjusted stage.
- Vacant zone reach uses existing TS coverage radii and running-line status, worded as proximity only; do not duplicate Rust's growth/active-service calculations.
- Art creation is a *different* ticket (HPA-979), and menu/marker styling is HPA-978; do not fold either into this PR.

## Definition of done

HPA-977 is complete when its Svelte panels are functional and visually consistent with the referenced mockups, the low-money warning occurs *before* saving, the player can still recover/deploy a saved no-fleet route, dock transitions keep the view stable, all targeted UI/runtime/MCP E2E and screenshot checks succeed, and GitHub CI is green **on the single HPA-977 PR**. No human approval step is an acceptance criterion.
