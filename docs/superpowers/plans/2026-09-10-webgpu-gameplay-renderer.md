# HPA-640 WebGPU Gameplay Renderer Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caelum's Canvas2D gameplay renderer with one batched WebGPU renderer, decouple display rAF from 10 Hz backend publication, interpolate moving transit vehicles, and prove ~5,000-visible-vehicle behavior without changing Rust gameplay/persistence contracts.

**Architecture:** Keep the HPA-544 compact `GameState`/`PresentationUpdate` boundary. `createGameRuntime` adds one internal `sceneRevision` derived directly from whether accepted updates contain a scene. An async `createWebGpuHost` owns WebGPU initialization, canvas/input/resize lifecycle, rAF display cadence, a one-in-flight 10 Hz tick scheduler, and previous/latest compact state references. CPU batch builders reuse existing geometry/selectors; one triangle pipeline draws geometric presentation and one instanced-quad pipeline draws culled/interpolated vehicles. Svelte retains HUD and map-local text. No scene graph or Canvas fallback.

**Tech Stack:** TypeScript 5.8, Svelte 5, browser WebGPU/WGSL, Vitest, Playwright, existing Rust/WASM/Tauri backend.

**Spec:** `docs/superpowers/specs/2026-09-10-webgpu-gameplay-renderer-design.md`

## Global constraints

- HPA-640 is **one ticket / one PR**. Continue implementation on this draft PR; do not open separate implementation, cleanup, or verification PRs.
- Do not change `GameSnapshot`, snapshot schema, Rust `PresentationUpdate`, or `GameBackend` methods for this slice.
- Do not add camera/pan/zoom UX, private-car actors, GPU text, texture/material framework, scene graph, PixiJS, Rust `wgpu`, Bevy rendering, or a production Canvas fallback.
- Preserve `routeGeometry.ts`, `placementValidation.ts`, catalogs, and runtime selectors unless a focused Canvas-neutral extraction is necessary.
- Use TDD for pure transform/batch/culling/cadence behavior. Retarget current renderer behavior tests rather than replacing them with broad snapshots.
- Wall-clock performance is reference evidence only; CI assertions cover deterministic structural properties.
- Before completion, run the full repository gate and search production `src` for remaining Canvas2D renderer references.

---

## Task 0: Record the 5k Canvas baseline and extract renderer-neutral presentation helpers

**Files:**
- Create: `tests/helpers/renderScaleState.ts`
- Create: `tests/e2e/rendererScale.html`
- Create: `tests/e2e/rendererScale.ts`
- Create: `tests/e2e/rendererScale.spec.ts`
- Create: `docs/performance/hpa-640-webgpu.md`
- Create: `src/render/boardTransform.ts`
- Create: `src/render/mapTextOverlay.ts`
- Create: `tests/render/boardTransform.test.ts`
- Create: `tests/render/mapTextOverlay.test.ts`
- Modify: `package.json`
- Modify: current Canvas modules/tests only to point at the extracted helpers

- [ ] **Step 1: Write a deterministic renderer-only scale fixture**

Implement `buildRenderScaleState(vehicleCount = 5_000)` using current domain types. It must contain representative map/building/road/track geometry, at least one valid bus path and one valid metro path, representative demand/traffic/crowding rows, and exactly `vehicleCount` deterministic transit vehicle rows distributed over valid route steps.

The fixture is presentation-only. Do not create 5,000 live simulation actors or add product-only benchmark state.

Add a focused fixture test and run:

```bash
bunx vitest run tests/helpers/renderScaleState.test.ts
```

If the helper test is placed in an existing helper test file instead, use that exact focused path consistently.

- [ ] **Step 2: Add the opt-in Canvas baseline page**

`tests/e2e/rendererScale.html` loads `rendererScale.ts`. Before the cutover the page creates a 1280 x 800 2D canvas, builds the 5k fixture, warms up for 30 frames, and exposes:

```ts
window.__caelumRendererScale.run(120)
```

Return frame count, presented vehicle count, median CPU render ms, and p95 CPU render ms.

