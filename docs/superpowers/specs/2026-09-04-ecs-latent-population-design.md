# HPA-347 ECS Latent Population Design

**Linear:** HPA-347 — [Scale] Add ECS-backed latent population schedules and transport-demand generation

**Status:** Proposed implementation design

## Context

HPA-544 is complete. Ordinary frontend traffic now crosses the compact `PresentationUpdate { scene, frame }` boundary, so the browser no longer needs one row per latent citizen. The remaining scale problem is inside `caelum-core`: `GameSnapshot.sims` is still the live population store and ordinary ticking repeatedly clones or scans it.

Today the high-cardinality work is concrete:

- `population::apply_due_move_ins` and occupancy helpers scan `snapshot.sims`;
- `buildings::assign_workplaces` scans the population;
- `trips::spawn_due_commute_trips`, `reset_daily_commute_flags`, and `next_boundary_after` scan every sim;
- `max_tick_substeps` derives part of its budget from population count and widens that budget when move-ins grow `sims` mid-tick;
- terminal trip handling searches `snapshot.sims` by citizen ID;
- building removal/reassignment mutates citizens from snapshot-only helpers in `transit.rs`.

At about 200,000 citizens, dormant population therefore participates in ordinary substep cost even when very few citizens are due to act.

HPA-347 is the first load-bearing Bevy slice. It is not a Bevy proof-of-concept and not a whole-engine rewrite.

## Goals

1. Make standalone `bevy_ecs` the sole live owner of latent citizens and their next scheduled activity.
2. Keep durable identity in stable Caelum string IDs; Bevy `Entity` values remain runtime-only.
3. Advance a 200,000-citizen fixture without scanning all citizens on an ordinary quiet substep.
4. Wake citizens through a sparse time-indexed scheduler and emit deterministic `TripDemand` rows into the existing route/private-car pipeline.
5. Preserve current Worker commute behavior first, including coarse-tick/fine-tick equivalence, before adding the ticket-required school/day-off/optional demand semantics.
6. Preserve delayed housing move-in, finite workplace capacity, stable assignment order, demolition cleanup, late-workplace-assignment behavior, and cross-midnight active-trip behavior.
7. Preserve HPA-544 `PresentationUpdate` shape; the frontend never learns about ECS or latent citizen rows.
8. Keep save/restore candidate-first and deterministic.
9. Deliver dependency/toolchain change, runtime migration, persistence cutover, new routine demand, tests, and scale evidence in this one HPA-347 PR.

## Non-goals

- Moving map/route graphs, transit vehicles, active-trip movement, traffic aggregation, economy, or catalogs into ECS.
- Per-citizen pathfinding while dormant.
- Batched route choice or traffic-demand routing; HPA-348 owns that next.
- WebGPU, viewport/LOD extraction, publication cadence, or interpolation; HPA-640 owns those.
- Rendered citizens or private-car entities.
- Households, needs/mood, social simulation, school enrollment capacity, or visitor capacity.
- A generic Bevy plugin/framework layer.
- Backward compatibility with schema-v9 development saves.
- Splitting HPA-347 across multiple implementation PRs. Stage A and Stage B are separate commits/gates on the same PR.

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

`GameEngine` stops implementing `Clone`. Existing clone uses are tests and are retargeted to independently constructed engines.

## Tick commit unit: shell + ECS world

The current engine decides `applied` from `next_snapshot != current_snapshot`. That is no longer sufficient because a population activity can change only ECS state while leaving the shell byte-for-byte equal.

After the cutover, one tick commits **both** authorities together:

```text
(shell candidate, ECS mutations)
```

The trip driver reports whether population state changed during the call. `GameEngine::tick` uses:

```text
applied = shell_changed || population_changed
```

and retains the ECS mutations even when the shell candidate compares equal. There is no rollback layer and no discarded ECS candidate.

This preserves an existing subtle behavior: a running `tick(0.0)` may process work already due at the current timestamp. Therefore zero delta is **not** globally defined as a no-op. The required no-op cases are:

- paused engine;
- speed `0`;
- running zero-delta tick with no currently due population/world event.

A running zero-delta tick with a due activity must keep the ECS mutation, update any resulting shell state, and return `applied == true` when either authority changes.

Early objective termination and the release cap-fallback path keep all population mutations already applied up to the returned shell timestamp; neither path silently reverts one side of the commit unit.

## Dependency and toolchain

Use only standalone ECS:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Set `rust-version = "1.95"` in all three Rust packages: `caelum-core`, `caelum-wasm`, and `src-tauri`.

Do not add full `bevy`, `bevy_app`, reflection, Bevy serialization, async executor, `multi_threaded`, or `rand`. The schedule stays explicitly ordered and single-threaded in this slice.

The dependency task builds the real `wasm32-unknown-unknown` target immediately and records release WASM size before/after HPA-347. Artifact size is evidence, not a threshold.

## Runtime components

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

During the branch-local schema-v9 adapter, current `NonWorker` maps to runtime `Student` but remains non-travelling. No temporary activity-kind enum is introduced: the scheduler uses the final `ScheduledActivityKind` from its first implementation commit.

## Sparse scheduler: exact due-time buckets

The earlier one-minute `ceil(due_time / bucket_seconds)` design is rejected. `GAME_DAY_SECONDS / MINUTES_PER_DAY` is a repeating binary fraction, so exact integer-minute departures can round into the following bucket. It would also unnecessarily quantize housing move-ins, whose due timestamps are anchored to arbitrary `PlacedBuilding.placed_at` values.

Instead, group events by their **exact validated due timestamp**:

```rust
#[derive(Clone, Copy, Debug)]
struct ScheduledTime(f64);

struct PopulationScheduler {
    buckets: BTreeMap<ScheduledTime, Vec<PopulationEvent>>,
}
```

`ScheduledTime` accepts only finite, non-negative values, normalizes signed zero, and implements `Ord` with `f64::total_cmp`. There is no division/ceil bucket arithmetic.

Consequences:

- current Worker departures reuse the exact `scheduled_time_seconds(...)` value they already use;
- move-ins retain exact `placed_at + slot * MOVE_IN_INTERVAL_SECONDS` timing;
- optional dwell/return uses its exact computed due timestamp;
- `next_population_boundary` returns the earliest exact due timestamp still in the map;
- equal timestamps naturally share one bucket;
- far-future citizens impose only BTree scheduler bookkeeping, not a population query.

The existing `EPSILON` convention remains at the trip-loop boundary: current-time pre-processing drains scheduler keys due at or within the current due-equality band, and the existing boundary helper continues to handle tiny forward candidates consistently.

## Scheduled events and stale entities

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

Keeping `Entity` in the runtime-only queue is intentional. Bevy entity handles are `(index, generation)` identities; after despawn, a recycled slot has a different generation, so the old handle is invalid rather than aliasing the replacement.

`ApplyDue` must use a non-panicking entity lookup. A stale handle is dropped. A regression test must despawn a citizen, spawn a replacement that can reuse the slot, advance to the old event, and prove the replacement receives no demand.

Stable `CitizenId` is still the durable identity and the deterministic sort key. `Entity` is never serialized, presented, or used to order externally visible behavior.

## Runtime resources

### `PopulationClock`

Current simulation timestamp supplied by the substep driver.

### `PopulationIndex`

One rebuildable derived resource owns the targeted lookups needed to avoid global scans:

- `CitizenId -> Entity`;
- building metadata needed by population logic;
- residents by housing building;
- workers by workplace building;
- deterministic unassigned-worker IDs;
- free workplace slots in stable building-ID order;
- placed school buildings;
- placed optional-outing destination buildings.

Use BTree-backed collections wherever iteration order affects assignment or demand. Reverse indexes may store runtime `Entity` handles; all entity access remains generation-checked.

The index is derived, not authority. Test-only helpers rebuild it from a full entity query and building list after every lifecycle mutation class (`run_due`, move-in, despawn, reassignment, reconcile) and assert equality with the incrementally maintained index. Production does not rebuild it every tick.

