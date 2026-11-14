# HPA-677 — Sunny Diorama map sprites and city menus — Implementation plan

**Design:** [2026-11-13-hpa-677-sunny-diorama-map-menus-design.md](../specs/2026-11-13-hpa-677-sunny-diorama-map-menus-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-677/bring-the-new-art-to-the-map-and-menus  
**Baseline:** main @ 3a655a9dd1c0fc347f0b0cde740e7c1afc7e00a1 (HPA-678, HPA-676 and HPA-696 merged)  
**Delivery:** **One PR for HPA-677, design + plan + future code + tests on this same branch.** This first draft contains planning documents only. Do not open a follow-up implementation PR, create assets, or touch Rust/persistence.

## Change ownership

| Task | Primary paths | Preserve |
| --- | --- | --- |
| Illustrated City Library | src/components/city/CityLibraryScreen.svelte, CityList.svelte, src/styles.css | Existing callbacks, first-run routing, CitySummary, reuse of CityList inside CityPanel |
| Two-column New City | src/components/NewCityScreen.svelte, src/styles.css | NewCityRequest, trimmed name, busy/error/Cancel, existing defaults |
| Atlas/instance geometry | Focused src/render/webgpu/mapSprites.ts or spriteAtlas.ts; src/render/webgpu/mapBatch.ts | BUILDING_CATALOG footprint, deterministic tree placement and all other map geometry |
| Textured pass and lifecycle | src/render/webgpu/renderer.ts, src/runtime/createWebGpuHost.ts | Existing solid, vehicle, overlay, frame capture, picking and viewport transform |
| Regression proof | tests/e2e/newCity.spec.ts, cityLibrary.spec.ts; relevant tests/ui and tests/render files | Real WASM/browser flows and the existing host-injection test seam |

Change only necessary files; this is an ownership map, not a mandatory file count. All images already exist in src/assets/sunny-diorama.

## Task 1 — Update the existing menu player-flow tests first

1. In tests/e2e/newCity.spec.ts, replace tests that call selectOption on the old Template and Map size selects with accessible tile-button interactions. Preserve the original tests' end-to-end Rust/WASM assertions, including real starting budget, selected template, size and city creation. Add a focused case that checks the three template images, the changing large preview, all size/economy controls and their aria-pressed states, default Crossroads/Small/Standard, blank-name submit gate and trimmed name. Do not build a new E2E fixture or test harness.
2. Extend the existing cityLibrary.spec.ts save/reload/Continue flow to check the key-art background, Caelum logo/text, named Continue action, the most recent saved city, rename, Load and confirmed Delete. Keep the existing metadata ordering and disable/retry behavior. Use a saved city with an intentionally different name to avoid accidentally testing a hard-coded Continue label.
3. Keep tests for the compact in-game CityPanel CityList and the initial no-city redirect. Any unit changes to tests/ui/cityList.test.ts or tests/ui/appShell.test.ts should be limited to affected markup and behavior.
4. Run the focused tests red on the current UI before changing components, then green with the new markup. These are player-flow regressions, not pixel-perfect screenshot goldens.

**Proof:** Existing create/save/Continue/Load/Rename/Delete flows remain functional while illustrated selectors and library controls are reachable by role/name and keyboard.

## Task 2 — Integrate menu art using Svelte state already present

1. CityLibraryScreen: import menu/city-library.webp and existing app-icon-source.png. Apply a cover-cropped, full-viewport background, keeping a subdued/card-covered left area and ample foreground contrast. Use a single cream card with the live-text Caelum wordmark/tagline, large “Continue [cities[0].name]” button and New City. Retain the current error, loading, retry and empty-list branches; do not invent a last-city field.
2. CityList: render a deterministic initial avatar and larger saved-city card style **only when used in the library**. The component is also used inside CityPanel; scope the styling to its parent/optional simple variant instead of changing that panel's density. Preserve rename on Enter/blur, Escape cancellation, two-click Delete, disabled/busy state, Load and existing data-testids. Limit scrolling to the library's list area.
3. NewCityScreen: retain its existing four local Svelte state variables and submit handler. Replace select controls with three image-backed template buttons, three map-size tile buttons, and two economy tile buttons (Standard “Money matters”, Creative “Build for free”). Put the selected template's source image in the large right-side preview. Buttons use type=button, aria-pressed and visible focus; image decorations do not hide textual names. Keep the initial defaults and original NewCityRequest.
4. Update the existing screen CSS tokens in src/styles.css, scoped to the two menu screens, for 2-column large preview and a non-clipping arrangement at 1024×768 and 1440×900. Do not introduce a component library, additional state store or new API boundary.

**Proof:** Real browser keyboard and mouse interactions select a template/size/economy and create the correct city. Two saved cities can be managed from the illustrated Library. CityPanel remains compact and functional.

## Task 3 — Build one local atlas and deterministic sprite data

1. Create a **small explicit asset map** for the twelve sprite-bearing BuildingType values (smallHouse, largeHouse, supermarket, cinema, officeTower, businessPark, factory, warehouse, clinic, school, parkPlaza, busTerminal) and the three existing tree-0*.webp variants. Exclude busStop and metroStation so their existing procedural map markers remain. Reference the already committed URLs through Vite imports; do not fetch remote images or add a new asset pipeline.
2. Decode all fifteen images as one startup promise. Validate building image dimensions against BUILDING_CATALOG widths/heights × 192 and trees against 192×192. Fail clearly on missing or malformed assets. Pack the decoded images into a deterministic single texture atlas with transparent gutter, using a temporary 2D canvas only for packing and GPU upload; honor device maxTextureDimension2D. Atlas layout, UV rectangles and source asset metadata are not separate persistence records.
3. Extract just the existing deterministic tree predicate/hash/offset/size code from mapBatch.ts into a small reusable map-sprite geometry helper, avoiding separate independent random-placement algorithms. Keep the original 12–18 world-pixel tree canopy diameter. Use one further deterministic hash to choose a tree variant; it must not depend on frame time, zoom or save/load order.
4. For each PlacedBuilding, derive a **single quad** from origin + native dimensions and rotated occupied footprint, using getRotatedFootprintSize and building.rotation (0/90/180/270). Center the sprite before rotating in world coordinates; do not tessellate one sprite per occupied tile or create four directional textures. The instance records hold world position, local extents/rotation and one atlas UV rect.
5. Preserve the small +3px renderer-owned soft shadows as solid geometry under buildings and trees, and remove only the replaced procedural tree canopies, building flat roofs and outlines from mapBatch.ts. Keep roads, zones, lot outlines, track, grid, stop/station markers and structural draw ordering.
6. Test the atlas layout and UVs, all twelve building-type asset mappings, dimension checks, deterministic trees, tree filtering on occupied/road/zoned tiles, and building 0°/90°/180°/270° world geometry with one focused suite. Avoid unit tests that duplicate the whole map mesh snapshot.

**Proof:** One atlas contains exactly the shipped assets; one building instance corresponds to one placed building; rotation stays within its real occupied footprint; reload preserves tree distribution.

## Task 4 — One textured WebGPU instanced draw in the existing frame

1. Extend WebGpuRenderFrame with a narrow sprite batch/instance input and keep its existing solids, vehicles and overVehicles inputs. Put sprite placement between structural map geometry and routes/dynamic overlays; the host's frame assembly remains the single source of draw ordering. The sprite pass draws trees before buildings from **one** instance buffer and one texture atlas.
2. In renderer.ts, add one WGSL textured-quad pipeline, sampler, bind group and grow-only sprite instance buffer. Reuse the existing quad corner buffer and device/encoder. Shader rotates in world space then projects with the host's world-to-clip factors; use RGBA blending and transparent gutters to prevent bleed. Avoid a per-sprite texture bind, draw call, or framework-like generic materials layer.
3. In createWebGpuHost.ts, reuse the existing sceneRevision + gridMode invalidation strategy; compute the static sprite instance geometry once for changed structural state, then apply the same camera transform used by other batches for each frame. Keep viewport/Fit, hit-testing and MapTextOverlay tied to the existing board transform, not a sprite-specific camera.
4. Await atlas loading/upload during the existing async production createWebGpuHost path before exposing a drawable host. Do not change the createWebGpuHostWithRenderer injection contract for fake-renderer tests unless minimally necessary; its injected renderer can use a focused fake atlas input. Respect the existing device-loss and fatal-bootstrap behavior. Destroy atlas texture, sampler-owned references and the sprite buffer on host disposal.
5. Extend renderer/host tests to prove **one sprite instanced draw** for a nonempty scene, zero sprites for empty scenes, reuse of a texture between normal render and captureFrame, correct clear/readback, device cleanup, and no changed route/vehicle batches. Add one real WebGPU browser pixel/scene assertion where fake GPU tests cannot validate UV orientation or alpha.

**Proof:** The existing GPU frame/capture and inspect/picking interactions continue to work; buildings/trees visually replace flat shapes without rewriting the renderer.

## Task 5 — E2E validation, visual mockup checks and release gates

**Automated / agent-driven E2E acceptance** (no human sign-off criterion):

1. **New City**: At 1024×768 and 1440×900, the left controls and large right preview are visible and do not clip. The selected template's preview changes on click/keyboard, selection state is exposed to accessibility tools, and creating Small/Medium/Large cities with Standard/Creative choices produces the expected Rust-backed map and rules.
2. **City Library**: On browser reload with multiple stored cities, the City Library key art, left foreground card and logo visibly match the attached **City Library redesign** composition, while Continue by name, New City, saved-time labels, rename, Load and confirmed Delete work end to end. CityPanel's embedded list still works after entering a city.
3. **Map art**: With Small Town and with a manually rotated building, the screenshot/captured GPU frame contains recognizable building roofs and all three tree variants at the expected world positions. Compare rendered screenshots with the Linear **Game screen: buildings and trees as sprites** reference at Small/Medium/Large Fit and a close zoom. Keep bus/metro procedural markers and line/vehicle overlays visible and hit-testable. Test deterministic tree placement and one instanced draw in focused automated assertions.
4. **Visual proof against mockups**: Collect Playwright screenshots as test artifacts for the **New City redesign**, **City Library redesign**, and **Game screen** layouts at the stated viewports. Programmatically assert key card/preview/board geometry and non-overlap, then review those captures against the attached mockup compositions as part of automated/agent-driven verification; do not introduce screenshot-golden styling tests or a human approval gate.
5. **macOS and Windows**: The existing Tauri CI packaging matrix builds macOS .app and Windows NSIS with the same static art and WebGPU frontend. Run a minimal native-launch smoke on available macOS/Windows environments to verify the New City, City Library and displayed textured map can open and display assets; reuse the browser Playwright suite for full shared UI interactions. Do not require additional native automation infrastructure just for this styling ticket.
6. **Regression gates**: bun run check, bun run format:check, bun run lint, bun run test:unit, bun run test:e2e, bun run build all pass after implementation. Existing Rust and Tauri CI jobs run unchanged. No Android or Linux acceptance requirements.

## Risks and bounded mitigations

- **UV bleed / alpha / 90° swap:** use transparent atlas gutters, a tight pure geometry test and one real-WebGPU pixel oracle. No separate renderer.
- **Startup asset failure:** load all fifteen images before first frame and reuse the existing fatal/shell-error handling, with no fallback texture or retry service.
- **Structural cache drift:** remove old roof/canopy generation in the same change and reuse the current scene revision; no extra reactive cache/store.
- **Menu regression:** CityList is reused in CityPanel. Scope foreground-card styles to the library and update existing tests rather than cloning city-list logic.
- **CI cost:** keep existing WebGPU/Playwright and Tauri jobs; targeted real pixel checks rather than screenshot goldens or a new browser/device matrix.

## Exit criteria and PR workflow

- The two planning documents are reviewed **on this draft PR**; code and tests are committed to **the same PR** when implementation begins.
- All end-to-end and relevant unit/CI gates above pass, and the three attached Linear mockup compositions are checked against captured UI/screenshots.
- No new art/SFX or unneeded abstractions, no new Rust/host/persistence contracts, and no per-city thumbnail field.
- HPA-677 should be marked Done only after the implementation and verification, not when the planning-only PR is created.
