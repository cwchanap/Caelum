# HPA-643 Live Long-Wait Route Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a live Bus/Metro route-health warning for platform-servable riders at risk of going unserved, and point to the existing HPA-628 Add bus / Add train action only when Rust already exposes a valid fleet-shortfall offer.

**Architecture:** Extend the existing Rust waiting/platform/service-control seams instead of adding diagnostics infrastructure. Consolidate elapsed-wait derivation in `trips`, add one persisted per-leg wait counter on `ActiveTrip` (schema v9) that route health consumes instead of the trip-wide elapsed wait, expose one platform-eligible waiter aggregate from `platforms` (capacity-filtered), derive two runtime-only `ServiceMetrics` fields once per output snapshot in `service_control`, forward them through the existing TypeScript selector, and render one warning in the Lines row.

**Tech Stack:** Rust `caelum-core`, serde wire contracts, TypeScript runtime, Svelte 5, Vitest/Testing Library, existing Playwright regression suite.

**Spec:** `docs/superpowers/specs/2026-08-18-long-wait-route-health-design.md`

## Corrective addendum (commit `13f967d`)

The task steps below were written before implementation. The original shape derived route health from the trip-wide `elapsed_wait_seconds` and promised no schema bump. A corrective commit changed two things after the initial implementation:

1. **Per-leg wait.** `waiting_health_by_line` now consumes a new persisted `ActiveTrip.current_leg_wait_seconds` counter (reset on every `current_leg_index` advance, accumulated per waiting stint) instead of the trip-wide `elapsed_wait_seconds`. Without this, a transfer rider carried a previous line's delay into the next line's health metric. The counter is persisted canonical state under schema v9 (snapshot schema bumped from v8 to v9; old development city records cleared, not migrated), and the persistence boundary validates it as finite, non-negative, and no greater than the trip-wide elapsed wait.
2. **Platform capacity.** `platform_waiters_by_line` is now filtered through `on_platform_trip_ids`, so a shared platform whose capacity is already filled by earlier-patience waiters cannot inflate route health for a line the overflow rider cannot board.

The Global Constraints, file map, and verification notes below reflect this corrected shape. The per-task code snippets that still show `elapsed_wait_seconds` for route health or an `ActiveTrip` literal without `current_leg_wait_seconds` are historical; treat the Global Constraints and file map as authoritative where they diverge.

## Global Constraints

- Add exactly two required derived `ServiceMetrics` fields: `waitingAtRiskCount` and `longestWaitSeconds`.
- Add one persisted `ActiveTrip.current_leg_wait_seconds` counter so route health measures only the current leg's waiting stint, not the trip-wide elapsed wait that includes previous lines.
- A rider is eligible only when the existing platform logic says the `Waiting` trip is physically on a present platform serving its current non-walk line **and** the platform still has boarding capacity for that rider (filter `platform_waiters_by_line` through `on_platform_trip_ids`).
- Extract `trips::elapsed_wait_seconds(&ActiveTrip)` and use it at the existing wait-metric sites. Route health uses the new `trips::current_leg_wait_seconds(&ActiveTrip)` instead, so a transfer rider does not carry a previous line's delay into the next line's health.
- A targeted eligible waiter is at risk when `current_leg_wait_seconds(trip) > target_headway_seconds` **or** `trip.patience_remaining <= MIN_HEADWAY_SECONDS`.
- Lines without `targetHeadwaySeconds` publish neutral `waitingAtRiskCount == 0` / `longestWaitSeconds == null`.
- Do not cap target headway or change `WAIT_PATIENCE_SECONDS` in this slice.
- Scan active trips through the platform waiter aggregation once; do not scan every active trip once per route.
- Reuse platform eligibility through an aggregate; keep `waiting_line_id` private to `platforms.rs`.
- Bus and Metro use the same `service_control` publication path.
- `ServiceMetrics` remains runtime output only: no serde defaults, compatibility alias, persistence field, or history buffer. The backing `ActiveTrip.current_leg_wait_seconds` is **persisted canonical state**: snapshot schema bumps from v8 to v9, old development city records are cleared (not migrated), and the persistence boundary validates the counter as finite, non-negative, and no greater than the trip-wide `elapsed_wait_seconds`.
- TypeScript forwards Rust values only. It must not reproduce the risk formula, target comparison, platform eligibility, or fleet-offer predicate.
- HPA-643 adds no gameplay intent or runtime controller command.
- The existing HPA-628 `nextVehicleCost` remains the only signal that Add bus / Add train is currently offered.
- Do not widen `AddServiceVehicle` into arbitrary fleet growth.
- Render health only for `route.status.primary === "running"` with positive `waitingAtRiskCount`.
- No Playwright scenario solely to synthesize a long wait.
- No findings engine, dashboard, severity catalogue, alert queue, measured headway history, target editing, holding, withdrawal/reassignment/refunds, operating-cost work, new dependency, or feature flag.

