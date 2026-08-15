# HPA-624 Bus Headway and Initial Fleet Deployment Design

**Linear:** HPA-624  
**Parent:** HPA-334  
**Depends on:** HPA-622

## Goal

Deliver the first Phase 4 service-control loop for **bus routes only**:

> A valid bus route can exist with zero buses. The player sets one constant target headway, Caelum derives the required fleet from the route's current congestion-aware round-trip time, and one explicit action deploys that initial fleet at deterministic time-spaced positions. The existing Lines panel shows target versus current headway and assigned versus required fleet.

This is intentionally narrower than a timetable or fleet-management system. It proves that route geometry and service operation are separate concepts before adding any second service period, holding policy, bunching logic, vehicle withdrawal, or Metro service planning.

## Current seams to reuse

The repository already has nearly every boundary this slice needs:

- `route_editor::create_route_costed` validates route geometry and currently couples route creation to the first vehicle purchase.
- `transit::initial_vehicle` creates the existing bus vehicle cursor shape.
- `transit::assign_vehicle_costed` already implements one unspaced vehicle add and existing cost/route-validity rules.
- `Route.legs` is already the cyclic itinerary used by live vehicle movement for both loop and shuttle services.
- HPA-622's `traffic::RoadFlow` and congestion helpers are the source of live road delay.
- `transit::vehicle_step_seconds` is the exact per-step timing semantics used by live vehicles once made `pub(crate)` for reuse.
- `transit::tick_vehicles` advances `Vehicle.itinerary_index`, `path_step_index`, and `step_progress` over those same route legs.
- `route_lifecycle::rebase_edited_route_vehicles_and_riders` already parks/rebases vehicles after structural edits so cursors remain valid.
- `router::active_services` is the one place that decides which routes are eligible for passenger planning.
- `runtimeSelectors.ts` already derives each Lines-panel row from the authoritative snapshot.
- `LinesPanel.svelte` already owns route rename, color, pause/resume, repair, edit, and delete controls.

Reuse those seams. Do not add a scheduler service, fleet repository, operations dashboard, generic `ServicePlan`, or second runtime store.

## Chosen scope: bus first, Metro unchanged

HPA-334 explicitly asks the first vertical slice to prove one existing route type. Use buses because HPA-622 just made bus travel time congestion-aware, so buses exercise the stable Phase 3 travel-time input that Phase 4 was waiting for.

Only **new bus routes** stop receiving an implicit first vehicle in HPA-624. New Metro lines keep their current one-vehicle creation behavior and creation cost. Metro headways are deferred until they demonstrate whether the bus shape should actually be generalized.

The existing generic route editor remains generic while creation policy becomes mode-specific:

- Bus create: validate topology, assign platforms, insert active route with `vehicle_ids = []`, charge no vehicle cost.
- Metro create: preserve the current initial Metro vehicle and vehicle cost.

Route editing remains structural. HPA-624 must **not** buy buses, delete buses, or re-space a fleet to the target headway during a route edit. It must, however, preserve the existing structural-edit rebase behavior. `update_route` already calls `rebase_edited_route_vehicles_and_riders` when route structure changes; that may park/reposition buses and reset their cursors so they remain valid on the edited itinerary. Do not remove or bypass that safety behavior.

After a structural edit, assigned fleet and newly derived required fleet may disagree, and rebased buses may temporarily bunch at stops. HPA-624 leaves that visible rather than introducing automatic re-spacing, holding, or fleet resizing.

## Route-owned target headway, not a service-plan abstraction

Persist one nullable bus-only field directly on `Route`:

