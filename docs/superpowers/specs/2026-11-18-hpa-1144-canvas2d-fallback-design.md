# HPA-1144 — Canvas2D gameplay fallback: design

**Status:** Design for the single HPA-1144 draft/implementation PR.  
**Baseline:** `main` inspected on 2026-11-18 (recent commit `b734e719`).  
**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Related:** HPA-640 (completed WebGPU cutover); this ticket intentionally revises its earlier no-fallback decision.

## Problem and outcome

The production `createWebGpuHost()` currently rejects when `navigator.gpu` is missing or `requestAdapter()` yields null. The bootstrap in `src/main.ts` then displays a terminal shell error. Device acquisition failure can do the same. This makes otherwise supported browser/WASM gameplay inaccessible.

Keep WebGPU as the normal high-throughput path. When WebGPU *startup capability/setup* is unavailable, select a small Canvas2D presentation renderer **once**, before gameplay starts. The Rust engine, WASM/native backends, simulation ticks, state, saving, map input/camera, Svelte UI, and scene-building code remain shared.

### Behavior matrix

| Situation | Expected behavior |
| --- | --- |
| Working WebGPU | WebGPU renderer; `data-renderer="webgpu"` |
| Missing `navigator.gpu` | Boot playable Canvas2D; `data-renderer="canvas2d"` |
| `getContext("webgpu")` fails on a disposable probe canvas | Boot Canvas2D |
| Adapter request rejects or returns null | Boot Canvas2D |
| Device request rejects; usable device/format cannot be obtained | Boot Canvas2D; destroy any acquired device |
| Canvas2D context unavailable | Clear terminal startup error (no recursive fallback) |
| Corrupt/missing/incompatible sprite image | Clear terminal startup error on **both** renderers |
| Unexpected WebGPU device loss *after* startup | Existing terminal error; **no live renderer swap** |
| City Library ↔ gameplay remount | Reuse selected renderer; no second simulation/animation loop |

## Verified architecture and boundaries

- `src/runtime/createWebGpuHost.ts` contains the 10 Hz tick admission, rAF display, state interpolation, camera, pointer/drag/pan/zoom, remount/cleanup, scene caching, and `buildFrame()`. Preserve this single host.
- `buildFrame()` already emits clip-space **six-float triangles**, projected **10-float sprite instances**, projected **11-float vehicle instances**, and ordered painter stages. It uses `buildMapBatch`, `buildTransitBatch`, `buildOverlayRanges`, and `encodeVehicleInstances`. **Do not** reinstate the deleted Canvas gameplay/domain renderer or tessellate map primitives twice.
- `src/render/webgpu/renderer.ts` owns the actual GPU draws, device loss, and `captureFrame()`; the frame currently orders `solids → sprites → overSprites → vehicles → overVehicles`. Keep that order for Canvas2D.
- `src/render/webgpu/spriteAtlas.ts` owns the stable layer order and validates all **15** tree/building WebP sources and dimensions. Bus stops and metro stations remain procedural solids; no additional art.
- `src/runtime/createGameRuntime.ts` injects a host factory for tests, and the `RuntimeController` exports one mount/capture surface. Reuse it; no new backend, new shell state, or new game runtime.
- The WebGPU headless Linux compositor may not present canvas pixels; existing `debugCaptureFrame()`/Playwright helpers already supply a reliable RGBA pixel oracle.

## Design decisions

### 1. One small renderer-neutral seam; no backend framework

Rename `createWebGpuHost.ts` to `createGameHost.ts` and its public context/factory/with-renderer identifiers to neutral names, updating direct callers/tests (no compatibility aliases). Extract only the existing frame, stats, captured-frame and renderer method interfaces to `src/render/gameplayRenderer.ts`. The contract has:

- `configure(canvas)`, `unconfigure()`, `resize(width,height)`, `render(frame)`, `captureFrame(frame)`, `destroy()`;
- the existing ordered render-frame arrays and `{width,height,pixels: Uint8ClampedArray}` capture shape;
- an **optional** WebGPU-only `lost` promise, observed by the host only if present.

