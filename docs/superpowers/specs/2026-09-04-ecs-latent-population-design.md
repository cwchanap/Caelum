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
5. Preserve the current Worker/NonWorker commute behavior through the ECS ownership cutover before adding new demand semantics.
6. After that parity/quiet-tick gate, complete the HPA-347 product scope: school, return-home, one deterministic day off, and one bounded optional outing without per-frame citizen AI.
7. Preserve delayed sandbox housing move-in, finite workplace capacity, stable assignment, demolition cleanup, and current trip semantics.
8. Preserve HPA-544 `PresentationUpdate` shape; the frontend never learns about ECS or latent citizen rows.
9. Keep save/restore candidate-first and deterministic.
10. Deliver dependency/toolchain change, runtime migration, persistence cutover, tests, and scale evidence in this one PR.

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

`GameEngine` stops implementing `Clone`. Current clone uses are test-fixture conveniences and reconstruct an independent engine from a durable fixture when needed.

## Delivery staging

The migration and the new city-demand rules are deliberately separated inside the same HPA-347 PR.

### Stage A — ownership/parity

Move the current Worker commute model to ECS scheduling with current effective behavior:

- current workers keep existing shift/departure rules;
- current NonWorkers remain non-travelling;
- no day-off suppression;
- no student school trips;
- no optional outings.

At the end of this stage, record a worker-only 200k quiet-tick measurement. The ECS cutover must demonstrate that dormant population no longer drives ordinary quiet-tick work before new demand behavior is enabled.

### Stage B — HPA-347 demand expansion

After the Stage-A gate is recorded, replace the temporary v9 adapter with schema v10 and activate the ticket-required student/day-off/optional rules in a later commit on this same PR.

This preserves parity isolation without creating a second ticket or PR for behavior already required by HPA-347.

## Dependency and toolchain

Use only standalone ECS:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

`bevy_ecs 0.19.1` requires Rust 1.95.0, so set `rust-version = "1.95"` in all three Rust packages: `caelum-core`, `caelum-wasm`, and `src-tauri`.

Do not add full `bevy`, `bevy_app`, reflection, Bevy serialization, async executor, `multi_threaded`, or `rand`. This slice uses one explicitly ordered schedule. Parallel execution can be considered only after the new runtime shape is measured.

The dependency landing must compile the actual WASM target immediately, not only the native workspace rlib build.

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

`ScheduledActivityKind` and `ScheduledActivity` are introduced as the final types before the ownership cutover, even while the branch still serializes v9 `Sim`. The temporary adapter converts v9 daily flags into these final kinds; there is no throwaway activity enum.

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

A Bevy `Entity` contains index + generation. If its slot is recycled after despawn, the old generational handle is stale rather than identifying the replacement entity. Therefore the runtime-only queue may keep `Entity` without cloning a citizen-ID `String` into every future event.

The scheduler must still treat stale events deliberately: resolving a drained `Activity { entity }` that no longer exists is a no-op. A regression test despawns a scheduled citizen, spawns a replacement, and proves the stale event cannot emit demand for the replacement.

### `PopulationIndex`

One rebuildable resource owns only derived lookup/reverse-index state:

- `CitizenId -> Entity` lookup;
- building metadata needed by population logic;
- residents by housing building;
- workers by workplace building;
- deterministic unassigned-worker IDs;
- free workplace slots in stable building-ID order;
- placed school buildings;
- placed optional-outing destination buildings.

Use BTree-backed collections wherever iteration order affects assignment/demand. `CitizenId` components and `by_id` remain the identity source; `residents_by_building` / `workers_by_building` are reverse indexes, never the only identity of a citizen.

### `NextCitizenOrdinal`

ID allocation is separate from `PopulationIndex`:

```rust
#[derive(Resource)]
struct NextCitizenOrdinal(usize);
```

It starts at `max(existing sim suffix) + 1` when a world is built and advances monotonically during that runtime. It is allocator state, not a derived index, so deleting the highest-ID citizen does not make incremental index-consistency checks falsely expect the allocator to move backwards.

On save/restore, only live citizens are durable. A fresh world rebuilds the allocator from the maximum currently persisted citizen ID, matching the existing development-save posture.

### Mailboxes

`DuePopulationEvents` and `PendingTripDemands` are short-lived vectors cleared each schedule run. They are ordering seams between systems, not persisted state.

## Derived-index consistency

Incremental indexes are performance caches and must be provably rebuildable.

In tests only, provide a rebuild/assert helper that queries all live citizen components plus the current shell building list and rebuilds a fresh `PopulationIndex`. After every tested move-in, `run_due`, reassignment, housing removal, and workplace removal, assert that the rebuilt index equals the live index.

