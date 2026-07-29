# HPA-340: Rust Persistence Validation and Atomic Engine Restoration

**Status:** Implemented in PR #17 (HPA-339/340). The HPA-339 schema-v4 sandbox prerequisite and the HPA-340 persistence pipeline are both complete; the HPA-339 dependency below is preserved as historical context.

**Linear:** [HPA-340](https://linear.app/cwchanap/issue/HPA-340/implement-rust-persistence-snapshots-and-atomic-validated-engine)

## Outcome

`caelum-core` can produce a persistence-safe snapshot and can validate,
construct, or replace a `GameEngine` from an untrusted, already-deserialized
schema-v4 `GameSnapshot`.

Validation is strict and deterministic. It never repairs, normalizes, migrates,
or partially commits the candidate. A successful restoration preserves the
validated snapshot exactly and rebuilds the non-serialized `RoadTopology`. A
failed restoration leaves the running snapshot and topology unchanged.

## Prerequisite and Baseline

HPA-340 targets the schema-v4 sandbox contract designed by HPA-339:

- `SandboxTemplateId::{BlankGrid, Crossroads}`;
- persisted sandbox `starting_capital`;
- fixed template dimensions owned by HPA-339's authoritative
  `sandbox::MAP_WIDTH` and `sandbox::MAP_HEIGHT` constants;
- the canonical Crossroads default request; and
- `SNAPSHOT_SCHEMA_VERSION = 4`.

HPA-339 implementation is therefore a prerequisite. HPA-340 must be implemented
on top of that schema-v4 state rather than adding temporary schema-v3
persistence or compatibility behavior. HPA-340 implementation must not land
schema-v4 constants, fields, factories, or compatibility shims ahead of
HPA-339; it starts only after the HPA-339 schema-v4 implementation is present.

The prerequisite was rechecked against a freshly fetched `origin/main` on
2026-07-27. Linear marked HPA-339 Done, but the repository still had schema v3,
`SandboxTemplateId::GrowingSuburb`, no persisted `starting_capital`, and no
Rust sandbox factory; HPA-339's linked PR contained its design and
implementation plan rather than the implementation. Approval of this document
therefore authorizes the HPA-340 implementation plan, not an implicit expansion
into HPA-339. The implementation plan begins with a hard source-level gate and
must stop without editing HPA-340 if that gate still fails.

HPA-340 is a core persistence-authority slice. HPA-341 subsequently adds the
public save/import operations and equivalent TypeScript result contracts.
HPA-340 does include the minimal compatibility edits required by the already
shipped WASM/Tauri `loadSnapshot` path: the existing loaders serialize
`PersistenceError`, accept only paused persistence-valid snapshots, and keep
their current success shape. They do not add a new command, storage operation,
or frontend persistence API. Raw host deserialization failures belong to
HPA-341; envelope parsing and metadata belong to HPA-342.

## Current State

`GameEngine` currently stores two fields that must remain coherent:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
}
```

Normal network mutations already follow a candidate-first discipline:
construct a candidate snapshot, normalize affected live stop access, compile a
candidate topology, recompute route state, and then commit the snapshot and
topology together.

The existing `GameEngine::from_snapshot` is not a persistence validator. It:

- checks only the schema number;
- normalizes legacy roadside-stop state;
- compiles topology;
- recomputes serialized route legs; and
- returns `GameplayRejection`.

That behavior was appropriate for the pre-persistence roadside-stop migration,
but it is incompatible with HPA-340. It can accept malformed coordinates,
rewrite stop state, and change route-derived fields. It also mixes persistence
failure with ordinary gameplay intent rejection.

The current model exposes many primitive and string-backed fields that Serde
alone cannot make semantically valid: map row ordering, tile identity, authored
structure ownership, building footprints, cross-entity references, platform
assignments, route-derived paths, vehicle progress, trip state, counters, and
metric relationships. HPA-340 adds the missing whole-snapshot validation
boundary.

## Approved Decisions

1. HPA-340 validates schema v4 only. HPA-339 implementation is a prerequisite.
2. Validation is strict. It rejects inconsistent serialized derived state
   instead of normalizing or repairing it.
3. Validation returns the first error in a documented deterministic order.
   It does not aggregate cascading failures.
4. Persistence errors are a new typed model and never reuse or wrap
   `GameplayRejection` as the public persistence contract.
5. A valid restored snapshot remains exactly equal to the supplied snapshot.
   Only the non-serialized road topology is rebuilt.
6. A successful `snapshot_for_save` changes only `paused` in its returned clone,
   validates that clone before returning it, and never mutates the live engine.
7. A persistence snapshot must already be paused. Restoration rejects
   `paused = false` rather than silently normalizing it.
8. Validation is host-agnostic and independent of save-envelope metadata.
9. HPA-340 does not add a migration policy. Unsupported schemas are rejected.
10. Ordered collections and fixed traversal order make error selection
    deterministic.

## Goals

- Add `GameEngine::snapshot_for_save`.
- Add a pure core validation path usable before import or restoration.
- Add strict construction and atomic in-place restoration.
- Add a typed, serializable persistence error contract.
- Validate scalar, numeric, rules, scenario, map, road, entity, reference,
  assignment, trip, and metric invariants.
- Rebuild topology only after authored road facts are structurally safe.
- Preserve snapshot equality across a valid round trip.
- Prove deterministic continuation after save and restore.
- Add corruption-focused unit and integration coverage.

## Non-goals

- Save-envelope IDs, names, timestamps, checksums, or metadata.
- New WASM, Tauri, or TypeScript persistence operations; HPA-341 owns them.
  Minimal changes to the existing `loadSnapshot` bridges and their tests are
  required so the workspace continues to compile and exposes one persistence
  error shape.
- Browser IndexedDB or filesystem storage.
- Import/export file-format parsing.
- Autosave, checkpoints, recovery generations, or city-library UI.
- Schema migration or compatibility aliases.
- Repairing stale route legs, stop access, metrics, or assignments.
- Changing gameplay intent behavior except where an unavoidable compile
  adjustment follows from the core persistence error return type.

## 1. Ownership and Module Boundaries

### 1.1 Dedicated persistence module

Add `crates/caelum-core/src/persistence/` with the following private
organization:

- `mod.rs` — public facade, fixed validation-stage order, and prepared
  candidate;
- `error.rs` — public error and context enums;
- `map.rs` — snapshot shell, rules, scenario, tiles, road structures, and
  topology;
- `entities.rs` — identity indexes, buildings, ownership, transit nodes,
  platforms, routes, lines, and vehicles; and
- `trips.rs` — sims, active trips, route plans, counters, and metrics.

`lib.rs` re-exports only the public validation function, result/error types, and
engine methods. Stage validators remain private so callers cannot validate an
incomplete subset and mistake it for a persistence-safe snapshot.

`lib.rs` declares `pub(crate) mod persistence`; only the deliberate facade
items are re-exported publicly. This makes the internal module reachable from
`engine.rs` without exposing its stage validators outside `caelum-core`.

### 1.2 Private prepared candidate

The module owns a private candidate:

```rust
struct PreparedSnapshot {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
}
```

The owned candidate exists only after all validation succeeds. Validators
borrow the snapshot and use ordered indexes; they do not rewrite it.

An internal helper returns the compiled topology while preserving the snapshot:

```rust
fn validate_and_compile(
    snapshot: &GameSnapshot,
) -> PersistenceResult<RoadTopology>;

