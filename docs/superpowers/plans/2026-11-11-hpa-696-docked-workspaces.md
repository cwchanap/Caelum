# HPA-696 — Dock panels on the right — Implementation plan

**Spec:** [2026-11-11-hpa-696-docked-workspaces-design.md](../specs/2026-11-11-hpa-696-docked-workspaces-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-696/dock-the-panels-on-the-right  
**Baseline:** main @ 0168a57d59387286fea0fae8c97495b97efc9a5a  
**Delivery:** **One PR for HPA-696, including implementation and tests.** This initial draft contains design/plan only. Do not create another PR for code. Do not combine HPA-677, and do not generate new art.

## Change ownership

| Responsibility | Primary change paths | Keep intact |
| --- | --- | --- |
| Active-city shell and stage | `src/App.svelte`, `src/styles.css`, `src/components/hud/CommandPanel.svelte`, `CommandShelf.svelte` | Runtime destination, draft gate, keyboard focus; no new viewport state |
| Map Fit/resize | Existing `GameCanvas.svelte`, `boardTransform.ts`, `createWebGpuHost.ts` (normally no changes) | One measured canvas for GPU, hit-testing and map labels; no camera rewrite |
| Inspector placement | `App.svelte`, `InspectPanel.svelte`, small pure placement helper, `styles.css` | `ui.selectedId`, shared transform, same stop/vehicle/building actions; no click callback |
| Build catalogue, shortcuts and visuals | `BuildPanel.svelte`, `src/domain/catalog/buildGroups.ts`, `src/ui/shortcuts.ts`, existing `CommandPlateGrid.svelte`, `sunny-diorama/build-categories/`, `build-items/`; delete `src/assets/command-plates/` | `BUILD_GROUPS` stays keyboard-agnostic; `BUILDING_CATALOG`, cursor previews, focus and real build selection |
| Saved-route selection and editor | `src/runtime/createGameRuntime.ts`, `LinesPanel.svelte`, `RouteEditor.svelte` | Existing save/deploy token guarantees, source/edit distinction, price and service data |
| Other panels and cleanup | `DataPanel.svelte`, `CityPanel.svelte`, `src/styles.css`, `src/assets/sunny-diorama/README.md` | Existing content, busy gates, overlays; remove stale centred-panel CSS/docs |
| Regression proof | `tests/e2e/routes.spec.ts`, `commandShelf.spec.ts`, `topbarViewport.spec.ts`, `mapInspection.spec.ts`; focused `tests/ui/` and `tests/runtime/` | Real browser layout/viewport checks plus important UI/runtime invariants |

Edit only when needed; this table is a change map, not a requirement to touch every file.

## Task 1 — Make one dock and keep all map tiles clickable

**Update the existing bug-reproducing E2E first (red→green):** In `tests/e2e/routes.spec.ts:366–445`, the test `proves route drafting can reach a stop beneath the Lines panel` already builds a Small city and a stop at `{x:21,y:5}`, but closes Lines to click the covered stop before reopening it. **Remove the Close/Reopen workaround and the now-obsolete `insidePanel` / covered-versus-exposed / `elementFromPoint` assertions**; click `OCCLUSION_COVERED_STOP` directly with Lines still open and assert its waypoint is added. Check canvas/dock non-overlap separately in the existing geometry E2E. Verify that edited test fails on main and passes with the dock; do **not** create a duplicate scenario. Keep other bottom-row edge clicks in manual UAT.

1. In `App.svelte`, group the board/MapTextOverlay, zoom controls, ActionFeedback, Inspect and CommandShelf in a relative **game-stage**; add a conditional **workspace-dock** sibling containing the existing CommandPanel. Keep Topbar in a full-width absolute top band across both columns. Do not add another layout store.
2. In `styles.css`, make game-workspace one column when closed and `minmax(0, 1fr)` plus a ~360–400px right column when open (clamped for 1024px), with `min-width:0` on the stage. Set **`.workspace-dock { top: calc(var(--hud-top) + 12px); bottom: 12px; }`**, not a bottom offset based on `HUD_INSET.bottom`: the shelf/zoom live solely in column 1 and should not waste the bottom 88px of dock scroll space. Replace centred absolute panel offsets with the dock-contained scroll region. Remove `CommandPanel.pinned`, `.command-panel--pinned`, the `.command-panel-overlay` wrapper and its dead tests, and the 1143px `.overlay-legend` workaround. Switch `.command-panel__body`, `.action-feedback` and `.command-shelf` away from `100vw/100vh` sizing to stage/dock-relative `100%` limits.
3. Put `container-type: inline-size` on game-stage and compact the shelf via an **@container** rule based on real stage width, not a dock-open class. Preserve all Build/Lines/Data/City/Select/Demolish buttons, accessible labels, focus and keyboard shortcuts. Keep bottom zoom controls usable at 1024px; Topbar and feedback remain readable.
4. Keep board and map text inside the same game-stage. Their existing ResizeObserver and shared `getBoardTransform` already take the measured canvas width; simply verify open/close triggers correct Fit, hit-testing and hover alignment. Do **not** add `HUD_INSET.right`, a camera remount or separate viewport transform. Preserve zoomed view and existing camera clamping.
5. Keep the destination close/Escape focus behavior in App; a route draft still pins Lines until Save/Cancel.

**Proof:** UI test for stage/dock presence, focus and draft gate; **Playwright**, not jsdom, for geometry. At **1024px and 1440px**, open Build and assert canvas.right <= dock.left, Fit draws the entire map inside canvas, and the right-most column responds to a tile click. Close dock and assert full-width canvas returns. Verify the **updated existing route-occlusion E2E** and at least one pan/zoom/cursor position.

## Task 2 — Project the selected tile into a bounded Inspect popover

1. **Do not add a GameCanvas click callback or local anchor state.** The runtime already sets `ui.selectedId` for stop, vehicle and building selections, and `focusWaitLocation` sets it for programmatic navigation. Parse with exported `parseSelectedPoint` from `runtimeSelectors.ts`; project its tile center with `getBoardTransform` using the actual stage width/height, map and camera.
2. Measure stage and popover with Svelte `bind:clientWidth`/`bind:clientHeight`, without adding a separate observer. Add a small pure `placeInspectorPopover` helper: **return `null` (hide) if the selected-tile anchor is outside the visible stage map area**, accounting for horizontal padding and top/bottom HUD safe bands. When the tile is visible, place next to it, flip horizontally/vertically when space is tight, and nudge the *card* into the safe area; never clamp an off-screen anchor into a pinned edge card. Skip invalid/zero-size measurements.
3. Keep the inspector stage-local and hidden whenever a dock destination is open. Through pan, zoom and Fit it follows its **selected tile** (like MapTextOverlay); for vehicles it stays at the original **clicked tile** rather than following the moving vehicle. A wait-location jump projects the node tile automatically. Keep current panel actions, dismiss behavior and test IDs.

**Proof:** focused placement-helper test for normal, right-edge, bottom-edge, **off-screen hide/reappear after camera movement**, and zero-size cases; existing Inspect UI and map E2E cover stop, building, vehicle and service-control navigation. No fallback or clearing-state test is required.

## Task 3 — Reuse the art; supply Build prices, descriptions and one shortcut table

1. Keep `CommandPlateGrid.svelte` and its tested 2×2 arrow-key navigation. Change only the four category image imports in BuildPanel from `src/assets/command-plates` to `sunny-diorama/build-categories`; verify `object-fit: cover !important` against art at narrow width. Delete the old command-plates folder and remove stale usage in `sunny-diorama/README.md` in **the same implementation change**.
2. Add a short `description` and `cost: { amount, unit: "each" | "perTile" } | "free"` to `BuildMenuItem` in the **existing** `src/domain/catalog/buildGroups.ts`; no new catalogue. Fill building prices using `BUILDING_CATALOG`, including bus stop/metro station. Use explicit nominal non-building hints tied to current core rules: $100/road tile, dual road up to $200/stroke tile when both lanes need building, $500/track tile, $1,000 compact/$2,000 standard roundabout and Free zone paint. This is a UI hint only; cursor preview and Rust remain authoritative for actual costs, partial replacements and Creative mode.
3. Build item cards render this catalogue metadata and the known item footprint (use `getRotatedFootprintSize` for buildings). Load the 26 existing Build thumbnails through one **eager `import.meta.glob`** keyed by filename/id. Add a focused catalogue↔asset coverage test; no 26 manual imports, asset registry or fallback copy.
4. Implement pure `buildGroupShortcuts(group: BuildMenuGroup)` in **`src/ui/shortcuts.ts`** (importing only the domain catalogue type) to map the first nine visible items to 1–9. **Both** the card badges and App.svelte's **existing** `handleWindowKeydown` use it; do not add a second key listener. Keep `src/domain/catalog/buildGroups.ts` as keyboard-agnostic item data. Build destination + active leaf group takes priority over road preset keys; when a leaf group is not open, keep current global 1/2/3 road presets. `0` remains Fit. Ignore modifiers, text fields and active route drafts. Pin the Roads group 1/2/3 parity with `ROAD_PRESET_KEYS` in a test.
5. Move current Rotate and the active-item explanation into the dock footer without introducing new gameplay state or arithmetic for actual placement cost. **Preserve focus across the Build category drilldown**: focus the Back button or first item when a group mounts, then restore focus to the previously activated category plate when Back returns to the grid. A small BuildPanel-local previous-group reference is enough. **Escape already closes the entire Build panel** (`createGameRuntime.ts:handleEscape`); keep that behavior and return focus to the Build trigger in CommandShelf instead of treating Escape as Back.

**Proof:** focused `tests/runtime/buildGroups.test.ts` for descriptions/prices (and drift checks against catalog/core invariants), `tests/ui/buildPanel.test.ts` for category and item cards, image coverage and shortcuts. Test focus entering a leaf group, Back returning to its category plate, and Escape closing the dock and returning to the CommandShelf trigger. Existing cursor-preview/build interactions stay green.

## Task 4 — Route rail, existing service card and accepted-create selection

1. In RouteEditor, restyle waypoint list as numbered dots on a vertical rail. Feed selected route colour from `ShellRouteListItem` when editing (already selected by `startRouteEdit`); use neutral/accent for new drafts. Keep selected/missing states and clicking.
2. Group existing Append/Replace/Insert after, move/remove, Reverse, Undo and Redo controls into a compact toolbar. Preserve all event handlers, disable gates, loop/shuttle pattern, preview warnings/failures and reload-edit-conflict behavior. Keep existing saved-line name, colour, fleet, pause and delete actions within dock-width cards.
3. In `src/runtime/createGameRuntime.ts:saveRouteDraft`, reuse its existing pre-save ID set and detected post-save route ID in **one place**, instead of only looking up IDs inside `deployCreatedLine`. In the **accepted, token-current create** path, set `ui.selectedRouteId` to that newly created line when exactly one ID is found, whether or not an initial fleet is deployable. Keep superseded/rejected-save semantics untouched; let the deploy helper use the same new ID. Edits already have selectedRouteId.
4. Treat the **selected route's existing card** as the post-save summary. Highlight and scroll it into view **once upon selection change** (not on every tick), showing available `assignedFleet`, `targetHeadwaySeconds` and `dailyOperatingCost`. It updates naturally after any initial fleet deployment. No `recentlySavedRouteId`, duplicate App diff, special summary state, extra wire field or speculative price calculation.
5. Keep `Save & run · $X` exactly when `initialFleetCost` exists, `Save & run` when it does not, and `Save route` for edits, without changing preview/affordability gates.

**Proof:** one runtime test for an accepted create selecting its new line (including no initial deployment) and non-selection for rejection/superseded save where relevant; UI assertion that selected card exposes the real Fleet, Target and Daily cost. Existing route editor and service-control tests stay green.

## Task 5 — Move Data and City into the same visual system

1. Confirm DataPanel and CityPanel render inside the same dock without changing their runtime props. Adjust card/input spacing and truncation only as necessary; retain overlays, metrics, save/busy gates and city-list actions.
2. Audit z-index and pointer-events for Topbar, ActionFeedback, CommandShelf, Inspect, dock and bare map. Check a click near the right edge of an open dock, Escape/Close focus and route draft gating.
3. Remove stale centred-modal CSS/test assertions and update `sunny-diorama/README.md:10` in the implementation PR alongside the category art swap. Preserve screen-reader announcements and visible focus, without treating a non-modal dock as an aria-modal dialog.

**Proof:** existing Data/City tests, city E2E and keyboard-only open/close flow pass; no dead layout flags or old command plate references survive.

## Task 6 — Targeted verification and one-pass UAT

Test *as each task lands*, not only at the end. **Modify the existing `routes.spec.ts` occlusion E2E first (red→green)**; each change is implemented and verified on **this same PR**.

1. Run focused Vitest for new popover placement, Build catalogue/shortcuts, runtime route selection and touched panel tests while implementing; add no mirrored test matrix for internal branches.
2. Run focused Playwright for **the existing `routes.spec.ts` formerly covered stop** (with Lines still open), **dock/canvas geometry and Fit/right-edge click at 1024 and 1440**, and **topbar + shelf overlap/clipping**. Extend `tests/e2e/topbarViewport.spec.ts` instead of creating another viewport harness.
3. Run `bun run check`, `bun run format:check`, `bun run lint:svelte`, `bun run lint:css`, `bun run test:unit` and `bun run test:e2e` before marking ready. Use normal WASM prerequisite; production Rust changes are not expected.
4. Manual browser UAT at **1440×900** and **1024×768/900**, Small 28×18 and Medium 56×36: dock open/closed Fit, pan/zoom and tile edges, Build art/card costs/keys/Rotate, selected-tile Inspect (including vehicle movement), route draft/reload/save/service, Data and City operations. No screenshot goldens.
5. Repair failures on this same branch; update design only if behavior choices change. No separate implementation or cleanup PR.

## Risks and mitigations

1. **Shelf at ~624–664px stage width:** container-query compaction may still clip; guard with 1024px Playwright button visibility and dock-overlap assertions, not jsdom-only layout checks.
2. **Build 1/2/3 precedence:** global road presets can conflict after switching groups; use exactly one `buildGroupShortcuts` table for both badges and handler, with precedence/parity tests.
3. **Old E2E hard-coded viewport clicks:** the shared `clickMapTile` helper already uses the canvas bounding box, but literal viewport coordinates may land inside the new dock. Audit affected tests during first red→green run and use existing map helpers instead.

## Exit criteria

- With a Lines draft open, formerly covered stops are clickable **without closing the dock** (proved by the updated existing E2E); confirm bottom-row clickability in manual UAT.
- Board width and GPU click mapping agree after dock open/close; Fit uses the true narrower stage with no hidden right edge, proved in Playwright.
- Build uses shipped category and item art, with CommandPlateGrid retained and old command-plates removed; item catalogue prices/descriptions and key precedence are explicit.
- Route editing and service management retain existing functionality and cost rules; accepted create selects its new route and the existing selected service card is the post-save summary.
- Data/City and anchored Inspect work in the new layout; Inspect hides when its tile leaves the stage map area; Build Back and Escape preserve expected focus. No Rust, WebGPU shader, WASM/Tauri wire, or persistence change was needed.
- The PR stays **draft** for review until implementation and tests have been committed to the same PR.
