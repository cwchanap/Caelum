# HPA-640 WebGPU Gameplay Renderer Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Caelum's Canvas2D gameplay renderer with one layered WebGPU renderer, decouple display rAF from 10 Hz backend publication, path-interpolate moving transit vehicles, and prove ~5,000-visible-vehicle behavior without changing Rust gameplay/persistence contracts.

**Architecture:** Keep the HPA-544 `PresentationUpdate`/`GameBackend` boundary unchanged. `createGameRuntime` owns one internal `sceneRevision` derived only from accepted updates with `scene !== null`; `createWebGpuHost` owns WebGPU lifecycle, pointer/resize handling, rAF display, and a one-in-flight 10 Hz gate on top of the existing serialized gameplay queue. CPU batch builders preserve Canvas painter order; vehicle motion is interpolated in route/path cursor space and resampled through the existing `PathGeometry` sampler before viewport culling and one instanced upload. Svelte retains HUD and map-local text. No scene graph or Canvas fallback.

**Tech Stack:** TypeScript 5.8, Svelte 5, browser WebGPU/WGSL, Vitest, Playwright, existing Rust/WASM/Tauri backend.

**Spec:** `docs/superpowers/specs/2026-09-10-webgpu-gameplay-renderer-design.md`

## Global Constraints

- HPA-640 is **one ticket / one PR**. Continue implementation on this draft PR; do not open separate implementation, cleanup, or verification PRs.
- Do not change `GameSnapshot`, snapshot schema, Rust `PresentationUpdate`, or `GameBackend` methods.
- Preserve the existing `createSerializedQueue`; the host-level one-in-flight gate prevents rAF tick flooding but is not a replacement queue.
- Do not add camera/pan/zoom UX, private-car actors, GPU text, texture/material framework, scene graph, PixiJS, Rust `wgpu`, Bevy rendering, or a production Canvas fallback.
- Preserve `routeGeometry.ts`, `placementValidation.ts`, catalogs, and runtime selectors. Extract Canvas-neutral path/board helpers rather than copying their math.
- Vehicle interpolation must follow `PathGeometry`; do not world-lerp sampled `x/y` or independently lerp headings.
- Preserve painter order: map/buildings -> under-route overlays -> committed routes/stops/arrows -> route-draft stroke -> vehicles -> route-handle geometry -> DOM text.
- The solid WebGPU pipeline must support source-alpha blending from its first implementation.
- `sceneRevision` changes only when an accepted `PresentationUpdate.scene !== null`; every state-install path uses one helper.
- Current whole-map fit remains production behavior. `WorldViewport` is only the culling seam for this ticket.
- Build renderer scale state from existing `tests/helpers/gameState.ts` and `tests/helpers/mapFixtures.ts`; do not create a second city/sandbox fixture framework.
- A real Chromium adapter/device/context/submit smoke must pass before production switches to `createWebGpuHost`.
- Run the full existing Playwright suite immediately after host cutover and before Canvas deletion.
- Wall-clock performance is reference evidence only; CI assertions cover deterministic structural properties.
- Before completion, run the full repository gate and search production `src` for remaining Canvas2D renderer references.

---

## Task 0: Record the Canvas baseline and extract renderer-neutral geometry/view seams

**Files:**
- Create: `tests/helpers/renderScaleState.ts`
- Create: `tests/render/renderScaleState.test.ts`
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
- Modify: `src/render/canvas.ts`
- Modify: `src/render/pathRenderer.ts`
- Modify: `src/render/routeGeometry.ts`
- Modify: `src/render/transitRenderer.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: current Canvas tests only to consume the extracted helpers
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `createTestGameState`, `addTestBusStop`, `addTestBusRoute`, `addTestMetroStation`, `addTestMetroLine`, `assignTestVehicle`, `withRoads`, `withTracks`, existing `PathGeometry`, existing Canvas renderer.
- Produces:

```ts
export function buildRenderScaleState(vehicleCount?: number): GameState;

export const tileSize: number;
export interface BoardTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}
export function getBoardTransform(
  board: { width: number; height: number },
  map: GameMap,
): BoardTransform;
export function applyCanvasPixelSize(
  canvas: CanvasSizeTarget,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio?: number,
): boolean;
export function clientPointToTile(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  map: GameMap,
): Point | null;

export interface GeometrySample {
  point: TripPosition;
  tangent: TripPosition;
}
export function pointAndTangentAt(
  geometry: PathGeometry,
  progress: number,
): GeometrySample;
export function pointAt(
  geometry: PathGeometry,
  progress: number,
): TripPosition;

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

