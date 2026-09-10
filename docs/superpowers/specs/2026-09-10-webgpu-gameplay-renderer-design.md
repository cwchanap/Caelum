# HPA-640 WebGPU Gameplay Renderer Cutover Design

## Status

Planning design for HPA-640, based on `main` at `717bd841ece76a6b34a09e9d2a94a423b54f8d69` after HPA-544, HPA-347, and HPA-348.

## Goal

Replace the Canvas2D gameplay renderer with one focused WebGPU path that can batch roughly 5,000 visible transit vehicles while preserving the current transport-sandbox interactions. Keep Svelte as the application/HUD UI and Rust as gameplay authority.

HPA-640 remains one implementation ticket and one PR. This planning commit starts that PR; implementation, parity work, performance evidence, and Canvas2D deletion continue on the same branch.

## Current shape

The current architecture already provides the important scale boundary:

- Rust publishes compact `PresentationUpdate` data; ordinary frontend state no longer carries the latent 200k-citizen population.
- `createGameRuntime.ts` folds those updates into the flat `GameState` used by Svelte and rendering.
- `createCanvasHost.ts` owns the real `<canvas>`, pointer input, resize lifecycle, and requestAnimationFrame loop.
- The current rAF loop also calls backend `tick(deltaSeconds)`, so display cadence and simulation/presentation publication are coupled.
- `render/canvas.ts` fits the whole map into the board. There is no player camera, pan, or zoom state on `main` today.
- The Canvas renderer is mostly geometric: tiles, roads, tracks, buildings, paths, circles, overlays, previews, and vehicle rectangles.
- Canvas text is limited to map-local status/guidance: cursor/tool badge, preview feedback, route waypoint numbers, and broken-route guidance.
- `routeGeometry.ts` already owns Canvas-independent route/corridor presentation math.
- `placementValidation.ts` is presentation logic and should survive the renderer cutover.

One detail matters for caching: `applyPresentationUpdate()` rebuilds live route/metro rows on every frame so it can merge the latest service metrics. Therefore route-array reference equality is **not** a valid structural-scene signal even on frame-only updates. The runtime must preserve the authoritative distinction already present on the wire: `PresentationUpdate.scene !== null`.

HPA-544's reference evidence also gives the wire-side scale relevant here. On the reference M1 Pro, the 5,000-vehicle row is 765,206 frame-only bytes with 496 µs projection and 1,203 µs serialization. HPA-640 should not enlarge that wire contract. It should publish it less often and reduce each received frame to one bounded GPU instance upload.

## Options considered

### A. Raw WebGPU with a small 2D batch builder — selected

Use browser WebGPU directly from TypeScript. Keep Caelum's CPU-side geometry and build only the primitives the game needs: colored triangles/strokes plus an instanced vehicle quad.

Why this fits:

- smallest runtime dependency surface;
- no retained scene graph or display-object lifecycle;
- explicit batching/upload behavior;
- current visuals are flat colored transport geometry;
- leaves Svelte and Rust boundaries unchanged.

The cost is a small amount of WebGPU setup/WGSL, which is justified by the narrow renderer surface.

### B. PixiJS or another retained 2D renderer — rejected

This would remove some primitive boilerplate but adds a scene graph, object lifecycle, runtime dependency, and another abstraction boundary primarily to draw simple geometry. It is more architecture than Caelum currently needs.

### C. Ship Canvas2D and WebGPU together — rejected

A long-lived fallback doubles parity and maintenance work. Temporary comparison code is fine while implementing the branch, but the merged result has one gameplay renderer. Unsupported WebGPU environments receive a clear bootstrap error rather than a Canvas fallback.

## Decision summary