Do not run a full rebuild in production. Test `NextCitizenOrdinal` separately as monotonic allocator state.

## Schedule order and same-bucket determinism

Own one standalone schedule with explicit chained sets:

```text
CollectDue -> ApplyDue -> EmitTripDemand
```

- **CollectDue:** drain buckets whose boundary is `<= PopulationClock.now`.
- **ApplyDue:** process only the drained move-in/citizen events.
- **EmitTripDemand:** append demand rows in deterministic stable order.

Before `ApplyDue`, canonicalize the drained batch:

1. `MoveIn` events sort by `(building_id, slot)`;
2. `Activity` events sort by the resolved `CitizenId` of the still-live entity;
3. missing/stale `Activity` entities are dropped.

This preserves the current housing-ID/slot allocation order even when multiple houses share one minute bucket. A two-house same-minute test inserts events in reverse order and proves stable `sim-NNN` allocation and home assignment.

`run_due` may rerun the schedule if processing creates another event in the already-current bucket; this closes same-time work without a population scan.

## Stage-A current commute state machine

Before new demand semantics are activated, ECS reproduces the current model:

- current Worker -> existing shift/departure behavior;
- current NonWorker -> runtime `Student` identity but emits no trip;
- assigned idle worker at the outbound boundary -> `CommuteOutbound`;
- successful/late outbound -> schedule `PrimaryReturn` at the existing return time;
- successful/late return -> settle home and schedule the next day's `DailyRoutine`;
- unserved outbound/return preserves the current stranded/recovery behavior without zero-distance phantom trips.

### Existing guards that remain contracts

The cutover explicitly preserves these current guards:

1. **Sandbox-only move-in.** Housing added in Campaign does not schedule resident move-ins. Existing campaign growth can place houses while population remains unchanged.
2. **Late workplace assignment.** If a worker receives a workplace after today's outbound departure has already passed, do not emit an immediate late outbound; schedule the next eligible daily wake.
3. **In-progress trip across midnight.** A travelling citizen has no `NextActivity`. No scheduler event may create a second outbound/return while that active trip is unresolved. A regression test advances an active return across midnight and proves no phantom same-day trip appears.

These are migration parity requirements, not optional edge hardening.

## Stage-B routine expansion

Only after the worker-only quiet-tick gate is recorded does the PR activate the new HPA-347 demand behavior.

### Worker/student split

Every tenth citizen ordinal is persisted as `Student`; the other 90% are `Worker`. Worker shift selection and outbound/return windows reuse the existing `shift_template_for_id` / `departure_minute_for_sim` rules.

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

The existing transit-income rule is purpose-agnostic. Therefore an optional/student journey that completes using Bus/Metro earns the same existing fixed transit income as any other completed transit journey; HPA-347 does not create a second fare rule.

### Final state machine

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

Housing move-ins remain building-driven, sandbox-only, and paused with the engine.

When a runtime is built or sandbox housing is added, derive occupied slots from `PopulationIndex` and schedule the remaining slots from `PlacedBuilding.placed_at` using the existing `MOVE_IN_INTERVAL_SECONDS`. Campaign housing does not schedule move-ins.

A move-in event:

1. verifies the housing building still exists and the slot remains open;
2. allocates the next stable `sim-NNN` ordinal from `NextCitizenOrdinal`;
3. spawns one citizen entity;
4. assigns a workplace if capacity exists;
5. updates reverse indexes;
6. schedules the first `DailyRoutine`, preserving the late-assignment/departure guard.

Pure `buildings.rs` / `transit.rs` snapshot mutation helpers become shell-only because preview code also calls them. Once `GameEngine` accepts a building-changing candidate, a focused ECS reconciliation receives before/after building lists plus the candidate active trips/vehicles.

Targeted reconciliation rules:

- added housing -> in Sandbox only, schedule missing move-in slots;
- added workplace -> fill free slots from sorted unassigned-worker IDs; if today's departure is already past, do not create today's outbound;
- removed housing -> find residents through `residents_by_building`, despawn them, remove their active trips, and scrub vehicle passenger IDs;
- removed workplace -> find workers through `workers_by_building`, clear/reassign them, and retarget/drop affected outbound trips using the existing Idle/patience/deadline reset semantics;
- removed school/optional destination -> only in Stage B, cancel affected outbound trips and schedule the citizen's next sensible activity.

Growth-wave building additions use the same reconciliation after the existing growth executor mutates the shell. Campaign growth never gains sandbox move-in as a side effect. Do not add a second growth path.

