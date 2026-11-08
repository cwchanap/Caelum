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
- `Topbar.svelte` already receives `ShellTopbarState` with formatted budget, daily cost, day/time, population, avg wait, late and unserved counts; `snapshot.persistence.activeCity.name`, `dirty` and `busy` supply city identity/save state. No gameplay fields or new selectors are needed solely for the HUD.
- `src/components/hud/CommandShelf.svelte` already implements Build/Lines/Data/City, Select/Demolish, the existing keyboard shortcuts, line count and route-draft interaction gate. Preserve these behaviors, `data-testid` hooks and focus handling.
- `src/components/ActionFeedback.svelte` owns a permanently mounted polite screen-reader live region and dismissible errors. Preserve its announcement semantics when converting the visible strip to a toast. The map's cursor price/rejection badge remains in `MapTextOverlay`.
- `src/render/boardTransform.ts` is the shared map/camera transform used by the WebGPU host, picking and `MapTextOverlay.svelte`. The renderer's `src/runtime/createWebGpuHost.ts` caches structural geometry by scene revision and only rebuilds it when the map changes; its current structural batch includes a grid on every tile.
- `src/render/colors.ts`, `src/render/webgpu/mapBatch.ts`, `transitBatch.ts`, `vehicleInstances.ts` and the existing `renderer.ts` shaders implement the graphics today with untextured geometry. Preserve this path and the current GPU buffer/pipeline strategy.
- `index.html` still says “Caelum // Transit Ops”. `styles.css` references fonts but does not load them. The desktop release runs offline through Tauri.

## 1. Visual tokens, fonts and common controls

Replace the console colours with **one** Sunny Diorama palette: warm grass, light cream/white cards, dark slate text, teal/terracotta accents, subtle outlines, soft shadows and rounded corners. Define the palette once for DOM tokens and the corresponding small rendering palette in `src/render/colors.ts` (renderer colours are literal parsed values, not CSS variables). Do not introduce a theme engine, dark-mode switch or component library.

Bundle Bricolage Grotesque (headings) and Inter (body/UI, tabular numerals) via Bun-managed local font assets so they load offline in both browser and Tauri. Remove the obsolete JetBrains Mono dependency/fallback as the primary HUD typography. Keep text readable at 1024px and focus/disabled states obvious.

Put reusable **CSS primitives** for button, card, chip, segmented control and input/field in one well-labelled section of the existing CSS (or one imported CSS file if that genuinely reduces duplication). Use them in the new HUD; avoid introducing component wrappers that have only one caller. Existing panels automatically inherit the lighter palette, but their layouts are HPA-696.

## 2. Full-bleed game shell

Change the active-city shell to one full-window `GameCanvas` with pointer-transparent positioning layers and interactive HUD elements above it. The renderer canvas and map text still cover the same measured board element; HUD containers must not intercept clicks over empty map space.

- **Top-left card:** active city's real name and a save-state label derived solely from `busy`/`dirty` (e.g. Working, Unsaved, Saved). The product/page title is “Caelum”, not the old Transit Ops brand block.
- **Top-center card:** existing pause/resume, `shell.time` (Day + clock), and 1×/2×/4× buttons. Keep their actions, pressed state and keyboard behavior.
- **Top-right card:** money and daily operating cost, residents, average wait, and a compact warning chip using the already-selected `late`/`unserved` metrics. No new simulation calculation; at 1024px use tighter spacing/wrapping rather than clipped numbers or disappearing essential controls.
- **Bottom-center floating dock:** Build, Lines, Data, City, Select and Demolish in that order. Preserve existing pressed/expanded state, route-draft gating, number of lines, and existing shortcuts (Build B, Select V, Demolish D). Do not invent shortcuts for Lines/Data/City.
- **Bottom-left:** relocate the existing +, − and Fit controls as a compact floating vertical stack.
- **Feedback:** remove the 72px reserved band; anchor the current visible `ActionFeedback` as a small toast under the clock, with the same details, dismiss button, screen-reader live region and route-draft suppression. Do not add a timer or queue.
- **Existing workspace panels:** continue to function as floating centre overlays for now. They adopt colours/tokens but do **not** dock, receive new art, or change route-editor behavior in wave 1.

The board and all map tools stay keyboard-accessible. Use fixed/absolute overlay positioning only for the HUD, never a full-screen pointer-blocking backdrop.

## 3. Fit and pointer alignment: one shared transform

With the canvas now full-window, the Fit view must use the **unobstructed viewport** between the top cards and the tool dock (with a modest margin); otherwise top/bottom map rows hide beneath HUD chrome.