### `NextCitizenOrdinal`

Monotonic allocator state is separate from `PopulationIndex`:

```rust
#[derive(Resource)]
struct NextCitizenOrdinal(usize);
```

It is initialized to `max(existing sim suffix) + 1` on load and incremented on spawn. It is intentionally **not** rebuild-equal to `max(live ID) + 1` after deletions; IDs are not reused.

### Mailboxes

`DuePopulationEvents` and `PendingTripDemands` are short-lived vectors cleared each schedule run. They are ordering seams, not persisted state.

## Explicit schedule order and determinism

Own one standalone schedule:

```text
CollectDue -> ApplyDue -> EmitTripDemand
```

`CollectDue` drains exact-time buckets due now. Before mutation, canonicalize events using stable domain identity:

1. `MoveIn` before `Activity`, matching today's move-in-before-commute ordering;
2. move-ins by `(building_id, slot)`;
3. activities by resolved `CitizenId`;
4. stale activities with missing entities are dropped.

`EmitTripDemand` then sorts demand rows by:

```text
(scheduled_time, citizen_id, explicit purpose rank)
```

Never use Bevy entity order, hash-map iteration order, or scheduler insertion order for visible behavior.

`run_due` reruns the schedule if processing creates another event due at the current timestamp. This preserves the current same-time behavior where a move-in can become eligible for commute processing without a whole-population scan.

## Dynamic substep-cap widening

The current trip loop widens its substep budget when move-ins add new sim boundaries mid-tick. The ECS cutover must preserve that invariant.

Initial cap calculation includes the scheduler's existing distinct due-time keys through `final_time`. During the tick, every scheduler insertion reports whether it created a **new future due-time key** within the current tick window. Reconciliation and due-event processing return that count to the trip driver, which saturating-adds it to the cap.

Adding another event to an already-populated timestamp does not widen the cap because it does not create another time boundary. Removing a key may leave the cap conservatively high, which is safe.

Outcome-expiry widening remains unchanged.

## Stage A: ownership parity before new gameplay

The first live ECS cutover preserves today's travel semantics:

- current `Worker` citizens use existing shift/departure rules;
- current `NonWorker` citizens map to runtime `Student` but emit no primary or optional travel yet;
- no day-off suppression yet;
- no school travel yet;
- no optional outing yet;
- existing trip/private-car/transit-income behavior remains unchanged.

The Stage-A gate is structural, not just “a timing number exists”:

1. a 200,000-citizen runtime with only `N` citizens due now emits exactly `N` stable-ordered demands while the other `200_000 - N` remain future-scheduled;
2. a quiet 200,000-citizen tick produces no population work beyond scheduler bookkeeping and no accidental trip;
3. one coarse tick and equivalent fine ticks over a representative due wave produce identical explicit durable snapshots;
4. current Worker commute golden/lifecycle/growth/shuttle tests remain green after being migrated to `GameEngine` ownership;
5. reference wall-clock measurements are recorded alongside these structural proofs, with no timing threshold.

Only after Stage A is green does the PR move to schema v10 and new routine behavior.

## Move-in and workplace semantics

Housing move-ins remain Sandbox-only. Campaign growth may place housing but must not schedule Sandbox resident move-ins.

When housing is added in Sandbox, schedule unoccupied slots at the exact existing times:

```text
building.placed_at + slot * MOVE_IN_INTERVAL_SECONDS
```

A move-in event:

1. rechecks the building and slot;
2. allocates the next monotonic `sim-NNN` ordinal;
3. spawns one citizen;
4. assigns a workplace if capacity exists;
5. updates derived indexes;
6. installs the final `DailyRoutine` activity kind using current Worker late-assignment semantics.

If today's Worker departure already passed when a workplace becomes available, do not retroactively spawn that outbound trip. Schedule the next appropriate daily wake, preserving current behavior.

### Workplace allocation order

