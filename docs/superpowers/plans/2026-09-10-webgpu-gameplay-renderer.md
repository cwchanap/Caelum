# HPA-640 WebGPU Gameplay Renderer Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caelum's Canvas2D gameplay renderer with one batched WebGPU path, reduce ordinary backend publication to 10 Hz while keeping rAF display, smooth transit vehicles in path space, and prove the committed 5k-visible-vehicle presentation ceiling without changing Rust gameplay/persistence contracts.

**Architecture:** Keep the HPA-544 `PresentationUpdate`/flat `GameState` boundary and the existing serialized gameplay queue. `createGameRuntime` gains one internal `sceneRevision` and one optional async host factory for tests. `createWebGpuHost` owns WebGPU lifecycle, rAF display, one-in-flight 10 Hz tick admission, observed publication timing, and device-loss forwarding. CPU batch builders preserve Canvas painter order; vehicles are path-interpolated, culled, and uploaded as one instanced batch. Svelte retains HUD and map-local text.

**Tech Stack:** TypeScript 5.8, Svelte 5, browser WebGPU/WGSL, Vitest, Playwright, existing Rust/WASM/Tauri backend.

**Spec:** `docs/superpowers/specs/2026-09-10-webgpu-gameplay-renderer-design.md`

## Global Constraints

- HPA-640 is **one Linear ticket / one draft PR**. Continue on PR #59; do not open another HPA-640 PR without explicit user approval.
- Measure both **200 vehicles** (current/near-term context) and **5,000 vehicles** (HPA-336/HPA-640 future-scale ceiling). These are evidence rows, not a gate that reopens the approved WebGPU direction.
- Do not change Rust `PresentationUpdate`, `GameBackend`, `GameSnapshot`, snapshot schema, or persistence-store contracts.
- Keep `createSerializedQueue`; the host adds only one-in-flight tick admission.
- Do not add camera/pan/zoom UX, private-car actors, GPU text, texture/material framework, scene graph, PixiJS, Rust `wgpu`, Bevy rendering, automatic GPU recovery, or a production Canvas fallback.
- Keep current Canvas renderer tests until their production Canvas modules are deleted in Task 5.
- Preserve current painter order and source-alpha behavior.
- Use current `tests/helpers/gameState.ts` and `tests/helpers/mapFixtures.ts`; do not create a second city/map fixture framework.
- Wall-clock performance stays documentation evidence. CI pins structural behavior.
- Chromium and Tauri/WKWebView must both pass after production cutover and **before** Canvas deletion.

## File Structure

```text
src/render/
  boardTransform.ts              # extracted tile/board transform + existing canvasToTile
  pathGeometry.ts                # extracted pointAt / pointAndTangentAt
  routeGeometry.ts               # retained
  placementValidation.ts         # retained
  colors.ts                      # retained
  mapTextOverlay.ts              # pure DOM-text view derivation
  webgpu/
    primitives.ts                # CPU tessellation only
    mapBatch.ts                  # structural map/buildings/roads/tracks
    transitBatch.ts              # committed route/stops/arrows + emphasis
    overlayBatch.ts              # ordered dynamic ranges
    vehicleInstances.ts          # path interpolation/culling/instances
    renderer.ts                  # pipelines/buffers/draw order
src/runtime/
  createWebGpuHost.ts            # GPU host + input/resize/rAF/cadence/device loss
src/components/
  GameCanvas.svelte
  MapTextOverlay.svelte
```

New WebGPU tests use `webgpu*.test.ts` names. Existing `mapRenderer.test.ts`, `transitRenderer.test.ts`, `overlayRenderer.test.ts`, etc. remain the Canvas oracle until Task 5.

---

## Task 0: Record Canvas context rows and extract renderer-neutral helpers