pub(crate) fn prepare_snapshot(
    snapshot: GameSnapshot,
) -> PersistenceResult<PreparedSnapshot>;
```

The pure public validation path calls the same helper and discards the compiled
topology. Restoration calls it once and retains the topology.

### 1.3 Existing gameplay modules remain authoritative

Persistence validation reuses, or extracts narrow read-only helpers from, the
authoritative modules:

- `clock` for day and clock derivation;
- `building_catalog` and `buildings::footprint` for building facts;
- `stop_access` for live access validity;
- `road` and `roundabouts` for canonical authored structures;
- `road_topology` for compilation;
- `network` and `route_lifecycle` for route derivation;
- `service_itinerary` for vehicle and platform itinerary indexes; and
- `objectives`/`trips` for metric and trip-state relationships.

Persistence does not duplicate a second router, building catalogue, topology
compiler, or objective evaluator.

Existing mutating helpers may be run only against a clone when validation needs
to compare serialized derived facts with canonical reconstruction. A mismatch
is an error; the reconstructed clone is never returned as the restored state.

## 2. Public Core API

### 2.1 Safe save snapshot

```rust
impl GameEngine {
    pub fn snapshot_for_save(
        &self,
    ) -> PersistenceResult<GameSnapshot>;
}
```

The method:

1. clones the current committed snapshot;
2. sets the clone's `paused` field to `true`;
3. runs the same complete validation used by import; and
4. returns the clone only when validation succeeds.

Every other field, vector order, identifier, counter, path, and metric remains
equal. The live engine's pause state and topology do not change. A validation
failure is returned at the save boundary so HPA-341 cannot write a snapshot
that the same engine would refuse to restore.

### 2.2 Pure validation

```rust
pub type PersistenceResult<T> = Result<T, PersistenceError>;

pub fn validate_snapshot(
    snapshot: &GameSnapshot,
) -> PersistenceResult<()>;
```

This is the import-safe read-only path. It runs every validation stage,
including topology compilation and derived-state comparison, without
constructing or replacing an engine.

The function accepts an already-deserialized `GameSnapshot`. HPA-341 owns
mapping host serialization/deserialization failures into the host-neutral
frontend result. HPA-340 owns semantic validity after a typed snapshot exists.

### 2.3 Strict construction

```rust
impl GameEngine {
    pub fn from_snapshot(
        snapshot: GameSnapshot,
    ) -> PersistenceResult<Self>;
}
```

`from_snapshot` becomes the strict schema-v4 persistence construction path. It
delegates to `prepare_snapshot` and performs no stop normalization, route
repair, schema migration, or fallback.

Pre-schema-v4 roadside migration is no longer reachable through this method.
The live `stop_access` normalization used after gameplay map changes remains
covered by its gameplay tests.

### 2.4 Atomic in-place restoration

```rust
impl GameEngine {
    pub fn restore_snapshot(
        &mut self,
        snapshot: GameSnapshot,
    ) -> PersistenceResult<GameSnapshot>;
}
```

Restoration is:

```rust
let prepared = persistence::prepare_snapshot(snapshot)?;
self.snapshot = prepared.snapshot;
self.road_topology = prepared.road_topology;
Ok(self.snapshot())
```

No field on `self` is mutated before the fallible preparation completes.
Failures at the last validation stage or topology compile therefore have the
same atomicity guarantee as early schema failures.

The success result is the exact committed snapshot clone. It is not a
canonicalized replacement.

`restore_snapshot` is the core in-place API for callers that already own a
mutable engine. Existing hosts may keep their construct-and-replace load shape:
build `GameEngine::from_snapshot` before taking the host lock, then swap the
complete engine. They do not need to call `restore_snapshot` or move validation
under the lock.

## 3. Persistence Error Contract

### 3.1 Separate from gameplay rejection

Define a closed, Serde-tagged enum:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PersistenceError {
    UnsupportedSchema {
        expected: u16,
        actual: u16,
    },
    InvalidNumericValue {
        #[serde(skip_serializing_if = "Option::is_none")]
        entity: Option<EntityRef>,
        field: SnapshotField,
        reason: NumericError,
    },
    InvalidModeSettings {
        field: SnapshotField,
        reason: ModeError,
    },
    InvalidScenario {
        field: SnapshotField,
        reason: ScenarioError,
    },
    InvalidMapDimensions {
        expected: MapSize,
        actual: MapSize,
    },
    InvalidTile {
        tile_id: String,
        reason: TileError,
    },
    InvalidRoadStructure {
        structure_id: String,
        reason: RoadStructureError,
    },
    DuplicateEntityId {
        id: String,
        first_kind: EntityKind,
        second_kind: EntityKind,
    },
    InvalidEntity {
        entity: EntityRef,
        field: SnapshotField,
        reason: EntityError,
    },
    DanglingReference {
        source: EntityRef,
        field: SnapshotField,
        target: EntityRef,
    },
    InvalidOwnership {
        owner: EntityRef,
        owned: EntityRef,
        reason: OwnershipError,
    },
    InvalidAssignment {
        entity: EntityRef,
        reason: AssignmentError,
    },
    InvalidDerivedState {
        field: SnapshotField,
        reason: DerivedStateError,
    },
    InvalidRoadTopology {
        reason: RoadTopologyError,
    },
}
```

The nested enums are also closed, serializable, and camelCase. They contain
structured entity kinds, identifiers, fields, expected/actual values, points,
or bounded numeric reasons where relevant. They do not contain host metadata
or require message parsing. `InvalidNumericValue.entity` is omitted when the
field belongs to the snapshot shell/rules rather than one entity.

`rename_all` applies to enum variant names; `rename_all_fields` separately
applies camelCase to named fields inside struct variants. Every tagged
persistence enum uses both attributes. Every named persistence context struct
uses `#[serde(rename_all = "camelCase", deny_unknown_fields)]`. The tagged
enums also use `deny_unknown_fields`, so unknown keys at the top level or inside
a selected variant context are rejected instead of ignored.

HPA-341 mirrors this enum as a TypeScript discriminated union. Host
deserialization and transport failures remain separate from these core
validation variants.

After both host schema probes and `GameEngine::from_snapshot` return
`PersistenceError`, schema mismatch is no longer a gameplay rejection. Remove
`RejectionCode::UnsupportedSnapshotSchema`,
`GameplayRejection::unsupported_snapshot_schema`,
`RejectionContext::{expected_schema_version, actual_schema_version}`, the
matching TypeScript gameplay-rejection union/context fields, and its gameplay
message branch. Persistence wire tests replace the retired gameplay wire
coverage.

### 3.2 Topology error translation

Replace the shared gameplay return type on topology compilation with a focused,
closed error:

```rust
pub enum RoadTopologyCompileError {
    UnsafeRoundaboutPortMapping {
        structure_id: String,
        footprint: Vec<Point>,
    },
}
```

`RoadTopology::compile` and the roundabout transition compiler return this
type. Normal gameplay commit and preview call sites convert it exhaustively
into `GameplayRejection`; persistence converts it exhaustively into
`InvalidRoadTopology` or `InvalidRoadStructure`. Neither public persistence
result wraps or exposes `GameplayRejection`.

The current compile call graph has one failure family:

- `compile_reciprocal_lane_transitions` is infallible;
- `compile_automatic_junction_transitions` is infallible after authored-map
  structural validation; and
