# HPA-347 ECS Latent Population Design

**Linear:** HPA-347 — [Scale] Add ECS-backed latent population schedules and transport-demand generation

**Status:** Proposed implementation design

## Context

HPA-544 is complete. Ordinary frontend traffic now crosses the compact `PresentationUpdate { scene, frame }` boundary, so the browser no longer needs one wire row per latent citizen. The remaining scale problem is inside `caelum-core`: `GameSnapshot.sims` is still the live population store and ordinary ticking repeatedly clones or scans it.

Today the high-cardinality work is concrete:

- `population::apply_due_move_ins` and occupancy helpers scan `snapshot.sims`;
- `buildings::assign_workplaces` scans the population;
- `trips::spawn_due_commute_trips`, `reset_daily_commute_flags`, and `next_boundary_after` scan every sim;
- `max_tick_substeps` derives part of its budget from population count;
- terminal trip handling searches `snapshot.sims` by citizen ID;
- building removal/reassignment mutates citizens from snapshot-only helpers in `transit.rs`.

At about 200,000 citizens, dormant population therefore participates in ordinary substep cost even when very few citizens are due to act.

HPA-347 is the first load-bearing Bevy slice. It is not a Bevy proof-of-concept and not a whole-engine rewrite.

## Goals

1. Make standalone `bevy_ecs` the sole live owner of latent citizens and their next scheduled activity.
2. Keep durable identity in stable Caelum string IDs; Bevy `Entity` values remain runtime-only.
3. Advance a 200,000-citizen fixture without scanning all citizens on an ordinary quiet substep.
4. Wake citizens through time buckets and emit deterministic `TripDemand` rows into the existing route/private-car pipeline.
5. Support work, school, return-home, one deterministic day off, and one bounded optional outing without per-frame citizen AI.
6. Preserve delayed housing move-in, finite workplace capacity, stable assignment, demolition cleanup, and current trip semantics.
7. Preserve HPA-544 `PresentationUpdate` shape; the frontend never learns about ECS or latent citizen rows.
8. Keep save/restore candidate-first and deterministic.
9. Deliver dependency/toolchain change, runtime migration, persistence cutover, tests, and scale evidence in this one PR.

## Non-goals

- Moving map/route graphs, transit vehicles, active-trip movement, traffic aggregation, economy, or catalogs into ECS.
- Per-citizen pathfinding while dormant.
- Batched route choice or traffic-demand routing; HPA-348 owns that next.
- WebGPU, viewport/LOD extraction, publication cadence, or interpolation; HPA-640 owns those.
- Rendered citizens or private-car entities.
- Households, needs/mood, social simulation, school enrollment capacity, or visitor capacity.
- A generic Bevy plugin/framework layer.
- Backward compatibility with schema-v9 development saves.

## Chosen architecture

### Rejected: store the existing snapshot as an ECS resource

This adds a Bevy layer but leaves all 200,000 `Sim` rows in the same clone/scan paths. It does not solve the target bottleneck.

### Rejected: move the whole simulation to ECS now

This expands one scale ticket across mature route, vehicle, economy, traffic, and rendering seams. It makes parity failures harder to isolate and duplicates work already scoped to HPA-348/HPA-640.

### Chosen: ECS owns latent population; existing Rust owns active transport and city systems