`rendererScale.spec.ts` navigates directly to the harness page, asserts structural values/finite timings, and prints the result. Skip unless `CAELUM_RENDER_BENCH=1`.

Add to `package.json`:

```json
"bench:render": "CAELUM_RENDER_BENCH=1 playwright test tests/e2e/rendererScale.spec.ts --project=chromium"
```

Run:

```bash
bun run bench:render
```

Record reference machine/browser and Canvas median/p95 in `docs/performance/hpa-640-webgpu.md`. Do not add timing thresholds to the test.

- [ ] **Step 3: Extract board transform/picking from `canvas.ts`**

Move Canvas-neutral behavior into `src/render/boardTransform.ts`:

- `tileSize`;
- `BoardTransform`;
- `getBoardTransform`;
- DPR-aware backing-store sizing;
- client coordinate -> tile mapping.

Port the existing transform/DPR/picking assertions first, run them red against the new module, then update current Canvas imports.

Run:

```bash
bunx vitest run tests/render/boardTransform.test.ts
```

- [ ] **Step 4: Extract all map-local text derivation**

Create:

```ts
export type MapTextOverlayItem =
  | { kind: "cursorBadge"; anchor: Point; text: string; placement: "aboveOrBelow" }
  | { kind: "routeWaypoint"; anchor: TripPosition; text: string }
  | { kind: "roadPreview"; anchor: Point; text: string }
  | { kind: "routeFailure"; anchor: TripPosition; text: string };

export function selectMapTextOverlayItems(
  state: GameState,
  ui: UiState,
): MapTextOverlayItem[];
```

Move current cursor badge wording/validation plus the text portions of road-preview feedback, numbered route handles, and broken-route guidance into this pure selector. Current Canvas modules may still draw the selected text temporarily in Task 0; there must now be one source of truth for text/anchors.

Tests pin road/track/building/roundabout/area/remove cursor labels, route waypoint numbering, preview feedback, and route-failure guidance.

Run:

```bash
bunx vitest run tests/render/mapTextOverlay.test.ts tests/render/cursorBadge.test.ts tests/render/overlayRenderer.test.ts
bun run check
```

- [ ] **Step 5: Ensure the normal product suite is unaffected**

Run:

```bash
bun run test:unit
bun run test:e2e
```

The benchmark spec must skip in the normal E2E run.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers tests/e2e/rendererScale.html tests/e2e/rendererScale.ts tests/e2e/rendererScale.spec.ts docs/performance/hpa-640-webgpu.md src/render package.json
git commit -m "perf: establish HPA-640 renderer baseline"
```

---

## Task 1: Add the minimal WebGPU primitive/renderer foundation

**Files:**
- Create: `src/render/webgpu/primitives.ts`
- Create: `src/render/webgpu/renderer.ts`
- Create: `tests/render/webgpuPrimitives.test.ts`
- Create: `tests/render/webgpuRenderer.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add WebGPU ambient types, not a renderer framework**

Add `@webgpu/types` as a dev dependency and include it in TypeScript ambient types. Do not add a runtime graphics dependency.

Run:

```bash
bun install
bun run check
```

- [ ] **Step 2: Write CPU primitive tests first**

Pin deterministic geometry for:

- rectangle/tile -> two triangles;
- thick line -> correctly oriented quad;
- polyline/quadratic tessellation -> finite vertices and exact endpoints;
- circle/ring -> closed finite shape;
- dashed stroke -> real gaps;
- arrowhead/cross -> deterministic geometry;
- CSS colors currently used by `colors.ts` -> RGBA floats.