- `compile_roundabout_transitions` may return
  `UnsafeRoundaboutPortMapping` from `roundabout_parts`,
  `circulation_edges`, `entry_transition`, `exit_transition`,
  `port_accepts_inbound`, `port_accepts_outbound`, or their shared
  `ring_neighbors`/heading checks.

Placement-time roundabout validation continues returning gameplay errors and is
not part of the topology compiler error surface. The focused compiler error
always carries the structure ID and canonical candidate footprint; helpers that
currently construct only a structure-ID rejection are changed to receive that
footprint. Add one focused test per fallible helper family plus an exhaustive
conversion test for both gameplay and persistence.

Adding a new topology compiler variant must fail to compile until both the
gameplay and persistence conversions classify it. Matching on the unrelated
shared `RejectionCode` enum is not an acceptable substitute for this guarantee.

### 3.3 Closed nested error taxonomy

Every nested persistence enum is closed, Serde-derived, and camelCase. Do not
add `Other(String)`, arbitrary field paths, or free-form reason strings. Adding
or changing a leaf requires:

1. a Rust exhaustive-match update;
2. an exact Rust wire-format test;
3. the corresponding HPA-341 TypeScript union update once that issue lands; and
4. a frontend normalization test that rejects unknown leaves rather than
   treating them as a known error.

The complete HPA-340 v1 entity vocabulary is:

```rust
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Building,
    Sim,
    ActiveTrip,
    Stop,
    Station,
    Platform,
    BusRoute,
    MetroLine,
    Vehicle,
}

#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRef {
    pub kind: EntityKind,
    pub id: String,
}

#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapSize {
    pub width: u8,
    pub height: u8,
}
```

`SnapshotField` identifies logical serialized fields. Entity instances remain
in `EntityRef`; field variants do not embed attacker-controlled path strings:

```rust
#[serde(rename_all = "camelCase")]
pub enum SnapshotField {
    Time,
    Day,
    ClockMinutes,
    Speed,
    Paused,
    Budget,
    GameMode,
    EconomyPreset,
    SandboxTemplateId,
    StartingCapital,
    DemandMultiplier,
    ScenarioObjectives,
    ScenarioGrowthWaves,
    ObjectiveThresholds,
    GrowthWaveId,
    GrowthWaveTriggerTime,
    GrowthWaveActions,
    MapWidth,
    MapHeight,
    TileCount,
    TileCoordinates,
    TileId,
    TileKind,
    TileArea,
    TileRoadConnections,
    TileOneWay,
    TileRoadStructureId,
    EntityId,
    BuildingOrigin,
    BuildingRotation,
    BuildingOccupiedTiles,
    BuildingTransitNodeId,
    NodeKind,
    NodeStatus,
    NodeAnchor,
    NodeRoadAccess,
    PlatformLabel,
    PlatformCapacity,
    PlatformCount,
    PlatformOrder,
    PlatformRouteIds,
    RoutePattern,
    RouteWaypointIds,
    RouteLegs,
    RouteEstimatedSeconds,
    RoutePathBroken,
    RouteRevision,
    RouteVehicleIds,
    VehicleMode,
    VehicleLineId,
    VehicleCapacity,
    VehiclePassengerIds,
    VehicleItineraryIndex,
    VehiclePathStepIndex,
    VehicleStepProgress,
    VehicleParkedPosition,
    SimHome,
    SimPosition,
    SimWorkerProfile,
    SimShiftTemplate,
    SimWorkplace,
    SimCommuteDay,
    SimDailyFlags,
    TripServiceDay,
    TripPurpose,
    TripStatus,
    TripOrigin,
    TripDestination,
    TripPosition,
    TripDeadline,
    TripPatience,
    TripRoutePlan,
    TripEstimatedSeconds,
    TripCurrentLegIndex,
    TripSequenceDay,
    NextTripSequence,
    MetricsCounters,
    MetricsWaits,
    MetricsTripOutcomes,
    OutcomeWaitSeconds,
    OutcomeTimestamp,
    MetricsState,
    MetricsLossReason,
}
```

Reason enums use
`#[serde(tag = "kind", content = "details", rename_all = "camelCase",
rename_all_fields = "camelCase", deny_unknown_fields)]`.
Their complete HPA-340 v1 variants are:

```rust
pub enum NumericError {
    NotFinite,
    Negative,
    OutOfRange {
        minimum: f64,
        maximum: f64,
        actual: f64,
    },
    Overflow,
}

pub enum ModeError {
    PersistenceRequiresPaused,
    UnsupportedSpeed,
    InvalidEconomyForMode,
    SandboxObjectivesPresent,
    SandboxGrowthWavesPresent,
    SandboxTerminalState,
    CampaignTerminalWithoutObjectives,
}

pub enum ScenarioError {
    DuplicateGrowthWaveId { wave_id: String },
    TriggerTimesOutOfOrder {
        previous_wave_id: String,
        wave_id: String,
    },
    AppliedAfterUnapplied {
        first_unapplied_wave_id: String,
        later_applied_wave_id: String,
    },
    ActionOutOfBounds {
        wave_id: String,
        action_index: u32,
        point: Point,
    },
    UnknownBuildingType {
        wave_id: String,
        action_index: u32,
    },
    InvalidBuildingRotation {
        wave_id: String,
        action_index: u32,
    },
}

pub enum TileError {
    WrongRowMajorCoordinate { expected: Point, actual: Point },
    CountMismatch { expected: usize, actual: usize },
    NonCanonicalId { expected: String },
    UnsupportedKind,
    UnsupportedArea,
    NonRoadHasRoadState,
    DuplicateRoadConnection,
    NonCanonicalRoadConnectionOrder,
    ConnectionOutOfBounds { heading: Heading },
    ConnectionToNonRoad { neighbor: Point },
    NonReciprocalConnection { neighbor: Point },
    InvalidOneWayAxis,
    InvalidInfrastructureCoexistence,
}

pub enum RoadStructureError {
    NonCanonicalId,
    EmptyFootprint,
    DuplicateFootprintPoint,
    OverlappingFootprint,
    NonRoadFootprintTile,
    TileOwnerMismatch,
    DanglingTileOwner,
    DuplicatePortId,
    DuplicatePortPointEdge,
    InvalidBoundaryPort,
    NonCanonicalFootprint,
    NonCanonicalLaneFacts,
    NonCanonicalMovementFacts,
    AutomaticJunctionMismatch,
}

pub enum EntityError {
    EmptyId,
    NonCanonicalId,
    InvalidStaticShape,
}

pub enum OwnershipError {
    MissingOwner,
    MultipleOwners,
    OwnerTypeMismatch,
    FootprintMismatch,
    AnchorMismatch,
    ReciprocalLinkMissing,
    SpatialOverlap,
}

pub enum AssignmentError {
    DuplicateAssignment,
    ModeMismatch,
    WaypointMissing,
    PlatformMismatch,
    VehicleMissingFromLine,
    VehicleListedByMultipleLines,
    PassengerNotRiding,
    PassengerInMultipleVehicles,
    ItineraryIndexOutOfBounds,
    PathStepIndexOutOfBounds,
    ProgressOutOfRange,
}

pub enum DerivedStateError {
    ClockMismatch,
    StopAccessMismatch { node: EntityRef },
    RouteLegMismatch { route: EntityRef },
    RoutePathBrokenMismatch { route: EntityRef },
    RouteOracleNotIdempotent { route: EntityRef },
    TripStateMismatch { trip: EntityRef },
    TripPositionMismatch { trip: EntityRef },
    TripCounterMismatch,
    MetricsRelationshipMismatch,
    OutcomeWindowMismatch,
    ObjectiveStateMismatch,
    LossReasonMismatch,
}

pub enum RoadTopologyError {
    UnsafeRoundaboutPortMapping {
        structure_id: String,
        footprint: Vec<Point>,
    },
}
```

