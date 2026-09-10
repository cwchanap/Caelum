# HPA-640 WebGPU Gameplay Renderer Cutover Design

## Status

Planning design for HPA-640, based on `main` at `717bd841ece76a6b34a09e9d2a94a423b54f8d69` after HPA-544, HPA-347, and HPA-348.

This revision incorporates the pre-implementation review of vehicle interpolation, painter's order, and WebGPU host risk. HPA-640 remains one implementation ticket and one PR; implementation, parity work, performance evidence, and Canvas2D deletion continue on this same branch.

## Goal

Replace the Canvas2D gameplay renderer with one focused TypeScript WebGPU path that can batch roughly 5,000 visible transit vehicles while preserving the current transport-sandbox interactions. Keep Svelte as application/HUD/map-text UI and Rust as gameplay authority.

## Current shape

The current architecture already provides the important scale boundary:

- Rust publishes compact `PresentationUpdate` data; ordinary frontend state no longer carries the latent 200k-citizen population.
- `createGameRuntime.ts` folds those updates into the flat `GameState` used by Svelte and rendering.
- `createCanvasHost.ts` owns the real `<canvas>`, pointer input, resize lifecycle, and requestAnimationFrame loop.
- The current rAF loop also calls backend `tick(deltaSeconds)`, so display cadence and simulation/presentation publication are coupled.
- `render/canvas.ts` fits the whole 28×18 map into the board. There is no player camera, pan, or zoom state on `main` today.
- Canvas painter order is `map -> buildings -> overlays -> transit -> route handles -> text badges`.
- The Canvas renderer is mostly geometric: tiles, roads, tracks, buildings, paths, circles, overlays, previews, and vehicle rectangles.
- Canvas text is limited to map-local status/guidance: cursor/tool badge, preview feedback, route waypoint numbers, and broken-route guidance.
- `routeGeometry.ts` already owns Canvas-independent route/corridor presentation math.
- `pointAndTangentAt()` already samples line, quadratic-bezier, and arc `PathGeometry`; vehicle rendering uses that sampler with `Vehicle.stepProgress`.
- `placementValidation.ts` and runtime selectors are presentation logic and should survive the renderer cutover.

Two current details constrain the cutover.

First, `applyPresentationUpdate()` rebuilds live route/metro rows on every frame so it can merge the latest service metrics. Route-array reference equality is therefore not a valid structural-scene signal even on frame-only updates. The runtime must preserve the authoritative wire distinction: `PresentationUpdate.scene !== null`.

Second, 10 Hz publication means a 100 ms wall interval advances 400 ms of simulation at speed 4. A bus tile is 1.25 s and a metro tile is 0.625 s, so a published vehicle can move a substantial fraction of a curved step and can cross a step boundary. Interpolating sampled world `x/y` endpoints would cut chords through bezier/arc paths and can disagree with the route tangent. Interpolation must remain in path/cursor space.

HPA-544's reference evidence gives the wire-side scale relevant here. On the reference M1 Pro, the 5,000-vehicle row is 765,206 frame-only bytes with 496 µs projection and 1,203 µs serialization. HPA-640 does not enlarge that wire contract. It publishes it less often and reduces each received frame to bounded GPU geometry/instance uploads.

## Options considered

### A. Raw WebGPU with a small 2D batch builder — selected

Use browser WebGPU directly from TypeScript. Keep Caelum's CPU-side route/path geometry and build only the primitives the game needs: colored triangles/strokes plus one instanced vehicle quad.

Why this fits:

- smallest runtime dependency surface;
- no retained scene graph or display-object lifecycle;
- explicit batching/upload behavior;
- current visuals are flat colored transport geometry;
- leaves Svelte and Rust boundaries unchanged.

The cost is a small amount of WebGPU setup/WGSL, justified by the narrow renderer surface.

### B. PixiJS or another retained 2D renderer — rejected

This removes some primitive boilerplate but adds a scene graph, object lifecycle, runtime dependency, and another abstraction boundary primarily to draw simple geometry. It is more architecture than Caelum currently needs.

### C. Ship Canvas2D and WebGPU together — rejected

A long-lived fallback doubles parity and maintenance work. Temporary comparison code is fine while implementing the branch, but the merged result has one gameplay renderer. Unsupported WebGPU environments receive a clear bootstrap error rather than a Canvas fallback.

