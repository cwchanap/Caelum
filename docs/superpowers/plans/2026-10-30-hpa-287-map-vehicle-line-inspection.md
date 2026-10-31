# HPA-287 — Map Vehicle and Line Inspection — Implementation Plan

> **Design:** [2026-10-30-hpa-287-map-vehicle-line-inspection-design.md](../specs/2026-10-30-hpa-287-map-vehicle-line-inspection-design.md)  
> **Linear:** [HPA-287](https://linear.app/cwchanap/issue/HPA-287/click-vehicles-and-lines-on-the-map)  
> **PR policy:** Design, implementation, tests and review belong in **this single draft PR**. Do not create a coding follow-up PR.

## Working agreement

Caelum is a hobby transport sandbox. Keep the existing Rust gameplay authority and the shared WASM/Tauri projection. The WebGPU host determines **geometry candidates**, not whether a click should select, build or navigate. The runtime and pure UI action own policy. No gameplay intent, persisted field, save-schema change, new visual/SFX work, picker framework or new commands.

Implement as **three visible vertical slices**, each functional and testable before the next one. Do not split them into multiple PRs.

## Slice A — Load projection → vehicle click → Inspect

**Change:** `crates/caelum-core/src/presentation.rs`, `src/domain/types.ts`, `src/runtime/backend/types.ts`, `src/render/webgpu/vehicleInstances.ts`, `src/render/webgpu/pickMapTarget.ts` (small new pure helper), `src/runtime/createWebGpuHost.ts`, `src/ui/uiState.ts`, `src/ui/actions.ts`, `src/runtime/createGameRuntime.ts`, `src/runtime/types.ts`, `src/runtime/runtimeSelectors.ts`, `src/components/hud/panels/InspectPanel.svelte`; extend the existing tests for those components.

### A1 — Extend exactly the existing Rust frame

1. In the existing vehicle projection test at `presentation.rs` (the no-passenger-IDs assertion), also assert `passengerCount` and `capacity` from a fixture with known passenger IDs/capacity. Do not add another empty-vehicle test.
2. Add `passenger_count: usize` and `capacity: u16` to `VehiclePresentation`. Populate them with `vehicle.passenger_ids.len()` and `vehicle.capacity` in `project_frame`. Do **not** expose passenger IDs on the frame.
3. Add `passengerCount: number` and `capacity: number` to the **existing** `Vehicle` in `src/domain/types.ts`. Do not add `PresentedVehicle` or change `GameState.transit` to an intersection type.
4. In `RustVehicle extends Omit<Vehicle, ...>` add **`"passengerCount"`** to the omitted fields; its existing `capacity`/durable `passengerIds` declaration remains the authority for saved vehicles. `PresentationVehicle` inherits both scalars without an explicit override. `src/runtime/presentationView.ts` **does not change**, because it already spreads the frame vehicle and normalizes `parkedPosition`.
5. Adjust only fixtures affected by the now-required live vehicle scalars. No migrations, wrappers or host-specific branches.

**Check:** `cargo test -p caelum-core`, `bun run check`, targeted runtime presentation tests.

### A2 — Reuse last rendered vehicle samples

1. In `vehicleInstances.ts`, have the existing interpolation → cull → instance-encoding loop expose the post-cull `{ id, point }` samples **from that exact pass**, without a second vehicle-position calculation. Keep current paused, parked, terminal, corridor-offset and continuity behavior unchanged.
2. `createWebGpuHost.ts` retains the latest **on-screen drawn** samples (and the matching drawing transform, when relevant to coordinate conversion); refresh on actual `drawFrame`. An offscreen capture must not replace the screen's hit-target list. Clear on detach.
3. Add a small pure `pickMapTarget.ts` helper that finds the nearest point within `tileSize / 2`, squared distance then ID, from the drawn samples. The host converts click CSS to world pixels using `getBoardTransform` and keeps the current drag/pan click-suppression guards. Do not introduce a spatial index, GPU readback or new gesture state.
4. Extend existing `WebGpuHostContext.onTileClick` to accept an optional, narrow `pick: { vehicleId: string | null; lineId: string | null }`. For this slice `lineId` is null. **No** `onVehicleClick` or `onLineClick` callback; don't duplicate the Select gate in the host. Extend `RuntimeController.handleTileClick` to receive the candidate. The current busy gate, edit-draft waypoint interception and existing non-Select intent path stay in charge.

**Tests:** pure picker hit, miss, nearest-of-two; one host test for zoom/pan coordinate conversion, callback wiring and click-after-pan suppression. Existing `tests/render/webgpuVehicleInstances.test.ts` already tests paused, parked, terminal and shared-corridor sampling; do not repeat those scenarios in DOM click tests.

### A3 — Decide Select policy in the existing pure action

1. Add `selectedVehicleId: string | null` to `UiState`, initialized to null. No selection union, independent selector manager, save field or new public `selectVehicle()` controller method.
2. Extend `applyUiTileClick(state, ui, point, pick)` to accept the optional geometry candidate. **Only** the `handleTileClick` branch with `ui.activeTool === "inspect" && ui.selectedBuilding === null` (and after `workingSave.isBusy()`) passes the pick to Select resolution. Keep route drafts and building-placement intent paths unchanged.
3. For a live vehicle ID hit, set `selectedVehicleId`, `selectedId` to the clicked tile for repeat-click detection, `selectedNodeKind: null` and the existing contextual Inspect destination. Never cache vehicle load. If a present stop or station is under that vehicle and the player repeats the click on the same tile, select the node instead of the vehicle; subsequent same-tile clicks continue the existing stop↔station cycling. Validation uses existing `resolveNodesAtTile(state, point)` only inside the action, not the WebGPU host. A candidate missing from the latest state falls through.
4. Clear `selectedVehicleId` wherever ordinary selection is replaced. The **seven runtime locations** are `nextToolUiState` (~149), `nextAreaUiState` (~184), `nextBuildingUiState` (~212), the `openRouteEdit` transition (~803), the explicit UI reset/selection transitions (~915 and ~1022), and `focusWaitLocation` (~1875). Also clear it in the **two tile-selection returns** in `src/ui/actions.ts` (~137 and ~156). `resetUi()` already reconstructs `createUiState()`; don't add redundant branches. Inspect also returns null if the chosen ID disappears from a later frame.
5. Add `ShellInspectorState.kind = "vehicle"`; from the **current** vehicle and route/line derive name/color, riders/capacity and the leg destination label via `legs[itineraryIndex % legs.length].toWaypointId`. Missing leg/line/node or broken path shows `—`. Add a compact vehicle branch to existing `InspectPanel.svelte`; its line chip reuses `onOpenServiceControls(lineId)`.

**Tests:** use `tests/ui/actions.test.ts` for Select/placement gate and vehicle→same-tile node, `tests/runtime/gameRuntime.test.ts` for busy gate, and existing selector/Inspect tests for numeric load and next-stop display. Pin **one** clearing invariant: a vehicle selection followed by an ordinary tile click and a tool switch clears vehicle Inspect. Cover stale/removed vehicle with one focused test; no exhaustive state-transition matrix.

**Slice A done:** clicking a paused or moving visible Bus/Metro vehicle opens real Inspect with its line, live numeric load and next stop, without hijacking a house placement or route-draft click.

## Slice B — Line-path click in the same Select flow

**Change:** `src/render/webgpu/pickMapTarget.ts`, `src/runtime/createWebGpuHost.ts`, `src/ui/actions.ts`, `src/runtime/createGameRuntime.ts`, extend existing pure picker/Select/host tests.

1. From `renderableLines(state)` and `buildCorridorGroups`, sample the **displayed** `presentationPath` steps after `presentationForRoute` offsets; reuse `pointAt`/`pointAndTangentAt` from `pathGeometry.ts`. No second route model or continuously computed path hit index.
2. **Hard tile gate:** a line is eligible **only if its presented path has a step on the clicked tile**, not merely within 16 world pixels of a nearby tile. This prevents the shared-corridor (4px offset) proximity radius from stealing clicks on neighboring building tiles. Within eligible steps, choose nearest within ~16 world px, then stable line ID. Preserve existing broken/last-valid presentation semantics.
3. `onTileClick(point, { vehicleId, lineId })` now carries both geometry candidates; the host still does not decide click priority. In the Select branch, `applyUiTileClick` resolves vehicle (except same-tile node repeat) > present node > tile-gated line > ordinary tile. For line hits, clear any previous `selectedVehicleId`, return a narrow `lineIdToOpen` decision alongside UI state and have `handleTileClick` call the **existing** idempotent `api.openServiceControls(lineId)` after its current busy/tool gates. Do not reproduce or toggle Lines state in the host/action, and don't open route edit.
4. Preserve existing ordinary empty/building inspector selection and suppression of click events following pan/drag.

**Tests:** pure picker verifies tile-gated route hit vs adjacent building tile and nearest of shared lines; pure UI action verifies node wins over route and placement tools ignore picks; host test verifies callback forwarding. Keep one concise runtime assertion that a valid line hit clears previous vehicle Inspect and opens Lines with the chosen route (even if already selected).

**Slice B done:** click a visible Bus/Metro path away from a station/stop to manage that line, while nearby buildings and stop inspectors keep their old behavior.

## Slice C — Camera focus on Lines wait-location click

**Change:** `src/render/boardTransform.ts`, `src/runtime/createGameRuntime.ts`, existing board-transform/runtime/fake-host tests.

1. Add `{ kind: "centerOn"; point: Point }` to `CameraAction` and `applyCameraAction`. Preserve current zoom, clamp the center against the actual board; from `null` fitted view, start at bounded **2×** zoom so a center request has a visible effect (or remain fitted if no zoom possible). Camera remains local/unpersisted.
2. In existing `focusWaitLocation(routeId, nodeId)`, **after** validation of route + present node + inactive route draft, call `gameHost.adjustCamera({ kind: "centerOn", point: node.position })`. Preserve its existing route selection, node Inspect and no-op invalid cases. No extra Lines button callback or center service.
3. Tests: active-zoom centering, fit→2× centering, and one missing-node no-op in existing unit/runtime tests, using `tests/helpers/gameHost.ts` to observe camera actions. Edge clamping is already covered by existing `clampCamera` tests.

**Slice C done:** a wait-location click centers the actual map camera and still opens that stop/station's contextual Inspect.

## Final verification and merge gate

Run targeted checks during each slice; before marking this **same PR** ready:

- `cargo fmt --all --check` and `cargo test -p caelum-core`
- `bun run check` and `bun run test:unit`
- `bun run lint` and `bun run format:check`
- Browser Playwright: **pause**, click displayed vehicle, assert line and `0 / capacity`; click a line-path tile away from stops, assert Lines opens. No changed-load E2E or manufactured at-risk commuter scene.
- Wait-location center is covered by runtime fake-host tests; verify both adapters share the same core projection without a second UI implementation.

## Risks worth checking (and nothing more)

- **Policy bypass:** building placement also uses `activeTool: "inspect"`; host-picked candidates must not intercept `selectedBuilding` or `workingSave.isBusy()`.
- **Pixel parity:** choose from last on-screen post-cull instances, not recomputed snapshots; do not let debug capture silently update picking state.
- **Station accessibility:** first click over train picks the train, second same-tile click reaches station, further stop/station clicks retain their cycle.
- **Adjacent building safety:** tile-gated path candidates, not just nearest geometry.
- **Transient state cleanup:** clear selected vehicle at the nine existing selection-write sites and re-derive Inspect from current frame.
- **Types:** add scalars to live `Vehicle`, omit `passengerCount` on saved `RustVehicle`, no new `PresentedVehicle`, no fold or schema changes.

No new assets, sound, routing rules, persistent camera, generic picker or separate implementation PR.
