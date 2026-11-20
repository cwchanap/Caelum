# HPA-1144 — Canvas2D gameplay fallback: design

**Status:** Revised after two design-review rounds on [PR #85](https://github.com/cwchanap/Caelum/pull/85). Planning documentation only; implementation stays on this same draft PR.  
**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Related:** HPA-640 completed the WebGPU cutover and intentionally removed the former Canvas gameplay renderer. This issue adds a **new, narrow fallback** without restoring that renderer.

## Outcome and constraints

Before this change, unavailable WebGPU at startup made `createWebGpuHost()` reject and the browser show a Shell Error. Caelum should run its existing Rust-backed gameplay and Svelte UI in browsers/WebViews that have Canvas2D but not WebGPU. This can also benefit desktop Tauri/WebView environments where WebGPU is unavailable; **Chromium coverage does not prove every native WebView combination**.

WebGPU remains the preferred high-throughput renderer. Select a Canvas2D fallback **once at startup**, only for WebGPU API/context/adapter/device/format capability/setup failures. An unexpected WebGPU device loss **after** startup remains terminal. Invalid sprite assets, GPU pipeline bugs and unrelated app errors are terminal—not swallowed by the fallback.

Keep **one** host, the same render-frame builder, the same runtime/backend, and the same UI. No duplicate scene tessellation, game loop, route logic, camera or picking subsystem; no new artwork, audio, or rendering dependency. Canvas2D has no 5,000-vehicle performance-parity target.

## Current source of truth

- `src/runtime/createGameHost.ts`: `GameHost` lifecycle, `buildFrame()` (roughly lines 436–520), map world-to-clip projection, rAF display, 10 Hz one-in-flight ticks, pointer/drag/zoom/resize, capture, remount and device-loss forwarding. (Written against the design-baseline name `createWebGpuHost.ts`; the host was renamed during implementation.)
- `src/render/webgpu/mapBatch.ts`, `transitBatch.ts`, `overlayBatch.ts`, `vehicleInstances.ts`: already build world-space triangles and vehicle/sprite instances. **Keep them** and project once in the shared host.
- `src/render/webgpu/renderer.ts`: existing ordered `solids → sprites → overSprites → vehicles → overVehicles` frame and WebGPU shaders, capture, GPU resource management.
- `src/render/webgpu/spriteAtlas.ts`: ordered 15 tree/building URLs, source dimensions, validated `Image.decode()`. Bus stops and metro stations are still procedural triangles.
- `src/render/boardTransform.ts`: assigns canvas `width`/`height` during resize, which **resets all Canvas2D context state**.
- `tests/e2e/mapSprites.spec.ts` and `tests/e2e/routes.spec.ts`: existing analytically known-color / footprint / stop-marker capture oracles via `debugCaptureFrame()`. Headless WebGPU presentation screenshots can be unreliable on Linux, unlike capture-frame data.

## Design

### Shared contract and host (no plugin framework)

Move only renderer-neutral `RenderFrame`, batch/stat/captured-frame types and renderer methods to `src/render/gameplayRenderer.ts`. The contract contains:

- `kind: "webgpu" | "canvas2d"` and optional WebGPU-only `lost` signal;
- `configure(canvas)`, `unconfigure()`, `resize(width,height)`, `render(frame)`, `captureFrame(frame)`, `destroy()`;
- the existing RGBA8 `{ width, height, pixels: Uint8ClampedArray }` capture shape and ordered painter stages.

Move **`SPRITE_INSTANCE_FLOATS = 10`**, **`VEHICLE_INSTANCE_FLOATS = 11`**, **`VEHICLE_LANE_OFFSET_PX = 8`**, and **`VEHICLE_RIM_PX = 1.5`** into the shared module. Both renderers and the existing instance builders import them; WebGPU WGSL interpolates the shared rim/offset values instead of hardcoding an independent number. Do **not** move the world-space batch builders out of `webgpu/` just for naming symmetry.

Rename `src/runtime/createWebGpuHost.ts` to `src/runtime/createGameHost.ts` and its public context/factory helpers to neutral names **without compatibility aliases**. Do the mechanical rename in a separate commit **within the same PR**. Keep all input, camera, state interpolation, batching, rAF, tick admission, pointer picking and lifecycle inside the same host. Observe `renderer.lost` only if present. Every mounted gameplay canvas has `data-runtime-canvas="true"` and `data-renderer="webgpu|canvas2d"`; persist the selection over City Library → city remounts.


### Startup selection and strict error boundary

The concrete Canvas2D renderer must exist **before** the production factory is wired to select it (implementation Checkpoints 2 → 3). The factory's GPU acquisition and capability preflight are deliberately separate from asset loading, atlas uploading and pipeline construction.

1. **Before any fallback catch**, call `loadSpriteImages(): Promise<readonly HTMLImageElement[]>` from `spriteAtlas.ts`. It reuses `SPRITE_LAYER_SOURCES` and `decodeSpriteImage` to validate the shipped 15 files/dimensions once, in stable layer order. A bad asset remains terminal, never a reason to fall back. Do not add a second metadata wrapper: `image.naturalWidth`/`naturalHeight` are already validated.
2. Probe startup **capability** on a **throwaway 16×16 canvas** so requesting WebGPU cannot poison the real gameplay canvas's 2D mode. Inside one small setup try: check `navigator.gpu`, request adapter/device, obtain preferred canvas format and `getContext("webgpu")`, then **`probeContext.configure({ device, format, alphaMode: "opaque" })` and `probeContext.unconfigure()`**. A null/rejected adapter/device or context/configure/unconfigure failure selects Canvas2D; destroy any acquired device first. Use `finally` where appropriate so the disposable context cannot stay configured after a failed probe. This specifically catches browsers/WebViews that expose a GPU context but cannot set up the swapchain. It does not promise every later real-canvas failure is recoverable.
3. **Outside the capability catch**, call synchronous `createSpriteAtlasTexture(device, images)` to upload already-decoded images and create the WebGPU renderer/pipelines. The atlas uploader cleans up a partially created texture on its own failure; if renderer construction subsequently throws, destroy the returned atlas texture and acquired device before rethrowing. **Never fall back on atlas upload, texture or shader/pipeline bugs.** This is the existing WebGPU fast path with assets decoded once, not two pipelines with different validation.
4. On a capability failure, construct the existing `src/render/canvas2d/renderer.ts` with those same images. If the gameplay canvas's `getContext("2d")` later fails at mount, surface the terminal setup error. There is no retry/recursive fallback.
5. Construct **the same shared host** with the selected concrete renderer. The host factory is async; public `mountCanvas()` stays synchronous after runtime creation. Host selection survives City Library ↔ active-city remounts. Unexpected mid-session GPU device loss remains fatal.

Use a small factory test table: GPU success, unavailable/rejected capability (including **configure throwing**), acquired-device cleanup, and bad sprite/pipeline errors that remain terminal. The normal WebGPU fake context already provides `configure`/`unconfigure`; reuse it instead of adding a fake graphics framework.


### Canvas2D renderer: small, but seam-safe

Add `src/render/canvas2d/renderer.ts` that paints the **already projected** render frame in the existing stage order:

1. At **every** `render(frame)` (not only `configure()`), set the identity transform and `globalAlpha = 1`, restore `imageSmoothingEnabled = true` and `imageSmoothingQuality = "high"`; `canvas.width/height` resets all context state. Fill the entire backing store opaquely with `colors.empty`.
2. For solids, convert clip to device pixels (`x = (clipX + 1) * width/2`, `y = (1 - clipY) * height/2`). **Accumulate consecutive equal-RGBA triangles per batch/stage in one fill path**, normalize winding, and fill once per run. Individual triangle antialiasing creates quad diagonals, disc spokes and translucent overlaps; never merge across different colors or painter stages.
3. For sprites, use the existing projected 10-float origin/angle/half-extents/UV/layer/clip-scale data to position and rotate in y-down world orientation. Use **`drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, …)`**, with source dimensions from the **validated image**, *not* `Math.round(uvScale * SPRITE_ATLAS_WIDTH)` or the raw product: `Float32` quantization can make 192/576 × 576 slightly greater than 192. Throw for any invalid sprite layer instead of quietly skipping a missing image. This prevents WebKit cropping errors without duplicating the atlas layout.
4. After the **sprite loop**, explicitly reset `setTransform(1,0,0,1,0,0)` and `globalAlpha=1` before `overSprites` solids; after the **vehicle loop**, reset them again before `overVehicles`. One frame-start reset is not sufficient when using `setTransform` for individual sprites/vehicles. Restore per-item alpha to avoid tint leaking between instances. Preserve `solids → sprites → overSprites → vehicles → overVehicles`.
5. Vehicles use projected 11-float rows, shared `VEHICLE_LANE_OFFSET_PX = 8`, and `VEHICLE_RIM_PX = 1.5`. Draw the white rim as an **even-odd outer-minus-inner ring** and the nonoverlapping colored body at the *same instance alpha* (avoid body-over-rim double blending). **Only draw an inner body when both half-extents exceed the rim width**; otherwise the entire tiny rectangle is white, like the WGSL fragment shader. Reset transforms/alpha after the loop.
6. `captureFrame(frame)` calls the same `render(frame)` on the configured 2D canvas, then reads `getImageData(0,0,width,height)` into the shared RGBA8 shape; no offscreen canvas. Return `null` while unconfigured. `unconfigure` drops the active context; `destroy` releases image references idempotently; remount can configure a new canvas.

There is no renderer-specific scheduler, bitmap cache, DOM scene, new asset, or 2D geometry-building path.


### Known risks and mitigation

- **GPU context exists but cannot configure:** test `configure`/`unconfigure` on a disposable canvas during capability selection; keep pipeline/atlas failures outside the fallback catch. A later real-canvas failure remains a clear fatal error.
- **Image size/transform bugs:** validated `naturalWidth`/`naturalHeight` rather than `Float32` UV reverse arithmetic; explicit identity/`globalAlpha` resets at painter boundaries and tiny-rim guard.
- **Seams, alpha and sampling:** same-color run batching, normalized winding, disjoint vehicle rim, reset smoothing on every paint, and known-color browser pixel oracles. No cross-renderer screenshot-diff threshold.
- **Large-map CPU frame cost:** the current `buildRenderScaleState(200)` fixture creates a **Small 28×18 map**. It cannot measure 84×54 structural cost. Add a Large-map option with **84×54 tiles, representative roads/buildings/trees and 200 visible vehicles** to the existing test fixture, leaving normal 200/5,000 GPU benchmarks unchanged. Measure and record Canvas2D median/p95 host CPU-frame times with **no numeric threshold**; include map dimensions and renderer in the row. Do not call `GPUDevice.queue.onSubmittedWorkDone()` on the 2D branch, or pretend it uploaded GPU buffers. Only consider a static-layer bitmap cache if measured Large-map cost warrants it.
- **Platform coverage:** Chromium/real WASM validates shared drawing behavior, but does not prove every Tauri/WKWebView configuration.


## Lean automated verification and acceptance

Everything belongs in **draft PR #85**. Each code checkpoint is compilable and unit-tested before advancing. One Chromium/platform is sufficient because no platform-specific code changes are proposed.

1. **Shared contract/host:** mechanical rename and neutral types/constants first; update all direct imports including `src/render/webgpu/pickMapTarget.ts` and no-op renderer fixtures in `tests/helpers/gameHost.ts`. Run `bun run check && bun run test:unit` (and existing loss/lifecycle tests) after Checkpoint 1.
2. **Sprite and 2D renderer:** `loadSpriteImages` reuses asset validation; `createSpriteAtlasTexture(device, images)` performs synchronous upload of decoded images. Build the Canvas2D renderer **before** referencing it from the factory. A recording context verifies batched triangles, stage reset, rectangular sprite crop/rotation, missing-layer error, tiny/dimmed vehicle rim and resize/capture lifecycle. Re-run `bun run check && bun run test:unit` after Checkpoint 2. No native jsdom raster output or new `canvas` dependency.
3. **Factory:** disposable canvas probes real WebGPU `configure`/`unconfigure` as well as adapter/device/format; capability failures switch to Canvas2D and clean up the device. Texture/pipeline failures stay fatal with texture/device cleanup. Focused unit cases cover these boundaries. Re-run `bun run check && bun run test:unit` after Checkpoint 3.
4. **Reproducible Playwright Chromium/real WASM:** one short `canvasFallback.spec.ts` hides `navigator.gpu` before navigation using `page.addInitScript`, creates a city, asserts `data-renderer="canvas2d"` and no Shell Error, makes **one real gameplay mutation**, samples nonblank map and a quad diagonal, verifies City Library remount and backing-store resize. Reuse `mapSprites.spec.ts` rotated footprint/transparent inset and `routes.spec.ts` stop-marker known-color oracles for the fallback; keep GPU-specific mip calibration on GPU. Do not duplicate the whole routes/camera/overlay E2E matrix.
5. **MCP-driven acceptance and visual evidence:** use a browser MCP once to inspect **Fit and zoomed Canvas2D screenshot output**, assert renderer selection and visible city/HUD alignment, and record the final result on PR #85. The reproducible Playwright E2E supplies detailed gameplay and pixel assertions; **do not manually replay its build/remount/resize operations through MCP**. This is a narrowly scoped MCP end-to-end acceptance/visual pass on the real app, not a separate test suite or a CI service dependency. No HPA-1144 mockup or human acceptance gate.
6. **Large-map performance and regression:** run one **84×54 Canvas2D, 200-vehicle** benchmark, with GPU-queue waits guarded to GPU only; record renderer/map dimensions and median/p95 CPU time without a fabricated performance threshold. Then `bun run check`, lint, unit, Playwright E2E and project CI; update `CLAUDE.md`, `docs/architecture.md`, host comments in the same PR. No backend/Rust change expected; real WASM E2E proves the backend-through-browser path.

## Non-goals

WebGL2, PixiJS, hot swapping after device loss, recreating a failed WebGPU device, a second gameplay/domain renderer or loop, GPU/Canvas2D 5k-vehicle parity, a browser compatibility matrix, new artwork/SFX, an image-diff acceptance threshold, backward-compatibility aliases, or a multi-PR delivery plan.

See [the implementation plan](../plans/2026-11-18-hpa-1144-canvas2d-fallback.md) for file-level checkpoints.