## Decision summary

1. Use raw WebGPU in TypeScript. Do not add Rust `wgpu`, Bevy rendering, PixiJS, a scene graph, or a renderer plugin system.
2. Add only WebGPU ambient TypeScript types if needed (`@webgpu/types` as a dev dependency); no runtime renderer library.
3. Preserve `PresentationUpdate`, `GameBackend`, and durable snapshot contracts. This slice needs no Rust/schema/backend-method change.
4. Keep the latest compact `GameState` as the frontend presentation view. WebGPU never consumes a durable gameplay snapshot.
5. Add one runtime-internal integer `sceneRevision`. Increment it whenever an accepted `PresentationUpdate` contains `scene !== null`; frame-only updates leave it unchanged.
6. Centralize every accepted presentation update — initial presentation, dispatch, restore, and reset — behind the same runtime helper so `sceneRevision` cannot drift from state installation.
7. Extract `pointAndTangentAt`/`pointAt` into a Canvas-neutral `pathGeometry.ts`; both WebGPU stroke tessellation and vehicle sampling reuse it. Do not reimplement bezier/arc math in `primitives.ts`.
8. Keep `routeGeometry.ts`, `placementValidation.ts`, catalogs, and selectors. Replace only Canvas-specific drawing code.
9. Display at requestAnimationFrame cadence while requesting backend simulation/presentation updates at 10 Hz (100 ms wall-clock cadence).
10. Keep at most one backend tick in flight on top of the existing `createSerializedQueue`; do not replace or duplicate the gameplay queue. Accumulate wall time while a tick is pending and cap one submitted delta to the existing 250 ms background-jump limit.
11. Interpolate vehicles in route/path cursor space, not world-space pose space. Sample position and tangent from the existing path geometry at the interpolated cursor.
12. Snap to the latest vehicle pose across discontinuities: new/missing vehicle, scene change, line/itinerary discontinuity, parked↔path transition, backward/non-adjacent step jump, pause, or speed 0.
13. Cull sampled/interpolated vehicle poses against a `WorldViewport` before instance encoding and GPU upload.
14. Preserve Canvas painter order explicitly: map/buildings below data/placement overlays, routes above those overlays, vehicles above routes, handle markers above vehicles, DOM text above the GPU canvas.
15. Enable source-alpha blending in the solid pipeline from the first WebGPU renderer task; existing overlay colors/global alpha require it.
16. Keep static caching narrow: map/building/road/track geometry caches by `sceneRevision`; route geometry caches by `sceneRevision` plus the current selected/edited route emphasis IDs. Route-draft strokes and other preview geometry stay dynamic.
17. Do not add camera controls. Current production viewport is the whole fitted map; tests feed a smaller viewport to prove the culling seam for a future camera.
18. Render map-local text in a Svelte/DOM overlay. Do not build a GPU font atlas and do not retain a secondary Canvas2D surface.
19. Add an early real Chromium WebGPU functional probe before the production host cutover. If the Playwright worker needs an explicit software adapter/configuration for functional tests, pin the minimum configuration and keep reference performance measurements on the real GPU.
20. Delete Canvas2D gameplay modules/tests in this same PR after parity is proven.

## Target architecture

```text
Rust simulation authority
        |
        | existing PresentationUpdate / tick()
        v
createGameRuntime
  |- latest compact GameState / UiState
  |- existing serialized gameplay queue
  `- sceneRevision (increments only when update.scene != null)
        |
        v
createWebGpuHost ---------------------------------------------+
  | requestAnimationFrame display loop                        |
  | 10 Hz / one-in-flight tick gate                           |
  | previous/latest vehicle cursor history                    |
  | shared board transform + pointer mapping                  |
  |                                                           |
  +--> WebGPU renderer                                        |
  |      1. map/buildings/roads/tracks       [sceneRevision]  |
  |      2. data + placement overlays        [dynamic]        |
  |      3. routes/stops/arrows              [scene+emphasis] |
  |      4. route-draft stroke               [dynamic]        |
  |      5. transit vehicles                 [instanced]      |
  |      6. route-handle marker geometry     [dynamic]        |
  |                                                           |
  `--> GameCanvas + MapTextOverlay (Svelte DOM) <-------------+
         cursor badge / preview feedback / waypoint numbers /
         broken-route guidance

Svelte HUD/panels remain normal DOM UI.
```

