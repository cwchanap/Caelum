# HPA-1144 — Canvas2D gameplay fallback: implementation plan

**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Design:** [Canvas2D fallback design](../specs/2026-11-18-hpa-1144-canvas2d-fallback-design.md)  
**Target:** `main`; baseline checked 2026-11-18 (`b734e719`).  
**PR policy:** **One ticket, one PR.** Implement this plan as additional commits to the **existing draft PR on this branch**, then mark that PR ready for review. Do not create a separate code PR or split tests into another PR.

## Scope and integration rules

Only change the presentation-host/renderer surface and its TypeScript/browser tests. Keep Rust gameplay, backend, saves, HUD/map text, controls, camera semantics, and the 10 Hz tick admission unchanged. Canvas2D is a best-effort compatibility path, not a new game renderer architecture or performance-targeted scale path. No new artwork or sound effects; the shipped 15 WebP sprites are reused.

## Implementation checkpoints (all on this PR)

### 1. Extract the minimal shared frame/renderer contract

**Change**
- Move the frame, solid/vehicle/sprite-batch, captured RGBA frame, and renderer stats/method types from `src/render/webgpu/renderer.ts` into `src/render/gameplayRenderer.ts` with renderer-neutral names.
- Keep `lost?: Promise<...>` optional; only WebGPU actually exposes the loss promise. Keep WebGPU-only GPU device/format/texture details in `src/render/webgpu/renderer.ts`.
- Rename `src/runtime/createWebGpuHost.ts` → `src/runtime/createGameHost.ts`, `WebGpuHostContext` → `GameHostContext`, and `createWebGpuHostWithRenderer` → `createGameHostWithRenderer`. Update imports in `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts`, `tests/helpers/gameHost.ts`, `tests/render/webGpuHost.test.ts`, `tests/e2e/rendererScale.ts`, and related tests. No backward-compatible re-exports.
- Keep `GameHost` lifecycle and `buildFrame()` in one place; subscribe to device loss only when the selected renderer supplies it.

**Prove**
- Existing fake renderer/host tests still exercise all pointer/camera/tick/resize/remount paths.
- Existing GPU renderer unit tests and Rust/WASM game-runtime behavior still compile and pass.
- No renderer-specific types leak into `RuntimeController` except the existing neutral capture shape.

### 2. Share sprite decoding/validation without copying the asset catalog

**Change**
- In `src/render/webgpu/spriteAtlas.ts`, expose one validated layer-indexed image-loading function (including source rectangle/dimensions) using the existing ordered layer table and `decodeSpriteImage` checks.
- Make `createSpriteAtlasTexture` use that function; let the Canvas2D renderer consume the same returned layers. Decode once per chosen renderer, not per frame.
- Ensure invalid image decode or unexpected dimensions throws with the existing asset-identifying message; this exception is *outside* startup fallback catches.

**Prove**
- Existing layer order, 15 sprites, expected native dimensions, and GPU atlas/mipmap tests pass.
- A bad image fails startup rather than silently swapping renderers or showing a partial blank map.

### 3. Add the small Canvas2D renderer and pixel tests

**Change**
- Create `src/render/canvas2d/renderer.ts` implementing the shared methods.
- Render clip-space solid triangles in original order, sprites from layer/image source rects with y-down world rotation and transparency, and vehicles as rotated bodies with existing 8-world-pixel lane offset and white 1.5-world-pixel edge.
- Preserve painter order: `solids → sprites → overSprites → vehicles → overVehicles`; copy vertex/instance data only as needed for painting.
- Use device-pixel width/height from the shared host; reuse high-quality image smoothing. Provide deterministic offscreen `captureFrame(frame)` via `getImageData` returning RGBA8 and `null` if not mounted. Keep `configure/unconfigure/destroy` idempotent and small.
- No second tessellator, no GPU shader rewrite, no render scheduler in this file, no new dependency.

**Prove**
- Unit tests with a real or recording 2D context verify colored triangles/alpha/order, all sprite layer selection and source cropping, a non-square rotated building, three trees, vehicle body/edge/offset, empty frame, DPR/resize, snapshot pixels, and teardown/remount.
- Pixel assertions tolerate Canvas2D vs WebGPU anti-aliasing differences; they must not tolerate missing sprites, wrong orientation, or displaced vehicles.

### 4. Select renderer once in the existing bootstrap path

**Change**
- Have production `createGameHost` probe WebGPU on a disposable canvas and attempt adapter/device/format setup. Use Canvas2D for absent API, unavailable context, null/rejected adapter and rejected device/format setup.
- Release an acquired device on a failed setup. Keep sprite decode, pipeline bugs, and unrelated runtime errors **outside** the fallback handler. If 2D context creation fails, expose the terminal error as today.
- Construct the normal shared host with the chosen renderer. On every `mount()`, set `data-renderer="webgpu|canvas2d"` on the same `canvas[data-runtime-canvas=true]` used by existing E2E and pointer selectors. The choice survives City Library → city → library remount.
- Keep unexpected post-boot WebGPU device loss terminal; deliberate device destruction during `destroy()` remains ignored. Do not modify `src/main.ts` error routing except if required for clear diagnostics.

**Prove**
- Focused async factory tests cover the full capability matrix and cleanup. A supported failure creates a playable 2D host; an invalid asset and a Canvas2D failure raise explicit errors.
- Existing WebGPU success/loss and no-extra-ticks tests stay green.

