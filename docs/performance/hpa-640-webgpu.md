# HPA-640 WebGPU Gameplay Renderer Baselines

Renderer rows for the HPA-640 WebGPU cutover. `vehicles-200` is the
current/near-term context; `vehicles-5000` is the HPA-336/HPA-640 roadmap
presentation ceiling. Wall-clock values are documentation evidence only — no
timing threshold and no decision gate.

## Command

`CAELUM_RENDER_BENCH=1 playwright test tests/e2e/rendererScale.spec.ts --project=chromium`
(alias `bun run bench:render`)

The benchmark page (`tests/e2e/rendererScale.html`) mounts the production
WebGPU host (`createWebGpuHostWithRenderer` over the real `createWebGpuRenderer`)
in a fixed 1280×800 board host and drives one synchronous host render per
frame over the renderer-only scale fixture (`buildRenderScaleState`, a
renderer stress proxy composed from the shared test helpers — no Rust
simulation actors), warming up 30 frames and measuring 120 frames of CPU
encode+submit time. The spec skips in normal E2E.

## Reference environment

- Machine: Apple M1 Pro, macOS 26.6.2 (arm64)
- Browser: headless Chromium via Playwright 1.59.1 (software GL, not a performance run in a controlled GPU lab)

## Evidence shapes (cadence ≠ wire ≠ renderer)

The three effects that changed display behavior are independent and must not
be credited to one another:

1. **Publication cadence.** The deleted Canvas host admitted one simulation
   tick per animation frame (~60/s at display refresh). The WebGPU host admits
   ticks at ≤10 host ticks/sec with at most one tick in flight, clamped to a
   250 ms wall-delta ceiling (design contract pinned by
   `tests/render/webGpuHost.test.ts`). This is a scheduling change, not a
   renderer property, and applies regardless of which renderer draws.
2. **Presentation wire.** Frame bytes, projection cost, and serialization are
   the HPA-544 baseline (`hpa-544-presentation-baseline.md`) and are unchanged
   by HPA-640: vehicles-5000 scene+frame is 804,523 bytes (0.834× snapshot)
   with 496 µs projection / 1,203 µs serialize. WebGPU consumes the same
   `PresentationUpdate` rows.
3. **Renderer.** The rows below compare the two renderers at identical
   scenes/sizes and are the only rows that measure WebGPU vs Canvas2D work.

## Canvas rows (Task 0, deleted renderer)

| Fixture       | Vehicles | Frames | Median CPU ms | p95 CPU ms |
| ------------- | -------: | -----: | ------------: | ---------: |
| vehicles-200  |      200 |    120 |         0.500 |      0.600 |
| vehicles-5000 |    5,000 |    120 |         6.000 |      6.500 |

## WebGPU rows (Task 5, production path)

Whole-board viewport, so every presented vehicle is visible: encoded
instances equal presented vehicles (no viewport culling at this board size).
One instanced vehicle draw per frame; solid draws are the non-empty painter
batches (scene + routes; overlay ranges are empty with no active overlay).

| Fixture       | Vehicles | Frames | Median CPU ms | p95 CPU ms | Encoded instances | Vehicle upload bytes | Solid draws | Vehicle draws | Queue completed |
| ------------- | -------: | -----: | ------------: | ---------: | ----------------: | -------------------: | ----------: | ------------: | --------------: |
| vehicles-200  |      200 |    120 |         0.200 |      1.200 |               200 |                8,800 |           2 |             1 |             yes |
| vehicles-5000 |    5,000 |    120 |         0.500 |      1.400 |             5,000 |              220,000 |           2 |             1 |             yes |

## Contract interpretation

- The 200-vehicle row reflects the current gameplay scale; the 5,000-vehicle row
  is the ceiling the batched renderer must hold without changing the
  `PresentationUpdate`/`GameSnapshot` contracts.
- At the 5,000-vehicle ceiling the WebGPU path holds 0.500 ms median CPU
  encode+submit (Canvas: 6.000 ms) with a single instanced draw and one
  220,000-byte vehicle upload per frame; p95 includes batch-cache-rebuild and
  compiler jitter on the software-GL headless run.

## Production cutover gates (Task 4)

### Chromium (full Playwright through the WebGPU production path)

`bun run test:e2e` after switching the production default to `createWebGpuHost`:
27 passed, 1 skipped (the renderer-scale benchmark spec skips by design). The
road-marker oracle in `routes.spec.ts` was retargeted from the Canvas2D fillRect
trace to probing the rendered WebGPU frame: `RuntimeTestSeam.debugCaptureFrame`
re-renders the host's frame into an offscreen target and reads it back via
`copyTextureToBuffer` + `mapAsync`, sampling a 10×10 world-pixel marker blob.
Canvas-side readbacks (`toDataURL`/drawImage/screenshots) cannot serve as the
oracle — under software-Vulkan CI Chromium the canvas never reaches the
compositor and they read back blank. The original assertion is preserved: a
filled bus-colored marker renders at each passenger stop and never at the
road-access tile. No build/track/demolish, route-edit, overlay, save/restore, pointer,
resize, or simulation-control assertion was weakened.

### Tauri / WKWebView smoke (completed)

`bun run tauri:dev` on macOS 26.6.2 (arm64): the native shell (caelum-core +
tauri/wry/tao, 392 crates) compiled clean in the dev profile and launched
`target/debug/caelum`. An unlocked interactive session then completed the
full smoke through the production WebGPU path:

- WebGPU adapter/device/`bgra8unorm` context/queue submission all work in
  WKWebView.
- City create/load through the native city-store IPC; road drags land on
  exactly the intended tiles (pointer/board-transform alignment); bus stops,
  route save, headway set, and fleet deploy all behave as on Chromium.
- Simulation runs at full rAF cadence in the visible window; vehicle path
  state advances while running and is stable while paused.
- Canvas backing store tracks board resize (2560x1224 <-> 1800x1200) with
  DPR 2 via the ResizeObserver path.
- Captured-frame pixel verification: full map (board/roads/route/stops)
  renders; the bus is a distinct 30x17 device-px rectangle offset ~21 device
  px perpendicular above the route line (Canvas parity); the bus moved
  between consecutive captured frames (pixel diff confined to the vehicle).

The smoke caught two WebGPU vehicle-instance defects that Chromium e2e could
not see (its pixel probes run in the fleet-free window before `Deploy fleet`):
clip-space projection of instance extents (fullscreen-orange vehicle quads)
and half-size on-center bodies invisible inside the same-colored route line.
Both were fixed before Canvas deletion (`d154c60`, `7124c86`).