After the cutover:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: bevy_ecs::world::World,
    population_schedule: bevy_ecs::schedule::Schedule,
}
```

`GameEngine.snapshot.sims` is always empty. The ownership contract is:

- **live latent population:** ECS components/resources in `world`;
- **live active transport:** existing `snapshot.active_trips` + transit state;
- **durable population:** `GameSnapshot.sims`, reconstructed from ECS only by explicit snapshot/save operations;
- **presentation:** existing HPA-544 scene/frame wire, with population aggregates read from ECS indexes.

There is no live `Vec<Sim>` mirror beside ECS.

`GameEngine` stops implementing `Clone`. Current clone uses are test-fixture conveniences and should reconstruct an independent engine from a durable fixture when needed.

## Dependency and toolchain

Use only standalone ECS:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

`bevy_ecs 0.19.1` requires Rust 1.95.0, so set `rust-version = "1.95"` in all three Rust packages: `caelum-core`, `caelum-wasm`, and `src-tauri`.

Do not add full `bevy`, `bevy_app`, reflection, Bevy serialization, async executor, `multi_threaded`, or `rand`. This slice uses one explicitly ordered schedule. Parallel execution can be considered only after the new runtime shape is measured.

## Durable schema v10

The current commute-day booleans exist because each day is rediscovered by scanning the population. Replace them with one persisted next activity.

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CitizenRoutine {
    Worker {
        shift_template: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workplace: Option<Point>,
    },
    Student,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledActivityKind {
    DailyRoutine,
    PrimaryReturn,
    OptionalReturn,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledActivity {
    pub kind: ScheduledActivityKind,
    pub due_time: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sim {
    pub id: String,
    pub home: Point,
    pub position: Point,
    pub routine: CitizenRoutine,
    pub next_activity: Option<ScheduledActivity>,
}
```

`position` is the last settled location. While travelling, movement authority is the matching `ActiveTrip` and `next_activity` is `None`.

Extend `TripPurpose` with `OptionalOutbound` and `OptionalReturn`. Keep `CommuteOutbound` / `CommuteReturn` for the primary worker/student round trip so the mature trip pipeline changes minimally.

Bump `SNAPSHOT_SCHEMA_VERSION` from 9 to 10 and reject v9. Do not add a migration layer.

## ECS components

Keep the component set small and data-oriented:

```rust
#[derive(Component)]
struct CitizenId(String);

#[derive(Component)]
struct HomeAssignment {
    building_id: String,
    point: Point,
}

#[derive(Component)]
struct SettledPosition(Point);

#[derive(Component)]
enum Routine {
    Worker {
        shift_template: String,
        workplace: Option<BuildingAssignment>,
    },
    Student,
}

#[derive(Component)]
struct NextActivity(ScheduledActivity);

struct BuildingAssignment {
    building_id: String,
    point: Point,
}
```

Runtime building IDs make occupancy, reassignment, and demolition targeted. Durable `Sim` remains point-oriented because routing/save contracts already use points.

## Runtime resources

### `PopulationClock`

The current simulation timestamp supplied by the trip substep driver before the population schedule runs.

### `PopulationScheduler`

```rust
struct PopulationScheduler {
    buckets: BTreeMap<u64, Vec<PopulationEvent>>,
}
```

Each key is one in-game-minute bucket. Convert an exact due time to the first bucket boundary at or after it, so an activity is never executed early. The exact `ScheduledActivity.due_time` remains on the citizen and is used as `TripDemand.scheduled_time`; bucketing only determines when the citizen wakes.

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

Runtime `Entity` is allowed inside this non-serialized queue. Deterministic external order is always recovered from stable `CitizenId` before demand emission.

### `PopulationIndex`

One rebuildable resource owns the indexes needed to avoid global scans:

- `CitizenId -> Entity` lookup;
- next citizen ordinal for O(1) `sim-NNN` allocation;
- building metadata needed by population logic;
- residents by housing building;
- workers by workplace building;
- deterministic unassigned-worker IDs;
- free workplace slots in stable building-ID order;
- placed school buildings;
- placed optional-outing destination buildings.

Use BTree-backed collections wherever iteration order affects assignment/demand. The index is derived runtime data, not a second population authority.

### Mailboxes

`DuePopulationEvents` and `PendingTripDemands` are short-lived vectors cleared each schedule run. They are ordering seams between systems, not persisted state.

## Schedule order

Own one standalone schedule with explicit chained sets:

```text
CollectDue -> ApplyDue -> EmitTripDemand
```