---

## Baseline gate

The planning branch is based on HPA-628 / PR #48. Before implementation:

```bash
git fetch origin
git rebase origin/main

test -f crates/caelum-core/src/service_control.rs
rg "WAIT_PATIENCE_SECONDS" crates/caelum-core/src/trips.rs
rg "platform_waiter_ids|waiting_line_id" crates/caelum-core/src/platforms.rs
rg "AddServiceVehicle|next_vehicle_cost" crates/caelum-core/src crates/caelum-core/tests/service_control.rs
rg "nextVehicleCost" src/runtime src/components/hud/panels/LinesPanel.svelte tests
```

Run the focused baseline:

```bash
cargo test -p caelum-core --test platforms
cargo test -p caelum-core --test service_control
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/ui/linesPanel.test.ts
```

Expected: PASS before HPA-643 edits.

## File map

### Rust production

- `crates/caelum-core/src/trips.rs` — add the shared elapsed-wait helper, replace the existing raw formula copies, add the `current_leg_wait_seconds` read helper, reset the counter on leg advance, and accumulate the waiting delta per leg.
- `crates/caelum-core/src/platforms.rs` — refactor the existing platform waiter scan, expose platform-eligible waiters grouped by current line, and filter the grouped waiters through `on_platform_trip_ids` so shared-platform capacity overflow cannot inflate route health; keep `waiting_line_id` private.
- `crates/caelum-core/src/model.rs` — add the two required derived `ServiceMetrics` fields, add the persisted `ActiveTrip.current_leg_wait_seconds` field, and bump `SNAPSHOT_SCHEMA_VERSION` from 8 to 9.
- `crates/caelum-core/src/service_control.rs` — derive per-line risk/longest-wait from the platform waiter aggregate using `current_leg_wait_seconds` and publish it for Bus/Metro.
- `crates/caelum-core/src/persistence/trips.rs` — validate `current_leg_wait_seconds` as finite, non-negative, and no greater than the trip-wide `elapsed_wait_seconds`.
- `crates/caelum-core/src/persistence/error.rs` — add the `SnapshotField::TripCurrentLegWaitSeconds` variant.
- `crates/caelum-core/src/transit.rs` / `crates/caelum-core/src/stop_access.rs` — reset `current_leg_wait_seconds` at the transfer/boarding/alighting transitions that advance `current_leg_index`.

### Rust tests

- `crates/caelum-core/src/trips.rs` test module — lock elapsed-wait helper semantics and `current_leg_wait_seconds` independence from the trip-wide patience budget.
- `crates/caelum-core/src/platforms.rs` test module — lock platform eligibility/grouping and shared-platform capacity overflow exclusion without widening the function to `pub`.
- `crates/caelum-core/src/service_control.rs` test module — lock risk thresholds, line scoping, null-target neutrality, and longest wait.
- `crates/caelum-core/tests/service_control.rs` — lock Bus/Metro output, persistence, HPA-628 coexistence, every direct `ServiceMetrics` literal in this file, and one restore rejection test for an impossible persisted `current_leg_wait_seconds`.
- `crates/caelum-core/tests/model_wire_format.rs` — update direct literals and the exact camelCase `serviceMetrics` JSON object.
- Every direct `ActiveTrip { ... }` test fixture across `crates/caelum-core/tests/` and the in-line test modules — set `current_leg_wait_seconds` for the new required persisted field.

### TypeScript production

- `src/domain/types.ts` — add required `waitingAtRiskCount` / `longestWaitSeconds` to `ServiceMetrics`.
- `src/runtime/types.ts` — add the same values to `ShellServiceState`.
- `src/runtime/runtimeSelectors.ts` — forward the Rust values only.
- `src/components/hud/panels/LinesPanel.svelte` — render the compact route-health warning.

### TypeScript tests with real non-null literal fallout

- `tests/runtime/runtimeSelectors.test.ts`
- `tests/runtime/snapshotView.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/ui/linesPanel.test.ts`

Do **not** pre-edit `tests/helpers/gameState.ts`, `tests/render/transitRenderer.test.ts`, or `tests/render/overlayRenderer.test.ts`: their relevant route helpers use `serviceMetrics: null`. `tests/e2e/routes.spec.ts` reads metrics but does not construct `ServiceMetrics`.

