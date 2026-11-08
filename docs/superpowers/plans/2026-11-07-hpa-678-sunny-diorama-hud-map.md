# HPA-678 — Sunny Diorama HUD and map — Implementation plan

**Spec:** [2026-11-07-hpa-678-sunny-diorama-hud-map-design.md](../specs/2026-11-07-hpa-678-sunny-diorama-hud-map-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-678/give-the-game-its-new-hud-and-map-look  
**Baseline:** `main` @ `70e0b78`  
**Delivery:** **One PR for HPA-678.** This draft starts as design/plan only; implementation and tests are committed onto the same branch/PR after review. HPA-676 remains a separate art-only task.

## Existing ownership and change map

| Responsibility | Primary files | Keep intact |
| --- | --- | --- |
| Visual tokens and fonts | `src/styles.css`, `index.html`, `package.json`, `bun.lock` | Existing component contracts; offline Tauri fonts |
| Active shell + top bar | `src/App.svelte`, `src/components/Topbar.svelte` | `RuntimeSnapshot` data, pause/speed actions, save ownership |
| Dock/feedback/zoom | `src/components/hud/CommandShelf.svelte`, `src/components/ActionFeedback.svelte`, `src/components/GameCanvas.svelte` | Keyboard/focus semantics, route-draft gate, live region |
| Camera + labels | `src/render/boardTransform.ts`; `App.svelte` shares its `HUD_INSET` constant with CSS | Existing GPU host, overlay and e2e helpers keep calling the shared transform; **no inset props/data plumbing** |
| Structural map | `src/render/colors.ts`, `src/render/webgpu/mapBatch.ts` | Current SolidGeometry and scene-cache lifecycle |
| Transit/vehicles | `src/render/webgpu/transitBatch.ts`, `vehicleInstances.ts`, `renderer.ts` | Existing route paths and single instanced vehicle pipeline |
| Tests | `tests/ui/appShell.test.ts`, `tests/ui/commandShelf.test.ts`, `tests/render/boardTransform.test.ts`, `tests/render/webGpuHost.test.ts`, `tests/render/webgpuMapBatch.test.ts`, `tests/render/webgpuTransitBatch.test.ts`, `tests/render/webgpuVehicleInstances.test.ts`, `tests/render/pickMapTarget.test.ts`, `tests/e2e/topbarViewport.spec.ts` plus one map edge-click e2e | Focus on player outcomes and deterministic invariants; no pixel goldens |

## Task 1 — Set the visual foundation without building a design framework

1. Add locally bundled Bricolage Grotesque and Inter through Bun (`@fontsource`), importing only weights used and keeping font files in the Vite/Tauri bundle. Change `index.html` title to `Caelum`. No external font CDN. There is **no JetBrains Mono dependency** to uninstall; remove its legacy `--font-mono` fallback and style UI numerals with Inter/tabular figures. Update the `CHAR_PX` metric comment in `MapTextOverlay.svelte` while keeping a conservative width estimate.
2. Define one **role-named** warm CSS palette: `--accent`, `--warning`, `--surface`, `--ink`, etc. Rename old colour-specific tokens (`--cyan`, `--amber`, `--magenta`, `--lime`, `--bg-deep`) and update **all** CSS and Svelte callers in the same change, with no old aliases. Sweep hard-coded old dark-console background/border tints from `styles.css`, `CommandShelf.svelte`, `CommandPanel.svelte`, `CommandPlateGrid.svelte` and touched HUD/panel component styles. Do not needlessly replace unrelated semantic route/overlay colours.
3. Add only **four** CSS-only primitives with actual HUD callers: button, card, chip, segmented control. No field/input primitive or reusable Svelte wrapper until HPA-696 really needs one.
4. Set the GPU palette direction **now**, before updating vertex-colour tests: warm light grass; muted **terracotta/coral residential lots and terracotta/slate house roofs**; distinct green park lots; darker-green tree canopies; separate office/commercial/industrial/civic colours. GPU literal `colors.ts` and DOM tokens stay intentionally separate; no theme provider.
5. Spot-check existing modal panels against the light tokens and hard-coded literal sweep. Their position/structure does not change until HPA-696.

**Proof:** panels are not dark-tinted islands on cream; typography is clear; the font loading assertion in Task 6 verifies actual local faces rather than relying on fallback.

## Task 2 — Float the HUD over the existing canvas (**implement atomically with Task 3**)

1. In `App.svelte`, make the active-city `GameCanvas` full-bleed. Import `HUD_INSET` from `boardTransform.ts` and set `--hud-top` / `--hud-bottom` inline, so CSS bands and camera use the **same constants**. Keep only HUD cards interactive (`pointer-events: auto`); transparent overlay containers must not swallow map clicks. Do not make a separate geometry observer.
2. Rebuild `Topbar.svelte` as three fixed-height clusters. Left: real city name and `busy`/`dirty` save state with the **existing** CityPanel labels “Working…”, “Unsaved changes”, “Saved”; at 1024px, ellipsize long names and expose their full title rather than wrapping. Centre: current pause/resume, day/time and 1×/2×/4× actions. Right: budget, daily cost, residents, average wait and a compact warning chip.
3. For the warning chip, add **one** view-only field `tripIssues: string | null` to `ShellTopbarState` and compute it from **numeric** `state.metrics.lateTrips`/`unservedTrips` in `runtimeSelectors.ts`. UI consumes that preformatted string; no `Number(shell.late)` parsing in Svelte and no new game/wire data. Do not restore the unused `networkSummary` topbar readout; keep it for `CityPanel`.
4. Reuse `CommandShelf.svelte` destination/tool handling but present Build, Lines, Data, City, Select and Demolish as a bottom-centre floating dock, retaining existing shortcuts, line count, pressed/expanded state, route-draft gate, focus and test hooks. In `GameCanvas.svelte`, make +/−/Fit a **horizontal** group in the **bottom safe band**, beside the dock (not vertically overlapping leftmost fitted tiles). Do not add left/right camera insets.
5. Reposition visible `ActionFeedback` as a small under-clock toast while preserving the **always-mounted** sr-only live region, details, dismiss action and route-draft suppression. Remove the old 72px feedback strip/scroll assumptions. Keep the current `CommandPanel` floating above the map; adjust only necessary offset/z-index, not docking or route editor behavior.
6. Land the matching `boardTransform.ts` change in **Task 3 in the same commit/change** as the full-window shell, so no intermediate commit leaves edge tiles hidden.

**Focused tests:** adapt `tests/ui/appShell.test.ts`, `tests/ui/commandShelf.test.ts` and `tests/ui/actionFeedback.test.ts` for city/save status, warning, keyboard/focus, toast and route-draft behavior. Update `tests/e2e/topbarViewport.spec.ts` for the three cluster groups and long money/city-name cases at 1024, 1280 and 1440px. Do not preserve assertions about the old console grid.

**Proof:** full-window shell and the inset-aware camera ship together; buttons are readable, accessible and do not block transparent map space.

## Task 3 — Put safe Fit and zoom clamping inside the shared transform (**pair with Task 2**)

1. In **`src/render/boardTransform.ts` only**, export a fixed `HUD_INSET = { top, bottom }` and write a small `safeRect(board)` helper: full width, top/bottom margins, nonnegative usable height. The CSS values come directly from this constant in Task 2. Handle zero/tiny board sizes without NaN or division-by-zero.
2. Make `fitScale`, `maxZoom`, `clampCamera`, `resolvedCamera` and `getBoardTransform` use that safe rectangle. Use the safe rect centre, not `board.width/2` or `board.height/2`, for world offsets. **Crucially clamp at zoom >1 against the safe rectangle on both axes** so extreme map rows stay reachable and not hidden under cards/dock.
3. Update `zoomCameraAt` to anchor around the safe centre for its world-to-screen maths; `applyCameraAction` uses the safe centre for zoom buttons and safe width/height for keyboard pan steps. Keep wheel zoom anchored to the actual pointer. Preserve `Camera | null` (null is Fit), `centerOn`, zoom limits and world coordinates.
4. Keep `visibleWorldRect` and `canvasToWorld` using the **full canvas** for culling and picking. Keep the WebGPU host, `MapTextOverlay.svelte` transform consumer and `tests/e2e/helpers.ts` **unchanged** for inset plumbing: they already call the same `boardTransform` functions. Do not pass new props, keep per-frame DOM reads out of rendering, and retain the existing map text/canvas alignment.

**Focused tests:** a `boardTransform.test.ts` safe-fit + zoomed-in corner-clamp regression, including a tiny board; retain existing host/pointer and overlay mapping tests. One e2e test must **zoom to maximum, pan to the bottom-right corner and click the bottom-right tile, then do the same for top-left**. The older “Small map at Fit, bottom-row click” is useful but insufficient alone; include it if inexpensive.

**Proof:** the shared transform gives matching GPU/DOM/e2e tile locations, and at any supported zoom the player can reach the entire playable map without the HUD occluding edge tiles.

## Task 4 — Redraw the structural map in existing geometry

1. Update `colors.ts` and the renderer clear colour to warm daytime grass, using the **distinct** residential/house/park/tree colours already selected in Task 1. Keep GPU palette literals separate from CSS tokens.
2. At the start of `mapBatch.ts::buildMapBatch`, compute **one occupied-tile set** from `state.buildings[].occupiedTiles` and reuse it for vacant-lot edges, roofs and trees. Never emit decorative trees on those occupied tiles.
3. For vacant zoned tiles, draw tinted lot fills with dashed edges **only along the outer perimeter**, i.e. where the adjacent tile is not a vacant tile of the same area. Reuse `SolidGeometry.dashedLine` from `primitives.ts` rather than creating a dash helper. A 6×6 zone should look like **one outlined lot**, not 36 dashed boxes.
4. Add cheap deterministic grass variation, curb/lane hints, existing roundabout planted islands, track sleepers, roofs/shadows and sparse round-canopy trees derived from a tile-coordinate hash. No Rust mutation, new map field or random runtime state. Keep authored routes/overlays and picking geometry as-is.
5. Add one `gridMode` argument to `buildMapBatch` (hidden, faint, normal or equivalent). Derive mode from active tool and **discrete** on-screen tile-size bands. Add the mode to the existing **structural scene cache key** in `createWebGpuHost.ts`. One tool/threshold transition rebuilding the scene is acceptable; **do not** add a separate grid GPU batch or retessellate on every tick/pan.
6. Record **before/after structural vertex counts on a Large 84×54 map**; `createWebGpuHost.ts` currently transforms and re-uploads the structural batch per frame. The smaller grid cost may offset trees/dashes/shadows. Optimise only if measurement shows material growth, not as speculative infrastructure.

**Focused tests:** `webgpuMapBatch.test.ts` covers grid off/on/low-zoom fade, one perimeter-only dashed lot, deterministic tree coordinates, and tree disappearance after building or zoning; adapt existing exact-colour assertions once. `webGpuHost.test.ts` asserts scene rebuild on grid-mode change but not ordinary ticks/pan. Existing overlay/route tests guard painter order.

**Proof:** the map is readable in Select without internal zone/grid clutter, and the new art-free visuals remain cheap and deterministic.

## Task 5 — Improve transit markers and vehicles without adding a pipeline

1. Use existing `transitBatch.ts` SolidGeometry for white/rimmed bus-stop discs and rounded-square metro markers in route/mode colours; preserve path geometry, picking inputs and selected-route emphasis.
2. In `renderer.ts::VEHICLE_SHADER`, **decouple lane displacement from body half-width** before increasing visual dimensions. The existing `-(2 * halfWidth + 2)` local offset makes wider bodies slide sideways into neighbouring tiles; use a fixed lateral offset (roughly today's 10px or smaller), and then modestly increase `VEHICLE_HALF_LENGTH`/`VEHICLE_HALF_WIDTH` in `vehicleInstances.ts`.
3. Pass the quad's local coordinates as a shader varying and render a thin white outer rim **inside the same fragment shader and one instanced vehicle pass**. Currently `vehicleInstances.ts` applies one fixed colour per **mode**, but HPA-678 asks for the **individual line's colour**: obtain it from existing `state.transit.routes`/`metroLines` via one local ID-to-colour lookup per encode call; no new wire data. Retain centre/path origin, heading, unrelated-route opacity, interpolation, culling and stable ordering. No additional GPU buffers or draw calls.
4. Add a focused `pickMapTarget.test.ts` regression for clicking the **actually rendered body centre** and an outer visible point at the chosen width/offset. Respect today's same-tile pick gate and 16px path-point radius; if a visible portion of the body misses, reduce the dimensions/offset or minimally adjust tolerance, **never** allow adjacent-tile vehicles to steal a building click.

**Focused tests:** reuse `webgpuVehicleInstances.test.ts` and `webgpuTransitBatch.test.ts` for centre/order/colour and marker geometry; run the existing renderer tests and one map-inspection e2e path for clicking vehicles. No shader/pixel golden tests without a reproduced regression.

**Proof:** a larger vehicle remains on its intended lane and can be inspected where it is visibly drawn, with a single vehicle pass.

## Task 6 — Verify real player flow and finish in this PR

1. Make small, reviewable commits per task where practical (Task 2 + Task 3 **together**, with checks passing). All work remains within **the same draft PR #80**; do not open separate implementation PRs.
2. Run focused tests as each part lands, then the standard CI-shaped checks:

```sh
bun run check
bun run test:unit
bun run test:e2e
bun run lint
bun run format:check
bun run build
```

Rust is not changing; `cargo test --workspace` is optional unless CI/a touched shared contract requires it. No new Rust test matrix for a rendering-only ticket.

3. Playwright font proof after app load: await `document.fonts.ready`, confirm the Bricolage Grotesque 600/16 and Inter 16 faces are **registered and loaded** and `document.fonts.check('600 16px "Bricolage Grotesque"')` and `document.fonts.check('16px Inter')` are true. Inspect `page.on('request')` and assert no **font request** leaves the app origin. A bare `check()` without ensuring local faces are present is not strong enough to catch silent fallback. Tauri remains a manual offline spot check.
4. Manual browser UAT at 1024×768, 1280×800, 1440×900 with Small and Large maps: Fit, maximum zoom to both map corners, wheel zoom, pan, place road/stop, zone a lot, observe growth, Select/Demolish, create/save a line, inspect a vehicle, show Data overlay, save/reload city. Check that centre panels remain usable while HPA-696 is outstanding.
5. Compare Large-map 84×54 structural vertex count before/after map visuals and note it in the PR. Verify capture tests and the existing WebGPU host API still work. Do not tune performance without a measured regression.
6. Remove obsolete dark-console CSS and obsolete test assumptions in the **same implementation PR**. Update `docs/architecture.md` only if the new HUD/transform ownership needs explanation. Before marking ready, reconcile HPA-678 with the final implementation; keep HPA-676/677/696 assets, menus, docked panels and textures in their separate tickets.

**No implementation tests have run while this PR contains documentation only.**

## Acceptance checklist

- [ ] Floating Sunny Diorama HUD + full-bleed canvas; no 72px feedback band
- [ ] Offline bundled fonts, real city/save state and existing metrics/actions
- [ ] One constant-driven safe viewport; Fit **and max-zoom panning** keep both edge tiles reachable and clicking/labels aligned
- [ ] Grid is tool-driven and lower contrast at low zoom; vacant-zone dashes follow **outer perimeter only**
- [ ] Warm map with distinct grass/residential/house/park/tree colours; one shared occupied set and deterministic decorative trees
- [ ] Larger readable vehicles with fixed lane offset and correct drawn-body picking; stop markers without a new GPU pipeline
- [ ] Targeted UI/render/e2e including max-zoom edge tile, vehicle pick and local font-load assertions; Large-map vertex count recorded; standard checks pass
- [ ] No Rust/wire/save or new artwork work; **one PR for HPA-678**

## Review boundaries

Keep this a UI/rendering improvement, not a new architecture. If visuals require extra GPU buffers/pipelines, state owners, generic components, or a large font/theme framework, prefer the existing geometry/CSS alternative. Wave 3 tasks must be able to replace provisional building/trees with HPA-676 sprites and adopt the shared tokens without redoing simulation or save contracts.
