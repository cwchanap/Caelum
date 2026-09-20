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

Do not add a mode or vehicle ID to the public command.

### 1.2 Add one shared candidate helper

In `service_control.rs`, add a small helper that receives the snapshot, line ID, mode, and ordered vehicle IDs.

Rules:

- return `None` when `vehicle_ids.len() <= 1`;
- iterate `vehicle_ids.iter().rev()`;
- resolve each ID from `snapshot.transit.vehicles`;
- require matching `line_id`, matching mode, and empty `passenger_ids`;
- return the first matching vehicle ID.

Use this helper as the single ownership point for both availability and mutation.

Do not generalize this into a fleet repository or vehicle-query abstraction.

### 1.3 Implement `retire_service_vehicle`

Authoritative order:

1. resolve Bus/Metro with existing `service_mode`; unknown ID returns `RouteNotFound`;
2. read active flag, legs, and ordered `vehicle_ids`;
3. if fleet <= 1, return `CostedMutation::free(state.clone())`;
4. resolve the empty candidate; if none exists, return the same free no-op;
5. validate active route; otherwise `InactiveRoute`;
6. validate current operational legs with existing `is_route_operational`; otherwise `DisconnectedLeg`;
7. clone snapshot;
8. remove candidate ID from the route/line `vehicle_ids`;
9. remove that vehicle from `transit.vehicles`;
10. return a free mutation with budget unchanged.

The candidate must be checked before cloning/mutation.

No call into route lifecycle, trip invalidation, routing, or `CostPolicy`.

### 1.4 Publish `canRetireVehicle`

Add `can_retire_vehicle: bool` to Rust `ServiceMetrics`.

Update the model-wire expectation to pin `canRetireVehicle`.

In `service_metrics_by_line`, derive the availability bit from current authoritative state using the same candidate helper plus the same active/operational line rule. Pass the resulting bool into the existing metric constructor.

Do not expose candidate ID or passenger counts.

### 1.5 Rust behavior tests

Prefer a compact shared fixture/table over duplicate Bus and Metro suites.

Required tests:

- Bus: reverse-order selection removes newest assigned empty vehicle.
- Metro: same line-ID contract and removal semantics.
- Occupied newest vehicle is skipped in favor of an earlier empty vehicle.
- All removable vehicles occupied => no-op.
- One vehicle => no-op.
- Inactive line with an otherwise eligible candidate => `InactiveRoute`.
- Disconnected line with an otherwise eligible candidate => `DisconnectedLeg`.
- Retirement may make `assignedFleet < requiredFleet`.
- Budget does not change.
- Surviving vehicles compare equal before/after, including passenger IDs/cursors/parked positions.
- Active trips, target, geometry, revision, and wait evidence are unchanged by the mutation itself.
- Refreshed metrics show the smaller fleet, larger nominal interval, lower running daily cost, unchanged recommendation, and recomputed retirement availability.

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
- focused runtime/selector tests

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

### 2.3 Focused TypeScript tests

Update fixture service metrics once in shared helpers rather than scattering ad-hoc defaults.

Pin:

- selector forwarding true/false;
- runtime sends the exact command;
- no TypeScript retirement eligibility calculation exists.

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

- button absent when `canRetireVehicle === false`;
- Bus/Metro copy;
- click invokes the callback with the line ID;
- App forwards to runtime once.

Do not test Rust eligibility rules again in Svelte.

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

Reuse the existing deployed Bus service setup rather than creating a new scenario framework.

1. Build/configure an active Bus line with a deployed fleet.
2. Globally pause simulation before the add/retire pair. HPA-48 already allows Add while globally paused, and this guarantees the newly added vehicle remains empty.
3. Record:
   - current fleet count;
   - current daily operating cost;
   - current budget.
4. Click existing Add bus.
5. Assert:
   - fleet increases by one;
   - budget decreases by the existing purchase cost;
   - retirement becomes available.
6. Click `Retire bus · no refund`.
7. Assert:
   - fleet returns to the prior count;
   - daily operating cost returns to the prior value;
   - budget stays at the post-purchase value;
   - line remains selected/operational and no route draft opens.

Do not add a second Metro E2E. Rust tests own mode parity.

Rebuild WASM before Playwright so the browser does not exercise a stale Rust artifact.

### Task 4 gate

Run the repository's normal WASM build command, then:

```bash
bun run test:e2e
```

---

## Task 5 — Final cleanup and whole-branch verification

### Scope scan

Confirm the PR did **not** introduce:

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
rg "RetireServiceVehicle|retireServiceVehicle|canRetireVehicle" crates src tests
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