**Files:**
- Create: `tests/helpers/renderScaleState.ts`
- Create: `tests/helpers/renderScaleState.test.ts`
- Create: `tests/e2e/rendererScale.html`
- Create: `tests/e2e/rendererScale.ts`
- Create: `tests/e2e/rendererScale.spec.ts`
- Create: `docs/performance/hpa-640-webgpu.md`
- Create: `src/render/boardTransform.ts`
- Create: `src/render/pathGeometry.ts`
- Create: `src/render/mapTextOverlay.ts`
- Create: `tests/render/boardTransform.test.ts`
- Create: `tests/render/pathGeometry.test.ts`
- Create: `tests/render/mapTextOverlay.test.ts`
- Modify only as needed: current Canvas modules to import extracted helpers
- Modify: `package.json`

**Interfaces:**
- `buildRenderScaleState(vehicleCount: number): GameState`
- existing `canvasToTile(...)` moved, not renamed
- `pointAt(...)` / `pointAndTangentAt(...)`
- `selectMapTextOverlayItems(state, ui)`

- [ ] **Step 1: Build the renderer-only scale fixture from existing helpers**

Compose `createTestGameState`, bus/metro helper functions, `withRoads`, `withTracks`, and `pointsOnRow`.

Pin:

```ts
expect(buildRenderScaleState(200).transit.vehicles).toHaveLength(200);
expect(buildRenderScaleState(5_000).transit.vehicles).toHaveLength(5_000);
```

The fixture must include representative roads, tracks, buildings, at least one valid bus route and metro line, and non-empty demand/traffic/crowding presentation rows. Do not create 5,000 Rust simulation actors.

Run:

```bash
bunx vitest run tests/helpers/renderScaleState.test.ts
```

- [ ] **Step 2: Record Canvas rows at 200 and 5,000 vehicles**

The benchmark page calls today's `renderGame()` on a fixed 1280×800 Canvas, warms up 30 frames, and measures 120.

Expose:

```ts
window.__caelumRendererScale.run(vehicleCount: 200 | 5000, frames = 120);
```

Return vehicle count, frame count, median CPU ms, and p95 CPU ms. Add:

```json
"bench:render": "CAELUM_RENDER_BENCH=1 playwright test tests/e2e/rendererScale.spec.ts --project=chromium"
```

The benchmark spec skips in normal E2E.

Run:

```bash
bun run bench:render
```

Record `vehicles-200` as current/near-term context and `vehicles-5000` as the roadmap ceiling. Add no timing threshold and no decision gate.

- [ ] **Step 3: Extract board transform without naming churn**

Move from `canvas.ts` into `boardTransform.ts`:

```ts
export const tileSize = 32;
export interface BoardTransform { scale: number; offsetX: number; offsetY: number; width: number; height: number; }
export function getBoardTransform(...): BoardTransform;
export function applyCanvasPixelSize(...): boolean;
export function syncCanvasSize(...): boolean;
export function canvasToTile(...): Point | null;
```

Move the existing transform/DPR/picking assertions first, then update imports.

Run:

```bash
bunx vitest run tests/render/boardTransform.test.ts tests/render/canvas.test.ts tests/render/canvasHost.test.ts
```

- [ ] **Step 4: Extract path sampling, not Canvas drawing**

Move `pointAt` and `pointAndTangentAt` into `pathGeometry.ts`. `pathRenderer.ts` temporarily keeps only Canvas drawing and imports those helpers. Retarget `routeGeometry.ts`, `transitRenderer.ts`, and `overlayRenderer.ts` imports.

`pathGeometry.test.ts` owns line/quadratic/arc sampling; `pathRenderer.test.ts` keeps Canvas drawing assertions until Task 5.

Run:

```bash
bunx vitest run tests/render/pathGeometry.test.ts tests/render/pathRenderer.test.ts tests/render/routeGeometry.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts
```

- [ ] **Step 5: Extract map-local text derivation while Canvas still draws it**

Create:

```ts
export type MapTextOverlayItem =
  | { kind: "cursorBadge"; anchor: Point; text: string; placement: "aboveOrBelow" }
  | { kind: "routeWaypoint"; anchor: TripPosition; text: string }
  | { kind: "roadPreview"; anchor: Point; text: string }
  | { kind: "routeFailure"; anchor: TripPosition; text: string };

export function selectMapTextOverlayItems(state: GameState, ui: UiState): MapTextOverlayItem[];
```

Move current wording/anchor logic there. Canvas calls the selector during the transition; do not delete Canvas text tests yet.

