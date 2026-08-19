# HPA-643 Live Long-Wait Route Health Design

**Linear:** HPA-643  
**Parent:** HPA-335  
**Related:** HPA-628

## Goal

Deliver the first Phase 5 operational-health slice with one live passenger symptom on the existing Lines row:

> When riders who are actually waiting on a platform are taking too long to receive service, show the problem on that Bus or Metro line. If Rust also exposes the existing HPA-628 fleet-shortfall offer, point to the existing Add bus / Add train action as the bounded recovery.

Keep the route-health output as two runtime-derived fields on the existing `ServiceMetrics` seam, backed by one persisted per-leg wait counter on `ActiveTrip` so a transfer rider does not carry a previous line's delay into the next line's health. Do not add a findings engine, history store, new gameplay intent, second pause model, or dashboard.

## Verified baseline and reuse

Current `main` already provides the required seams:

- `crates/caelum-core/src/service_control.rs` owns Bus/Metro cycle time, required fleet, nominal headway, initial deployment, and `next_vehicle_cost`.
- `ServiceMetrics` is runtime-derived output. Route/Metro input ignores `service_metrics`, and save normalization clears it.
- `AddServiceVehicle { line_id }` is the only bounded post-deployment fleet action.
- `crates/caelum-core/src/platforms.rs` already resolves which `Waiting` trips are on a real platform serving their current line. `platform_waiter_ids` performs the full `Waiting -> current line -> position|line platform` filter.
- `crates/caelum-core/src/trips.rs` already derives elapsed wait from `WAIT_PATIENCE_SECONDS - patience_remaining` in multiple places.
- `LinesPanel.svelte` already renders target, nominal headway, assigned/required fleet, `nextVehicleCost`, and minute formatting.

HPA-643 should extend these seams rather than build parallel route-health machinery.

## Product decision: diagnose service risk, not only “past target”

The earlier design counted only:

```text
elapsed wait > configured target headway
```

That is not a usable product rule with the current simulation. `WAIT_PATIENCE_SECONDS` is 240 seconds, and a waiting trip becomes Unserved when patience expires. Therefore a strict “past target” count can never fire for any configured target at or above four minutes. The UI currently permits much larger headways.

Do **not** fix this by capping all service targets to passenger patience. Service target and passenger patience are different product controls, and a four-minute maximum would unnecessarily constrain valid Bus/Metro planning. It would also still leave an exact 240-second target unobservable under a strict `>` comparison.

Instead, make the route-health count explicitly about riders **at risk of going unserved**.

A platform-servable waiter is at risk when either:

```rust
current_leg_wait_seconds(trip) > target_headway_seconds
```

or:

```rust
trip.patience_remaining <= f64::from(MIN_HEADWAY_SECONDS)
```

`current_leg_wait_seconds` is the wait accumulated on the current transit leg's waiting stint only, so a rider who already waited on a previous line does not carry that delay into the current line's health. `MIN_HEADWAY_SECONDS` is already 60 seconds. Reusing that existing service interval gives the player one minimum-headway-sized warning window before patience expiry without inventing another tuning constant.

Consequences:

- short targets still warn when a rider has waited longer than the advertised target;
- long targets still become diagnosable during the final 60 seconds before the rider gives up;
- no service-target ceiling is added;
- the UI copy says “at risk” / “waiting too long,” not “past target.”

A line without a configured target contributes no HPA-643 health. Production initial deployment already requires a target; null-target assigned fleets exist only through fixture/dev seams and do not need an extra observable rule.

## Shared elapsed-wait authority

The expression:

```rust
(WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0)
```

already appears in multiple trip-simulation paths. HPA-643 would otherwise add another copy.

Extract one narrow helper in `trips.rs`:

```rust
pub(crate) fn elapsed_wait_seconds(trip: &ActiveTrip) -> f64 {
    (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0)
}
```

Use it at the existing trip-metric/boundary call sites. This is consolidation of an existing semantic invariant, not a new abstraction layer. Route health does **not** consume `elapsed_wait_seconds`: a transfer rider's trip-wide elapsed wait includes time spent waiting on a previous line, which would misattribute that delay to the current line. Route health uses the per-leg counter below instead.