Run red:

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts
```

- [ ] **Step 3: Implement the smallest primitive builder**

Use plain functions plus a growable number array/`Float32Array` finalization. World coordinates remain in the existing 32-pixel tile space. Do not model display objects/materials/nodes.

- [ ] **Step 4: Add exactly two WebGPU pipelines**

`renderer.ts` owns:

- one `GPUDevice` and `GPUCanvasContext`;
- world->clip uniform buffer;
- reusable static solid vertex buffer;
- reusable dynamic solid vertex buffer;
- six-vertex unit vehicle quad;
- grow-only vehicle instance buffer;
- one solid-color triangle pipeline;
- one instanced-vehicle pipeline;
- resize/reconfigure and teardown.

Use a small contract:

```ts
export interface WebGpuRenderer {
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  destroy(): void;
}
```

`WebGpuRenderStats` exposes deterministic counts/bytes for tests and the benchmark, not a general telemetry subsystem.

- [ ] **Step 5: Test resource reuse/draw shape with a narrow fake GPU boundary**

Prove buffer capacity is reused until growth is needed and one render encodes the expected solid/vehicle draw calls. Do not emulate shader execution or mock WebGPU globally in runtime tests.

Run:

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add src/render/webgpu tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts package.json bun.lock tsconfig.json
git commit -m "feat: add minimal WebGPU batch renderer"
```

---

## Task 2: Port map, transit, and gameplay overlay geometry to CPU batches

**Files:**
- Create: `src/render/webgpu/mapBatch.ts`
- Create: `src/render/webgpu/transitBatch.ts`
- Create: `src/render/webgpu/overlayBatch.ts`
- Retarget: `tests/render/mapRenderer.test.ts`
- Retarget: `tests/render/transitRenderer.test.ts`
- Retarget: `tests/render/overlayRenderer.test.ts`
- Modify: `src/render/routeGeometry.ts` / `tests/render/routeGeometry.test.ts` only for a Canvas-neutral helper extraction if required

- [ ] **Step 1: Retarget map tests from Canvas calls to visual semantics**

Pin:

- tile fill/grid categories;
- straight/corner road connectivity;
- automatic junction approaches;
- roundabout geometry/ports;
- connected/isolated tracks;
- one-way arrow heading;
- building footprint/outline intent.

Write expected batch assertions first, then implement `mapBatch.ts` using `primitives.ts` and current `colors.ts`.

- [ ] **Step 2: Retarget transit tests around route geometry semantics**

Preserve current behavior for:

- bus vs metro widths/colors;
- shared-corridor offsets/canonical order;
- disconnected-leg dashed/last-valid presentation;
- off-road endpoint connectors;
- stop/station/access markers;
- route direction arrows;
- selected/edited route emphasis.

Reuse `canonicalCorridorPrimitive`, `corridorOffsets`, `directionArrowSamples`, and `routePathPresentation`; do not create a second route geometry model.

Implement `transitBatch.ts` with base route/node geometry separated from small UI-dependent emphasis geometry.

- [ ] **Step 3: Retarget overlay tests**

Pin geometric output for:

- coverage/demand/traffic/crowding;
- hover/inspect selection;
- building/area preview;
- road/track/remove drag preview;
- road mutation changed/skipped/impact markers;
- route draft geometry and selected/missing handle markers;
- broken-route focused/unfocused markers.

Text assertions belong to `mapTextOverlay.test.ts`, not GPU geometry tests.

Implement `overlayBatch.ts` by consuming current selectors/`buildRoadMutationPreview(...)` output.

- [ ] **Step 4: Wire static vs dynamic batch inputs using an explicit scene revision**

Do **not** use live route array identity as a cache key: `applyPresentationUpdate()` reconstructs route/metro rows on frame-only service-metric updates.

Make the renderer rebuild static map/building/base-route geometry only when the supplied integer `sceneRevision` changes. UI overlay/emphasis geometry remains dynamic.

At this task boundary tests can pass explicit revision numbers directly; runtime ownership arrives in Task 4.

- [ ] **Step 5: Verify**

Run:

```bash
bunx vitest run tests/render/mapRenderer.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts tests/render/routeGeometry.test.ts tests/render/webgpuRenderer.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add src/render/webgpu src/render/routeGeometry.ts tests/render
git commit -m "feat: batch Caelum gameplay geometry for WebGPU"
```

---

## Task 3: Add vehicle pose interpolation, viewport culling, and one instanced upload