No production change is expected in `src/runtime/backend/types.ts` or `src/runtime/snapshotView.ts`; their current structural forwarding already carries new `ServiceMetrics` keys.

## Risks

### Risk 1: target headway can exceed passenger patience

`WAIT_PATIENCE_SECONDS` is 240 seconds while service targets can be much larger. A strict “wait > target” warning is therefore unreachable for long targets. Do not hide this with a test precondition and do not cap all service targets to current passenger patience. The implemented risk rule must also count an eligible rider once remaining patience is at most `MIN_HEADWAY_SECONDS`.

### Risk 2: route-plan membership is broader than boardability

A Waiting trip can still name a line while no present platform at its current position serves that line. Counting it would create a warning the suggested Add vehicle action cannot resolve. Health must consume the existing `position|line -> platform` eligibility path.

### Risk 3: required-field fallout is intentional

Adding required fields will break stale non-null Rust/TypeScript literals. Update the actual literals and exact JSON expectation; do not make the fields optional or add serde defaults to reduce edits.

---

### Task 1: Consolidate elapsed-wait and platform-waiter reuse

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/platforms.rs`

**Interfaces:**
- Produces: `trips::elapsed_wait_seconds(trip: &ActiveTrip) -> f64` as `pub(crate)`.
- Produces: `platforms::platform_waiters_by_line<'a>(state: &'a GameSnapshot) -> HashMap<String, Vec<&'a ActiveTrip>>` as `pub(crate)`.
- Preserves: existing `platform_waiter_ids`, `on_platform_trip_ids`, queue sorting, capacity behavior, and private `waiting_line_id`.

- [ ] **Step 1: Add a failing elapsed-wait unit test**

In the existing `#[cfg(test)]` module in `trips.rs`, add a test around the nearest existing Waiting `ActiveTrip` fixture:

```rust
#[test]
fn elapsed_wait_seconds_uses_shared_patience_authority() {
    let mut trip = fixture_waiting_trip();
    trip.patience_remaining = WAIT_PATIENCE_SECONDS - 90.0;
    assert_eq!(elapsed_wait_seconds(&trip), 90.0);

    trip.patience_remaining = WAIT_PATIENCE_SECONDS;
    assert_eq!(elapsed_wait_seconds(&trip), 0.0);
}
```

If the local helper has a different existing name, use that exact existing helper rather than adding a duplicate fixture constructor.

Run:

```bash
cargo test -p caelum-core elapsed_wait_seconds_uses_shared_patience_authority
```

Expected initially: compile failure because `elapsed_wait_seconds` does not exist.

- [ ] **Step 2: Add the shared helper and replace all existing raw copies**

Near `WAIT_PATIENCE_SECONDS` in `trips.rs`:

```rust
pub(crate) fn elapsed_wait_seconds(trip: &ActiveTrip) -> f64 {
    (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0)
}
```

Replace the existing raw formula in:

1. `track_aggregate_wait_boundary`;
2. terminal unserved outcome wait calculation in `tick_trip`;
3. `update_metrics` current waiting sum.

Target shapes:

```rust
.map(|trip| elapsed_wait_seconds(trip))
```

and:

```rust
let outcome_wait_seconds = elapsed_wait_seconds(&next_trip);
```

Verify no production copy remains:

```bash
rg "WAIT_PATIENCE_SECONDS - .*patience_remaining" crates/caelum-core/src/trips.rs
```

Expected: only the helper implementation matches.

- [ ] **Step 3: Add a failing internal platform-eligibility test**

Add a `#[cfg(test)] mod tests` to `platforms.rs` if one does not exist. Build one raw snapshot with:

- a present Bus stop at `(5, 5)`;
- platform `stop-001-p0` serving `route-001`;
- one Waiting trip at `(5, 5)` whose current Bus leg names `route-001`;
- one otherwise identical Waiting trip at `(6, 5)` where no platform serves the line;
- one Riding trip at `(5, 5)` naming the same line.

Use this local helper:

```rust
fn waiting_trip(id: &str, position: Point, status: TripStatus) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: format!("sim-{id}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: position,
        destination: Point::from((0, 0)),
        position: position.into(),
        status,
        deadline: 9_999.0,
        route_plan: Some(RoutePlan {
            estimated_seconds: 100.0,
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: position,
                to: Point::from((0, 0)),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
        }),
        current_leg_index: 0,
        patience_remaining: 100.0,
        private_car_trip: None,
    }
}
```