These are logical painter-order stages, not a scene graph. The renderer may pack dynamic triangle stages into one reusable vertex buffer with explicit draw ranges; stage boundaries must still preserve the order above.

## Scene revision

Do not infer structural change from `GameState` object/array identity. `presentationView.ts` reconstructs route and metro view rows on frame-only updates to attach current `serviceMetrics`.

Instead, `createGameRuntime.ts` owns:

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

Every state-installation path uses that helper:

- initial `backend.presentation()`;
- `commitDispatchResult()`;
- successful restore via `installRestoredGameplay()`;
- successful reset.

Initial presentation therefore installs revision 1. Normal frame-only ticks/rejected no-op updates leave it unchanged. Successful structural dispatch/reset/restore updates advance it once.

`createWebGpuHost` receives `getSceneRevision: () => number` alongside `getState/getUi`.

Consequences:

- map/building/road/track GPU geometry rebuilds only when `sceneRevision` changes;
- frame-only service-metric/vehicle/aggregate updates do not rebuild structural geometry;
- route geometry can use `sceneRevision` plus a tiny UI emphasis key rather than state identity;
- vehicle interpolation resets immediately across structural scene replacement;
- no deep comparison/fingerprint/revision framework is needed.

## Shared board and path geometry

Move Canvas-neutral board behavior from `render/canvas.ts` into `render/boardTransform.ts`:

- `tileSize`;
- `BoardTransform`;
- `getBoardTransform`;
- DPR-aware backing-store sizing;
- client-coordinate to tile mapping.

Move Canvas-neutral path sampling from `render/pathRenderer.ts` into `render/pathGeometry.ts`:

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

`routeGeometry.ts`, transitional Canvas drawing, WebGPU tessellation, broken-route midpoint calculation, and vehicle sampling all consume these helpers. `primitives.ts` may choose tessellation sample density, but it does not implement independent line/bezier/arc equations.

`boardTransform.ts` remains the single world-to-board rule for GPU rendering, pointer picking, and DOM label placement. HPA-640 does not introduce a camera object because there is no player camera feature to model yet.

## GPU rendering

### Primitive builder and blending

`render/webgpu/primitives.ts` is a CPU geometry helper, not a scene graph. It appends colored triangles for current visual needs:

- rectangles/tile fills;
- thick line/polyline strokes;
- quadratic/arc tessellation by sampling `pathGeometry.ts`;
- circles/rings;
- arrowheads/crosses;
- dashed draft/broken-route strokes.

World coordinates remain in today's 32-pixel tile space. One small WGSL uniform maps world coordinates through `BoardTransform` to clip space.

The solid-color triangle pipeline enables ordinary source-alpha blending from Task 1 because current presentation uses both RGBA colors and `globalAlpha`-style opacity. This is part of the base pipeline descriptor, not a later renderer feature.

The renderer owns only a few reusable buffers:

- structural map/building buffer, cached by `sceneRevision`;
- route buffer, cached by `sceneRevision` + selected/edited route emphasis IDs;
- one grow-only dynamic triangle buffer, rebuilt for under-route overlays, route-draft strokes, and post-vehicle handle markers, with explicit ranges;
- one grow-only vehicle instance buffer.

No per-feature GPU object tree is introduced.

### Painter-order batches

`webgpu/mapBatch.ts` replaces tile/building/road/track/roundabout Canvas drawing and contains no transit lines. It is the structural scene buffer.

`webgpu/overlayBatch.ts` emits dynamic geometry in named ranges so the renderer can place it correctly:

- `underRoutes`: coverage/demand/traffic/crowding, hover/inspect selection, building/area previews, road/track/remove previews, road-mutation markers, broken-route markers;
- `routeDraft`: current draft path stroke;
- `overVehicles`: numbered-handle circle/cross marker geometry without text.

`webgpu/transitBatch.ts` emits committed route lines, stops/stations, access indicators, route-node cues, and direction arrows. Its visual result depends on selected/edited route emphasis, so its cache key is not `sceneRevision` alone.

The render pass is always:

```text
map/buildings
underRoutes overlays
committed routes/stops/arrows
route draft stroke
instanced vehicles
overVehicles handle markers
DOM text
```

