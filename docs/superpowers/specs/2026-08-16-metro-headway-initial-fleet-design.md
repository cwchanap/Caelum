# HPA-626 Metro Headway and Initial Fleet Deployment Design

**Linear:** HPA-626  
**Parent:** HPA-334  
**Follows:** HPA-624

## Goal

Extend the proven HPA-624 service-control loop to Metro without introducing a timetable, fleet manager, or persisted `ServicePlan`:

> A valid Metro line can exist with zero trains. Before service starts, the player sets one constant target headway. Rust derives the required train count, estimated deployment cost, and deterministic initial placement from the line's live track itinerary. One explicit Deploy action buys the whole initial fleet atomically. The existing Lines row shows the same service setup for Bus and Metro.

The product model becomes consistent for both supported transit modes:

```text
create route geometry -> zero fleet
set target headway     -> no cost
deploy initial fleet   -> atomic vehicle purchase
run service            -> read-only target / nominal / fleet
```

No post-deployment resize, withdrawal, timetable, holding, or bunching workflow enters this slice.

## Why this is the next Phase 4 slice

HPA-624 already delivered for Bus:

- fleet-free route creation;
- one pre-deployment target headway;
- Rust-derived cycle time, required fleet, and nominal headway;
- deterministic one-shot initial deployment;
- zero-fleet passenger-routing exclusion;
- one compact Lines-row setup flow.

Metro is the remaining route type with an implicit first vehicle. That asymmetry is now a concrete second consumer for the narrow HPA-624 seams. Generalizing those seams is justified; a richer service-planning architecture is not.

## Existing seams to reuse

Reuse the current code rather than adding parallel abstractions:

- `Route` and `MetroLine` already share `legs`, `vehicle_ids`, `active`, `pattern`, `revision`, and `path_broken`.
- `RouteLegPath` is already the common cyclic itinerary representation.
- `transit::vehicle_step_seconds` already applies congestion to Bus road steps and falls through to the step's own travel time for Metro.
- `transit::initial_vehicle` and `transit::vehicle_cost` already support Bus and Metro.
- `CostPolicy` already owns Standard vs Creative charging.
- `route_lifecycle::is_route_operational` remains the structural route test.
- `router::active_services` remains the passenger-service eligibility boundary.
- `GameEngine::snapshot()` remains the shared WASM/Tauri output path.
- persistence normalization already clears derived Bus service metrics.
- `runtimeSelectors.ts` and `LinesPanel.svelte` already own the Bus service presentation.

Do not unify `Route` and `MetroLine`. The remaining `stop_ids` / `station_ids` distinction still drives different platform, persistence, and routing seams, so collapsing the entities would be unrelated churn.

## Chosen architecture: one small `service_control` module

Rename HPA-624's Bus-only module at the start of the work:

```text
crates/caelum-core/src/bus_service.rs
-> crates/caelum-core/src/service_control.rs
```

Generalize only the pieces that now have two real consumers:

1. `ServiceMetrics` output shape;
2. live cycle-time walk over `RouteLegPath` × resolved `TransitMode` × `RoadFlow`;
3. required-fleet formula;
4. deterministic time-offset cursor placement;
5. target/deployment mutation;
6. thin runtime/UI service presentation.

Do not add a route trait, unified route entity, strategy registry, scheduler, fleet repository, or Metro-specific copy.

## Product service intents are keyed by line ID only

Follow the existing product-level route-intent convention. Route IDs are namespaced (`route-NNN` vs `metro-NNN`), and existing route operations resolve by ID rather than requiring the caller to repeat the mode.

Use:

```rust
GameIntent::SetServiceTargetHeadway {
    line_id: String,
    target_headway_seconds: u32,
}

GameIntent::DeployInitialFleet {
    line_id: String,
}
```

TypeScript follows serde camelCase:

```ts
| {
    type: "setServiceTargetHeadway";
    lineId: string;
    targetHeadwaySeconds: number;
  }
| {
    type: "deployInitialFleet";
    lineId: string;
  }
```

Runtime methods are also line-ID-only:

```ts
setServiceTargetHeadway(
  lineId: string,
  targetHeadwaySeconds: number,
): RuntimeCommandResult;

deployInitialFleet(lineId: string): RuntimeCommandResult;
```

