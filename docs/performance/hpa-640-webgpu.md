# HPA-640 WebGPU Gameplay Renderer Baselines

Canvas2D rows recorded before the WebGPU cutover. `vehicles-200` is the
current/near-term context; `vehicles-5000` is the HPA-336/HPA-640 roadmap
presentation ceiling. Wall-clock values are documentation evidence only — no
timing threshold and no decision gate.

## Command

`CAELUM_RENDER_BENCH=1 playwright test tests/e2e/rendererScale.spec.ts --project=chromium`
(alias `bun run bench:render`)

The benchmark page (`tests/e2e/rendererScale.html`) draws today's
`renderGame()` on a fixed 1280×800 Canvas over the renderer-only scale fixture
(`buildRenderScaleState`, a renderer stress proxy composed from the shared test
helpers — no Rust simulation actors), warms up 30 frames, and measures 120
frames of CPU draw time. The spec skips in normal E2E.

## Reference environment

- Machine: Apple M1 Pro, macOS 26.6.2 (arm64)
- Browser: headless Chromium via Playwright 1.59.1 (software GL, not a performance run in a controlled GPU lab)

## Canvas rows (Task 0)

| Fixture       | Vehicles | Frames | Median CPU ms | p95 CPU ms |
| ------------- | -------: | -----: | ------------: | ---------: |
| vehicles-200  |      200 |    120 |         0.500 |      0.600 |
| vehicles-5000 |    5,000 |    120 |         6.000 |      6.500 |

## Contract interpretation

- The 200-vehicle row reflects the current gameplay scale; the 5,000-vehicle row
  is the ceiling the batched renderer must hold without changing the
  `PresentationUpdate`/`GameSnapshot` contracts.
- Later HPA-640 tasks append their rows to this file as the WebGPU path lands.

## Production cutover gates (Task 4)

### Chromium (full Playwright through the WebGPU production path)

`bun run test:e2e` after switching the production default to `createWebGpuHost`:
27 passed, 1 skipped (the renderer-scale benchmark spec skips by design). The
road-marker oracle in `routes.spec.ts` was retargeted from the Canvas2D fillRect
trace to probing the presented WebGPU canvas (PNG decode + pixel sampling of a
10×10 world-pixel marker blob), preserving the original assertion: a filled
bus-colored marker renders at each passenger stop and never at the road-access
tile. No build/track/demolish, route-edit, overlay, save/restore, pointer,
resize, or simulation-control assertion was weakened.

### Tauri / WKWebView smoke (non-interactive session)

`bun run tauri:dev` on macOS 26.6.2 (arm64): the native shell (caelum-core +
tauri/wry/tao, 392 crates) compiled clean in the dev profile and launched
`target/debug/caelum`; the app process stayed alive with the Vite dev server
serving the frontend (HTTP 200) and zero error/panic lines in the captured
stdout/stderr. The session was locked (login window, no on-screen window, no
assistive access), so the following remain **unverified non-interactively** and
need a human smoke pass before Canvas deletion: visible map render in
WKWebView, WKWebView WebGPU adapter availability, resize/pointer alignment,
build/select/drag input, overlay/route layering, and visibly continuous moving
vehicles.