Run:

```bash
bunx vitest run tests/render/mapTextOverlay.test.ts tests/render/cursorBadge.test.ts tests/render/overlayRenderer.test.ts
bun run check
bun run test:unit
bun run test:e2e
```

- [ ] **Step 6: Commit Task 0**

```bash
git add src/render tests/helpers tests/render tests/e2e/rendererScale* docs/performance/hpa-640-webgpu.md package.json
git commit -m "perf: establish HPA-640 renderer baselines"
```

---

## Task 1: Add the minimal blended WebGPU renderer and early Chromium proof

**Files:**
- Create: `src/render/webgpu/primitives.ts`
- Create: `src/render/webgpu/renderer.ts`
- Create: `tests/render/webgpuPrimitives.test.ts`
- Create: `tests/render/webgpuRenderer.test.ts`
- Create: `tests/e2e/webgpuProbe.spec.ts`
- Modify: `package.json`, `bun.lock`, `tsconfig.json`
- Modify: `playwright.config.ts` only if the probe proves a functional adapter flag is required

**Interfaces:**
- one solid triangle pipeline with source-alpha blending
- one instanced vehicle pipeline
- string scene/route cache keys
- `WebGpuRenderer.lost`

- [ ] **Step 1: Add ambient WebGPU types only**

Add `@webgpu/types` as a dev dependency and include it in TypeScript ambient types. Add no runtime graphics library.

```bash
bun install
bun run check
```

- [ ] **Step 2: TDD the CPU primitive builder**

Pin rectangle, thick line, dashed stroke, circle/ring, arrow/cross, color parsing, and quadratic/arc tessellation. Curve expectations must call `pointAt` / `pointAndTangentAt`; `primitives.ts` must not reimplement curve equations.

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts
```

Expected RED before `primitives.ts`, then GREEN after minimal triangle generation.

- [ ] **Step 3: TDD the renderer contract**

Use:

```ts
export interface WebGpuDeviceLoss { reason?: string; message: string; }

export interface WebGpuRenderer {
  readonly lost: Promise<WebGpuDeviceLoss>;
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  destroy(): void;
}
```

The solid pipeline must use source-alpha composition:

```ts
blend: {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
}
```

Tests pin grow-only buffer reuse, string cache keys, ordered solid ranges, one instance-buffer upload, and one vehicle draw.

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts
```

- [ ] **Step 4: Add a real WebGPU Playwright probe before cutover**

`webgpuProbe.spec.ts` must, inside Chromium:

1. verify `navigator.gpu`;
2. request adapter/device;
3. create a 16×16 canvas and `getContext("webgpu")`;
4. configure with `getPreferredCanvasFormat()`;
5. submit one clear render pass;
6. await `device.queue.onSubmittedWorkDone()`;
7. destroy the device.

Run both:

```bash
bunx playwright test tests/e2e/webgpuProbe.spec.ts --project=chromium
bunx playwright test tests/e2e/webgpuProbe.spec.ts --project=chromium --headed
```

If headless Chromium alone requires a software/functional adapter switch, add only the minimum proven Playwright launch setting. Do not use that run for performance evidence.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/render/webgpu tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts tests/e2e/webgpuProbe.spec.ts package.json bun.lock tsconfig.json playwright.config.ts
git commit -m "feat: add minimal blended WebGPU renderer"
```

---

## Task 2: Build WebGPU batches in painter order and keep Canvas tests intact

**Files:**
- Create: `src/render/webgpu/mapBatch.ts`
- Create: `src/render/webgpu/transitBatch.ts`
- Create: `src/render/webgpu/overlayBatch.ts`
- Create: `tests/render/webgpuMapBatch.test.ts`
- Create: `tests/render/webgpuTransitBatch.test.ts`
- Create: `tests/render/webgpuOverlayBatch.test.ts`
- Keep: existing Canvas renderer tests unchanged

**Interfaces:**

```ts
buildMapBatch(state): Float32Array
buildTransitBatch(state, ui, sceneRevision): { vertices: Float32Array; routeStyleKey: string }
buildOverlayRanges(state, ui): {
  underRoutes: Float32Array;
  routeDraft: Float32Array;
  overVehicles: Float32Array;
}
```

- [ ] **Step 1: TDD structural map batching**

`webgpuMapBatch.test.ts` pins tile fills/grid, straight/corner roads, automatic junctions, roundabouts, track presentation, one-way arrows, and building footprints.

```bash
bunx vitest run tests/render/webgpuMapBatch.test.ts tests/render/mapRenderer.test.ts
```

Both the new batch tests and old Canvas oracle must be GREEN.

- [ ] **Step 2: TDD committed transit batching**

`webgpuTransitBatch.test.ts` pins bus/metro widths/colors, corridor offsets, disconnected/last-valid dotted paths, endpoint connectors, stops/stations/access cues, direction arrows, selected/edited emphasis, and `UNRELATED_ROUTE_OPACITY`.

Use a string key:

```ts
const routeStyleKey =
  `routes:${sceneRevision}:${ui.selectedRouteId ?? "-"}:${editedRouteId ?? "-"}`;
