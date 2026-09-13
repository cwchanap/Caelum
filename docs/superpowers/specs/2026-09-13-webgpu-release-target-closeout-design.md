# HPA-48 WebGPU Release-Target Closeout Design

## Status

Planning design for HPA-48 on `main` after HPA-640 / PR #59 merged.

HPA-336's four implementation slices are now complete:

1. HPA-544 — compact presentation boundary and scale harness;
2. HPA-347 — ECS-backed latent population and exact-time schedules;
3. HPA-348 — batched route choice and traffic-demand processing;
4. HPA-640 — Canvas2D-to-WebGPU cutover, lower publication cadence, interpolation, and 5k renderer fixture.

The remaining roadmap question is narrower than another feature: **does the production WebGPU path actually sustain the 5,000-visible-vehicle target on the macOS Tauri/WKWebView release target?**

## Why HPA-336 is not ready to close yet

HPA-640 has the correct renderer shape and parity evidence, but its quantitative 5k row is from headless Chromium running software GL:

- 200 vehicles: 0.500 ms median callback CPU;
- 5,000 vehicles: 83.150 ms median callback CPU;
- 5,000 vehicles still encode exactly 5,000 instances in one vehicle draw with one 220,000-byte upload.

That row is useful evidence about the implementation and software fallback environment, but it is not the HPA-336 success claim. HPA-336 names Tauri/native as the release-performance target and requires roughly 5k visible vehicles to render smoothly there.

The HPA-640 Tauri smoke proves WKWebView WebGPU correctness, input parity, resize behavior, and visible vehicle motion. It does not run the 5k stress fixture or record frame-delivery timing.

Therefore HPA-48 closes **one evidence gap**. It does not reopen the renderer architecture decision.

## Goals

1. Run the existing production 200/5k renderer fixture inside macOS Tauri/WKWebView on the Apple M1 Pro reference machine.
2. Measure delivered-frame cadence separately from JavaScript frame-callback CPU cost.
3. Use a concrete 60 fps closeout gate for the 5k row.
4. If the current renderer already passes, make no production optimization.
5. If it fails, profile first and permit only one focused optimization direction against the measured dominant seam.
6. On pass, consolidate the existing scale evidence and close HPA-336.

## Non-goals

- No new gameplay feature.
- No camera/pan/zoom work.
- No target beyond 5,000 visible vehicles.
- No individual citizen rendering or individual private-car simulation.
- No scene graph, PixiJS, Bevy renderer, Rust `wgpu`, worker/offscreen renderer, or compute shader.
- No generic benchmark platform or macOS WebDriver framework.
- No production benchmark screen or route.
- No CI wall-clock threshold.
- No presentation wire, save schema, or simulation contract change.
- No broad renderer optimization pass when the release target already meets the gate.

## Existing seams to reuse

### Production renderer benchmark fixture

`tests/e2e/rendererScale.html` and `tests/e2e/rendererScale.ts` already provide the correct workload:

- fixed 1280×800 host;
- real `createWebGpuHostWithRenderer`;
- real `createWebGpuRenderer`;
- shared `buildRenderScaleState` fixture;
- 30 warmup frames;
- 120 measured frames;
- 200 and 5,000 vehicle rows;
- actual encoded instance, upload-byte, solid-draw, vehicle-draw, and queue-completion evidence.

Keep that as the single benchmark implementation. HPA-48 extends how it is launched and what timing it reports; it does not fork it for Tauri.

### Tauri development URL override

The current Tauri config already launches the Vite dev server at `127.0.0.1:5281`. Tauri 2's CLI `--config` merge can override only `build.devUrl`, so the benchmark can be loaded directly in the real WKWebView without adding a production application route or changing the checked-in default window configuration.

The intended command shape is equivalent to:

```text
bun tauri dev --config <JSON overriding build.devUrl to /tests/e2e/rendererScale.html?autorun=1>
```

A package script may wrap the exact quoting for the macOS reference workflow.

## Decision 1: measure delivered-frame interval, not only callback CPU

The current benchmark records CPU time around the host's delivered rAF callback. That answers how much main-thread work the host/batcher/encoder performs, but it is not itself a smoothness measurement:

- GPU/compositor pressure can reduce delivered frame cadence without making JavaScript callback CPU expensive;
- a software implementation can make callback CPU expensive while still proving the batch shape;
- HPA-336's final claim is player-visible presentation smoothness on the release target.

Extend `RendererScaleResult` with:

```ts
medianFrameIntervalMs: number;
p95FrameIntervalMs: number;
```

The existing wrapped host `requestAnimationFrame` callback already receives the browser/WebView timestamp. Record consecutive **host-delivered** callback timestamps; the helper rAF used only to await delivery must remain on the unwrapped `realRequestAnimationFrame` so it does not contaminate the sample.

