# HPA-640 WebGPU Gameplay Renderer Cutover Design

## Status

Planning design for HPA-640, based on `main` at `717bd841ece76a6b34a09e9d2a94a423b54f8d69` after HPA-544, HPA-347, and HPA-348.

This revision incorporates the second pre-implementation review. HPA-640 remains one implementation ticket and one PR; implementation, browser/Tauri parity, performance evidence, and Canvas2D deletion stay on this draft PR.

## Goal

Replace the Canvas2D gameplay renderer with one focused TypeScript WebGPU path while keeping Svelte as application/HUD/map-text UI and Rust as gameplay authority.

The renderer is designed against the roadmap's future presentation contract of roughly **5,000 simultaneously visible road/public-transport vehicles**. That is deliberately a capacity target, not a claim that today's 28×18 sandbox economy can naturally buy 5,000 transit vehicles. The benchmark therefore records both:

- **200 vehicles** as a near-term stress/reference row for the current small-map presentation; and
- **5,000 vehicles** as the committed HPA-336/HPA-640 future-scale ceiling.

The benchmark is evidence, not a gate that reopens the already-approved WebGPU roadmap decision. It does let us attribute the eventual improvement correctly between lower publication cadence and GPU rendering.

## Existing constraints

The current architecture already supplies the important scale boundary:

- Rust publishes compact `PresentationUpdate` data; ordinary frontend state does not carry the latent 200k-citizen population.
- `createGameRuntime.ts` folds those updates into the flat `GameState` used by Svelte and rendering.
- `createCanvasHost.ts` owns the `<canvas>`, pointer input, resize lifecycle, requestAnimationFrame loop, and currently requests one backend tick per rAF.
- `render/canvas.ts` fits the whole 28×18 map into the board. There is no player camera/pan/zoom state on `main`.
- Current painter order is `map -> buildings -> overlays -> transit -> route handles -> text badges`.
- Current visuals are mostly flat geometric shapes.
- `routeGeometry.ts` already owns Canvas-independent route/corridor presentation math.
- `pointAndTangentAt()` already samples line, quadratic-bezier, and arc `PathGeometry`.
- `placementValidation.ts`, catalogs, and runtime selectors are renderer-neutral presentation logic.
- `createSerializedQueue` is the one gameplay-operation serializer and remains authoritative for backend ordering.
- `GameCanvas.svelte` expects `mountCanvas(host): () => void` to remain synchronous after runtime creation.

Two current details constrain the cutover.

First, `applyPresentationUpdate()` rebuilds live route/metro rows on every frame to merge `serviceMetrics`. Route-array identity is therefore not a structural-scene signal. `PresentationUpdate.scene !== null` is the correct source for one runtime `sceneRevision`.

Second, lower-frequency publication cannot be smoothed with world-space pose lerp. At speed 4 a 100 ms wall interval advances 400 ms of simulation; a bus tile is 1.25 s and a metro tile is 0.625 s. Vehicles can move far enough to traverse curves or cross a step boundary. Interpolation must stay in path/cursor space and derive heading from the sampled tangent.

## Review disposition

### Accepted

The design adopts these review corrections before coding:

1. Preserve painter order; do not fuse base transit into the structural map buffer.
2. Keep current Canvas renderer tests until their production modules are deleted.
3. Prove real Chromium WebGPU early, before production host cutover.
4. Run the Tauri/WKWebView smoke after host cutover and **before** deleting Canvas2D.
5. Thread a host factory through `CreateGameRuntimeOptions` so Node/jsdom runtime tests never require `navigator.gpu`.
6. Surface unexpected `GPUDevice.lost` through the existing runtime fatal/shell-error path; deliberate `device.destroy()` during teardown is ignored.
7. Compute vehicle interpolation alpha from the observed interval between the two accepted presentation states, not a fixed 100 ms.
8. Preserve the existing `canvasToTile` name; moving it to `boardTransform.ts` is enough.
9. Use string cache keys consistently.
10. Make the runtime's direct render calls coalesce with the active rAF loop so accepted ticks do not double-render while running; paused/stopped state still repaints immediately.

### Not adopted

Two review recommendations change product/delivery decisions rather than correct the design:

- **Do not make WebGPU conditional on current 200-vehicle Canvas performance.** HPA-336 explicitly commits to a ~5k-visible-vehicle GPU presentation direction, and HPA-640 explicitly owns the WebGPU cutover. The 200-row measurement provides current-scale context; the 5k row proves the future capacity contract.
- **Do not split HPA-640 into multiple PRs/tickets.** Both the roadmap and HPA-640 specify one implementation slice/ticket = one PR. The branch uses task/commit checkpoints so review can happen incrementally without creating a long-lived dual-renderer delivery model. A split requires an explicit product decision, not an implementation-review rewrite.

## Decision summary

1. Raw browser WebGPU in TypeScript; no PixiJS, retained scene graph, Rust `wgpu`, or Bevy renderer.
2. Add only ambient WebGPU TypeScript types if needed (`@webgpu/types` as a dev dependency).
3. Keep `PresentationUpdate`, `GameBackend`, and durable snapshot/schema contracts unchanged.
4. Add one runtime-internal integer `sceneRevision`, incremented only when an accepted update has `scene !== null`.
5. Route initial presentation, dispatch, restore, and reset through one `acceptPresentationUpdate()` helper.
6. Extract `pointAndTangentAt`/`pointAt` into Canvas-neutral `pathGeometry.ts`; Canvas transition code and WebGPU reuse the same sampler.
7. Extract board transform/picking into `boardTransform.ts`; keep `canvasToTile` unchanged.
8. Display at rAF cadence while requesting backend updates at 10 Hz with at most one host tick request in flight on top of the existing serialized queue.
9. Keep the 250 ms submitted wall-delta cap; retain overflow while a tick is pending.
10. When rAF owns continuous display, runtime `render()` requests do not perform a second immediate draw. Paused/stopped state still repaints immediately.
11. Interpolate vehicles in path cursor space; heading always comes from `pointAndTangentAt()` on the interpolated cursor.
12. Use the **observed previous-to-latest publication interval** to compute alpha, clamped to `[0, 1]`.
13. Snap across discontinuities rather than inventing a general route timeline.
14. Cull after path sampling/interpolation and before instance encoding/upload.
15. Preserve painter order explicitly.
16. Enable source-alpha blending in the solid pipeline from the first WebGPU task.
17. Structural map geometry caches by a string `sceneRevision` key; committed route geometry caches by scene revision plus selected/edited-route emphasis.
18. Keep route-draft and preview geometry dynamic.
19. Keep HUD/map-local text in Svelte/DOM; no GPU font atlas or second Canvas surface.
20. Keep whole-map fit behavior; `WorldViewport` is a plain tested rectangle, not a camera/LOD framework.
21. `createGameRuntime` accepts an optional async `createHost` factory; production defaults to `createWebGpuHost`, tests inject a fake host.
22. `createWebGpuHost` remains async, so adapter/device setup finishes before runtime is returned while public `mountCanvas()` stays synchronous.
23. Real Chromium WebGPU probe runs before cutover; full Playwright and Tauri/WKWebView gates run after cutover but before Canvas deletion.
24. Delete Canvas2D production modules and their Canvas-specific tests together in this same PR only after both browser and desktop gates pass.

## Target architecture

```text
Rust simulation authority
        |
        | existing PresentationUpdate / tick()
        v
createGameRuntime
  |- latest compact GameState / UiState
  |- existing serialized gameplay queue
  |- sceneRevision
  `- createHost? test seam
        |
        v
createWebGpuHost --------------------------------------------------+
  | rAF display loop                                               |
  | 10 Hz / one-in-flight backend tick admission                  |
  | previous/latest accepted-state timestamps                     |
  | shared board transform + pointer mapping                      |
  | device-loss -> runtime fatal callback                         |
  |                                                                |
  +--> WebGPU renderer                                             |
  |      1. map/buildings/roads/tracks       [scene key]           |
  |      2. data + placement overlays        [dynamic]             |
  |      3. committed routes/stops/arrows    [route style key]     |
  |      4. route-draft stroke               [dynamic]             |
  |      5. transit vehicles                 [instanced]           |
  |      6. route-handle marker geometry     [dynamic]             |
  |                                                                |
  `--> GameCanvas + MapTextOverlay (Svelte DOM) <-----------------+
         cursor badge / preview feedback / waypoint numbers /
         broken-route guidance

Svelte HUD/panels remain ordinary DOM UI.
```