1. Use raw WebGPU in TypeScript. Do not add Rust `wgpu`, Bevy rendering, PixiJS, a scene graph, or a renderer plugin system.
2. Add only WebGPU ambient TypeScript types if needed (`@webgpu/types` as a dev dependency); no runtime renderer library.
3. Preserve `PresentationUpdate`, `GameBackend`, and durable snapshot contracts. This slice needs no Rust/schema/backend-method change.
4. Keep the latest compact `GameState` as the frontend presentation view. WebGPU never consumes a durable gameplay snapshot.
5. Add one runtime-internal integer `sceneRevision`. Increment it whenever an accepted `PresentationUpdate` contains `scene !== null`; frame-only updates leave it unchanged. The WebGPU host reads this revision to decide when to rebuild static GPU geometry and when vehicle interpolation must snap.
6. Keep `routeGeometry.ts`, `placementValidation.ts`, catalogs, and selectors. Replace only Canvas-specific drawing code.
7. Display at requestAnimationFrame cadence while requesting backend simulation/presentation updates at 10 Hz (100 ms wall-clock cadence).
8. Keep at most one backend tick in flight. Accumulate wall time while it is pending and cap one submitted delta to the existing 250 ms background-jump limit.
9. Smooth moving vehicles from previous/latest compact frontend states. Interpolate render poses only; never predict future simulation state or mutate gameplay authority.
10. Cull interpolated vehicle poses against a `WorldViewport` before instance encoding and before GPU upload.
11. Do not add camera controls. Current production viewport is the whole fitted map; tests feed a smaller viewport to prove the culling seam for a future camera.
12. Render map-local text in a Svelte/DOM overlay. Do not build a GPU font atlas and do not retain a secondary Canvas2D surface.
13. Delete Canvas2D gameplay modules/tests in this same PR after parity is proven.

## Target architecture

```text
Rust simulation authority
        |
        | existing PresentationUpdate / tick()
        v
createGameRuntime
  |- latest compact GameState / UiState
  `- sceneRevision (increments only when update.scene != null)
        |
        v
createWebGpuHost --------------------------------------+
  | requestAnimationFrame display loop                 |
  | 10 Hz / one-in-flight backend tick scheduler       |
  | previous/latest render-state history               |
  | board transform + pointer mapping                  |
  |                                                    |
  +--> WebGPU renderer                                 |
  |      |- static map/building/base-transit buffer    |
  |      |- dynamic overlay/preview triangle buffer    |
  |      `- culled/interpolated vehicle instances      |
  |                                                    |
  `--> GameCanvas + MapTextOverlay (Svelte DOM) <------+ 
         cursor badge / waypoint numbers / guidance