These are the complete leaves for the HPA-340 v1 persistence wire contract. If
implementation discovers that a listed leaf must split for deterministic error
selection, amend this written contract and its wire examples before adding
code. Implementation may not invent additional leaves ad hoc, replace the
taxonomy with strings, or omit accompanying wire tests.

### 3.4 Representative wire shapes

Exact top-level and nested serialization follows these examples:

```json
{
  "code": "unsupportedSchema",
  "context": { "expected": 4, "actual": 3 }
}
```

```json
{
  "code": "invalidNumericValue",
  "context": {
    "field": "time",
    "reason": { "kind": "notFinite" }
  }
}
```

```json
{
  "code": "invalidTile",
  "context": {
    "tileId": "tile-4-2",
    "reason": {
      "kind": "nonReciprocalConnection",
      "details": { "neighbor": { "x": 5, "y": 2 } }
    }
  }
}
```

```json
{
  "code": "invalidTile",
  "context": {
    "tileId": "",
    "reason": {
      "kind": "countMismatch",
      "details": { "expected": 504, "actual": 503 }
    }
  }
}
```

```json
{
  "code": "danglingReference",
  "context": {
    "source": { "kind": "busRoute", "id": "route-001" },
    "field": "routeWaypointIds",
    "target": { "kind": "stop", "id": "stop-999" }
  }
}
```

```json
{
  "code": "duplicateEntityId",
  "context": {
    "id": "stop-001",
    "firstKind": "building",
    "secondKind": "stop"
  }
}
```

```json
{
  "code": "invalidDerivedState",
  "context": {
    "field": "routeLegs",
    "reason": {
      "kind": "routeLegMismatch",
      "details": {
        "route": { "kind": "busRoute", "id": "route-001" }
      }
    }
  }
}
```

```json
{
  "code": "invalidRoadStructure",
  "context": {
    "structureId": "roundabout:compact2x2:4,2",
    "reason": { "kind": "duplicatePortPointEdge" }
  }
}
```

```json
{
  "code": "invalidRoadTopology",
  "context": {
    "reason": {
      "kind": "unsafeRoundaboutPortMapping",
      "details": {
        "structureId": "roundabout:compact2x2:4,2",
        "footprint": [
          { "x": 4, "y": 2 },
          { "x": 5, "y": 2 },
          { "x": 4, "y": 3 },
          { "x": 5, "y": 3 }
        ]
      }
    }
  }
}
```

### 3.5 First-error policy

Validation returns one error. It does not continue into dependent stages after
an earlier invariant fails. This prevents a single broken identity or footprint
from generating a cascade of misleading reference errors.

The same snapshot always receives the same first error.

## 4. Deterministic Validation Pipeline

The stages run in this fixed order:

1. schema version;
2. snapshot scalar values and redundant clock fields;
3. game mode, economy preset, sandbox settings, and scenario;
4. map dimensions, row-major tiles, tile IDs, and tile values;
5. authored road structures, ports, reciprocal lane facts, and ownership;
6. candidate road-topology compilation;
7. global entity-ID indexes and spatial ownership;
8. transit nodes, platforms, routes, lines, vehicles, and their references;
9. sims, active trips, passengers, and route plans; and
10. metrics, counters, indexes, progress, and remaining derived-state checks.

Topology intentionally precedes the global entity index because it depends
only on the already-validated authored map/structure stages. A snapshot with
both valid topology and a dangling transit reference therefore reaches the
later entity/reference stage and reports that reference error. This ordering is
part of the deterministic first-error contract.

Validators use:

- fixed category order;
- stored vector order where the vector is authoritative;
- sorted/canonical comparison where model order is not semantic; and
- `BTreeMap`/`BTreeSet` for indexes whose iteration may affect error selection.

Do not use `HashMap`/`HashSet` iteration to select the first persistence error.
When an authoritative helper internally uses a hash collection, its output must
be canonicalized before it feeds equality comparison or error selection.
Validation may not assume that an otherwise reusable helper's hash iteration is
stable.

### 4.1 Performance and host lock boundary

Validation builds each ordered identity/reference index once, compiles road
topology once, and runs one read-only all-route derivation. It must not recompile
topology per entity, repeatedly scan full entity vectors for references, or add
an unbounded all-pairs pass where an ordered index provides direct lookup.

The reference performance target is at most 100 ms median in a release build
for the Section 11.3 fixture expanded to 100 routes/lines, 100 vehicles, 1,000
sims, and 1,000 active trips on the project's Apple Silicon development
baseline. Record the measurement during implementation; do not make wall-clock
timing a flaky CI assertion.

Host adapters keep fallible validation outside engine locks. In particular,
the Tauri loader constructs `GameEngine::from_snapshot(snapshot)` before
locking `EngineState`, then holds the mutex only long enough to swap the
prepared engine and clone the returned snapshot. The existing command already
uses that shape and HPA-340 preserves it. HPA-341's save command should clone
the engine under the mutex and call `snapshot_for_save` on that clone after
releasing the lock.

The existing WASM loader runs validation on the browser main thread. HPA-340
records the native release measurement above and, once the bridge compiles,
records the same fixture's WASM timing as implementation evidence. If either
host approaches the interaction budget, HPA-341 owns moving invocation behind
an asynchronous worker/host boundary; core validation must not be weakened or
made partial to hide host-thread cost.

## 5. Snapshot Shell and Numeric Invariants

### 5.1 Schema and pause state

- `schema_version == SNAPSHOT_SCHEMA_VERSION`.
- The expected version is schema v4.
- `paused` must be `true`.
- HPA-340 does not translate v3 or older snapshots.

### 5.2 Time and clock

- `time` is finite and non-negative.
- `time` is below the first value whose day would exceed `u32::MAX`:
  `(u32::MAX as f64 + 1.0) * GAME_DAY_SECONDS`.
- `day == clock::day_index(time)`.
- `clock_minutes == clock::clock_minutes(time)`.
- `speed` is exactly `0`, `1`, `2`, or `4`.

The time bound prevents the existing float-to-integer conversion from
saturating while a serialized clock continues to advance.

### 5.3 Budget and general numeric policy

- `budget >= 0`.
- Every `f64` is checked for finiteness before arithmetic, ordering, conversion,
  geometry, or indexing.
- `NumericError::NotFinite` is always selected before `Negative` or
  `OutOfRange`; every `OutOfRange { minimum, maximum, actual }` payload
  therefore contains only finite JSON numbers. NaN and positive/negative
  infinity are never copied into a `PersistenceError` context.
- Durations, timestamps, waits, progress, and costs use their domain-specific
  non-negative/range checks.
- Index values must be valid for the referenced collection before access.
- Arithmetic needed to validate coordinates, dimensions, sequences, and
  counters uses checked operations.

Typed schema-v4 newtypes such as `DemandMultiplier` and objective thresholds
retain their constructor/Serde guarantees. Persistence still validates their
observable ranges so direct Rust construction or future internal changes
cannot bypass the whole-snapshot contract.

## 6. Rules and Scenario Invariants