Assert:

```rust
let grouped = platform_waiters_by_line(&snapshot);
let ids = grouped["route-001"]
    .iter()
    .map(|trip| trip.id.as_str())
    .collect::<Vec<_>>();
assert_eq!(ids, vec!["boardable"]);
```

Run:

```bash
cargo test -p caelum-core platform_waiters_by_line_requires_real_serving_platform
```

Expected initially: compile failure because `platform_waiters_by_line` does not exist.

- [ ] **Step 4: Refactor the existing platform scan behind one candidate helper**

Keep `waiting_line_id` private. Add:

```rust
fn platform_waiter_candidates<'a>(
    state: &'a GameSnapshot,
) -> Vec<(&'a ActiveTrip, String, String)> {
    let index = platform_index(state);
    state
        .active_trips
        .iter()
        .filter_map(|trip| {
            if trip.status != TripStatus::Waiting {
                return None;
            }
            let line_id = waiting_line_id(trip)?;
            let key = format!(
                "{}|{}",
                position_key(
                    trip.position.x.round() as i32,
                    trip.position.y.round() as i32,
                ),
                line_id,
            );
            let platform_id = index.get(&key)?.clone();
            Some((trip, line_id.to_string(), platform_id))
        })
        .collect()
}
```

Refactor `platform_waiter_ids` to consume these candidates and preserve its existing sort:

```rust
pub(crate) fn platform_waiter_ids(state: &GameSnapshot) -> HashMap<String, Vec<String>> {
    let mut groups: HashMap<String, Vec<&ActiveTrip>> = HashMap::new();
    for (trip, _, platform_id) in platform_waiter_candidates(state) {
        groups.entry(platform_id).or_default().push(trip);
    }

    let mut ordered = HashMap::new();
    for (platform_id, mut trips) in groups {
        trips.sort_by(|left, right| {
            left.patience_remaining
                .total_cmp(&right.patience_remaining)
                .then_with(|| left.id.cmp(&right.id))
        });
        ordered.insert(
            platform_id,
            trips.into_iter().map(|trip| trip.id.clone()).collect(),
        );
    }
    ordered
}
```

Add:

```rust
pub(crate) fn platform_waiters_by_line<'a>(
    state: &'a GameSnapshot,
) -> HashMap<String, Vec<&'a ActiveTrip>> {
    let mut groups: HashMap<String, Vec<&ActiveTrip>> = HashMap::new();
    for (trip, line_id, _) in platform_waiter_candidates(state) {
        groups.entry(line_id).or_default().push(trip);
    }
    groups
}
```

Do not export `waiting_line_id`.

- [ ] **Step 5: Run platform/trip regression tests**

```bash
cargo fmt --all --check
cargo test -p caelum-core elapsed_wait_seconds_uses_shared_patience_authority
cargo test -p caelum-core platform_waiters_by_line_requires_real_serving_platform
cargo test -p caelum-core --test platforms
cargo test -p caelum-core --test trip_lifecycle
```

Expected: PASS.

- [ ] **Step 6: Commit the reuse refactor**

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/src/platforms.rs
git commit -m "refactor: share platform wait semantics"
```

---

### Task 2: Publish Rust-owned at-risk route health and lock the wire contract

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/service_control.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/tests/model_wire_format.rs`

**Interfaces:**
- Consumes: `platform_waiters_by_line` and `elapsed_wait_seconds` from Task 1.
- Produces private `WaitingHealth { waiting_at_risk_count, longest_wait_seconds }`.
- Produces private `waiting_health_by_line(state) -> HashMap<String, WaitingHealth>`.
- Extends `ServiceMetrics` / serde wire with required `waiting_at_risk_count` / `longest_wait_seconds`.

- [ ] **Step 1: Add a failing packed risk-aggregation unit test**

In the `service_control.rs` test module, create three route entries using the existing `route_with_legs` helper:

```rust
let mut short_target = route_with_legs(Vec::new());
short_target.id = "route-short".into();
short_target.target_headway_seconds = Some(60);

let mut long_target = route_with_legs(Vec::new());
long_target.id = "route-long".into();
long_target.target_headway_seconds = Some(300);

let mut no_target = route_with_legs(Vec::new());
no_target.id = "route-none".into();
no_target.target_headway_seconds = None;
```

Give each route a present stop/platform at a distinct position whose platform `route_ids` contains that route ID. Seed platform-servable Waiting trips:

```text
route-short: 60s wait     -> not at risk from target equality
route-short: 61s wait     -> at risk from past-target rule
route-short: 90s wait     -> at risk and longest
route-long: 181s wait     -> remaining patience 59s, at risk before 300s target
route-none: 200s wait     -> ignored by HPA-643 health
```

Also seed one `route-short` Waiting trip at a position with no serving platform; it must not contribute.

Assert:

```rust
assert_eq!(
    health.get("route-short"),
    Some(&WaitingHealth {
        waiting_at_risk_count: 2,
        longest_wait_seconds: Some(90.0),
    })
);
assert_eq!(
    health.get("route-long"),
    Some(&WaitingHealth {
        waiting_at_risk_count: 1,
        longest_wait_seconds: Some(181.0),
    })
);
assert_eq!(health.get("route-none"), None);
```

Run:

```bash
cargo test -p caelum-core waiting_health_counts_past_target_or_low_patience_platform_waiters
```

Expected initially: compile failure because the health helper/fields do not exist.

- [ ] **Step 2: Extend `ServiceMetrics` with required fields**

In `model.rs`:

```rust
pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub estimated_deployment_cost: Option<i32>,
    pub next_vehicle_cost: Option<i32>,
    pub nominal_headway_seconds: Option<f64>,
    pub waiting_at_risk_count: usize,
    pub longest_wait_seconds: Option<f64>,
}
```

Do not add `#[serde(default)]` to either new field.

- [ ] **Step 3: Add the private health aggregation in `service_control`**

Imports:

```rust
use std::collections::HashMap;

use crate::platforms::platform_waiters_by_line;
use crate::trips::elapsed_wait_seconds;
```

Add:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct WaitingHealth {
    waiting_at_risk_count: usize,
    longest_wait_seconds: Option<f64>,
}

fn waiting_health_by_line(state: &GameSnapshot) -> HashMap<String, WaitingHealth> {
    let targets: HashMap<&str, u32> = state
        .transit
        .routes
        .iter()
        .filter_map(|route| {
            route
                .target_headway_seconds
                .map(|target| (route.id.as_str(), target))
        })
        .chain(state.transit.metro_lines.iter().filter_map(|line| {
            line.target_headway_seconds
                .map(|target| (line.id.as_str(), target))
        }))
        .collect();

    let mut health = HashMap::new();
    for (line_id, waiters) in platform_waiters_by_line(state) {
        let Some(target) = targets.get(line_id.as_str()).copied() else {
            continue;
        };
        let mut line_health = WaitingHealth::default();
        for trip in waiters {
            let wait_seconds = elapsed_wait_seconds(trip);
            line_health.longest_wait_seconds = Some(
                line_health
                    .longest_wait_seconds
                    .map_or(wait_seconds, |longest| longest.max(wait_seconds)),
            );
            if wait_seconds > f64::from(target)
                || trip.patience_remaining <= f64::from(MIN_HEADWAY_SECONDS)
            {
                line_health.waiting_at_risk_count += 1;
            }
        }
        health.insert(line_id, line_health);
    }
    health
}
```

No target means no map entry and therefore neutral `WaitingHealth::default()` at publication.

- [ ] **Step 4: Thread `WaitingHealth` through existing Bus/Metro metrics**

Change the private `metrics(...)` signature to accept:

```rust
waiting_health: WaitingHealth,
```

Append to the existing `ServiceMetrics` constructor:

```rust
waiting_at_risk_count: waiting_health.waiting_at_risk_count,
longest_wait_seconds: waiting_health.longest_wait_seconds,
```

Update existing private unit-test calls to `metrics(...)` with `WaitingHealth::default()` unless the test is specifically about HPA-643.

In `populate_snapshot_metrics` derive before mutable loops:

```rust
let flow = crate::traffic::derive_road_flow(snapshot);
let waiting_health = waiting_health_by_line(snapshot);
```

Then for each Bus route / Metro line:

```rust
let health = waiting_health.get(&route.id).copied().unwrap_or_default();
```

and pass `health` into `metrics(...)`.

Do not change the existing `route.active && !snapshot.paused` input used for HPA-628 `next_vehicle_cost`.

- [ ] **Step 5: Update every direct Rust `ServiceMetrics` literal**

Before compiling, enumerate current literals:

```bash
rg -n "ServiceMetrics \{" crates/caelum-core
```

For neutral literals add:

```rust
waiting_at_risk_count: 0,
longest_wait_seconds: None,
```

This includes the forged direct-restore `ServiceMetrics` in `crates/caelum-core/tests/service_control.rs`. Do not leave any literal to be fixed by adding serde defaults.

- [ ] **Step 6: Update the exact camelCase wire expectation**

In `crates/caelum-core/tests/model_wire_format.rs`, update the exact derived output object:

```rust
assert_eq!(
    value["serviceMetrics"],
    json!({
        "roundTripSeconds": 600.0,
        "assignedFleet": 2,
        "requiredFleet": 3,
        "estimatedDeploymentCost": null,
        "nextVehicleCost": null,
        "nominalHeadwaySeconds": 300.0,
        "waitingAtRiskCount": 0,
        "longestWaitSeconds": null
    })
);
```

Forged incoming `serviceMetrics` JSON can remain partial because the entire field is skipped on deserialization; the required-field contract applies to Rust-produced non-null output, not ignored forged input.

- [ ] **Step 7: Add Bus/Metro output and save-omission assertions**

Extend existing service-metric output tests:

```rust
assert_eq!(metrics.waiting_at_risk_count, 0);
assert_eq!(metrics.longest_wait_seconds, None);
```

Add one valid Bus snapshot with a targeted platform waiter and assert serialized output:

```rust
assert_eq!(
    value["transit"]["routes"][0]["serviceMetrics"]["waitingAtRiskCount"],
    1
);
assert_eq!(
    value["transit"]["routes"][0]["serviceMetrics"]["longestWaitSeconds"],
    90.0
);
```

Add one equivalent Metro waiter assertion to prove the same shared path.

For a snapshot with positive health, assert save normalization still removes the entire field:

```rust
let saved_json = serde_json::to_value(engine.snapshot_for_save()).unwrap();
assert!(saved_json["transit"]["routes"][0]
    .get("serviceMetrics")
    .is_none());
