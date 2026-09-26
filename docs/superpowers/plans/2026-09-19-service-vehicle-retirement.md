# HPA-368 — One-vehicle service retirement implementation plan

## Objective

Implement the approved HPA-368 retirement slice on this same PR:

> A player can retire one empty Bus or Metro vehicle from the existing Lines controls, never the last vehicle, with no refund and no rider disruption.

Keep the implementation local to existing service-control seams. Do not add a fleet manager, deferred-retirement state, passenger ejection path, resale economy, or new UI surface.

## Verified starting point

Current `main` already has:

- line-ID-only `AddServiceVehicle`;
- shared Bus/Metro `service_control`;
- ordered `vehicle_ids` on each line;
- Rust-only `Vehicle.passenger_ids`;
- derived/non-authoritative `ServiceMetrics`;
- live Fleet / Recommended / Estimated interval / Daily cost / wait information;
- one-at-a-time Add bus/train in `LinesPanel.svelte`;
- thin runtime/backend command forwarding;
- real-WASM route/service E2E coverage.

The new work is one inverse fleet mutation plus one availability bit.

---

## Task 1 — Add the Rust retirement contract and authoritative mutation

**Modify**

- `crates/caelum-core/src/intent.rs`
- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/model.rs`
- `crates/caelum-core/src/rejection.rs`
- `crates/caelum-core/src/service_control.rs`
- `crates/caelum-core/tests/model_wire_format.rs`
- `crates/caelum-core/tests/service_control.rs`

### 1.1 Lock the wire contract first

Add a failing wire-format test for:

```json
{
  "type": "retireServiceVehicle",
  "lineId": "route-001"
}
```

Add `RetireServiceVehicle { line_id: String }` to `GameIntent` and dispatch it through `service_control::retire_service_vehicle`.

Update the existing exhaustive `expected_type_tag` / GameIntent type-tag table in `model_wire_format.rs` with the new variant. The dedicated JSON test and exhaustive tag table must both go green in this task.

Do not add a mode or vehicle ID to the public command.

### 1.2 Add one shared candidate helper

In `service_control.rs`, add a small helper that receives the snapshot, line ID, mode, and ordered vehicle IDs.

Rules:

- return `None` when `vehicle_ids.len() <= 1`;
- iterate `vehicle_ids.iter().rev()`;
- resolve each ID from `snapshot.transit.vehicles`;
- require matching `line_id`, matching mode, and empty `passenger_ids`;
- return the first matching vehicle ID.

Use this helper only for dispatch-time concrete vehicle selection.

Do not generalize this into a fleet repository or vehicle-query abstraction. Availability is a separate slow-state predicate so presentation never scans occupancy.

### 1.3 Add the occupied-fleet rejection and implement `retire_service_vehicle`

Add `RejectionCode::VehiclesOccupied` to the Rust rejection enum. It carries the existing route context only; do not add passenger/vehicle IDs to the rejection.

Authoritative order:

1. resolve Bus/Metro with existing `service_mode`; unknown ID returns `RouteNotFound`;
2. read active flag, legs, and ordered `vehicle_ids`;
3. if fleet <= 1, return `CostedMutation::free(state.clone())`;
4. validate active route; otherwise `InactiveRoute`;
5. validate current operational legs with existing `is_route_operational`; otherwise `DisconnectedLeg`;
6. resolve the empty candidate; if none exists, return `VehiclesOccupied`;
7. clone snapshot;
8. remove candidate ID from the route/line `vehicle_ids`;
9. remove that vehicle from `transit.vehicles`;
10. return a free mutation with budget unchanged.

The empty-candidate check is a live safety check, not a substitute for service-state validation. An inactive/disconnected line with two occupied vehicles must still follow the service-state rejection contract, and an active line whose removable vehicles all carry riders returns an explicit gameplay rejection rather than a silent unchanged snapshot.

The candidate must be checked before cloning/mutation.

No call into route lifecycle, trip invalidation, routing, or `CostPolicy`.

### 1.4 Publish `canRetireVehicle`

Add `can_retire_vehicle: bool` to Rust `ServiceMetrics`.

Update the model-wire expectation to pin `canRetireVehicle`.

Add a small `retire_vehicle_offer(active, legs, assigned_fleet)` sibling of `add_vehicle_offer` and publish `canRetireVehicle` from only:

- active line;
- operational legs;
- assigned fleet >= 2.

Do **not** scan `passenger_ids` in `service_metrics_by_line` / `metrics`, and do **not** include `snapshot.paused`. Global simulation pause freezes boarding/movement but remains a valid planning state for Add/Retire; only route/line inactivity suppresses the offer.

The authoritative mutation still reverse-scans occupancy at dispatch. Do not expose candidate ID or passenger counts.

### 1.5 Rust behavior tests

Prefer a compact shared fixture/table over duplicate Bus and Metro suites.

Required tests:

- Bus: reverse-order selection removes newest assigned empty vehicle.
- Metro: same line-ID contract and removal semantics.
- Occupied newest vehicle is skipped in favor of an earlier empty vehicle.
- All removable vehicles occupied => `VehiclesOccupied` rejection.
- One vehicle => no-op.
- Inactive line with an otherwise eligible candidate => `InactiveRoute`.
- Disconnected line with an otherwise eligible candidate => `DisconnectedLeg`.
- Global simulation pause: `canRetireVehicle === true`, dispatch applies when an empty candidate exists, and budget is unchanged.
- Retirement may make `assignedFleet < requiredFleet`.
- One **authoritative snapshot surgical-equality** test in the internal `service_control.rs` test module: call the retirement mutation directly on a snapshot whose derived `service_metrics` are not authoritative, clone the before-state into `expected`, remove only the chosen vehicle ID from the line and the matching `Vehicle`, then assert the complete resulting snapshot equals `expected`. This replaces field-by-field preservation assertions and automatically covers budget, trips, target, geometry/revision, surviving vehicle fields, and future fields.
- Keep one separate output-metrics test for the intentionally changed derived values: smaller fleet, larger nominal interval, lower running daily cost, unchanged recommendation/add semantics, wait health, and recomputed retirement availability.

### Task 1 gate

Run:

```bash
cargo fmt --all -- --check
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test service_control
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Do not continue with frontend wiring until the authoritative Rust contract is green.

