# HPA-626 Metro Headway and Initial Fleet Deployment Design

**Linear:** HPA-626  
**Parent:** HPA-334  
**Follows:** HPA-624

## Goal

Extend the proven HPA-624 service-control loop to the remaining supported transit mode without turning Phase 4 into a timetable or fleet-management project:

> A valid Metro line can exist with zero trains. Before service starts, the player sets one constant target headway. Caelum derives the required train count from the line's current live track cycle time, then one explicit action buys and deploys that initial fleet at deterministic time-spaced positions. The existing Lines panel shows Target, Required, Nominal, and Fleet for both Bus and Metro.

The important architectural result is smaller than a generic service-planning system: **route geometry is free to exist without service fleet for both current route types**. Once that is true, route creation, route preview, passenger eligibility, and the Lines UI all have one consistent mental model.

## Why this is the next actionable Phase 4 slice

HPA-624 completed the first HPA-334 vertical slice for Bus. Main now has:

- zero-fleet Bus creation;
- a pre-deployment target headway;
- Rust-derived required fleet and nominal headway;
- deterministic one-shot Bus deployment;
- zero-fleet Bus exclusion from passenger routing;
- one compact Lines-row setup flow.

Metro is the remaining supported route type with the old coupled model: creating a Metro line still buys and inserts its first train. It therefore cannot use the service-control loop and remains the sole reason route preview still carries initial-vehicle affordability state.

That makes Metro parity a better next slice than service bands, holding, bunching, withdrawal, or a fleet screen. Those later features would add new concepts before the existing two route types even share the same basic service-start model.

## Existing seams to reuse

The repository already contains almost everything this slice needs:

- `route_editor::create_route_costed` owns route/line creation and currently contains the Bus/Metro first-vehicle asymmetry.
- `transit::initial_vehicle` creates either Bus or Metro vehicles with the same cursor shape.
- `transit::assign_vehicle_costed` is the existing low-level Bus/Metro fixture seam and stays available.
- `Route.legs` and `MetroLine.legs` both use the same `RouteLegPath` cyclic itinerary.
- `transit::vehicle_step_seconds` already expresses the exact live timing rule for both modes: Bus road steps use HPA-622 congestion; Metro steps use their track travel time.
- `transit::tick_vehicles` advances both modes through `itinerary_index`, `path_step_index`, and `step_progress`.
- `route_lifecycle` already handles structural rebase, break, repair, and vehicle parking for both modes.
- `router::active_services` is the passenger-routing eligibility boundary.
- `GameEngine::snapshot()` is the common output path for WASM and Tauri.
- persistence normalization already clears non-authoritative Bus service metrics.
- `runtimeSelectors.ts` and `LinesPanel.svelte` already own route-row state and the Bus setup controls.

Reuse these boundaries. Do not add another backend method, a scheduler process, a persisted service-plan object, a fleet repository, a timetable model, or a route trait hierarchy.

## Alternatives considered

### A. One small mode-aware service-control seam — recommended

Promote the HPA-624 Bus-only helpers into one shared `service_control` module now that there are two concrete consumers.

Share only:

- service metric shape;
- current-leg cycle-time walking;
- required-fleet formula;
- deterministic offset-to-cursor resolution;
- target validation and one-shot initial deployment;
- snapshot metric population;
- thin runtime/UI presentation shape.

Mode-specific behavior remains explicit through `TransitMode` and existing constants/functions. Bus naturally receives road congestion through `vehicle_step_seconds`; Metro naturally does not. Bus cost remains `BUS_COST`; Metro cost remains `METRO_COST`.

This removes real duplication without inventing a framework. It is the best fit for KISS/YAGNI now that there are exactly two users of the same behavior.

### B. Copy HPA-624 into a separate Metro module

Add `metro_service.rs`, `SetMetroTargetHeadway`, `DeployMetroFleet`, `ShellMetroServiceState`, and duplicate the Lines UI branch.

This would be slightly faster for the first few edits but would leave two copies of the same formula, cursor spacing, validation, snapshot output, runtime commands, and UI flow. The divergence risk is immediate rather than hypothetical because both modes already share the same itinerary and vehicle cursor model.