```

Reuse current `routeGeometry.ts`; no second route model.

```bash
bunx vitest run tests/render/webgpuTransitBatch.test.ts tests/render/transitRenderer.test.ts tests/render/routeGeometry.test.ts
```

- [ ] **Step 3: TDD dynamic overlay ranges**

`webgpuOverlayBatch.test.ts` pins:

- data/selection/placement/road-mutation/broken-route geometry in `underRoutes`;
- route draft stroke in `routeDraft`;
- route handle circles/crosses in `overVehicles`;
- no text geometry.

```bash
bunx vitest run tests/render/webgpuOverlayBatch.test.ts tests/render/overlayRenderer.test.ts tests/render/mapTextOverlay.test.ts
```

- [ ] **Step 4: Pin painter order and narrow caching**

`webgpuRenderer.test.ts` must observe draw order:

```text
structural
underRoutes
routes
routeDraft
vehicles
overVehicles
```

Use:

```ts
const sceneKey = `scene:${sceneRevision}`;
const routeStyleKey =
  `routes:${sceneRevision}:${selectedRouteId ?? "-"}:${editedRouteId ?? "-"}`;
```

Frame-only vehicle/metric changes reuse structural + route buffers. Selection/edit emphasis invalidates only route geometry.

Run:

```bash
bunx vitest run tests/render/webgpuRenderer.test.ts tests/render/webgpuMapBatch.test.ts tests/render/webgpuTransitBatch.test.ts tests/render/webgpuOverlayBatch.test.ts
bunx vitest run tests/render/canvas.test.ts tests/render/mapRenderer.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts
bun run check
```

Do not delete/rename Canvas tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/render/webgpu tests/render/webgpuMapBatch.test.ts tests/render/webgpuTransitBatch.test.ts tests/render/webgpuOverlayBatch.test.ts tests/render/webgpuRenderer.test.ts
git commit -m "feat: batch gameplay geometry in painter order"
```

---

## Task 3: Add path-space vehicle interpolation, observed alpha, culling, and one instance draw

**Files:**
- Create: `src/render/webgpu/vehicleInstances.ts`
- Create: `tests/render/webgpuVehicleInstances.test.ts`
- Modify: `src/render/webgpu/renderer.ts`
- Keep: Canvas vehicle tests in `tests/render/transitRenderer.test.ts`

**Interfaces:**

```ts
export interface WorldViewport { minX: number; minY: number; maxX: number; maxY: number; }

export function interpolationAlpha(
  previousObservedAtMs: number,
  latestObservedAtMs: number,
  rafNowMs: number,
): number;
```

- [ ] **Step 1: Pin observed-interval alpha**

Implement:

```ts
const interval = Math.max(1, latestObservedAtMs - previousObservedAtMs);
return Math.max(0, Math.min(1, (rafNowMs - latestObservedAtMs) / interval));
```

Tests must include both 100 ms and 130 ms accepted-state intervals; the 130 ms case must not reach alpha 1 after only 100 ms.

- [ ] **Step 2: Pin same-step path interpolation**

