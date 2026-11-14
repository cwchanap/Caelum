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
| Typed texture-array loader + geometry | src/render/webgpu/spriteAtlas.ts; src/render/webgpu/mapBatch.ts | BUILDING_CATALOG footprint and the existing deterministic tree hash |
| Textured pass and lifecycle | src/render/webgpu/renderer.ts, src/runtime/createWebGpuHost.ts | Existing solid, vehicle, overlay, frame capture, picking and viewport transform |
| Regression proof | tests/e2e/newCity.spec.ts, cityLibrary.spec.ts; relevant tests/ui and tests/render files | Real WASM/browser flows and the existing host-injection test seam |

Change only necessary files; this is an ownership map, not a mandatory file count. All images already exist in src/assets/sunny-diorama.

## Task 1 — Update existing menu player-flow tests first

1. Update `tests/e2e/newCity.spec.ts`'s old `selectOption` calls to `getByRole("radio", { name: "Small Town" }).check()` / `toBeChecked()`, and likewise for size/economy. Preserve the original end-to-end Rust/WASM assertions for template, map size, starting capital, economy rules and saved-city creation. Check checked default Crossroads/Small/Standard and changing the large preview; verify disabled blank-name/busy submit, trimmed input, keyboard arrow selection and Cancel/error handling. Reuse existing fixtures.
2. Extend `tests/e2e/cityLibrary.spec.ts`'s existing save/reload/Continue flow to assert key-art/brand, **Continue [actual newest saved city name]**, avatar, saved timestamp, rename, Load, and confirmed Delete. Preserve disabled/retry behavior and first-run redirect; use distinct names so a hard-coded label cannot pass.
3. Update the focused `tests/ui/cityList.test.ts` and `tests/ui/appShell.test.ts` assertions as needed. Verify `CityPanel` still uses the same `CityList` and the correct compact style.
4. Run affected tests red on the current UI, then green after Task 2. Do not add a new generic E2E harness or screenshot-golden system.

**Proof:** Role/checked-state keyboard interactions and the real create/save/Continue/Load/Rename/Delete flows work end to end.

## Task 2 — Integrate the two menu screens, reusing their existing Svelte state

1. `CityLibraryScreen.svelte`: import `menu/city-library.webp` and the existing brand icon. Use a cover-cropped background with a foreground cream card, live Caelum wordmark/tagline, **Continue [cities[0].name]** and New City; retain the current loading, list error/Retry, empty, busy and disabled paths without a new last-city field.
2. `CityList.svelte`: render a colored initial avatar in all rows, with color derived from **city.id**, not its editable name. Keep Enter/blur rename, Escape cancel, two-click Delete and Load behaviors and current testids. Scope **all enlarged library-card layout and scrolling to `.city-library-screen` in styles.css** so the existing in-game CityPanel stays compact; do not introduce a variant prop or clone list logic.
3. `NewCityScreen.svelte`: keep the four Svelte-local states and form submit handler. Use three `<fieldset><legend>` groups with native labeled **radio inputs** bound to `templateId`, `mapSize` and `economyPreset`. Style the labels as illustrated templates, size tiles and Standard/Creative economy tiles. Use the selected template image in the right-hand large preview. Native radio keyboard arrows and checked-state replace custom aria-pressed/toggle logic. Preserve default choices, Create disabled gating and optional Cancel.
4. Keep both cards unclipped at 1024×768 and 1440×900. Reuse current CSS tokens and focus styles; do not add a library, state store, new art or rendering APIs.

**Proof:** Selected radios update image previews and create the correct real city; loading and saved-city management remain intact in Library and CityPanel.

## Task 3 — Typed asset table, mipmapped array upload, and scene instance data