Reject this option. The second concrete consumer is enough evidence to share these narrow seams.

### C. Introduce a persisted `ServicePlan` / scheduler abstraction

Create a generic service-plan entity with service bands, fleet policy, timetable state, or route-type implementations.

This anticipates future Phase 4 items that are explicitly not justified yet. It increases schema, validation, API, and UI surface before any second period, holding policy, or fleet-management need has been observed.

Reject this option. Keep one nullable target directly on each line type and revisit a richer model only when a second service-period case creates real duplication.

## Persist the same minimal authority on Bus and Metro

HPA-624 established a useful split:

- persisted authority: target headway;
- derived output: cycle time, assigned fleet, required fleet, nominal headway.

Keep that exact model for Metro.

Rename the Rust/TypeScript metric type from Bus-specific naming because it now has two real consumers:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMetrics {
    pub round_trip_seconds: f64,
    pub assigned_fleet: usize,
    pub required_fleet: Option<usize>,
    pub nominal_headway_seconds: Option<f64>,
}
```

The type rename itself has no wire key. The serialized object still appears as `serviceMetrics`.

`Route` keeps its existing fields, now typed as `Option<ServiceMetrics>`. Add the same required-nullable target and serialize-only derived output to `MetroLine`:

```rust
pub struct MetroLine {
    // existing fields
    #[serde(deserialize_with = "deserialize_required_option")]
    pub target_headway_seconds: Option<u32>,

    #[serde(
        skip_deserializing,
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub service_metrics: Option<ServiceMetrics>,
}
```

Canonical TypeScript mirrors the same shape on both `Route` and `MetroLine`.

`null` means service has not been configured. Do not introduce a `ServicePlan` property, service-band list, vehicle-class configuration, or nested policy object.

## Schema v8 is a direct development break

`MetroLine.targetHeadwaySeconds` is a new required wire key, so disposable development saves move directly from v7 to v8.

Update the active storage contract in one task:

- Rust `SNAPSHOT_SCHEMA_VERSION = 8`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 8`;
- IndexedDB default database `caelum-city-saves-v8`, version `8`;
- native application-data directory `cities-v8`;
- active engine/backend comments and tests;
- `docs/architecture.md`.

Old development saves disappear. Do not add migrations, fallback namespaces, aliases, optional compatibility readers, or serde defaults for the required Metro target key.

Historical specs and plans remain historical.

## Derived metrics remain non-authoritative

Generalize HPA-624's output behavior, not its authority boundary.

Authoritative engine state keeps `service_metrics = None` for both Bus routes and Metro lines.

`GameEngine::snapshot()`:

1. clones the authoritative snapshot;
2. derives `RoadFlow` once;
3. fills Bus and Metro `service_metrics` on the output clone;
4. returns the clone to WASM/Tauri.

Serde ignores incoming `serviceMetrics` values for both line types. Persistence normalization clears both collections. `snapshot_for_save()` therefore omits derived metrics.

TypeScript only normalizes `undefined`/missing derived output to canonical `null`; it never recalculates cycle time, congestion, required fleet, or nominal headway.

## Shared service-control module

Rename the narrowly Bus-specific module to reflect its second consumer:

```text
crates/caelum-core/src/bus_service.rs
-> crates/caelum-core/src/service_control.rs
```

The module should expose a small mode-aware surface rather than traits or per-mode strategy objects:

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;

pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    mode: TransitMode,
    line_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot>;

pub(crate) fn deploy_initial_fleet(
    state: &GameSnapshot,
    mode: TransitMode,
    line_id: &str,
) -> GameplayResult<CostedMutation>;

pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot);
```

Private helpers operate on the shared line ingredients rather than a new trait hierarchy:

- `legs: &[RouteLegPath]`;
- `target_headway_seconds: Option<u32>`;
- assigned `vehicle_ids`;
- `TransitMode`;
- one `RoadFlow` reference.

A forged `TransitMode::Walk` service-control request is rejected at the boundary using an existing incompatible-route rejection. There is no need for a new persisted service-mode enum because `TransitMode` already owns the wire vocabulary.

## Headway policy remains pre-deployment only

Use one shared floor:

```rust
pub const MIN_HEADWAY_SECONDS: u32 = 60;
```

For both Bus and Metro:

- line must exist for the supplied mode;
- target must be at least 60 seconds;
- no arbitrary upper bound;
- target change does not bump structural route revision;
- target can change only while assigned fleet is empty;
- once any vehicle exists, the target is no longer editable in this slice.

Reuse HPA-624's existing `InvalidHeadway` and `FleetAlreadyAssigned` rejections. Do not add another service lifecycle state.

The Lines UI remains whole-minute input with `min=1`, `step=1`; Rust is authoritative.

## Current cycle time uses live movement semantics

Generalize the Bus cycle walker over the shared `RouteLegPath` representation:

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

Rules stay exactly aligned with HPA-624:

- use `current_path` only;
- every required leg needs a current path;
- ignore `last_valid_path`;
- ignore cached `estimated_seconds`;
- skip non-positive effective step durations;
- empty reversal legs contribute zero;
- timed reversals contribute their actual live steps.

For Bus, `vehicle_step_seconds` applies current aggregate road congestion to road steps.

For Metro, the same helper returns the track step's own travel time. No traffic formula or special Metro timing implementation is needed.

## Required fleet and nominal headway stay identical

For either mode:

```text
required fleet = max(1, ceil(roundTripSeconds / targetHeadwaySeconds))
```

After fleet exists:

```text
nominal headway = roundTripSeconds / assignedFleet
```

Keep the term **Nominal**. This is a count-based deterministic estimate, not measured departure history. It may diverge from actual spacing after line edits; this slice intentionally does not repair bunching or resize fleet.

## Deterministic initial fleet placement is shared

For required fleet `N`, vehicle `i` starts at:

```text
offset(i) = roundTripSeconds * i / N
```

Resolve the offset over the same current path steps and `vehicle_step_seconds` durations used by cycle math. Initialize only:

- `Vehicle.itinerary_index`;
- `Vehicle.path_step_index`;
- `Vehicle.step_progress`.

Skip zero-step and zero-duration legs. Create IDs in stable order through existing `initial_vehicle` / `next_entity_id` behavior.

The existing Bus shuttle regression continues to prove reversal behavior. Add a Metro unequal-leg vector to prove the same resolver works on track paths and remains stable under coarse/fine simulation stepping.

No separate Metro placement algorithm is needed.

## Atomic deployment cost is mode-specific, not abstract

Deployment selects the existing vehicle cost by mode:

```text
Bus   -> requiredFleet * BUS_COST
Metro -> requiredFleet * METRO_COST
```

Use checked integer conversion/multiplication and existing `CostPolicy`.

Standard either buys the complete initial fleet or changes nothing. Creative remains free through the existing policy.

Do not create vehicle inventory, purchase orders, depots, or a generalized costing service.

## Route creation becomes fleet-free for both modes

After this slice:

```text
Create Bus route   -> route geometry/platform assignments, zero vehicles, zero vehicle cost
Create Metro line  -> line geometry/platform assignments, zero vehicles, zero vehicle cost
Set target         -> no cost
Deploy initial fleet -> one atomic mode-specific fleet purchase
```

`route_editor::create_route_costed` therefore no longer needs the current Metro-only initial vehicle branch.

Keep low-level `AssignVehicle` intact for core tests/dev fixtures. It is not exposed as a player plus-one fleet button.

If a fixture uses `AssignVehicle` before target setup, target/deployment rules behave as they do for Bus today: the line is already running and the one-shot setup workflow is unavailable.

## Delete obsolete route-preview vehicle affordability

Metro is currently the last route type that purchases a vehicle during route creation. Once Metro creation becomes fleet-free, route preview has no route-creation purchase to quote.

Delete the dead surface rather than preserving permanent zeroes:

- `RoutePreviewResponse.initial_vehicle_cost` / `initialVehicleCost`;
- `RoutePreviewResponse.affordable`;
- the route-preview `InsufficientBudget` warning branch/type if no other preview producer uses it;
- TypeScript selector logic that turns an unaffordable route draft into `Need $...`.

Route geometry preview remains responsible for topology, turn summary, missing nodes, route-change revision checks, and network warnings.

This cleanup is part of the Metro slice because the old fields become dead only when the last implicit route vehicle is removed.

## Zero fleet means no passenger service for both modes

Keep `route_lifecycle::is_route_operational(active, legs)` structural.

Passenger service eligibility becomes:

```text
structurally operational
AND assigned vehicle_ids is not empty
```

for both Bus and Metro in `router::active_services`.

This avoids teaching the structural lifecycle about fleet policy while ensuring passengers never plan a trip on a line with no arriving vehicle.

Lines status precedence becomes mode-neutral:

1. broken -> Broken;
2. inactive -> Paused;
3. active + connected + zero fleet -> No fleet;
4. otherwise -> Running.

`No fleet` remains display-only.

## Replace Bus-specific public/runtime command names

Now that the behavior has two product consumers, keep one thin command pair rather than adding two more Metro-specific methods.

Rust intent:

```rust
GameIntent::SetServiceTargetHeadway {
    mode: TransitMode,
    line_id: String,
    target_headway_seconds: u32,
}