The six GPU stages are painter-order ranges, not a scene graph. Dynamic triangle ranges may share one grow-only vertex buffer.

## Scene revision and update acceptance

`createGameRuntime.ts` owns:

```ts
let sceneRevision = 0;

function acceptPresentationUpdate(
  current: GameState | null,
  update: PresentationUpdate,
): GameState {
  if (update.scene !== null) sceneRevision += 1;
  return applyPresentationUpdate(current, update);
}
```

Every accepted presentation update uses this helper:

- initial `backend.presentation()`;
- `commitDispatchResult()`;
- successful restore through `installRestoredGameplay()`;
- successful reset.

Initial presentation installs revision 1. Frame-only ticks/no-op updates leave it unchanged. Structural dispatch/reset/restore advances it exactly once.

No array identity, deep comparison, fingerprint, or persisted renderer revision is added.

## Runtime host injection

Async WebGPU creation changes test construction semantics. Do not force all Node/jsdom runtime tests to mock `navigator.gpu`.

Extend only the runtime constructor options:

```ts
export type CreateGameHost = (
  context: WebGpuHostContext,
) => Promise<GameHost>;

export interface CreateGameRuntimeOptions {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity?: CitySummary | null;
  now?: () => string;
  createCityId?: () => string;
  hoverPreviewDebounceMs?: number;
  createHost?: CreateGameHost;
}
```

Production uses:

```ts
const createHost = options.createHost ?? createWebGpuHost;
const gameHost = await createHost(hostContext);
```

Runtime tests inject `async () => fakeHost`. This is a construction seam only; it does not become a renderer plugin system and does not alter `RuntimeController`.

## Cadence and repaint contract

### Backend publication

While runtime is started, simulation is running/unpaused, and speed is non-zero:

- every rAF is a display opportunity;
- wall time accumulates;
- at/after 100 ms, if no host tick is pending, submit one `api.tick(accumulatedDelta)`;
- clamp that submitted wall delta to 250 ms;
- retain excess accumulated time;
- while that tick is unresolved, keep drawing but submit no second host tick.

The call still enters the existing `createSerializedQueue`; the host gate does not replace or bypass it.

Pausing/stopping resets wall timestamps/accumulator so resume does not catch up stale background time.

### Runtime-triggered repaint

Today `publish()`/`commit()` call the host renderer directly. With a free-running rAF display loop, doing the same would draw twice around every accepted tick.

The new `GameHost.render()` contract is therefore:

- while an active rAF loop owns display, record that latest state/UI is available and let the next rAF draw it; do not synchronously draw a second frame;
- when paused/stopped/no rAF is scheduled, draw immediately so hover/tool/restore/error UI can repaint without simulation time advancing;
- terminal publication stops the loop first and then performs one final immediate render.

Tests pin that one accepted running tick does not create an extra draw, while paused UI commits still repaint synchronously.

### Observed-interval interpolation alpha

The host retains:

- previous accepted `GameState` + scene revision + `observedAtMs`;
- latest accepted `GameState` + scene revision + `observedAtMs`.

For two compatible accepted states:

```text
interval = max(1 ms, latestObservedAt - previousObservedAt)
alpha = clamp((rafNow - latestObservedAt) / interval, 0, 1)
```

This intentionally renders vehicle motion one observed publication interval behind authority; it never extrapolates.

A 130 ms accepted-state interval therefore interpolates for 130 ms rather than saturating at the nominal 100 ms and freezing for the final 30 ms. Metrics, clock, budget, overlays, and Svelte UI always use latest state; only vehicle cursor presentation interpolates.

## Shared board and path geometry

Create `src/render/boardTransform.ts` from Canvas-neutral code currently in `canvas.ts`:

- `tileSize`;
- `BoardTransform`;
- `getBoardTransform`;
- DPR-aware backing-store sizing;
- existing `canvasToTile`.

