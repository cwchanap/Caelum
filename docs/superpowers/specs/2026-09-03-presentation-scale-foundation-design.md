# HPA-544: Presentation Scale Foundation Design

## Status

Revised after the second design review on 2026-09-03.

Bevy ECS remains committed for HPA-347, where it becomes load-bearing with real latent citizens. HPA-544 stays focused on the durable-state/presentation boundary.

## Context

Caelum currently sends a complete Rust `GameSnapshot` through ordinary startup, dispatch, and tick calls. TypeScript normalizes that snapshot into the flat `GameState` used by Svelte and Canvas2D.

That wire carries state the scale roadmap explicitly does not want in the UI:

- latent citizens (`sims`), targeted toward roughly 200,000 records;
- complete active-trip internals, including route plans and private-car paths;
- vehicle passenger ID lists.

The product target is simulation-heavy with light graphics. Citizens generate transport demand; they are not intended to be rendered individually. HPA-544 therefore removes latent-citizen/raw-trip transport without changing simulation storage yet.

## Architecture decision

```text
GameEngine { GameSnapshot, RoadTopology }       // unchanged in HPA-544
    ├── snapshot() / snapshot_for_save()        // durable/core state
    ├── presentation()                          // complete scene + frame
    ├── dispatch/tick                           // GameplayUpdateResult
    └── reset/restore                           // PresentationUpdate on success

Rust wire
    PresentationUpdate
      ├── scene: PresentationScene | null
      └── frame: PresentationFrame

TypeScript runtime
    flat GameState presentation view
      └── applyPresentationUpdate(current, update)

Canvas2D
    current requestAnimationFrame tick/render loop unchanged
```

Rust keeps an explicit scene/frame wire because scene data changes infrequently. TypeScript does **not** spread that split through every renderer: one reducer merges updates back into the existing flat live-view shape.

HPA-347 later replaces high-cardinality Rust storage with Bevy ECS behind this contract. HPA-640 later introduces lower-frequency publication and interpolation together with WebGPU.

## Goals

1. Ordinary gameplay output carries no `sims`, complete `activeTrips`, route plans, private-car paths, or passenger ID lists.
2. `GameSnapshot` remains the complete save/restore/sandbox/core model.
3. Presentation composes existing Rust population/platform/traffic/service seams instead of duplicating their rules.
4. TypeScript keeps one flat `GameState` live view so low-cardinality render/tool code does not require a mechanical rewrite.
5. Individual citizen dots and dead/dormant lateness/growth overlays are retired rather than encoded into a new high-cardinality contract.
6. Aggregate demand, crowding, traffic, route/service UI, inspectors, map rendering, and route editing remain available.
7. Candidate-first restore/reset, Tauri epoch semantics, rAF-driven serialized ticks, and no-op tick identity behavior remain unchanged.
8. The implementation records the old and new wire cost on the same deterministic cardinality matrix.

## Non-goals

- No Bevy dependency, `World`, `Schedule`, components, or Rust toolchain bump.
- No 200k production population implementation.
- No WebGPU or lower-frequency ticker/interpolation.
- No rendered citizens or individual private-car simulation.
- No second persistence format, save compatibility layer, generic patch engine, event bus, worker framework, or renderer plugin layer.
- No full Bevy app or Godot migration.

## Precise scale claim

HPA-544 removes **row-per-latent-citizen** and **raw per-trip route/path** terms from the ordinary wire. It does not claim every output collection is constant-sized.

| Presentation term | Cardinality |
| --- | --- |
| `populationCount` | O(1), aside from numeric digit width |
| `buildingOccupancy` | O(occupancy-capable buildings) |
| `platformOccupancy` | O(present platforms) |
| `trafficFlow` | O(road tiles carrying flow) |
| `demandFlow` | O(distinct destination tiles), bounded by map tiles |
| `vehicles` | O(public-transport vehicles represented) |
| `serviceMetrics` | O(routes + metro lines) |

There is no per-active-trip presentation vector.

Changing the number of latent sims may change aggregate scalar values such as `populationCount` and occupancy counts, so serialized bytes are not required to be byte-for-byte invariant. The required property is **no linear payload growth caused by serializing one record per sim**.

HPA-640 owns viewport/LOD extraction and GPU batching for large visible-vehicle/map presentation.

## Measurement contract