Introduce a small, read-only presentation-only **safe viewport inset** (top/bottom, plus left/right only if needed) to the existing `boardTransform` calculations. Keep it tied to the shell layout's measured/CSS-controlled geometry, not to Rust, `UiState`, saves or a second camera. The resulting single transform must be shared consistently by:

1. GPU world-to-clip drawing and vehicle culling in `createWebGpuHost.ts`;
2. pointer mapping, hover, drag, map picking and pan/zoom anchoring; and
3. DOM labels in `MapTextOverlay.svelte`.

The input canvas remains full-window. Compute the usable rectangle once per board/layout size change and use the same insets for camera Fit, zoom actions and the text overlay. Preserve the existing `Camera | null` contract (`null` means Fit), centerOn/pan behavior, pixel ratio handling and scene ownership. Do not add a separate camera, persisted viewport, new runtime data source or DOM-to-Rust messages.

**Invariant:** world tile centres projected by WebGPU and DOM text must match exactly, and tapping a visible tile must select that tile even after Fit, zoom, resize or pan. This is more important than pixel-perfect mockup measurements.

## 4. Map visuals using existing untextured WebGPU batches

Keep existing painter ordering and simple geometry; new sprites/textures belong to HPA-677.

- **Base:** warmer grass fill with a subtle deterministic tile-colour variation and soft board edge. Set the renderer clear colour to match. Avoid random state or per-frame noise.
- **Grid:** no grid in Select/inspection mode; show it only for an armed placement/route/demolish tool, with a lower-opacity level when on-screen tiles are small. Derive this from existing `UiState` and discrete zoom/scale bands. Include grid visibility/band in the structural batch cache key so it updates on tool/threshold changes but does not retessellate on every tick or pan.
- **Vacant zones:** retain the existing area meaning/colours while drawing tinted lots and an obvious dashed boundary for an empty zoned tile. A developed building gets its roof instead of looking like an empty zone.
- **Roads/track:** add simple curbs and lane markings to the existing road geometry, keep one-way arrows, put a planted island in the existing roundabout geometry, and add low-cost sleeper ticks to existing track. Do not affect topology, route geometry, service paths or traffic.
- **Buildings:** until sprites arrive, use clearer roof colours and a small offset shadow built from the same SolidGeometry shapes; use existing `occupiedTiles`, no new footprint schema.
- **Vehicles:** increase the visual body dimensions while preserving world-space centre and heading, and draw a thin white outline through the existing instanced shader so it remains one vehicle pass. Preserve line colour, selection opacity, culling, interpolation and picking.
- **Stops/stations:** white disc with route-coloured rim for bus stops and white rounded square for metro stations; reuse current route/mode colour information. Glyphs and text labels on the GPU are not required.
- **Decorative trees:** sparse, deterministic (tile-coordinate hash), simple round-canopy geometry on genuinely empty, unzoned, track-free, unoccupied tiles only. Trees are render-only and vanish when a tile is built/zoned; they are never serialized, picked, simulated, or added to Rust state.

Keep overlays, route strokes, shared-corridor offsets, draft handles, failures and the existing map text readable above the new palette. Avoid a second renderer, texture pipeline, external tile generator or particle system.

## Acceptance criteria

1. At 1024×768, 1280×800 and 1440×900, the top controls, numbers, bottom dock and zoom buttons do not overlap or clip; the existing pause/speed/build/select/demolish actions and keyboard shortcuts still work.
2. A Small, Medium and Large map at Fit sits fully clear of floating controls. Pointer-to-tile, labels and rendered geometry agree after Fit/zoom/pan/resize.
3. Select hides the grid; arming Build/road/route or Demolish shows a legible grid; low zoom reduces its emphasis. Repeat draws of an unchanged map produce the same decorative tree positions.
4. Empty zoned lots, developed buildings, road/track, roundabouts, buses and stations are visually distinct; vehicles remain visible at Fit.
5. The feedback toast preserves dismiss/accessibility behavior; browser and Tauri load fonts without a network.
6. Existing e2e flows, WebGPU host/capture contracts and core gameplay behavior remain intact. No screenshot-golden styling suite is required.

## Deliberate non-goals

No generated images/icons, building sprite atlas, map textures, branded key art, City Library/New City redesign, Build-card redesign, right-side docking or Inspect popovers (HPA-676/677/696). No Rust, WASM/native wire, gameplay API, persistence format, migrations, auto-save logic or new player controls. Keep one HPA-678 implementation PR: this draft will be extended in place after the design is reviewed.