Warmup establishes the previous timestamp. The measured loop records one interval per delivered benchmark frame alongside the existing callback CPU sample.

Do not add FPS smoothing, moving windows, GPU timestamp queries, or a telemetry subsystem.

## Decision 2: one benchmark implementation, two launchers

Browser behavior stays unchanged:

```text
bun run bench:render
```

Playwright still calls `window.__caelumRendererScale.run(...)` and asserts structural renderer facts.

For Tauri, add an explicit autorun mode to the same page. When `autorun=1` is present:

1. run the 200-vehicle row;
2. run the 5,000-vehicle row;
3. render the complete JSON result into one `<pre>` element and log the same result;
4. leave the window open for inspection/copying.

No autorun occurs in ordinary browser E2E or production application startup.

A `bench:render:tauri` package script launches Tauri with only a `build.devUrl` override to that benchmark URL. The normal `tauri:dev` script and checked-in `tauri.conf.json` remain unchanged.

## Decision 3: closeout gate

Run on the same reference class used by the existing performance evidence:

- Apple M1 Pro;
- macOS;
- 1280×800 Tauri window;
- production TypeScript WebGPU host and renderer;
- real WKWebView WebGPU adapter/device;
- 30 warmup + 120 measured delivered frames per row.

The 5,000-vehicle row passes HPA-336 closeout only when all are true:

- `presentedVehicles === 5000`;
- `encodedInstances === 5000`;
- `vehicleDraws === 1`;
- `queueCompleted === true`;
- median delivered-frame interval ≤ **16.7 ms**;
- p95 delivered-frame interval ≤ **33.4 ms**.

Interpretation:

- 16.7 ms is the practical 60 fps smoothness target;
- 33.4 ms p95 tolerates occasional single-refresh misses without accepting sustained 30 fps behavior;
- callback CPU remains recorded for attribution but is not a separate pass/fail threshold;
- the gate is reference evidence only and is never added to CI.

The 200-vehicle row remains current-scale context and a useful sanity comparison, not a second product gate.

## Decision 4: optimization is conditional on measured failure

If the first Tauri run passes, HPA-48 performs **zero production renderer optimization**.

If it fails:

1. capture one Web Inspector/Instruments performance trace of the same 5k run;
2. identify the dominant seam before editing production code;
3. record the finding in the PR and HPA-48;
4. apply one focused optimization direction inside the existing WebGPU host/batcher/renderer;
5. rerun exactly the same Tauri gate.

Likely seams may include batch construction, vehicle interpolation/instance encoding, buffer upload, command encoding, or queue/compositor pressure, but none is preselected by this design.

Prefer deleting repeated work or allocation over adding abstractions. The permitted implementation should stay local to existing renderer modules and tests.

If the focused correction still misses the gate, stop. Record the measured limitation on HPA-336 and leave the roadmap open rather than expanding HPA-48 into a renderer redesign.

## Evidence ownership

Keep renderer evidence in the existing `docs/performance/hpa-640-webgpu.md` rather than creating a second performance-document hierarchy.

Append a **Release-target closeout** section containing:

- exact command;
- OS/machine/WKWebView context;
- 200 and 5k result tables;
- frame-interval and callback-CPU columns;
- structural instance/upload/draw evidence;
- gate result;
- any focused optimization, if one was actually required.

HPA-336 closeout then references the existing committed evidence:

- HPA-544 presentation cardinality and serialization;
- HPA-347 200k dormant-population/runtime evidence;
- HPA-348 route-choice/demand batching evidence;
- HPA-640/HPA-48 5k release-target renderer evidence.

Do not rerun unrelated expensive scale suites merely to duplicate already committed measurements unless a production change in HPA-48 touches those Rust paths.

## Regression strategy

### Always

- existing browser `bench:render` remains usable;
- benchmark structural assertions stay green;
- TypeScript/Svelte checks and unit tests stay green;
- normal Playwright gameplay journeys stay green;
- Tauri benchmark row runs through WKWebView.

### If production renderer code changes

Run the normal full repository gate used by HPA-640, including Rust/WASM build/test/lint and Tauri gameplay smoke. The conditional optimization must not trade correctness for benchmark numbers.

### If Task 0 passes without production changes

Do not invent code churn. The PR may finish with the benchmark timing extension, Tauri launch seam, evidence/docs, and roadmap closeout only.

## Linear closeout

HPA-48 is the final child/evidence gate for HPA-336.

On a passing release-target row:

1. add one HPA-336 evidence comment summarizing all four scale slices plus HPA-48;
2. remove any stale completed blocker relation if still present;
3. mark HPA-336 Done;
4. mark HPA-48 Done after the single PR is merged.

If the final gate remains red after the one focused optimization direction, neither issue is falsely closed.