```

- [ ] **Step 8: Replace causal boarding proof with bounded HPA-628 coexistence**

Reuse `shortfall_bus_engine()` only for what it already guarantees: a live HPA-628 shortfall.

Take `snapshot_for_save()`, add one persistence-valid Sim + Waiting Bus trip at `stop-001` whose current leg names `route-001`, and set:

```rust
patience_remaining: 59.0,
```

The trip is at risk regardless of the fixture's derived target because it has <= 60 seconds patience remaining. Restore and resume the engine.

Assert before top-up:

```rust
let snapshot = engine.snapshot();
let metrics = snapshot.transit.routes[0]
    .service_metrics
    .as_ref()
    .unwrap();
assert_eq!(metrics.waiting_at_risk_count, 1);
assert!(metrics.longest_wait_seconds.is_some());
assert_eq!(metrics.next_vehicle_cost, Some(BUS_COST));
```

Then dispatch:

```rust
let result = engine.dispatch(GameIntent::AddServiceVehicle {
    line_id: "route-001".into(),
});
assert!(result.applied, "existing HPA-628 top-up still applies: {result:?}");
```

Do **not** tick until boarding or patience expiry. Existing transit/platform tests own boarding correctness.

- [ ] **Step 9: Run the full Rust gate**

```bash
cargo fmt --all --check
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 10: Commit Rust health publication**

```bash
git add crates/caelum-core/src/model.rs \
        crates/caelum-core/src/service_control.rs \
        crates/caelum-core/tests/service_control.rs \
        crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat: derive route waiting risk"
```

---