```rust
pub struct Route {
    // existing fields
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

The key must be present in schema-v7 snapshots. `null` means the player has not configured service yet. Use the repository's required-nullable deserialization pattern rather than a serde default that silently accepts an old route shape.

Do not add the field to `MetroLine`, and do not create a `ServicePlan`, service-band list, timetable object, or vehicle-class configuration. A second route type or service-period case must first demonstrate duplication.

### Headway mutation

Add one bus-specific intent:

```rust
GameIntent::SetBusTargetHeadway {
    route_id: String,
    target_headway_seconds: u32,
}
```

Rules:

- the route must be an existing bus route;
- `target_headway_seconds` must be greater than zero;
- there is no arbitrary upper bound in this development slice;
- changing headway does not change route `revision`, because revision remains the optimistic-concurrency token for structural route/platform editing;
- changing headway does not automatically buy, remove, or reposition vehicles.

Add an explicit `InvalidHeadway` gameplay rejection rather than overloading a topology error.

The UI may present whole minutes for convenience, but the authoritative wire/storage unit is seconds.

## Schema v7 is a direct development break

Adding required wire state to `Route` bumps the disposable development snapshot schema from 6 to 7.

Update directly in the same implementation task:

- Rust `SNAPSHOT_SCHEMA_VERSION = 7`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 7`;
- IndexedDB default database `caelum-city-saves-v7`, version `7`;
- native application-data directory `cities-v7`;
- `GameEngine::from_snapshot` documentation;
- active architecture/runtime comments and tests that describe schema v6.

Old development cities disappear. Do not add migration code, fallback namespaces, aliases, dual readers, or serde defaults for the new route field. Historical design/plan documents remain historical and do not need rewriting solely because they describe the v6 work that created them.

## Current bus round-trip time

HPA-624 needs the round-trip time that a bus would experience **now**, not the free-flow `estimated_seconds` cached when the route was authored.

For a connected bus route, calculate one cycle by walking the existing cyclic `Route.legs` in order and summing the exact effective duration of every current path step through the same helper used by live vehicle movement:

```rust
transit::vehicle_step_seconds(flow, TransitMode::Bus, step)
```

Do not call `traffic::effective_road_path_seconds` for service-cycle math. That helper intentionally preserves a stored `total_travel_seconds` for an empty synthetic road path, while live vehicle movement treats a zero-step leg as zero elapsed movement time. Headway/fleet math must match the live cursor semantics.

Use only `leg.current_path`:

- if a required leg has no `current_path`, service metrics are unavailable;
- ignore `last_valid_path`;
- ignore authored/cached `estimated_seconds`;
- skip path steps whose effective duration is non-positive.

Derive `RoadFlow` from the current snapshot with HPA-622's existing helper. Do not persist round-trip time or cache it on `Route`; it changes when active private-car trips change.

Put the Rust calculation in a small bus-specific module such as `bus_service.rs`, rather than growing `transit.rs` further or introducing a generic operations framework.

### Loop and shuttle semantics

`Route.legs` is cyclic for both existing service patterns, so the same walk covers both. Shuttle-specific reversal legs must be part of the timing semantics:

- a zero-step terminal reversal contributes `0` seconds because live movement skips it;
- an in-place U-turn reversal contributes its actual `RoadPathStep.travel_seconds` through `vehicle_step_seconds`;
- a multi-step roundabout/junction reversal contributes every effective current-path step;
- no special shuttle scheduler or separate formula is introduced.

Tests must lock this explicitly. One representative synthetic shuttle vector is:

```text
outbound road step      100s
terminal reversal       0s   (empty path)
return road step        200s
terminal U-turn step      2s
--------------------------------
round trip              302s
```

With flow `8` on the outbound road point, that 100-second road step becomes `200s` under the existing `2.0x` congestion multiplier, so the same vector becomes `402s`. Rust and TypeScript display tests must use these same values.

## Required fleet and current headway

When a route has a positive target headway and a positive current round-trip time:

```text
required fleet = max(1, ceil(roundTripSeconds / targetHeadwaySeconds))
```

The slice deliberately has no fractional, standby, or spare fleet concept.

For display, define **current headway** as the deterministic instantaneous estimate:

```text
current headway = roundTripSeconds / assignedFleet
```

If assigned fleet is zero, current headway is unavailable. This is the HPA-624 meaning of “actual headway”: it reflects the travel time the currently assigned fleet would produce under current congestion if evenly distributed. It is **not** measured departure history and does not imply bunching detection.