Keep the `canvasToTile` name: the WebGPU surface is still an `HTMLCanvasElement`, so renaming it adds churn without new semantics.

Create `src/render/pathGeometry.ts` from Canvas-neutral code currently in `pathRenderer.ts`:

```ts
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
```

`routeGeometry.ts`, transitional Canvas drawing, WebGPU tessellation, broken-route midpoint calculation, and vehicle sampling all consume these helpers. `primitives.ts` selects tessellation sample density but does not reimplement line/bezier/arc equations.

## GPU renderer and painter order

### Minimal primitive builder

`render/webgpu/primitives.ts` appends colored triangles for:

- tile/rectangle fills;
- thick line/polyline strokes;
- curves sampled through `pathGeometry.ts`;
- circles/rings;
- arrowheads/crosses;
- dashed strokes.

No display object/material/node model exists.

### Pipelines and buffers

Use:

- one solid-color triangle pipeline with source-alpha blending;
- one instanced vehicle-quad pipeline;
- one grow-only structural triangle buffer;
- one grow-only route triangle buffer;
- one grow-only dynamic triangle buffer with explicit ordered ranges;
- one grow-only vehicle instance buffer.

Cache keys are strings:

```ts
const sceneKey = `scene:${sceneRevision}`;
const routeStyleKey =
  `routes:${sceneRevision}:${selectedRouteId ?? "-"}:${editedRouteId ?? "-"}`;
```

No generic cache-key type/framework is introduced.

### Painter order

`webgpu/mapBatch.ts` contains only map/building/road/track/roundabout geometry.

`webgpu/overlayBatch.ts` emits named dynamic ranges:

- `underRoutes`: data overlays, hover/selection, building/area/road/track/remove previews, road-mutation markers, broken-route markers;
- `routeDraft`: draft path stroke;
- `overVehicles`: route-handle circle/cross geometry without text.

`webgpu/transitBatch.ts` emits committed routes, stops/stations, access indicators, route-node cues, and direction arrows with current selected/edited route dimming/emphasis.

Render order is always:

```text
map/buildings
underRoutes overlays
committed routes/stops/arrows
routeDraft
instanced vehicles
overVehicles handle markers
DOM text
```

This preserves the current visual contract: translucent overlays remain beneath route lines and route selection/editing can dim unrelated lines and vehicles.

## Vehicle interpolation and culling

`webgpu/vehicleInstances.ts` owns cursor interpolation, pose sampling, viewport culling, and instance encoding.

For each latest vehicle:

1. Resolve the matching previous vehicle by stable ID.
2. Snap to latest for pause/speed 0, scene change, new/missing previous vehicle, `lineId` change, parked/path transition, backward cursor, non-adjacent cursor jump, or any continuity case we cannot prove cheaply.
3. Same line + same itinerary + same path step: lerp `stepProgress`, then sample the presented `PathGeometry` once with `pointAndTangentAt()`.
4. One adjacent step on the same itinerary: interpolate through the remaining previous-step time plus elapsed latest-step time, then sample the selected step with `pointAndTangentAt()`.
5. Larger jumps or itinerary/terminal boundaries snap to latest. Do not build a general timeline.
6. Derive angle from the sampled tangent; do not independently interpolate heading.
7. Apply route emphasis opacity.
8. Cull against `WorldViewport` plus a one-tile margin.
9. Encode one fixed-size instance for each remaining vehicle.

For adjacent steps:

```text
remainingPrevious =
  (1 - previous.stepProgress) * previousStep.travelSeconds
elapsedLatest =
  latest.stepProgress * latestStep.travelSeconds
span = remainingPrevious + elapsedLatest
target = alpha * span
```

Zero/invalid span snaps to latest.

Tests include quadratic and arc geometry so a world-space chord implementation cannot pass.

The GPU owns one unit quad and draws all visible vehicles in one instanced draw. No per-vehicle GPU buffer/object/bind group/draw call.

Private-car traffic remains aggregate; HPA-640 does not create private-car actors to manufacture the 5k benchmark.

## Viewport culling

Use one plain rectangle:

```ts
export interface WorldViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

Current production whole-map fit yields a viewport covering the map. Unit tests feed a narrower viewport and prove presented vehicles are removed before instance encoding/upload. No camera or LOD subsystem is added.

## Map-local DOM text

GPU text remains out of scope.

Create pure `render/mapTextOverlay.ts` derivation plus `MapTextOverlay.svelte` for:

- cursor/tool badge;
- road-preview feedback;
- route waypoint numbers;
- broken-route guidance.

Geometric handle circles/crosses stay WebGPU.

`GameCanvas.svelte` owns:

```text
.board
  .board-surface        <-- runtime mounts only its canvas here
  MapTextOverlay        <-- pointer-events: none
```

Both `.board-surface` and the overlay are `position:absolute; inset:0`, so they share the same CSS box. Both use `getBoardTransform` with that box size. The runtime never calls `innerHTML = ""` on the Svelte-owned `.board`.

## WebGPU lifecycle and fatal loss

`createWebGpuHost()` is async. It creates the renderer/device before runtime construction returns, preserving synchronous `mountCanvas(host): () => void`.

`WebGpuRenderer` exposes the device-loss promise in a narrow form:

```ts
export interface WebGpuDeviceLoss {
  reason?: string;
  message: string;
}

export interface WebGpuRenderer {
  readonly lost: Promise<WebGpuDeviceLoss>;
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  destroy(): void;
}
```

The host forwards a loss whose reason is not `"destroyed"` to `WebGpuHostContext.onFatalError`. Runtime routes that through the same terminal `backendError`/shell-error transition used for fatal backend failure. Teardown calls `destroy()`; the resulting deliberate `"destroyed"` loss is ignored.

HPA-640 does **not** add automatic device recreation or a Canvas fallback; one loud terminal error is the KISS behavior.

## Browser and Tauri gates

### Early Chromium capability probe

Before production cutover, Playwright runs a focused page that:

1. asserts `navigator.gpu`;
2. requests an adapter/device;
3. gets/configures `getContext("webgpu")`;
4. submits one clear render pass;
5. awaits `device.queue.onSubmittedWorkDone()`.

Run one headed Chromium probe on the reference machine. If CI/headless requires an explicit functional software adapter/configuration, pin only the minimum required settings. Never compare software-adapter timings to real-GPU performance evidence.

### Production cutover gate

After `createGameRuntime` switches to `createWebGpuHost`, but while all Canvas modules/tests still exist:

1. run focused runtime/host/unit tests;
2. run the full existing Playwright suite through the WebGPU production path;
3. run `tauri:dev` on the intended desktop path and verify rendering, resize/input, and smooth vehicle motion.

A failure in either Chromium or Tauri blocks Canvas deletion. The old Canvas implementation remains in the branch as a debugging oracle until both gates pass, but it is not a runtime fallback.

## Performance evidence

Use one renderer-only fixture composed from existing `tests/helpers/gameState.ts` and `tests/helpers/mapFixtures.ts`; do not create a second city/route fixture framework.

Record two cardinalities with the same representative geometry:

- `vehicles-200`;
- `vehicles-5000`.

Before cutover, record Canvas median/p95 CPU render time for both. After cutover, record WebGPU median/p95 CPU encode+submit time plus structural counts for both. The 5k row is the HPA-336 scale ceiling; the 200 row makes the current-scale cost visible.

The synthetic repeated transit rows are a renderer stress proxy for the committed visible-vehicle capacity target; they are not meant to model 5,000 manually purchased buses in today's economy.

Also record cadence separately:

- old contract: up to one backend publication request per rAF;
- new contract: at most 10 host tick requests/sec, still serialized by `createSerializedQueue`;
- HPA-544 projection/serialization evidence remains the wire-cost baseline.

Final evidence must not attribute all improvement to WebGPU if the cadence change is the larger contributor.

Wall-clock values are documentation evidence, not CI thresholds. CI pins deterministic properties: painter order/ranges, blending config, one-in-flight tick admission, observed-interval alpha, culling before encode, one vehicle instance upload/draw, cache reuse, and no Canvas production path after deletion.

## Risks and gates

| Risk | Required gate |
| --- | --- |
| Curve/step interpolation draws chords or jumps | Same-step quadratic/arc + adjacent-step tests; discontinuities snap |
| Dynamic overlays cover routes / route dimming is lost | Ordered range tests + current Canvas oracle retained until cutover |
| Headless Chromium lacks WebGPU | Early real probe; minimal functional adapter config only if required |
| Tauri/WKWebView differs from Chromium | `tauri:dev` smoke after cutover and before Canvas deletion |
| Runtime tests construct WebGPU in Node/jsdom | `CreateGameRuntimeOptions.createHost` fake-host injection |
| Device lost mid-session freezes silently | fake lost-promise test -> terminal shell error; no automatic recovery |
| Running tick publication causes duplicate draws | host render-coalescing test; paused repaint test |
| Variable tick latency causes alpha freeze | observed-interval alpha test (e.g. 130 ms gap) |
| 5k benchmark is mistaken for current gameplay reachability | docs report 200 current-scale context and 5k roadmap ceiling separately |

## Target files

```text
src/render/
  boardTransform.ts
  pathGeometry.ts
  colors.ts                         retained
  placementValidation.ts            retained
  routeGeometry.ts                  retained
  mapTextOverlay.ts
  webgpu/
    primitives.ts
    mapBatch.ts
    transitBatch.ts
    overlayBatch.ts
    vehicleInstances.ts
    renderer.ts