The GPU renderer implements this contract unchanged in behavior. The 2D renderer also implements it. The host retains the scene caches and `buildFrame()` and calls either renderer through the same lifecycle. Avoid plugin registries, shader translation, a new game loop, and a second camera/picking implementation.

The selected backend is fixed for the lifetime of the host. Set `nextCanvas.dataset.renderer` to `webgpu` or `canvas2d` on **every mount**, in addition to the existing `data-runtime-canvas` attribute.

### 2. Explicit capability selection before graphics assets

The production `createGameHost` asynchronously chooses a renderer:

1. Inspect `navigator.gpu`. Probe `getContext("webgpu")` on a **throwaway canvas** before committing the real game canvas. Never probe WebGPU and then ask for 2D on the *same* canvas: canvas context mode is sticky.
2. If the API/context is absent, choose Canvas2D. Otherwise, attempt `requestAdapter()`, `requestDevice()` and the preferred format. Handle only these capability/setup failures with a Canvas2D choice; release any already-created GPU device before switching.
3. **Outside the fallback catch**, decode and validate the 15 sprite sources for the chosen path, then initialize the concrete renderer. A decode/dimension error or a genuine app/render pipeline error remains a terminal startup failure, not a reason to hide it behind fallback.
4. If WebGPU initialization proceeds, create the existing GPU texture/pipelines and retain its loss signal. If Canvas2D is selected, initialize one 2D renderer with the same validated sources.
5. Build the existing shared host around the selected renderer and return it before synchronous `mountCanvas()` is called. No renderer switch later.

Make selection/catch boundaries independently testable. Do not swallow unrelated exceptions with a broad `try { createWebGpuHost(...) } catch { useCanvas() }`. Real canvas `configure` failures after a successful preflight may surface normally; no complicated mount-time renderer replacement is required.

### 3. Reuse sprite source ordering and validation

Expose one compact `loadValidatedSpriteLayers()` (or equivalent) from `spriteAtlas.ts`: a layer-indexed array of `HTMLImageElement` plus known source dimensions, using the existing URL mapping, `Image.decode()`, and dimensions check. The GPU atlas uploader consumes the same result instead of maintaining another decode table. The 2D renderer uses the loaded image and original source crop by layer, **not** a generated atlas canvas and not a copied asset list.

Use `imageSmoothingEnabled = true` and `imageSmoothingQuality = "high"`. Canvas2D may show small sampling differences from GPU mipmapped textures at extreme Fit scales; layout, source crops, alpha, and orientation must remain correct.

### 4. A deliberately straightforward Canvas2D paint path

Add `src/render/canvas2d/renderer.ts`. A configured context paints each frame in the existing order:

- Clear/fill the entire canvas in `colors.empty`; use opaque base pixels like the WebGPU clear pass.
- **Solids:** each six-float vertex is `[clipX, clipY, r, g, b, a]`. Convert to device pixels with `x = (clipX + 1) * width / 2`, `y = (1 - clipY) * height / 2`; fill successive triples as triangles using their authored color/alpha. Current CPU geometry emits a constant color per triangle. Preserve batch sequence and transparent overlays.
- **Sprites:** projected row = `[clipX, clipY, angle, halfWidthWorldPx, halfHeightWorldPx, uvX, uvY, layer, clipSx, clipSy]`. Convert origin to device pixels. Derive world-to-device-pixel factors from `clipSx * width / 2` and `-clipSy * height / 2`; translate/rotate in **y-down world orientation**, then `drawImage` the matching validated layer source with its actual source rectangle centered at the origin and scaled to twice the half extents. Preserve transparent pixels and rotations. No tile-level drawing logic.
- **Vehicles:** the corresponding 11-float rows use center, angle, half-length/width, RGBA, clip factors. Apply the same transform; render the existing centered rotated body, constant **8 world-pixel perpendicular lane offset**, and **1.5 world-pixel white outer edge**. Keep per-instance alpha and existing route-order/emphasis behavior.
- **Capture:** `captureFrame(frame)` draws the *supplied* frame to a reusable offscreen 2D canvas at the current device-pixel size and returns a copied, row-tight RGBA8 `Uint8ClampedArray` via `getImageData`. It must not depend on whether the compositor presents the visible canvas, nor modify the onscreen scene. Return null when unconfigured.
- **Cleanup:** unconfigure drops the active 2D context reference on a screen switch; destroy releases the layer references, offscreen surface, and pending resources. A remount can reconfigure on a newly created canvas.