Closed schema enums (`GameMode`, `EconomyPreset`, `SandboxTemplateId`, and
`MoveInRateSelection`) reject unknown wire values during full
`GameSnapshot` deserialization. That is a raw host-deserialization failure, not
a `PersistenceError`. Persistence does not duplicate those unreachable
membership checks; it validates the cross-field relationships among the
already-typed values and uses `SnapshotField::{GameMode, EconomyPreset,
SandboxTemplateId}` when reporting those relationships. HPA-339's sole
`MoveInRateSelection::Paused` variant therefore needs no persistence-error
leaf.

### 6.1 Sandbox settings

For sandbox mode:

- `starting_capital` is non-negative and representable by the persisted model;
- demand multiplier is finite and greater than zero;
- scenario objectives are `None`;
- growth waves are empty;
- metrics state is `Running`; and
- loss reason is `None`.

The current mutable budget need not equal starting capital. Starting capital is
the reset contract; budget is live gameplay state.

The current map need not still resemble the chosen template. Players are
expected to edit roads, areas, buildings, and transit after creation.

### 6.2 Campaign settings

For campaign mode:

- economy is Standard;
- Creative campaign is rejected as an invalid mode/preset combination;
- the persisted sandbox settings still use valid schema-v4 values;
- objectives may be present or intentionally absent;
- growth waves may be authored; and
- terminal metric state is allowed only when reachable from the campaign's
  objectives and current serialized metrics.

A campaign without objectives cannot be terminal.

### 6.3 Scenario content

- Scenario names and growth-wave messages remain opaque display text.
  Persistence does not add a new text policy that gameplay does not enforce.
- Growth-wave IDs are non-empty and unique.
- Trigger times are finite, non-negative, and non-decreasing.
- Once an unapplied wave appears, no later wave may be marked applied.
- Objective thresholds satisfy their Rust newtype ranges.
- Growth-action rectangles and origins are in bounds.
- Growth building types and rotations are catalogued.
- Growth actions are validated as authored future commands, not applied during
  validation.

## 7. Map, Tiles, and Authored Road State

### 7.1 Dimensions and row-major identity

- Width equals `sandbox::MAP_WIDTH` and height equals
  `sandbox::MAP_HEIGHT`, the authoritative HPA-339 template constants.
- Tile count is exactly `width * height`.
- Tile index `i` has:
  - `x = i % width`;
  - `y = i / width`; and
  - `id == ids::tile_id(x, y)`.
- Coordinates and tile IDs are therefore unique by construction.

`GameMap::tile` currently falls back to a linear coordinate search when the
row-major index does not match. Persistence rejects such malformed ordering
before any validator relies on `GameMap::tile`.

### 7.2 Tile values

- `kind` is a supported tile kind.
- `area`, when present, is a supported area kind.
- Non-road tiles have:
  - no road connections;
  - no one-way direction; and
  - no road-structure owner.
- Road connections:
  - contain no duplicate headings;
  - remain in canonical heading order;
  - point in bounds to another road tile; and
  - are reciprocal on the neighbor.
- One-way headings are compatible with the authored lane axis and reciprocal
  neighbor facts.
- Track and road coexistence is accepted only where current placement rules
  permit it.

### 7.3 Road structures

- Structure IDs are non-empty and unique.
- Port IDs are non-empty and unique.
- Footprints are non-empty, in bounds, duplicate-free, and non-overlapping.
- Every footprint tile is a road and declares the matching
  `road_structure_id`.
- Every tile-side structure reference resolves to a structure whose footprint
  contains that tile.
- Ports belong to the structure boundary and use valid point/edge/direction
  facts.

Roundabouts additionally require:

- canonical ID for origin and size;
- exact size-derived footprint;
- fixed counterclockwise lane facts;
- canonical internal movement facts; and
- boundary ports consistent with external reciprocal roads.

Automatic junctions additionally require:

- canonical ID;
- canonical footprint and port keys;
- owned tile facts consistent with the junction; and
- equality with automatic-junction reconstruction performed on a clone.

Canonical reconstruction is a validator/oracle. Its candidate is never
committed or returned.

### 7.4 Topology compilation

After authored map validation succeeds, compile `RoadTopology` from the
candidate map. A compilation failure is a typed persistence error.

The compiled topology is retained by `prepare_snapshot` and dropped by the
pure `validate_snapshot` wrapper.

## 8. Identity, Buildings, and Spatial Ownership

### 8.1 Entity identity

Build one ordered identity index for:

- buildings;
- sims;
- active trips;
- stops;
- stations;
- platforms;
- bus routes;
- metro lines; and
- vehicles.

IDs are non-empty, follow their Rust-generated type format, and are globally
collision-free across the complete listed index, not merely unique within each
kind. Engine-generated prefixes partition the space (`building-`, `sim-`,
`trip-day-`, `stop-`, `station-`, node-prefixed platform IDs, `route-`,
`metro-`, and `vehicle-`), so this rejects corruption without excluding
authoritative state. `DuplicateEntityId` reports the ID plus both encountered
kinds; for a same-kind duplicate, `first_kind == second_kind`. Type-specific
canonical formatting includes the day/sequence trip ID format.

Road structures, ports, growth waves, and tiles retain their own structurally
validated namespaces because their formats and lookup rules are different.

### 8.2 Buildings

For each building:

- building type exists in `building_catalog`;
- rotation is `0`, `90`, `180`, or `270`;
- origin is in bounds;
- `occupied_tiles` exactly equals `buildings::footprint` for type, origin, and
  rotation;
- footprint order is canonical row-major;
- all footprint points remain in bounds;
- the footprint satisfies catalogue zoning rules;
- track/road/structure coexistence matches current building rules; and
- the footprint does not overlap another building or incompatible present
  transit node.

A building's `transit_node_id`, when present:

- resolves to exactly one present node;
- matches the building effect;
- matches the building origin; and
- is claimed by no other building.

Ordinary buildings cannot declare transit ownership.

Present transit nodes created by the direct transit intents may legitimately
exist without a building owner. Persistence does not invent one.

## 9. Transit Nodes, Platforms, Routes, and Vehicles

### 9.1 Present and missing nodes

Present stops and stations:

- have in-bounds, non-conflicting anchors;
- match their linked building when one exists;
- satisfy their physical track/road-access rules; and
- do not occupy road-structure-owned tiles.

Present metro stations require track.

A present bus node may have `road_access = None` when that is a legitimate
committed disconnected state, including a standalone building-placed bus stop.
When `road_access` is present:

- the road point is in bounds;
- it references a usable, non-structure road;
- it is valid for the stop/terminal footprint; and
- the preferred heading, when present, is legal for that lane.

For each present bus node, the exact validity oracle is:

```rust
stop.road_access == stop_access::resolve_stop_access(snapshot, &stop.id)
```

This is not equality with a canonical first-road recomputation.
`resolve_stop_access` returns the serialized access unchanged whenever it is
already valid and derives a fallback only when the stored value is missing or
invalid. The comparison therefore accepts any valid committed access, accepts
`None` when no access is available, rejects missing access when gameplay would
resolve one, and rejects stale invalid access. A mismatch returns
`InvalidDerivedState { field: NodeRoadAccess, reason:
StopAccessMismatch { .. } }`.

Persistence never writes the oracle result. Route validation uses the same
read-only resolver when checking serialized route state.

Missing stops/stations are retained tombstones only while referenced by a
route/line:

- their identity, kind, anchor, platforms, and historical road-access value may
  remain serialized;
- they claim no physical map occupancy;
- historical road access is not required to remain live; and
- an unreferenced missing node is invalid because gameplay garbage collection
  would remove it.