This preserves current Canvas layering: translucent data overlays remain under transit lines, and unrelated route/vehicle dimming remains visible when inspecting/editing a route.

### Vehicle cursor sampling and interpolation

`webgpu/vehicleInstances.ts` owns the high-cardinality dynamic path, but it reuses the existing route/corridor/path sampler rather than inventing a second motion model.

Extract a Canvas-independent cursor sampler that resolves a vehicle against a `TransitRenderCache` for a `GameState` and returns enough information to resample the route:

```ts
export interface VehicleCursorSample {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  itineraryIndex: number;
  pathStepIndex: number;
  stepProgress: number;
  geometry: PathGeometry | null;
  parkedPoint: TripPosition | null;
}

export interface VehiclePose {
  id: string;
  mode: "bus" | "metro";
  lineId: string;
  point: TripPosition;
  angleRadians: number | null;
}
```

The existing `TransitRenderCache` concept remains useful and may be moved into the Canvas-neutral transit batch module. Cache each `GameState` in a `WeakMap`; previous/latest states can each resolve against their own route/corridor cache.

Interpolation rules are explicit:

1. Resolve the latest cursor. If it cannot produce a pose, omit the vehicle.
2. Snap to latest when paused, speed is 0, vehicle ID is new/missing previously, scene revision changed, `lineId` changed, itinerary index changed, parked/path state changed, or cursor movement is backward/non-adjacent.
3. If previous/latest are on the same `lineId`, itinerary, and `pathStepIndex`, interpolate **`stepProgress`**, then call `pointAndTangentAt()` once on that step's presentation geometry. Heading comes from the sampled tangent; do not lerp world heading independently.
4. If latest `pathStepIndex === previous.pathStepIndex + 1` on the same itinerary and both adjacent presentation geometries exist, walk through the end of the previous step and beginning of the latest step. Parameterize the bridge by the remaining previous-step time plus elapsed latest-step time, then sample whichever step contains the interpolated cursor with `pointAndTangentAt()`.
5. If a publication skipped more than one path step, crosses an itinerary/terminal boundary, or otherwise cannot prove continuity cheaply, snap to latest rather than draw a chord through the map.

For adjacent steps:

```text
remainingPrev = (1 - previous.stepProgress) * previousStep.travelSeconds
elapsedLatest = latest.stepProgress * latestStep.travelSeconds
span = remainingPrev + elapsedLatest
target = alpha * span
```

If `target <= remainingPrev`, sample the previous step between its previous progress and 1. Otherwise sample the latest step between 0 and its latest progress. Zero-duration/invalid spans snap to latest.

This deliberately renders only provably continuous cursor motion. It does not extrapolate, does not mutate simulation state, and does not build a general spline timeline.

After sampling/interpolation:

1. apply route-emphasis opacity to the instance;
2. cull against `WorldViewport` plus a one-tile margin;
3. encode one fixed-size instance only for a visible pose.

The GPU owns one unit quad. One grow-only reusable instance buffer contains visible bus/metro poses, and one instanced draw renders them. Do not allocate one object/buffer/bind group/draw call per vehicle.

Private cars remain Caelum's aggregate traffic model; this ticket does not create private-car actors for visual load.

## Cadence and render history

### 10 Hz publication, rAF display

The host keeps requestAnimationFrame as display clock. While runtime is running, unpaused, and speed is non-zero:

- every rAF renders;
- wall time accumulates for simulation publication;
- after at least 100 ms and only when no tick is pending, call the existing runtime `tick(accumulatedDelta)`;
- cap one submitted delta to 250 ms;
- retain excess accumulated wall time for the next eligible submission;
- while the returned tick promise is pending, keep drawing and do not request another tick.

The runtime `tick()` still enters the existing serialized gameplay queue. The host-level one-in-flight gate prevents rAF from flooding that queue; it does not replace the queue or introduce a second gameplay serializer.

Stopping/pausing clears timestamp/accumulator history so resume does not catch up an old background gap.

### Render history

The host retains only:

- previous compact `GameState` + its scene revision;
- latest compact `GameState` + its scene revision;
- wall-clock time when latest was observed.

When current state changes with the same scene revision, shift latest -> previous and start alpha at 0. If the scene revision changes, clear previous and render latest immediately.