No 5,000-vehicle performance parity requirement or special Canvas2D optimization. Do not create a per-triangle DOM node, background image loop, or second animation scheduler.

### 5. Keep input, runtime, and UI exactly shared

All renderer-independent behavior stays in the host: world/clip projection, pointer picking against drawn-frame state, route drafts, hover, drags, vehicle interpolation, camera actions, resize/DPR handling, tick throttling, and error propagation. The Svelte HUD, map text, city-library mount lifecycle and Rust/persistence contracts are unchanged.

## Test strategy and acceptance

All acceptance is **automated** and belongs in this **same draft PR** as subsequent implementation commits; no separate implementation PR or human sign-off.

1. **Startup selection (Vitest):** mock missing API, absent WebGPU context, null/rejected adapter, rejected device, format/setup failure, and Canvas2D context failure. WebGPU success remains `data-renderer="webgpu"`; supported capability failures boot `data-renderer="canvas2d"` without Shell Error. Invalid image decode and unexpected renderer errors must remain fatal. Verify device destruction for each relevant failure.
2. **2D unit/pixel tests:** assert triangle order/color/alpha, tree/building source cropping and rotations (including rectangular footprint), vehicle lane offset/white rim and rotation, overlays above/below correct layers, row-tight frame capture, resize/DPR, unconfigure/remount/destroy. Keep existing GPU shader/texture and device-loss tests.
3. **Single-platform MCP-driven browser E2E (Chromium + real WASM):** before the first navigation, inject a `navigator.gpu` override so WebGPU is unavailable. Create/load a city, confirm nonblank Canvas2D map, road/building/stop markers/sprites, hover/click/select, build or demolish, create and run a route with a moving vehicle, use Data overlay, zoom/pan/Fit, resize the viewport, enter City Library and remount. Assert actual game-state/map changes, no Shell Error, and `data-renderer="canvas2d"`. Keep normal WebGPU E2E green. One browser/platform suffices because no platform-specific code is touched.
4. **Automated visual check (no ticket mockup):** via the browser MCP capture the **same deterministic city and viewport** at (a) Fit and (b) a zoomed view showing buildings, route/vehicle and overlay, for Canvas2D and WebGPU. Use the existing `debugCaptureFrame` pixel capture for map comparisons (not Linux compositor screenshots alone), and screenshots for HUD alignment. Inspect/compare painter order, opacity, source cropping, orientation, approximate vehicle placement, overlay and text alignment; tolerate rasterization/mipmap antialiasing differences. Store screenshot/capture artifacts in the PR's test evidence; no manual visual acceptance gate.
5. **Regression:** run `bun run check`, `bun run test:unit`, `bun run test:e2e`, `bun run lint`, and repository CI. No Rust gameplay changes, no new dependency, and no generated artwork/SFX.

## Non-goals

WebGL2, PixiJS, GPU device recreation, mid-session hot fallback, backend/save changes, domain rendering duplication, new graphics abstraction platform, 5k-vehicle Canvas performance equivalence, cross-platform E2E matrix, backward-compatible symbols, new art or SFX.

## Implementation companion

See [HPA-1144 implementation plan](../plans/2026-11-18-hpa-1144-canvas2d-fallback.md). This planning commit seeds **the same draft PR** that will later contain the implementation, tests and MCP evidence.