Inside `service_control`, find the ID in `transit.routes` first, then `transit.metro_lines`, derive `TransitMode` from the owning collection, and feed that mode to shared timing/cost helpers. If neither collection owns the ID, return `RouteNotFound`.

Do not expose a `TransitMode::Walk` branch in this product API. `AssignVehicle { mode, line_id }` remains unchanged as the low-level dev/test seam and is not a precedent for player product commands.

## Minimal persisted authority on both route types

Keep HPA-624's authority split:

- persisted authority: target headway;
- derived output: cycle time, assigned fleet, required fleet, estimated deployment cost, nominal headway.

Rename the Bus-specific metric type to:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub estimated_deployment_cost: Option<i32>,
    pub nominal_headway_seconds: Option<f64>,
}
```

`Route` keeps its existing target/metrics wire keys and changes only the metric type name. Add the same required-nullable target and serialize-only metrics to `MetroLine`:

```rust
#[serde(deserialize_with = "deserialize_required_option")]
pub target_headway_seconds: Option<u32>,

#[serde(
    skip_deserializing,
    default,
    skip_serializing_if = "Option::is_none"
)]
pub service_metrics: Option<ServiceMetrics>,
```

Canonical TypeScript mirrors these fields on both route types.

Do not persist `ServiceMetrics` and do not add a nested `ServicePlan` object.

## Schema v8 is a direct development break

`MetroLine.targetHeadwaySeconds` is a new required wire key, so move directly from v7 to v8:

- Rust `SNAPSHOT_SCHEMA_VERSION = 8`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 8`;
- IndexedDB database `caelum-city-saves-v8`, version `8`;
- native application-data directory `cities-v8`;
- active engine/backend comments, tests, and `docs/architecture.md` updated in the same task.

Development saves are disposable. Add no migration, fallback namespace, dual reader, alias, or serde default for the required target key.

`CLAUDE.md` currently carries a stale literal schema number. Remove the literal number instead of changing it to another value that will drift again. Its guidance should say that `crates/caelum-core/src/model.rs::SNAPSHOT_SCHEMA_VERSION` is authoritative.

## Restore validation carries the existing 60-second invariant to Metro

HPA-624 already rejects a persisted Bus target below the authoritative floor before the snapshot becomes engine state. Metro receives the same field, so it must receive the same restore invariant.