- [ ] **Step 1: Build the deterministic renderer scale fixture by composition**

Start from existing helpers rather than constructing a parallel map model:

```ts
export function buildRenderScaleState(vehicleCount = 5_000): GameState {
  let state = createTestGameState();
  state = withRoads(state, pointsOnRow(8, 2, 25));
  state = withTracks(state, pointsOnRow(11, 2, 25));
  state = addTestBusStop(state, { x: 4, y: 8 });
  state = addTestBusStop(state, { x: 22, y: 8 });
  state = addTestBusRoute(state, ["stop-001", "stop-002"]);
  state = addTestMetroStation(state, { x: 4, y: 11 });
  state = addTestMetroStation(state, { x: 22, y: 11 });
  state = addTestMetroLine(state, ["station-001", "station-002"]);

  const bus = state.transit.routes[0];
  const metro = state.transit.metroLines[0];
  if (bus === undefined || metro === undefined) throw new Error("scale routes");

  const vehicles = Array.from({ length: vehicleCount }, (_, index) => ({
    id: `scale-vehicle-${index.toString().padStart(5, "0")}`,
    mode: index % 2 === 0 ? ("bus" as const) : ("metro" as const),
    lineId: index % 2 === 0 ? bus.id : metro.id,
    itineraryIndex: 0,
    pathStepIndex: 0,
    stepProgress: (index % 100) / 100,
    parkedPosition: null,
  }));

  return {
    ...state,
    transit: { ...state.transit, vehicles },
    demandFlow: [{ point: { x: 18, y: 7 }, count: 200 }],
    trafficFlow: [{ point: { x: 12, y: 8 }, flow: 8 }],
  };
}
```

Add `tests/render/renderScaleState.test.ts` asserting exact vehicle count, both modes, valid route references, finite step progress, and representative overlay rows.

Run:

```bash
bunx vitest run tests/render/renderScaleState.test.ts
```

Expected: PASS after the helper is implemented.

- [ ] **Step 2: Record the 5k Canvas baseline before any renderer cutover**

`tests/e2e/rendererScale.html` loads `rendererScale.ts`. The pre-cutover harness creates a 1280×800 2D canvas, renders `buildRenderScaleState(5_000)`, warms 30 frames, then exposes:

```ts
window.__caelumRendererScale.run = (frameCount = 120) => {
  const timings: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const started = performance.now();
    renderGame(ctx, state, createUiState());
    timings.push(performance.now() - started);
  }
  return summarizeRendererTimings(timings, state.transit.vehicles.length);
};
```

`rendererScale.spec.ts` is opt-in under `CAELUM_RENDER_BENCH=1`, checks structural values/finite timings, and prints the result. Add:

```json
"bench:render": "CAELUM_RENDER_BENCH=1 playwright test tests/e2e/rendererScale.spec.ts --project=chromium"
```

Run on the reference machine:

```bash
bun run bench:render
```

Record browser, machine, 5,000 presented vehicles, median CPU render ms, and p95 CPU render ms in `docs/performance/hpa-640-webgpu.md`. Do not add timing thresholds.

- [ ] **Step 3: Extract board transform and pointer mapping**

Move `tileSize`, `BoardTransform`, `getBoardTransform`, `applyCanvasPixelSize`, and pointer mapping out of `canvas.ts`. Port existing transform/DPR/picking tests first.

Use the new function name consistently:

```ts
const point = clientPointToTile(canvas, event.clientX, event.clientY, state.map);
```

Run:

```bash
bunx vitest run tests/render/boardTransform.test.ts tests/render/canvas.test.ts tests/render/canvasHost.test.ts
```

Expected: PASS with current Canvas behavior unchanged.

- [ ] **Step 4: Extract `PathGeometry` sampling before WebGPU tessellation**

Move only Canvas-neutral math from `pathRenderer.ts`:

```ts
export function pointAndTangentAt(
  geometry: PathGeometry,
  progress: number,
): GeometrySample {
  // exact existing line / quadraticBezier / arc implementation
}

export function pointAt(
  geometry: PathGeometry,
  progress: number,
): TripPosition {
  return pointAndTangentAt(geometry, progress).point;
}
```

Update `routeGeometry.ts`, `pathRenderer.ts`, `transitRenderer.ts`, and `overlayRenderer.ts` to import the sampler from `pathGeometry.ts`. Keep Canvas-only `drawPathGeometry()` in `pathRenderer.ts` until Task 5.

Move the current sampler assertions to `pathGeometry.test.ts`, including line/quadratic/arc midpoint+tangent cases.

Run:

```bash
bunx vitest run tests/render/pathGeometry.test.ts tests/render/pathRenderer.test.ts tests/render/routeGeometry.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts
```

- [ ] **Step 5: Extract map-local text derivation**

Create `selectMapTextOverlayItems(state, ui)` as the one source of truth for cursor wording/anchors, road-preview feedback text, route waypoint numbers, and broken-route guidance. Transitional Canvas renderers may still draw these items until Task 4.

Tests must pin road/track/building/roundabout/area/remove cursor labels, route waypoint numbering, preview feedback, and route-failure guidance.

Run:

```bash
bunx vitest run tests/render/mapTextOverlay.test.ts tests/render/cursorBadge.test.ts tests/render/overlayRenderer.test.ts
bun run check
```

- [ ] **Step 6: Run the pre-WebGPU product gate**

Run:

```bash
bun run test:unit
bun run test:e2e
```

The renderer benchmark remains skipped in the normal E2E run.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/renderScaleState.ts tests/render tests/e2e/rendererScale.html tests/e2e/rendererScale.ts tests/e2e/rendererScale.spec.ts docs/performance/hpa-640-webgpu.md src/render package.json
git commit -m "perf: establish HPA-640 renderer baseline"
```

---

## Task 1: Add the minimal blended WebGPU renderer and prove the browser adapter early

**Files:**
- Create: `src/render/webgpu/primitives.ts`
- Create: `src/render/webgpu/renderer.ts`
- Create: `tests/render/webgpuPrimitives.test.ts`
- Create: `tests/render/webgpuRenderer.test.ts`
- Create: `tests/e2e/webgpuAvailability.spec.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `tsconfig.json`
- Modify: `playwright.config.ts` only if the actual worker needs explicit functional WebGPU configuration

**Interfaces:**
- Consumes: `BoardTransform`, `PathGeometry`, `pointAndTangentAt`, `colors`.
- Produces:

```ts
export interface SolidBatch {
  vertices: Float32Array;
  vertexCount: number;
}

export interface DrawRange {
  firstVertex: number;
  vertexCount: number;
}

export interface DynamicSolidBatch extends SolidBatch {
  underRoutes: DrawRange;
  routeDraft: DrawRange;
  overVehicles: DrawRange;
}

export interface VehicleInstanceBatch {
  instances: Float32Array;
  instanceCount: number;
}

export interface WebGpuRenderFrame {
  transform: BoardTransform;
  structural: { cacheKey: number; batch: SolidBatch };
  routes: { cacheKey: string; batch: SolidBatch };
  dynamic: DynamicSolidBatch;
  vehicles: VehicleInstanceBatch;
}

export interface WebGpuRenderStats {
  structuralVertexCount: number;
  routeVertexCount: number;
  dynamicVertexCount: number;
  vehicleInstanceCount: number;
  vehicleUploadBytes: number;
  solidDrawCount: number;
  vehicleDrawCount: number;
}

export interface WebGpuRenderer {
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  destroy(): void;
}
```

- [ ] **Step 1: Add only ambient WebGPU types**

Add `@webgpu/types` as a dev dependency and include it in TypeScript ambient types. Do not add a runtime renderer library.

Run:

```bash
bun install
bun run check
```

- [ ] **Step 2: Write primitive tests before implementation**

Pin deterministic output for rectangles, thick lines, circles/rings, arrowheads/crosses, dashed strokes, and CSS color parsing. Quadratic/arc tessellation must sample `pointAndTangentAt()` rather than implement separate curve equations.

Example lock:

```ts
it("tessellates a quadratic through the shared path sampler", () => {
  const geometry: PathGeometry = {
    kind: "quadraticBezier",
    from: { x: 0, y: 0 },
    control: { x: 1, y: 1 },
    to: { x: 2, y: 0 },
  };
  const points = sampleGeometryPolyline(geometry, 4);
  expect(points[0]).toEqual(pointAt(geometry, 0));
  expect(points.at(-1)).toEqual(pointAt(geometry, 1));
  expect(points[2]).toEqual(pointAt(geometry, 0.5));
});
```

