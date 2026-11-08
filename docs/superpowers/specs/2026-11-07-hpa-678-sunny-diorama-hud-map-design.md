# HPA-678 — Sunny Diorama HUD and map look — Design

**Linear:** https://linear.app/cwchanap/issue/HPA-678/give-the-game-its-new-hud-and-map-look  
**Repository:** `cwchanap/Caelum`  
**Baseline:** `main` at `70e0b78` (after HPA-675)  
**Delivery:** This draft PR starts with the specification and plan; implementation and tests will be added to **this same PR**. No second implementation PR.

## Player outcome

The active city feels like a bright, readable city-builder rather than a dark dispatch console: an unobstructed, warm map with light floating HUD cards; clearly distinguishable zoning, buildings, roads, vehicles, stations and waiting-to-grow lots; and familiar commands in a compact dock. At Fit, the entire board remains visible between the top HUD and bottom dock. Build and route interactions continue to use the same authoritative Rust simulation.

This is **wave 1** of the agreed Sunny Diorama redesign. Wave 2 HPA-676 produces all new art independently. Wave 3 HPA-677 installs sprites and redesigns the city menus, and HPA-696 docks/reworks the workspace panels. Those tasks retain separate tickets/PRs.

## Current code and constraints (verified)

- `src/App.svelte` owns the active-city shell, `Topbar`, `GameCanvas`, `CommandShelf`, `CommandPanel` and `ActionFeedback`. `src/styles.css` uses a four-row grid: 64px top bar, map, 72px feedback slot and 92px command shelf. `CommandPanel` currently floats centrally; leave its docking for HPA-696.
- `Topbar.svelte` already receives `ShellTopbarState` with formatted budget, daily cost, day/time, population, avg wait, late and unserved counts; `snapshot.persistence.activeCity.name`, `dirty` and `busy` supply city identity/save state. No gameplay fields or new wire data are needed; add at most one small presentation selector, `tripIssues: string | null`, for the warning chip so Svelte does not parse metric strings.
- `src/components/hud/CommandShelf.svelte` already implements Build/Lines/Data/City, Select/Demolish, the existing keyboard shortcuts, line count and route-draft interaction gate. Preserve these behaviors, `data-testid` hooks and focus handling.
- `src/components/ActionFeedback.svelte` owns a permanently mounted polite screen-reader live region and dismissible errors. Preserve its announcement semantics when converting the visible strip to a toast. The map's cursor price/rejection badge remains in `MapTextOverlay`.
- `src/render/boardTransform.ts` is the shared map/camera transform used by the WebGPU host, picking and `MapTextOverlay.svelte`. The renderer's `src/runtime/createWebGpuHost.ts` caches structural geometry by scene revision and only rebuilds it when the map changes; its current structural batch includes a grid on every tile.
- `src/render/colors.ts`, `src/render/webgpu/mapBatch.ts`, `transitBatch.ts`, `vehicleInstances.ts` and the existing `renderer.ts` shaders implement the graphics today with untextured geometry. Preserve this path and the current GPU buffer/pipeline strategy.
- `index.html` still says “Caelum // Transit Ops”. `styles.css` references fonts but does not load them. The desktop release runs offline through Tauri.

## 1. Visual tokens, fonts and common controls

Replace the console colours with a **single Sunny Diorama visual direction**: warm grass, light cream/white cards, dark slate text, teal/terracotta accents, subtle outlines, soft shadows and rounded corners. Use semantic/role-based CSS tokens (`--accent`, `--warning`, `--surface`, `--ink`, etc.); **rename** misleading console colour aliases such as `--cyan`, `--amber`, `--magenta`, `--lime` and `--bg-deep` and update every caller in the same change. Sweep hard-coded dark-console tints in `styles.css` and the existing HUD/panel Svelte styles so old dark islands do not survive on cream cards. Keep a small **separate** GPU palette in `src/render/colors.ts`: WebGPU colours are parsed literals, not live CSS variables. No theme engine, dark-mode toggle or component library.

**Chosen zone palette:** use warm/light grass, **muted terracotta/coral residential lots** and terracotta/slate house roofs, with **distinct green** for park lots and a darker canopy green for trees. Keep commercially/business-zoned lots yellow/blue and industrial/civic lots distinguishable. Residential zones and houses must *not* reuse the grass/tree hue. The vacant-lot outline carries the zoned-but-unbuilt distinction; building roofs have their own shapes and shadows. Select actual light-theme hex values once before updating map-colour tests.