Rust remains authoritative for deployment count and cost. TypeScript mirrors the same current-path step walk only for presentation. Tests must lock both implementations to identical representative vectors, including the shuttle vector above and at least one congested road step. A display implementation that instead uses `estimatedSeconds`, `lastValidPath`, or empty-path stored totals is incorrect rather than merely approximate.

## Zero fleet means no passenger service

A route may be structurally active and connected while having `vehicle_ids = []`. Such a route must remain editable and visible, but passengers must not plan journeys on service that cannot arrive.

Keep `route_lifecycle::is_route_operational(active, legs)` as the structural active/connected check because fleet assignment and other lifecycle code must work while a route has zero vehicles. Narrow only passenger eligibility in `router::active_services`:

```text
bus route is passenger-service eligible
= structurally operational
AND vehicle_ids is not empty
```

Metro behavior is unchanged.

In the Lines panel, status precedence is:

1. broken route -> Broken;
2. inactive route -> Paused;
3. active connected bus with zero buses -> No fleet;
4. otherwise -> Running.

Do not turn `No fleet` into a persisted route lifecycle state.

## `AssignVehicle` remains an engine/test seam

Keep the existing `GameIntent::AssignVehicle` behavior in HPA-624. Core tests such as route-resilience fixtures already use it to add a bus explicitly, and after bus route creation becomes fleet-free it remains a convenient unspaced engine/test add.

Policy:

- do not delete or reject bus `AssignVehicle`;
- do not expose a new plus-one `AssignVehicle` control in the Lines panel;
- the intended player setup path is **Set target headway -> Deploy initial fleet**;
- a bus added through `AssignVehicle` immediately makes a structurally valid route passenger-service eligible;
- because the route is no longer zero-fleet, later `DeployBusFleet` rejects with `FleetAlreadyAssigned`;
- after a real deployment, `AssignVehicle` may still append another unspaced bus through low-level dispatch, but HPA-624 does not build player UX around that path.

This preserves existing core/test behavior without turning a development seam into a general fleet-management feature.

## One explicit initial-fleet deployment

Add a second bus-specific intent:

```rust
GameIntent::DeployBusFleet {
    route_id: String,
}
```

This action exists only to complete the first route-setup loop. It is not a general resize command.

Preconditions:

- route exists and is a bus route;
- route is active and all legs are connected;
- `target_headway_seconds` is set and positive;
- route currently has zero assigned vehicles;
- current round-trip time is positive and derivable from current route paths.

Use existing rejection codes for missing/inactive/broken routes, plus small explicit `HeadwayNotSet` and `FleetAlreadyAssigned` codes for the two new service-control failures.

### Atomic cost

Derive `requiredFleet` once from the current `RoadFlow`, then quote:

```text
requiredFleet * BUS_COST
```

through the existing `CostPolicy`.

Standard economy either buys the whole initial fleet or changes nothing. Do not partially deploy the affordable subset. Creative economy remains free through the same policy. Do not add purchase inventory or a vehicle ownership ledger.

### Why not call `AssignVehicle` N times from TypeScript

Repeated player-path host dispatches would expose partial purchases, recompute against intermediate snapshots, and make deterministic spacing a UI concern. One Rust mutation keeps cost, IDs, and placement atomic without creating a fleet manager. This does not remove the existing low-level `AssignVehicle` intent described above.

## Deterministic time-based spacing

The route legs already form a cyclic itinerary. At deployment, space `N` buses by **travel time**, not by stop index, leg count, or tile count.

For vehicle index `i` in stable creation order:

```text
offset(i) = roundTripSeconds * i / N
```

Resolve the offset across the route's current path steps using the same `vehicle_step_seconds` semantics as round-trip calculation and live bus movement. The located cursor initializes:

```text
Vehicle.itinerary_index
Vehicle.path_step_index
Vehicle.step_progress
```

`step_progress` is the fraction of the located effective step already traversed. Skip zero-duration steps and zero-step legs. Because `i < N`, offsets are always in `[0, roundTripSeconds)`.

Create vehicle IDs sequentially with the existing `next_entity_id`/`initial_vehicle` seam, then overwrite only the three cursor fields needed for spacing. Passenger lists start empty and `parked_position` remains consistent with the current live vehicle model.