## Per-leg wait authority and persisted state

Route health must measure only the wait accumulated on the current transit leg's waiting stint, so a rider who waited on a previous line does not carry that delay into the next line's health. Add one persisted counter to `ActiveTrip`:

```rust
pub current_leg_wait_seconds: f64,
```

with a read helper:

```rust
pub(crate) fn current_leg_wait_seconds(trip: &ActiveTrip) -> f64 {
    trip.current_leg_wait_seconds.max(0.0)
}
```

The runtime resets `current_leg_wait_seconds` to zero whenever `current_leg_index` advances (on transfer/boarding/alighting transitions), and accumulates the waiting delta while a leg is in its `Waiting` stint. It is distinct from the trip-wide `patience_remaining` budget, which drives abandonment and is never reset on transfer.

Because this counter feeds route-health derivation on restore, it is persisted canonical snapshot state, not runtime-derived output. The snapshot schema bumps from v8 to v9 to carry it; per the project breaking-change rule, old development city records are cleared rather than migrated. The persistence boundary validates it as finite, non-negative, and no greater than the trip-wide `elapsed_wait_seconds` (the per-leg counter resets on every leg advance while the trip-wide budget is cumulative, so a per-leg value above the trip-wide total is an impossible state the runtime cannot produce).

## Count only platform-servable waiters

A current route-plan line ID alone is not enough to mean a rider can be served. `platform_waiter_ids` already drops waiting trips whose current position and line do not resolve to a present platform serving that line.

HPA-643 must use that complete eligibility rule. Otherwise the warning could recommend adding a vehicle for a rider that no vehicle can board.

Keep `waiting_line_id` private to `platforms.rs`. Refactor the existing scan behind one internal platform-waiter candidate helper, then expose the aggregate needed by `service_control`:

```rust
pub(crate) fn platform_waiters_by_line<'a>(
    state: &'a GameSnapshot,
) -> HashMap<String, Vec<&'a ActiveTrip>>;
```

Both `platform_waiter_ids` and `platform_waiters_by_line` consume the same indexed candidates, so there is still one definition of:

```text
Waiting
AND current non-walk line exists
AND current position|line resolves to a present serving platform
```

Do not expose `waiting_line_id` just so another module can recreate the scan.

`platform_waiters_by_line` must also respect platform capacity: a shared platform whose capacity is already filled by earlier-patience waiters cannot board an overflow rider for that line, so the overflow rider cannot be served by that line at that platform and must not inflate its route health. Filter the grouped waiters through `on_platform_trip_ids` so only riders the platform/boarding seam can actually board contribute to per-line health.

## Chosen data contract

Extend runtime-derived `ServiceMetrics` with exactly two **required** fields:

```rust
pub waiting_at_risk_count: usize,
pub longest_wait_seconds: Option<f64>,
```

Wire form:

```ts
interface ServiceMetrics {
  // existing fields...
  waitingAtRiskCount: number;
  longestWaitSeconds: number | null;
}
```

Do not add serde defaults and do not make the TypeScript fields optional. Update every direct Rust `ServiceMetrics { ... }` literal and exact camelCase wire expectation as part of this breaking development change.

`longest_wait_seconds` is the longest current wait among platform-servable waiters for a targeted line. With no eligible waiters it is `None`.

`waiting_at_risk_count` counts eligible waiters that satisfy the risk rule above.

No total-waiting field, score, severity, finding ID, timestamp, or history is added.

## Derive health once per output snapshot

Keep health publication in `service_control`, next to the existing derived service metrics.

