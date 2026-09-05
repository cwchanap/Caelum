# HPA-347 ECS Latent Population Design

**Linear:** HPA-347 — [Scale] Add ECS-backed latent population schedules and transport-demand generation

**Status:** Proposed implementation design

## Context

HPA-544 is complete. The frontend now consumes the compact `PresentationUpdate { scene, frame }` contract and no longer needs one wire row per latent citizen. Its scale harness shows the presentation payload stays roughly flat even when a synthetic durable snapshot contains 200,000 sims.

That removed the browser serialization bottleneck, but the simulation core still treats every citizen as ordinary `GameSnapshot` state:

- `GameEngine` owns `GameSnapshot` and clones it through tick/dispatch paths.
- `population::apply_due_move_ins`, resident/job occupancy, and `buildings::assign_workplaces` walk `snapshot.sims`.
- `trips::spawn_due_commute_trips`, `reset_daily_commute_flags`, and `next_boundary_after` scan all sims during ordinary simulation work.
- `max_tick_substeps` derives its event budget from `sims.len()`.
- trip completion mutates a matching `Sim` by searching the vector.
- building removal/reassignment reaches into `snapshot.sims` from `transit.rs`.

At the target scale, 200,000 dormant citizens therefore still participate in snapshot cloning and repeated scheduling scans even when almost none of them are due to do anything.

HPA-347 is the first load-bearing Bevy slice. It is not a framework experiment and it is not a full engine rewrite.

## Goals

1. Make standalone `bevy_ecs` the sole live owner of latent citizens and their activity schedule.
2. Keep durable save/restore identity in Caelum domain IDs; Bevy `Entity` values never cross persistence or presentation boundaries.
3. Advance a 200,000-citizen population without scanning all citizens at each trip substep.
4. Batch same-time activity wakeups through a time-indexed scheduler and emit deterministic `TripDemand` records into the existing routing/trip pipeline.
5. Support regular work, school, return-home, day-off, and bounded optional outing routines without per-frame citizen AI.
6. Preserve housing capacity, finite workplace capacity, move-in timing, stable workplace assignment, demolition cleanup, and the compact HPA-544 presentation wire.
7. Keep save/restore candidate-first and deterministic.
8. Deliver the dependency/toolchain change, runtime migration, tests, and scale evidence in this one HPA-347 PR.

## Non-goals

- Moving route graphs, transit vehicles, active-trip movement, traffic aggregation, economy, or catalogs into ECS.
- Per-citizen pathfinding while dormant.
- Batched route choice/traffic demand processing; HPA-348 owns that next optimization.
- WebGPU, render cadence, viewport/LOD, interpolation, or GPU batching; HPA-640 owns those.
- Rendered citizens or private-car entities.
- Household, needs/mood, social, education-capacity, or visitor-capacity simulation.
- A generic simulation framework/plugin layer around Bevy.
- A compatibility loader for old development saves. This cutover may bump the snapshot schema and replace the old `Sim` persistence shape directly.

## Approaches considered

### A. Put the existing snapshot inside an ECS resource

Create a Bevy `World`, insert `GameSnapshot` as a resource, and run the existing functions as systems.

This has the smallest diff, but it is not load-bearing ECS. The 200,000 `Sim` rows would still be cloned/scanned exactly as today and there would be two layers without a performance win.

**Reject.**

### B. Move the whole simulation to ECS in one PR

Convert citizens, active trips, vehicles, routes, road/track topology, buildings, traffic, and economy to components/resources at once.

This would eventually be coherent, but it expands HPA-347 across unrelated mature seams, obscures the actual performance target, and makes parity failures hard to isolate. HPA-348 and HPA-640 already own later scale slices.

**Reject.**

### C. ECS owns latent population; existing Rust modules own active transport and city systems

`GameEngine` owns a Bevy `World` and one explicitly ordered population schedule. Citizen entities live only in that world. The ordinary runtime `GameSnapshot` becomes the shell for map/buildings/transit/active trips/economy/etc. and intentionally carries an empty `sims` vector. Full `Sim[]` is reconstructed only for durable snapshots.

A time-bucket resource wakes only due population events. Those systems emit small `TripDemand` records, and the existing trip/router/traffic code turns those demands into active trips. Trip terminal results are fed back into the ECS citizen so its next activity can be scheduled.

This removes the high-cardinality dormant scan without forcing unrelated systems into ECS.

**Choose C.**

## Dependency and toolchain

Use standalone `bevy_ecs` only:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