src/runtime/
  createWebGpuHost.ts

src/components/
  GameCanvas.svelte
  MapTextOverlay.svelte
```

Canvas production modules remain until the post-cutover Chromium and Tauri gates pass. Then delete them together with their Canvas-specific tests:

- `src/runtime/createCanvasHost.ts`;
- `src/render/canvas.ts`;
- `src/render/mapRenderer.ts`;
- `src/render/buildingRenderer.ts`;
- `src/render/roundaboutRenderer.ts`;
- `src/render/pathRenderer.ts` after Canvas-only drawing has moved and `pathGeometry.ts` owns sampling;
- `src/render/transitRenderer.ts`;
- `src/render/overlayRenderer.ts`;
- `src/render/cursorBadge.ts`.

## Explicit non-goals

- no camera/pan/zoom product feature;
- no PixiJS/scene graph/material/plugin framework;
- no Godot/Bevy renderer or Rust `wgpu`;
- no GPU text/texture-art pipeline;
- no lighting/3D/physics/compute simulation;
- no rendered 200k citizens;
- no private-car actor simulation;
- no snapshot/schema/backend API change;
- no second gameplay queue;
- no automatic GPU-device recovery;
- no Canvas fallback after cutover;
- no second HPA-640 PR without an explicit product decision.

## Acceptance

HPA-640 is complete on this one PR when:

1. gameplay uses one WebGPU canvas and production `src` has no Canvas2D gameplay context;
2. HPA-544 `PresentationUpdate`, `GameBackend`, and durable snapshot/schema contracts are unchanged;
3. initial/dispatch/restore/reset state installation shares one `sceneRevision` helper;
4. backend publication admission is 10 Hz / one host tick in flight while display remains rAF-driven and the existing serialized queue remains authoritative;
5. runtime-triggered render requests do not double-render while rAF is active, while paused/stopped commits still repaint immediately;
6. vehicle smoothing uses observed-interval alpha and path-space cursor interpolation, with quadratic/arc and adjacent-step tests and snap-on-discontinuity;
7. source-alpha blending and explicit painter order preserve overlays/routes/dimming;
8. structural and route-style caches use string keys and do not depend on live array identity;
9. 5,000 visible vehicles cull/encode into one grow-only instance upload and one instanced draw; narrowed viewport tests prove offscreen rows are removed before encoding;
10. Svelte owns HUD/panels/map text; WebGPU owns geometric gameplay presentation;
11. Canvas tests remain until their Canvas modules are deleted;
12. early Chromium WebGPU probe passes before cutover;
13. after cutover, full Playwright and Tauri/WKWebView smoke pass before Canvas deletion;
14. unexpected device loss reaches the terminal shell error instead of silently freezing;
15. performance evidence reports both 200-vehicle current-scale context and 5k future-scale ceiling, and separates cadence/wire benefit from renderer benefit;
16. final unit/type/lint/build/E2E gates pass and Canvas-specific production modules/tests are removed together.