**Files:**
- Create: `src/render/webgpu/vehicleInstances.ts`
- Create: `tests/render/webgpuVehicleInstances.test.ts`
- Modify: `src/render/webgpu/transitBatch.ts`
- Modify: `src/render/webgpu/renderer.ts`
- Retarget: vehicle-specific assertions in `tests/render/transitRenderer.test.ts`

- [ ] **Step 1: Extract Canvas-free vehicle pose sampling with current behavior pinned**

Define:

```ts
export interface VehiclePose {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  x: number;
  y: number;
  angleRadians: number | null;
}

export interface WorldViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

Retarget current vehicle sampling tests to cover bus path, metro path, parked vehicle, zero-step terminal reversal, corridor-offset sampling, and invalid/missing path -> no pose.

- [ ] **Step 2: Write interpolation tests before implementation**

Pin:

- alpha 0/0.5/1;
- shortest-angle heading interpolation;
- new/missing previous vehicle -> latest immediately;
- different previous/latest `sceneRevision` -> latest immediately;
- paused or speed zero -> latest immediately.

There is no extrapolation path/test.

- [ ] **Step 3: Write culling/batch tests before implementation**

Use a test viewport smaller than the map. Prove:

- culling occurs after pose calculation and before encoding;
- 5,000 visible rows create exactly 5,000 instance records;
- 20,000 presented rows with only 400 in viewport create exactly 400 records;
- instance ordering is deterministic;
- the renderer issues one instance-buffer upload and one instanced vehicle draw for the visible set.

Include the one-tile culling margin in expected boundaries.

- [ ] **Step 4: Implement one fixed-size instance record**

Encode only position, orientation, half-size, RGBA, and opacity needed by the vehicle shader. The renderer owns one reusable unit quad and one grow-only instance buffer.

No per-vehicle GPU objects, bind groups, buffers, or draws.

- [ ] **Step 5: Verify**

Run:

```bash
bunx vitest run tests/render/webgpuVehicleInstances.test.ts tests/render/transitRenderer.test.ts tests/render/webgpuRenderer.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add src/render/webgpu tests/render/webgpuVehicleInstances.test.ts tests/render/transitRenderer.test.ts tests/render/webgpuRenderer.test.ts
git commit -m "feat: batch visible interpolated transit vehicles"
```

---

## Task 4: Replace the Canvas host, add sceneRevision/10 Hz cadence, and move map text to Svelte

**Files:**
- Create: `src/runtime/createWebGpuHost.ts`
- Create: `tests/render/webGpuHost.test.ts`
- Create: `src/components/MapTextOverlay.svelte`
- Create: `tests/ui/mapTextOverlay.test.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/components/GameCanvas.svelte`
- Modify: `src/App.svelte`
- Modify: runtime tests that currently mock `createCanvasHost`
- Modify: `tests/ui/gameCanvas.test.ts`
- Modify: `tests/ui/pointerEvents.test.ts`
- Modify: `tests/ui/appShell.test.ts` only for changed GameCanvas composition/props

- [ ] **Step 1: Add runtime sceneRevision tests before implementation**

In runtime tests, pin this internal behavior through the render-host context/fake host:

- initial `backend.presentation()` with scene => revision 1;
- frame-only tick => revision unchanged;
- rejected/no-op frame-only dispatch => unchanged;
- accepted update containing scene => increment once;
- successful reset/restore scene => increment once;
- no deep/reference comparison decides revision.

Centralize `applyPresentationUpdate` acceptance in one local helper in `createGameRuntime.ts`; do not sprinkle revision increments across call sites.

- [ ] **Step 2: Port host lifecycle/input tests to a fake WebGPU renderer**

Start from `canvasHost.test.ts` behavior. Pin:

- one canvas mount;
- DPR/ResizeObserver sizing;
- click -> exact tile mapping;
- hover/pointer capture/drag start-current-commit-cancel/context-menu/leave behavior;
- remount/teardown listener/observer/rAF cleanup;
- clear WebGPU-unavailable/null-adapter startup error;
- adapter/device created once per runtime host.

`createWebGpuHost` accepts one narrow test dependency:

```ts
interface WebGpuHostDeps {
  createRenderer(): Promise<WebGpuRenderer>;
}
```

Production default requests `navigator.gpu.requestAdapter()` and `adapter.requestDevice()`.

- [ ] **Step 3: Write 10 Hz/rAF cadence tests before implementation**

Use fake rAF timestamps and a deferred `onTick` promise. Prove:

- every delivered rAF renders;
- 0-99 ms accumulated time submits no tick;
- reaching 100 ms submits one accumulated tick;
- while unresolved, more rAF frames render but no second tick queues;
- after settlement, retained accumulated time may drive the next tick;
- one submitted delta <= 0.25 seconds;
- stop/pause resets timestamp/accumulator;
- speed zero submits no tick;
- same scene revision allows previous/latest vehicle interpolation window;
- changed scene revision snaps to latest and invalidates static geometry.

- [ ] **Step 4: Implement async host creation and wire runtime**

`createGameRuntime` is already async, so use:

```ts
const gameHost = await createWebGpuHost({
  getState: () => state,
  getUi: () => ui,
  getSceneRevision: () => sceneRevision,
  onTick: (deltaSeconds) => api.tick(deltaSeconds).then(() => undefined),
  // existing pointer callbacks
});
```

Keep public `RuntimeController.mountCanvas(host): () => void` unchanged. Keep the existing serialized gameplay queue, save dirtiness, fatal backend behavior, preview invalidation, and immediate renders on UI commits.

- [ ] **Step 5: Move map-local text to Svelte without blocking input**

Change `GameCanvas.svelte` to:

```text
.board (Svelte/focus/accessibility owner)
  .board-surface (runtime owns only its child canvas)
  MapTextOverlay (pointer-events: none)