This preserves the current remove/restore lifecycle, which marks referenced
nodes missing without clearing their other fields.

### 9.2 Platforms

For every platform:

- ID, label, capacity, count, and ordering match the Rust constructor for the
  owning node kind;
- `route_ids` contain no duplicates;
- every route ID resolves to the compatible bus route or metro line;
- the route contains the owning node as a waypoint; and
- the route/platform relationship is reciprocal.

Each route waypoint is assigned to exactly one platform at that node, including
retained tombstones.

### 9.3 Routes and metro lines

Bus-route waypoint IDs resolve to stops. Metro-line waypoint IDs resolve to
stations. Missing tombstones are valid references; absent entities are not.

Each route/line validates:

- canonical ID type;
- minimum waypoint count;
- waypoint uniqueness;
- service pattern;
- revision;
- exact leg count and service directions;
- terminal-reversal placement;
- every `current_path` has in-bounds points, valid step adjacency/mode, a finite
  non-negative duration, and legal traversal against the compiled topology;
- every historical `last_valid_path` has in-bounds points, valid step
  adjacency/mode, and a finite non-negative duration, without requiring its
  removed roads to remain traversable in the current topology;
- `path_broken` consistency; and
- vehicle references.

Route/line names and colors remain opaque display text. `rename_route` already
applies its own fallback naming policy, while `recolor_route` intentionally
accepts arbitrary strings; persistence does not invent stricter UI policy.

Re-resolve every route/line against the validated map/topology on a clone. Merge
resolved legs through the same last-valid-path policy used by
`route_lifecycle`. The resulting legs and `path_broken` must exactly equal the
serialized values.

Do not call `recompute_all_routes` from persistence. It is a network-mutation
commit helper that may bump revisions, project vehicles, break/restore service,
clear passengers, invalidate trips, and rebase parking. Those effects must not
participate in route-derived validation.

```rust
pub(crate) struct RouteDerivedState {
    pub route_id: String,
    pub mode: TransitMode,
    pub legs: Vec<RouteLegPath>,
    pub path_broken: bool,
}

pub(crate) fn derive_route_states(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
) -> Vec<RouteDerivedState>;
```

Extract this read-only oracle in `route_lifecycle`. In stable bus-route order
followed by metro-line order, it:

1. calls the existing deterministic `resolve_route_legs`;
2. applies only `merge_resolved_legs(Some(serialized_legs), resolved)` so the
   current last-valid-path policy remains authoritative;
3. derives `path_broken` from the merged leg statuses; and
4. returns only route ID, mode, legs, and `path_broken`.

It must not call service transition, revision, vehicle projection, passenger,
trip invalidation, stop-access rebase, or parking-rebase helpers. Persistence
compares only `legs` and `path_broken` on the matching serialized route/line;
revision, assignments, vehicles, passengers, trips, and parking are validated
by their own explicit stages.

For a disconnected leg, `merge_resolved_legs` deliberately preserves the
serialized historical `last_valid_path`; current authored state cannot
reconstruct that history, and the road removal that broke the leg means the
historical path may no longer traverse the current topology. The route stage
therefore applies only structural and numeric checks to `last_valid_path`.
Current-topology traversal is required only for `current_path`. The oracle
proves that the engine's merge policy is at a fixed point without pretending to
prove the historical origin or current traversability of a retained path.

No derived route data replaces the supplied snapshot. For every
persistence-valid engine snapshot, the oracle output equals the serialized
route fields. Replacing only those fields on a clone with the oracle output and
running the oracle again must return the same output. Cover operational routes,
broken routes that retain last-valid legs, and routes through present/missing
node lifecycle states.

### 9.4 Vehicles

For every vehicle:

- mode is Bus or Metro, never Walk;
- `line_id` resolves to the matching route/line;
- it appears exactly once in that route/line's `vehicle_ids`;
- every reciprocal vehicle ID resolves back to it;
- capacity matches the Rust vehicle type;
- passenger IDs are unique;
- itinerary index is valid for the current service itinerary;
- path-step index is valid for the referenced path state;
- step progress is finite and in `0..=1`; and
- parked position, when present, is finite and in map bounds.

Operational routes require vehicle movement indexes compatible with the
current path. Broken routes may retain a parked position from their last valid
path; persistence validates it as historical route state rather than requiring
current live infrastructure beneath it.

Each passenger ID resolves to an active Riding trip for the same line/mode. A
trip appears in at most one vehicle.

## 10. Sims, Trips, Counters, and Metrics

### 10.1 Sims

For every sim:

- ID uses the canonical sim format;
- home and current position are in bounds;
- optional workplace is in bounds;
- worker profile and shift template are compatible;
- non-workers do not carry worker-only commute settings;
- `commute_day <= snapshot.day`; and
- daily flags are monotonic:
  - outbound arrival implies outbound resolution;
  - return-home implies return resolution; and
  - return progress does not precede required outbound progress.

Homes and workplaces do not have to remain occupied by buildings. Bulldozing
intentionally leaves those authored points on the sim.

### 10.2 Active trips

Every trip:

- resolves to exactly one sim;
- has a canonical day/sequence ID;
- references a service day that is not in the future;
- is unique for `(sim, service day, purpose)`;
- has in-bounds origin/destination;
- has a finite, in-bounds world position;
- has finite, non-negative deadline and patience values within lifecycle
  bounds; and
- agrees with the sim's current world position.

Outbound and return endpoints agree with the sim's home/workplace contract,
including the existing dormant home-fallback case.

### 10.3 Route plans and trip state

When a route plan is present:

- legs are non-empty and contiguous;
- first `from` equals the trip origin;
- final `to` equals the trip destination;
- all points are in bounds;
- estimated seconds are finite, non-negative, and equal the deterministic sum
  of the legs; and
- current leg index is valid for the trip status.

Walk legs have:

- no line ID;
- no service direction; and
- no board/alight itinerary indexes.

Bus/metro legs have:

- a compatible route/line ID;
- a valid service direction;
- valid board and alight itinerary indexes; and
- endpoints matching the referenced service visits.

Trip status, route-plan presence, current leg, position, and vehicle membership
must form a reachable trip-lifecycle combination:

- Riding appears in exactly one compatible vehicle;
- non-Riding appears in none;
- terminal trips have final state consistent with their outcome; and
- terminal trips may remain serialized to enforce one trip per sim/day/purpose.

### 10.4 Trip sequence counters

- `trip_sequence_day <= day`.
- `next_trip_sequence >= 1`.
- When `trip_sequence_day == day`, `next_trip_sequence` is strictly greater
  than every trip ID sequence already serialized for that day.
- Incrementing the next sequence must not overflow.

If the stored sequence day is earlier than the snapshot day, the normal next
trip creation will reset it; persistence does not perform that reset early.

### 10.5 Metrics

All metric floats and trip outcomes are validated before objective arithmetic:

- total/average waits are finite and non-negative;
- outcome waits and timestamps are finite and non-negative;
- outcome timestamps do not exceed snapshot time;
- outcomes are chronological; and
- retained outcomes satisfy the existing rolling-window pruning rule,
  including its single older fallback.

Relationships:

- `late_trips <= completed_trips`;
- lifetime completed/late/unserved counts are not smaller than their retained
  outcome subsets;
- `waiting_trip_count` does not exceed the number of serialized nonterminal
  active trips;
