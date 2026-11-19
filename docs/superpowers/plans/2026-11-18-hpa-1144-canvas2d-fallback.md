# HPA-1144 — Canvas2D gameplay fallback: implementation plan

**Ticket:** https://linear.app/cwchanap/issue/HPA-1144/add-canvas2d-gameplay-fallback-when-webgpu-is-unavailable  
**Design:** [Canvas2D fallback design](../specs/2026-11-18-hpa-1144-canvas2d-fallback-design.md)  
**Review:** [PR #85 design review](https://github.com/cwchanap/Caelum/pull/85) (2026-11-18).  
**Delivery:** **Exactly one PR for this ticket: PR #85.** This is a draft planning commit. Add the implementation, tests, browser MCP end-to-end evidence and screenshots to **the same branch and PR**, not a separate implementation PR.

## Scope and invariants

Keep WebGPU preferred; Canvas2D is selected only when WebGPU startup capability/setup is unavailable. Never hide asset errors, GPU pipeline bugs or other runtime failures; unexpected WebGPU device loss remains fatal. One shared frame/host, game engine, tick loop, mouse/drag/picking/camera code, Svelte shell and persistence. No second map renderer/tessellation system, new package, art/SFX, or 5k-vehicle Canvas2D target.

### Checkpoint 1 — Mechanical rename and small shared type seam

- Rename `src/runtime/createWebGpuHost.ts` → `src/runtime/createGameHost.ts`, `WebGpuHostContext` → `GameHostContext`, `createWebGpuHostWithRenderer` → `createGameHostWithRenderer`, and replace the production factory with `createGameHost`. One **mechanical commit on this PR**; update all direct runtime, test helper, benchmark and E2E imports without aliases.
- Add `src/render/gameplayRenderer.ts` for only the shared `RenderFrame`/batch/stats/RGBA capture types, `GameplayRenderer` methods, `kind: "webgpu" | "canvas2d"`, and optional `lost` promise. Move `SPRITE_INSTANCE_FLOATS = 10`, `VEHICLE_INSTANCE_FLOATS = 11`, `VEHICLE_LANE_OFFSET_PX = 8`, and `VEHICLE_RIM_PX = 1.5` here. Import those constants from both concrete renderers and current batch builders; reference the new rim constant in WGSL.
- Keep `buildFrame()`, resize, camera, input, 10 Hz tick admission, rAF interpolation, remount, pointer mapping, and device-loss handling in the **single existing host**. Subscribe to `renderer.lost` only when present. Set `data-renderer` on each newly mounted gameplay canvas.
- In this same task's implementation commits, update `CLAUDE.md` (the old-host names and "Canvas2D gameplay rendering is deleted" statement), `docs/architecture.md` (runtime/display host and the distinction between the removed old Canvas renderer and new limited fallback), and stale host comments. This is necessary documentation for a breaking in-repo rename—not a separate task/PR.

**Acceptance:** existing GPU renderer, host/camera/picking/rAF and tests compile with the neutral contract; no behavioral change from the rename alone.

### Checkpoint 2 — One validated sprite load and narrow startup selection

- Export `loadSpriteImages()` from `src/render/webgpu/spriteAtlas.ts`, reusing `SPRITE_LAYER_SOURCES` and `decodeSpriteImage`. Return the 15 layer-indexed original images/source dimensions. The existing GPU atlas uploader takes these already decoded images; Canvas2D uses exactly the same table. No copied asset map or extra decode pass.
- Decode **before** and **outside** the fallback catch so damaged images remain a startup error. Then probe `navigator.gpu` and `getContext("webgpu")` on a **disposable canvas**, attempt adapter/device/format setup in a narrowly scoped catch, and choose Canvas2D only for these setup failures. Destroy an acquired device when capability setup fails. Leave sprite-upload/pipeline/renderer creation **outside that catch**, cleanup and rethrow its unexpected errors.
- Construct the existing host around the chosen concrete renderer. The real game canvas is created only on `mount()`, preserving the context-sticky invariant. Canvas2D context unavailable at mount throws clearly through the existing fatal shell path; don't add a recursive fallback or dedicated exhaustive test.

**Acceptance (focused factory tests, not a giant matrix):**
- [ ] Successful WebGPU startup yields `data-renderer="webgpu"`.
- [ ] Missing API/context or null/rejected adapter/device (parameterized where appropriate) yields `canvas2d`.
- [ ] Device acquired then capability setup fails ⇒ `device.destroy()` and Canvas2D.
- [ ] Invalid asset decoding ⇒ terminal error, **not** Canvas2D; genuine pipeline bugs remain terminal.
- [ ] Mid-session device loss still reports fatal; deliberate destroy is ignored.

Use existing `createFakeDevice` / `createFakeCanvas` helpers in `tests/helpers/fakeWebGpu.ts`. No extra renderer factory abstraction.

### Checkpoint 3 — Minimal seam-safe Canvas2D painter

Add `src/render/canvas2d/renderer.ts` implementing `GameplayRenderer`, with no new dependency or its own scheduling.

- At **every render**, restore identity transform, `imageSmoothingEnabled=true`, `imageSmoothingQuality="high"`, then clear/fill `colors.empty`. The host's `canvas.width/height` reset makes a configure-only smoothing setting incorrect.
- Clip-to-device-pixel project each existing solid triangle; **batch each consecutive same-RGBA run** into a single nonzero fill path with consistent triangle winding. Preserve batch/stage order and alpha (cracks/radial spokes/double-alpha are bugs).
- Draw each validated sprite source rectangle via a y-down rotated/scaled `drawImage`; verify non-square 90° footprints and transparent insets. No new atlas, per-tile drawing code or duplicate URL list.
- Draw rotated vehicles with the shared 8-world-px lane offset and 1.5-world-px white rim as an **even-odd outer-minus-inner ring**, then a nonoverlapping colored inner body. Apply the same instance alpha to each region (no washed-out double-blending).
- `captureFrame(frame)` calls the **same** `render(frame)` on the configured visible 2D canvas and reads its backing store with `getImageData` into the shared row-tight RGBA shape. No offscreen capture surface. Return `null` while unconfigured; unconfigure/remount and destroy are small/idempotent.
- Keep the required order `solids → sprites → overSprites → vehicles → overVehicles`; no static bitmap cache unless the benchmark in Checkpoint 5 identifies a real problem.

**Acceptance:** one recording-2D-context unit test asserts same-color fill run count/order, correct alpha/color, rotated rectangular sprite `drawImage` crop/transform, vehicle rim/body transforms and source instance data; one host/renderer lifecycle test covers configure, resize/DPR reset, remount, render/capture and teardown. jsdom lacks native Canvas2D raster output, so **pixel correctness belongs in Playwright**. Do not add a `canvas` test package or tests for every sprite/layer/tree permutation.

### Checkpoint 4 — Focused real-browser E2E, existing pixel oracles, MCP visual evidence

- Add `tests/e2e/canvasFallback.spec.ts`: before navigation, use `page.addInitScript` to hide `navigator.gpu` (not a production force flag). With **real browser/WASM gameplay**, use existing `createDefaultCity` helpers; assert `canvas[data-renderer="canvas2d"]`, no Shell Error, nonblank capture pixels; build **one** structure and assert the Rust-backed state changes; run a City Library → gameplay remount and viewport resize and recapture. Add a road-quad diagonal pixel probe for visible seams/alpha. Avoid rerunning the whole input, route, camera and overlays suite.
- Run the **existing** `mapSprites.spec.ts` rotated large-house footprint + transparent-inset known-color oracle on the forced fallback path (parameterize its single general test or share the helper); keep its mip-filter calibration WebGPU-only.
- Reuse `expectRoadsideStopAnchors` from `tests/e2e/routes.spec.ts` by extracting the existing known-color probe into a test helper, then call it once under fallback for a roadside stop. Keep the existing full routes suite on WebGPU; don't clone it.
- Perform the **same minimal fallback browser E2E once through browser automation MCP** on Chromium/one platform. It must assert renderer selection, real gameplay mutation, remount and resize, rather than being only screenshots. Capture **one Fit and one zoomed fallback screenshot** (no ticket UI mockup), automatically inspect screenshot framing and HUD/map labels, and attach evidence to PR #85. Use `debugCaptureFrame()` known-color and diagonal probes as the objective pixel visual check. **Do not** gate on WebGPU-vs-Canvas2D pixel-diff snapshots. The Playwright scenario is repeatable CI regression coverage; MCP is the task's recorded acceptance execution, **not a CI service dependency**. No human acceptance.

**Acceptance:** Chromium/real WASM passes the small new forced-fallback smoke and reused sprite/stop pixel oracles; unchanged WebGPU E2E suite passes. Screenshot evidence shows nonblank Fit/zoom map, aligned DOM HUD, correctly cropped sprites, stop markers, and no road-quad seams. One platform is sufficient, with no platform-specific changes.

### Checkpoint 5 — Measure once, regression, and close out PR

- Add **one Canvas2D 200-visible-vehicle row** to the existing `tests/e2e/rendererScale.ts` benchmark harness (e.g., a renderer query selector), using the real shared host and scene. Preserve the existing 200/5,000 WebGPU rows. Record Canvas2D **median/p95 CPU frame time** in PR evidence with **no artificial threshold**.
- If Canvas2D on a Large scene is clearly unusable, evaluate a **single** cached static-layer bitmap in `canvas2d/renderer.ts` based on observed numbers; otherwise do not add complexity. Keep any justified fix on **this same PR**.
- Run `bun run check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, and existing CI. The real WASM E2E supplies backend-through-browser coverage; no Rust simulation changes are expected.
- Include final MCP run evidence + Fit/zoom screenshot visual check, performance row, and test summary in **PR #85**. Mark ready for review only after the implementation and acceptance results are complete.

## Risks and limits

| Risk | Mitigation / decision |
| --- | --- |
| Triangle antialias seams/double alpha | Same-color run paths, normalized winding, real-browser diagonal/known-color probes |
| CPU cost on Large maps | Real 200-vehicle measurement; postpone bitmap cache until justified |
| DPR/context-state reset | Reapply smoothing and identity every draw; resize/remount browser coverage |
| Dimmed vehicle outline changes color | Even-odd disjoint ring/body at one instance alpha |
| Different Canvas2D and GPU filtering | Known-color oracle and screenshot inspection, no brittle cross-backend diff |
| Tauri/WebView variants may differ | Shared code, one Chromium platform acceptance; do not claim native validation that did not run |

## End-to-end definition of done (no human gate)

- [ ] WebGPU stays default, and documented missing capability/setup cases select Canvas2D; fatal error boundaries and device cleanup are proven.
- [ ] Browser/WASM fallback smoke has **real gameplay state change**, correct canvas selection, remount/resize and nonblank map.
- [ ] Existing rotated-building/transparent-inset and roadside-marker pixel oracles also pass with fallback, plus seam/opacity sample.
- [ ] Browser **MCP** executes that same smoke on one platform and captures **Fit + zoomed screenshots**; automated visual assertions cover frame content and HUD alignment, with no mockup dependency.
- [ ] Existing WebGPU tests, host lifecycle and loss semantics remain correct; unit tests use a recording context rather than a new raster library.
- [ ] Canvas2D 200-vehicle benchmark row recorded; no made-up performance threshold or premature cache.
- [ ] `CLAUDE.md`, `docs/architecture.md`, and host comments describe both the old renderer deletion and the new fallback accurately.
- [ ] Typecheck, lint, unit, browser E2E and CI green. **Implementation + tests + evidence all within PR #85**, no new art/SFX.

## Expected files

`src/render/gameplayRenderer.ts` (new); rename `src/runtime/createWebGpuHost.ts` → `createGameHost.ts`; adjust `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts`, `src/render/webgpu/renderer.ts`, `src/render/webgpu/vehicleInstances.ts`, `src/render/webgpu/spriteAtlas.ts`; add `src/render/canvas2d/renderer.ts`; update host/GPU test imports and recording-context tests; `tests/e2e/canvasFallback.spec.ts`, reuse `tests/e2e/mapSprites.spec.ts` and `routes.spec.ts` known-color helpers; augment the existing scale harness; update `CLAUDE.md`, `docs/architecture.md`, and stale comments.

**Explicit non-goals:** WebGL2/PixiJS, hot GPU-loss switching, a second game renderer/domain geometry subsystem, 5k-vehicle Canvas2D parity, native multi-platform E2E matrix, screenshot diffs against GPU, compatibility aliases, new art/SFX, or a second PR.
