# HPA-347 ECS Latent Population Design

**Linear:** HPA-347 — [Scale] Add ECS-backed latent population schedules and transport-demand generation

**Status:** Proposed implementation design

## Context

HPA-544 removed latent citizens from ordinary frontend payloads, but `caelum-core` still stores every citizen in live `GameSnapshot.sims`. Ordinary simulation work still clones or scans that vector in population, workplace assignment, commute spawning, boundary discovery, and terminal-trip updates.

HPA-347 removes that dormant-population cost by making standalone `bevy_ecs` load-bearing exactly where the high-cardinality state lives. It does not move mature route, vehicle, traffic, economy, or rendering systems into ECS.

## Goals

- ECS is the sole live owner of latent citizens.
- `GameEngine.snapshot.sims` is empty at runtime; explicit save/debug snapshots reconstruct durable sims.
- A sparse scheduler processes only due population events.
- Existing Worker commute behavior survives the ownership cutover before new routine behavior is enabled.
- Stable Caelum string IDs remain durable; Bevy `Entity` stays runtime-only.
- HPA-544 presentation wire remains unchanged.
- Save/restore stays candidate-first.
- 200k structural, granularity, reference-timing, and WASM-size evidence is recorded.
- The whole ticket remains one PR.

## Non-goals

No full Bevy application, renderer, plugin framework, multithreaded schedule, reflection, `rand`, household/needs/social model, per-citizen dormant pathfinding, individual private-car entities, route-choice batching, WebGPU work, or v9 save migration.

HPA-348 owns route-choice batching. HPA-640 owns WebGPU/viewport/LOD/cadence.

## Runtime ownership

After Stage A:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: bevy_ecs::world::World,
    population_schedule: bevy_ecs::schedule::Schedule,
}
```

Ownership is explicit:

- shell `GameSnapshot`: map/buildings/transit/active trips/economy/metrics/scenario;
- ECS `World`: latent citizen state, assignments, next activity, population indexes;
- `RoadTopology`: existing compiled road graph;
- durable `GameSnapshot.sims`: reconstructed only on explicit snapshot/save;
- frontend: unchanged aggregate `PresentationUpdate`.

There is never a live full `Vec<Sim>` mirror next to ECS.

`GameEngine` no longer implements `Clone`; tests build independent engines.

## Dependency

Use only:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Set Rust package `rust-version = "1.95"` for `caelum-core`, `caelum-wasm`, and `src-tauri`.

Do not add full `bevy`, `bevy_app`, reflection/serialization, async executor, `multi_threaded`, or `rand`.

Build the actual release WASM target when the dependency lands and record artifact bytes before/after HPA-347. Size is evidence, not a threshold.

## Tick commit invariant

Today `GameEngine::tick` treats `next_snapshot == current_snapshot` as a no-op. That cannot remain the only commit test once population lives outside the shell: a due activity may change ECS state without changing shell fields.

One tick commits the pair:

```text
(shell candidate, ECS mutations)
```

The trip driver reports `population_changed`. Engine result semantics become:

```text
applied = shell_changed || population_changed
```

The engine always retains ECS mutations already performed by the tick. There is no rollback layer and no “discard world because shell compared equal” path.

Existing current-time behavior is preserved: a running `tick(0.0)` may process work already due now. Therefore only paused, speed-0, or zero-delta-with-no-due-work are required no-ops. Zero delta with a due activity must retain that mutation.

Early objective termination and cap fallback keep the shell and ECS changes processed up to the returned timestamp together.

## Components

Keep components small:

```rust
#[derive(Component)]
struct CitizenId(String);

#[derive(Component)]
struct HomeAssignment {
    building_id: Option<String>,
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
    building_id: Option<String>,
    point: Point,
}
```

`building_id: None` is allowed for legacy/unit fixtures whose point does not resolve to a live building. Gameplay-produced population remains building-backed. HPA-347 does not add stricter “home must be housing/workplace must be job building” persistence rules solely for ECS indexing.

During the temporary schema-v9 adapter, current `NonWorker` maps to runtime `Student` but remains non-travelling until Stage B.

## Exact-time scheduler

Do not use `ceil(due_time / (GAME_DAY_SECONDS / MINUTES_PER_DAY))`. That quotient can round exact current integer-minute departures into the next bucket, and housing move-ins can be anchored to arbitrary `PlacedBuilding.placed_at` timestamps anyway.

Use exact validated due timestamps as sparse buckets:

```rust
#[derive(Clone, Copy, Debug)]
struct ScheduledTime(f64);

