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

Use `menu/city-library.webp` as a full-viewport, cover-cropped background, with its quiet left area behind a warm, legible foreground card. Reuse the existing Sunny Diorama tokens and the finished brand icon with a live-text **Caelum** wordmark and one-line tagline.

- Prominent **Continue [most recently saved city name]** and **New City** actions; Continue uses existing `cities[0]` and only appears when a saved city exists. Preserve loading, list errors and Retry.
- Each `CitySummary` shows a colored initial avatar, editable name, existing saved timestamp, Load and two-click Delete. Choose the avatar color deterministically from `city.id` (not the renameable name); retain Enter/blur/Escape rename semantics and busy/disabled states. Do not add city metadata or thumbnail fields.
- The saved-city list scrolls within the foreground card while primary actions remain legible at 1024×768 and 1440×900.
- `CityList.svelte` is shared with the in-game CityPanel. Render the avatar in both contexts but keep the CityPanel compact by scoping larger cards, margins and scrolling to `.city-library-screen` in styles.css. **No variant prop or duplicate city-list implementation.**

The first-run redirect to New City, error handling and existing save/load transitions stay unchanged.

## 2. New City

Use the shipped template art to make one responsive two-column card matching the attached New City mockup.

**Left:** city-name input, three illustrated template choices (Blank Grid, Crossroads, Small Town), three sizes (Small 28×18, Medium 56×36, Large 84×54), two economies (Standard — “Money matters”; Creative — “Build for free”), Create City, optional Cancel and inline errors. **Right:** a large preview of the selected template image; changing a choice updates it immediately without invoking Rust.

Preserve the Svelte-local `name`, `templateId`, `mapSize` and `economyPreset` states, defaults Crossroads/Small/Standard, and the existing `NewCityRequest`. **Each set of mutually exclusive choices uses `<fieldset><legend>…</legend>` with native labeled `<input type="radio" bind:group={...}>` tiles**, not aria-pressed toggle buttons. This gives the correct radio semantics, checked state and arrow-key navigation for free. Keep visible focus, text labels and decorative images with empty alt text. Create remains disabled for a trimmed blank name and during busy work; keep Cancel/error behavior. The card fits at supported desktop widths.

## 3. Textured buildings and trees

### Typed sprite table and one mipmapped texture array

Create one focused `src/render/webgpu/spriteAtlas.ts` module:

- Explicitly import the twelve sprite-bearing building WebPs into a typed `Record<Exclude<BuildingType, "busStop" | "metroStation">, string>`, plus the three tree variants. `busStop` and `metroStation` retain their procedural markers; **busTerminal** uses its 3×2 building sprite. Native footprint dimensions come only from `BUILDING_CATALOG`.
- Decode all 15 local images once, validate their pixel dimensions against 192px per native footprint tile and 192×192 for trees, and fail startup on a missing/invalid asset or upload. No fallback texture or flat roofs when art is unavailable.
- Use **one WebGPU `texture_2d_array` sized 576×384×15, format `rgba8unorm`, with five mip levels (0–4)**. Each image occupies the top-left of its own transparent layer; each sprite instance carries its layer index and `uvScale=(sourceWidth/576, sourceHeight/384)`. No shelf packer, gutters, mip bleed between neighbors or redundant size-limit check.
- For each image, generate each downscaled mip using a temporary 2D canvas with `imageSmoothingQuality: "high"`, drawing at the source dimensions divided by `2^level`. Upload the levels via `queue.copyExternalImageToTexture` with destination `mipLevel`, `origin.z` (array layer), `colorSpace: "srgb"` and **`premultipliedAlpha: true`**. The texture uses `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`, as the external-image copy path requires; the canvas is only for upload, not gameplay rendering.
- Use linear min/mag filtering with `mipmapFilter: "linear"`. Preserve the existing solid pipeline's numeric color convention by sampling a **non-sRGB `rgba8unorm`** sprite texture, and apply a separate **premultiplied-alpha blend** (color src=`one`, dst=`one-minus-src-alpha`, corresponding alpha blend) in the sprite pipeline. Keep the existing solid/vehicle straight-alpha blend unchanged.
- Await decode/upload in the existing async `createWebGpuHost` factory, pass ready GPU assets into synchronous `createWebGpuRenderer`, and keep the fake-renderer `createWebGpuHostWithRenderer` test seam unchanged. Destroy the texture and instance buffer with existing renderer resources, preserving fatal startup and device-loss behavior.

### Placement, caching and explicit painter order