Rename the constant once, at the beginning of Task 1:

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;
```

Both Bus and Metro restore validation reference `service_control::MIN_HEADWAY_SECONDS`.

For a non-null Metro target below the floor:

- return existing `PersistenceError::InvalidNumericValue`;
- entity is `EntityKind::MetroLine`;
- field is existing `SnapshotField::RouteTargetHeadway`;
- reason is existing `NumericError::OutOfRange`;
- exactly `60` remains valid.

Do not add a Metro-specific snapshot field, persistence error, or duplicate constant.

## Derived metrics remain non-authoritative

`GameEngine` authoritative state keeps `service_metrics = None` for both collections.

`GameEngine::snapshot()`:

1. clones authoritative state;
2. derives `RoadFlow` once;
3. fills `ServiceMetrics` for Bus and Metro on the output clone;
4. returns that clone to WASM/Tauri.

Serde ignores incoming `serviceMetrics`; persistence normalization clears metrics from both collections; `snapshot_for_save()` therefore omits them.

TypeScript only normalizes missing/undefined values to `null`, formats them, and dispatches commands. It does not calculate timing, fleet count, or vehicle cost.

## Current cycle time uses live movement semantics

Use one shared walk:

```rust
fn round_trip_seconds(
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
) -> Option<f64> {
    let mut total = 0.0;
    for leg in legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            let seconds = transit::vehicle_step_seconds(flow, mode, step);
            if seconds > 0.0 {
                total += seconds;
            }
        }
    }
    (total.is_finite() && total > 0.0).then_some(total)
}
```

Rules:

- use `current_path` only;
- ignore `last_valid_path` and cached `estimated_seconds`;
- every required leg needs a current path;
- skip non-positive step durations;
- empty reversal legs contribute zero;
- timed reversals contribute their live step times.

Bus continues to see current road congestion. Metro automatically uses fixed track step time through the existing `vehicle_step_seconds` fallback. There is no Metro timing implementation in TypeScript or a second Rust walker.

## Required fleet, nominal headway, and estimated deployment cost

For either mode:

```text
required fleet = max(1, ceil(roundTripSeconds / targetHeadwaySeconds))
```

Before deployment, Rust also exposes an informational estimate:

```text
estimated deployment cost = requiredFleet * vehicle_cost(mode)
```

Use checked integer conversion/multiplication; expose `null` if a safe quote cannot be represented. Creative still displays the nominal vehicle purchase value because the row is describing required assets; actual Creative deduction remains zero through `CostPolicy`.

After fleet exists:

```text
nominal headway = roundTripSeconds / assignedFleet
```

Call it **Nominal**, never Current/Actual.

The deployment estimate is snapshot-derived and can change if the live cycle changes before dispatch. The UI must make that clear; Rust recomputes the authoritative required fleet and cost at deployment time.

## Deterministic initial placement stays shared

For required fleet `N`, vehicle `i` starts at:

```text
offset(i) = roundTripSeconds * i / N
```

Resolve that offset across the same current steps and `vehicle_step_seconds` durations used by cycle math. Initialize only:

- `Vehicle.itinerary_index`;
- `Vehicle.path_step_index`;
- `Vehicle.step_progress`.

Use existing `initial_vehicle` / stable ID allocation. Skip zero-step and zero-duration legs.

Keep the existing Bus shuttle regression. Add a Metro unequal-step vector and a deployed-Metro coarse-vs-fine tick regression by extending the existing golden-sequence pattern.

## Atomic deployment cost

At dispatch, derive the owning mode from `line_id`, recompute current cycle and required fleet once, then quote:

```text
requiredFleet * vehicle_cost(mode)
```

through existing `CostPolicy`.

Standard buys the entire initial fleet or changes nothing. Creative remains free. Do not add vehicle inventory, purchase orders, depots, or refund machinery.

## Route creation becomes fleet-free for both modes

After HPA-626:

```text
Create Bus route   -> zero fleet, no vehicle cost
Create Metro line  -> zero fleet, no vehicle cost
```

`route_editor::create_route_costed` no longer needs the Metro-only initial vehicle branch.

Keep low-level `AssignVehicle` for fixtures that genuinely require a running vehicle. Geometry-only tests must not add a train simply to preserve an old `Running` label.

## Route preview vehicle affordability becomes dead and is deleted

Metro is the final consumer of route-creation vehicle affordability. Once Metro creation is fleet-free, remove:

- `RoutePreviewResponse.initial_vehicle_cost` / `initialVehicleCost`;
- `RoutePreviewResponse.affordable`;
- route-preview `WarningCode::InsufficientBudget` and its only warning producer;
- TypeScript `Need $...` route-draft presentation.

Do **not** remove ordinary `RejectionCode::InsufficientBudget`. Road-mutation preview still uses it for construction-budget failures.

Implementation sequencing may briefly neutralize the old route-preview affordability fields in the fleet-free creation commit so that intermediate commits stay behaviorally correct; the immediately following cleanup commit removes the dead fields. No compatibility path survives the task.

## Zero fleet means no passenger service for both modes

Keep structural lifecycle separate from service availability:

```text
passenger-eligible service
= is_route_operational(active, legs)
AND vehicle_ids is not empty
```

Apply that rule to Bus and Metro in `router::active_services`.

Lines status becomes mode-neutral:

1. broken -> Broken;
2. inactive -> Paused;
3. active + connected + zero fleet -> No fleet;
4. otherwise -> Running.

Known test retarget rule:

- geometry/repair test with zero fleet -> expect `No fleet`;
- test that actually needs movement/routing -> explicitly `AssignVehicle` or use Set -> Deploy when service control is under test.

## Thin shared Lines-row presentation

Rename `ShellBusServiceState` to `ShellServiceState`; every Bus/Metro route row carries the same service presentation.

Before deployment:

```text
No fleet
Target            6 min
Required          3 trains
Est. deploy cost  $150,000
[ 6 ] min [Set]
[Deploy fleet · est. $150,000]
```

For Bus, use `bus` / `buses`; for Metro, `train` / `trains`.

The UI displays Rust-provided `estimatedDeploymentCost`; it does not multiply `requiredFleet` by a duplicated TypeScript vehicle-cost constant.

After deployment:

```text
Target   6 min
Nominal  5.8 min
Fleet    3
```

No input, Deploy, Required, top-up, withdrawal, refund, or post-deployment target edit is shown.

## Structural edits after deployment remain unchanged

Existing route lifecycle continues to own edits, break/repair, parking, and cursor safety. Edits may reposition vehicles but do not:

- add/delete fleet;
- restore initial spacing;
- resize to the target;
- change the configured target.

Rust simply derives a new nominal headway from the changed route.

## Error handling

Reuse existing errors:

- missing ID -> `RouteNotFound`;
- target below 60 -> `InvalidHeadway`;
- deploy without target -> `HeadwayNotSet`;
- target change / second deploy after fleet exists -> `FleetAlreadyAssigned`;
- inactive -> `InactiveRoute`;
- disconnected / no positive cycle -> `DisconnectedLeg`;
- unaffordable complete fleet -> existing budget rejection.

No service-state enum or Metro-specific error family is added.

## Test strategy

### v8 contract and restore

Prove:

- schema is v8 in Rust/TypeScript/storage namespaces;
- `MetroLine.targetHeadwaySeconds` is required-nullable;
- forged derived metrics never become authority;
- Bus and Metro target `59` reject restore through `RouteTargetHeadway`;
- Bus and Metro target `60` restore;
- saved snapshots omit derived service metrics.

### Shared service math

Preserve Bus HPA-624 vectors and add Metro coverage for:

- current-path-only track cycle time;
- stale `last_valid_path` / `estimated_seconds` ignored;
- heavy `RoadFlow` does not change Metro cycle;
- shared required/nominal formula;
- Rust-derived estimated deployment cost;
- unequal-step deterministic placement.

### Creation, routing, deployment

Prove:

- Bus behavior stays unchanged;
- Metro creation is zero-fleet and costs no vehicle purchase;
- zero-fleet Metro is passenger-ineligible;
- explicit low-level `AssignVehicle` makes unrelated routing fixtures live;
- Metro Set -> Deploy works by line ID with no mode parameter;
- Standard deployment is atomic;
- Creative deduction is zero;
- second deploy rejects;
- deployed Metro remains granularity-independent.

### Route preview cleanup

Prove route preview contains no vehicle-cost/affordability fields or route-only budget warning. Keep topology, revision, route failure, and road-mutation budget tests.

### UI/runtime

Prove:

- zero-fleet Bus and Metro show `No fleet`;
- both share Target/Required/estimated-cost/Set/Deploy UI;
- runtime commands carry only line ID (+ target where relevant);
- UI performs no timing/fleet/cost formula;
- deployed rows show Target/Nominal/Fleet only.

### Browser/WASM composition

Use the existing Metro layout helpers. Provision test budget explicitly before deployment, choose a target that gives a deterministic required count, assert the Rust-derived required count and estimated cost shown by the UI, Deploy, then Resume and verify the clock advances.

The existing Metro station-repair geometry E2E should finish at `No fleet`, not add a train to preserve the old label.

## Non-goals

HPA-626 does not add:

- post-deployment headway editing;
- fleet top-up, withdrawal, reassignment, refund, or auto-resize/re-spacing;
- peak/off-peak/night bands or closed periods;
- stop-by-stop timetables;
- departure history / actual-headway metrics;
- holding, bunching detection, or recovery;
- depots, crews, maintenance, breakdowns, or vehicle variants;
- route visibility/map-layer controls;
- persisted `ServicePlan`, scheduler, fleet manager, or route trait hierarchy;
- save migration/backward compatibility.

## Success criteria

HPA-626 is complete when:

1. new Bus and Metro routes both begin with zero fleet and no route-creation vehicle purchase;
2. both modes use one line-ID-keyed pre-deployment Target -> Required -> Deploy flow;
3. Rust owns timing, fleet count, estimated/current deploy cost, placement, and restore validity;
4. persisted Bus/Metro targets below 60 seconds reject restore;
5. zero-fleet Bus/Metro lines are passenger-ineligible and display `No fleet`;
6. the shared UI shows the Rust-derived estimated deployment cost before the irreversible one-shot purchase;
7. Bus HPA-624 behavior remains green;
8. route-preview vehicle affordability is deleted without touching road-preview budget rejection;
9. schema/storage is v8 with no compatibility path;
10. a real Metro line can be configured, deployed, and run through the shared Lines panel.