Svelte HUD/panels remain normal DOM UI.
```

## Scene revision

Do not infer structural change from `GameState` object/array identity. `presentationView.ts` reconstructs route and metro view rows on frame-only updates to attach current `serviceMetrics`.

Instead, `createGameRuntime.ts` keeps:

```ts
let sceneRevision = 0;
```

Every code path that accepts a `PresentationUpdate` goes through one local helper. The helper increments `sceneRevision` only when `update.scene !== null`, then calls `applyPresentationUpdate(...)`. Initial presentation therefore installs revision 1; normal ticks/rejected no-op updates leave it unchanged; successful structural dispatch/reset/restore updates advance it.

`createWebGpuHost` receives `getSceneRevision: () => number` alongside `getState/getUi`.

Consequences:

- static GPU batches rebuild only when `sceneRevision` changes;
- frame-only service-metric/vehicle/aggregate updates do not rebuild static geometry;
- vehicle interpolation resets immediately across structural scene replacement;
- no deep comparison/fingerprint layer is needed.

## Shared board transform

Move Canvas-neutral pieces from `render/canvas.ts` into `render/boardTransform.ts`:

- `tileSize`;
- `BoardTransform`;
- `getBoardTransform`;
- DPR-aware canvas backing-store sizing;
- client-coordinate to tile mapping.

This remains the single world-to-board rule for GPU rendering, pointer picking, and DOM label placement. HPA-640 does not introduce a camera object because there is no player camera feature to model yet.

## GPU rendering

### Primitive batch

`render/webgpu/primitives.ts` is a CPU geometry helper, not a scene graph. It appends colored triangles for current visual needs:

- rectangles/tile fills;
- thick line/polyline strokes;
- quadratic/arc tessellation;
- circles/rings;
- arrowheads/crosses;
- dashed draft/broken-route strokes.

World coordinates remain in today's 32-pixel tile space. One small WGSL uniform maps world coordinates through `BoardTransform` to clip space.

Use one solid-color triangle pipeline. Keep a static and a dynamic GPU buffer only because their update cadence differs.

### Static scene batch

`webgpu/mapBatch.ts` replaces tile/building/road/track/roundabout Canvas drawing. `webgpu/transitBatch.ts` reuses `routeGeometry.ts` to emit base route geometry, stops/stations, access indicators, and direction arrows.

The renderer stores the `sceneRevision` used to build its static buffer. If revision is unchanged, frame-only updates reuse the existing buffer even though live route view objects were rebuilt by `presentationView.ts`.

Selected-route emphasis and route-draft previews remain dynamic overlays because they depend on `UiState`.

### Dynamic overlay batch

`webgpu/overlayBatch.ts` ports geometric output from the current overlay renderer: coverage, demand, traffic, crowding, hover/selection, placement previews, road-mutation previews, route-draft marker geometry, and broken-route markers.

Existing display derivation such as `buildRoadMutationPreview`, route-editor selectors, and placement validation remains outside the GPU layer.

### Vehicle instances

`webgpu/vehicleInstances.ts` owns the high-cardinality dynamic path.

Refactor current route/path vehicle sampling so it returns a Canvas-independent world-space `VehiclePose`. For each current vehicle:

1. resolve latest pose from existing route/corridor geometry;
2. when previous state contains the same stable vehicle ID **and** the previous/latest scene revision matches, resolve previous pose;
3. interpolate previous -> latest position and shortest-angle heading by host alpha;
4. if paused/speed-zero, new vehicle, missing previous pose, or scene revision changed, use latest pose immediately;
5. cull against `WorldViewport` plus a one-tile margin;
6. encode one fixed-size instance record only for a visible pose.

The GPU owns one unit quad. One grow-only reusable instance buffer contains the visible bus/metro poses, and one instanced vehicle draw renders the batch. Do not allocate one object/buffer/bind group/draw call per vehicle.

Private cars remain Caelum's aggregate traffic model; this ticket does not create private-car actors for visual load.

## Cadence and interpolation

### 10 Hz publication, rAF display

The host keeps requestAnimationFrame as display clock. While runtime is running, unpaused, and speed is non-zero:

- every rAF renders;
- wall time accumulates for simulation publication;
- after at least 100 ms and only when no tick is pending, submit one `api.tick(accumulatedDelta)`;
- cap a submitted delta to 250 ms;
- keep remaining accumulated time for the next eligible tick;
- while tick is pending, keep drawing and do not enqueue another backend tick.

Stopping/pausing clears the timestamp/accumulator so resume does not catch up an old background gap.

This is frontend scheduling only. Rust still advances from the supplied delta and returns the same `GameplayUpdateResult`.

### Render history

The host retains only:

- previous compact `GameState` + its scene revision;
- latest compact `GameState` + its scene revision;
- wall-clock time when latest was observed.

When current state changes with the same scene revision, shift latest -> previous and start alpha at 0. If the scene revision changes, clear previous and render latest immediately.

During the next 100 ms display interval, vehicle alpha advances to 1. This intentionally renders moving vehicles one publication interval behind authority instead of extrapolating. Metrics, budget, clock, overlays, and Svelte UI always use latest state; only moving vehicle poses interpolate.

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

Culling occurs **after pose sampling/interpolation and before instance encoding**. Current board-fit behavior produces a viewport covering the whole map, so no new camera UX is required. Unit tests feed a narrowed viewport and prove that, for example, 20,000 presented vehicles with only 400 near the viewport create only 400 GPU instance records.

This seam is enough for a future camera; no LOD/camera framework is introduced now.

## Map-local text

GPU text is deliberately out of scope. Add pure `render/mapTextOverlay.ts` view derivation plus `MapTextOverlay.svelte` for:

- cursor/tool badge;
- road-preview feedback text;
- route-draft waypoint numbers;
- broken-route guidance text.

Geometric circles/crosses/markers remain WebGPU.

`GameCanvas.svelte` becomes a Svelte-owned board container containing a dedicated runtime-owned surface div and a pointer-events-none text overlay. The runtime mounts its canvas only into the surface div, so it never clears Svelte-owned children.

The overlay observes the board size and uses `getBoardTransform` in CSS-pixel dimensions to place labels. Duplicating one lightweight `ResizeObserver` is preferable to exposing renderer layout state through application state.

## WebGPU lifecycle

Make `createWebGpuHost(...)` asynchronous and await it inside already-async `createGameRuntime(...)`.

The host factory requests one adapter/device before returning. `mountCanvas(host)` can therefore retain its current synchronous teardown signature. On mount, the host creates/configures one canvas context, wires input/resize listeners, and creates size-dependent resources. On teardown it cancels rAF, clears pointer/hover state, disconnects observers/listeners, destroys renderer-owned buffers, and removes its canvas.

If WebGPU or an adapter is unavailable, throw a clear bootstrap error. `main.ts` already converts runtime bootstrap rejection into the shell error surface. Do not add a Canvas fallback.

Unit tests inject one narrow renderer factory into `createWebGpuHost`; they do not mock the entire WebGPU object graph. Pure batch/extraction tests never touch GPU APIs.

## Performance evidence

Add one renderer-only browser stress harness under `tests/e2e` so the same deterministic scene can measure Canvas2D before deletion and WebGPU after cutover without creating 5,000 simulation actors.

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
- real Tauri/M1 Pro smoke observation where practical.

Numbers are reference evidence, not CI thresholds. Automated tests pin structural properties instead: viewport culling before encoding, one 5k instance batch/draw, static-buffer reuse when `sceneRevision` is unchanged, and no overlapping backend-tick queue.

Run real-GPU performance measurements on normal Chromium. If CI requires a software WebGPU adapter for functional coverage, do not mix those timings into the reference result.

## Target files

```text
src/render/
  boardTransform.ts
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
- `src/render/pathRenderer.ts`;
- `src/render/transitRenderer.ts`;
- `src/render/overlayRenderer.ts`;
- `src/render/cursorBadge.ts`.