The implementation begins with a pre-cutover baseline using the current full snapshot.

Measure at least these independent cardinalities:

- sims: `0`, `10_000`, `50_000`, `200_000`;
- active trips: `0`, `1_000`, `5_000`, `20_000`;
- occupancy-capable buildings: current fixture, `1_000`, `5_000`, `20_000`;
- transit vehicles: current fixture, `1_000`, `5_000`.

Record full-snapshot serialized bytes and native serde serialization time before presentation code lands. After the cutover, rerun the same fixtures and record scene+frame bytes, frame-only bytes, projection time, presentation serialization time, and presentation/full-snapshot ratios.

Timing is reference evidence, not a shared-CI threshold.

## Durable state and versioning

`GameSnapshot` remains authoritative for:

- `GameEngine::snapshot()` used by Rust tests/core inspection;
- `snapshot_for_save()`;
- save capture;
- restore input;
- sandbox candidate construction;
- persistence validation.

Presentation is unversioned. Rust persistence remains authoritative for restore schema/structural rejection; TypeScript does not add a second restore validator.

`SNAPSHOT_SCHEMA_VERSION` and raw Rust snapshot types remain in the persistence/backend boundary. The flat live `GameState` no longer carries `schemaVersion`; tests that need to assert save schema compare the durable stored snapshot against the persistence constant/raw snapshot contract instead of reading schema version from presentation.

## `PresentationUpdate`

```rust
pub struct PresentationUpdate {
    pub scene: Option<PresentationScene>,
    pub frame: PresentationFrame,
}
```

Scene emission is intentionally simple:

- `presentation()`, successful reset, successful restore -> scene included;
- any **applied player dispatch** -> scene included;
- tick -> frame only;
- rejected/no-op dispatch -> frame only.

Do not add `scene_changed` or a cached scene comparator. Applied dispatches are low-frequency, and resending an unchanged scene is simpler than maintaining a second structural field list. Shipped sandbox ticks do not apply campaign growth.

A no-op tick (`applied == false`) keeps the current frontend `GameState` object and publishes no replacement, preserving the existing reference-identity optimization.

## `PresentationScene`

Reuse existing serde model types where safe:

- `GameRules`;
- `GameMap`;
- `PlacedBuilding`;
- `Stop`;
- `Station`.

Do not create parallel presentation structs for those.

Use focused bus/metro line presentation structs because durable line structs contain derived service metrics. They carry:

```text
id
name
color
waypoint ids
vehicleIds
active
pattern
revision
legs/path geometry
pathBroken
targetHeadwaySeconds
```

`serviceMetrics` is frame data.

`scenario` is not part of the live presentation scene. Project guidance says campaign objectives/growth have no active shipped gameplay consumer; the only live source consumer is the campaign-gated Growth overlay. HPA-544 removes that frontend branch instead of creating new presentation types for dormant campaign data.

Core/save campaign data survives for its separate cleanup.

## `PresentationFrame`

The exact metrics wire is:

```rust
pub struct PresentationMetrics {
    pub late_trips: u32,
    pub unserved_trips: u32,
    pub average_wait_seconds: f64,
    pub state: MetricsState,
}
```

These are the only current `Metrics` values required by shipped frontend logic: the shell uses late/unserved/average wait, while the animation loop uses terminal/running state.

The frame contains:

```text
time
day
clockMinutes
speed
paused
budget
metrics
populationCount
buildingOccupancy[]
platformOccupancy[]
trafficFlow[]
demandFlow[]
vehicles[]
serviceMetrics[]
```

## Building occupancy reuse

Reuse `population::resident_occupancy(state, building)` for housing.

Add only the missing sibling:

```rust
pub(crate) fn job_occupancy(
    state: &GameSnapshot,
    building: &PlacedBuilding,
) -> usize;
```

It counts sims whose optional workplace belongs to `building.occupied_tiles`.

Projection rule:

1. resident capacity > 0 -> `resident_occupancy`;
2. else job capacity > 0 -> `job_occupancy`;
3. else omit row.

The current catalog has no resident+job mixed-capacity building; pin that invariant instead of inventing mixed-use precedence.

```rust
pub struct BuildingOccupancyPresentation {
    pub building_id: String,
    pub occupancy: u32,
}
```

Rows sort by building ID.

## Platform occupancy reuse