```

`App.svelte` passes latest `state`/`ui`. `MapTextOverlay` observes the board's CSS size, uses `getBoardTransform`, and renders `selectMapTextOverlayItems(...)` absolutely.

Tests prove runtime mounting cannot erase the overlay, teardown still runs, accessibility/focus stay on `.board`, and overlay pointer-events cannot intercept gestures.

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
bunx vitest run tests/render/webGpuHost.test.ts tests/runtime tests/ui/mapTextOverlay.test.ts tests/ui/gameCanvas.test.ts tests/ui/pointerEvents.test.ts tests/ui/appShell.test.ts
bun run check
```

- [ ] **Step 7: Commit**

```bash
git add src/runtime/createWebGpuHost.ts src/runtime/createGameRuntime.ts src/components/GameCanvas.svelte src/components/MapTextOverlay.svelte src/App.svelte tests
git commit -m "feat: cut runtime display loop to WebGPU"
```

---

## Task 5: Delete Canvas2D, run real WebGPU parity/performance evidence, and close the one PR

**Files:**
- Delete: `src/runtime/createCanvasHost.ts`
- Delete: `src/render/canvas.ts`
- Delete: `src/render/mapRenderer.ts`
- Delete: `src/render/buildingRenderer.ts`
- Delete: `src/render/roundaboutRenderer.ts`
- Delete: `src/render/pathRenderer.ts`
- Delete: `src/render/transitRenderer.ts`
- Delete: `src/render/overlayRenderer.ts`
- Delete: `src/render/cursorBadge.ts`
- Delete/retarget: superseded Canvas-specific tests
- Modify: `tests/e2e/rendererScale.ts`
- Modify: `tests/e2e/rendererScale.spec.ts`
- Modify: `docs/performance/hpa-640-webgpu.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`
- Modify: `playwright.config.ts` only if the supported Chromium worker requires explicit functional WebGPU adapter configuration

- [ ] **Step 1: Run the actual app on WebGPU before deleting Canvas modules**

Run:

```bash
bun run dev
```

Use normal GPU-backed Chromium. Verify one normal gameplay surface renders and `navigator.gpu.requestAdapter()` succeeds. Do not add a production Canvas fallback for unsupported environments.

- [ ] **Step 2: Run existing player journeys through WebGPU**

Run:

```bash
bun run test:e2e
```

Preserve existing journey coverage for build/track/demolish, pointer gestures, route creation/editing, overlays, save/restore, and simulation controls. Fix WebGPU/input parity rather than weakening tests.