- `average_wait_seconds == 0` when `waiting_trip_count == 0`;
- waiting count and average wait are the last values committed by the tick
  metric update, not a cache required to equal the current active-trip states;
  accepted route/line intents may invalidate Waiting trips to Idle without
  recomputing metrics; and
- values that cannot be reconstructed from intentionally pruned history use
  relational validation rather than invented totals.

The rolling-window rule is checked as a fixed point of the existing pruning
oracle using the serialized time:

```rust
let mut expected = snapshot.metrics.trip_outcomes.clone();
objectives::prune_trip_outcomes(
    &mut expected,
    snapshot.time,
    objectives::effective_rolling_window_seconds(snapshot),
);
expected == snapshot.metrics.trip_outcomes
```

The engine tick path advances `next.time` before trip advancement and passes
that advanced value to `update_metrics`, so this comparison uses the same time
that is serialized. More than one retained outcome must be inside the window.
When every outcome is older, the single latest outcome is the allowed fallback.

Metric state:

- sandbox is exactly Running with no loss reason;
- a campaign without objectives is exactly Running with no loss reason;
- Running and Won have no loss reason;
- Lost has exactly one objective-owned reason:
  - `"Too many unserved citizens"`;
  - `"Too many late arrivals"`; or
  - `"Average wait time is too high"`; and
- Won/Lost is allowed only for a campaign with objectives.

Use the existing pure-on-input objective function as the equality oracle; do
not duplicate its thresholds, count gates, lifetime/window asymmetry, or reason
selection in persistence:

1. For serialized Running campaign state,
   `objectives::evaluate_objectives_opt(snapshot)` must return `None`.
2. For serialized Won/Lost state, clone the snapshot, set only
   `metrics.state = Running` and `metrics.loss_reason = None`, then call
   `objectives::evaluate_objectives_opt(&clone)`.
3. The function must return `Some(expected)`, and only
   `expected.metrics.state` plus `expected.metrics.loss_reason` are compared to
   the serialized terminal pair.
4. Assert as a helper invariant that every other field in `expected` remains
   equal to the pre-evaluation clone.

Validation may evaluate this clone but never commits or returns it. The
serialized metrics, time, objective thresholds, outcome window, and
last-tick-committed waiting aggregates remain unchanged.

## 11. Atomicity and Deterministic Continuation

### 11.1 Failed restoration

Tests capture:

- `engine.snapshot()`; and
- `engine.road_topology_for_test().clone()`.

They inject failures at early, middle, topology, and final derived-state stages,
call `restore_snapshot`, and assert both captured values remain equal.

The implementation does not require rollback because it performs no live
mutation before preparation succeeds.

### 11.2 Successful restoration

For a valid snapshot:

- returned snapshot equals the supplied snapshot;
- `engine.snapshot()` equals the supplied snapshot; and
- cached topology equals `RoadTopology::compile(&snapshot.map)`.

### 11.3 Future determinism

Build a nontrivial engine state containing:

- authored ordinary roads;
- an automatic junction;
- a roundabout;
- zoning and buildings;
- present and missing transit nodes;
- a bus route and metro line;
- vehicles;
- sims and active trips; and
- non-empty metrics.

Pause the source engine, save and restore it, then apply the same sequence of
resume, ticks, and intents to the original and restored engines. After every
operation, compare:

- `DispatchResult`;
- complete snapshot; and
- topology where the operation may change roads.

The sequence uses fixed inputs and no host metadata, random values, or
wall-clock state.

## 12. Test Strategy

### 12.1 `persistence_snapshot.rs`

Cover:

- successful `snapshot_for_save` changes only `paused`;
- `snapshot_for_save` returns a persistence error rather than handing out an
  invalid save;
- the running engine remains unchanged;
- canonical HPA-339 Blank Grid and Crossroads snapshots;
- Standard and Creative sandbox snapshots;
- valid campaign snapshots;
- complete save/construct/restore equality; and
- rebuilt topology equality.

Include regressions that take snapshots after representative accepted gameplay
intents and prove `snapshot_for_save` succeeds. One case must create a Waiting
trip, delete or invalidate its route so gameplay changes the trip to Idle
without a tick metric refresh, and then save immediately. This proves
persistence rules accept the last tick-committed metric aggregates produced by
the authoritative engine.

### 12.2 `persistence_corruption.rs`

Use table-driven fixtures derived from real schema-v4 engine state. Each case
changes one field and asserts one exact error.

Cover:

- schema;
- unpaused input;
- `NaN`, positive/negative infinity, negative values, and upper bounds;
- clock drift;
- mode/preset/scenario combinations;
- dimensions, tile count, row order, coordinates, and tile IDs;
- road reciprocity, structure footprint, ownership, ports, roundabout facts,
  automatic-junction facts, and topology failure;
- every duplicate-ID category, including one same-kind and one cross-kind
  collision that assert both reported kinds;
- building footprint/owner mismatches;
- missing/dangling entity references;
- tombstone lifetime, including a referenced missing node that remains valid
  and the same node becoming invalid after its last route is deleted;
- present stop access that is already valid but differs from
  `derive_stop_access_for_footprint`'s first candidate (accepted), missing
  access with an available fallback (rejected), invalid stored access
  (rejected), legitimately disconnected `None` (accepted), and missing-node
  historical access whose road has since disappeared (accepted);
- platform reciprocity;
- route and vehicle assignment;
- stale route legs;
- invalid indexes/progress;
- sim/trip endpoint and status mismatch;
- counter overflow; and
- metrics/outcome inconsistency.

Metric-state corruption cases include Running state for which
`evaluate_objectives_opt` would fire, each exact Lost reason, a mismatched Lost
reason, Won without a satisfied survival gate, terminal campaign state without
objectives, and any terminal sandbox state.

Include snapshots with multiple corruptions to prove the documented first-error
order.

For rolling outcomes, include a tick-produced snapshot spanning multiple
substeps and prove pruning is a fixed point at the serialized
`snapshot.time`. Also include the single older fallback and reject multiple
older outcomes.

### 12.3 `persistence_atomicity.rs`

Cover:

- pure validation cannot mutate an engine;
- every representative failed restore preserves snapshot and topology;
- a topology-stage failure remains atomic;
- a final derived-state failure remains atomic; and
- valid restoration swaps snapshot and topology together.

### 12.4 `persistence_determinism.rs`

Cover save → restore → identical ticks/intents → identical results and
snapshots using the nontrivial city described in Section 11.3.

### 12.5 Error wire tests

Assert exact camelCase serialization for every top-level error code and every
closed nested leaf in Section 3.3, including the representative complete
payloads in Section 3.4. Round-trip each payload through Serde and assert that
unknown `code`, `field`, `kind`, and entity-kind values are rejected.
Also reject unknown keys beside `code`/`context`, inside every struct-variant
context, inside `reason`, inside `details`, and inside `EntityRef`/`MapSize`.
This is the `deny_unknown_fields` v1 wire policy; persistence errors do not
silently accept additive fields.

### 12.6 Route-derived fixed-point tests

Add focused route-lifecycle coverage proving that the read-only
`derive_route_states` oracle equals serialized `legs`/`path_broken` and is
idempotent for valid, broken, last-valid, and missing-node route states.
Snapshot the candidate's revisions, vehicles, passengers, trips, parking, and
stop access before the call and assert none change. These tests are
prerequisites for using the helper as the persistence route oracle.
One broken-route case removes a road used by `last_valid_path` and proves the
historical path passes structural validation without passing current-topology
traversal; the absent `current_path` plus derived broken status remains the
oracle comparison.