For same vehicle ID + scene + line + itinerary + `pathStepIndex`, interpolate only `stepProgress`, then sample one presented geometry with `pointAndTangentAt()`.

Use separate quadratic and arc fixtures. Expected positions/tangents come from the path sampler, not world-point midpoint. This must fail a chord-lerp implementation.

- [ ] **Step 3: Pin one adjacent-step rollover and snap rules**

For one provably adjacent step on the same itinerary:

```text
remainingPrevious = (1 - previous.stepProgress) * previousStep.travelSeconds
elapsedLatest = latest.stepProgress * latestStep.travelSeconds
span = remainingPrevious + elapsedLatest
target = alpha * span
```

Sample either the tail of the previous geometry or head of the latest geometry according to `target`.

Snap to latest for scene change, pause/speed 0, new/missing previous vehicle, line change, itinerary change, parked↔path transition, backward/non-adjacent jump, or invalid/zero span. Do not implement a general route timeline or extrapolation.

- [ ] **Step 4: Pin culling + instance encoding**

After interpolation:

1. apply route-emphasis opacity;
2. cull against `WorldViewport` plus one-tile margin;
3. encode only visible instances in stable vehicle-ID order.

Tests must prove:

```text
5000 visible -> 5000 encoded
20000 presented, 400 in viewport -> 400 encoded
```

Feed 5k encoded instances to the renderer and assert one vehicle `writeBuffer` + one instanced draw.

```bash
bunx vitest run tests/render/webgpuVehicleInstances.test.ts tests/render/webgpuRenderer.test.ts tests/render/transitRenderer.test.ts
bun run check
```

- [ ] **Step 5: Commit Task 3**

```bash
git add src/render/webgpu/vehicleInstances.ts src/render/webgpu/renderer.ts tests/render/webgpuVehicleInstances.test.ts tests/render/webgpuRenderer.test.ts
git commit -m "feat: interpolate and batch visible transit vehicles"
```

---

## Task 4: Cut production to WebGPU and pass browser + Tauri gates before deletion

**Files:**
- Create: `src/runtime/createWebGpuHost.ts`
- Create: `tests/render/webGpuHost.test.ts`
- Create: `tests/helpers/gameHost.ts`
- Create: `src/components/MapTextOverlay.svelte`
- Create: `tests/ui/mapTextOverlay.test.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/components/GameCanvas.svelte`
- Modify: `src/App.svelte`
- Modify: runtime/UI tests that construct a runtime
- Keep: every Canvas production module/test until Task 5

**Interfaces:**
- async `createWebGpuHost(context): Promise<GameHost>`
- optional `CreateGameRuntimeOptions.createHost`
- one `acceptPresentationUpdate()` helper
- unexpected device loss -> existing fatal/shell-error state
- public `mountCanvas(host): () => void` unchanged

- [ ] **Step 1: Add the host-factory test seam before switching defaults**

Export:

```ts
export interface GameHost {
  mount(host: HTMLElement): () => void;
  render(): void;
  start(): void;
  stop(): void;
  syncAnimationLoop(): void;
  isRunning(): boolean;
}

export type CreateGameHost =
  (context: WebGpuHostContext) => Promise<GameHost>;
```

Add to `CreateGameRuntimeOptions`:

```ts
createHost?: CreateGameHost;
```

Production later uses `options.createHost ?? createWebGpuHost`. Add `tests/helpers/gameHost.ts` and update every Node/jsdom `createGameRuntime(...)` caller to inject an async fake host; do not mock `navigator.gpu` globally.

Run:

```bash
rg 'createGameRuntime\(' tests/runtime tests/ui
bunx vitest run tests/runtime tests/ui/pointerEvents.test.ts
```

- [ ] **Step 2: Centralize `sceneRevision` through all accepted updates**

Use one helper:

```ts
let sceneRevision = 0;

const acceptPresentationUpdate = (
  current: GameState | null,
  update: PresentationUpdate,
): GameState => {
  if (update.scene !== null) sceneRevision += 1;
  return applyPresentationUpdate(current, update);
};
```

Use it for initial presentation, `commitDispatchResult`, successful restore, and successful reset.

