# HPA-287 — Map Vehicle and Line Inspection — Design

> **Linear:** [HPA-287](https://linear.app/cwchanap/issue/HPA-287/click-vehicles-and-lines-on-the-map)  
> **Status:** proposed for review; documentation only  
> **Delivery:** one implementation PR using this draft PR (not a second PR)

## Outcome and player interaction

With **Select** active, clicking a rendered bus or metro vehicle opens contextual **Inspect** showing the line's name/color, current riders/capacity, and next stop/station. Clicking a visible route path on a tile **without a stop/station** selects its line and opens the existing **Lines** controls. Clicking a route's at-risk wait location in Lines keeps its current node inspection behavior and also centers the map camera there.

No new art, SFX, gameplay intent, persistence field, generic picking engine, or new management panel.

## Existing ownership and constraints

- Rust `crates/caelum-core/src/model.rs` owns `Vehicle.capacity` and `Vehicle.passenger_ids`; `presentation.rs::VehiclePresentation` projects cursor data but deliberately omits load today. Both WASM and Tauri call this same Rust projection.
- The frontend's `src/runtime/backend/types.ts::PresentationVehicle` currently inherits `Vehicle` fields too broadly even though Rust does not send capacity/passenger IDs; correct that contract as part of this feature rather than pretend those arrays exist.
- `src/render/webgpu/vehicleInstances.ts` already knows how to sample latest/interpolated world-space positions, including parked vehicles, zero-step terminal reversals, shared-corridor offsets and discontinuity snaps. `createWebGpuHost.ts` already gates ordinary clicks after pan/drag gestures.
- `src/runtime/createGameRuntime.ts` owns local selection and `focusWaitLocation`; `src/runtime/runtimeSelectors.ts` projects an inspector; `src/components/hud/panels/InspectPanel.svelte` renders it. `openServiceControls(routeId)` already opens Lines with that route selected.
- `src/render/boardTransform.ts` is the one camera/coordinate authority, and the GPU host owns actual board dimensions.

## 1. Vehicle load: one scalar on the existing Rust frame

Add `passenger_count: u16` and `capacity: u16` to Rust `VehiclePresentation` (camelCase JSON: `passengerCount`, `capacity`). Set them to `vehicle.passenger_ids.len()` (convert safely to the bounded vehicle capacity/type) and `vehicle.capacity` when `project_frame` already iterates the vehicles. Keep `passenger_ids` private to Rust: no trip rows or rider identities on the frame. Update the **one** frontend presentation type and its `GameState` projection to reflect those exact fields; do not claim frame vehicles have `passengerIds`.

This is a presentation-wire change, not a durable save-schema change. WASM and Tauri receive it through their existing shared core projection and adapters; no extra host-specific command or parity framework.

## 2. Shared visual sampling for picking

Extract a small pure **presented vehicle sample** helper from `vehicleInstances.ts`, used by both `encodeVehicleInstances` and click picking. Return vehicle ID plus world-pixel center (and renderer-required heading) for each current vehicle. The helper must preserve the renderer's current interpolation alpha, pause/speed-0 snap behavior, corridor offsets and terminal/parked fallbacks; avoid a second approximate vehicle-position formula.

On an ordinary primary click in Select mode, the WebGPU host converts the pointer from canvas CSS to world pixels with the existing `getBoardTransform`. Hit-test presented vehicles within about **half a tile** (16 world px) of their actual displayed center. Choose smallest squared distance, then stable ID as tie-break. Only renderable/visible vehicles may be picked. The host forwards `onVehicleClick(vehicleId)` to the runtime. The runtime keeps a local `selectedVehicleId: string | null` (not persisted) and clears conflicting tile/node inspection selection.

Re-evaluate the selected vehicle each projected frame by ID. If it disappears, Inspect closes gracefully; do not freeze stale rider counts or store vehicle snapshots in UI state.

## 3. Route path click and click priority

Only under Select, and only when no route draft is active, use the current scene's **presented** Bus/Metro paths (the same connected/last-valid geometry and shared-corridor offsets used by `transitBatch.ts`) for a small proximity test on the clicked route-path tile. Use existing `pathGeometry` helpers and a bounded point-to-curve/segment approximation where needed; no GPU readback or general spatial index. Choose nearest visible line within about half a tile, breaking equal-distance ties by line ID.

The click priority is:
1. rendered vehicle within hit radius;
2. a present stop/station (and existing node/building selection semantics);
3. a route path on a non-stop/station tile;
4. ordinary existing tile selection, including buildings and empty tiles.

When a line is hit, delegate to the existing `openServiceControls(lineId)` runtime operation (idempotent selection, **not** toggle, **not** route editing). Do not alter click behavior for road/build/route-draft tools, Space/middle pan, or any drag. A shared corridor needs one deterministic picked line; changing selection can still use the Lines list.

## 4. Vehicle inspector projection

Extend `ShellInspectorState` with `kind: "vehicle"` including vehicle ID, mode, line ID, line name/color, `passengerCount`, `capacity`, and a readable next waypoint label. Derive this as a pure selector from the **current frame vehicle** plus the existing route/metro-line scene, using the current leg's `toWaypointId` when available. If the route/leg/node is missing or broken, show a neutral `—` for next stop rather than guessing. A zero-load vehicle shows `0 / capacity`.

Add a compact vehicle branch to the existing `InspectPanel.svelte`, with a button using `onOpenServiceControls(lineId)`. Reuse existing line coloring and inspector styling; no new UI destination or vehicle state service.

## 5. Center on wait location

Extend `CameraAction` in `boardTransform.ts` with `{ kind: "centerOn"; point: Point }`. Handle it using the **current** zoom and `clampCamera` bounds; if the view is fitted (`camera === null`), zoom modestly (target 2× fit, bounded by `maxZoom`) so centering can visibly work. If the board cannot zoom, retain fit. No camera position is persisted.

After the existing successful `focusWaitLocation(routeId, nodeId)` validates both line and **present** node, invoke the existing host camera adjustment with the node position. Continue to select the node and retain the route, and preserve the existing no-op behavior for missing/invalid target or open route draft. The existing Lines wait-location button needs no extra prop or callback.

## State and boundaries

- Rust: add only the two numeric vehicle frame fields; no gameplay changes.
- Presentation view: frame vehicles include load/capacity, still no passenger IDs.
- Host: one shared visual sampling path, two narrow click outcomes, existing pan/camera system.
- Runtime: one transient selected vehicle ID and narrow selection methods; the shell selector does not call Rust or own mutable copies.
- UI: one additional Inspect branch, existing Lines controls.
- Explicitly out: per-citizen details, following vehicles with camera, route-cycling picker menus, GPU selection passes, new routing rules, save migration, new assets.

## Acceptance and regression gates

- Select clicks a rendered moving or parked bus/train, Inspect has **correct line and numeric load/capacity** and next stop; frame updates refresh the counts without reselecting.
- Vehicle click uses the same presented position as rendering across interpolation, shared corridors, camera zoom/pan and terminal fallback; click off radius does not select.
- Clicking a line path away from stops opens **Lines** and selects the intended Bus/Metro line; stops still inspect as before; ambiguous overlaps resolve deterministically.
- Existing route drafting, placement, drag-to-pan, click-to-inspect buildings/stops, and no-fleet lines remain usable.
- Clicking an at-risk wait location opens its existing stop/station Inspect and **centers a clamped camera**; both already-zoomed and fit views work.
- No new save field, native/WASM divergence, or performance regression from work done continuously on every tick; picking happens only on click.