Run red, implement minimal geometry builder, then run green:

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts
```

- [ ] **Step 3: Add exactly two pipelines with alpha blending from day one**

`renderer.ts` owns one solid triangle pipeline and one instanced-vehicle pipeline. The solid target uses:

```ts
blend: {
  color: {
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
},
```

Own only reusable structural, route, dynamic-solid, and vehicle-instance buffers. Buffer capacity grows geometrically and is reused until growth is required. No per-feature GPU objects or material registry.

- [ ] **Step 4: Pin painter-stage draw order in renderer tests**

Using the narrow fake GPU boundary, assert the encoded solid/vehicle order is exactly:

```text
structural
underRoutes
a committed route range
routeDraft
vehicles
overVehicles
```

The renderer may skip empty ranges, but it may not reorder non-empty stages. Also assert structural/route cache keys prevent redundant uploads while dynamic geometry and vehicle instances update.

Run:

```bash
bunx vitest run tests/render/webgpuRenderer.test.ts
```

- [ ] **Step 5: Add the real Playwright WebGPU functional probe now, before host cutover**

Create `tests/e2e/webgpuAvailability.spec.ts`:

```ts
test("Chromium can create and submit a WebGPU canvas pass", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    if (navigator.gpu === undefined) return { ok: false, stage: "gpu" };
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) return { ok: false, stage: "adapter" };
    const device = await adapter.requestDevice();
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("webgpu");
    if (context === null) return { ok: false, stage: "context" };
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: "premultiplied",
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return { ok: true, stage: "done" };
  });
  expect(result).toEqual({ ok: true, stage: "done" });
});
```

Run both:

```bash
bunx playwright test tests/e2e/webgpuAvailability.spec.ts --project=chromium
bunx playwright test tests/e2e/webgpuAvailability.spec.ts --project=chromium --headed
```

If the configured headless worker returns `adapter`, first prove the minimum Chromium software-adapter launch configuration locally, then add only that configuration to `playwright.config.ts`. Do not skip the functional probe and do not use software-adapter timings as performance evidence.

- [ ] **Step 6: Verify Task 1**

Run:

```bash
bunx vitest run tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts
bun run check
bun run test:e2e
```

Expected: current Canvas product journeys plus the new real WebGPU probe pass.

- [ ] **Step 7: Commit**

```bash
git add src/render/webgpu tests/render/webgpuPrimitives.test.ts tests/render/webgpuRenderer.test.ts tests/e2e/webgpuAvailability.spec.ts package.json bun.lock tsconfig.json playwright.config.ts
git commit -m "feat: add minimal blended WebGPU renderer"
```

---

## Task 2: Port geometry into explicit painter-order batches

**Files:**
- Create: `src/render/webgpu/mapBatch.ts`
- Create: `src/render/webgpu/transitBatch.ts`
- Create: `src/render/webgpu/overlayBatch.ts`
- Retarget: `tests/render/mapRenderer.test.ts`
- Retarget: `tests/render/transitRenderer.test.ts`
- Retarget: `tests/render/overlayRenderer.test.ts`
- Modify: `tests/render/webgpuRenderer.test.ts`

**Interfaces:**
- Consumes: Task 0 board/path geometry, existing `routeGeometry.ts`, current selectors/placement validation, Task 1 primitives/renderer types.
- Produces:

```ts
export function buildStructuralBatch(state: GameState): SolidBatch;

export function routeEmphasisKey(ui: UiState): string;
export function buildCommittedTransitBatch(
  state: GameState,
  ui: UiState,
): SolidBatch;

export function buildDynamicSolidBatch(
  state: GameState,
  ui: UiState,
): DynamicSolidBatch;
```

`routeEmphasisKey(ui)` contains only the inputs that affect committed route dimming/highlight: `selectedRouteId` and the edited route ID, not hover/drag state.

- [ ] **Step 1: Retarget map tests to batch semantics**

Pin tile fill/grid categories, straight/corner roads, automatic junction approaches, roundabout geometry/ports, connected/isolated tracks, one-way arrows, and building footprint/outline intent.

Implement `buildStructuralBatch(state)` with map/building/road/track/roundabout geometry **only**. Do not put committed transit geometry into this buffer.

Run:

```bash
bunx vitest run tests/render/mapRenderer.test.ts
```

- [ ] **Step 2: Retarget committed transit tests and preserve dimming**

Pin bus/metro widths/colors, corridor offsets, disconnected/last-valid presentation, off-road connectors, stop/station/access markers, route direction arrows, and selected/edited route emphasis.

The cache key used by the caller is:

```ts
const routeCacheKey = `${sceneRevision}:${routeEmphasisKey(ui)}`;
```

A frame-only service-metric update with the same emphasis must reuse route geometry; changing selected/edited route must rebuild it even if `sceneRevision` is unchanged.

Use existing `canonicalCorridorPrimitive`, `corridorOffsets`, `directionArrowSamples`, `routePathPresentation`, and `UNRELATED_ROUTE_OPACITY` semantics. Do not port a second corridor model.

Run:

```bash
bunx vitest run tests/render/transitRenderer.test.ts tests/render/routeGeometry.test.ts
```

- [ ] **Step 3: Split dynamic geometry into painter-order ranges**

`buildDynamicSolidBatch(state, ui)` appends into one CPU buffer but records three ranges:

```ts
const underRoutes = builder.range(() => {
  appendCoverageDemandTrafficCrowding(...);
  appendHoverAndPlacementPreviews(...);
  appendRoadMutationMarkers(...);
  appendBrokenRouteMarkers(...);
});