- Let **`buildMapBatch(state, gridMode)` return `{ vertices, sprites }`**. There is only one existing consumer of the deterministic tree predicate and hash, so emit tree sprite instances directly where `drawTrees` currently creates procedural canopies—do not extract a tree helper. Keep exclusions for roads, track, zones, roundabouts and occupied buildings, and the original 12–18 world-pixel canopy size. Choose a variant with **`Math.floor(tileHash(x, y, 5) * 3)`**: `tileHash` returns a fraction in [0,1), so `tileHash % 3` is invalid as an array index.
- For each `PlacedBuilding`, emit **one** instance. Use the center of its **rotated occupied footprint** as origin, **unrotated** native `BUILDING_CATALOG` width/height × `tileSize/2` as half-extents, and angle `rotation * Math.PI / 180` in y-down world space. A 90° rotation already produces a 2×3 occupied quad from a native 3×2; don't swap extents twice. Build/inspect hit-testing stays on the existing game state.
- Continue to draw one warm +3/+3 solid shadow under each tree/building; for a building, use **one footprint-sized shadow rect**, not overlapping per-tile rects visible through transparent art. Keep procedural roofs and tree canopies until the new sprite draw is verified; remove them **together with enabling the sprite pass**, not in an earlier task.
- Reuse the existing `scene:<revision>:<gridMode>` cache for both the solid vertices and sprite instance rows. Keep per-frame camera projection in the host. Generalize the existing small instance-origin projection loop with stride/tail parameters for vehicles and sprites, instead of forking a near-identical transform.
- Represent painter order explicitly in `WebGpuRenderFrame`: **`solids` (terrain/roads/track/shadows) → `sprites` (trees then buildings, one instanced draw) → `overSprites` (underRoutes, routes, draft overlays) → `vehicles` → `overVehicles`**. The host owns this split rather than inferring it from a batch role inside the renderer. Use the existing shared `encodeFrame` for render and offscreen capture and add `spriteInstances`/`spriteDraws` to `WebGpuRenderStats`.
- Retain Fit/pan/zoom, picking, transit stop/station markers, vehicle/route presentation and GPU readback. No new Rust, wire, save contract or WebGPU host.

Remove flat building roofs/outlines and procedural tree canopies in Task 4, **only after** the textured pass is drawing, so each intermediate commit remains playable.

## Responsibilities and change boundaries

| Concern | Expected files | Deliberate non-changes |
| --- | --- | --- |
| Library visuals/actions | src/components/city/CityLibraryScreen.svelte, CityList.svelte, src/styles.css | No save/store or CitySummary changes |
| New City selections | src/components/NewCityScreen.svelte, src/styles.css | No new template generator; same NewCityRequest |
| Texture array and sprite placement | src/render/webgpu/spriteAtlas.ts, mapBatch.ts | No generated art or duplicate tree helper |
| One textured GPU draw | src/render/webgpu/renderer.ts, src/runtime/createWebGpuHost.ts | Keep vehicle/route pipelines, WebGPU host, board/picking transforms |
| Tests | Existing city E2Es/UI tests, map batch/renderer/host tests | No screenshot-golden suite or new testing infrastructure |

## Acceptance proof (automated, end to end)

1. **New City (browser Playwright):** Use `getByRole("radio", { name: ... }).check()` and `toBeChecked()` for illustrated template, size and economy tiles. Confirm the right preview, correct defaults, blank-name/busy gates, and actual Rust-backed city state; existing Create/Cancel/error flows remain usable.
2. **City Library (browser Playwright):** After saving two cities and reloading, the key art/brand, **Continue [latest saved city]**, initial/avatar color, saved time, rename, Load and two-click Delete work. The shared in-game CityPanel remains compact and working.
3. **GPU/unit:** Each building has one instance with correct footprint at all 4 rotations; one shadow rect per building; tree placements and variants are deterministic with all three variants in a representative Small Town map; all 15 layers/mip sizes are valid; a nonempty sprite frame has **one instanced sprite draw**. Transit markers, routes, vehicles, Fit and picking remain intact.
4. **Real WebGPU pixel oracle:** Reuse the **existing** `tests/e2e/helpers.ts:sampleTilePixels` → `debugCaptureFrame()` pipeline already used by `tests/e2e/routes.spec.ts`. At close zoom, sample (a) a known transparent building inset, which should show underlying ground, and (b) the opaque bounds of a rotated native 3×2 building, which should fall within a 2×3 tile footprint. Use one focused test, not a screenshot parser.
5. **Mockup visual check:** At 1024×768 and 1440×900, Playwright asserts unclipped library/new-city composition and saves screenshot artifacts for comparison to the corresponding HPA-677 mockups. For the map, capture **Large Fit** (maximum downscale) and **max zoom** (close detail), not a redundant Small/Medium Fit screenshot matrix. No brittle pixel-golden styling suite or human acceptance gate.
6. **Supported desktop paths:** Existing macOS .app and Windows NSIS Tauri bundle CI jobs succeed with the shipped assets. Browser/WASM Playwright remains automated interactive end-to-end coverage for their shared frontend. Packaging CI alone does **not** verify WKWebView runtime visuals; record this limitation, without adding manual native-launch acceptance or a new framework. No Android/Linux acceptance matrix.

## Risks, decisions and out of scope

- **Mipmaps/alpha/color:** One fixed-size layered texture with five CPU-generated mips prevents cross-sprite bleed and Fit-scale aliasing. Use `rgba8unorm`, premultiplied-alpha uploads/blending and focused WebGPU readback instead of new rendering infrastructure.
- **Startup:** Decode and upload all fifteen existing images once in the async host factory; errors follow the existing fatal/shell-error path. No fallback, per-asset manager or incremental loader.
- **UI reuse:** Native radio groups, avatar colors derived from stable city IDs and parent-scoped CityList CSS avoid extra state/components and regressions in CityPanel.
- **Out of scope:** HPA-696 dock and Build art, any new art/SFX, app-icon regeneration, native/core simulation, wire/snapshot/persistence changes, per-city thumbnail data, new renderer/backends, screenshot goldens and manual desktop acceptance.