---

## Task 2 — Extend the existing TypeScript command boundary

**Modify**

- `src/domain/types.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/types.ts`
- `src/runtime/createGameRuntime.ts`
- `src/runtime/runtimeSelectors.ts`
- `src/runtime/rejectionMessages.ts`
- focused runtime/selector/rejection-message tests

### 2.1 Mirror the derived metric

Add:

```ts
canRetireVehicle: boolean;
```

to `ServiceMetrics` and `ShellServiceState`.

`selectServiceState` must only forward:

```ts
canRetireVehicle: route.serviceMetrics?.canRetireVehicle ?? false
```

Do not derive it from `assignedFleet`, route status, or frontend vehicle rows.

### 2.2 Add the backend/runtime command

Extend the backend intent union with:

```ts
{ type: "retireServiceVehicle"; lineId: string }
```

Extend `RuntimeController` with:

```ts
retireServiceVehicle: (lineId: string) => RuntimeCommandResult;
```

Implement it in `createGameRuntime` exactly like `addServiceVehicle`:

- dead runtime => current snapshot;
- otherwise `enqueueDispatch({ type: "retireServiceVehicle", lineId })`.

### 2.3 Add rejection copy

Extend the TypeScript `RejectionCode` union with `"vehiclesOccupied"` and handle it exhaustively in `rejectionMessages.ts` with mode-neutral copy:

```text
Every removable vehicle on this line has riders.
```

Do not derive the line mode for this message.

### 2.4 Focused TypeScript tests

Update fixture service metrics once in shared helpers rather than scattering ad-hoc defaults.

Pin:

- selector forwarding true/false;
- runtime sends the exact command;
- `vehiclesOccupied` maps to the new player-facing rejection message and remains covered by the exhaustive rejection switch.

The "no TypeScript retirement eligibility formula" rule is verified by the concrete selector/UI behavior plus the final source scan; do not invent a Vitest assertion for absence of code.

### Task 2 gate

Run:

```bash
bun run check
bun run test:unit
```

---

## Task 3 — Add the one Lines-panel action and App wiring

**Modify**

- `src/components/hud/panels/LinesPanel.svelte`
- `src/App.svelte`
- `tests/ui/linesPanel.test.ts`
- `tests/ui/appShell.test.ts`

### 3.1 Lines-panel prop

Add:

```ts
onRetireServiceVehicle: (routeId: string) => void;
```

No new component or dialog.

### 3.2 Render from Rust-owned availability only

In the deployed-service controls, render the action iff:

```ts
route.service.canRetireVehicle
```

Copy:

- Bus: `Retire bus · no refund`
- Metro: `Retire train · no refund`

Keep Add and Retire as independent explicit actions. Do not hide Add merely because Retire is available; recommendation is guidance and the player is allowed to reverse a choice at sunk capital cost.