const routeDraft = builder.range(() => {
  appendRouteDraftStroke(...);
});

const overVehicles = builder.range(() => {
  appendRouteDraftHandleGeometry(...); // circles/crosses only; text is DOM
});
```

Retarget overlay tests to assert these semantics. Text assertions belong only to `mapTextOverlay.test.ts`.

Run:

```bash
bunx vitest run tests/render/overlayRenderer.test.ts tests/render/mapTextOverlay.test.ts
```

- [ ] **Step 4: Lock painter order and opacity composition**

Add one renderer integration test with non-empty structural, under-route overlay, committed route, draft, vehicle, and handle ranges. Assert draw ordering and alpha values. Include a selected route and an unrelated route at `UNRELATED_ROUTE_OPACITY` so a full-opacity cached route batch cannot pass.

Run:

```bash
bunx vitest run tests/render/webgpuRenderer.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts
```

- [ ] **Step 5: Verify Task 2**

Run:

```bash
bunx vitest run tests/render/mapRenderer.test.ts tests/render/transitRenderer.test.ts tests/render/overlayRenderer.test.ts tests/render/routeGeometry.test.ts tests/render/webgpuRenderer.test.ts
bun run check
```

- [ ] **Step 6: Commit**

```bash
git add src/render/webgpu tests/render
git commit -m "feat: batch gameplay geometry in painter order"
```

---

## Task 3: Add path-following vehicle interpolation, viewport culling, and one instanced upload

**Files:**
- Create: `src/render/webgpu/vehicleInstances.ts`
- Create: `tests/render/webgpuVehicleInstances.test.ts`
- Modify: `src/render/webgpu/transitBatch.ts` only to expose/reuse its Canvas-neutral transit presentation cache
- Modify: `src/render/webgpu/renderer.ts`
- Retarget: vehicle-specific assertions in `tests/render/transitRenderer.test.ts`

**Interfaces:**
- Consumes: `GameState`, `Vehicle`, committed transit/corridor presentation cache, `pointAndTangentAt`, `WorldViewport`, Task 1 `VehicleInstanceBatch`.
- Produces:

```ts
export interface WorldViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface VehicleCursorSample {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  itineraryIndex: number;
  pathStepIndex: number;
  stepProgress: number;
  geometry: PathGeometry | null;
  travelSeconds: number | null;
  parkedPoint: TripPosition | null;
}

export interface VehiclePose {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  point: TripPosition;
  angleRadians: number | null;
}

export function sampleVehicleCursor(
  state: GameState,
  vehicle: Vehicle,
): VehicleCursorSample | null;

export function interpolateVehiclePose(options: {
  previousState: GameState | null;
  latestState: GameState;
  vehicleId: string;
  previousSceneRevision: number | null;
  latestSceneRevision: number;
  alpha: number;
}): VehiclePose | null;

export function buildVehicleInstanceBatch(options: {
  previousState: GameState | null;
  latestState: GameState;
  previousSceneRevision: number | null;
  latestSceneRevision: number;
  alpha: number;
  viewport: WorldViewport;
  ui: UiState;
}): VehicleInstanceBatch;
```

The transit presentation cache remains one `WeakMap<GameState, ...>` equivalent to today's `TransitRenderCache`; previous/latest state each resolve through their own cache. Do not create a persistent route cache keyed by gameplay IDs.

- [ ] **Step 1: Extract current vehicle cursor sampling with parity tests**

Retarget current tests for bus path, metro path, parked vehicle, zero-step terminal reversal, corridor-offset sampling, and invalid/missing path -> no pose.

The latest pose remains:

```ts
const sample = pointAndTangentAt(presentedGeometry, vehicle.stepProgress);
const angleRadians =
  Math.hypot(sample.tangent.x, sample.tangent.y) < 1e-9
    ? null
    : Math.atan2(sample.tangent.y, sample.tangent.x);
