# HPA-48 WebGPU Release-Target Closeout Implementation Plan

## Objective

Prove or falsify the remaining HPA-336 renderer success criterion on the actual macOS Tauri/WKWebView target using the already-shipped 5,000-vehicle production WebGPU fixture.

This remains **one ticket and one PR**. The first implementation step is an evidence gate. Production renderer optimization is forbidden unless that gate fails on the reference target.

Design: `docs/superpowers/specs/2026-09-13-webgpu-release-target-closeout-design.md`

## Current branch state

Planning only. Before implementation begins this branch should contain exactly the design and implementation-plan documents.

## Frozen decisions

- Reuse `tests/e2e/rendererScale.html` / `rendererScale.ts`; do not create another renderer benchmark implementation.
- Browser Playwright remains one launcher; Tauri/WKWebView becomes a second launcher for the same page.
- Use Tauri 2 `--config` to override only `build.devUrl`; do not change the default `tauri.conf.json` behavior.
- Add delivered-frame interval median/p95 beside existing callback-CPU evidence.
- 5k closeout gate: median interval ≤16.7 ms, p95 ≤33.4 ms, 5,000 encoded instances, one vehicle draw, queue completes.
- Timing remains reference evidence, never a CI threshold.
- If the first real Tauri run passes, do not optimize production rendering.
- If it fails, profile first; no production edit until the measured hotspot and exact bounded correction are written into this PR plan.
- One focused optimization direction maximum before reassessing HPA-336.

## Task 0 — extend the existing benchmark without changing production rendering

### Files

Modify:

- `tests/e2e/rendererScale.ts`
- `tests/e2e/rendererScale.html`
- `tests/e2e/rendererScale.spec.ts`
- `package.json`

Do not modify `src/render/**` or `src/runtime/createWebGpuHost.ts` in this task.

### 0.1 Record delivered host-frame intervals

In `rendererScale.ts`:

1. Keep the existing `realRequestAnimationFrame` bypass used by `nextDeliveredFrame()`.
2. In the wrapped `window.requestAnimationFrame`, retain the delivered callback timestamp alongside `lastFrameCpuMs`.
3. After warmup, seed the previous delivered timestamp from the final warmup frame.
4. During the measured loop, append one `timestamp - previousTimestamp` sample for each **host-delivered** frame.
5. Add `medianFrameIntervalMs` and `p95FrameIntervalMs` to `RendererScaleResult`.
6. Keep existing CPU timing, instance count, upload bytes, draw counts, and final `device.queue.onSubmittedWorkDone()` behavior unchanged.

Do not use the helper await-rAF timestamp as the sample; that callback intentionally bypasses the wrapped host rAF.

### 0.2 Add explicit Tauri autorun output

Keep `window.__caelumRendererScale.run(...)` unchanged for Playwright callers.

When `new URLSearchParams(location.search).get("autorun") === "1"`:

1. run `200` with the normal frame count;
2. run `5000` with the normal frame count;
3. render a single JSON object such as `{ environment, rows: [...] }` into a `<pre id="renderer-scale-result">`;
4. log the same JSON object once to the console;
5. surface an error in the same `<pre>` and rethrow if setup or either row fails.

The page must not autorun without the explicit query parameter.

`rendererScale.html` should contain only the existing fixed host plus the minimal result/status element. Do not style or productize the benchmark page.

### 0.3 Preserve browser benchmark coverage

Update `rendererScale.spec.ts` to assert the new timing fields are finite and positive for the existing rows. Keep structural assertions for:

- presented/encoded vehicle count;
- upload bytes;
- one vehicle draw;
- queue completion.

Do **not** assert the 16.7/33.4 ms release gate in Playwright. Headless Chromium software GL is not the release target and timing is not a CI contract.

### 0.4 Add the Tauri launcher

Add one package script:

```text
bench:render:tauri
```

It runs the normal Tauri dev shell with a CLI config merge that overrides only:

```json
{
  "build": {
    "devUrl": "http://127.0.0.1:5281/tests/e2e/rendererScale.html?autorun=1"
  }
}
```

The checked-in `src-tauri/tauri.conf.json`, normal `tauri:dev`, production startup, and bundle configuration stay unchanged.

The target workflow is macOS-only evidence, so do not add cross-platform quoting helpers or another Node process wrapper unless the direct package script demonstrably cannot launch on the reference Mac.

### Task 0 verification

Run:

```text
bun run check
bun run test:unit
bun run bench:render
```

Expected:

- TypeScript/Svelte checks green;
- existing unit suite green;
- browser 200/5k benchmark still completes and includes the new interval fields;
- no production renderer/runtime diff exists yet.

Commit only the benchmark/launcher seam after those checks pass.

## Task 1 — run the release-target hard gate before production edits

### Reference environment