Bundle Bricolage Grotesque (headings) and Inter (body/UI) via Bun-managed local `@fontsource` assets for offline browser/Tauri use; use Inter with tabular numerals for numbers. There is **no existing JetBrains Mono package dependency**: replace the legacy `--font-mono` references/fallback with the actual Inter body/numeric styles in this change. Update `MapTextOverlay.svelte`'s `CHAR_PX` comment to stop claiming JetBrains Mono metrics, keeping a conservative label-width estimate. Keep text readable at 1024px and focus/disabled states obvious.

Add only **four CSS primitives** that have current HUD callers: button, card, chip and segmented control, in one well-labelled section of existing CSS (or one imported CSS file if it genuinely reduces duplication). **No field/input primitive** until HPA-696 needs one. Avoid Svelte wrappers for single-use controls. Existing panels need the explicit old-colour literal sweep above to become legible; their *layout* redesign stays HPA-696.

## 2. Full-bleed game shell

Change the active-city shell to one full-window `GameCanvas` with pointer-transparent positioning layers and interactive HUD elements above it. The renderer canvas and map text still cover the same measured board element; HUD containers must not intercept clicks over empty map space.

- **Top-left card:** active city's real name and a save-state label derived solely from `busy`/`dirty`, reusing `CityPanel.svelte` wording (“Working…”, “Unsaved changes”, “Saved”). The top band has a **fixed height** shared with the transform; long city names **ellipsize** at 1024px with a `title` revealing the full name rather than wrapping. The product/page title is “Caelum”, not the old Transit Ops brand block.
- **Top-center card:** existing pause/resume, `shell.time` (Day + clock), and 1×/2×/4× buttons. Keep their actions, pressed state and keyboard behavior.
- **Top-right card:** money and daily operating cost, residents, average wait, and a compact conditional warning chip. Add exactly one UI-only `ShellTopbarState.tripIssues: string | null` selected from the **numeric** late/unserved counters in `runtimeSelectors.ts` (e.g. “3 late · 1 unserved”, `null` when zero); Svelte renders it without parsing formatted strings. Existing `networkSummary` stays available for `CityPanel` and is **not** squeezed into the top bar. At 1024px use tighter spacing/fixed rows; keep essential numbers readable rather than wrapping the fixed-height band.
- **Bottom-center floating dock:** Build, Lines, Data, City, Select and Demolish in that order. Preserve existing pressed/expanded state, route-draft gating, number of lines, and existing shortcuts (Build B, Select V, Demolish D). Do not invent shortcuts for Lines/Data/City.
- **Bottom-left:** place the existing +, − and Fit controls **horizontally within the bottom safe band**, beside the floating dock. They retain their keyboard equivalents and are not overlaid on fitted map tiles. No additional left/right safe inset is required.
- **Feedback:** remove the 72px reserved band; anchor the current visible `ActionFeedback` as a small toast under the clock, with the same details, dismiss button, screen-reader live region and route-draft suppression. Do not add a timer or queue.
- **Existing workspace panels:** continue to function as floating centre overlays for now. They adopt colours/tokens but do **not** dock, receive new art, or change route-editor behavior in wave 1.

The board and all map tools stay keyboard-accessible. Use fixed/absolute overlay positioning only for the HUD, never a full-screen pointer-blocking backdrop.

## 3. Fit and pointer alignment: one shared transform

The canvas fills the **whole window** but Fit, camera clamping and keyboard navigation must keep the edge tiles visible **between the fixed-height top HUD band and bottom dock/zoom band**, not underneath them. This also applies at maximum zoom: the player must be able to pan to and click the top-left **and** bottom-right tiles.

**Use a fixed presentation-only constant inside the existing transform module, not measured insets threaded through callers.**

- Export `HUD_INSET = { top, bottom }` from `src/render/boardTransform.ts`. Define one `safeRect(board)` helper with full canvas width, top/bottom insets and nonnegative usable height (handle tiny/zero-size test boards without NaN or division-by-zero). `App.svelte` imports the same constant and sets `--hud-top` / `--hud-bottom` for CSS. One source of truth; fixed-height top band; no ResizeObserver or new runtime prop for insets.
- Use the safe rectangle for `fitScale`, `maxZoom`, `clampCamera` (both axes), `resolvedCamera` defaults, `getBoardTransform` offsets/centre, `zoomCameraAt` anchor calculations, `applyCameraAction`'s zoom middle and keyboard pan step. All offsets remain in **full-canvas CSS coordinates**. Preserve `Camera | null` (`null` = Fit), world/tile coordinates and pointer-centred wheel zoom.
- Keep `visibleWorldRect` and `canvasToWorld` using the **full board** so areas behind transparent overlay space can still be drawn and picked. Do not change `createWebGpuHost.ts`, `MapTextOverlay.svelte` or `tests/e2e/helpers.ts` just to pass an inset: they all already call the shared transform functions. No second camera/view-state owner or persisted field.