```

Run:

```bash
bunx vitest run tests/render/webgpuVehicleInstances.test.ts tests/render/transitRenderer.test.ts
```

- [ ] **Step 2: Write same-step path interpolation tests before implementation**

Use a quadratic curve whose geometric midpoint is not the chord midpoint:

```ts
it("interpolates stepProgress then resamples the quadratic path", () => {
  const previous = vehicleAt({ pathStepIndex: 0, stepProgress: 0.2 });
  const latest = vehicleAt({ pathStepIndex: 0, stepProgress: 0.8 });
  const pose = interpolateFixture(previous, latest, 0.5);
  const expected = pointAndTangentAt(quadraticGeometry, 0.5);
  expect(pose?.point).toEqual(worldCenter(expected.point));
  expect(pose?.angleRadians).toBeCloseTo(
    Math.atan2(expected.tangent.y, expected.tangent.x),
  );
});
```

Also include an arc case. A test that world-lerps previous/latest sampled points must fail these expectations.

- [ ] **Step 3: Write adjacent-step rollover and snap tests**

For same line + same itinerary + `latest.pathStepIndex === previous.pathStepIndex + 1`, use remaining/elapsed step time:

```ts
const remainingPrevious =
  (1 - previous.stepProgress) * previousStep.travelSeconds;
const elapsedLatest = latest.stepProgress * latestStep.travelSeconds;
const target = alpha * (remainingPrevious + elapsedLatest);
```

Sample previous geometry until `target` reaches its end, then latest geometry. Pin a corner/quadratic adjacency so chord lerp cannot pass.

Snap to latest for each of:

- scene revision changed;
- new/missing previous vehicle;
- paused or speed 0;
- `lineId` changed;
- itinerary index changed;
- parked -> path or path -> parked;
- backward step index;
- step jump greater than 1;
- missing/zero-duration adjacent geometry.

Do not independently interpolate heading; heading always comes from the sampled path tangent.

- [ ] **Step 4: Write culling/instance tests before implementation**

Prove:

```ts
expect(buildInstances(scaleState(5_000), wholeMapViewport).instanceCount).toBe(5_000);
expect(buildInstances(scaleState(20_000), narrowViewport).instanceCount).toBe(400);
```

Also pin one-tile culling margin, deterministic instance order, unrelated-route opacity, fixed record width, one instance-buffer upload, and one instanced vehicle draw.

Culling must occur after interpolation but before encoding; use a test where previous is outside/latest inside to distinguish the order.

- [ ] **Step 5: Implement the minimal path/culling pipeline**

Implementation order per vehicle:

```text
resolve latest cursor
resolve previous cursor when eligible
same-step or adjacent-step path interpolation; otherwise snap
sample position+tangent
apply route emphasis opacity
WorldViewport + one-tile margin cull
append fixed-size instance record
```

The renderer owns one six-vertex unit quad and one grow-only instance buffer. No per-vehicle object/buffer/bind group/draw call.

- [ ] **Step 6: Verify Task 3**

Run:

```bash
bunx vitest run tests/render/webgpuVehicleInstances.test.ts tests/render/transitRenderer.test.ts tests/render/webgpuRenderer.test.ts
bun run check
```

- [ ] **Step 7: Commit**

```bash
git add src/render/webgpu tests/render/webgpuVehicleInstances.test.ts tests/render/transitRenderer.test.ts tests/render/webgpuRenderer.test.ts
git commit -m "feat: path-interpolate visible transit vehicles"
```

---

## Task 4: Cut the production host to WebGPU, centralize scene revision, move text to DOM, and run full E2E

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
- Modify: `tests/ui/appShell.test.ts` only for changed composition/props

**Interfaces:**
- Consumes: Task 1 renderer, Task 2 batches, Task 3 vehicle instances, existing runtime `tick()`/serialized queue, Task 0 text/board helpers.
- Produces:

```ts
interface WebGpuHostDeps {
  createRenderer(): Promise<WebGpuRenderer>;
}