- **CollectDue:** drain buckets whose boundary is `<= PopulationClock.now`.
- **ApplyDue:** process only the drained move-in/citizen events.
- **EmitTripDemand:** stable-sort due citizens by `CitizenId` and append demand rows.

None of these systems queries every citizen. `run_due` may rerun the schedule if processing creates another event in the already-current bucket; this closes same-time work without a population scan.

## Routine rules

The routine model is deterministic and intentionally bounded.

### Worker/student split

Preserve the current effective ratio: every tenth citizen ordinal becomes `Student`; the other 90% become `Worker`. Worker shift selection and outbound/return windows reuse the existing `shift_template_for_id` / `departure_minute_for_sim` rules.

Finite workplace capacity remains. Assign workers to free slots in sorted workplace-building order with stable citizen ID as the tie-breaker. Unassigned workers remain in a sorted runtime set until a slot opens.

### Students

Students select among placed `school` buildings in stable building-ID order using the citizen/day seed. This ticket does not model school enrollment capacity.

- outbound window: 07:30–08:30;
- return window: 15:00–16:00.

If there is no school, there is no primary trip that day.

### Day off

Each citizen has exactly one deterministic day off in seven:

```text
day % 7 == numeric_id_suffix(citizen_id) % 7
```

A day off suppresses the primary work/school trip.

### Optional outing

On a day off, at most one optional outing is possible. Only one in four eligible citizens takes it, selected by a stable citizen/day integer mixer.

Eligible building types:

- `supermarket`
- `cinema`
- `clinic`
- `parkPlaza`

Choose a placed building in stable ID order from the seed, then a footprint tile deterministically.

- outbound window: 11:00–15:00;
- dwell after successful arrival: 120 in-game minutes;
- then emit `OptionalReturn`.

No visitor capacity, shopping economy, or chained leisure stops are added.

### State machine

A citizen has at most one `NextActivity` and no next activity while an active trip exists.

1. `DailyRoutine` wakes the citizen for that day.
2. If the citizen is away from home from a previous failed return, emit a return-home trip before considering new work/school/outing activity.
3. Otherwise, if a primary work/school trip applies, emit `CommuteOutbound`.
4. Otherwise, optionally emit `OptionalOutbound`; if not, schedule the next day's `DailyRoutine`.
5. Successful primary outbound arrival schedules `PrimaryReturn` at the routine return time, or the current bucket if that time already passed.
6. Successful optional outbound arrival schedules `OptionalReturn` after 120 in-game minutes.
7. Successful return arrival settles the citizen at home and schedules the next day's `DailyRoutine`.
8. Unserved outbound leaves settled position unchanged and schedules the next daily wake.
9. Unserved return leaves the citizen at the current settled location and schedules the next daily wake; rule 2 retries home before a new outbound routine.

This replaces the global daily flag reset and avoids retry loops inside one broken time bucket.

## Trip-demand bridge

The ECS population does not route.

```rust
struct TripDemand {
    citizen_id: String,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    scheduled_time: f64,
}
```

`trips.rs` drains these rows and routes them sequentially through the existing route-plan/private-car path. Same-time demands are sorted by `(scheduled_time, citizen_id, explicit purpose rank)` before trip sequence allocation.

Route choice remains O(number of due demands) in HPA-347. If that becomes the measured wave bottleneck, HPA-348 owns the batching optimization.

## Trip resolution back into ECS

Before terminal active trips are removed, collect:

```rust
struct PopulationTripResolution {
    citizen_id: String,
    purpose: TripPurpose,
    status: TripStatus,
    destination: Point,
    resolved_at: f64,
}
```

Apply those rows to ECS after each substep:

- `Arrived` and `Late` count as arrival for settled-position/activity scheduling;
- `Unserved` preserves settled position and schedules the recovery described above.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`; no live snapshot citizen remains to mutate.

## Time-boundary integration

Replace population-dependent trip scans with scheduler queries:

- `spawn_due_commute_trips` becomes pending-demand routing;
- delete `reset_daily_commute_flags`;
- `next_boundary_after` asks `PopulationScheduler` for its next populated bucket;
- `max_tick_substeps` counts populated scheduler buckets inside the tick window instead of `sims.len() * events_per_day`;
- remove `remaining_move_in_slots`; move-ins are already scheduler events.

Active-trip, vehicle, growth, objective, and traffic boundaries remain in their existing modules.

## Move-in and building reconciliation

Housing move-ins remain building-driven and paused with the engine.

When a runtime is built or housing is added, derive occupied slots from `PopulationIndex` and schedule the remaining slots from `PlacedBuilding.placed_at` using the existing `MOVE_IN_INTERVAL_SECONDS`. A move-in event:

1. verifies the housing building still exists and the slot remains open;
2. allocates the next stable `sim-NNN` ordinal from the index;
3. spawns one citizen entity;
4. assigns a workplace if capacity exists;
5. updates reverse indexes;
6. schedules the first `DailyRoutine`, skipping an already-passed primary departure for today as current behavior does.

Pure `buildings.rs` / `transit.rs` snapshot mutation helpers become shell-only because preview code also calls them. Once `GameEngine` accepts a building-changing candidate, a focused ECS reconciliation receives before/after building lists plus the candidate active trips/vehicles.

Targeted reconciliation rules:

- added housing -> schedule missing move-in slots;
- added workplace -> fill free slots from sorted unassigned-worker IDs;
- removed housing -> find residents through `residents_by_building`, despawn them, remove their active trips, and scrub vehicle passenger IDs;
- removed workplace -> find workers through `workers_by_building`, clear/reassign them, and retarget/drop affected outbound trips using the existing Idle/patience/deadline reset semantics;
- removed school/optional destination -> cancel only affected outbound trips and schedule the citizen's next sensible activity.

Growth-wave building additions use the same reconciliation after the existing growth executor mutates the shell. Do not add a second growth path.

## Presentation

Do not change the HPA-544 wire.

Keep `presentation::project_update(&GameSnapshot, include_scene)` as the pure durable-snapshot projector used by parity tests and the existing snapshot harness.

Add a runtime projector used by `GameEngine` that takes the live shell plus ECS population aggregates. Factor one shared frame builder so all non-population presentation remains single-source.

Runtime population fields come from `PopulationIndex`:

- `populationCount` = citizen count;
- residential building occupancy = indexed resident count;
- job building occupancy = indexed assigned-worker count.

Students do not redefine the existing job-occupancy meaning of school rows in this ticket.

Platform occupancy, traffic flow, demand flow, vehicles, service metrics, scene map/buildings/routes/stations remain exactly as HPA-544 defines them.

`GameplayUpdateResult` constructors take a precomputed `PresentationUpdate`; they must not call the durable projector and accidentally reconstruct 200,000 sims on every tick/dispatch.

## Save and restore

### Explicit durable snapshot/save

`GameEngine::snapshot()` and `snapshot_for_save()` are intentionally expensive debug/persistence operations:

1. clone the live shell;
2. query all citizen entities;
3. project each to durable `Sim`;
4. sort by stable `Sim.id`;
5. install the vector into the clone;
6. populate/normalize the same derived save fields as today.

Ordinary tick, dispatch, and presentation never call this path.

### Candidate-first restore

1. schema-probe and deserialize v10;
2. validate the full durable snapshot;
3. compile topology/normalize shell fields;
4. build a fresh ECS world, indexes, scheduler buckets, and population schedule from the validated candidate;
5. validate runtime population invariants;
6. clear `candidate.sims` to make the live shell;
7. replace the current engine only after all candidate work succeeds.

Runtime `Entity` handles are never serialized or compared across restores. Save/restore equivalence is defined entirely by stable Caelum IDs and durable/presentation values.

Add persistence validation for:

- `Sim.home` resolving to a residential building footprint;
- worker workplace, when present, resolving to a job-capacity building footprint;
- finite/non-negative `next_activity.due_time`;
- a sim with an active trip having `next_activity == None`;
- a sim without an active trip having a next activity;
- unique stable sim IDs (existing entity validation).

Use the existing structured persistence error model: new `SnapshotField::SimNextActivityDueTime` plus `AssignmentError::{SimHomeNotResidential, SimWorkplaceNotJob, ScheduledWhileTraveling, MissingNextActivity}`.

## Determinism

Determinism must not depend on Bevy entity allocation or hash iteration.

Tie-breakers:

1. scheduler bucket / exact scheduled time;
2. stable citizen ID;
3. explicit purpose rank.

Use BTree-backed indexes for deterministic assignment and output. The schedule sets are explicit and chained, and `multi_threaded` stays disabled in this slice.

## Performance evidence

Extend the HPA-544 native harness shape instead of adding a benchmark framework.

For 10k / 50k / 200k populations, record on one reference machine:

- durable candidate -> ECS runtime construction;
- quiet tick with all next activities in the future;
- runtime presentation projection;
- explicit full `snapshot()` reconstruction.

For 1k / 5k / 20k due-demand waves, separately record:

- ECS wake + demand emission;
- existing route/private-car trip creation.

Wall-clock values are evidence, not CI thresholds.

Structural tests prove:

- the live engine shell has empty `sims` while ECS owns 200,000 citizens;
- runtime presentation reports `populationCount == 200_000` without serializing citizen rows;
- a quiet tick emits no demand/active trips;
- a due bucket emits exactly the citizens scheduled in that bucket in stable order;
- same durable fixture produces identical demand order and save snapshot;
- save -> restore -> save preserves stable Caelum IDs and durable values while ignoring runtime Entity handles;
- HPA-544 presentation wire shape is unchanged.

## File boundaries

- `crates/caelum-core/src/population/mod.rs` — durable/runtime conversion, population indexes, building reconciliation, public population seams.
- `crates/caelum-core/src/population/components.rs` — citizen ECS components only.
- `crates/caelum-core/src/population/schedule.rs` — scheduler resources, system sets, routine wake/demand emission.
- `crates/caelum-core/src/model.rs` — v10 durable citizen/activity/purpose types.
- `crates/caelum-core/src/engine.rs` — world/schedule ownership, candidate commit, durable snapshot reconstruction, runtime presentation.
- `crates/caelum-core/src/trips.rs` — scheduler boundary integration, demand routing, terminal resolution collection.
- `crates/caelum-core/src/buildings.rs` / `transit.rs` — shell-only mutation, no latent-population authority.
- `crates/caelum-core/src/persistence/*` — v10 validation before ECS build.
- `crates/caelum-core/src/presentation.rs` — shared frame projector plus durable/runtime population sources.
- `crates/caelum-core/examples/presentation_scale.rs` + `docs/performance/hpa-347-ecs-population.md` — scale evidence.
- `src/domain/types.ts` / `src/runtime/backend/types.ts` — durable v10 host wire only; live `GameState` stays aggregate.

The two population submodules are the only planned split. Do not build a generic ECS framework or further layer the code unless implementation proves a focused file has another independently large responsibility.

## Acceptance mapping

HPA-347 is complete when:

- the 200k fixture is actually ECS-owned;
- ordinary tick/presentation does not reconstruct or scan full `Sim[]`;
- future-away citizens cost scheduler/index bookkeeping only until due;
- work/school/day-off/optional routines emit stable `TripDemand` rows;
- active trips still use the current route/transit/private-car pipeline;
- terminal trips schedule the citizen's next ECS activity;
- move-in/workplace/demolition semantics use indexed ECS authority;
- save/restore reconstructs via stable Caelum IDs and never persists Bevy entities;
- schema-v9 dev saves are rejected;
- HPA-544 presentation shape stays compatible;
- reference evidence records construction, quiet tick, due-bucket emission, route-spawn, save, and presentation costs;
- any remaining route-wave/rendering bottleneck is named for HPA-348/HPA-640 rather than hidden behind another abstraction.