1. Create a single focused `src/render/webgpu/spriteAtlas.ts`: explicitly map `Exclude<BuildingType, "busStop" | "metroStation">` to twelve imported WebPs and include the three tree variants in a stable 15-layer order. The building types remain checked by TypeScript; no `import.meta.glob` for the map sprites, new art or asset framework.
2. In the existing async production `createWebGpuHost` factory, decode all 15 images as one startup operation and validate that buildings match `BUILDING_CATALOG` native footprint dimensions × 192 pixels and trees are 192×192. Fail loudly on bad loads. Create **one** `rgba8unorm` `texture_2d_array` with `size: [576, 384, 15]` and `mipLevelCount: 5`. Reuse a small 2D canvas to draw/upload each individual image's 5 levels using `imageSmoothingQuality: "high"`. Each copied mip uses `destination: {texture, mipLevel, origin: {z: layer}, colorSpace: "srgb", premultipliedAlpha: true}`; create the texture with `TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT`. Each layer outside its image stays transparent. No shelf packer, gutters, atlas UV rectangle table, max-dimension branch, or GPU mip-render pipeline. Set sampler min/mag/mipmap filters to linear.
3. In `mapBatch.ts`, keep the existing deterministic hash/predicate in place and return `{ vertices, sprites }` from `buildMapBatch`, with **one scene cache entry** for both arrays. Emit tree instances where `drawTrees` currently emits the canopy and choose index `Math.floor(tileHash(x, y, 5) * 3)` (the hash is fractional, so `%3` is incorrect). Keep original 12–18 world-pixel canopy, tile exclusions and jitter.
4. Emit **one sprite instance per building** with the **rotated footprint center**, *unrotated* native width/height × tileSize/2 as world half-extents, and angle from `building.rotation`. Per instance: world origin, angle, half-extents, `uvScale=(sourceW/576, sourceH/384)`, and layer; clip-scale slots are filled by host projection. Do not swap half-extents and rotate a second time. The stable sprite row order is trees then buildings.
5. **Do not remove the procedural roofs or tree canopies yet.** Task 3 prepares the data and texture upload without changing visible output; Task 4 replaces geometry only once the textured pass is working. Unit tests cover typed mapping, image validation/mip dimensions, deterministic all-three-tree variants and exclusions, and 0/90/180/270 instance footprints.

**Proof:** The 15 existing assets are loaded into one layered texture; `buildMapBatch` returns one building instance per placed building; no visual blank period between commits.

## Task 4 — Add one explicit textured pass and replace old shapes

1. Extend `WebGpuRenderFrame` to express the actual ordered painter stages: **`solids` (structural) → `sprites` (one instanced textured draw) → `overSprites` (underRoutes/route/draft) → `vehicles` → `overVehicles`**. In `createWebGpuHost.ts:buildFrame`, move the existing `underRoutes`, route and `routeDraft` batches from `solids` to `overSprites`, with their original order. Do not infer the split from `role === "structural"` in the renderer. Update all frame fixtures in `tests/render/webgpuRenderer.test.ts` and host fakes.
2. Add a dedicated WGSL `texture_2d_array` sprite shader, **non-sRGB `rgba8unorm`** sampling, premultiplied-alpha blend (color src=`one`, dst=`one-minus-src-alpha`), sampler/bind group and one grow-only sprite instance buffer. Reuse the existing unit quad and single `encodeFrame` used by both normal rendering and `captureFrame`; leave the current vehicle/solid blend unchanged. Add `spriteInstances`/`spriteDraws` to `WebGpuRenderStats` so a nonempty sprite frame can assert **one** draw call.
3. Follow the vehicle shader's y-down world rotation and per-instance world→clip scale; in the host, reuse **one small stride/tail-parameterized instance projection loop** for both vehicles and sprites, rather than maintaining duplicate transforms. Reuse the structural scene revision/grid-mode cache for sprite rows and the same board transform used for Fit, hover, labels and picking.
4. Await/load the atlas in the existing production async `createWebGpuHost`, then pass the ready texture into synchronous `createWebGpuRenderer`. Retain the injected `createWebGpuHostWithRenderer` fake seam without requiring GPU image loading there. The renderer owns cleanup of the texture and sprite buffer; device-loss and bootstrap errors retain their existing policy.
5. **Only once a textured frame draws correctly**, remove the old flat building roofs/outlines and procedural tree canopies from `mapBatch.ts`. Draw a **single solid shadow rectangle per rotated building footprint**, rather than overlapping per-tile shadows, plus the existing tiny tree shadows. Make this cleanup in the same commit as the working sprite draw so intermediate commits remain playable.
6. Update focused renderer/host tests for texture-array bindings, mip levels, premultiplied blend, rotation, ordered stages, one sprite draw, resource cleanup and the existing frame/capture equivalence; keep route, vehicle and picking regressions green. Reuse the existing real-WebGPU pixel-test helper for the narrow E2E smoke described below.

