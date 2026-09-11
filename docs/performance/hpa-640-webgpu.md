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
