# HPA-287 — Map Vehicle and Line Inspection — Implementation Plan

> **Design:** [2026-10-30-hpa-287-map-vehicle-line-inspection-design.md](../specs/2026-10-30-hpa-287-map-vehicle-line-inspection-design.md)  
> **Linear:** [HPA-287](https://linear.app/cwchanap/issue/HPA-287/click-vehicles-and-lines-on-the-map)  
> **PR policy:** Implement, review, and merge **within this one draft PR**. The planning docs are the initial commit; do not create a second coding PR.

## Working agreement

Keep the current Rust simulation authoritative, WASM/Tauri wrappers thin, Svelte presentational, and WebGPU host responsible for pointer coordinates. No schema migration, new gameplay intent, generic pick registry, independent model of vehicle movement, art or SFX. Because development builds have no compatibility requirement, update the frontend vehicle type to match the real compact projection in place.

## Task 1 — Publish vehicle load on the current frame

**Files:** `crates/caelum-core/src/presentation.rs`, `src/runtime/backend/types.ts`, `src/domain/types.ts` (**required** for a distinct live `PresentedVehicle` type), `src/runtime/presentationView.ts`, existing presentation/frame fixtures and tests.

1. First add/update Rust projection test: a vehicle with two `passenger_ids`, known capacity and deterministic cursor emits only `passengerCount: 2` / `capacity`, not IDs. Test empty vehicle too, with no new deep fixture hierarchy.
2. Add the two numeric fields to `VehiclePresentation` and derive from the existing `snapshot.transit.vehicles` pass. Bound the conversion to the chosen numeric type (or use `usize` if already conventional); do **not** serialize passenger IDs or durable snapshot changes.
3. The current `Vehicle` and `PresentationVehicle` types correctly carry cursor fields and **already omit** `passengerIds` and `capacity`. Add `passengerCount: number` and `capacity: number` to `PresentationVehicle` **additively**. In `src/domain/types.ts`, define `PresentedVehicle extends Vehicle` with the two scalar fields; type the live `GameState.transit.vehicles` as `PresentedVehicle[]` using an `Omit<TransitNetwork, "vehicles">` intersection. Leave `Vehicle`, `TransitNetwork` and saved `RustVehicle` unchanged; `presentationView.ts` maps frame scalars into the new live view. Update affected fixture types rather than inventing passenger arrays.
4. Adjust existing WASM/native wire fixture or deserialization assertions only where the contract actually changes. Since both adapters consume core `PresentationUpdate`, don't create separate feature implementations.

**Gate:** `cargo test -p caelum-core`, `bun run check`, and targeted runtime presentation tests.

## Task 2 — Share vehicle sampling and hit-test only on click

**Files:** `src/render/webgpu/vehicleInstances.ts`, `src/runtime/createWebGpuHost.ts`; optionally one small `src/render/webgpu/pickMapTarget.ts` for pure geometry if it improves testability; existing WebGPU/vehicle tests.

1. Refactor `vehicleInstances.ts` minimally to expose the actual sampled vehicle ID + current presented world-pixel position while keeping `encodeVehicleInstances` as the rendering entrypoint. The same `latestSample`/`interpolateSample` and corridor offsets must power both rendering and picking.
2. Cache or capture the latest draw's observation pair/alpha for the ensuing click; do not substitute authoritative positions for interpolated rendered positions. During pause/scene change, preserve current snap behavior.
3. Convert click CSS coordinates into world pixels via `getBoardTransform`; in Select mode, choose the nearest displayed vehicle with squared distance <= `(tileSize / 2)^2`. Tie-break by ID. Don't pick culled/invisible vehicles.
4. Add a narrowly named `WebGpuHostContext.onVehicleClick(id)` callback. For non-Select tools/drafts and after pan suppression, retain existing `onTileClick` behavior unchanged.
5. Tests should pin moving, parked, zero-step terminal, shared-corridor, paused, zoomed, missed-click and competing-vehicle results. Prefer extending `tests/render/webGpuHost.test.ts` and existing vehicle-instance tests over a new general test suite.

**Gate:** `bun run test:unit` (or targeted Vitest projects).

## Task 3 — Select line path while preserving tile inspection

**Files:** `src/render/webgpu/transitBatch.ts` (reuse helpers, only extract if needed), `src/render/pathGeometry.ts` (reuse), `src/runtime/createWebGpuHost.ts`, `src/runtime/createGameRuntime.ts`, relevant host/runtime tests.

1. Implement a click-only nearest presented-path proximity check for Bus/Metro routes. Use `presentationPath`, current shared-corridor geometry/offset and existing geometry sampling; avoid mismatches with rendered paths. Bound the pick radius to roughly half a tile and use stable ID ties.
2. Resolve hit priority in one place: vehicle > existing present stop/station > visible line path on a non-stop tile > existing ordinary tile/building selection. Call the **already exported** `resolveNodesAtTile(state, point)` from `src/ui/actions.ts` for present-node precedence, since it already excludes tombstones. Do not export `presentNodeAt` (which resolves by ID, not tile), reimplement presence rules, swallow building clicks, change route-draft handles, or add a generic hit-target pipeline.
3. Add one narrow `WebGpuHostContext.onLineClick(routeId)` callback (parallel to `onVehicleClick(vehicleId)`) and wire it in `createGameRuntime.ts` directly to the existing `api.openServiceControls(routeId)`. Unlike `selectRoute`, this operation should not toggle off an already selected line. Do not open route editing or introduce a combined pick-result framework.
4. Test distinct route paths, overlapping corridors, station/stop precedence, no valid line hit, and click-after-pan suppression; include an assertion that selected line and Lines destination update together.

**Gate:** focused `tests/render/webGpuHost.test.ts`, `tests/runtime/gameRuntime.test.ts`, and UI shell tests.

## Task 4 — Add transient vehicle Inspect projection

**Files:** `src/ui/uiState.ts`, `src/runtime/types.ts`, `src/runtime/createGameRuntime.ts`, `src/runtime/runtimeSelectors.ts`, `src/components/hud/panels/InspectPanel.svelte`, `src/App.svelte` only for existing callback wiring, and corresponding existing tests.

1. Add `selectedVehicleId: string | null` to `UiState`; initialize/reset/clear it alongside conflicting tile selections. Add a small `selectVehicle(id)` runtime method that validates current presence and opens contextual Inspect without a backend dispatch. Keep it out of saved state.
2. Extend `ShellInspectorState` to `kind: "vehicle"`. From the latest frame vehicle and line/leg scene data derive line name/color, rider count/capacity, and the current leg's destination waypoint label. A missing/broken route shows `—`; never infer a stop from raw vehicle coordinates. Selectors return null when the vehicle vanishes.
3. Add one accessible Svelte vehicle inspector section with a colored line chip that uses the existing `onOpenServiceControls(lineId)` callback. Reuse existing typography and feedback patterns.
4. Assert one bus and one metro case; live load changes; vehicle disappearance; selecting a stop/building afterward replaces vehicle inspect; and opening its line controls switches to Lines without a new route draft.
5. Review `handleEscape`, `resetUi`, create/load and route-delete flows for stale transient selection. Change only paths that actually keep the invalid vehicle ID visible.

**Gate:** `bun run check`, targeted selectors/runtime/UI tests.

## Task 5 — Focus camera from existing wait-location actions

**Files:** `src/render/boardTransform.ts`, `src/runtime/createGameRuntime.ts`, existing board-transform/Lines runtime UI tests.

1. Add `CameraAction.kind = "centerOn"` with `point: Point`, and `applyCameraAction` behavior that preserves active zoom, starts a fitted camera at a modest 2× if possible, and clamps the requested center. Keep `null` as fit.
2. Only after `focusWaitLocation` validates the route, node, and no-route-draft gate, invoke `gameHost.adjustCamera({ kind: "centerOn", point: node.position })` using the existing host callback. Preserve the current selected route/node and contextual Inspector. If camera update causes one additional publication, prefer that simple behavior to a new transaction abstraction.
3. Test centered zoomed view, initial fit view, edge clamping, missing/deleted wait node, and route-draft no-op; extend existing Lines wait-location button test rather than adding a new prop.
4. Ensure the host still clamps camera against the actual CSS board dimensions.

**Gate:** targeted board transform/runtime/Lines tests.

## Final player-flow verification

- `cargo fmt --all --check`
- `cargo test -p caelum-core`
- `bun run check`
- `bun run test:unit`
- `bun run test:e2e -- --project=chromium` (or the smallest relevant Playwright suite while iterating)
- `bun run lint` and `bun run format:check`

One browser Playwright scenario should create/run a small Bus route, click a visible vehicle, assert the line and `0/capacity` then a changed load if practical, select the route from a path tile away from stops, and click an at-risk waiting node to verify the camera/Inspector. Add a Metro scenario in the cheapest existing real-Rust unit/integration tests rather than duplicating a heavy end-to-end setup. Confirm Tauri uses the shared wire and can still start; no separate UI implementation.

## Review-sensitive risks

- **Live vs saved type:** the current frame type is already correct (cursor-only); add numeric fields to the frame and a dedicated live `PresentedVehicle` type without adding frame-only fields to durable `RustVehicle` or the cursor-only domain base.
- **Picking drift:** position and corridor offsets must match rendered vehicles/routes, especially during interpolation and zoom.
- **UX precedence:** a vehicle on top of a stop takes precedence; a stop takes precedence over its line. Preserve prior building/empty-tile behavior elsewhere.
- **Camera fit:** centering at zoom 1 is visually ineffectual, so use bounded 2× from fit; do not alter persisted map state.
- **Work scope:** no animations, tracking camera, per-rider details, route selection menu, general spatial index, full test matrices, or art/SFX ticket.

## Done when

The design acceptance scenarios pass; the PR contains the actual implementation plus these docs; tests and both host contracts pass; and **this same PR** can be marked ready, merged, and used to close HPA-287. Do not create a second PR for implementation.