`bevy_ecs 0.19.1` requires Rust 1.95.0. Raise `rust-version` from `1.77.2` to `1.95` in all three workspace packages (`caelum-core`, `caelum-wasm`, and `src-tauri`) so the workspace advertises one honest floor.

Do not add full `bevy`, `bevy_app`, reflection, serialization, async executor, or `multi_threaded` in this slice. The ECS schedule is deliberately single-threaded and explicitly ordered first; HPA-347 needs deterministic load-bearing ownership more than scheduler parallelism. A later benchmark may justify enabling Bevy multithreading, but it is not required to remove the O(population) idle scan.

Do not add `rand`. Seeded optional-activity variation can use a tiny deterministic integer mixer over stable citizen ordinal + day + salt.

## Runtime ownership

After the cutover:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,        // live shell; snapshot.sims is always empty
    road_topology: RoadTopology,
    world: bevy_ecs::world::World,
    population_schedule: bevy_ecs::schedule::Schedule,
}
```

The invariant is intentional:

- **live population authority:** ECS components/resources in `world`;
- **live active transport authority:** existing `snapshot.active_trips` and transit state;
- **durable population authority:** reconstructed `GameSnapshot.sims` returned by `snapshot()` / `snapshot_for_save()`;
- **presentation authority:** existing `PresentationUpdate` wire, sourced from shell state plus ECS aggregate indexes.

There is never a live `Vec<Sim>` mirroring the ECS citizens.

`GameEngine` should no longer derive `Clone`. Current clone uses are test-fixture conveniences. Retarget them through explicit fixture construction/durable snapshots rather than defining a production contract that deep-clones a 200,000-entity world.

## Durable citizen model

The existing four daily commute booleans exist mainly because every day is rediscovered by scanning `Vec<Sim>`. Replace that persistence shape when moving to scheduled activities.

Keep the `sims` wire key and stable string `Sim.id`, but make each row a compact durable projection of the ECS-owned citizen:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitizenRoutine {
    Worker {
        shift_template: String,
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

`position` is the last settled location. While the citizen is travelling, movement authority stays in `ActiveTrip`; `next_activity` is `None`. When a terminal trip resolves, the ECS citizen updates its settled position and schedules the next activity.

Extend `TripPurpose` with `OptionalOutbound` and `OptionalReturn`. Keep the existing `CommuteOutbound`/`CommuteReturn` names for worker and student primary trips so the mature trip scoring/routing path needs minimal semantic churn.

Bump `SNAPSHOT_SCHEMA_VERSION` from 9 to 10. No v9 migration layer is added.

## ECS components

Use a small set of data-oriented components; do not create behavior traits or one component per boolean:

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

The runtime-only building IDs make occupancy/reassignment/removal indexed operations. The durable `Sim` projection keeps point-based home/workplace fields because routing and the existing save contract are point-oriented.

A citizen with no `NextActivity` must have an active trip. Persistence validation should reject a saved citizen that simultaneously has an active trip and a scheduled next activity.

## ECS resources

Keep the resources focused and few:

### `PopulationClock`

Current simulation timestamp supplied by the trip substep driver before the population schedule runs.

### `PopulationScheduler`

```rust
struct PopulationScheduler {
    buckets: BTreeMap<u64, Vec<PopulationEvent>>,
}
```

A key is one in-game-minute bucket. Convert a due timestamp to the **first bucket boundary at or after** that timestamp, so bucketing never executes an activity early. One-minute bucketing bounds population scheduling boundaries by time, not citizen count, while shifting an event by less than one in-game minute at most.

Events are either:

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

The queue may hold runtime `Entity` IDs because it is never serialized. Stable ordering is recovered from `CitizenId` before demand emission.

### `PopulationIndex`

One derived resource owns the indexes needed to avoid whole-population scans:

- stable `CitizenId -> Entity` lookup;
- next citizen ordinal for O(1) `sim-NNN` allocation;
- housing/building metadata derived from `PlacedBuilding` + the existing catalog;
- residents by housing building;
- workers by workplace building;
- deterministic unassigned-worker set;
- free workplace slots in stable building-ID order;
- current school buildings and optional-outing destination buildings.

The index is runtime-only and fully rebuildable from the durable snapshot. It is not a second authoritative population model.

### `DuePopulationEvents` and `PendingTripDemands`

Short-lived vectors cleared each population schedule run. They are mailboxes between explicitly ordered systems, not persistent state.

## Explicit schedule order

Create one Bevy schedule owned by `GameEngine` with explicit chained system sets:

```text
CollectDue -> ApplyDue -> EmitTripDemand
```

- **CollectDue:** drain scheduler buckets whose boundary is `<= PopulationClock.now`.
- **ApplyDue:** process move-ins and target only the due citizen entities; create/update `NextActivity` state as needed.
- **EmitTripDemand:** sort due citizen activities by stable citizen ID and append deterministic `TripDemand` rows.

No system in these sets queries every citizen. Due citizen entities come from the drained bucket and are accessed directly by `Entity`/stable-ID index.

`population::run_due(...)` may rerun the schedule while a system schedules another event into the already-current bucket (for example an exactly-due activity created by a move-in). This closes same-timestamp work without an all-citizen scan.

## Routine model

Keep routine generation deterministic and intentionally small.

### Worker profile

Preserve the current effective worker ratio: every 10th stable citizen ordinal is a student; the other 90% are workers. Worker shift-template distribution and commute departure windows reuse the existing `shift_template_for_id` / `departure_minute_for_sim` logic.

Finite workplace capacity is unchanged. Workers are assigned to free slots in sorted workplace-ID order, with citizen IDs as the stable tie-breaker. Unassigned workers stay unassigned until capacity exists.

### Student profile

Students choose a school from currently placed `school` buildings in stable building-ID order, with the citizen/day seed selecting among them. This slice does **not** add enrollment capacity. If there is no school, that citizen has no primary trip that day.

Use a school outbound window of 07:30–08:30 and a return window of 15:00–16:00, with deterministic citizen/day jitter.

### Day off

Each citizen gets exactly one deterministic day off in a seven-day cycle:

```text
day % 7 == numeric_id_suffix(citizen_id) % 7
```

A day off suppresses the primary work/school trip.

### Optional outing

On a day off, at most one optional outing may be emitted. Use a stable citizen/day seed; only one in four eligible day-off citizens takes an outing. Eligible destination building types in this slice are:

- `supermarket`
- `cinema`
- `clinic`
- `parkPlaza`

Pick from placed eligible buildings in stable ID order and then choose a footprint tile deterministically. Depart between 11:00 and 15:00. After successful arrival, schedule `OptionalReturn` after 120 in-game minutes. No visitor capacity, shopping economy, or additional stops are modeled.

This gives seeded variation and non-work demand without becoming a needs simulator.

### Next-activity state machine

A citizen owns only one scheduled activity at a time:

1. `DailyRoutine` wakes the citizen for that day.
2. If primary work/school applies, emit `CommuteOutbound`; otherwise optionally emit `OptionalOutbound`; otherwise schedule the next day's `DailyRoutine`.
3. When a primary outbound trip arrives, schedule `PrimaryReturn` at that routine's return time, or the current bucket if already late.
4. When an optional outbound trip arrives, schedule `OptionalReturn` after the fixed dwell.
5. A return arrival schedules the next day's `DailyRoutine`.
6. An unserved outbound/return schedules the next sensible daily wake/return without creating a phantom zero-distance trip.

This replaces the global daily flag reset.

## Trip-demand bridge

Add one plain Rust value owned by the population module:

```rust
struct TripDemand {
    citizen_id: String,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    scheduled_time: f64,
}
```

The ECS systems do not route. `trips.rs` drains `PendingTripDemands` and feeds each row through the existing `build_commute_trip` / route-plan / private-car choice logic. Same-time demands are already stable-sorted before this bridge, so trip sequence allocation remains deterministic.

This intentionally leaves route-choice cost proportional to the number of due demands. HPA-348 owns batching that next; HPA-347 only removes dormant-citizen work from that path.

## Trip resolution back into ECS

Refactor the active-trip result pass to collect compact terminal resolution rows before terminal trips are removed:

```rust
struct PopulationTripResolution {
    citizen_id: String,
    purpose: TripPurpose,
    status: TripStatus,
    destination: Point,
    resolved_at: f64,
}
```

The substep driver applies those rows through `population::apply_trip_resolutions(...)`:

- arriving outbound updates `SettledPosition` and schedules a return;
- arriving return updates position to home and schedules next daily wake;
- unserved trips leave settled position unchanged and schedule the appropriate future activity;
- a terminal resolution clears the implicit travelling state by inserting the next `NextActivity`.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`; there is no live `snapshot.sims` to mutate.