During the next 100 ms display interval, vehicle alpha advances to 1. Metrics, budget, clock, overlays, and Svelte UI always use latest state; only moving vehicle cursors interpolate.

## Viewport culling

Define a small Canvas/GPU-independent rectangle:

```ts
interface WorldViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

Culling occurs **after path sampling/interpolation and before instance encoding**. Current board-fit behavior produces a viewport covering the whole map, so no new camera UX is required. Unit tests feed a narrowed viewport and prove that, for example, 20,000 presented vehicles with only 400 near the viewport create only 400 GPU instance records.

This seam is enough for a future camera; no LOD/camera framework is introduced now.

## Map-local text

GPU text is deliberately out of scope. Add pure `render/mapTextOverlay.ts` view derivation plus `MapTextOverlay.svelte` for:

- cursor/tool badge;
- road-preview feedback text;
- route-draft waypoint numbers;
- broken-route guidance text.

Geometric circles/crosses/markers remain WebGPU.

`GameCanvas.svelte` becomes a Svelte-owned board container containing a dedicated runtime-owned `.board-surface` and a pointer-events-none text overlay. The runtime mounts its canvas only inside `.board-surface`, so its normal child cleanup cannot erase Svelte-owned overlay DOM.

The GPU surface and overlay occupy the same CSS box. Both use `getBoardTransform` from that box's width/height so pointer mapping, GPU geometry, and DOM labels cannot drift because they measured different containers.

## WebGPU lifecycle and early browser gate

Make `createWebGpuHost(...)` asynchronous and await it inside already-async `createGameRuntime(...)`.

The host factory requests one adapter/device before returning. `mountCanvas(host)` therefore keeps its current synchronous teardown signature. On mount, the host creates/configures one canvas context, wires input/resize listeners, and creates size-dependent resources. On teardown it cancels rAF, clears pointer/hover state, disconnects observers/listeners, destroys renderer-owned buffers, and removes its canvas.

If WebGPU or an adapter is unavailable, throw a clear bootstrap error. `main.ts` already converts runtime bootstrap rejection into the shell error surface. Do not add a Canvas fallback.

Unit tests inject one narrow renderer factory into `createWebGpuHost`; they do not mock the entire WebGPU object graph. Pure batch/extraction tests never touch GPU APIs.

Before production switches from `createCanvasHost` to `createWebGpuHost`, add a real Playwright Chromium probe that:

1. asserts `navigator.gpu` exists;
2. requests an adapter and device;
3. configures a tiny `webgpu` canvas context with the preferred format;
4. submits a clear-only render pass;
5. waits for `device.queue.onSubmittedWorkDone()`.

Run it in normal Chromium and once headed locally. If the default Playwright worker returns no adapter, pin the minimum explicit Chromium software-adapter configuration needed for **functional** E2E and document that distinction. Do not use software-adapter timings as HPA-640 performance evidence.

After the Task 4 production host cutover, run the entire existing Playwright suite before deleting Canvas2D. Tauri/WebView remains a separate Task 5 smoke gate.

## Performance evidence

Add one renderer-only browser stress harness under `tests/e2e` so the same deterministic scene can measure Canvas2D before deletion and WebGPU after cutover without creating 5,000 simulation actors.

Build it by composing existing `tests/helpers/gameState.ts` and `tests/helpers/mapFixtures.ts`; do not create an independent city/sandbox factory.

Reference fixture:

- 1280 x 800 board;
- representative road/building/transit/overlay geometry;
- valid bus and metro paths;
- 5,000 synthetic presentation vehicles distributed along valid path steps;
- 30 warm-up frames;
- 120 measured frames.

Record in `docs/performance/hpa-640-webgpu.md`:

- Canvas2D baseline median/p95 CPU render time;
- WebGPU median/p95 CPU encode/submit time;
- WebGPU 120-frame queue-completion average using `device.queue.onSubmittedWorkDone()` after the run;
- presented vehicle count, encoded visible count, instance-upload bytes, and draw counts;
- real Tauri/M1 Pro smoke observation.

Numbers are reference evidence, not CI thresholds. Automated tests pin structural properties instead: painter order/draw ranges, source-alpha blend configuration, path-following interpolation, viewport culling before encoding, one 5k instance batch/draw, structural/route-buffer reuse under their explicit keys, and no overlapping backend tick requests.

Run real-GPU performance measurements on normal Chromium. If CI uses a software WebGPU adapter for functional coverage, do not mix those timings into the reference result.

## Risks and gates

### Path interpolation

Risk: world-space lerp can cut across curved routes or slide through discontinuous cursor transitions.

Gate: unit tests include a quadratic/arc sample where a chord interpolation cannot satisfy the expected midpoint/tangent, an adjacent-step rollover, and snap cases for parked/path, itinerary, scene, and non-adjacent jumps.

### Painter order and alpha

Risk: caching transit together with the map would put translucent data overlays above routes and would freeze selected-route dimming at the wrong opacity.

Gate: batch/renderer tests assert draw-stage order and route-emphasis invalidation. The solid pipeline has source-alpha blending from its first implementation.

### Playwright WebGPU availability

Risk: production cutover can be correct while the automated Chromium worker has no functional adapter.

Gate: real adapter/device/context/submit probe lands in Task 1, before host cutover. Minimal functional software-adapter configuration is permitted only if required and is explicitly separated from performance evidence.

### Tauri WebView WebGPU availability

Risk: Chromium works while the release-target WebView renders a blank board or behaves differently.

Gate: Task 5 requires `tauri:dev` map/input/motion smoke before Canvas deletion is considered complete. There is no fallback renderer.

## Target files

```text
src/render/
  boardTransform.ts
  pathGeometry.ts
  colors.ts                      retained
  placementValidation.ts         retained
  routeGeometry.ts               retained
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