### 5. Add real browser/WASM end-to-end and screenshot evidence

**Change**
- Add `tests/e2e/canvasFallback.spec.ts` using existing `createDefaultCity`, `runtimeSnapshot`, `settleLayout`, map coordinate and pixel-capture helpers. Use `page.addInitScript` **before navigation** to set `navigator.gpu` unavailable; do not introduce a production `forceRenderer` feature flag.
- Complete a real WASM gameplay slice: create/load city; select and hover a road/building/stop; make a building/road edit (or demolish); create a route with service; verify moving vehicle/changed state; turn on Data overlay; zoom, pan, Fit and resize; navigate out to City Library and back. Assert no Shell Error and `data-renderer="canvas2d"` throughout. Existing normal Chromium/WebGPU E2E remains in the suite.
- Run the **MCP browser E2E** on the same Chromium browser/platform as the repo's Playwright suite (one platform is sufficient; no platform-specific renderer behavior is introduced).
- With no mockup attached for this fallback task, have the browser MCP save two **Canvas2D** screenshots/captured RGBA frames: **Fit** and **zoomed with route + sprites + vehicle + overlay**. Capture equivalent **WebGPU** frames with the same deterministic fixture, viewport, game state and camera. Use `debugCaptureFrame` for map content on Linux (canvas presentation may be black under software-Vulkan), plus full-screen screenshots for DOM HUD/map-label alignment. Record automated comparisons/inspection for sprite presence/alpha, frame order, visible stops, vehicle placement and UI alignment, allowing minor filter/antialias differences.
- Store screenshots/captures in test artifacts or the PR evidence; do **not** commit generated screenshot binaries unless the repo's existing testing pattern requires it. No manual approval gate.

**Prove**
- Automated MCP-driven browser run has real state assertions and passes both map views, interactions, camera/resize, library remount and nonblank pixel capture.
- A normal WebGPU browser run still declares `data-renderer="webgpu"`.
- Pixel/sample assertions prove source cropping/rotations, translucent overlays, and device-pixel capture orientation.

### 6. Regression/finish within the same PR

**Run**
- `bun run check`
- `bun run lint`
- `bun run test:unit`
- `bun run test:e2e` (Chromium/WebGPU plus forced fallback)
- Existing CI checks. Since Rust gameplay is untouched, do not add new Rust tests unless a surprising backend change becomes necessary; if that occurs, include a Rust-backed end-to-end test in this same PR.

**Review**
- Verify no forked game loop, no duplicated map/domain drawing, no host lifecycle leak, and no dependency/art additions.
- Attach MCP E2E + automated screenshot evidence to this same draft PR and only then mark it ready for review.

## End-to-end acceptance checklist

- [ ] **Default:** WebGPU-capable Chromium runs the real game with `data-renderer="webgpu"`; current WebGPU tests pass.
- [ ] **Fallback:** missing GPU API, probe context failure, null/rejected adapter and device/setup failures all choose Canvas2D. A forced-no-WebGPU real WASM game boots without Shell Error.
- [ ] **Failure boundaries:** missing/invalid sprite content and Canvas2D creation failure produce clear terminal errors; no silent fallback on unrelated code bugs. Acquired GPU resources are cleaned up.
- [ ] **Gameplay E2E through MCP:** create/load city, selection, construction/demolition, route service and moving vehicle, data overlay, camera zoom/pan/Fit, resize, City Library and remount all work and mutate game state correctly, on one supported platform.
- [ ] **Visual acceptance through MCP:** automatically capture and inspect Fit and zoomed scenes on Canvas2D and equivalent WebGPU frames; verify map nonblank, correct sprite/vehicle rotation and placement, alpha/painter order, stops/roads, overlays and HUD/text alignment. No mockup exists for HPA-1144, so use screenshot-based evidence; no human acceptance gate.
- [ ] **Lifecycle:** one rAF loop, same 10 Hz tick throttle, clean resize/DPR/remount/frame capture; GPU loss remains terminal.
- [ ] **Boundaries:** no Rust simulation/persistence changes, additional rendering dependency, new art/SFX, second engine/tessellation, or 5k-vehicle Canvas2D performance target.
- [ ] **Quality:** typecheck, lint, unit, browser E2E and CI green; screenshots/capture artifacts included in PR evidence.

## Files likely touched

| Area | Expected files |
| --- | --- |
| Shared contract | `src/render/gameplayRenderer.ts` (new) |
| Shared host/selection | `src/runtime/createWebGpuHost.ts` → `src/runtime/createGameHost.ts`, `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts` |
| Existing GPU | `src/render/webgpu/renderer.ts`, `src/render/webgpu/spriteAtlas.ts` |
| Fallback renderer | `src/render/canvas2d/renderer.ts` (new) |
| Unit/host | `tests/render/webGpuHost.test.ts` (rename if useful), new `tests/render/canvas2dRenderer.test.ts`, existing GPU/asset tests, `tests/helpers/gameHost.ts` |
| Browser/E2E | new `tests/e2e/canvasFallback.spec.ts`, existing helpers/renderer benchmark typing |
| Docs | This plan and its design file |

## Avoid

Do not split the implementation into another PR, build a renderer plugin framework, add a new renderer feature switch for production, restore the obsolete Canvas2D gameplay source, change game rules, or create a second art/SFX task. No art or SFX work is required.
