# HPA-624 Bus Headway and Initial Fleet Deployment Design

**Linear:** HPA-624  
**Parent:** HPA-334  
**Depends on:** HPA-622

## Goal

Deliver the first Phase 4 service-control loop for **bus routes only**:

> A valid bus route can exist with zero buses. Before service starts, the player sets one constant target headway. Caelum derives the required fleet from the route's current congestion-aware cycle time, then one explicit action buys and deploys that initial fleet at deterministic time-spaced positions. The existing Lines panel shows the target, nominal headway, and assigned fleet without introducing a fleet-management screen.

This is intentionally smaller than a timetable or fleet-management system. It proves that route geometry and service operation are separate concepts before adding service periods, holding/bunching, fleet top-ups or withdrawal, or Metro service planning.

## Existing seams to reuse

The repository already has the required boundaries:

- `route_editor::create_route_costed` validates route geometry and currently couples creation to the first vehicle purchase.
- `transit::initial_vehicle` creates the existing bus cursor shape.
- `transit::assign_vehicle_costed` remains the existing low-level unspaced add used by core tests.
- `Route.legs` is the cyclic itinerary used by live vehicle movement for both loop and shuttle services.
- HPA-622's `traffic::RoadFlow` is the live road-load input.
- `transit::vehicle_step_seconds` is the exact live per-step timing rule once made `pub(crate)`.
- `transit::tick_vehicles` advances `Vehicle.itinerary_index`, `path_step_index`, and `step_progress` over those same paths.
- `route_lifecycle::rebase_edited_route_vehicles_and_riders` already keeps vehicle cursors valid after structural edits.
- `router::active_services` decides whether a route can be used by passenger planning.
- `GameEngine::snapshot()` is the common authoritative snapshot returned through both WASM and Tauri hosts.
- `persistence::normalize_derived_fields` already clears/rebuilds derived state rather than trusting serialized caches.
- `runtimeSelectors.ts` and `LinesPanel.svelte` already own route-row presentation and controls.

Reuse those seams. Do not add a scheduler service, fleet repository, operations dashboard, generic `ServicePlan`, new `GameBackend` method, or TypeScript timing engine.

## Bus first; Metro unchanged

HPA-334 asks the first vertical slice to prove one route type. Buses are the right first type because HPA-622 just made bus travel time congestion-aware.

Only **new bus routes** stop receiving an implicit first vehicle:

- Bus create: validate topology, assign platforms, insert active route with `vehicle_ids = []`, charge no vehicle cost.
- Metro create: preserve the current initial Metro vehicle and vehicle cost.

Route editing remains structural. HPA-624 must not buy/delete buses or re-space a fleet to the target headway during an edit. It **must preserve** the existing structural rebase. `update_route` already calls `rebase_edited_route_vehicles_and_riders` after structural change; buses may therefore be parked/repositioned and have their cursors reset so the new itinerary stays safe.

After such an edit, the fleet may be bunched and its nominal headway may no longer match the target. That is visible but not automatically corrected in HPA-624.

## Persist only the target headway

Add one required-nullable bus-only field to `Route`:

```rust
pub struct Route {
    // existing fields
    #[serde(deserialize_with = "deserialize_required_option")]
    pub target_headway_seconds: Option<u32>,
}
```

TypeScript mirrors it as:

```ts
export interface Route {
  // existing fields
  targetHeadwaySeconds: number | null;
}
```

`null` means service has not been configured. Do not add the field to `MetroLine`, and do not create `ServicePlan`, service bands, timetable objects, or vehicle-class configuration.

## Schema v7 is one direct development break

The required `Route.targetHeadwaySeconds` wire key bumps disposable development saves from v6 to v7.

Update current behavior in the same schema task:

- Rust `SNAPSHOT_SCHEMA_VERSION = 7`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 7`;
- IndexedDB default database `caelum-city-saves-v7`, version `7`;
- native application-data directory `cities-v7`;
- `GameEngine::from_snapshot` documentation;
- active runtime/backend comments, tests, fixtures, and `docs/architecture.md` that describe v6.

Old development cities disappear. Do not add migration, fallback namespaces, aliases, dual readers, or serde defaults for the required target field. Historical specs/plans remain historical and do not need rewriting.

## Rust owns all service timing and fleet math

Do **not** add `src/domain/busService.ts` and do not port congestion/timing behavior into TypeScript.

The Lines panel needs live service numbers, but Rust already owns the only correct timing semantics. Expose those numbers as **runtime-derived, non-authoritative output** on the bus `Route` rather than computing them a second time in TypeScript.

Add a small serializable view type in the Rust model:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub nominal_headway_seconds: Option<f64>,
}
```