Use a private value:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct WaitingHealth {
    waiting_at_risk_count: usize,
    longest_wait_seconds: Option<f64>,
}
```

and:

```rust
fn waiting_health_by_line(state: &GameSnapshot) -> HashMap<String, WaitingHealth>;
```

The helper:

1. gets `platform_waiters_by_line(state)` once;
2. builds/reads the current target for each real Bus/Metro line;
3. skips lines with no target;
4. uses `trips::current_leg_wait_seconds` for every eligible waiter;
5. records the maximum wait;
6. increments the at-risk count when the rider is past target or has at most `MIN_HEADWAY_SECONDS` patience remaining.

`populate_snapshot_metrics` derives `RoadFlow` and the waiting-health map before either mutable route loop, then passes the matching `WaitingHealth` into the shared Bus/Metro `metrics(...)` function.

This is O(active trips + eligible waiters + lines), not O(lines × active trips), and avoids a mutable/immutable borrow conflict.

## Runtime-only output, persisted per-leg input

The two `ServiceMetrics` fields follow the existing `ServiceMetrics` rules exactly:

- computed only for output snapshots;
- ignored from incoming route/Metro `serviceMetrics`;
- removed by save normalization;
- never trusted to authorize `AddServiceVehicle`.

The backing `ActiveTrip.current_leg_wait_seconds` is **not** runtime-derived output. It is persisted canonical snapshot state under schema v9, restored as authority and trusted by route-health derivation, with the persistence boundary validating it as finite, non-negative, and no greater than the trip-wide elapsed wait. The schema bump is a development breaking change: old development city records are cleared, not migrated, and no compatibility adapter or `serde(default)` is added.

The existing HPA-628 mutation recomputes its own live requirement.

## Lines-row UX

Keep the warning inside the existing deployed service block.

Example with a shortfall:

```text
Target   5.0 min
Nominal  6.4 min
Fleet    2 / 3 required
2 riders at risk · longest 3.2 min. Add bus to recover.
[Add bus · $8,000]
```

Example without a top-up offer:

```text
Target   2.0 min
Nominal  2.0 min
Fleet    2 / 2 required
1 rider at risk · longest 2.4 min.
```

Render only when:

```ts
route.status.primary === "running" &&
route.service.waitingAtRiskCount > 0
```

No separate `assignedFleet > 0` condition is needed: `running` already requires a non-empty fleet. No separate longest-wait null check is needed: a positive at-risk count implies at least one eligible waiter and therefore a non-null longest wait by the Rust contract.

When `nextVehicleCost !== null`, append `Add bus to recover.` / `Add train to recover.` and leave the existing button unchanged. When it is null, the warning is informational; do not invent arbitrary fleet growth.

Do not add `role="alert"` or `aria-live`; this is live simulation data and may update frequently.

Global simulation pause does not need a second route-status field. Existing Rust behavior already suppresses `nextVehicleCost` while paused; a frozen read-only warning may remain visible for an otherwise running line.

## Verification strategy

### Rust helper and platform eligibility

Lock the reusable primitives rather than duplicating a large matrix:

- `elapsed_wait_seconds` returns the expected wait from patience and is used by existing trip logic;
- `current_leg_wait_seconds` is independent of the trip-wide patience budget (reset on leg advance, accumulated per waiting stint);
- a Waiting trip on a real serving platform appears in `platform_waiters_by_line`;
- a Waiting trip with the same route-plan line but no matching present platform does not appear;
- a Waiting trip on a shared platform whose capacity is already filled does not appear for that line;
- non-Waiting trips do not appear.

Existing platform ordering/capacity tests remain unchanged.

### Service-health aggregation

Use one packed `service_control` unit test with targeted real lines and platform-servable waiters to prove:

- line scoping;
- exact target boundary is not “past target” by itself;
- `wait > target` counts;
- long-target rider with `patience_remaining <= 60` counts even though wait is below target;
- no-target line produces default `0 / null` health;
- maximum wait is selected;
- no eligible waiters yields `0 / null`.

Use a Metro output assertion to prove the same shared publication path; do not duplicate the whole matrix per mode.

### HPA-628 coexistence, not causal boarding

Do **not** tick the existing `shortfall_bus_engine()` until a waiter boards. That fixture's shortfall is transient private-car congestion, and boarding depends on platform/cursor alignment. Such a test would combine HPA-643 aggregation, traffic decay, HPA-628 placement, and transit boarding into one unstable causal claim.

Instead:

1. start from the existing restored Bus shortfall fixture;
2. add one valid platform-servable waiter with 59 seconds of remaining patience;
3. assert the same output snapshot has `waitingAtRiskCount > 0`, non-null longest wait, and `nextVehicleCost == Some(BUS_COST)`;
4. dispatch existing `AddServiceVehicle { line_id }`;
5. assert it applies and preserves the existing HPA-628 behavior.

Existing transit/platform tests continue to own boarding correctness.

### Wire and persistence

Update **all** direct Rust `ServiceMetrics { ... }` literals, including the forged direct-restore fixture, and update the exact `json!({...})` `serviceMetrics` output object with:

```json
{
  "waitingAtRiskCount": 0,
  "longestWaitSeconds": null
}
```

for neutral fixtures.

Prove output uses camelCase and `snapshot_for_save()` still omits `serviceMetrics` entirely.

`ActiveTrip.current_leg_wait_seconds` is persisted canonical state under schema v9. Update every direct `ActiveTrip { ... }` literal (including test fixtures) to set it, and add one restore rejection test proving `GameEngine::from_snapshot` rejects an impossible persisted value (e.g. `current_leg_wait_seconds` above the trip-wide `elapsed_wait_seconds`) with an `invalidNumericValue` / `tripCurrentLegWaitSeconds` / `outOfRange` diagnostic.

### TypeScript projection and UI

The real required-field fixture fallout is concentrated in tests that construct non-null `ServiceMetrics` / `ShellServiceState`:

- `tests/runtime/runtimeSelectors.test.ts`;
- `tests/runtime/snapshotView.test.ts`;
- `tests/runtime/gameRuntime.test.ts`;
- `tests/ui/appShell.test.ts`;
- `tests/ui/linesPanel.test.ts`.

`tests/helpers/gameState.ts`, `tests/render/transitRenderer.test.ts`, and `tests/render/overlayRenderer.test.ts` use `serviceMetrics: null` for the relevant helpers and do not need edits solely because the required fields were added. `tests/e2e/routes.spec.ts` reads service metrics but does not construct the type.

For the Lines row, lock:

- positive warning + existing Bus top-up copy/action;
- warning without a top-up offer;
- one representative non-running status hides the warning;
- zero at-risk count hides the warning;
- Metro uses `train` copy through the same component.

Do not create a paused/broken/noFleet mirror matrix.

## Risks

### Patience and target are independent controls

A strict “past target” diagnostic is unreachable for targets at/above current passenger patience. HPA-643 resolves this by diagnosing riders at risk of going unserved, not by constraining all service targets to four minutes.

### Eligibility must match boarding

Counting route-plan-declared waiters without platform resolution would create warnings that the suggested vehicle action cannot address. Health therefore consumes the same platform eligibility scan as boarding, including platform capacity: a shared platform whose capacity is already filled cannot board an overflow rider for that line, so the overflow rider must not inflate that line's health.

### Per-leg wait is persisted and trusted on restore

`current_leg_wait_seconds` is canonical snapshot state under schema v9, not runtime-derived output, so a forged save could publish a false long-wait/past-target warning on restore. The persistence boundary validates it as finite, non-negative, and no greater than the trip-wide elapsed wait; the schema bump clears old development city records rather than migrating them.

### Required-field blast radius

The new `ServiceMetrics` fields and the persisted `ActiveTrip.current_leg_wait_seconds` field intentionally break stale non-null literals. Fix the actual literals and exact wire expectations; do not weaken the production type with defaults or optional fields.

## Non-goals

- Measured departure headway or bunching detection.
- Departure, denied-boarding, dwell, or crowding history.
- Stop/station dashboards or road diagnostics.
- Generic findings/rules/severity/alert infrastructure.
- Automatic fleet changes or optimization.
- Arbitrary extra-vehicle purchase, withdrawal, reassignment, refunds, or selling.
- Post-deployment target editing.
- Changing passenger patience or imposing a new maximum service headway.
- Holding/layover/bunching recovery.
- New causal boarding fixture solely to re-prove HPA-628 top-up behavior.
- Phase 5 fare/subsidy/operating-cost work.
- Save migration, backward compatibility, or security-hardening work.