### 12.7 Existing host bridge and test migration

The existing WASM and Tauri schema probes construct
`PersistenceError::UnsupportedSchema`, and their `GameEngine::from_snapshot`
call sites serialize every `PersistenceError` unchanged. Existing TypeScript
`loadSnapshot` methods continue returning a snapshot on success and rejecting
on failure; HPA-340 does not add the HPA-341 result union.

The rejected-promise compatibility contract is:

| Failure source | WASM `loadSnapshot` rejection | Tauri `loadSnapshot` rejection |
| --- | --- | --- |
| Schema probe | The Section 3.4 `unsupportedSchema` object from `serde_wasm_bindgen` | The same JSON object returned as the command error |
| Semantic validation | The serialized `PersistenceError` object from `serde_wasm_bindgen` | The same serialized JSON object returned as the command error |
| Raw snapshot deserialization or transport | A JavaScript string rejection from `to_js_error`; not a `PersistenceError` | A JSON string command error; not a `PersistenceError` |

Both schema probes preserve their existing `unwrap_or(0)` policy. In an
`UnsupportedSchema` payload, `actual: 0` is the reserved result when
`schemaVersion` is missing, has the wrong type, or the probe otherwise cannot
deserialize it. A literal numeric schema version of `0` is indistinguishable
and is rejected with the same payload. Add exact WASM and Tauri tests for the
unreadable probe case.

For example, unpaused semantic input rejects with:

```json
{
  "code": "invalidModeSettings",
  "context": {
    "field": "paused",
    "reason": { "kind": "persistenceRequiresPaused" }
  }
}
```

The async TypeScript adapters propagate those object/string rejection reasons
unchanged. Object failures are asserted with `rejects.toMatchObject` or
`rejects.toEqual`, not message matching; raw string failures retain focused
string assertions until HPA-341 introduces the frontend result/transport
normalization boundary.

Update the real-WASM, Tauri-command, and backend forwarding tests so:

- valid load fixtures are internally coherent and paused;
- an unpaused fixture is rejected rather than silently loaded;
- schema and semantic failures assert the new persistence error wire shape; and
- mock forwarding tests do not present unpaused input as a successful semantic
  load.

### 12.8 Existing core test migration

Update existing engine/topology fixtures to canonical schema-v4 snapshots.

Post-HPA-340 tests use exactly these fixture paths:

1. Start from `GameEngine::new()` or the HPA-339 requested-sandbox constructor,
   apply gameplay intents, and call `snapshot_for_save`.
2. Use the HPA-339 sandbox/campaign factories to obtain canonical paused
   construction state.
3. Use one shared integration-test helper in
   `crates/caelum-core/tests/common/mod.rs`:
   - `strict_engine_from_fixture` sets only `paused = true` on a fixture and
     constructs it through production `GameEngine::from_snapshot`;
   - `running_engine_from_fixture` calls the strict helper and then dispatches
     `SetPaused { paused: false }`.

The shared helper never bypasses validation, normalizes stop access, or
recomputes route state. A fixture rejected by the strict helper must be fixed
or deliberately moved to a corruption test; do not add ad hoc unchecked engine
constructors. Tests whose subject is an unpaused gameplay tick construct a
strict paused engine first and unpause through the normal intent.

Before changing the return type, inventory every `GameEngine::from_snapshot`
caller. After migration, production callers are limited to the two existing
host load bridges; persistence construction/corruption tests may call it
directly, and unrelated core tests use the shared strict/running fixture
helpers. Add a repository search assertion to the implementation review notes
so no old convenience caller is silently missed.

Retire pre-persistence tests that expect `from_snapshot` to repair legacy stop
state. Preserve tests for live stop-access normalization after gameplay
mutations and convert malformed-load cases into strict persistence rejection
coverage.

This migration is a blocking implementation workstream, not incidental test
cleanup. Before adding the strict validator, inventory and classify every
`from_snapshot` caller as:

1. one of the two production host load bridges;
2. a valid fixture constructor migrated to `tests/common/`; or
3. an intentionally malformed legacy-load test converted into a focused
   persistence-corruption rejection.

In particular, `stop_migration.rs` cases that currently pass extreme or
malformed coordinates and assert successful normalization move to category 3;
they are not made persistence-valid merely to preserve their old success
expectation. Land the shared helper and caller migration as a dedicated plan
task, keeping `cargo test -p caelum-core` green before proceeding to the full
corruption matrix.

## 13. File Map

Create:

- `crates/caelum-core/src/persistence/mod.rs`
- `crates/caelum-core/src/persistence/error.rs`
- `crates/caelum-core/src/persistence/map.rs`
- `crates/caelum-core/src/persistence/entities.rs`
- `crates/caelum-core/src/persistence/trips.rs`
- `crates/caelum-core/tests/persistence_snapshot.rs`
- `crates/caelum-core/tests/persistence_corruption.rs`
- `crates/caelum-core/tests/persistence_atomicity.rs`
- `crates/caelum-core/tests/persistence_determinism.rs`

Modify:

- `crates/caelum-core/src/lib.rs`
- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/rejection.rs`
- `crates/caelum-core/src/road_topology.rs`
- `crates/caelum-core/src/roundabouts.rs`
- `crates/caelum-core/src/route_lifecycle.rs`
- `crates/caelum-core/src/preview.rs`
- narrow helper visibility/signatures in other authoritative gameplay modules
  where read-only validation reuse requires it
- existing `from_snapshot`, schema, engine-topology, route, stop, trip, and
  wire-format tests affected by the strict contract
- `crates/caelum-core/tests/common/mod.rs`
- `crates/caelum-wasm/src/lib.rs`
- `src-tauri/src/lib.rs`
- `src/domain/types.ts`
- `src/runtime/rejectionMessages.ts`
- `src/runtime/backend/wasmBackend.ts`
- `src/runtime/backend/tauriBackend.ts`
- `tests/runtime/backendContract.test.ts`
- `tests/runtime/wasmArtifact.smoke.test.ts`
- `tests/runtime/wasmBackend.test.ts`
- `tests/runtime/tauriBackend.test.ts`

Do not add a new host command, backend method, storage module, or UI in this
issue. The listed host/backend changes only bridge the existing load path to
the new core error and paused-input contract.

## 14. Verification

Run:

```sh
cargo fmt --all --check
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
cargo test --workspace
bun run test:unit -- tests/runtime/wasmArtifact.smoke.test.ts \
  tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts
```

If the HPA-339 implementation adds required workspace-level non-Rust gates,
run those unchanged gates as well. HPA-340 does not add new WASM, Tauri,
browser, or storage behavior, but the existing host bridge tests remain part
of workspace compatibility.

## 15. Acceptance-Criteria Mapping

| HPA-340 criterion | Design proof |
| --- | --- |
| Save snapshot preserves every field except paused | Validated `snapshot_for_save` success contract and `persistence_snapshot.rs` |
| Valid round trip restores equal gameplay state and topology | Strict prepared candidate, snapshot equality, and fresh topology comparison |
| Invalid schema, IDs, references, assignments, numbers, and mode settings return typed errors | Closed persistence error model plus corruption table |
| Failed restore leaves snapshot/topology unchanged | Candidate-first restoration and late-stage atomicity tests |
| Save/restore continuation is deterministic | Nontrivial dual-engine tick/intent sequence |
| Validation is deterministic and host-independent | Fixed stage order, ordered indexes, typed snapshot input, and no host metadata |