No confirmation state in this slice.

### 3.3 App delegation

Add one handler mirroring the existing Add handler:

```ts
function handleRetireServiceVehicle(lineId: string): void {
  if (runtime !== null) {
    void applyRuntimeResult(() => runtime.retireServiceVehicle(lineId));
  }
}
```

Pass it to `LinesPanel`.

### 3.4 UI tests

Pin:

- below-recommendation fixture: `canRetireVehicle: true` with `assignedFleet < requiredFleet` still renders Retire with the no-refund copy;
- `canRetireVehicle: false` hides the control even if the fixture has multiple assigned vehicles, proving the panel does not substitute fleet-count/recommendation logic for Rust's bit;
- Bus/Metro copy;
- click invokes the callback with the line ID;
- App forwards to runtime once.

Do not test the underlying Rust occupancy algorithm again in Svelte; these assertions only lock that the UI obeys the Rust-owned bit.

### Task 3 gate

Run:

```bash
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run build
```

---

## Task 4 — Prove the player flow through real WASM

**Modify**

- the existing route/service Playwright spec, expected to be `tests/e2e/routes.spec.ts`
- shared E2E helpers only if an existing helper is genuinely missing

### Browser journey

Extend the existing `tests/e2e/routes.spec.ts` test **"tunes a deployed bus service from its line summary"** in place. Do not create another setup journey.

That test already owns the exact prerequisites and values HPA-368 needs: deployed Bus line, selected route, paused/no-elapsed-time state, `baselineAssigned`, `baselineBudget`, `baselineDailyCost`, `nextVehicleCost`, `originalVehicleIds`, and the existing Add assertion.

Immediately after the current post-Add assertions:

1. assert `serviceMetrics.canRetireVehicle === true`;
2. click `Retire bus · no refund`;
3. poll until `vehicleIds.length === baselineAssigned`;
4. assert `dailyOperatingCost === baselineDailyCost`;
5. assert budget remains `baselineBudget - nextVehicleCost` (no refund);
6. assert all original vehicle IDs remain and the added ID disappeared;
7. retain the existing final proof that route selection survives and no route draft opens.

Do not add a new pause step or duplicate road/stop/route/deploy setup. Do not add a second Metro E2E; Rust tests own mode parity.

Rebuild WASM before Playwright so the browser does not exercise a stale Rust artifact.

### Task 4 gate

Run the repository's normal WASM build command, then:

```bash
bun run test:e2e
```

---

## Risks / accepted tradeoffs

- **Live occupancy race:** the button is intentionally stable and does not promise an empty vehicle still exists at dispatch. If every removable vehicle has riders by the time Rust executes the command, `VehiclesOccupied` is the explicit recoverable result. Never solve this with a tick-rate occupancy button or deferred-retirement state.
- **Physical spacing after non-immediate retirement:** removing the newest just-added vehicle exactly restores the pre-purchase spacing because Add inserted it into the largest gap. Retiring some older empty vehicle after service has churned can leave a larger physical gap while nominal headway still reports `roundTrip / fleet`. Accept that approximation in HPA-368; do not add fleet re-spacing unless later playtesting justifies it.

---

## Task 5 — Final cleanup and whole-branch verification

### Scope scan

Confirm the PR did **not** introduce:

- passenger occupancy scans in the retirement offer/metrics path;
- refund/resale fields or cost policy;
- deferred retirement state;
- passenger ejection/requeue code;
- last-vehicle removal;
- vehicle picker UI;
- fleet re-spacing;
- schema bump/migration;
- history/undo;
- new renderer work;
- new image/audio assets.

Useful searches:

```bash
rg "RetireServiceVehicle|retireServiceVehicle|canRetireVehicle|VehiclesOccupied" crates src tests
rg "refund|resale|depreciat|retire.*when.*empty|vehicle picker" crates src tests
```

The second search is a review aid, not a requirement to rename unrelated historical docs.

### Full verification

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run format:check
bun run check
bun run lint
bun run test:unit
bun run build
bun run test:e2e
```

Use the repository's existing WASM build prerequisite before the E2E command.

### Final PR update

Update the same draft PR body with:

- implementation summary;
- exact no-refund / empty-only semantics;
- tests run;
- any plan deviation that was required by the real code.

Mark ready only when all gates are green.

## Planned commit shape

Keep this one ticket / one PR. A reasonable implementation history is:

1. `feat: add empty service vehicle retirement`
2. `feat: expose service retirement controls`
3. `test: cover add-retire service flow`

Do not split HPA-368 into separate backend/frontend/QA PRs.