## Time-boundary integration

Replace population-dependent scans in `trips.rs` with scheduler queries:

- `spawn_due_commute_trips` -> drain/route `PendingTripDemands`;
- delete `reset_daily_commute_flags`;
- `next_boundary_after` asks `PopulationScheduler` for its next bucket boundary;
- `max_tick_substeps` adds the number of scheduled population buckets in the tick window, not `sims.len() * events_per_day`;
- remove `remaining_move_in_slots`; move-ins already occupy scheduler buckets.

The active-trip and vehicle boundary logic remains unchanged.

## Move-in and building capacity

Housing move-ins remain building-driven and delayed while paused.

When the runtime is built or a housing building is placed, derive currently occupied slots from `PopulationIndex` and schedule the remaining slot events from `PlacedBuilding.placed_at` using the existing `MOVE_IN_INTERVAL_SECONDS`. A move-in event:

1. verifies the housing building still exists and the slot is still open;
2. allocates the next stable `sim-NNN` ID from the runtime sequence;
3. spawns one ECS citizen entity;
4. assigns worker capacity if applicable;
5. updates reverse occupancy indexes;
6. schedules the citizen's first `DailyRoutine` (skipping today's already-passed primary departure, matching the current late-move-in rule).

No move-in event scans all existing citizens.