Tests pin revision 1 after initial scene; frame-only tick/no-op unchanged; structural dispatch/restore/reset each increment once.

- [ ] **Step 3: Port input/resize lifecycle to the WebGPU host**

Preserve `createCanvasHost` behavior for drag tools, pointer capture, context menu, hover, resize observer, remount, teardown, and the existing `canvasToTile` mapping.

`createWebGpuHost` is async because renderer/device creation happens before it returns. `mount()` stays synchronous.

`webGpuHost.test.ts` uses a narrow fake renderer; do not emulate the entire WebGPU API.

- [ ] **Step 4: Implement 10 Hz admission and render coalescing on top of the existing queue**

Host rAF rules:

```text
every active rAF -> render
0..99ms accumulated -> no tick
>=100ms and no pending host tick -> submit one accumulated tick
submitted delta <= 0.25s
overflow retained
pending tick -> render, no second submission
pause/stop/speed0 -> no stale catch-up
```

`ctx.onTick()` calls `api.tick()`, which still enters `createSerializedQueue`.

Resolve the current `publish()`/`commit()` repaint seam:

- while active rAF display is running, `GameHost.render()` does **not** draw synchronously; next rAF draws latest state;
- paused/stopped/no scheduled rAF -> render immediately;
- terminal transition stops first, then renders once.

Tests pin <=10 host tick submissions across 1 second of 60Hz rAF, no second admission while deferred tick is pending, no immediate double draw after an accepted running tick, and immediate paused repaint.

- [ ] **Step 5: Wire observed state history into vehicle interpolation**

Keep previous/latest accepted state + scene revision + `observedAtMs`. Same scene revision shifts history; scene change clears previous. rAF computes alpha with Task 3's `interpolationAlpha()`.

Metrics/budget/clock/overlays use latest state only. Only vehicle instances see previous/latest/alpha.

Pin the 130ms interval integration case.

- [ ] **Step 6: Handle unexpected `GPUDevice.lost` loudly**

`WebGpuRenderer.lost` resolves to `{ reason?, message }`.

```ts
void renderer.lost.then((info) => {
  if (info.reason === "destroyed") return;
  ctx.onFatalError(
    new Error(info.message ? `WebGPU device lost: ${info.message}` : "WebGPU device lost"),
  );
});
```

Host test: unexpected loss calls `onFatalError` once; deliberate `destroy()` loss does not.

Runtime test: injected host calls `context.onFatalError(...)`; assert one terminal `backendError`, host stopped, subscriber notified once, later backend operations suppressed. Do not recreate the device and do not fall back to Canvas.

- [ ] **Step 7: Move map-local text to Svelte and share the board CSS box**

`GameCanvas.svelte` becomes:

```text
.board
  .board-surface
  MapTextOverlay
```

Both `.board-surface` and `.map-text-overlay` are absolute `inset: 0`; overlay has `pointer-events: none`. Runtime mounts/clears only `.board-surface`, so Svelte overlay DOM survives.

Both host and overlay feed their same-size full-board CSS box into `getBoardTransform`.

- [ ] **Step 8: Switch production default to `createWebGpuHost` and run focused integration**

```bash
bunx vitest run tests/render/webGpuHost.test.ts tests/runtime tests/ui/mapTextOverlay.test.ts tests/ui/gameCanvas.test.ts tests/ui/pointerEvents.test.ts tests/ui/appShell.test.ts
bun run check
```

Canvas source/tests still exist as a comparison oracle; there is no production runtime fallback.

- [ ] **Step 9: Run full Playwright through the WebGPU production path**

```bash
bun run test:e2e
```

Do not weaken build/track/demolish, route-edit, overlay, save/restore, pointer, resize, or simulation-control assertions.

- [ ] **Step 10: Run Tauri/WKWebView before deleting Canvas**

```bash
bun run tauri:dev
```

Verify map render, resize/pointer alignment, build/select/drag input, overlay/route layering, and visibly continuous moving vehicles.

Record the macOS/WebKit observation in `docs/performance/hpa-640-webgpu.md`.

**Hard gate:** if the Tauri smoke fails, stop Task 4 and fix it while Canvas source/tests are still present. Do not start Task 5.