## Presentation

Do not change the HPA-544 wire.

Keep `presentation::project_update(&GameSnapshot, include_scene)` as the pure durable-snapshot projector used by parity tests and the existing snapshot harness.

Add a runtime projector used by `GameEngine` that takes the live shell plus ECS population aggregates. Factor one shared frame builder so all non-population presentation remains single-source.

Runtime population fields come from ECS/indexes:

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
3. project them to stable-ID `Sim` rows;
4. stable-sort by `Sim.id`;
5. populate service metrics / normal save derivations as today.

Ordinary tick/dispatch/presentation paths do not call these functions.

### Restore

Restore remains candidate-first:

1. deserialize and validate the complete v10 `GameSnapshot`;
2. compile topology;
3. build a fresh ECS world/index/scheduler from the validated sims;
4. clear sims from the candidate live shell;
5. create the population schedule;
6. produce candidate presentation;
7. only then replace the current engine.

No Bevy `Entity` value is serialized.

A saved citizen with an active trip must have `nextActivity = null`; an idle citizen must have exactly one next activity. Use the existing structured persistence error channel for violations.

## Test seam after the cutover

Production `GameEngine::tick` is the only live owner that advances shell + ECS together.

Current tests that directly call `trips::tick_trips(&GameSnapshot, ...)` must not preserve a second production population path. Retarget integration tests through a shared test helper that:

1. converts the fixture into a valid durable candidate;
2. constructs `GameEngine` from that candidate;
3. restores the fixture's intended paused/speed state;
4. calls `GameEngine::tick`;
5. returns `engine.snapshot()`.

`golden_sequences.rs`, `shuttle_service.rs`, `trip_lifecycle.rs`, and growth module tests are explicitly part of that migration. Unit tests inside `trips.rs` may use a local equivalent helper.

## Determinism

Determinism is explicit rather than relying on Bevy query order or hash iteration:

- move-in events: bucket -> building ID -> slot;
- activity events: bucket -> exact due time -> stable `CitizenId` -> explicit purpose rank;
- workplace assignment: workplace building ID -> slot -> stable citizen ID;
- school/optional selection: stable citizen/day seed + BTree-sorted candidate buildings;
- durable citizen projection: stable citizen ID;
- same-time `TripDemand`: exact scheduled time -> citizen ID -> purpose rank.

Bevy `Entity` is only a runtime lookup handle and never a deterministic sort key.

## Performance evidence

Reuse the HPA-544 native example instead of introducing a benchmark framework.

### Before cutover

Record 10k / 50k / 200k quiet population-tick time from current main.

### Stage-A gate

Immediately after worker-only ECS ownership lands, record a 200k worker-only quiet-tick reference on the same machine. This is the gate before Stage-B demand expansion. It is evidence, not a CI threshold.

### Final

Measure:

- 10k / 50k / 200k runtime construction;
- quiet tick;
- runtime presentation;
- explicit full snapshot reconstruction;
- 1k / 5k / 20k same-bucket due-demand scheduler emission;
- route creation for those waves as a separate number.

No wall-clock value becomes a CI threshold. Structural tests prove that a 200k world with only N due citizens processes exactly N population events/demands. If routing dominates the wave after scheduler work is reduced, record that bottleneck for HPA-348.

## Acceptance

HPA-347 is complete when:

1. standalone `bevy_ecs` is load-bearing and the workspace/WASM target compile on Rust 1.95+;
2. `GameEngine` owns `World` + one ordered population `Schedule` and live `snapshot.sims` is empty;
3. dormant citizens are absent from ordinary population scans and the worker-only 200k quiet-tick evidence is recorded before new demand is activated;
4. due events are time-bucketed, same-bucket move-ins/activities are canonically ordered, and stale generational entity events drop safely;
5. `PopulationIndex` is test-rebuildable after incremental mutations while `NextCitizenOrdinal` is tested separately as monotonic allocator state;
6. current sandbox move-in, late workplace-assignment, cross-midnight active-trip, Worker commute, private-car, demolition, and route behavior remains green at the ownership cutover;
7. final v10 saves persist `CitizenRoutine` + one next activity, reject v9, and persist no Bevy entity IDs;
8. later in the same PR, student/day-off/optional demand is enabled with deterministic tests as required by HPA-347;
9. HPA-544 presentation stays behaviorally/wire equivalent and contains no latent citizen rows;
10. representative 200k and due-wave measurements are recorded, with route choice left to HPA-348 if it is the remaining bottleneck;
11. full Rust, WASM, TypeScript, and Playwright gates pass.