### Task 3: Forward the required Rust fields through the TypeScript shell

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/runtime/snapshotView.test.ts`
- Modify neutral literal fallout: `tests/runtime/gameRuntime.test.ts`
- Modify neutral literal fallout: `tests/ui/appShell.test.ts`
- Modify neutral literal fallout: `tests/ui/linesPanel.test.ts`

**Interfaces:**
- Produces `ServiceMetrics.waitingAtRiskCount: number`.
- Produces `ServiceMetrics.longestWaitSeconds: number | null`.
- Produces matching `ShellServiceState` fields.
- `selectServiceState` forwards values only.

- [ ] **Step 1: Add a failing selector projection assertion**

In the existing route service fixture in `tests/runtime/runtimeSelectors.test.ts`, add:

```ts
waitingAtRiskCount: 2,
longestWaitSeconds: 95,
```

Then assert:

```ts
expect(route.service.waitingAtRiskCount).toBe(2);
expect(route.service.longestWaitSeconds).toBe(95);
```

Run:

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

Expected initially: type/selector failure because the fields are not defined or forwarded.

- [ ] **Step 2: Extend the domain and shell types as required fields**

In `src/domain/types.ts`:

```ts
export interface ServiceMetrics {
  roundTripSeconds: number;
  assignedFleet: number;
  requiredFleet: number | null;
  estimatedDeploymentCost: number | null;
  nextVehicleCost: number | null;
  nominalHeadwaySeconds: number | null;
  waitingAtRiskCount: number;
  longestWaitSeconds: number | null;
}
```

In `src/runtime/types.ts`:

```ts
export interface ShellServiceState {
  targetHeadwaySeconds: number | null;
  roundTripSeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  estimatedDeploymentCost: number | null;
  nextVehicleCost: number | null;
  nominalHeadwaySeconds: number | null;
  waitingAtRiskCount: number;
  longestWaitSeconds: number | null;
}
```

Do not make either field optional.

- [ ] **Step 3: Forward fields in `selectServiceState`**

Keep the existing projection and append:

```ts
waitingAtRiskCount: route.serviceMetrics?.waitingAtRiskCount ?? 0,
longestWaitSeconds: route.serviceMetrics?.longestWaitSeconds ?? null,
```

Do not add any risk calculation to TypeScript.

- [ ] **Step 4: Prove snapshot normalization forwards the object structurally**

In `tests/runtime/snapshotView.test.ts`, put non-neutral values in a raw Rust `serviceMetrics` fixture and assert:

```ts
expect(view.transit.routes[0].serviceMetrics).toMatchObject({
  waitingAtRiskCount: 3,
  longestWaitSeconds: 110,
});
```

Do not change `src/runtime/snapshotView.ts`; it already forwards `route.serviceMetrics ?? null`.

- [ ] **Step 5: Update the actual non-null TypeScript fixture fallout**

Add neutral values where the test is unrelated to health:

```ts
waitingAtRiskCount: 0,
longestWaitSeconds: null,
```

Update every non-null literal in:

```text
tests/runtime/runtimeSelectors.test.ts
tests/runtime/snapshotView.test.ts
tests/runtime/gameRuntime.test.ts
tests/ui/appShell.test.ts
tests/ui/linesPanel.test.ts
```

Verify the list rather than editing unrelated null fixtures:

```bash
rg -n "nextVehicleCost:" tests/runtime tests/ui
```

Do not touch `tests/helpers/gameState.ts`, `tests/render/transitRenderer.test.ts`, or `tests/render/overlayRenderer.test.ts` solely for HPA-643 required fields.

- [ ] **Step 6: Run runtime/type gates**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts tests/runtime/snapshotView.test.ts tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts tests/ui/linesPanel.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit TypeScript projection**

```bash
git add src/domain/types.ts \
        src/runtime/types.ts \
        src/runtime/runtimeSelectors.ts \
        tests/runtime/runtimeSelectors.test.ts \
        tests/runtime/snapshotView.test.ts \
        tests/runtime/gameRuntime.test.ts \
        tests/ui/appShell.test.ts \
        tests/ui/linesPanel.test.ts
git commit -m "feat: publish route waiting risk to shell"
```

---

### Task 4: Render one compact warning in the existing Lines row

**Files:**
- Modify: `src/components/hud/panels/LinesPanel.svelte`
- Test: `tests/ui/linesPanel.test.ts`

**Interfaces:**
- Consumes `route.service.waitingAtRiskCount` and `longestWaitSeconds` from Task 3.
- Consumes existing `nextVehicleCost` only to decide whether recovery copy accompanies the already-existing Add button.
- Adds no callback, intent, or controller method.

- [ ] **Step 1: Extend the existing Bus top-up test with positive health**

Use a genuinely deployed running row and add:

```ts
waitingAtRiskCount: 2,
longestWaitSeconds: 192,
nextVehicleCost: 12_500,
```

Assert:

```ts
const health = screen.getByTestId("route-health-route-bus-top-up");
expect(health).toHaveTextContent("2 riders at risk");
expect(health).toHaveTextContent("longest 3.2 min");
expect(health).toHaveTextContent("Add bus to recover");
expect(screen.getByRole("button", { name: "Add bus · $12,500" })).toBeVisible();
```

Keep the existing one-click callback assertion.

Run:

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
```

Expected initially: FAIL because the warning is not rendered.

- [ ] **Step 2: Extend the existing no-offer test**

For a running deployed Bus row:

```ts
waitingAtRiskCount: 1,
longestWaitSeconds: 150,
nextVehicleCost: null,
```

Assert:

```ts
const health = screen.getByTestId("route-health-route-bus-no-offer");
expect(health).toHaveTextContent("1 rider at risk");
expect(health).toHaveTextContent("longest 2.5 min");
expect(health).not.toHaveTextContent("recover");
expect(screen.queryByTestId("route-add-vehicle-route-bus-no-offer")).toBeNull();
```

- [ ] **Step 3: Render the two-clause warning**

Reuse existing `formatHeadway`. Inside the deployed service branch, after Target/Nominal/Fleet rows and before the Add vehicle button:

```svelte
{#if route.status.primary === "running" &&
  route.service.waitingAtRiskCount > 0}
  <p
    class="route-status-note"
    data-testid={`route-health-${route.id}`}
  >
    {route.service.waitingAtRiskCount}
    {route.service.waitingAtRiskCount === 1 ? "rider" : "riders"}
    at risk · longest {formatHeadway(route.service.longestWaitSeconds)}{#if route.service.nextVehicleCost !== null}. Add {route.mode === "metro" ? "train" : "bus"} to recover.{/if}
  </p>
{/if}
```

Do not add `assignedFleet > 0`; `running` already implies a non-empty fleet. Do not add a longest-wait null gate; positive Rust count implies an eligible waiter and therefore a longest wait.

Do not add `role="alert"` or `aria-live`.

- [ ] **Step 4: Add only the minimal hiding coverage**

Use one representative non-running fixture, for example `status.primary === "paused"`, with positive health and assert:

```ts
expect(screen.queryByTestId(`route-health-${routeId}`)).toBeNull();
```

Use one running fixture with:

```ts
waitingAtRiskCount: 0,
longestWaitSeconds: null,
```

and assert no warning.

Do not create a paused/broken/noFleet mirror matrix; `route.status.primary` is one selector contract already tested elsewhere.

- [ ] **Step 5: Extend the existing Metro top-up test with train recovery copy**

Add positive health and assert:

```ts
expect(screen.getByTestId("route-health-line-metro-top-up"))
  .toHaveTextContent("Add train to recover");
expect(screen.getByRole("button", { name: "Add train · $80,000" }))
  .toBeVisible();
```

No Metro-specific component or health formula.

- [ ] **Step 6: Run Svelte gates**

```bash
bun run test:unit -- tests/ui/linesPanel.test.ts
bun run check
bun run lint:svelte
```

Expected: PASS.

- [ ] **Step 7: Commit the Lines-row warning**

```bash
git add src/components/hud/panels/LinesPanel.svelte tests/ui/linesPanel.test.ts
git commit -m "feat: show riders at risk on lines"
```

---

### Task 5: Run repository-wide regression gates and verify scope

**Files:**
- No production file should change solely for this task.

**Interfaces:**
- Verifies Rust waiting semantics -> derived service output -> TypeScript projection -> Lines-row rendering while preserving HPA-628 behavior.

- [ ] **Step 1: Run Rust workspace gates**

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 2: Run the complete frontend/runtime unit suite**

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run existing browser regression suite**

```bash
bun run test:e2e
```

Expected: PASS. Do not add a synthetic HPA-643 browser setup merely to make a long waiter occur.

- [ ] **Step 4: Run quality/build gates**

```bash
bun run format:check
bun run check
bun run lint:svelte
bun run lint:css
bun run build
```

Expected: PASS.

- [ ] **Step 5: Inspect final scope**

```bash
git status --short
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  crates/caelum-core/src/trips.rs \
  crates/caelum-core/src/platforms.rs \
  crates/caelum-core/src/model.rs \
  crates/caelum-core/src/service_control.rs \
  src/domain/types.ts \
  src/runtime/types.ts \
  src/runtime/runtimeSelectors.ts \
  src/components/hud/panels/LinesPanel.svelte
```

Expected production shape:

```text
1 shared elapsed-wait helper (trip-metric sites)
1 persisted per-leg wait counter on ActiveTrip (schema v9) + read helper
1 shared platform-eligible waiter aggregate (capacity-filtered)
2 required derived ServiceMetrics fields
1 private per-line risk aggregation
TypeScript projection only
1 existing-row warning
```

The persisted `ActiveTrip.current_leg_wait_seconds` field and schema v9 bump are the intended exception to the original "no persistence field / no schema bump" framing (see the corrective addendum). Anything else — a new intent, history buffer, generic finding type, headway maximum, passenger-patience change, arbitrary fleet-growth rule, dashboard component, or second pause state — is out of scope and should be removed before review.

- [ ] **Step 6: Record actual verification in the draft PR**

Update PR #49 with the commands actually run and their results. Keep the PR draft until implementation and all required gates pass.