export async function createWebGpuHost(
  context: WebGpuHostContext,
  deps?: WebGpuHostDeps,
): Promise<WebGpuHost>;
```

Public `RuntimeController.mountCanvas(host): () => void` remains unchanged.

- [ ] **Step 1: Centralize all accepted `PresentationUpdate` installation**

Add one helper beside runtime state:

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

Use it at **all four** current acceptance seams:

```text
initial backend.presentation()
commitDispatchResult(result.update)
installRestoredGameplay(update)
successful reset result.update
```

Runtime tests pin initial revision 1, frame-only tick unchanged, frame-only rejected/no-op unchanged, scene-bearing dispatch +1, restore +1, reset +1. Do not use object/deep equality to infer revision.

- [ ] **Step 2: Port Canvas host lifecycle/input behavior onto a fake WebGPU renderer**

Start from `canvasHost.test.ts` behavior and pin:

- one canvas mount;
- adapter/device requested once per host;
- DPR/ResizeObserver sizing;
- click -> exact tile mapping through `clientPointToTile`;
- hover/pointer capture/drag start-current-commit-cancel/context-menu/leave behavior;
- remount/teardown listener/observer/rAF cleanup;
- clear unavailable-GPU/null-adapter bootstrap errors.

Tests inject only:

```ts
const deps: WebGpuHostDeps = {
  createRenderer: vi.fn(async () => fakeRenderer),
};
```

Do not mock a browser-wide WebGPU object graph.

- [ ] **Step 3: Write the 10 Hz/rAF contract before implementation**

With fake rAF timestamps and deferred `onTick`, prove:

```text
0 ms      render, no tick
50 ms     render, no tick
100 ms    render, submit one 0.100s tick
150 ms    render while pending, no second tick
220 ms    render while pending, no second tick
settle    next eligible frame may submit retained accumulated time
```

Also prove submitted delta is capped at 0.25 s, stop/pause clears timestamp+accumulator, speed 0 submits no tick, and every rAF renders even while a tick promise is pending.

`onTick` calls `api.tick(deltaSeconds)`; that method still enters `createSerializedQueue`. Do not add a second queue.

- [ ] **Step 4: Implement host render-state history and explicit cache keys**

The host retains previous/latest `GameState` + scene revision only for vehicles. On each rAF:

```ts
const latestState = ctx.getState();
const revision = ctx.getSceneRevision();
const routeKey = `${revision}:${routeEmphasisKey(ctx.getUi())}`;
const structural = buildStructuralBatch(latestState);
const routes = buildCommittedTransitBatch(latestState, ctx.getUi());
const dynamic = buildDynamicSolidBatch(latestState, ctx.getUi());
const vehicles = buildVehicleInstanceBatch({
  previousState,
  latestState,
  previousSceneRevision,
  latestSceneRevision: revision,
  alpha,
  viewport: wholeMapViewport(latestState.map),
  ui: ctx.getUi(),
});
renderer.render({
  transform,
  structural: { cacheKey: revision, batch: structural },
  routes: { cacheKey: routeKey, batch: routes },
  dynamic,
  vehicles,
});
```

The implementation may avoid rebuilding CPU `structural`/`routes` when their keys are unchanged; the key contract is authoritative. Scene changes clear previous vehicle history immediately.

- [ ] **Step 5: Move map-local text to Svelte without letting runtime DOM cleanup erase it**

Change `GameCanvas.svelte` to:

```text
.board (Svelte focus/accessibility owner)
  .board-surface (absolute/inset: 0; runtime mounts only its canvas here)
  MapTextOverlay (absolute/inset: 0; pointer-events: none)
```

`App.svelte` already owns the current `RuntimeSnapshot`; pass its `state` and `ui` into `GameCanvas`/`MapTextOverlay` rather than creating another store.

Both `.board-surface` and the overlay must resolve the same CSS width/height for `getBoardTransform`. Tests use a known rect and assert a tile label and GPU surface transform map to the same CSS position.

Pin that runtime `mountCanvas(surface)` can clear **surface children only** without removing `MapTextOverlay`, `.board` remains the focus/ARIA owner, teardown still runs, and overlay pointer-events cannot intercept gestures.

- [ ] **Step 6: Run focused host/runtime/UI tests**

Run:

```bash
bunx vitest run tests/render/webGpuHost.test.ts tests/render/webgpuRenderer.test.ts tests/render/webgpuVehicleInstances.test.ts tests/runtime tests/ui/mapTextOverlay.test.ts tests/ui/gameCanvas.test.ts tests/ui/pointerEvents.test.ts tests/ui/appShell.test.ts
bun run check
```

- [ ] **Step 7: Run the full existing Playwright suite now, before Canvas deletion**

Run:

```bash
bun run test:e2e
```

This is a hard Task 4 gate. Preserve build/track/demolish, pointer/drag, route create/edit, panel occlusion, save/restore, and simulation control journeys. Fix the WebGPU host/cadence/input implementation rather than weakening those journeys.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/createWebGpuHost.ts src/runtime/createGameRuntime.ts src/components/GameCanvas.svelte src/components/MapTextOverlay.svelte src/App.svelte tests
git commit -m "feat: cut runtime display loop to WebGPU"
```

---

## Task 5: Delete Canvas2D, record real-GPU evidence, smoke Tauri, and close the same PR

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
- Modify: `package.json` only if benchmark command changes

**Interfaces:**
- Consumes: completed Tasks 0-4 and the same Task 0 scale fixture.
- Produces: one production WebGPU renderer, no production Canvas2D renderer, final reference evidence and ownership docs.