If headless CI has no usable hardware adapter, add the smallest functional-only WebGPU adapter configuration to the Chromium Playwright project. Keep performance evidence on a real GPU and label any software-adapter run separately.

- [ ] **Step 3: Delete Canvas2D production modules and obsolete mocks**

Remove the listed Canvas-only files once their responsibilities are covered by `boardTransform`, WebGPU batch modules, or Svelte text.

Run:

```bash
rg 'getContext.*2d|CanvasRenderingContext2D|createCanvasHost|renderGame\(' src tests
rg 'mapRenderer|buildingRenderer|roundaboutRenderer|pathRenderer|transitRenderer|overlayRenderer|cursorBadge' src tests
```

Production expectation: no Canvas2D gameplay renderer/context remains under `src`. Do not mass-edit historical design/plan docs just because they describe the old renderer.

- [ ] **Step 4: Retarget the exact Task 0 benchmark fixture to WebGPU**

Keep the same 1280 x 800 scene, 5,000 vehicles, 30 warm-up frames, and 120 measured frames. Return/record:

- presented vehicle count;
- viewport-visible/encoded instance count;
- instance-buffer upload bytes;
- solid and vehicle draw counts;
- median/p95 CPU encode+submit ms;
- total 120-frame duration followed by `device.queue.onSubmittedWorkDone()` and derived average queue-completion cost.

Run on the reference M1 Pro with normal GPU-backed Chromium:

```bash
bun run bench:render
```

Update `docs/performance/hpa-640-webgpu.md` with Canvas baseline vs final WebGPU results. State explicitly that HPA-544's `PresentationUpdate` wire/cardinality was not changed by HPA-640.

- [ ] **Step 5: Perform the desktop target smoke**

Run:

```bash
bun run tauri:dev
```

Verify the map renders, map input works, and moving vehicles look continuous with 10 Hz backend publication + rAF display. Record reference environment/observation in the performance doc; do not turn manual wall-clock evidence into a CI threshold.

- [ ] **Step 6: Update architecture ownership docs**

Update `docs/architecture.md` and `CLAUDE.md` so they identify:

- Svelte: app/HUD/map text;
- `createGameRuntime`: gameplay orchestration plus internal `sceneRevision` from `PresentationUpdate.scene`;
- `createWebGpuHost`: WebGPU canvas/input/resize/rAF/10 Hz tick owner;
- WebGPU batch modules: geometric presentation + vehicle interpolation/culling only;
- Rust: gameplay authority and unchanged HPA-544 presentation wire.

Remove current claims that Canvas2D/`createCanvasHost` owns gameplay rendering.

- [ ] **Step 7: Run the full repository gate fresh**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
cargo build --workspace --locked
bun install --frozen-lockfile
bun run wasm:build:release
bun run format:check
bun run check
bun run lint:svelte
bun run lint:css
bun run test:unit
bun run build
bun run test:e2e
```

Then rerun:

```bash
rg 'getContext.*2d|CanvasRenderingContext2D|createCanvasHost' src tests
```

Expected production result: no Canvas2D gameplay path remains.

- [ ] **Step 8: Final scope review against HPA-640**

Check explicitly:

- one WebGPU gameplay renderer only;
- same Rust/schema/backend methods as before;
- `sceneRevision` comes only from `PresentationUpdate.scene !== null`;
- 10 Hz publication / rAF display, one tick in flight;
- previous/latest pose interpolation only, no prediction;
- viewport culling before instance encoding/upload;
- one 5k vehicle instance batch/draw;
- unchanged scene revision reuses static GPU geometry;
- Svelte map text/HUD retained;
- no camera/scene graph/fallback scope creep;
- Canvas baseline/final WebGPU evidence recorded;
- existing player journeys still pass.

- [ ] **Step 9: Commit final cutover/evidence**

```bash
git add -A
git commit -m "refactor: complete HPA-640 WebGPU cutover"
```

Continue review/implementation on this same draft PR. Do not open a second PR for execution or cleanup.