All unassigned Workers share one sorted `BTreeSet<String>`.

When a workplace is removed:

1. clear assignments for affected workers;
2. put those IDs back into the global unassigned set;
3. compute all free workplace slots;
4. fill them from the globally lowest unassigned citizen IDs in stable workplace/slot order.

Do not preferentially reassign only the just-cleared workers. This preserves today's `assign_workplaces` ordering when lower-ID workers were already unassigned.

## Building reconciliation

Pure `buildings.rs` / `transit.rs` snapshot mutation helpers become shell-only because preview code also calls them. `GameEngine` (and tick-time growth integration) owns population reconciliation after a shell candidate exists.

A focused reconciliation compares before/after building IDs and handles only changed population relationships:

- added Sandbox housing -> schedule missing move-in slots;
- added workplace -> expose slots, then refill from the global unassigned set;
- removed housing -> targeted resident despawn, remove their active trips, scrub passenger IDs, free/refill workplace slots;
- removed workplace -> clear affected assignments, merge them into unassigned set, globally refill slots, retarget/drop affected outbound trips using existing Idle/patience/deadline reset semantics;
- later Stage-B school/optional destination removal -> cancel only affected outbound trips and schedule the next sensible activity.

Growth-wave building changes use this same reconciliation after the existing growth executor mutates the shell. No second growth executor is added.

## Trip-demand bridge

ECS never routes:

```rust
struct TripDemand {
    citizen_id: String,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    scheduled_time: f64,
}
```

`trips.rs` drains these rows and routes them sequentially through the existing route-plan/private-car builder. Same-time demands share the same mutable `RoadFlow` so deterministic private-car admission behavior remains unchanged.

Route choice remains O(number of due demands). HPA-348 owns batching if the final wave measurements show that route construction is now the dominant cost.

## Trip resolution back into ECS

Before terminal active trips are removed, collect compact resolution rows:

```rust
struct PopulationTripResolution {
    citizen_id: String,
    purpose: TripPurpose,
    status: TripStatus,
    destination: Point,
    resolved_at: f64,
}
```

Apply them to ECS after each substep:

- `Arrived | Late` updates settled position and schedules the next activity;
- `Unserved` preserves settled position and schedules the current recovery rule;
- a travelling citizen has no `NextActivity` until resolution.

During the temporary v9 adapter stage, the same resolution handler also maintains the existing daily flags so explicit v9 snapshots remain testable. The v10 task deletes that adapter and those flags completely.

## Presentation: one projector, two aggregate builders

Do not create a second runtime projector.

Refactor to one projection function:

```rust
pub struct PopulationAggregates {
    pub population_count: u32,
    pub building_occupancy: BTreeMap<String, u32>,
}

pub fn project_update(
    snapshot: &GameSnapshot,
    population: &PopulationAggregates,
    include_scene: bool,
) -> PresentationUpdate
```

Two small builders feed it:

- durable builder derives `PopulationAggregates` from `snapshot.sims` for save/parity/harness use;
- runtime builder derives the same aggregate shape from ECS indexes.

All platform occupancy, traffic flow, demand flow, vehicle, service metrics, scene, and route logic stays in the single projector.

Parity tests compare the two aggregate builders for equivalent state, then run the same projector. This is sharper than comparing two projection implementations.

`GameplayUpdateResult` constructors take a precomputed `PresentationUpdate`; they must not invoke a durable snapshot projector internally.

## Test-fixture migration is a first-class task

Direct `trips::tick_trips(&GameSnapshot, ...)` is currently a large integration-test seam. The live cutover removes that as a production ownership model.

Before Stage A:

- inventory current `tick_trips` / `tick_trips_with_objectives` calls in `golden_sequences.rs`, `shuttle_service.rs`, `trip_lifecycle.rs`, `growth.rs`, and other current hits;
- reuse `tests/common::running_engine_from_fixture` to build an engine once per scenario/branch, then call `engine.tick(delta)` repeatedly inside fine-tick loops;
- add one shared population-valid fixture helper before v10 so arbitrary `Sim` fixtures gain valid housing/workplace relationships without each test inventing its own setup;
- module-local growth tests move to `GameEngine` directly;
- do not create a helper that reconstructs/validates a fresh engine on every substep.

