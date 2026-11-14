# HPA-677 — Sunny Diorama map sprites and city menus — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-677/bring-the-new-art-to-the-map-and-menus  
**Baseline:** cwchanap/Caelum main @ 3a655a9dd1c0fc347f0b0cde740e7c1afc7e00a1 (after merged HPA-678, HPA-676, HPA-696)  
**Delivery:** One PR for HPA-677. This first commit is a design/plan draft; implement and test on this same PR.

## Outcome

Use the completed Sunny Diorama artwork in the two existing city-management screens and in the WebGPU map. Players can choose a visually explained new-city template, resume or manage existing cities from an illustrated library, and see textured buildings and trees while retaining all map interaction, routes, save semantics and gameplay state.

Reference visuals are the three attachments on HPA-677: **City Library redesign**, **New City redesign**, and **Game screen: buildings and trees as sprites**. The approved art inventory and style rules are already tracked under HPA-676 and src/assets/sunny-diorama/README.md. No new art is required.

## Verified current state

- App.svelte already owns the library/new-city routing, list/retry, create/load/rename/delete and busy/error gating. With no saved cities it opens New City directly. Keep these transitions.
- CityLibraryScreen.svelte and CityList.svelte contain the working Continue/Load/Rename/Delete actions, but the library is visually plain. CityList is also reused inside CityPanel, so large library-card styles must be scoped to the library.
- NewCityScreen.svelte already owns name, economyPreset, templateId and mapSize; it currently uses select controls. MAP_SIZES mirrors Rust values: Small 28×18, Medium 56×36, Large 84×54.
- CitySummary contains only id, name, createdAt and savedAt. The existing sorted list uses most-recent savedAt first. No thumbnail, population or map preview is available per city.
- HPA-696 integrated the Sunny Diorama Build category/item artwork and changed the gameplay workspaces to a right dock. It does **not** own these menus or map textures.
- createWebGpuHost.ts caches map geometry by scene revision/grid mode and supplies WebGpuRenderFrame. mapBatch.ts draws colored building footprints and deterministic procedural trees. renderer.ts currently draws solid triangles and one instanced vehicle pass; it has no textured pipeline.
- Existing art: twelve src/assets/sunny-diorama/buildings/*.webp files, three trees/tree-0*.webp, three templates/*.webp, menu/city-library.webp, and brand/app-icon-source.png. Building sprites have exactly 192 source pixels per unrotated footprint tile, trees are 192×192 and designed to render at a 12–18 world-pixel canopy diameter. Art is transparent and has no baked shadow.

## 1. City Library

Use menu/city-library.webp as a full-viewport, cover-cropped background, with its relatively quiet left side behind a warm, legible foreground card. Reuse the existing Sunny Diorama surface, accent, border, font and focus tokens from styles.css. Reuse the finished brand/app-icon-source.png as a small mark, with a live-text **Caelum** wordmark and a short one-line tagline; never bake text into the image.

Within one foreground card:

- Prominent **Continue [most recently saved city name]** and **New City** actions, driven by the existing callbacks. Only show Continue when at least one saved city exists. Keep loading/list-error/retry states usable.
- For each CitySummary, display a colored initial avatar, editable city name, the existing saved timestamp, Load and two-click Delete. Retain current rename Enter/blur/Escape, delete confirmation and busy/disabled behavior. No derived per-city preview or metadata.
- The list scrolls within the foreground card if many cities exist; the key art and primary actions remain legible at 1024×768 as well as 1440×900.
- Preserve component test IDs and CityPanel's compact CityList use; apply library-specific variants/styles rather than globally enlarging every row.

The app's current first-run redirect to New City stays unchanged. Empty/list-error behavior remains recoverable without inventing a city slot.

## 2. New City

Replace the narrow vertical selectors with a single responsive two-column card matching the linked New City mockup:

**Left column:** city-name input; three illustrated **Blank Grid**, **Crossroads** and **Small Town** template buttons using templates/*.webp; three map-size option tiles (Small 28×18, Medium 56×36, Large 84×54); two economy tiles (Standard — “Money matters”, Creative — “Build for free”); validation/error; Create City and optional Cancel.

**Right column:** a large image of the currently chosen template, from the same three provided images; update immediately when the chosen template changes. No generated map preview and no Rust call for a preview.

Keep the existing default Crossroads / Small / Standard and NewCityRequest shape. Svelte-local selection state is sufficient. Use native button type="button", aria-pressed, visible focus, text labels, and decorative alt="" imagery so selectors work with keyboard and screen readers. The form still submits exactly once with the trimmed nonempty name and unchanged busy gating. Reflow the two columns inside the supported desktop minimum width without clipping.

## 3. Textured buildings and trees

### Asset registry and atlas

Create one small, explicit map-sprite module under src/render/webgpu/:

- Map the twelve sprite-bearing BuildingType values to their existing WebP URLs. Exclude busStop and metroStation; retain their HPA-678 procedural markers. BusTerminal **does** have a 3×2 map sprite. Use BUILDING_CATALOG for native footprint dimensions, not another divergent catalogue.
- Reuse the deterministic tree placement rules now in mapBatch.ts (same tile hash, rate, center jitter, occupied/zone/road exclusions). Choose one of the three tree variants from a deterministic hash; a city saved and loaded produces the same trees.
- Pack the fifteen decoded images into a **single** atlas with deterministic shelf layout and a small transparent gutter. Construct it once at startup with a temporary 2D canvas solely as an image-packing/upload surface; this is not a Canvas2D gameplay renderer. Use one uploaded GPU texture, one sampler and one instanced textured pipeline. Do not introduce a new image-processing/build dependency or asset generation step.
- Build UV rectangles from the same layout used to place source images. Verify actual decoded dimensions against 192 px/tile and 192×192 trees and fail startup visibly on an asset/decode/texture error. Await all images and atlas upload before the first gameplay frame. Do not draw flat-color placeholders or silently skip an unavailable image.
- Keep atlas resource ownership in the renderer and destroy it with existing GPU buffers. The current device-loss and bootstrap-error flows remain authoritative.

### Placement and painter order

- Use PlacedBuilding.origin, type and rotation plus BUILDING_CATALOG native width/height. Center the unrotated textured quad in the occupied, **rotated** footprint; rotate the quad by 0/90/180/270 degrees in world space, before the world-to-clip transform. A 90/270-degree rotation swaps occupied width/height without changing the artwork's UV orientation.
- Render buildings at full occupied footprint (not one sprite per occupied tile); preserve all build/inspect picking, which is driven by the existing runtime state rather than new GPU IDs.
- Draw the existing shared, warm soft shadow treatment as simple solid geometry under each building and tree; sprites themselves must not include a shadow. Trees use 12–18 world-pixel canopy size, not a full map tile.
- Keep the painter order explicit: terrain/grid/roads/track and shadows → **one instanced sprite draw** (trees then buildings) → route/overlay/draft geometry → vehicles → existing over-vehicle UI. The one sprite draw is an additional pass within the existing render encoder, not a new WebGPU host or per-building draw calls.
- Preserve scene-revision caching: reconstruct atlas-free instance data only on relevant scene changes, then apply the existing camera transform each draw. The same frame inputs serve normal rendering and captureFrame pixel readback. No extra Rust or wire fields.

Do not draw flat building roofs or procedural tree canopies behind/over the new sprites; retain the map features that are not being replaced.

## Responsibilities and change boundaries

| Concern | Expected files | Deliberate non-changes |
| --- | --- | --- |
| Library visuals/actions | src/components/city/CityLibraryScreen.svelte, CityList.svelte, src/styles.css | No save/store or CitySummary changes |
| New City selections | src/components/NewCityScreen.svelte, src/styles.css | No new template generator; same NewCityRequest |
| Sprite atlas and placement | Small focused src/render/webgpu sprite module(s), mapBatch.ts | No generated art; no new general asset framework |
| One textured GPU draw | src/render/webgpu/renderer.ts, src/runtime/createWebGpuHost.ts | Keep vehicle/route pipelines, WebGPU host, board/picking transforms |
| Tests | Existing city E2Es/UI tests, map batch/renderer/host tests | No screenshot-golden suite or new testing infrastructure |

## Acceptance proof (automated, end to end)

1. **New City (browser Playwright):** Pick each of the three illustrated templates, three sizes and both economies via visible tiles; confirm the right preview and pressed state follow selection, Create is disabled for a blank name, and submitted choices arrive in the actual Rust-generated city state. Existing Create/Cancel/error flows still work.
2. **City Library (browser Playwright):** After creating/saving two cities and reloading, the key art/card/brand, Continue with the latest name, each colored initial/saved time, rename, Load and confirmed Delete are visible and functional. Continue loads the latest saved city, not an invented metadata field.
3. **Map (real WebGPU Playwright + focused GPU/unit tests):** An authored or grown building draws the matching texture exactly once in its footprint at 0° and 90°; bus/metro markers and vehicle/route layers remain visible; tree variety and placement are deterministic across redraw/load; picking, Fit/pan/zoom and shared render/capture paths still agree. Assert a single textured instanced draw per nonempty frame.
4. **Visual mockup checks:** At 1024×768 and 1440×900, automated layout assertions and Playwright screenshot artifacts check the three HPA-677 reference compositions: background behind readable library card, left controls/right large New City preview, and recognizable roof/tree art at Small/Medium/Large Fit plus zoom. Verify image load, visible content and lack of clipping; do not add brittle pixel-perfect styling goldens or human sign-off gates.
5. **Supported desktop release paths:** Existing CI Tauri bundle builds on **macOS (.app)** and **Windows (NSIS)** must succeed with the bundled artwork and frontend; existing browser/WASM WebGPU E2E checks remain the functional end-to-end proof for the shared Svelte/game renderer. No Android/Linux acceptance matrix.

## Risks, decisions and out of scope

- **Texture correctness:** atlas UV bleed, transparency and incorrect 90° placement are the main real risks. Use transparent gutters, a focused transform test and the existing real-WebGPU pixel/capture harness, rather than an abstraction layer.
- **Atlas startup:** roughly fifteen finite local images are cheap to decode once. Fail clearly if a required image cannot load; do not build a fallback renderer or incremental asset loader.
- **Menus share components:** isolate City Library styling to avoid regressing the in-game CityPanel; keep accessibility and busy/error behavior.
- **Out of scope:** HPA-696 dock, Build thumbnails/categories (already integrated), new art/SFX, app-icon regeneration (already shipped), native/core simulation, wire/snapshot/persistence changes, per-city thumbnails, procedural vehicle replacement, new graphics backends, screenshot golden tests, and long-tail hardening.