This proves deterministic spacing on unequal route legs and shuttle reversals without adding departure clocks or holding.

Use the shuttle vector above as one spacing regression: with a 302-second cycle and `N = 2`, vehicle 1 receives offset `151s`. It skips the 100-second outbound step and zero-second reversal, then lands `51s` into the 200-second return step, so `step_progress == 0.255` on that step. This explicitly proves the cursor walk handles shuttle reversal legs rather than assuming a loop-only stop layout.

### Traffic after deployment

Spacing uses the `RoadFlow` visible at deployment time. Later car-flow changes alter live travel time and therefore the displayed current-headway estimate, but HPA-624 does not automatically re-space the fleet. Automatic recovery would be bunching/holding logic and is explicitly deferred.

Buses still do not contribute to `RoadFlow` in this phase, matching HPA-622.

## Structural edits after deployment

Existing structural editing already rebases vehicles when the itinerary changes. Preserve it.

HPA-624 rules are therefore:

- route edits may park/reposition buses through the existing rebase implementation to keep cursors safe;
- route edits do not add/remove buses;
- route edits do not attempt to preserve the old headway spacing;
- route edits do not run the initial deployment algorithm again;
- changing headway does not trigger rebase or re-spacing.

The Lines row simply recomputes current/required metrics afterward. Any bunching or assigned/required mismatch is visible and deferred to later operations work.

## Route preview and creation budget behavior

Keep the current `RoutePreviewResponse.initialVehicleCost`/`affordable` fields because Metro creation still buys one vehicle.

For a new route preview:

- Bus: `initialVehicleCost = 0`, `affordable = true` with respect to vehicle purchase.
- Metro: preserve current Metro vehicle cost and budget rejection/warning behavior.
- Editing either mode: preserve current zero creation cost.

The bus route editor therefore validates route geometry without blocking Save on the future fleet purchase. Fleet affordability is enforced only when the player deploys the fleet from the Lines row.

## Lines-panel UX

Extend the existing bus route row; do not create another panel or modal.

For bus rows, show a compact service block:

```text
Target      6 min
Current     —          (zero fleet)
Fleet       0 / 3
[headway input] [Set]
[Deploy 3 buses]
```

After deployment:

```text
Target      6 min
Current     5.8 min
Fleet       3 / 3
```

Rules:

- headway input uses whole minutes and dispatches seconds;
- the deploy button appears/enables only when the route is active, connected, has a target, has zero fleet, and required fleet is derivable;
- Metro rows keep their current compact controls with no service block;
- headway may still be edited after deployment, but HPA-624 does not resize the existing fleet; the assigned/required figures make any mismatch visible for a later ticket;
- `AssignVehicle` gets no player-facing plus-one control;
- use existing action-feedback/rejection plumbing for unaffordable deployment or invalid host actions.

Do not add charts, history, per-vehicle rows, route visibility toggles, or advanced operations navigation.

## TypeScript display derivation

Add one small bus-specific pure selector/helper rather than expanding Svelte with transport math.

It may reuse `selectTrafficFlow(state)` and the mirrored congestion constants from `src/domain/traffic.ts`, but its route walk must be a direct port of the Rust/live-vehicle step semantics:

```ts
interface BusServiceMetrics {
  roundTripSeconds: number;
  targetHeadwaySeconds: number | null;
  assignedFleet: number;
  requiredFleet: number | null;
  currentHeadwaySeconds: number | null;
}
```

For every `route.legs` entry:

1. require `currentPath`;
2. iterate its current steps in order;
3. for road steps, multiply `travelSeconds` by the current point flow's congestion multiplier;
4. skip non-positive effective step durations;
5. zero-step paths add zero;
6. never fall back to `lastValidPath` or `estimatedSeconds`.

This helper is presentation-only. Deployment independently derives the authoritative required count in Rust from the same snapshot semantics.

## Testing strategy

### Rust

Focused tests must prove:

- a new bus route has zero vehicles, costs no bus purchase, and remains structurally active/connected;
- a new Metro route still receives its initial vehicle and current cost;
- a zero-fleet bus route is excluded from passenger routing;
- `AssignVehicle` can still add one unspaced bus and make the route passenger-service eligible;
- positive target headway persists; zero is rejected; route structural revision does not change;
- current round-trip time uses HPA-622 congestion, including a flow change that changes required fleet;
- `ceil(roundTrip / target)` has the expected boundary behavior;
- loop routes with unequal step durations are summed by live duration, not stop count;
- shuttle empty reversals contribute zero while U-turn/multi-step reversal steps contribute their live durations;
- deployment is atomic under Standard budget and free under Creative;
- deployment rejects missing target and a second deployment;
- unequal-duration loop legs produce deterministic cursor offsets in stable vehicle-ID order;
- the 302-second shuttle vector with `N = 2` places vehicle 1 at progress `0.255` in the return step;
- an existing structural route edit still executes the normal vehicle rebase and does not invoke headway re-spacing;
- coarse/fine ticking remains deterministic after a deployed fleet starts moving;
- schema v7 requires the nullable route headway field and rejects older schema versions through the existing probe.

### TypeScript/UI

Focused tests must prove:

- bus service metrics match Rust's `600/300 -> 2` and `601/300 -> 3` boundary vectors;
- TypeScript reproduces the exact 302-second shuttle vector, zero-step reversal semantics, and the 402-second congested variant;
- a deliberately conflicting `estimatedSeconds`/`lastValidPath` value does not affect the TypeScript result when `currentPath` is present;
- the route selector reports No fleet, target/current headway, and assigned/required fleet correctly;
- the runtime dispatches `setBusTargetHeadway` and `deployBusFleet` intents without a second business-logic implementation;
- LinesPanel renders and invokes Set/Deploy controls for buses but not Metro;
- LinesPanel does not expose `AssignVehicle` as a plus-one fleet control;
- rejection copy covers the three new service-control errors.

### Real sandbox smoke

Keep E2E thin but real:

1. create/open a sandbox;
2. build the minimum road + two bus-stop route already supported by existing helpers;
3. save the bus route and assert it shows zero fleet / No fleet;
4. set a target headway;
5. deploy the required buses;
6. assert the row shows non-zero assigned fleet and current headway;
7. verify Pause/Resume and clock advancement still respond.

Do not wait for a real commute, measure exact rendered vehicle pixels, or build a traffic-load scenario in E2E; deterministic timing belongs in Rust/unit tests.

## Alternatives rejected

### Generic `ServicePlan` shared by bus and Metro

Rejected for the first slice. There is only one route type and one service period to support, and HPA-334 explicitly says to extract the abstraction only after a second case demonstrates duplication.

### Timetable/departure-event scheduler

Rejected. A target headway plus deterministic initial spacing is enough to make fleet quantity operationally meaningful. Departure clocks, holding, bunching, and recovery would create a new scheduling subsystem before playtesting proves it is needed.

### TypeScript-owned fleet mutation with repeated `AssignVehicle`

Rejected. It makes the host responsible for authoritative cost/count/placement and can partially mutate the route. Rust already owns simulation, cost policy, IDs, and vehicle cursors. The existing low-level `AssignVehicle` intent remains available to core/tests; it is simply not the intended player setup path.

### Automatic fleet resizing whenever headway, congestion, or route structure changes

Rejected. It would require purchase/withdrawal policy, passenger-safe removal, and likely vehicle re-spacing. HPA-624 only needs the initial deployment loop. Existing structural route rebase remains for cursor safety, but it is not headway optimization.

## Non-goals

- Metro headway or service-plan changes.
- Peak/off-peak/night bands or a closed service period.
- Stop-by-stop schedules or arbitrary departure times.
- Layovers, terminal holding, bunching detection, or bunching recovery.
- Player-facing plus-one bus purchase, vehicle withdrawal, reassignment, purchase inventory, depots, crews, maintenance, or breakdowns.
- Automatic headway/fleet optimization or re-spacing after route edits.
- Per-vehicle management UI or operations dashboards.
- Route visibility/map-layer frameworks.
- Save migration, backward compatibility, recovery, or pre-release hardening.