and one derived field on bus `Route`:

```rust
#[serde(
    skip_deserializing,
    default,
    skip_serializing_if = "Option::is_none"
)]
pub service_metrics: Option<BusServiceMetrics>,
```

This field is not persisted authority:

1. internal authoritative `GameEngine.snapshot` keeps `service_metrics = None`;
2. `GameEngine::snapshot()` clones the authoritative snapshot, derives `RoadFlow` once, fills bus `service_metrics`, and returns that clone to WASM/Tauri;
3. serde ignores any incoming `serviceMetrics` value and defaults it to `None`;
4. `normalize_derived_fields` also clears `service_metrics` so direct Rust `GameSnapshot` restoration cannot smuggle stale values into authority;
5. `snapshot_for_save()` runs the existing normalization after `snapshot()`, so the field is cleared and omitted from persisted saves.

This keeps the existing nine-method host boundary and makes TypeScript presentation a pass-through rather than a second implementation of transport behavior.

Canonical TypeScript `Route` uses:

```ts
export interface BusServiceMetrics {
  roundTripSeconds: number;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}

export interface Route {
  // existing fields
  targetHeadwaySeconds: number | null;
  serviceMetrics: BusServiceMetrics | null;
}
```

The raw Rust snapshot type may receive `serviceMetrics` as missing/undefined for routes where Rust cannot derive metrics; `normalizeRustSnapshot` canonicalizes that to `null`.

## Headway policy

Add one bus-specific intent:

```rust
GameIntent::SetBusTargetHeadway {
    route_id: String,
    target_headway_seconds: u32,
}
```

Use one small authoritative floor:

```rust
pub const MIN_BUS_HEADWAY_SECONDS: u32 = 60;
```

Rules:

- route must be an existing bus route;
- target must be at least 60 seconds;
- no arbitrary upper bound is needed in this slice;
- target change does not bump route `revision`;
- target can be changed only while `vehicle_ids` is empty;
- once any bus is assigned, HPA-624 treats headway as configured service setup and does not offer a resize workflow.

Use `InvalidHeadway` for values below the floor. If a stale/dev request tries to change the target after fleet assignment, reuse `FleetAlreadyAssigned`; do not add another lifecycle state just for this setup-only rule.

The Lines input uses whole minutes with `min=1` and `step=1`, but Rust remains authoritative.

## Current bus cycle time

For a connected bus route, calculate one complete cycle by walking the existing cyclic `Route.legs` and summing every **current path step** through the same helper live buses use:

```rust
transit::vehicle_step_seconds(flow, TransitMode::Bus, step)
```

Do not use `traffic::effective_road_path_seconds` for cycle math. That helper intentionally preserves a stored total for an empty synthetic road path, while live vehicle movement skips zero-step legs.

Cycle rules:

- every required leg must have `current_path` or metrics are unavailable;
- use `current_path` only;
- ignore `last_valid_path`;
- ignore cached `estimated_seconds`;
- skip non-positive effective step durations.

Put this logic in one small `bus_service.rs` module rather than growing `transit.rs` further.

### Loop and shuttle semantics

The same cyclic walk covers loop and shuttle routes. Reversal legs follow live cursor semantics:

- empty terminal reversal: `0s`;
- in-place U-turn: its actual timed road step;
- multi-step roundabout/junction reversal: every effective current-path step.

Lock a shared Rust test vector:

```text
outbound road step      100s
empty reversal            0s
return road step        200s
U-turn reversal            2s
--------------------------------
cycle                    302s
```

With flow `8` on the outbound point and existing capacity `4`, the outbound step is `2.0x`, producing a `402s` cycle.

There is no corresponding TypeScript vector because TypeScript no longer implements this behavior.

## Required fleet and nominal headway

Before deployment, when a target exists and cycle time is positive:

```text
required fleet = max(1, ceil(roundTripSeconds / targetHeadwaySeconds))
```

After buses exist, expose the deterministic count-based estimate:

```text
nominal headway = roundTripSeconds / assignedFleet
```

Call it **Nominal**, not Current/Actual. It does not measure departures and can differ from real spacing after route edits or congestion changes. This avoids promising bunching measurement before such a feature exists.

If assigned fleet is zero, nominal headway is unavailable.

## Zero fleet means no passenger service

A route can be active and connected while `vehicle_ids = []`. It stays editable and visible, but passengers must not plan journeys on a service that cannot arrive.

Keep `route_lifecycle::is_route_operational(active, legs)` structural. Narrow only the bus branch of `router::active_services`:

```text
bus passenger service
= structurally operational
AND vehicle_ids is not empty
```

Metro behavior is unchanged.

Lines status precedence:

1. broken -> Broken;
2. inactive -> Paused;
3. active connected bus with zero fleet -> No fleet;
4. otherwise -> Running.

`No fleet` is display-only.

## `AssignVehicle` remains a low-level engine/test seam

Keep `GameIntent::AssignVehicle` unchanged.

- Existing core fixtures use it to add an unspaced bus explicitly.
- It has no player-facing Lines-panel control today; HPA-624 does not add one.
- A bus added this way makes a structurally valid route passenger-service eligible.
- If it is used before deployment, `DeployBusFleet` rejects with `FleetAlreadyAssigned`.
- If it is used before target setup, `SetBusTargetHeadway` also rejects because HPA-624 does not retrofit service setup onto an already-running low-level fixture route.

This preserves test/dev behavior without turning `AssignVehicle` into the product fleet workflow.

## One-shot initial fleet deployment

Add:

```rust
GameIntent::DeployBusFleet {
    route_id: String,
}
```

Preconditions:

- bus route exists;
- route is active and all legs are connected;
- target headway is set and at least 60 seconds;
- route has zero assigned buses;
- current cycle time is derivable and positive.

Use existing route errors plus `HeadwayNotSet` and `FleetAlreadyAssigned`.

Deployment is deliberately one-shot. **Do not expand it into a top-up/resizing command in HPA-624.** Vehicle addition/withdrawal after service starts belongs to later HPA-334 expansion work.

### Atomic cost

Derive required fleet once from one current `RoadFlow`, then quote:

```text
requiredFleet * BUS_COST
```

through `CostPolicy` with checked integer conversion/multiplication.

Standard either buys the whole initial fleet or changes nothing. Creative remains free through the same policy. Do not add purchase inventory.

### Deterministic time spacing

For required fleet `N`, vehicle `i` gets cycle offset:

```text
offset(i) = roundTripSeconds * i / N
```

Resolve that offset across the same current path steps and effective durations used by cycle math. Initialize only:

```text
Vehicle.itinerary_index
Vehicle.path_step_index
Vehicle.step_progress
```

Skip zero-step/zero-duration legs. Create vehicle IDs in stable order through the existing `initial_vehicle`/`next_entity_id` seam.

Shuttle spacing regression: cycle `302s`, `N=2`, second bus offset `151s`. After `100s` outbound and the empty reversal, it lands `51s` into the `200s` return step, so `step_progress = 0.255`.

Later traffic changes alter live travel time and the nominal headway but do not re-space buses. Buses still do not contribute to HPA-622 `RoadFlow`.

## Structural edits after deployment

Preserve existing route-edit rebase behavior:

- structural edits may park/reposition buses to keep cursors valid;
- they do not add/delete buses;
- they do not preserve or reconstruct initial spacing;
- they do not run deployment again;
- target headway remains the configured target.

After an edit, the Lines row shows the same target plus the newly derived nominal headway and assigned fleet. No required-fleet mismatch is presented as an actionable control after deployment.

## Route preview and creation budget

Keep `RoutePreviewResponse.initialVehicleCost`/`affordable` because Metro still buys one vehicle at route creation.

- New bus preview: `initialVehicleCost = 0`; bus purchase budget cannot block Save.
- New Metro preview: keep current Metro cost/affordability behavior.
- Route edit: existing zero creation cost.