- Apple M1 Pro reference Mac;
- current macOS version recorded in evidence;
- 1280×800 Tauri window;
- WKWebView production WebGPU path;
- 30 warmup + 120 measured delivered frames per row.

Run:

```text
bun run bench:render:tauri
```

Copy the rendered JSON result into the PR working notes before making any optimization decision.

### Required 5k checks

All must pass:

```text
presentedVehicles === 5000
encodedInstances === 5000
vehicleDraws === 1
queueCompleted === true
medianFrameIntervalMs <= 16.7
p95FrameIntervalMs <= 33.4
```

Also record the 200-row context and both rows' callback CPU median/p95.

### Gate A — PASS

If all checks pass:

- **skip Task 2 entirely**;
- do not touch `src/render/**` or `src/runtime/**` for performance;
- continue directly to Task 3 evidence/closeout.

### Gate B — FAIL

If any smoothness check fails:

1. stop production coding;
2. capture one Web Inspector/Instruments trace of the exact 5k run;
3. identify the dominant seam and supporting measurement;
4. update this plan on the same PR with:
   - exact production files to change;
   - one root cause;
   - one bounded correction;
   - focused tests proving the correction;
5. only then continue to Task 2.

A failed structural check (wrong instance count/draw count/queue failure) is a correctness regression and must be fixed before treating this as a performance task.

## Task 2 — conditional single-hotspot optimization

**This task does not authorize any production file in advance.** Its exact file list is filled in only after Gate B profiling.

Rules for the correction:

- stay inside the current TypeScript WebGPU host/batcher/renderer architecture;
- prefer removing repeated computation/allocation/upload over adding a new abstraction;
- add a focused regression/performance-shape test for the corrected seam;
- preserve painter order, interpolation semantics, culling, pointer behavior, scene-revision caching, and the one-draw vehicle batch contract;
- do not alter `PresentationUpdate`, save schema, Rust simulation, or backend cadence to make renderer numbers look better.

After the correction:

```text
bun run check
bun run test:unit
bun run bench:render
bun run bench:render:tauri
```

### Conditional stop rule

If the exact same 5k Tauri gate is still red after this one focused optimization direction:

- stop implementation;
- document the remaining bottleneck and measured result;
- keep HPA-336 open;
- do not add a second optimization subsystem or broaden this ticket.

## Task 3 — record final evidence

Modify:

- `docs/performance/hpa-640-webgpu.md`

Append `## Release-target closeout (HPA-48)` with:

- date;
- exact `bench:render:tauri` command;
- machine/OS and WKWebView/Tauri context;
- 200 and 5k table containing:
  - frames;
  - median/p95 delivered-frame interval;
  - median/p95 callback CPU;
  - encoded instances;
  - upload bytes;
  - solid draws;
  - vehicle draws;
  - queue completion;
- PASS/FAIL against 16.7/33.4 ms;
- if Task 2 ran, before/after rows and the exact optimized hotspot;
- explicit statement that this is local reference evidence, not a CI threshold.

Do not create a second performance-doc hierarchy.

## Task 4 — final regression gate

### When Gate A passed with no production renderer edit

Run:

```text
bun run format:check
bun run check
bun run lint:svelte
bun run lint:css
bun run test:unit
bun run build
bun run test:e2e
bun run bench:render
bun run bench:render:tauri
```

The build already exercises the release WASM path. Do not rerun HPA-347/HPA-348 ignored scale suites merely to duplicate their committed evidence.

### When Task 2 changed production renderer/runtime code

Run the commands above plus the same Tauri gameplay parity smoke relevant to the changed seam. If Rust files somehow become necessary, stop and revise this plan first; no Rust change is currently justified.

## Task 5 — HPA-336 closeout

Only when the final Tauri 5k gate passes and the PR implementation/evidence is complete:

1. prepare one Linear comment on HPA-336 summarizing:
   - HPA-544 presentation evidence;
   - HPA-347 200k dormant population/runtime evidence;
   - HPA-348 demand/routing batching evidence;
   - HPA-640 WebGPU structural/parity evidence;
   - HPA-48 Tauri/WKWebView 5k frame-cadence evidence;
2. note that the roadmap success definition is now met on the reference target;
3. after this PR merges, remove stale completed blockers if any and mark HPA-336 Done;
4. mark HPA-48 Done.

Do not create a separate closeout PR.

## Expected PR shape

Planning stage:

- `docs/superpowers/specs/2026-09-13-webgpu-release-target-closeout-design.md`
- `docs/superpowers/plans/2026-09-13-webgpu-release-target-closeout.md`

Implementation stage when Gate A passes:

- four benchmark/launcher files from Task 0;
- existing HPA-640 performance doc;
- no production renderer changes.

Implementation stage when Gate B fails once:

- same files above;
- only the explicitly profiled production files added by the revised Task 2;
- focused tests for that seam.

That is the complete HPA-48 PR. No second PR is planned for this ticket.