**Invariant:** WebGPU tile centres, DOM labels and the existing e2e tile helper still agree. At Fit all board edges clear the HUD. At higher zoom, clamping makes **both** extreme map corners reachable/clickable inside the safe rectangle. Verify zoom, pan and pointer mapping together, not Fit alone.

## 4. Map visuals using existing untextured WebGPU batches

Keep existing painter ordering and simple geometry; new sprites/textures belong to HPA-677.

- **Base:** warmer grass fill with a subtle deterministic tile-colour variation and soft board edge. Set the renderer clear colour to match. Avoid random state or per-frame noise.
- **Grid:** no grid in Select/inspection mode; show it only for an armed placement/route/demolish tool, with a lower-opacity level when on-screen tiles are small. Derive this from existing `UiState` and discrete zoom/scale bands. Include grid visibility/band in the structural batch cache key so it updates on tool/threshold changes but does not retessellate on every tick or pan.
- **Vacant zones:** use the distinct zone palette above and a dashed **outer lot perimeter only**, not dashed edges between adjacent vacant tiles of the same area (which would recreate a dense grid in Select). Reuse `SolidGeometry.dashedLine`. Build **one occupied-tile set** from `state.buildings[].occupiedTiles` at the start of `buildMapBatch` and share it with vacant-zone dashes, roofs and tree exclusion.
- **Roads/track:** add simple curbs and lane markings to the existing road geometry, keep one-way arrows, put a planted island in the existing roundabout geometry, and add low-cost sleeper ticks to existing track. Do not affect topology, route geometry, service paths or traffic.
- **Buildings:** until sprites arrive, use distinct terracotta/slate/other roof colours and a small offset shadow built from the same SolidGeometry shapes; reuse the occupied-tile set, no new footprint schema.
- **Vehicles:** the current shader derives lateral body displacement from width (`-(2 × halfWidth + 2)`), so **first decouple the lane offset into its own fixed shader constant** (at most the present ~10px), then enlarge body extents. Pass local quad coordinates as a fragment varying for a thin white outline **inside the existing instanced pass**. Preserve path/world instance origin, heading, colour, opacity, culling and interpolation. Since `pickMapTarget.ts` uses a 16px path-point radius **and a same-tile gate**, test clicking the rendered body centre and visible edge; adjust size/offset or minimal pick tolerance if necessary, without allowing adjacent-tile vehicles to steal unrelated clicks.
- **Stops/stations:** white disc with route-coloured rim for bus stops and white rounded square for metro stations; reuse current route/mode colour information. Glyphs and text labels on the GPU are not required.
- **Decorative trees:** sparse, deterministic (tile-coordinate hash), darker-green round-canopy geometry on genuinely empty, unzoned, track-free tiles not in the shared occupied-tile set. Trees are render-only and vanish when a tile is built/zoned; they are never serialized, picked, simulated, or added to Rust state. Count structural vertices before/after on a Large 84×54 map; do not optimise pre-emptively.

Keep overlays, route strokes, shared-corridor offsets, draft handles, failures and the existing map text readable above the new palette. Avoid a second renderer, texture pipeline, external tile generator or particle system.

## Acceptance criteria

1. At 1024×768, 1280×800 and 1440×900, the top controls, numbers, bottom dock and zoom buttons do not overlap or clip; the existing pause/speed/build/select/demolish actions and keyboard shortcuts still work.
2. A Small, Medium and Large map at Fit sits fully clear of floating controls; at max zoom, both the top-left and bottom-right tiles remain reachable/clickable after pan. Pointer-to-tile, labels and rendered geometry agree after Fit/zoom/pan/resize.
3. Select hides the grid; arming Build/road/route or Demolish shows a legible grid; low zoom reduces its emphasis. Repeat draws of an unchanged map produce the same decorative tree positions.
4. Terracotta residential lots, green park lots, roofs and trees remain distinguishable against warm grass. Vacant zones show perimeter-only dashes. Roads/track, roundabouts, buses and stations are distinct, and enlarged vehicles are clickable on their drawn body at Fit.
5. The feedback toast preserves dismiss/accessibility behavior; Playwright confirms loaded local Bricolage Grotesque and Inter font faces with **no off-origin font requests**, and Tauri is spot-checked offline.
6. Existing e2e flows, WebGPU host/capture contracts and core gameplay behavior remain intact. Record the Large-map structural-vertex count before/after the new geometry. No screenshot-golden styling suite is required.

## Deliberate non-goals

No generated images/icons, building sprite atlas, map textures, branded key art, City Library/New City redesign, Build-card redesign, right-side docking or Inspect popovers (HPA-676/677/696). No Rust, WASM/native wire, gameplay API, persistence format, migrations, auto-save logic or new player controls. Keep one HPA-678 implementation PR: this draft will be extended in place after the design is reviewed.