struct PopulationScheduler {
    buckets: BTreeMap<ScheduledTime, Vec<PopulationEvent>>,
    boundary_generation: u64,
}
```

`ScheduledTime` accepts finite non-negative values, normalizes signed zero, and orders with `f64::total_cmp`.

Consequences:

- Worker departures reuse their exact existing `scheduled_time_seconds` values;
- move-ins preserve exact `placed_at + slot * MOVE_IN_INTERVAL_SECONDS` timing;
- optional return preserves its exact computed due time;
- `next_population_boundary` returns the earliest exact remaining key;
- equal due times share one bucket;
- no population query is needed to find the next event.

The existing `EPSILON` equality convention stays at the trip-loop boundary.

## Events and Bevy entity identity

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

Runtime `Entity` handles are generational. A despawned handle is invalid after index reuse rather than aliasing a replacement entity. `ApplyDue` uses non-panicking lookup and drops a stale handle.

A regression must schedule A, despawn A, spawn B, reach A's old due time, and prove B receives no stale demand.

`Entity` is never a durable ID or deterministic visible-order key.

## Derived index and allocator

`PopulationIndex` is rebuildable runtime data:

- `CitizenId -> Entity`;
- residents by housing;
- workers by workplace;
- global sorted unassigned Worker IDs;
- population-relevant building metadata;
- school/optional destination indexes needed later.

Use BTree-backed collections where iteration order matters.

Tests rebuild the index from ECS + building state after move-in, due processing, despawn, reassignment, and reconciliation and assert equality with incremental state. Production does not rebuild every tick.

Monotonic ID allocation is separate:

```rust
#[derive(Resource)]
struct NextCitizenOrdinal(usize);
```

Initialize to `max(existing sim suffix) + 1`; increment on spawn; never reuse IDs after deletion. It is intentionally not part of index rebuild equality.

## Schedule order and same-time determinism

One schedule owns:

```text
CollectDue -> ApplyDue -> EmitTripDemand
```

For each exact due timestamp, canonicalize before mutation:

1. MoveIn before Activity, preserving today's move-in-before-commute order;
2. MoveIn by `(building_id, slot)`;
3. Activity by resolved stable `CitizenId`;
4. stale Activity drops.

Demand output sorts by `(scheduled_time, citizen_id, explicit purpose rank)`.

`run_due` reruns while processing creates another event already due at the current timestamp. This preserves current same-time move-in/commute behavior without a full-population scan.

## Dynamic substep-cap widening

The current trip loop widens its cap when new sims create future boundaries mid-tick. ECS must preserve that safety property.

`PopulationScheduler.boundary_generation` increments whenever insertion creates a previously empty exact-time key. The trip loop captures the last generation and, after `run_due` or tick-time building reconciliation, saturating-adds any generation increase to the cap.

This can conservatively overcount a new key outside the current tick window; overcount is safe. Adding an event to an existing timestamp does not create a new boundary and does not increment the generation.

Outcome-expiry widening remains unchanged.

## Population and workplace lifecycle

### Move-in

Move-ins remain Sandbox-only. Campaign growth may place housing but never schedules Sandbox resident move-ins.

For each empty housing slot:

```text
exact due = building.placed_at + slot * MOVE_IN_INTERVAL_SECONDS
```

A due move-in revalidates the building/slot, allocates monotonic `sim-NNN`, spawns the ECS citizen, assigns a workplace if available, updates indexes, and installs the final activity-kind representation.

If a workplace becomes available after today's departure, preserve current late-assignment behavior: do not retroactively create today's outbound.

### Workplace ordering

All unassigned Workers share one sorted `BTreeSet<String>`.

When a workplace is removed, clear affected assignments back into that global set, then refill all free slots in stable workplace/slot order from the globally lowest unassigned IDs. Do not prefer only the workers just cleared by the removal.

### Demolition/reconciliation

Pure building/transit snapshot helpers become shell-only so preview stays ECS-free. GameEngine/tick growth reconciliation owns population changes after a shell candidate exists.

Reconciliation handles only changed building IDs:

- added Sandbox housing -> schedule slots;
- added workplace -> expose slots and globally refill;
- removed housing -> targeted resident despawn, trip removal, passenger scrub, slot refill;
- removed workplace -> clear, globally refill, retarget/drop affected outbound trips with existing Idle/patience/deadline reset behavior;
- Stage-B school/optional destination removal -> cancel only affected outbound demand and schedule recovery.

Cross-midnight travelling citizens have no `NextActivity` and cannot be woken by the scheduler until their trip resolves.

## Trip bridge

ECS emits, but does not route:

```rust
struct TripDemand {
    citizen_id: String,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    scheduled_time: f64,
}
```

The existing `build_commute_trip` route/private-car logic consumes each row sequentially with one shared mutable `RoadFlow` for a same-time batch.

Route choice stays O(due demand). HPA-348 owns batching.

Before terminal trips are removed, collect:

```rust
struct PopulationTripResolution {
    citizen_id: String,
    purpose: TripPurpose,
    status: TripStatus,
    destination: Point,
    resolved_at: f64,
}
```

Arrival/late updates settled position and schedules next activity; unserved preserves settled position and schedules recovery. During the temporary v9 adapter, this same handler also maintains the old day flags so explicit v9 snapshots remain testable.

## Presentation: one projector

Do not add `project_runtime_update`.

Use one projector:

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

Two small builders create `PopulationAggregates`:

- durable snapshot builder from `snapshot.sims`;
- runtime ECS builder from population indexes.

All non-population presentation logic stays single-source. Parity tests compare aggregate builders for equivalent state and then use the same projector.

`GameplayUpdateResult` receives a precomputed `PresentationUpdate`; it never projects from an empty-shell `sims` vector.

## Test seam migration

Before the live cutover, migrate current end-to-end calls of `trips::tick_trips` / `tick_trips_with_objectives` in integration/module tests.

- Reuse `tests/common::running_engine_from_fixture`.
- Build each coarse/fine engine once, then call `engine.tick(delta)` repeatedly.
- Do not create a helper that validates/recompiles a fresh engine on every substep.
- Module-local growth tests use `GameEngine` directly.
- Tests that only used plain tick to avoid objectives should adjust the fixture's objective mode rather than preserve a second production runtime path.
- Shared sim construction can be centralized, but arbitrary trip fixtures do not need artificial housing/job buildings because v10 does not add that unrelated persistence hardening.

This migration is a dedicated task rather than hidden fallout in the cutover/schema tasks.

## Stage A: ownership parity gate

Stage A migrates only today's travel behavior:

- Worker uses existing shift/departure rules;
- current NonWorker maps to runtime Student but does not travel yet;
- no day-off suppression;
- no school demand;
- no optional outing.

Stage B cannot start until all of these pass:

1. 200,000 total citizens with exactly `N` due now emit exactly `N` stable-ordered demands; future citizens remain scheduled.
2. A quiet 200k interval produces no accidental population/trip mutation.
3. One coarse tick and equivalent fine ticks produce identical explicit durable snapshots on a 200k scale fixture.
4. Existing Worker commute, growth, shuttle, population, and trip lifecycle suites are green through `GameEngine`.
5. No ordinary `trips.rs` path scans `sims`.
6. Worker-only reference timing is recorded.

The 200k coarse/fine check may be an explicit ignored release-scale test run by the HPA-347 gate instead of every default debug test invocation.

## Durable schema v10

After Stage A, replace daily booleans with one scheduled activity:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
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

A citizen with an active trip has no next activity; an idle citizen has one. Validate activity due time finite/non-negative and enforce those two ownership states.

Keep current home/position/workplace point validation; do not add housing/job membership hardening in this ticket.

Bump schema 9 -> 10 and reject v9 with no migration aliases/defaults.

## Stage B: ticket-required routine expansion

After v10 is green on the same PR:

### Student

Current NonWorker becomes travelling Student. Choose placed `school` deterministically in stable building-ID order.

- outbound 07:30–08:30;
- return 15:00–16:00;
- no school -> no Student primary trip that day;
- no enrollment-capacity model.

### Day off

Exactly one deterministic day off in seven:

```text
day % 7 == numeric_id_suffix(citizen_id) % 7
```

It suppresses primary Worker/Student travel.

### Optional outing

On a day off, one in four eligible citizens takes at most one outing. Eligible types:

- `supermarket`
- `cinema`
- `clinic`
- `parkPlaza`

Choose building/tile deterministically, depart 11:00–15:00, dwell 120 in-game minutes after successful arrival, then return home.

No visitor capacity, economy side model, or chained outings.

Existing transit income remains purpose-agnostic; tests characterize the same completed-transit `$200` rule for the new purposes without changing fare production code.

### State machine

1. `DailyRoutine`: if settled away from home, return home first.
2. Else on a non-day-off, emit Worker/Student primary outbound when a destination exists.
3. Else evaluate optional outing.
4. If no trip, schedule next day's `DailyRoutine`.
5. Primary outbound arrival -> `PrimaryReturn` at routine return time/current timestamp if already late.
6. Optional outbound arrival -> `OptionalReturn` after 120 in-game minutes.
7. Return arrival -> settle home, schedule next DailyRoutine.
8. Unserved outbound -> preserve settled position, schedule next daily wake.
9. Unserved return -> preserve position, schedule next daily wake so rule 1 retries home later.

No same-timestamp retry loop.

## Persistence and restore

`GameEngine::snapshot()` / `snapshot_for_save()` are intentionally O(population): clone shell, project stable-ID-sorted ECS citizens into durable `sims`, populate existing derived fields, normalize.

Ordinary tick/dispatch/presentation never call them.

Restore remains candidate-first:

1. validate/normalize durable candidate;
2. compile topology;
3. build ECS world/scheduler/index/allocator;
4. clear candidate `sims` in the live shell;
5. install all owners only after candidate construction succeeds.

No Bevy entity is persisted.

## Granularity independence

Coarse and fine ticks must remain equivalent across:

- current Worker commute after Stage A;
- same-time move-ins from multiple houses;
- move-in + departure at one timestamp;
- cross-midnight active trips;
- Stage-B Student/day-off/optional flows;
- explicit 200k Stage-A scale proof.

## Evidence

On one reference machine record:

### Before ECS
- 10k / 50k / 200k quiet tick;
- release WASM bytes.

### Stage A
- Worker-only 200k quiet tick;
- `N due / 200k total` structural result;
- 200k coarse/fine equality result.

### Final
- 10k / 50k / 200k runtime build, quiet tick, runtime presentation, full snapshot reconstruction;
- 1k / 5k / 20k scheduler emission separately from route spawning;
- release WASM bytes after HPA-347.

No wall-clock or byte threshold is created from the observed values. If route spawning is dominant, name HPA-348 as owner.

## Risks

- **Shell/ECS partial commit:** solved by explicit `population_changed` and shell+world commit semantics.
- **Cap undercount after new events:** solved by monotonic scheduler boundary-generation widening.
- **Floating-time bucket drift:** solved by exact due-time keys with `total_cmp`.
- **Derived-index drift:** solved by test-only rebuild equality; allocator separate.
- **Fixture migration cost:** isolated before cutover and uses one engine per loop.
- **WASM size increase:** measured before/after; no extra Bevy crates/features.

## Acceptance

HPA-347 is done when:

1. standalone Bevy ECS is load-bearing for latent citizens/scheduling;
2. live shell has no full `sims` mirror;
3. 200k dormant population does not require an ordinary whole-population substep scan;
4. exactly due citizens wake and future citizens remain dormant at 200k scale;
5. exact current move-in/departure times are preserved without quotient-bucket drift;
6. dynamic event creation cannot exhaust the substep cap incorrectly;
7. current Worker behavior, assignment ordering, Sandbox-only move-in, demolition, late assignment, and cross-midnight semantics remain equivalent;
8. coarse/fine durable state remains identical, including the scale gate;
9. one HPA-544 projector consumes durable/ECS `PopulationAggregates` with parity coverage;
10. schema-v10 save/restore is candidate-first, rejects v9, and persists no Bevy entity;
11. Stage-B Student/day-off/optional behavior is deterministic and bounded;
12. reference runtime/wave/WASM evidence is recorded and the next bottleneck is named;
13. full Rust/WASM/TS/E2E gates pass.

## Delivery

One ticket = one PR. PR #56 carries design, implementation, Stage-A proof, Stage-B behavior, and final evidence. Stage boundaries are review checkpoints, not separate PRs.