- [ ] **Step 11: Commit Task 4**

```bash
git add src/runtime src/components src/App.svelte tests/helpers/gameHost.ts tests/render/webGpuHost.test.ts tests/runtime tests/ui docs/performance/hpa-640-webgpu.md
git commit -m "feat: cut gameplay display to WebGPU"
```

---

## Task 5: Delete Canvas with its tests and record final evidence

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
- Delete/retarget matching Canvas tests only now
- Modify: renderer benchmark, performance doc, architecture docs

- [ ] **Step 1: Delete Canvas modules and their tests together**

Only after Task 4's Chromium/full-E2E/Tauri gates.

Mapping:

```text
createCanvasHost -> canvasHost.test
mapRenderer      -> mapRenderer.test
transitRenderer  -> transitRenderer.test
overlayRenderer  -> overlayRenderer.test
cursorBadge      -> cursorBadge.test
roundaboutRenderer -> roundaboutRenderer.test
Canvas-only canvas/path drawing assertions -> remove after boardTransform/pathGeometry/WebGPU coverage exists
```

Run:

```bash
rg 'getContext.*2d|CanvasRenderingContext2D|createCanvasHost|renderGame\(' src tests
rg 'mapRenderer|buildingRenderer|roundaboutRenderer|pathRenderer|transitRenderer|overlayRenderer|cursorBadge' src tests
```

Expected: no production Canvas2D gameplay path remains.

- [ ] **Step 2: Retarget the same 200/5k benchmark to WebGPU**

Keep the exact Task 0 scene, 1280×800 size, 30 warm-up frames, and 120 measured frames.

Record:

```text
presented vehicles
visible/encoded instances
vehicle upload bytes
solid draw count
vehicle draw count
median/p95 CPU encode+submit
queue completion after the run
```

Run on the same reference machine/browser:

```bash
bun run bench:render
```

- [ ] **Step 3: Separate cadence evidence from renderer evidence**

`docs/performance/hpa-640-webgpu.md` must report three independent shapes:

```text
publication: old rAF admission vs new <=10 host ticks/sec
wire: existing HPA-544 frame bytes/projection/serialization
renderer: Canvas vs WebGPU at vehicles-200 and vehicles-5000
```

Do not credit WebGPU with savings caused by lower publication cadence.

- [ ] **Step 4: Update architecture ownership docs**

Update `docs/architecture.md` and `CLAUDE.md`:

- Rust remains gameplay authority.
- HPA-544 presentation wire is unchanged.
- `createGameRuntime` owns orchestration + internal `sceneRevision`.
- `createWebGpuHost` owns GPU/input/resize/rAF/10Hz admission/device-loss forwarding.
- WebGPU modules own geometric presentation and vehicle interpolation/culling.
- Svelte owns HUD/panels/map text.
- Canvas2D gameplay rendering is gone.

- [ ] **Step 5: Run the complete gate fresh**

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
bunx playwright test tests/e2e/webgpuProbe.spec.ts --project=chromium
rg 'getContext.*2d|CanvasRenderingContext2D|createCanvasHost' src tests
```

- [ ] **Step 6: Final scope check**

Confirm:

```text
one HPA-640 PR
unchanged Rust/wire/schema
sceneRevision from update.scene only
existing serialized queue retained
<=10 host tick admissions/sec; <=1 host tick pending
no running double-draw; paused repaint works
observed-interval alpha
path-space curve/adjacent-step interpolation; discontinuities snap
source-alpha blending + correct painter order
string cache keys
Canvas tests survived until Canvas deletion
test host factory avoids navigator.gpu in Node/jsdom
unexpected device loss -> terminal shell error
culling before encode/upload
one vehicle upload + one instanced draw
Svelte map text
Chromium + Tauri proven before deletion
200 + 5000 rows recorded
cadence vs renderer effects separated
no camera/private-car actors/GPU text/fallback scope creep
```

- [ ] **Step 7: Commit final cleanup/evidence**

```bash
git add -A
git commit -m "refactor: complete HPA-640 WebGPU cutover"
```

Continue review on draft PR #59. Do not open a second HPA-640 PR.