The v10 persistence task must not surprise these tests with new home/workplace/activity validity requirements two tasks later; fixture validity lands before the live cutover.

## Durable schema v10

After Stage A passes, replace the temporary daily-flag save shape with one next activity:

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

A citizen with an active trip must have `next_activity = None`; an idle citizen must have one scheduled activity. `due_time` is validated finite/non-negative and is used directly as the scheduler key through `ScheduledTime`.

Bump `SNAPSHOT_SCHEMA_VERSION` from 9 to 10 and reject v9. No migration aliases/defaults are added.

## Stage B: ticket-required routine expansion

Only after Stage A and v10 are green, enable the new demand behavior on the same PR.

### Students

Current NonWorker becomes `CitizenRoutine::Student`. Students select among placed `school` buildings in stable building-ID order from a deterministic citizen/day seed.

- outbound window: 07:30–08:30;
- return window: 15:00–16:00;
- no school -> no student primary trip that day;
- no enrollment-capacity model in this ticket.

### Day off

Each citizen has one deterministic day off in seven:

```text
day % 7 == numeric_id_suffix(citizen_id) % 7
```

A day off suppresses primary work/school travel.

### Optional outing

On a day off, at most one optional outing is possible. One in four eligible citizens takes it from a stable citizen/day integer mixer.

Eligible building types:

- `supermarket`
- `cinema`
- `clinic`
- `parkPlaza`

Pick building and footprint tile deterministically.

- outbound window: 11:00–15:00;
- successful arrival dwell: 120 in-game minutes;
- then `OptionalReturn`.

No visitor capacity, shopping economy, or chained outings.

Transit income remains the existing completed-transit-journey rule and is purpose-agnostic. Stage-B tests characterize that existing behavior; no second fare model is added.

### Final state machine

1. `DailyRoutine`: if settled away from home, emit return-home first.
2. Otherwise, on a non-day-off, emit assigned Worker or available Student primary outbound.
3. Otherwise, evaluate the optional outing.
4. If no trip is emitted, schedule next day's `DailyRoutine`.
5. Primary outbound arrival -> `PrimaryReturn` at routine return time/current timestamp if already past.
6. Optional outbound arrival -> `OptionalReturn` at `resolved_at + 120` in-game minutes.
7. Successful return -> settle home and schedule next day's `DailyRoutine`.
8. Unserved outbound -> preserve settled position; schedule next daily wake.
9. Unserved return -> preserve settled position; schedule next daily wake so rule 1 retries home before another outbound.

Do not retry a failed return inside the same timestamp bucket.

## Persistence and restore

`GameEngine::snapshot()` and `snapshot_for_save()` are intentionally O(population):

1. clone the live shell;
2. query/project ECS citizens into stable-ID-sorted v10 `Sim` rows;
3. populate existing derived save fields;
4. normalize as today.

Ordinary tick/dispatch/presentation must never call these methods.

Restore remains candidate-first:

1. validate/normalize the complete durable candidate;
2. compile road topology;
3. construct the ECS world, scheduler, derived index, and ordinal allocator from the candidate;
4. clear `candidate.sims` in the live shell;
5. install shell + topology + world + schedule only after all candidate construction succeeds.

No Bevy `Entity` is persisted.

## Granularity independence

Coarse and fine ticks remain equivalent across the population migration.

Required proofs include:

- current Worker commute coarse/fine cases after Stage A;
- same-time move-ins from multiple houses;
- move-in + departure at the same timestamp;
- cross-midnight active trip;
- Stage-B optional/student routine cases;
- a scale-specific 200k Stage-A fixture with `N` due citizens: one coarse advance and the equivalent fine advances produce identical explicit durable snapshots.

The 200k coarse/fine proof may run as an explicit release/scale test rather than on every default debug test invocation; it is still a required HPA-347 gate.