Do not reimplement waiting/platform matching in `presentation.rs`.

`platforms.rs` already owns:

- present-node filtering;
- `(position, route_id) -> platform_id` indexing;
- platform capacities;
- waiting-status filtering;
- current-leg/walk/missing-line handling;
- current position + current line matching.

Add one crate-private composition seam using those helpers:

```rust
pub(crate) fn platform_waiting_occupancy(
    state: &GameSnapshot,
) -> BTreeMap<String, (u32, u16)>;
```

The count includes all matching waiters, including overflow. This intentionally differs from `on_platform_trip_ids`, which truncates at capacity for boarding/route-health semantics.

```rust
pub struct PlatformOccupancyPresentation {
    pub platform_id: String,
    pub count: u32,
    pub capacity: u16,
}
```

## Traffic reuse

Reuse `traffic::derive_road_flow`. Presentation only:

1. filters entries to current map tiles whose `kind == "road"`;
2. sorts ascending `y`, then `x`.

```rust
pub struct TrafficFlowPresentation {
    pub point: Point,
    pub flow: u16,
}
```

## Aggregate demand instead of trip markers

Do not introduce `TripMarkerPresentation`.

Normal trip resolution removes terminal `Arrived`/`Late`/`Unserved` trips from `active_trips` in the same pass, so the existing lateness overlay has no durable terminal markers to display. The target renderer also does not render individual citizens.

Project active destination demand instead:

```rust
pub struct DemandFlowPresentation {
    pub point: Point,
    pub count: u32,
}
```

Group current active trips by destination; sort `y`, then `x`. This is bounded by distinct map destinations, not active-trip count.

The current demand overlay repeatedly draws the same translucent color for repeated destinations. Preserve density from the grouped count using effective alpha:

```text
1 - (1 - base_alpha)^count
```

## Retired frontend presentation

Remove in HPA-544:

- individual citizen dots / `citizenRenderer`;
- `lateness` overlay and its label/color/tests;
- `growth` overlay and its label/color/tests.

Topbar late/unserved metrics remain. Core campaign/growth logic is not deleted here.

## Vehicle presentation

Project exactly the fields Canvas transit rendering consumes:

```rust
pub struct VehiclePresentation {
    pub id: String,
    pub mode: TransitMode,
    pub line_id: String,
    pub itinerary_index: usize,
    pub path_step_index: usize,
    pub step_progress: f64,
    pub parked_position: Option<TripPosition>,
}
```

Do not send `capacity` or `passenger_ids`.

## Service metrics reuse

Extract a stable-ID map from the current `populate_snapshot_metrics` path:

```rust
pub(crate) fn service_metrics_by_line(
    snapshot: &GameSnapshot,
) -> BTreeMap<String, ServiceMetrics>;
```

Durable output and presentation consume the same derivation.

## Pure projector seam

The pure projector is public inside the presentation module so tests/examples and the future ECS-backed engine can reuse it without test-only hooks:

```rust
pub fn project_update(
    snapshot: &GameSnapshot,
    include_scene: bool,
) -> PresentationUpdate;
```

Production WASM/Tauri hosts still call `GameEngine`; they do not bypass the engine with raw snapshots.

## Core result contract

```rust
pub struct GameplayUpdateResult {
    pub update: PresentationUpdate,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}
```

`tick` and `dispatch` return this. `GameEngine` also exposes:

```rust
pub fn presentation(&self) -> PresentationUpdate; // full scene
pub fn snapshot(&self) -> GameSnapshot;
pub fn snapshot_for_save(&self) -> GameSnapshot;
```

Successful reset/restore return full presentation.

## Host and restore contract

Keep nine backend methods:

```text
presentation()
snapshotForSave()
buildSandboxSnapshot()
restoreSnapshot(snapshot)
dispatch(intent)
tick(deltaSeconds)
reset()
previewRoute(request)
previewRoadMutation(request)
```

Ordinary `snapshot()` is removed. `snapshotForSave` and sandbox construction remain durable snapshot operations. Restore accepts a durable snapshot and returns:

```text
{ ok: true, update: PresentationUpdate }
{ ok: false, error: SnapshotError }
```

Only structured definitive Rust restore failures become `{ ok: false }`; ambiguous host/transport failures continue to throw.