Retarget their behavioral tests instead of simply dropping coverage.

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
- no Canvas2D fallback after cutover.

## Acceptance

HPA-640 is complete in this one PR when:

1. gameplay uses one WebGPU canvas and no Canvas2D gameplay context remains under production `src`;
2. build/track/demolish gestures, tile picking, hover/selection, route create/edit, overlays, responsive resize, save/restore, and simulation controls preserve current player behavior;
3. Svelte still owns HUD/panels/forms/map text; WebGPU owns gameplay geometry and moving vehicles;
4. backend publication runs at 10 Hz while display remains rAF-driven, without visible vehicle stepping in the reference run;
5. interpolation uses only previous/latest published states and matching scene revision;
6. 5,000 visible transit vehicles encode into one reused instance buffer and one instanced vehicle draw;
7. a narrowed-viewport test proves offscreen presented vehicles are removed before instance encoding/upload;
8. unchanged `sceneRevision` reuses static map/building/base-route GPU geometry despite frame-only live route row reconstruction;
9. the HPA-544 presentation wire remains unchanged;
10. stress evidence records Canvas baseline and final WebGPU results without turning wall-clock values into brittle CI thresholds;
11. normal unit/type/lint/build checks and existing Playwright user journeys pass through the WebGPU path;
12. Canvas-specific production modules/obsolete mocks are deleted or retargeted in the same PR, leaving no second renderer.