The existing selector test that says an unaffordable **bus** draft needs `$8,000` becomes unreachable once bus creation costs zero. Re-point that test to a Metro draft rather than keeping a misleading stub-only bus case.

## Lines-panel UX

Extend the existing bus row only.

### Before deployment

```text
No fleet
Target      6 min
Required    3 buses
[ 6 ] min [Set]
[Deploy 3 buses]
```

Rules:

- input is whole minutes, `min=1`, `step=1`;
- Set dispatches seconds;
- Deploy appears/enables only when route is active, connected, zero-fleet, target is set, and Rust-derived `requiredFleet` exists;
- the button label uses Rust's `serviceMetrics.requiredFleet`, so the count shown is the count Rust will buy.

### After deployment

```text
Target      6 min
Nominal     5.8 min
Fleet       3
```

Do not show an editable headway field, Deploy button, or `assigned / required` mismatch after service starts. HPA-624 has no player action that could reconcile such a number.

Metro rows remain unchanged. `AssignVehicle` gets no player-facing button.

## Test strategy

### Schema/contract

- v7 requires `targetHeadwaySeconds` on bus `Route`;
- current v6 namespaces/comments are updated in one task;
- no migration reader exists.

### Rust service math/output

- `600/300 -> 2`, `601/300 -> 3`;
- target unset -> required fleet unavailable;
- 302s shuttle and 402s congested shuttle vectors;
- `GameEngine::snapshot()` exposes derived metrics;
- forged/deserialized `serviceMetrics` is ignored/cleared;
- `snapshot_for_save()` omits derived service metrics;
- zero-fleet bus is excluded from passenger routing; one low-level `AssignVehicle` makes it eligible.

### Deployment

- target below 60s -> `InvalidHeadway`;
- target cannot change after any fleet exists;
- missing target -> `HeadwayNotSet`;
- Standard fleet purchase is atomic; Creative is free;
- second deployment -> `FleetAlreadyAssigned`;
- unequal-loop and shuttle offsets produce deterministic cursors;
- structural edit preserves existing rebase but does not resize/re-space.

### Fixture migration

Fleet-free bus creation changes many existing tests that used route creation as implicit service startup. The implementation task that removes the first bus must also migrate those fixtures:

- tests that need live bus service explicitly call existing `AssignVehicle`;
- geometry/editor tests that do not need service keep zero fleet;
- `tests/e2e/routes.spec.ts` stops protecting the old implicit-vehicle behavior and instead asserts route creation is fleet-free;
- the new HPA-624 smoke owns the real Set -> Deploy -> running-service path.

Do not postpone this migration to final verification.

### Granularity

Put the deployed-fleet coarse-vs-fine regression in `crates/caelum-core/tests/golden_sequences.rs`, beside the existing granularity-independence guards. Do not create a duplicate invariant test elsewhere.

## Explicit non-goals

- Metro headway/service planning.
- TypeScript congestion/service timing math.
- Service bands or arbitrary timetables.
- Measured/actual departure headway or history.
- Layover, holding, bunching detection/recovery.
- Fleet top-up, withdrawal, reassignment, auto-resize, or post-deployment headway editing.
- Depots, crews, maintenance, breakdowns, vehicle inventory.
- Generic service/fleet/scheduler abstractions.
- Route visibility/map-layer framework.
- Save migration/backward compatibility/recovery.

## Alternatives rejected

### TypeScript service-metrics port

Rejected. It would be the first production behavioral mirror of congestion-aware timing and would make a player-visible deployment count depend on math separate from the Rust purchase/placement logic. Rust-derived snapshot output is smaller and keeps one source of truth without adding a backend method.

### Incremental/top-up `DeployBusFleet`

Rejected for HPA-624. It would make the first slice a repeatable vehicle-add workflow and still would not solve spacing of existing buses without a re-spacing/holding policy. The lean slice treats target as pre-service configuration, deploys once, and shows only target/nominal/assigned values afterward.

### Generic `ServicePlan`

Rejected until Metro or a second service period demonstrates real duplication.

### Timetable/departure scheduler

Rejected. Target + initial time spacing proves the service-control loop without a new scheduling subsystem.

### Automatic re-spacing/resizing

Rejected. It immediately requires purchase/withdrawal rules and passenger-safe adjustment that HPA-334 explicitly leaves for later operational depth.