Delete after parity:

- `src/runtime/createCanvasHost.ts`;
- `src/render/canvas.ts`;
- `src/render/mapRenderer.ts`;
- `src/render/buildingRenderer.ts`;
- `src/render/roundaboutRenderer.ts`;
- `src/render/pathRenderer.ts` after `pathGeometry.ts` owns its retained sampling math;
- `src/render/transitRenderer.ts`;
- `src/render/overlayRenderer.ts`;
- `src/render/cursorBadge.ts`.

Retarget behavioral tests instead of simply dropping coverage.

## Explicit non-goals

- no camera/pan/zoom product feature;
- no Godot/Bevy renderer or Rust `wgpu`;
- no generic scene graph/material/plugin system;
- no texture atlas/GPU text/image-art pipeline;
- no lighting/3D/physics/compute-shader simulation work;
- no 1:1 rendering of 200k citizens;
- no private-car actor simulation;
- no durable snapshot/schema migration;
- no new backend presentation method;
- no second gameplay queue;
- no Canvas2D fallback after cutover.

## Acceptance

HPA-640 is complete in this one PR when:

1. gameplay uses one WebGPU canvas and no Canvas2D gameplay context remains under production `src`;
2. build/track/demolish gestures, tile picking, hover/selection, route create/edit, overlays, responsive resize, save/restore, and simulation controls preserve current player behavior;
3. Svelte still owns HUD/panels/forms/map text; WebGPU owns gameplay geometry and moving vehicles;
4. backend publication runs at 10 Hz while display remains rAF-driven with at most one host tick request in flight and the existing serialized gameplay queue retained;
5. vehicle interpolation follows `PathGeometry` by interpolating continuous cursor progress and resampling `pointAndTangentAt`, with discontinuities snapping instead of world-space lerping;
6. painter order remains map/buildings -> overlays -> routes -> draft -> vehicles -> handles -> DOM text, with alpha blending enabled;
7. 5,000 visible transit vehicles encode into one reused instance buffer and one instanced vehicle draw;
8. a narrowed-viewport test proves offscreen presented vehicles are removed before instance encoding/upload;
9. unchanged `sceneRevision` reuses structural map geometry; route geometry reuses only while both scene revision and route-emphasis inputs are unchanged;
10. every accepted `PresentationUpdate` uses one scene-revision helper, including initial presentation, dispatch, restore, and reset;
11. a real Chromium WebGPU functional probe passes before production host cutover, the full Playwright suite passes after cutover, and the Tauri WebView smoke passes before final Canvas deletion/closeout;
12. the HPA-544 presentation wire remains unchanged;
13. stress evidence records Canvas baseline and final real-GPU WebGPU results without turning wall-clock values into brittle CI thresholds;
14. Canvas-specific production modules/obsolete mocks are deleted or retargeted in the same PR, leaving no second renderer.