## Building mutation reconciliation

Population-dependent mutation must leave `buildings.rs`/`transit.rs` snapshot helpers because those helpers are also used by preview code and the live snapshot no longer owns citizens.

Pure snapshot mutation continues to produce the shell candidate. After `GameEngine` commits a candidate whose building set changed, call a focused ECS reconciliation with the before/after building lists and the live active-trip/vehicle collections.

Use the runtime indexes so the common mutations are targeted:

- **new housing:** schedule remaining move-in slots;
- **new workplace:** fill slots from the stable unassigned-worker set;
- **removed housing:** find residents through `residents_by_building`, despawn them, and remove their active trips/passenger references;
- **removed workplace:** find assigned workers through `workers_by_building`, clear/reassign them in stable order, and retarget/drop affected outbound trips using the current patience/deadline reset semantics;
- **removed school/optional destination:** retarget or cancel only outbound trips whose destination disappeared; schedule the next appropriate activity if cancellation leaves the citizen idle.

Growth-wave building additions use the same reconciliation after growth mutates the shell. Do not introduce a second growth path.

Direct pure-function tests for `transit::remove_at_tile` should stop asserting population mutation. Population semantics belong to `GameEngine` integration tests after this cutover.

## Presentation

Do not change the HPA-544 wire.

Keep `presentation::project_update(&GameSnapshot, include_scene)` as the pure durable-snapshot projector used by parity tests and the existing baseline harness.

Add a runtime projection path used by `GameEngine` that takes the live shell plus ECS aggregate population data. Factor only the small shared input needed by `project_frame`; do not duplicate the whole projector and do not construct a 200,000-row durable snapshot just to render a frame.

Runtime population presentation comes from `PopulationIndex`:

- `populationCount` = indexed citizen count;
- residential building occupancy = indexed residents for that building;
- job building occupancy = indexed assigned workers for that building.

Students do not change the existing job-occupancy meaning of the school building row in this slice.

Platform occupancy, traffic flow, demand flow, vehicles, service metrics, map, buildings, routes, and stations remain sourced exactly as HPA-544 does today.

Refactor `GameplayUpdateResult` constructors to accept a precomputed `PresentationUpdate` rather than internally calling the pure snapshot projector; otherwise tick/dispatch would accidentally rebuild a full durable population.

## Save and restore

### Save / full snapshot

`GameEngine::snapshot()` and `snapshot_for_save()` are explicitly expensive durable/debug operations:

1. clone the live shell;
2. query all citizen entities;
3. project each entity into durable `Sim`;
4. sort by stable `Sim.id`;
5. install that vector into the cloned snapshot;
6. normalize derived save fields as today.

Ordinary tick/dispatch/presentation must never call this path.

### Restore

Keep candidate-first restore:

1. probe/check schema;
2. deserialize and validate the full v10 `GameSnapshot`, including sims and active-trip references;
3. compile road topology and normalize derived shell fields;
4. build a fresh `World`, `PopulationIndex`, scheduler buckets, and schedule from the validated candidate;
5. verify runtime population invariants;
6. clear `candidate.sims` to create the live shell;
7. replace the current engine only after the entire candidate is ready.

Bevy `Entity` values are allocated afresh and are never persisted.

Persistence validation should additionally enforce:

- `Sim.home` resolves to a residential building footprint;
- worker workplace, when present, resolves to a job-capacity building;
- `next_activity.due_time` is finite/non-negative;
- a sim referenced by an active trip has `next_activity == None`;
- a sim without an active trip has exactly one future/current `next_activity`;
- stable sim IDs remain unique.

## Determinism

Determinism must not depend on Bevy entity allocation or hash-map iteration.

Use these tie-breakers everywhere:

1. scheduled bucket;
2. stable `CitizenId` string;
3. explicit activity-purpose rank where one citizen can emit more than one transition at the same timestamp.

Use `BTreeMap`/`BTreeSet` for population indexes whose iteration order affects assignment or demand emission. Runtime `Entity` is only a lookup handle.

The ECS schedule sets are explicit and chained. `multi_threaded` is disabled in this slice.

## Performance evidence

Extend the HPA-544 native harness shape instead of creating a benchmark framework.

Keep the existing presentation measurements and add runtime population rows for 10k / 50k / 200k citizens:

- candidate snapshot -> ECS runtime construction time;
- quiet tick with all next activities in the future;
- population schedule run with a representative due bucket;
- full `snapshot()` reconstruction cost (documented as save/debug-only);
- runtime presentation projection size/time.

Also measure representative demand waves (for example 1k / 5k / 20k due citizens) and explicitly separate:

- ECS wake/demand-emission time;
- existing route-choice/active-trip creation time.

The latter may become the recorded bottleneck that HPA-348 addresses. Wall-clock values remain reference evidence, not brittle CI thresholds.

Structural CI assertions should prove:

- runtime `snapshot.sims` is empty;
- 200k citizens exist in ECS and project a `populationCount` of 200k;
- quiet advancement does not emit demand or grow active trips;
- only citizens in due buckets are touched/emitted;
- same fixture + same seed produces identical demand order and durable save snapshot;
- save -> restore -> save uses stable Caelum IDs but different runtime `Entity` IDs;
- HPA-544 presentation wire remains unchanged.

## File boundaries

Prefer focused files without creating a framework:

- `crates/caelum-core/src/population.rs` — durable/runtime conversion, building-capacity reconciliation, public population helpers.
- `crates/caelum-core/src/population/components.rs` — citizen components only.
- `crates/caelum-core/src/population/schedule.rs` — scheduler resources, system sets, routine wake/demand emission.
- `crates/caelum-core/src/model.rs` — v10 durable `Sim`/routine/activity and optional trip-purpose wire types.
- `crates/caelum-core/src/engine.rs` — owns `World`/`Schedule`, candidate commit/reconcile, runtime presentation, durable snapshot reconstruction.
- `crates/caelum-core/src/trips.rs` — population boundary query, `TripDemand` routing bridge, terminal-resolution collection.
- `crates/caelum-core/src/buildings.rs` / `transit.rs` — remove direct `Sim` ownership assumptions.
- `crates/caelum-core/src/persistence/*` — validate v10 durable citizen state before runtime build.
- `crates/caelum-core/src/presentation.rs` — one shared frame projector plus snapshot/runtime population sources.
- `crates/caelum-core/examples/presentation_scale.rs` and `docs/performance/hpa-347-ecs-population.md` — reference scale evidence.
- `src/domain/types.ts` / `src/runtime/backend/types.ts` — durable v10 save wire only; no reintroduction of sims to live `GameState`.

The two population submodules are justified because the current single `population.rs` would otherwise accumulate ECS component definitions, scheduler systems, persistence conversion, capacity assignment, and mutation reconciliation in one large file. Do not split further unless implementation proves another responsibility is independently large.

## Acceptance mapping

HPA-347 is done when:

- the 200k citizen fixture is actually held as ECS entities;
- ordinary ticks/presentation do not reconstruct or scan a full `Sim[]`;
- future-away citizens cost only scheduler/index bookkeeping until their bucket is due;
- due work/school/optional routines produce stable ordered `TripDemand` rows;
- active trips still use the existing route/transit/private-car pipeline;
- terminal trips schedule the citizen's next ECS activity;
- move-in/workplace/demolition semantics run through indexed ECS authority;
- save/restore reconstructs by stable Caelum IDs and never persists Bevy entities;
- the HPA-544 presentation contract remains byte-shape compatible;
- v9 development saves are rejected rather than migrated;
- performance evidence records construction, quiet-tick, due-bucket, save, and demand-wave costs;
- any remaining scale bottleneck is named precisely for HPA-348/HPA-640 rather than hidden behind another abstraction.