- [ ] **Step 1: Delete Canvas production modules only after Task 4 E2E is green**

Remove the listed files. `pathGeometry.ts`, `boardTransform.ts`, `routeGeometry.ts`, `placementValidation.ts`, `colors.ts`, and the WebGPU modules remain.

Run cleanup searches:

```bash
rg 'getContext.*2d|CanvasRenderingContext2D|createCanvasHost|renderGame\(' src tests
rg 'mapRenderer|buildingRenderer|roundaboutRenderer|pathRenderer|transitRenderer|overlayRenderer|cursorBadge' src tests
```

Expected production result: no Canvas2D gameplay renderer/context under `src`. Historical docs may still describe older architecture.

- [ ] **Step 2: Retarget the exact Task 0 fixture to WebGPU**

Keep the same 1280×800 scene, 5,000 vehicles, 30 warm-up frames, and 120 measured frames. Return:

```ts
interface RendererScaleResult {
  presentedVehicleCount: number;
  encodedVehicleCount: number;
  vehicleUploadBytes: number;
  solidDrawCount: number;
  vehicleDrawCount: number;
  medianCpuMs: number;
  p95CpuMs: number;
  queueCompletionAverageMs: number;
}
```

After 120 submissions call `await device.queue.onSubmittedWorkDone()` before calculating the queue-completion evidence.

Run on the reference M1 Pro with normal GPU-backed Chromium:

```bash
bun run bench:render
```

Update `docs/performance/hpa-640-webgpu.md` with Canvas baseline vs final WebGPU results and explicitly state that HPA-544 `PresentationUpdate` shape/cardinality was unchanged.

Do not compare software-adapter results with the real-GPU reference table.

- [ ] **Step 3: Perform the Tauri release-target smoke before final closeout**

Run:

```bash
bun run tauri:dev
```

Verify:

```text
map/buildings/routes visible with correct layering
coverage/demand/traffic overlays remain below transit lines
route selection dims unrelated routes and vehicles
build/track/demolish pointer gestures work
route edit handles/text align with GPU geometry
moving bus/metro follows corners/curves without chord-cutting
10 Hz publication + rAF display appears continuous
```

Record machine/WebView observation in `docs/performance/hpa-640-webgpu.md`. A Tauri WebGPU failure blocks Canvas closeout; do not add a fallback renderer.

- [ ] **Step 4: Update architecture ownership docs**

`docs/architecture.md` and `CLAUDE.md` must identify:

- Svelte: app/HUD/map text;
- `createGameRuntime`: gameplay orchestration plus internal `sceneRevision` from accepted `PresentationUpdate.scene`;
- existing `createSerializedQueue`: sole gameplay-operation serializer;
- `createWebGpuHost`: GPU canvas/input/resize/rAF/10 Hz host gate;
- WebGPU batch modules: ordered geometric presentation;
- vehicle instance path: previous/latest path-cursor interpolation + viewport culling only;
- Rust: gameplay authority and unchanged HPA-544 presentation wire.

Remove current claims that Canvas2D/`createCanvasHost` owns gameplay rendering.

- [ ] **Step 5: Run the full repository gate fresh**

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

- [ ] **Step 6: Final scope review against HPA-640**

Check explicitly:

- one WebGPU gameplay renderer only;
- same Rust/schema/backend methods as before;
- every accepted presentation update flows through one `sceneRevision` helper;
- existing serialized gameplay queue retained; no second queue;
- 10 Hz publication / rAF display, at most one host tick request in flight;
- same-step and adjacent-step interpolation resample `PathGeometry`; no world-position or heading lerp;
- discontinuous vehicle cursor transitions snap;
- viewport culling occurs before instance encoding/upload;
- 5,000 visible vehicles use one reused instance buffer and one instanced draw;
- structural batch keyed only by scene revision;
- route batch additionally invalidates on selected/edited route emphasis;
- source-alpha blending enabled;
- painter order is map -> overlays -> routes -> draft -> vehicles -> handles -> DOM text;
- Svelte map text/HUD retained and aligned to the same board box;
- early Chromium WebGPU probe, post-cutover E2E, and Tauri smoke all executed;
- no camera/scene graph/fallback scope creep;
- Canvas baseline/final WebGPU evidence recorded.

- [ ] **Step 7: Commit final cutover/evidence**

```bash
git add -A
git commit -m "refactor: complete HPA-640 WebGPU cutover"
```

Continue review and implementation on this same draft PR. Do not open a second PR for execution, cleanup, or verification.