`workingSaveRuntime` keeps its existing candidate-first/serialized lifecycle but changes its installation value from the restore-returned `RustGameSnapshot` to the restore-returned full `PresentationUpdate`. `installRestoredGameplay` applies that update against `null` after invalidating previews/tokens, so engine replacement cannot retain stale structural view state.

## Flat TypeScript live view

Keep one flat `GameState`. Its meaning changes from “normalized durable snapshot” to “current presentation view”. It is unversioned and contains scene fields plus frame values. It does **not** contain:

- `schemaVersion`;
- `scenario`;
- `sims`;
- `activeTrips`;
- route plans/private-car paths;
- durable trip counters/outcomes;
- passenger IDs.

`applyPresentationUpdate(current, update)` is the single scene/frame merge point. On a frame-only update it reads structural fallback from `current.rules/map/buildings/transit.*`; it never treats a full `GameState` object as a `PresentationScene`. It then merges current frame service metrics onto route/metro live rows and installs the newest frame vehicles/aggregate vectors.

Because `GameState` stays flat, map/building/cursor/placement/route-draft/actions/Topbar/createCanvasHost code does not need a `{ scene, frame }` rewrite.

Only high-cardinality/dead-state consumers change behavior: backend/runtime normalization, `workingSaveRuntime` restore installation, `runtimeSelectors`, `overlayRenderer`, transit vehicle typing, and deleted citizen presentation.

## Test fixture reuse

Do not create a parallel presentation fixture tree. Retarget `tests/helpers/gameState.ts`, which already builds the shared live state for many tests.

`tests/fixtures/rustSnapshot.ts` remains for raw persistence/backend snapshot tests.

Cleanup guards search both source and tests:

```bash
rg "normalizeRustSnapshot|snapshotView|selectPlatformOccupancy|selectTrafficFlow" src tests
rg "activeTrips|\.sims\b|\bActiveTrip\b|\bSim\b" src tests
```

## Cadence

Canvas rAF continues calling serialized `api.tick(deltaSeconds)` exactly as today. An unapplied tick preserves the existing flat state object and avoids publication. HPA-640 owns lower-frequency publication plus interpolation/WebGPU together.

## Performance harness

No wall-clock API enters `crates/caelum-core/src`.

`crates/caelum-core/examples/presentation_scale.rs` may use `Instant`.

Task 0 records the current full-snapshot baseline. After the cutover the same fixture matrix measures `presentation::project_update` directly plus durable snapshot serialization.

Clock-free tests assert structural scale properties:

- no per-sim serialized rows;
- increasing only latent sim count causes at most small scalar-number byte differences, not linear row growth;
- demand rows grow with distinct destination tiles rather than active-trip count;
- building occupancy row count equals occupancy-capable building count;
- output ordering is deterministic.

The performance doc explicitly records that building occupancy remains O(buildings) and vehicle presentation remains O(vehicles); HPA-640 owns visible-vehicle culling/LOD.

## Verification

Before deleting TypeScript derivations, Rust tests pin:

- resident reuse + job occupancy;
- platform all-waiter overflow behavior;
- traffic road filtering/y-x ordering;
- aggregate demand ordering/cardinality;
- forbidden-key omission;
- vehicle cursor parity;
- service metric parity.

The first public gameplay-wire commit must pass:

```bash
cargo test --workspace
bun run wasm:build
bun run check
bun run test:unit
bun run test:e2e
```

E2E is part of the cutover gate, not deferred. New City E2E schema checks read the durable snapshot/persistence constant, not live presentation `GameState.schemaVersion`.

## Delivery boundary

HPA-544 is one implementation PR. It is complete when:

- Task 0 records the old full-snapshot cost;
- projection reuses existing domain seams;
- ordinary gameplay no longer sends full snapshots;
- no per-active-trip/citizen presentation array exists;
- citizen dots plus dead lateness/growth overlays are removed;
- `GameBackend.presentation()` replaces ordinary `snapshot()`;
- TypeScript still publishes one flat, unversioned `GameState`;
- `workingSaveRuntime` restores the presentation update without weakening candidate-first semantics;
- no-op ticks preserve state identity/publication behavior;
- save/load/sandbox remain complete and candidate-first;
- Rust/WASM/TS/unit/E2E gates pass at the wire cutover;
- after measurements use the same fixture matrix and report absolute/relative costs;
- no Bevy/WebGPU/cadence implementation lands in this slice.