## Evidence and WASM size

Use the HPA-544 native example shape and a dedicated HPA-347 performance document.

Record on the same reference machine:

### Before ECS

- 10k / 50k / 200k quiet tick;
- release WASM bytes.

### Stage A

- worker-only 200k quiet tick;
- structural `N due / 200k total` proof;
- 200k coarse/fine equality result.

### Final

- 10k / 50k / 200k runtime construction;
- quiet tick;
- runtime presentation;
- explicit full snapshot reconstruction;
- 1k / 5k / 20k due-wave scheduler emission;
- 1k / 5k / 20k existing route spawning separately;
- release WASM bytes after `bevy_ecs` + migration.

Wall-clock and byte values are evidence only, not CI thresholds. If route spawning becomes dominant, record HPA-348 as the next owner.

## Risks and mitigations

### Shell/ECS partial commit

**Risk:** population mutates while a same-value shell candidate is treated as a no-op.

**Mitigation:** `(shell, world)` is the tick commit unit; tick returns/observes `population_changed` separately from shell equality. Zero-delta due-work tests pin the behavior.

### Missing dynamic scheduler boundaries

**Risk:** move-ins/growth add future due timestamps after the initial substep cap is computed.

**Mitigation:** scheduler insertion reports newly created future keys inside the current tick window; the cap widens saturating just as current sim-count growth widens it.

### Floating-time drift

**Risk:** quotient-based minute buckets fire later than exact current departure times.

**Mitigation:** exact finite due timestamps are BTree keys ordered with `total_cmp`; no division/ceil bucketing.

### Derived-index drift

**Risk:** incremental reverse-index updates diverge from ECS authority.

**Mitigation:** test-only full rebuild/equality after every mutation class; allocator state is separate and tested monotonically.

### Fixture migration hides behavior regressions

**Risk:** dozens of direct snapshot-tick tests either become slow or invalid under v10.

**Mitigation:** migrate fixtures as a dedicated pre-cutover task, build one engine per loop, and establish valid population relationships before v10.

### WASM dependency cost

**Risk:** `bevy_ecs` materially increases browser artifact size.

**Mitigation:** build the real WASM target when the dependency lands and record release bytes before/after. Do not add more Bevy crates/features in this ticket.

## Acceptance

HPA-347 is complete when all of the following are true:

1. `GameEngine` owns a load-bearing standalone Bevy `World` + one ordered population schedule.
2. The live shell contains no latent `Sim` mirror.
3. Stable Caelum IDs are durable; Bevy `Entity` never crosses persistence/presentation boundaries.
4. A 200k population can be constructed and quiet-ticked without a whole-population ordinary substep scan.
5. In a 200k fixture with exactly `N` citizens due, exactly `N` stable-ordered demands are emitted; future citizens remain dormant.
6. Population exact-time scheduling preserves current departure/move-in boundaries without quotient-bucket rounding drift.
7. Dynamic scheduler boundaries added mid-tick widen the substep cap so no legitimate time is truncated.
8. Current Worker commute behavior, Sandbox-only move-in, late workplace assignment, cross-midnight trips, assignment order, and demolition cleanup remain equivalent after Stage A.
9. Coarse and fine ticks produce identical durable state for representative population behavior, including the explicit scale gate.
10. The single HPA-544 projector produces behaviorally identical presentation from durable and ECS population aggregates.
11. Candidate-first save/restore reconstructs ECS from schema v10, rejects v9, and persists no runtime entity handles.
12. Stage-B school/day-off/optional demand is deterministic and bounded as specified.
13. Reference 200k and demand-wave measurements plus release WASM before/after bytes are recorded; any remaining dominant bottleneck is named.
14. Full Rust, WASM, TypeScript, browser, and E2E gates pass on the final PR.

## Delivery

One ticket = one PR. PR #56 carries the planning commits and all HPA-347 implementation/evidence commits. Stage A and Stage B are explicit internal review gates, not separate PRs.
