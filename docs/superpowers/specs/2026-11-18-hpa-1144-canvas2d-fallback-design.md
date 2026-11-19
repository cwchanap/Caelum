# HPA-1144 — Canvas2D gameplay fallback: design

**Status:** Revised after the 2026-11-18 design review on [PR #85](https://github.com/cwchanap/Caelum/pull/85). Planning documentation only; implementation stays on this same draft PR.  
**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Related:** HPA-640 completed the WebGPU cutover and intentionally removed the former Canvas gameplay renderer. This issue adds a **new, narrow fallback** without restoring that renderer.

## Outcome and constraints

At present, unavailable WebGPU at startup makes `createWebGpuHost()` reject and the browser show a Shell Error. Caelum should run its existing Rust-backed gameplay and Svelte UI in browsers/WebViews that have Canvas2D but not WebGPU. This can also benefit desktop Tauri/WebView environments where WebGPU is unavailable; **Chromium coverage does not prove every native WebView combination**.

WebGPU remains the preferred high-throughput renderer. Select a Canvas2D fallback **once at startup**, only for WebGPU API/context/adapter/device/format capability/setup failures. An unexpected WebGPU device loss **after** startup remains terminal. Invalid sprite assets, GPU pipeline bugs and unrelated app errors are terminal—not swallowed by the fallback.

Keep **one** host, the same render-frame builder, the same runtime/backend, and the same UI. No duplicate scene tessellation, game loop, route logic, camera or picking subsystem; no new artwork, audio, or rendering dependency. Canvas2D has no 5,000-vehicle performance-parity target.

## Current source of truth

- `src/runtime/createWebGpuHost.ts`: `GameHost` lifecycle, `buildFrame()` (roughly lines 436–520), map world-to-clip projection, rAF display, 10 Hz one-in-flight ticks, pointer/drag/zoom/resize, capture, remount and device-loss forwarding.
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

1. **Before any fallback catch**, call shared `loadSpriteImages()` from `spriteAtlas.ts`. It returns the validated, layer-indexed original `HTMLImageElement` sources and dimensions. Bad decode/dimensions throw a useful fatal error. Pass this same loaded set to GPU texture upload or Canvas2D; no duplicate URL list or re-decode.
2. Check `navigator.gpu` and a disposable canvas's `getContext("webgpu")`; never probe WebGPU on the actual mounted gameplay canvas because its chosen context type is sticky. Attempt `requestAdapter()`, `requestDevice()`, and `getPreferredCanvasFormat()` **within one narrowly scoped capability/setup try**. Missing/null/rejected capability is a fallback signal; destroy an already acquired device on failure.
3. **Outside that fallback catch**, create the GPU atlas/pipelines/renderer using the loaded images and acquired device. A GPU sprite-upload/pipeline/renderer bug remains fatal; clean up GPU resources on failure, but **do not** start Canvas2D to conceal it.
4. For a capability failure, construct the Canvas2D renderer from the same decoded images. If its actual `getContext("2d")` at `mount()` returns null, throw a clear terminal setup error; do not chain another fallback.
5. Construct **the same shared host** with either concrete renderer. The host factory is async, while the existing public `mountCanvas()` stays synchronous once the runtime is created. No mid-game renderer switch.

A few focused factory tests should cover the distinct decision boundaries without building a full combinatorial matrix: working GPU; absent/failed capability (small table including null/rejected adapter and device); device acquired then format/setup failure with destruction; bad sprite image fails fatally. The context-error branch is an ordinary clear throw, not a separate test suite.

### Canvas2D renderer: small, but seam-safe

Add `src/render/canvas2d/renderer.ts` that paints the **already projected** render frame in existing stage order:

1. At **every** `render(frame)` call (not only `configure()`), restore the identity transform and `imageSmoothingEnabled = true`, `imageSmoothingQuality = "high"`; a `canvas.width/height` assignment resets context state. Fill an opaque `colors.empty` background.
2. For each solid batch, convert clip coordinates to backing pixels: `x = (clipX + 1) * width/2`, `y = (1 - clipY) * height/2`. **Accumulate consecutive equal-RGBA triangles in one `Path2D` or beginPath/fill path per run**, preserving batch/painter boundaries and authored color/alpha. Normalize triangle winding (swap the two corners when signed area is negative) for consistent nonzero filling. **Fill once per run**: independent per-triangle antialiasing introduces cracks/diagonal seams on quads and spokes in circle fans, and double alpha at joins in translucent overlays. Do not merge different colors or stages; no second geometry model.
3. Sprites use their existing projected 10-float row: clip-space origin, world-space angle and half extents, UV scale, layer index, clip factors. Convert origin to device pixels; apply y-down world rotation/scale with `setTransform` (or save/translate/rotate/scale), then `drawImage` from that layer's validated source rectangle. Cropping and transparency must work on rotated rectangular buildings as well as trees. No sprite atlas canvas in the fallback.
4. Vehicles use their existing 11-float row and shared 8-world-pixel perpendicular offset. Paint the **white outer 1.5-world-pixel rim as an even-odd rectangular ring**, then paint the **non-overlapping** inner colored body at the same instance alpha, after the shared rotation. Do **not** lay a semi-transparent colored rectangle over a semi-transparent white rectangle: doing so washes out dimmed vehicles versus WGSL.
5. `captureFrame(frame)`: call the renderer's normal `render(frame)` on its current configured 2D backing store, then return `getImageData(0,0,width,height).data` copied into the shared RGBA8 shape. No second offscreen canvas is required. As a debug readback it may refresh the visible canvas; it must return `null` while unconfigured.
6. `unconfigure()` drops the context reference so an existing game host can mount a fresh canvas; `destroy()` drops sprite references and is idempotent. No renderer-specific scheduler, bitmap cache, DOM scene or new dependency.

### Known risks and mitigation

- **Seams, alpha and source sampling:** same-color run batching, winding normalization, even-odd vehicle rims, smoothing reset at every paint, plus existing real-browser known-color pixel oracles. Avoid brittle cross-renderer image-diff thresholds.
- **Large-map CPU frame cost:** the host currently repaints on rAF, and projected arrays allocate per draw. Reuse the current renderer-scale harness for **one Canvas2D 200-vehicle row** on its real scene and record median/p95 CPU frame cost in PR evidence; **no numeric performance threshold**. Add a static-layer bitmap cache only if measurement demonstrates a significant problem, in this same renderer and same PR if needed; do not preemptively introduce it.
- **Platform coverage:** one browser/WASM Chromium path demonstrates the shared rendering code; it is not an assertion of native WKWebView availability or parity.

## Lean automated verification and acceptance

Implementation and verification remain **on this one draft PR**. The CI tests are reproducible; a single MCP-driven browser run and screenshots provide end-to-end acceptance/evidence without duplicating the entire gameplay suite.

1. **Host/factory unit:** four groups—WebGPU success, unavailable capability (parameterized missing API/context, null/rejected adapter, rejected device), acquired-device cleanup on setup failure, and invalid sprite fatal. Preserve existing WebGPU loss, host lifecycle, rAF and tick tests.
2. **Canvas2D recording-context unit:** one representative frame asserts same-color triangle batching and painter order, rotated rectangular sprite source rectangle, alpha-safe vehicle rim, and smoothing reset; one small test covers configure/resize/remount/capture/dispose. Use a mocked/recording context because jsdom has no native 2D pixel renderer. **No `canvas` package or new test dependency.**
3. **Reproducible Playwright Chromium/WASM E2E:** one **new**, short forced-fallback smoke test using `page.addInitScript` before navigation to hide `navigator.gpu`: create a city, assert `data-renderer="canvas2d"` and no Shell Error, build **one** structure (real backend mutation), verify captured nonblank map and a probe across a road/quad diagonal (no seam), navigate City Library and reload, resize and recapture. Reuse, rather than duplicate, the existing `mapSprites.spec.ts` rotated-footprint/transparent-inset color oracle and `routes.spec.ts` `expectRoadsideStopAnchors` marker oracle on the fallback path; skip the WebGPU-specific mip-filter calibration. The normal WebGPU suite still passes.
4. **MCP browser E2E and visual acceptance:** run that **same minimal real WASM fallback smoke** through browser automation MCP on one Chromium/platform and verify the gameplay mutation and render selection; no full mirror matrix of camera, fleets, drafts or overlays. Capture a **Fit screenshot and a zoomed screenshot** of the fallback scene as PR evidence (no HPA-1144 UI mockup exists). Automatically inspect screenshot framing/HUD/map-label alignment and use `debugCaptureFrame()` known-color pixel assertions to prove visual content and lack of seams. **Do not require WebGPU-vs-Canvas2D screenshot diffs or a full screenshot matrix.** The Playwright spec is the recurring CI regression gate; the MCP run is recorded task-level acceptance evidence, not a CI infrastructure dependency. No human acceptance.
5. **Scale/regression:** record the Canvas2D 200-vehicle median/p95 row alongside existing GPU benchmark evidence (no threshold). Run `bun run check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e` and project CI. No Rust changes are expected; real WASM gameplay is exercised by browser E2E.
6. **Docs updated in the implementation commit:** revise `CLAUDE.md` (especially its `createWebGpuHost` and "Canvas2D gameplay rendering is deleted" claims), `docs/architecture.md` (§runtime/display host), and stale source comments when the new code lands. Describe the new fallback alongside the historical deletion of the **old** renderer.

## Non-goals

WebGL2, PixiJS, hot swapping after device loss, recreating a failed WebGPU device, a second gameplay/domain renderer or loop, GPU/Canvas2D 5k-vehicle parity, a browser compatibility matrix, new artwork/SFX, an image-diff acceptance threshold, backward-compatibility aliases, or a multi-PR delivery plan.

See [the implementation plan](../plans/2026-11-18-hpa-1144-canvas2d-fallback.md) for file-level checkpoints.