**Proof:** GPU draws the correct textured sprites between structural and route passes, without extra per-object draws or a second renderer; capture and click/inspect behavior remain unchanged.

## Task 5 — Automated E2E, focused GPU pixel proof and release gates

**Acceptance is automated/agent-driven; there is no human sign-off criterion.**

1. **New City:** At 1024×768 and 1440×900, form controls and the large right image fit without clipping. Radio selection, native arrow keys, checked states and preview changes work. Actual Small/Medium/Large and Standard/Creative city creation returns the expected Rust map and rules.
2. **City Library:** On reload with multiple saved cities, the background, quiet left-side card, logo, named Continue, stable-ID avatar, saved time, rename, Load and confirmed Delete match the intended **City Library redesign** layout and work through real IndexedDB/WASM. CityPanel reuses the list with compact styling.
3. **Map geometry and mipmaps:** Focused unit assertions cover all four building rotations, one shadow rect, tree exclusions and reproducible variants (including all three in representative Small Town), plus one instanced sprite draw. Keep procedural stop/metro markers, line/vehicle layers and picking functional.
4. **Real WebGPU pixel oracle:** **Reuse `sampleTilePixels` from `tests/e2e/helpers.ts`**, already exercised in `routes.spec.ts`, which captures through `debugCaptureFrame()`. Add one focused new sprite test at **max zoom**: (a) sample a known transparent inset and compare with the underlying ground, proving premultiplied alpha; (b) sample the opaque extent of a rotated native 3×2 building within its expected **2×3** footprint. Use existing coordinate/viewport helpers; do not introduce a screenshot parser or pixel-golden matrix.
5. **Mockup check:** Playwright geometry assertions and screenshot artifacts for the New City and City Library reference compositions at 1024×768 and 1440×900. Review map screenshot artifacts against the **Game screen: buildings and trees as sprites** reference at **Large Fit** (strongest minification) and **max zoom** (detail). Small/Medium Fit and per-tree screenshot checks are unnecessary once mip filtering and deterministic unit checks are in place.
6. **macOS and Windows:** Existing Tauri CI packaging jobs build a macOS `.app` and Windows NSIS release with all assets bundled. Browser Playwright is the automated runtime E2E path for the shared frontend. The builds do not prove WKWebView native visual presentation; **record this limitation** rather than introducing a human native-launch acceptance gate or new cross-platform test harness. Linux CI regressions run unchanged; no Android/Linux acceptance.
7. **Standard gates:** `bun run check`, `bun run format:check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, `bun run build`; existing Rust and Tauri CI jobs unchanged.

**Proof:** The real player flows and new sprite pixels/instance statistics pass, visual layout is represented by captured artifacts, and both desktop release builds succeed.

## Risks and bounded mitigations

- **Fit-scale aliasing / image edges:** Five individually downsampled mip levels in separate texture-array layers; non-sRGB color handling and an explicit premultiplied-alpha sprite blend. Pin behavior with the existing real-WebGPU pixel-readback helper.
- **Rotation and shadows:** Native width/height plus one world-space rotation; one shadow per building footprint; renderer sample bounds and pure geometry tests.
- **Asset startup:** Decode and upload only the 15 shipped assets once before first frame; retain the existing fatal error behavior. No generic loader or fallback renderer.
- **Sharing CityList:** Reuse the one component and style only the library's parent scope; stable city.id color prevents rename flicker.
- **Scope/CI cost:** One PR, existing GitHub Actions jobs, one new pixel oracle and narrowed screenshot views; no new art, persistence, native IPC or new testing framework.

## Exit criteria and PR workflow

- This **same draft PR** gets the reviewed planning changes and, subsequently, implementation and tests. No separate implementation PR or visual-art task is needed because HPA-676 already delivered all images.
- Automated new-city/library/renderer flows, new mip/rotation tests, existing regression gates, three reference compositions and macOS/Windows Tauri packaging all pass. Native WKWebView presentation limitations are documented rather than misrepresented as tested.
- No new Rust/wire/save contracts, generic asset framework, per-city thumbnail field, screenshot goldens or human acceptance step.
- Mark HPA-677 Done **only** after implementation and verification; planning-only PR is not completion.