GameIntent::DeployInitialFleet {
    mode: TransitMode,
    line_id: String,
}
```

TypeScript wire names follow serde camelCase:

```ts
| {
    type: "setServiceTargetHeadway";
    mode: "bus" | "metro";
    lineId: string;
    targetHeadwaySeconds: number;
  }
| {
    type: "deployInitialFleet";
    mode: "bus" | "metro";
    lineId: string;
  }
```

Runtime controller:

```ts
setServiceTargetHeadway(
  mode: "bus" | "metro",
  lineId: string,
  targetHeadwaySeconds: number,
): RuntimeCommandResult;

deployInitialFleet(
  mode: "bus" | "metro",
  lineId: string,
): RuntimeCommandResult;
```

Delete the Bus-specific product methods/intents in the same change. There are no external users to preserve and no compatibility aliases are needed.

`AssignVehicle` remains unchanged as the low-level generic test/dev seam.

## Thin shared Lines-row presentation

Rename Bus-specific shell state to a generic presentation shape:

```ts
export interface ShellServiceState {
  targetHeadwaySeconds: number | null;
  roundTripSeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  nominalHeadwaySeconds: number | null;
}
```

Each `ShellRouteListItem` gets `service: ShellServiceState` for both supported modes rather than `busService: ... | null`.

`runtimeSelectors.ts` does no service math. It copies the target and Rust-derived metrics from the corresponding `Route` / `MetroLine`.

### Before deployment

Bus:

```text
No fleet
Target      6 min
Required    3 buses
[ 6 ] min [Set]
[Deploy fleet]
```

Metro:

```text
No fleet
Target      6 min
Required    2 trains
[ 6 ] min [Set]
[Deploy fleet]
```

The count noun is presentation only. The Deploy button does not promise the displayed count; Rust recomputes at dispatch time.

### After deployment

Both modes show:

```text
Target      6 min
Nominal     5.8 min
Fleet       3
```

Do not show target editing, Deploy, required-vs-assigned mismatch, top-up, or withdrawal after service starts.

## Structural edits after deployment stay unchanged

Keep the existing generic route lifecycle behavior:

- structural edits may park/reposition vehicles to keep cursors valid;
- they do not add/delete vehicles;
- they do not restore initial spacing;
- they do not automatically resize fleet to the target;
- configured target remains persisted.

After an edit, Rust derives a new round-trip and nominal headway from the changed live path. The player can observe that the target and nominal value differ, but HPA-626 adds no correction workflow.

## Error handling

Reuse the HPA-624 rejection vocabulary:

- missing/mismatched line -> existing route/incompatible-route rejection;
- target below 60 seconds -> `InvalidHeadway`;
- deploy without target -> `HeadwayNotSet`;
- target change or second deploy after any fleet exists -> `FleetAlreadyAssigned`;
- inactive line -> `InactiveRoute`;
- disconnected line / unavailable positive cycle -> `DisconnectedLeg`;
- unaffordable complete fleet -> existing budget rejection.

Do not add a service-state enum or a new family of Metro-specific errors.

## Test strategy

### v8 contract

Prove:

- Rust/TypeScript schema version is 8;
- both Bus `Route` and `MetroLine` require `targetHeadwaySeconds` on the wire;
- `null` is valid and omitted target key is invalid;
- forged/deserialized `serviceMetrics` is ignored for both types;
- `snapshot_for_save()` omits derived metrics;
- active storage namespaces move directly to v8 with no fallback.

### Shared service math

Preserve all existing Bus HPA-624 vectors:

- `600 / 300 -> 2`;
- `601 / 300 -> 3`;
- 302-second shuttle free-flow vector;
- 402-second congested shuttle vector;
- unequal path cursor placement.

Add Metro coverage:

- cycle time sums track `current_path` only;
- deliberately wrong `last_valid_path` / `estimated_seconds` are ignored;
- required and nominal formulas match Bus;
- deterministic offset placement lands at the expected Metro leg/step/progress;
- road `RoadFlow` does not alter Metro cycle time.

### Creation/deployment/routing

Prove:

- Bus regression: still zero-fleet at creation and unchanged Set -> Deploy behavior;
- Metro creation is now zero-fleet and no longer charges `METRO_COST`;
- zero-fleet Metro is passenger-ineligible;
- low-level `AssignVehicle` makes a Metro line eligible;
- target below 60 seconds rejects;
- missing target rejects deployment;
- Standard Metro deployment charges all trains atomically;
- Creative deployment is free;
- second deployment rejects;
- coarse/fine stepping from the deterministically spaced fleet remains equivalent.

### Route preview cleanup

Prove the wire/TS route-preview shape no longer contains `initialVehicleCost` or `affordable`, and route creation is not rejected for fleet budget. Keep topology/revision/route-impact preview tests.

### UI/runtime

Prove:

- both modes display `No fleet` at zero assigned fleet;
- both use the same Target/Required/Set/Deploy UI;
- Metro uses `trains` in the required count;
- after deployment both show Target/Nominal/Fleet and no setup controls;
- runtime dispatch includes the selected mode and performs no local timing/fleet math.

### Real browser/WASM composition

One representative Metro E2E:

1. build/connect two Metro stations and track;
2. create the Metro line;
3. assert zero fleet / No fleet;
4. set a target;
5. assert required fleet appears;
6. deploy;
7. assert non-zero Fleet and Nominal headway;
8. resume simulation and verify the clock advances.

Do not duplicate the full Rust metric matrix in Playwright.

## Non-goals

HPA-626 explicitly does not add:

- post-deployment headway editing;
- fleet top-up, withdrawal, reassignment, or automatic resize/re-spacing;
- peak/off-peak/night bands or closed service periods;
- stop-by-stop timetables;
- measured departure history or actual-headway metrics;
- terminal holding, layover policy, bunching detection, or bunching recovery;
- depots, crews, maintenance, breakdowns, or vehicle variants;
- route visibility/map-layer controls;
- a generic scheduler, fleet manager, persisted `ServicePlan`, or route trait hierarchy;
- save migration, backward compatibility, or pre-release hardening.

## Success criteria

HPA-626 is complete when:

1. new Bus and Metro routes both begin with zero fleet and no route-creation vehicle purchase;
2. both modes use the same pre-deployment Target -> Required -> Deploy product flow;
3. Rust remains the only authority for live cycle time, required fleet, nominal headway, cost, and deterministic placement;
4. zero-fleet Bus and Metro lines are excluded from passenger routing;
5. Bus behavior from HPA-624 remains green after the narrow shared seam is introduced;
6. route-preview vehicle affordability plumbing is deleted because it has no remaining consumer;
7. schema/storage is v8 with no compatibility path;
8. a real Metro line can be configured, deployed, and run through the shared Lines panel.