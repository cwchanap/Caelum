# HPA-287 — Map Vehicle and Line Inspection — Design

> **Linear:** [HPA-287](https://linear.app/cwchanap/issue/HPA-287/click-vehicles-and-lines-on-the-map)  
> **Status:** proposed for review; docs only so far  
> **Delivery:** design and implementation belong to **this one draft PR**

## Player outcome

With the actual **Select** tool active (not the building-placement mode that also uses `activeTool: "inspect"`), click a displayed Bus/Metro vehicle to see line name/color, riders/capacity and next stop in Inspect. Click a rendered line path **on its own path tile away from stops/stations** to open Lines with that line selected. Clicking a wait location in Lines continues to inspect the node and now also centers the camera.

No new gameplay intent, save schema, host-specific command, rendering asset, SFX, generic picking engine, or management panel.

## Existing boundaries

- `caelum-core` owns `Vehicle.capacity` and `Vehicle.passenger_ids`; `presentation.rs` builds the frame shared by the native and WASM adapters.
- Domain `Vehicle` (`src/domain/types.ts`) is the **live** cursor view. Durable `RustTransitNetwork` and `RustVehicle` (`src/runtime/backend/types.ts`) already override their vehicle shape; there is no need for a separate `PresentedVehicle` type or `GameState` intersection.
- `vehicleInstances.ts` already samples interpolated, parked, terminal, and shared-corridor-offset positions and culls them. `transitBatch.ts` already draws the offset route geometry.
- `createWebGpuHost.ts` owns pointer coordinates and last rendered frame; `createGameRuntime.ts::handleTileClick` owns the busy gate, route-draft handling and the actual Select-vs-building-placement gate; `src/ui/actions.ts::applyUiTileClick` already resolves node inspection and same-tile stop/station cycling.
- `openServiceControls(routeId)`, `focusWaitLocation(routeId, nodeId)`, `buildInspector`, `InspectPanel.svelte`, and `boardTransform.ts` are all existing integration points.

## A. Vehicle frame, pick, selection and Inspect

### Numeric load only

Add `passenger_count: usize` and `capacity: u16` to `VehiclePresentation`; derive them from `vehicle.passenger_ids.len()` and `vehicle.capacity` in the existing Rust projection loop. JSON names are `passengerCount` and `capacity`. No passenger IDs on the presentation frame, no new persistence field or schema version.

Add `passengerCount: number` and `capacity: number` directly to the existing TypeScript `Vehicle` interface. Its `GameState.transit.vehicles` already uses this type. `PresentationVehicle` inherits the fields and normalizes `parkedPosition` as before. Add `"passengerCount"` to the `RustVehicle` `Omit` list; `capacity` is already omitted/redeclared, and `passengerIds` remains durable-only. `presentationView.ts` already spreads each frame vehicle, so there is **no fold change**. This keeps one live vehicle type and the existing separate durable wire shape.

### Pick exactly what was drawn; leave policy to the runtime

Extend the existing `encodeVehicleInstances` sampling pass to also expose the **post-cull** list of `{ id, point }` world-pixel centers actually submitted on screen. The WebGPU host stores the most recently drawn list with that frame; do not re-interpolate or derive another position on click. An offscreen debug capture must not silently replace the on-screen hit targets. A pure, small `src/render/webgpu/pickMapTarget.ts` computes click-only nearest hits (no spatial index or GPU readback): nearest vehicle center within `tileSize / 2` (16 world pixels), distance first then stable ID. Convert CSS pointer position to world pixels using the board transform, and keep the existing pan/click suppression.

The host computes candidates (even if the current tool later ignores them) and forwards one `onTileClick(point, pick)` callback with `pick: { vehicleId: string | null; lineId: string | null }`. **It never chooses Select mode, node priority, building intent, or direct UI navigation.** `handleTileClick` applies its existing `workingSave.isBusy()` gate, route-draft handling, and `activeTool === "inspect" && selectedBuilding === null` gate. Only in that Select branch does the pure `applyUiTileClick(state, ui, point, pick)` resolve click priority.

Add a transient `ui.selectedVehicleId: string | null`, not saved. A vehicle selection sets `selectedId` to its clicked tile (for same-tile repeat clicks), clears conflicting node inspection, and opens contextual Inspect. On the **next click of that same tile when a present stop/station is under the vehicle**, fall through to the node resolver rather than selecting the same vehicle again; once a node is selected, further same-tile clicks retain the existing stop/station cycle. Selecting another tile, tool, building or wait location clears the vehicle ID. No new selection union or separate controller action.

Project `ShellInspectorState.kind = "vehicle"` from the currently present vehicle by ID: line ID/name/color, `passengerCount`/`capacity` and the current leg's `toWaypointId` label (`legs[itineraryIndex % legs.length]`). Show `—` for unavailable/broken destinations, and close the inspector if the vehicle vanishes. Reuse the existing Inspector and `onOpenServiceControls(lineId)` button. Do not cache rider counts or save inspector state.

## B. Click an actual line-path tile

The **same pure picker** returns a nearest line ID from the displayed connected/last-valid Bus/Metro geometry, using `renderableLines`, `buildCorridorGroups`, `presentationForRoute` and `pathGeometry`. Only consider a line when its presented path has a step on the **clicked tile**; a proximity radius must never let a path in an adjacent road tile steal a click from a building. Within candidate lines use roughly 16 world-pixel proximity, distance then stable line ID. Do not search a full map every animation frame: this runs on click only. No general selection pass, line-picker menu, or new route/path model.

The existing Select branch decides in this order:

1. Rendered vehicle hit (except same-tile repeat selection of a present node).
2. Present stop/station via existing `resolveNodesAtTile(state, point)`, including same-tile cycling; no tombstone is selectable.
3. Tile-gated line hit; clear any previous vehicle Inspect, and return the line ID as a small decision from `applyUiTileClick` so `handleTileClick` can call existing non-toggle `openServiceControls(routeId)` **after** the busy/tool gates.
4. Existing building/ordinary tile selection.

The host does **not** call `onVehicleClick`, `onLineClick` or `openServiceControls` itself. Building placement, route editing, click-to-pan/drag and other tools retain their existing precedence.

## C. Center on a waiting location

Add one `CameraAction` variant `{ kind: "centerOn"; point: Point }` in `boardTransform.ts`. It uses the current zoom and existing `clampCamera`; from fitted/null, start at bounded 2× fit so centering has a visible effect (or remain fitted if zoom is unavailable). Camera stays local and unpersisted.

After `focusWaitLocation` successfully validates the line, present node and route-draft gate, invoke `gameHost.adjustCamera({ kind: "centerOn", point: node.position })` while keeping its existing selected route and node Inspect. No extra Lines callback or new camera service.

## Delivery boundaries and review gates

Implement and review in three **vertical slices in this same PR**: (A) frame + vehicle pick + vehicle Inspect, (B) line path pick, (C) wait-location camera focus. Each slice ends with a working player click.

- Rust's existing no-passenger-IDs projection test also asserts numeric load/capacity; no redundant empty-vehicle fixture.
- Pure picker tests: hit, miss, nearest of two, and tile-gated line precedence; one host test covers zoom/pan coordinate conversion and click-after-pan suppression. Existing sampler tests cover parked, terminal, corridor and paused positions.
- Pure Select tests: building placement cannot be hijacked, save busy / route draft remain gated, vehicle → same-tile node → stop/station cycle, node wins over line, and vehicle selection clears on tile/tool switch.
- Selector/UI tests: Bus and Metro labels, current frame load, missing vehicle or broken leg, and opening Lines.
- Camera tests: active-zoom center, fitted→2× center and one invalid-node no-op. Existing clamp tests cover edges.
- Browser e2e: pause, click a rendered vehicle, assert line + `0 / capacity`, click a non-stop route path tile, assert Lines opens. Test wait-location camera focus at runtime with the fake host; do not manufacture an at-risk commuter scenario only for Playwright.

Explicitly out: per-rider details, camera following, new visual/audio assets, GPU pick passes, spatial indexes, migration, generic selection abstraction, and oversized regression matrices.
