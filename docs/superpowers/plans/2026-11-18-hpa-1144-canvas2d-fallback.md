# HPA-1144 — Canvas2D gameplay fallback: implementation plan

**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Design:** [Canvas2D fallback design](../specs/2026-11-18-hpa-1144-canvas2d-fallback-design.md)  
**Review:** [PR #85 design reviews](https://github.com/cwchanap/Caelum/pull/85) (rounds 1 and 2, 2026-11-18).  
**Delivery:** **Exactly one PR for this ticket: PR #85.** This is a draft planning commit. Add the implementation, tests, browser MCP end-to-end evidence and screenshots to **the same branch and PR**, not a separate implementation PR.

## Scope and invariants

Keep WebGPU preferred; Canvas2D is selected only when WebGPU startup capability/setup is unavailable. Never hide asset errors, GPU pipeline bugs or other runtime failures; unexpected WebGPU device loss remains fatal. One shared frame/host, game engine, tick loop, mouse/drag/picking/camera code, Svelte shell and persistence. No second map renderer/tessellation system, new package, art/SFX, or 5k-vehicle Canvas2D target.


### Checkpoint 1 — Mechanical rename, shared types/constants and documentation (runnable)

- Make a **mechanical commit on this same PR** renaming `src/runtime/createWebGpuHost.ts` → `src/runtime/createGameHost.ts`, `WebGpuHostContext` → `GameHostContext`, `createWebGpuHostWithRenderer` → `createGameHostWithRenderer`, and the production `createWebGpuHost` → `createGameHost` (still WebGPU-only until Checkpoint 3). Update all imports/callers without compatibility aliases, including `src/runtime/createGameRuntime.ts`, runtime types, render tests, `tests/e2e/rendererScale.ts`, and **`src/render/webgpu/pickMapTarget.ts`**.
- Add `src/render/gameplayRenderer.ts` holding only shared `RenderFrame`, batches/stats/RGBA8 capture types, `GameplayRenderer` methods, `kind: "webgpu" | "canvas2d"`, optional `lost` signal, and `SPRITE_INSTANCE_FLOATS = 10`, `VEHICLE_INSTANCE_FLOATS = 11`, `VEHICLE_LANE_OFFSET_PX = 8`, `VEHICLE_RIM_PX = 1.5`. Update both GPUs' actual WGSL rim/offset expressions and map/picking instance consumers to use these constants.
- Update all test fakes and constructors to supply renderer `kind`, particularly **`tests/helpers/gameHost.ts:createNoopWebGpuRenderer()`** (and direct `WebGpuRenderer` fakes). Keep existing host's scene construction, rAF, pointer/camera, tick admission, resize, frame capture, remount and optional device loss unchanged.
- Update **`CLAUDE.md`, `docs/architecture.md` and stale host comments in this same code checkpoint** to use the neutral host name and explain that the *former full Canvas2D gameplay renderer* was deleted by HPA-640, while HPA-1144 introduces a new, limited fallback. Describe intended behavior as planned until the actual 2D renderer is wired in Checkpoint 3.

**Gate:** `bun run check && bun run test:unit`. Existing GPU/host/rAF/loss tests must pass with the neutral interface **before** proceeding. No logic/painter changes yet.


### Checkpoint 2 — Shared sprite images + concrete Canvas2D painter (runnable)

**Build the renderer before adding the production fallback factory**. This checkpoint adds independent, directly tested 2D rendering capability and does not change default app startup.

- In `src/render/webgpu/spriteAtlas.ts`, expose **`loadSpriteImages(): Promise<readonly HTMLImageElement[]>`** using the existing `SPRITE_LAYER_SOURCES` and `decodeSpriteImage`; images are already dimension-checked and in stable 15-layer order. Change GPU uploader to **`createSpriteAtlasTexture(device, images): GPUTexture`**: it only uploads the decoded images, synchronously. Update its three known in-repo consumers: the production host (later finished in Checkpoint 3), `tests/e2e/rendererScale.ts`, and `tests/render/spriteAtlas.test.ts`. Ensure the uploader destroys a partially created texture if an upload throws.
- Add `src/render/canvas2d/renderer.ts` implementing `GameplayRenderer` with the already projected frame: opaque clear, grouped **same-RGBA/winding-normalized solid-triangle runs**, rotated sprites from validated original images, and correctly alpha-composited vehicles.
- Use **`drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, …)`**, never `uvScale * atlasWidth` for a source rectangle: float32 UVs can make 192.0000057 exceed the 192-pixel image. An invalid sprite layer must throw, not silently omit an object.
- At **every render** restore identity transform, `globalAlpha=1`, `imageSmoothingEnabled=true`, and `imageSmoothingQuality="high"` (backing-store resize resets them). After the **sprite** draw loop reset identity/`globalAlpha` before `overSprites`; after the **vehicle** loop reset again before `overVehicles`. Preserve painter order `solids → sprites → overSprites → vehicles → overVehicles`.
- Vehicles use shared 8-world-px lane offset and 1.5-world-px white rim as **disjoint even-odd ring + interior body**, same per-instance alpha (avoid washing out dimmed vehicles). When `hx <= VEHICLE_RIM_PX` or `hy <= VEHICLE_RIM_PX`, **skip the inner body** and draw the fully white outline as the GPU shader does.
- `captureFrame(frame)`: `render(frame)` on the configured game canvas, then `getImageData` for row-tight RGBA pixels; no offscreen canvas. `unconfigure`/remount/destroy remain idempotent. No per-tile rendering, separate loop or new dependency.

**Gate:** One recording-2D-context unit test for solid run count/order and alpha, transformed/cropped non-square sprite with missing-layer failure, vehicle rim/tiny-extents, and inter-stage resets; one lifecycle test covers resize/DPR smoothing, remount and capture/cleanup. jsdom has no rasterization package: real pixels are tested in Playwright. Run **`bun run check && bun run test:unit`** before Checkpoint 3.


### Checkpoint 3 — Wire startup capability selection into the existing host (runnable)

- In production `createGameHost`, call `loadSpriteImages()` **before** the fallback catch so bad assets remain fatal. Probe WebGPU on a disposable **16×16 canvas**; inside a narrow capability try check `navigator.gpu`, `getContext("webgpu")`, adapter/device/format, then **`probeContext.configure({device,format,alphaMode:"opaque"})` and `probeContext.unconfigure()`**. If these setup operations fail, destroy any acquired device and use the already implemented Canvas2D renderer. A null 2D context at actual mount reports a clear fatal error; there is no second fallback.
- **Outside the fallback catch**, call `createSpriteAtlasTexture(device, images)` and create the GPU renderer. Clean up a partially created texture on upload failure; if renderer/pipeline creation fails after receiving the texture, explicitly destroy **texture and device** and rethrow. Do not accidentally classify GPU upload or shader errors as capability failures.
- Use the single shared host around the chosen renderer; set `data-renderer="webgpu|canvas2d"` on every new canvas mount. Keep unexpected post-startup device loss terminal, and ignore intentional destruction during `destroy()`. Do not re-run capability selection across City Library remounts.

**Gate:** Four focused factory test groups with current fake-device/context helpers: WebGPU success; parameterized absent/rejected API/context/adapter/device including **probe configure failure**; owned-device cleanup on failed capability setup; invalid sprite or GPU pipeline error remains fatal, with correct cleanup. Run **`bun run check && bun run test:unit`**. Keep normal GPU tests passing.


### Checkpoint 4 — One reproducible browser/WASM E2E + MCP visual acceptance

- Add `tests/e2e/canvasFallback.spec.ts`: before navigation, use `page.addInitScript` to hide `navigator.gpu` (no production renderer override). Run **real Chromium/WASM gameplay**, create a city, assert `data-renderer="canvas2d"` and no Shell Error, make **one** Rust-backed construction mutation, assert state/map changes and nonblank capture; check a road-quad diagonal pixel sample for antialias seams; navigate City Library and back; resize and recapture. Do **not** mirror the full route/picking/overlay/camera suite.
- Reuse the **existing** `tests/e2e/mapSprites.spec.ts` rotated largeHouse opaque-footprint/transparent-inset known-color oracle on Canvas2D, keeping mip-specific proof GPU-only. Extract/reuse the `tests/e2e/routes.spec.ts:expectRoadsideStopAnchors` known-color stop marker probe under fallback (no cloned full routes flow). Keep the normal WebGPU E2E suite green.
- **MCP requirement, without redundant manual replays:** perform one short browser-MCP end-to-end **acceptance/visual pass of the real running fallback app**, verifying the Canvas2D renderer is selected and a valid city/map/HUD scene is visible; capture **Fit and zoomed screenshots** (no ticket mockup). Inspect framing, map-text/HUD alignment and visibly correct map art. **Do not repeat Playwright's mutation/remount/resize steps manually through MCP**; those are deterministic, reproducible assertions in the one E2E spec. Use existing `debugCaptureFrame()` known-color pixel oracles for precise raster proof, rather than GPU-vs-2D screenshot diff. Record the MCP pass + screenshots in PR #85. No human acceptance; no MCP-as-a-CI-service requirement.

**Gate:** Playwright Chromium/real-WASM fallback smoke and reused sprite/marker oracles pass; normal WebGPU suite passes. MCP visual acceptance produces Fit/zoom screenshots with automated verification of visible city and UI placement, on one platform only.


### Checkpoint 5 — **Large-map** Canvas2D benchmark, regression, and finish PR

- The existing `tests/helpers/renderScaleState.ts:buildRenderScaleState(200)` uses `createTestGameState()` on a **28×18 Small** fixture. That cannot quantify a Large map's structural rendering cost. Add a narrowly scoped `mapSize: "large"` option (possibly a simple test-only rectangular map constructor in `tests/helpers/gameState.ts`) and build an **84×54, 4,536-tile** fixture with representative roads, buildings, deterministic trees and 200 visible vehicles. Preserve the current Small fixture and WebGPU 200/5,000 rows unchanged. Avoid a new benchmark framework.
- In `tests/e2e/rendererScale.ts`, add one renderer/fixture selection for Canvas2D Large with 200 vehicles using the real shared host. **Guard `device?.queue.onSubmittedWorkDone()`** for the GPU branch; for Canvas2D, do not claim GPU queue completion or nonzero GPU-upload bytes. Report `renderer`, `mapSize`, `vehicleCount`, and **median/p95 CPU frame milliseconds** so the row cannot be mistaken for the Small WebGPU result.
- Record the measurements on **PR #85**, without an arbitrary numeric pass/fail threshold. Consider a cached static layer only if Large-map CPU numbers materially show it is needed; skip that complexity otherwise.
- Run `bun run check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, and existing CI. Include the browser-MCP visual acceptance evidence/screenshot artifacts and final test summary. No Rust/backend changes expected; real WASM browser E2E covers the backend path. Mark **this same PR** ready for review only once implementation, tests and evidence are complete.


## Risks and limits

| Risk | Mitigation / decision |
| --- | --- |
| Context exists but swapchain fails | Disposable canvas `configure`/`unconfigure` preflight; capability fallback without hiding pipeline/asset errors |
| Sprite source rect float overshoot | Use validated image `naturalWidth`/`naturalHeight` directly; throw on missing layer |
| Inter-stage transform/alpha leakage | Reset identity and `globalAlpha=1` after sprites/vehicles; restore smoothing on each render |
| Tiny/dimmed vehicle outlines | Guard inner rectangle against half-extents <= rim; disjoint same-alpha ring/body |
| Triangle seams and double alpha | Same-color winding-normalized paths and real-browser quad-diagonal known-color probe |
| False CPU confidence from Small fixture | Large 84×54 + representative roads/buildings/trees + 200 visible vehicles; GPU queue wait guarded |
| Different Canvas2D and GPU filtering | Reuse known-color sprite/marker pixel oracles and screenshots; no fragile screenshot diff |
| Native Tauri/WebView differences | Browser/WASM covers shared path on one platform; do not claim native validation not performed |


## End-to-end definition of done (no human gate)

- [ ] Each checkpoint is independently compilable/unit-tested: **`bun run check && bun run test:unit` after Checkpoints 1, 2 and 3**. The 2D renderer exists before the factory imports/selects it.
- [ ] WebGPU is the default; startup capability probe includes **`configure`/`unconfigure`** and gracefully selects Canvas2D when setup fails; owned-device cleanup occurs; sprite/upload/pipeline bugs stay fatal.
- [ ] 2D renderer draws seam-safe triangle runs, correctly sized/cropped rotated images and missing-layer failures; resets transform/globalAlpha between stages and smoothing after resize; draws tiny/dimmed vehicle rims correctly; capture/lifecycle work.
- [ ] Real Chromium/WASM Playwright fallback E2E makes **one real state mutation** and covers fallback renderer selection, nonblank pixels, road diagonal seam, library remount and resize; reused known-color building/stop pixel oracles also pass.
- [ ] Browser **MCP** runs one focused end-to-end visual acceptance pass on the real fallback app and produces **Fit + zoomed screenshots** with automatic map/HUD layout inspection; avoid repeating the full Playwright smoke by hand. No mockup and no human approval.
- [ ] A genuine **84×54 Large** Canvas2D scene with **200 visible vehicles**, roads, buildings and trees is benchmarked and `renderer/mapSize/median/p95` recorded; GPU-only queue calls guarded. No arbitrary performance target or premature caching.
- [ ] `CLAUDE.md`, `docs/architecture.md`, host comments, `pickMapTarget.ts` and no-op renderer fixtures are updated as required; no old-name compatibility aliases.
- [ ] Existing WebGPU host/loss and app E2E tests stay green; check, lint, unit, Playwright E2E and CI green. All implementation, tests and MCP evidence remain **within PR #85**, no art/SFX task.


## Expected files

`src/render/gameplayRenderer.ts` (new); rename `src/runtime/createWebGpuHost.ts` → `createGameHost.ts`; `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts`, `src/render/webgpu/renderer.ts`, **`src/render/webgpu/pickMapTarget.ts`**, `src/render/webgpu/vehicleInstances.ts`, `src/render/webgpu/spriteAtlas.ts`; add `src/render/canvas2d/renderer.ts`; update **`tests/helpers/gameHost.ts`** and host/factory/GPU/sprite atlas tests; `tests/e2e/canvasFallback.spec.ts`, reuse `tests/e2e/mapSprites.spec.ts` and `routes.spec.ts` pixel oracles; `tests/helpers/renderScaleState.ts`, possibly `tests/helpers/gameState.ts`, `tests/e2e/rendererScale.ts` and benchmark spec; `CLAUDE.md`, `docs/architecture.md`, source comments.

**Explicit non-goals:** WebGL2/PixiJS, hot GPU-loss switching, a second game renderer/domain geometry subsystem, 5k-vehicle Canvas2D parity, native multi-platform E2E matrix, screenshot diffs against GPU, compatibility aliases, new art/SFX, or a second PR.
