# HPA-340 Rust Persistence Validation and Atomic Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, deterministic Rust persistence boundary that produces validated paused snapshots, reconstructs or atomically replaces `GameEngine`, preserves valid snapshot bytes semantically unchanged, and returns one closed structured error contract for malformed schema-v4 state.

**Architecture:** A new private `caelum_core::persistence` module validates an already-deserialized `GameSnapshot` through a fixed ten-stage pipeline. It builds ordered indexes once, invokes existing gameplay oracles for topology, route state, stop access, itinerary, clock, metrics, and objectives, and returns a private prepared snapshot containing the untouched snapshot plus its compiled `RoadTopology`. `GameEngine` prepares candidates before mutation; the existing WASM and Tauri load bridges serialize the same `PersistenceError` without adding HPA-341 storage or UI APIs.

**Tech Stack:** Rust 2021, Serde/serde_json, wasm-bindgen, serde-wasm-bindgen, Tauri 2, TypeScript 5.8, Bun, Vitest.

**Companion design:** `docs/superpowers/specs/2026-07-27-rust-persistence-validation-design.md` is the approved invariant and wire-contract authority. If implementation evidence requires changing a listed invariant or error leaf, amend and re-approve that design before changing code.

## Global Constraints

- HPA-339 is a hard prerequisite. Do not implement schema v4, sandbox templates, `starting_capital`, or temporary compatibility shims in HPA-340.
- Accept only `SNAPSHOT_SCHEMA_VERSION == 4`; do not migrate, repair, normalize, or reinterpret older snapshots.
- A persistence candidate must already be paused. Only `snapshot_for_save` may set `paused = true`, and only on its returned clone.
- Successful validation preserves every serialized field exactly. Rebuild only the non-serialized `RoadTopology`.
- Failed construction or restoration must not mutate the live snapshot or cached topology.
- Return one deterministic first error using fixed category order, stored vector order, canonical comparison, and `BTreeMap`/`BTreeSet` indexes.
- Never use `HashMap`/`HashSet` iteration to choose an error. Canonicalize outputs from reused helpers whose internals use hash collections before comparison.
- Validate every `f64` for finiteness before arithmetic, ordering, conversion, geometry, indexing, or inclusion in an error payload.
- Keep `PersistenceError` separate from `GameplayRejection`; persistence never wraps or exposes gameplay errors.
- All tagged persistence enums use `tag`, `content`, `rename_all = "camelCase"`, `rename_all_fields = "camelCase"`, and `deny_unknown_fields`.
- All named persistence context structs use `rename_all = "camelCase"` and `deny_unknown_fields`.
- Topology compilation gets a focused error type with exhaustive gameplay and persistence conversions.
- Route validation uses a pure fixed-point oracle. It must not change revisions, vehicles, passengers, trips, parking, stop access, or any other snapshot field.
- Waiting metrics are last-tick aggregates. Do not require them to equal current Waiting trip state after accepted intents.
- Rolling outcomes must be a fixed point of the existing pruning oracle at serialized `snapshot.time`.
- Objective state must be checked with the existing objective evaluator on a clone; do not duplicate thresholds or reason selection.
- HPA-340 may minimally adapt the shipped WASM/Tauri `loadSnapshot` path. It adds no save command, storage layer, envelope, new backend method, or UI.
- Preserve Rust gameplay authority, immutable snapshot semantics, reference-equality dispatch, deterministic ordering, and the existing public success shape.
- Prefix every repository shell command with `rtk`.

---

## Hard Prerequisite Gate — Run Before Task 1

This gate is intentionally outside the numbered implementation tasks. It is a stop condition, not work to absorb into HPA-340.

- [ ] Fetch and inspect the integration baseline:

```sh
rtk git fetch origin
rtk git status --short --branch
rtk rg -n 'SNAPSHOT_SCHEMA_VERSION.*4|BlankGrid|Crossroads|starting_capital|StartingCapital|from_sandbox_request|create_sandbox_snapshot|create_sandbox_candidate' crates/caelum-core/src src/domain/types.ts
rtk rg -n 'GrowingSuburb|SNAPSHOT_SCHEMA_VERSION.*3' crates/caelum-core/src src/domain/types.ts
```

Expected: schema v4 exists in Rust and TypeScript; `SandboxTemplateId` has `BlankGrid` and `Crossroads`; `SandboxSettings` persists `starting_capital`; `crates/caelum-core/src/sandbox.rs` owns `MAP_WIDTH`, `MAP_HEIGHT`, canonical request/factory code, and a candidate containing snapshot plus topology; `GameEngine::from_sandbox_request` exists; production schema declarations no longer say v3 or `GrowingSuburb`.

- [ ] Run the prerequisite's focused tests:

```sh
rtk cargo test -p caelum-core --test sandbox_factory
rtk cargo test -p caelum-core --test sandbox_engine
```

Expected: both HPA-339 suites pass. If a test target or required symbol is absent, stop.

- [ ] Record the gate result in the implementation handoff.

If any expected interface is absent, make no HPA-340 source edit and do not create a compatibility layer. Report: “HPA-340 remains blocked on HPA-339 implementation.” Taking on HPA-339 requires a separate user scope decision.

---

## File Map

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
- `crates/caelum-core/src/sandbox.rs` only for the focused topology-error conversion required by HPA-339's already-landed candidate
- narrow authoritative helper visibility in `clock.rs`, `network.rs`, `objectives.rs`, `platforms.rs`, `service_itinerary.rs`, `stop_access.rs`, or `trips.rs` only where validation reuses the existing oracle
- `crates/caelum-core/tests/common/mod.rs`
- every existing core test that calls `GameEngine::from_snapshot`
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

Do not create or modify storage, save-envelope, persistence UI, or new host-command files.

---

### Task 1: Closed Persistence Error and Wire Contract

**Files:**

- Create: `crates/caelum-core/src/persistence/error.rs`
- Create: `crates/caelum-core/src/persistence/mod.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Test: unit tests in `crates/caelum-core/src/persistence/error.rs`

**Consumes:** `Point`, `Heading`, schema-v4 domain enums, and `serde::{Serialize, Deserialize}`.

**Produces:**

```rust
pub type PersistenceResult<T> = Result<T, PersistenceError>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PersistenceError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidNumericValue {
        #[serde(skip_serializing_if = "Option::is_none")]
        entity: Option<EntityRef>,
        field: SnapshotField,
        reason: NumericError,
    },
    InvalidModeSettings { field: SnapshotField, reason: ModeError },
    InvalidScenario { field: SnapshotField, reason: ScenarioError },
    InvalidMapDimensions { expected: MapSize, actual: MapSize },
    InvalidTile { tile_id: String, reason: TileError },
    InvalidRoadStructure { structure_id: String, reason: RoadStructureError },
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
    InvalidAssignment { entity: EntityRef, reason: AssignmentError },
    InvalidDerivedState { field: SnapshotField, reason: DerivedStateError },
    InvalidRoadTopology { reason: RoadTopologyError },
}
```

Also produce the complete closed vocabulary from design Section 3.3:

- structs: `EntityRef`, `MapSize`;
- enums: `EntityKind`, `SnapshotField`;
- reason enums: `NumericError`, `ModeError`, `ScenarioError`, `TileError`, `RoadStructureError`, `EntityError`, `OwnershipError`, `AssignmentError`, `DerivedStateError`, `RoadTopologyError`;
- no string catch-all, arbitrary field path, or `Other` variant.

- [ ] **Step 1: Write failing representative wire tests**

Add exact serialization and round-trip assertions before defining the types:

```rust
#[test]
fn unsupported_schema_has_exact_wire_shape() {
    let error = PersistenceError::UnsupportedSchema {
        expected: 4,
        actual: 3,
    };
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::json!({
            "code": "unsupportedSchema",
            "context": { "expected": 4, "actual": 3 }
        })
    );
}

#[test]
fn entity_field_and_nested_reason_are_camel_case() {
    let error = PersistenceError::InvalidDerivedState {
        field: SnapshotField::RouteLegs,
        reason: DerivedStateError::RouteLegMismatch {
            route: EntityRef {
                kind: EntityKind::BusRoute,
                id: "route-001".to_string(),
            },
        },
    };
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        serde_json::json!({
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
        })
    );
}
```

Run:

```sh
rtk cargo test -p caelum-core persistence::error::tests
```

Expected: compile failure because the persistence types do not exist.

- [ ] **Step 2: Define the closed types exactly**

Copy every top-level variant, field variant, entity kind, and reason leaf from design Section 3.3. Use this attribute on every tagged reason enum:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "details",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
```

Expose only `PersistenceError`, `PersistenceResult`, and context types required by the public error payload. Keep validators private.

- [ ] **Step 3: Prove the wire vocabulary is closed**

Add table-driven tests that instantiate every top-level error and every nested leaf at least once. Add negative deserialization cases for:

```rust
[
    r#"{"code":"unknown","context":{}}"#,
    r#"{"code":"unsupportedSchema","context":{"expected":4,"actual":3,"extra":1}}"#,
    r#"{"code":"invalidNumericValue","context":{"field":"unknown","reason":{"kind":"notFinite"}}}"#,
    r#"{"code":"invalidNumericValue","context":{"field":"time","reason":{"kind":"unknown"}}}"#,
    r#"{"code":"danglingReference","context":{"source":{"kind":"unknown","id":"x"},"field":"routeWaypointIds","target":{"kind":"stop","id":"y"}}}"#,
]
```

Also reject unknown keys beside `code`/`context`, inside every struct-variant context, inside `reason`, inside `details`, and inside `EntityRef`/`MapSize`.

- [ ] **Step 4: Export the deliberate public surface**

Declare `pub(crate) mod persistence;` and re-export the error/result/context types from `lib.rs`. Do not expose stage validators.

- [ ] **Step 5: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core persistence::error
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/persistence crates/caelum-core/src/lib.rs
rtk git commit -m "feat(core): add closed persistence error contract"
```

---

### Task 2: Focused Road Topology Compile Error

**Files:**

- Modify: `crates/caelum-core/src/road_topology.rs`
- Modify: `crates/caelum-core/src/roundabouts.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/preview.rs`
- Modify: post-HPA-339 `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/src/persistence/error.rs`
- Test: focused module tests in `road_topology.rs` and `roundabouts.rs`

**Produces:**

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoadTopologyCompileError {
    UnsafeRoundaboutPortMapping {
        structure_id: String,
        footprint: Vec<Point>,
    },
}

impl RoadTopology {
    pub(crate) fn compile(
        map: &GameMap,
    ) -> Result<Self, RoadTopologyCompileError>;
}
```

- [ ] **Step 1: Add failing focused-error tests**

Create one malformed authored-map fixture per fallible family:

- unsafe `roundabout_parts`/ring-neighbor mapping;
- unsafe circulation edge;
- unsafe entry/inbound mapping;
- unsafe exit/outbound mapping.

Each must assert the focused error contains the structure ID and canonical candidate footprint:

```rust
assert_eq!(
    RoadTopology::compile(&map).unwrap_err(),
    RoadTopologyCompileError::UnsafeRoundaboutPortMapping {
        structure_id: structure.id.clone(),
        footprint: structure.footprint.clone(),
    }
);
```

Run:

```sh
rtk cargo test -p caelum-core road_topology
rtk cargo test -p caelum-core roundabout
```

Expected: compile failure because `RoadTopology::compile` still returns `GameplayRejection`.

- [ ] **Step 2: Narrow the compile call graph**

Change `compile_roundabout_transitions` and every fallible helper it calls to return `RoadTopologyCompileError`. Pass the canonical footprint into helpers that currently know only the structure ID. Leave placement-time validation on `GameplayRejection`.

Keep reciprocal-lane and automatic-junction compilation infallible. Do not add unrelated variants.

- [ ] **Step 3: Add exhaustive conversions at each boundary**

Gameplay conversion:

```rust
fn topology_compile_rejection(
    error: RoadTopologyCompileError,
) -> GameplayRejection {
    match error {
        RoadTopologyCompileError::UnsafeRoundaboutPortMapping {
            structure_id,
            footprint,
        } => GameplayRejection::unsafe_roundabout_port_mapping(
            structure_id,
            footprint,
        ),
    }
}
```

Persistence conversion:

```rust
fn topology_persistence_error(
    error: RoadTopologyCompileError,
) -> PersistenceError {
    match error {
        RoadTopologyCompileError::UnsafeRoundaboutPortMapping {
            structure_id,
            footprint,
        } => PersistenceError::InvalidRoadTopology {
            reason: RoadTopologyError::UnsafeRoundaboutPortMapping {
                structure_id,
                footprint,
            },
        },
    }
}
```

Use the gameplay conversion in engine commits, previews, and the HPA-339 sandbox candidate. Keep the persistence conversion private to `persistence`.

- [ ] **Step 4: Prove exhaustiveness and behavior**

Add direct unit tests for both conversion payloads. Do not match on `RejectionCode`; adding a future `RoadTopologyCompileError` variant must make both conversions fail to compile.

- [ ] **Step 5: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core road_topology
rtk cargo test -p caelum-core roundabout
rtk cargo test -p caelum-core sandbox
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/road_topology.rs crates/caelum-core/src/roundabouts.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/preview.rs crates/caelum-core/src/sandbox.rs crates/caelum-core/src/persistence/error.rs
rtk git commit -m "refactor(core): focus topology compilation errors"
```

---

### Task 3: Pure Route-Derived Fixed-Point Oracle

**Files:**

- Modify: `crates/caelum-core/src/route_lifecycle.rs`
- Test: module tests in `crates/caelum-core/src/route_lifecycle.rs`

**Consumes:** `network::resolve_route_legs`, existing `merge_resolved_legs`, and stored bus/metro route order.

**Produces:**

```rust
#[derive(Clone, Debug, PartialEq)]
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

- [ ] **Step 1: Characterize current route recomputation**

Add valid, broken, missing-node, and last-valid-path cases. Capture these fields before calling the new oracle:

```rust
let revisions = route_revisions(&snapshot);
let vehicle_ids = route_vehicle_ids(&snapshot);
let passengers = vehicle_passengers(&snapshot);
let trips = snapshot.active_trips.clone();
let parking = vehicle_parking(&snapshot);
let stop_access = stored_stop_access(&snapshot);
```

Assert derived `legs` and `path_broken` equal the stored state, then assert every captured value remains unchanged.

- [ ] **Step 2: Implement read-only derivation**

For each route in stored category/vector order:

1. call `network::resolve_route_legs` with the supplied authoritative routing context;
2. call `merge_resolved_legs(Some(serialized_legs), resolved)`;
3. return only route ID, mode, derived legs, and derived broken flag;
4. do not clone and run `recompute_all_routes`, because that routine performs unrelated lifecycle mutations.

The merge rule must retain the last-valid leg for a broken route while keeping `current_path = None`.

- [ ] **Step 3: Prove fixed-point and historical-path semantics**

Call the oracle twice and assert equal output. Remove a road underneath a broken route's `last_valid_path` and prove:

- the historical last-valid path remains accepted as serialized history;
- current resolution remains absent;
- `path_broken` remains true;
- no current-topology traversal check is applied to the historical path.

Replace only `legs` and `path_broken` on a clone with the first oracle output,
run the oracle again with the same topology, and assert the output is equal.

- [ ] **Step 4: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core route_lifecycle
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/route_lifecycle.rs
rtk git commit -m "refactor(core): expose pure route state oracle"
```

---

### Task 4: Deterministic Snapshot, Rules, Map, and Topology Validation

**Files:**

- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Create: `crates/caelum-core/src/persistence/map.rs`
- Modify narrowly: authoritative map/road helpers where read-only reuse requires visibility
- Test: module tests in `persistence/map.rs`

**Produces:**

```rust
pub(super) fn validate_shell_rules_map_and_compile(
    snapshot: &GameSnapshot,
) -> PersistenceResult<RoadTopology>;
```

At this task, only private stage code exists. Do not export or re-export a
partially validating `validate_snapshot`; the public facade lands only after
all ten real stages are connected. Private no-op validator stubs are forbidden.

- [ ] **Step 1: Build canonical schema-v4 fixtures**

Use HPA-339 factories, never hand-assemble a baseline:

```rust
fn crossroads_snapshot() -> GameSnapshot {
    let mut snapshot =
        create_sandbox_snapshot(SandboxCreationRequest::default()).unwrap();
    snapshot.paused = true;
    snapshot
}
```

Add one table row per early corruption and assert the exact error, not only the code:

- schema mismatch before every other error;
- unpaused;
- time `NaN`, infinities, negative, and day-overflow bound;
- clock/day drift and unsupported speed;
- negative budget;
- sandbox/campaign economy, settings, objectives, growth waves, terminal-state relationships;
- duplicate/out-of-order growth waves and invalid actions;
- wrong dimensions/tile count/row coordinate/tile ID;
- invalid tile kind/area/road facts;
- road reciprocity/ordering/bounds;
- road structure footprint, ownership, ports, canonical lane/movement facts;
- automatic-junction mismatch;
- focused topology failure.

- [ ] **Step 2: Implement scalar and clock validation**

Use helpers that never copy a nonfinite value into an error:

```rust
fn finite_non_negative(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
) -> PersistenceResult<()> {
    if !value.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::NotFinite,
        });
    }
    if value < 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}
```

Then validate `day == clock::day_index(time)`, `clock_minutes == clock::clock_minutes(time)`, and speed exactly in `{0, 1, 2, 4}`. Do not add the redundant `clock_minutes < MINUTES_PER_DAY` check.

- [ ] **Step 3: Implement mode/rules/scenario validation**

Use the schema-v4 typed values. Enforce:

- sandbox starting capital nonnegative, demand multiplier finite and positive, no objectives/waves, Running metrics, no loss reason;
- campaign Standard economy, valid persisted sandbox settings, no terminal state without objectives;
- unique nonempty wave IDs, finite nondecreasing trigger times, no applied wave after an unapplied wave;
- every wave action point/building rotation/type is valid and in bounds.

Opaque scenario names/messages remain unrestricted.

- [ ] **Step 4: Implement canonical map and authored-road validation**

Compare dimensions to `sandbox::MAP_WIDTH` and `sandbox::MAP_HEIGHT`, never literal `28`/`18` in validator assertions. Traverse expected `(y, x)` row-major order and validate:

- exact tile count, coordinate, and `tile_id(x, y)`;
- closed tile kind/area combinations;
- no road state on non-road tiles;
- unique canonical road-connection order;
- in-bounds reciprocal road neighbors;
- one-way axis and infrastructure coexistence;
- canonical structure IDs, footprints, tile ownership, ports, lane/movement facts, automatic-junction state.

Use checked arithmetic for expected count and coordinates.

- [ ] **Step 5: Compile topology exactly once**

Only after authored map stages pass:

```rust
let topology = RoadTopology::compile(&snapshot.map)
    .map_err(topology_persistence_error)?;
```

Return it from `validate_and_compile`; do not compile per route or entity.

- [ ] **Step 6: Prove first-error order**

Create snapshots with two corruptions:

- schema + invalid tile;
- unpaused + invalid road structure;
- invalid dimensions + topology failure.

Assert the earlier documented stage wins.

- [ ] **Step 7: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core persistence::map
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/persistence
rtk git commit -m "feat(core): validate persistence map and rules"
```

---

### Task 5: Ordered Entity, Ownership, Transit, Route, and Vehicle Validation

**Files:**

- Create: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Modify narrowly: `platforms.rs`, `service_itinerary.rs`, `stop_access.rs`, and canonical ID helpers if visibility is required

**Produces:** stage 7–8 validators and ordered indexes reused by the trip stage.

```rust
struct EntityIndexes<'a> {
    buildings: BTreeMap<&'a str, &'a Building>,
    sims: BTreeMap<&'a str, &'a Sim>,
    trips: BTreeMap<&'a str, &'a ActiveTrip>,
    stops: BTreeMap<&'a str, &'a TransitStop>,
    stations: BTreeMap<&'a str, &'a MetroStation>,
    platforms: BTreeMap<&'a str, PlatformOwner<'a>>,
    bus_routes: BTreeMap<&'a str, &'a BusRoute>,
    metro_lines: BTreeMap<&'a str, &'a MetroLine>,
    vehicles: BTreeMap<&'a str, &'a Vehicle>,
}

pub(super) fn validate_entities<'a>(
    snapshot: &'a GameSnapshot,
    topology: &RoadTopology,
) -> PersistenceResult<EntityIndexes<'a>>;
```

- [ ] **Step 1: Add global identity corruption cases**

Test empty/noncanonical IDs, same-kind duplicates, and cross-kind collisions. Cross-kind coverage must assert both kinds:

```rust
let topology =
    validate_shell_rules_map_and_compile(&snapshot).unwrap();
assert_eq!(
    validate_entities(&snapshot, &topology).unwrap_err(),
    PersistenceError::DuplicateEntityId {
        id: "stop-001".into(),
        first_kind: EntityKind::Building,
        second_kind: EntityKind::Stop,
    }
);
```

Insert categories in the exact fixed order from the design, and use that same order when reporting `first_kind`/`second_kind`.

- [ ] **Step 2: Build ordered indexes once**

Index every globally identified building, sim, active trip, stop, station, platform, route, line, and vehicle. Never rescan full vectors to resolve each reference. Do not use hash iteration for diagnostics.

- [ ] **Step 3: Validate buildings and spatial ownership**

For each building validate:

- catalog type exists;
- rotation and origin are valid;
- canonical footprint equals serialized occupied tiles;
- all footprint points are in bounds and nonoverlapping;
- every tile owner link is exact and reciprocal;
- optional transit-node ID resolves to the expected node kind/anchor;
- no building or structure claims the same spatial tile twice.

- [ ] **Step 4: Validate node lifetime and stop access**

Enforce present/missing node shape and tombstone lifetime:

- present nodes require valid anchors and current physical ownership;
- missing nodes remain only while referenced by a route/line;
- deleting the last reference makes a missing node invalid;
- missing-node historical access is not revalidated against current roads.

For a present bus stop compare exactly:

```rust
stop.road_access
    == stop_access::resolve_stop_access(snapshot, &stop.id)
```

Do not compare against only `derive_stop_access_for_footprint`'s first candidate. Cover valid non-first stored access, missing fallback, invalid stored access, legitimately disconnected `None`, and missing-node historical access.

- [ ] **Step 5: Validate canonical platforms**

Compare stored platform count/order/IDs/labels/capacities against:

```rust
platforms::bus_platforms(stop_id, kind)
platforms::metro_platforms(station_id)
```

Then validate route-ID reciprocity. Canonicalize any helper output before comparison if its internals are hash-backed.

- [ ] **Step 6: Validate routes and lines with the pure oracle**

Validate waypoint presence/kind, pattern, revision, estimated duration, and route/line vehicle IDs. Call the oracle once for all routes:

```rust
let derived = route_lifecycle::derive_route_states(
    snapshot,
    RoutingContext {
        road_topology: topology,
    },
);
```

Compare only:

- serialized `legs` to derived `legs`;
- serialized `path_broken` to derived `path_broken`.

Call the oracle again in a focused test and report `RouteOracleNotIdempotent` if the two outputs differ. This is a guard on the helper contract, not permission to mutate the snapshot.

- [ ] **Step 7: Validate vehicles and assignments**

For each vehicle validate:

- mode/line compatibility and reciprocal line listing;
- one line owner only;
- canonical capacity;
- passenger IDs unique locally and globally;
- passenger trip is Riding on the same line/mode;
- itinerary index and path-step index in bounds before access;
- finite progress in range;
- parked position matches the authoritative itinerary/route state.

Use `service_itinerary::build_service_itinerary` and `service_visits`; do not duplicate itinerary construction.

- [ ] **Step 8: Add first-error and corruption coverage**

Cover every entity/reference/ownership/assignment leaf, including multiple-corruption cases that prove identity precedes dangling references and routes precede vehicles.

- [ ] **Step 9: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core persistence::entities
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/persistence crates/caelum-core/src/platforms.rs crates/caelum-core/src/service_itinerary.rs crates/caelum-core/src/stop_access.rs
rtk git commit -m "feat(core): validate persistence entities and transit"
```

Only add authoritative helper files to the commit if their visibility/signature actually changed.

---

### Task 6: Sim, Trip, Counter, Metrics, and Objective Validation

**Files:**

- Create: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Modify narrowly: `crates/caelum-core/src/objectives.rs` or `trips.rs` only for read-only oracle visibility

**Produces:**

```rust
pub(super) fn validate_trips(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<()>;
```

- [ ] **Step 1: Add sim and active-trip corruption cases**

Cover:

- canonical sim/trip IDs;
- in-bounds home/current/workplace/origin/destination/world position;
- worker profile/shift compatibility and non-worker fields;
- commute day and monotonic daily flags;
- exactly one sim per trip;
- unique `(sim, service day, purpose)`;
- nonfuture service day;
- outbound/return endpoints including dormant home fallback;
- sim/trip world-position agreement;
- finite nonnegative deadlines and patience.

- [ ] **Step 2: Validate route plans and lifecycle states**

For every plan validate nonempty contiguous legs, endpoints, in-bounds points, and exact deterministic estimated seconds. For each leg:

- walk: no line, direction, or board/alight indexes;
- bus/metro: compatible line, direction, valid visit indexes, and matching visit endpoints.

Check indexes before access. Validate the status/plan/current-leg/position/vehicle-membership state machine:

- Riding in exactly one compatible vehicle;
- non-Riding in no vehicle;
- terminal status consistent with outcome;
- retained terminal trips remain allowed for daily uniqueness.

- [ ] **Step 3: Validate sequence counters with checked arithmetic**

Enforce:

```rust
snapshot.trip_sequence_day <= snapshot.day
snapshot.next_trip_sequence >= 1
```

When sequence day equals current day, next sequence is greater than every serialized sequence for that day, and `checked_add(1)` succeeds.

- [ ] **Step 4: Add metrics and rolling-window regressions**

Before objective arithmetic validate every wait/timestamp float, chronology, `timestamp <= snapshot.time`, counter relationships, and:

```rust
let mut expected = snapshot.metrics.trip_outcomes.clone();
objectives::prune_trip_outcomes(
    &mut expected,
    snapshot.time,
    objectives::effective_rolling_window_seconds(snapshot),
);
if expected != snapshot.metrics.trip_outcomes {
    return Err(PersistenceError::InvalidDerivedState {
        field: SnapshotField::MetricsTripOutcomes,
        reason: DerivedStateError::OutcomeWindowMismatch,
    });
}
```

Test:

- tick-produced outcomes spanning multiple substeps;
- multiple retained in-window outcomes;
- one latest older fallback accepted;
- multiple older outcomes rejected;
- future/out-of-order timestamps rejected.

- [ ] **Step 5: Preserve last-tick waiting aggregates**

Validate only:

- `late_trips <= completed_trips`;
- lifetime counts not smaller than retained subsets;
- `waiting_trip_count` not greater than serialized nonterminal trips;
- average wait zero when waiting count is zero;
- remaining finite/nonnegative relationships from the design.

Do not derive waiting count/average from current Waiting states. Add the mandatory regression:

1. create a Waiting trip;
2. delete or invalidate its route so gameplay changes it to Idle;
3. do not tick;
4. pause/save;
5. assert validation succeeds with last-tick aggregates.

- [ ] **Step 6: Use the objective evaluator as the equality oracle**

For Running campaign state, require `evaluate_objectives_opt(snapshot) == None`. For Won/Lost:

```rust
let mut running = snapshot.clone();
running.metrics.state = MetricsState::Running;
running.metrics.loss_reason = None;
let expected = objectives::evaluate_objectives_opt(&running)
    .ok_or_else(objective_state_mismatch)?;
```

Assert every field other than `metrics.state` and `metrics.loss_reason` remains equal, then compare the expected terminal pair. Test all three exact loss reasons, mismatched reason, unsatisfied Won, terminal campaign without objectives, and terminal sandbox.

- [ ] **Step 7: Wire the complete fixed stage order**

`validate_and_compile` must now execute exactly:

1. schema;
2. snapshot scalars/clock;
3. mode/settings/scenario;
4. map/tile values;
5. authored roads;
6. topology compile;
7. global IDs/spatial ownership;
8. transit/routes/vehicles;
9. sims/trips/passengers/plans;
10. metrics/counters/indexes/progress/remaining derived state.

No stage may continue after error.

Wire the real private stages without exposing a partial public validator:

```rust
fn validate_and_compile(
    snapshot: &GameSnapshot,
) -> PersistenceResult<RoadTopology> {
    let topology =
        map::validate_shell_rules_map_and_compile(snapshot)?;
    let indexes =
        entities::validate_entities(snapshot, &topology)?;
    trips::validate_trips(snapshot, &indexes)?;
    Ok(topology)
}
```

- [ ] **Step 8: Verify and commit**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core persistence::trips
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk git add crates/caelum-core/src/persistence crates/caelum-core/src/objectives.rs crates/caelum-core/src/trips.rs
rtk git commit -m "feat(core): validate persistence trips and metrics"
```

Only add `objectives.rs`/`trips.rs` if their visibility changed.

---

### Task 7: Public Validation, Safe Save, Strict Construction, and Atomic Restore

**Files:**

- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Create: `crates/caelum-core/tests/persistence_snapshot.rs`
- Create: `crates/caelum-core/tests/persistence_corruption.rs`
- Create: `crates/caelum-core/tests/persistence_atomicity.rs`
- Modify: `crates/caelum-core/tests/common/mod.rs`
- Modify: every existing core test calling `GameEngine::from_snapshot`

**Produces:**

```rust
pub fn validate_snapshot(
    snapshot: &GameSnapshot,
) -> PersistenceResult<()>;

struct PreparedSnapshot {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
}

pub(crate) fn prepare_snapshot(
    snapshot: GameSnapshot,
) -> PersistenceResult<PreparedSnapshot>;

impl GameEngine {
    pub fn snapshot_for_save(&self) -> PersistenceResult<GameSnapshot>;
    pub fn from_snapshot(snapshot: GameSnapshot) -> PersistenceResult<Self>;
    pub fn restore_snapshot(
        &mut self,
        snapshot: GameSnapshot,
    ) -> PersistenceResult<GameSnapshot>;
}
```

- [ ] **Step 1: Inventory and classify every caller before changing the return type**

```sh
rtk rg -n 'GameEngine::from_snapshot|from_snapshot\\(' crates src-tauri tests
```

Record each result as:

1. WASM or Tauri production load bridge;
2. valid core fixture moving to the shared helper;
3. malformed legacy load becoming a persistence-corruption case.

Expected current families include `golden_sequences.rs`, `stop_migration.rs`, `objectives_metrics.rs`, `route_preview.rs`, WASM, and Tauri. Re-run the search after HPA-339 because it may add callers.

- [ ] **Step 2: Write failing public-API and atomicity tests**

Cover:

```rust
#[test]
fn save_changes_only_paused_on_a_clone() {
    let mut engine = nontrivial_running_engine();
    let before = engine.snapshot();
    let saved = engine.snapshot_for_save().unwrap();

    assert!(saved.paused);
    assert_eq!(engine.snapshot(), before);

    let mut expected = engine.snapshot();
    expected.paused = true;
    assert_eq!(saved, expected);
}
```

Also cover:

- invalid live derived state makes `snapshot_for_save` return an error;
- valid Blank Grid, Crossroads, Standard/Creative sandbox, and campaign snapshots;
- `from_snapshot` preserves exact snapshot and rebuilds equal topology;
- early, topology, and final-stage restore failures preserve both live fields;
- valid restore swaps snapshot/topology together.

- [ ] **Step 3: Implement candidate preparation once**

```rust
pub(crate) fn prepare_snapshot(
    snapshot: GameSnapshot,
) -> PersistenceResult<PreparedSnapshot> {
    let road_topology = validate_and_compile(&snapshot)?;
    Ok(PreparedSnapshot {
        snapshot,
        road_topology,
    })
}
```

`validate_snapshot` calls `validate_and_compile` and discards topology. `from_snapshot` and `restore_snapshot` call `prepare_snapshot` once and retain it.

- [ ] **Step 4: Implement candidate-first engine methods**

```rust
pub fn snapshot_for_save(&self) -> PersistenceResult<GameSnapshot> {
    let mut candidate = self.snapshot.clone();
    candidate.paused = true;
    validate_snapshot(&candidate)?;
    Ok(candidate)
}

pub fn restore_snapshot(
    &mut self,
    snapshot: GameSnapshot,
) -> PersistenceResult<GameSnapshot> {
    let prepared = prepare_snapshot(snapshot)?;
    self.snapshot = prepared.snapshot;
    self.road_topology = prepared.road_topology;
    Ok(self.snapshot())
}
```

No live assignment occurs before preparation succeeds.

- [ ] **Step 5: Add shared strict/running fixture helpers**

In `tests/common/mod.rs`:

```rust
pub fn strict_engine_from_fixture(
    mut snapshot: GameSnapshot,
) -> GameEngine {
    snapshot.paused = true;
    GameEngine::from_snapshot(snapshot)
        .expect("fixture must be persistence-valid")
}

pub fn running_engine_from_fixture(
    snapshot: GameSnapshot,
) -> GameEngine {
    let mut engine = strict_engine_from_fixture(snapshot);
    let result =
        engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(result.applied, "fixture must resume: {result:?}");
    assert!(result.rejection.is_none());
    engine
}
```

- [ ] **Step 6: Migrate existing core fixtures**

Use HPA-339 factories or real engine intents. Fix valid fixtures so strict validation passes. Convert old `stop_migration.rs` cases that expect load-time repair—including extreme/malformed coordinates—into exact corruption rejections. Preserve live gameplay stop-normalization tests.

Do not add an unchecked constructor or mutate fixtures inside `from_snapshot`.

- [ ] **Step 7: Verify public core behavior**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core --test persistence_snapshot
rtk cargo test -p caelum-core --test persistence_atomicity
rtk cargo test -p caelum-core
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
```

Expected: all core tests pass with strict fixture construction.

- [ ] **Step 8: Commit**

```sh
rtk git add crates/caelum-core/src/persistence/mod.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/common/mod.rs crates/caelum-core/tests/persistence_snapshot.rs crates/caelum-core/tests/persistence_corruption.rs crates/caelum-core/tests/persistence_atomicity.rs crates/caelum-core/tests/golden_sequences.rs crates/caelum-core/tests/stop_migration.rs crates/caelum-core/tests/objectives_metrics.rs crates/caelum-core/tests/route_preview.rs
rtk git commit -m "feat(core): add atomic validated snapshot restoration"
```

Add any additional post-HPA-339 caller identified in Step 1 by its explicit
path; do not stage the whole test directory.

---

### Task 8: Existing Host Load Bridges and Retired Gameplay Schema Error

**Files:**

- Modify: `crates/caelum-core/src/rejection.rs`
- Modify: `crates/caelum-wasm/src/lib.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/rejectionMessages.ts`
- Modify: `src/runtime/backend/wasmBackend.ts`
- Modify: `src/runtime/backend/tauriBackend.ts`
- Modify: `tests/runtime/backendContract.test.ts`
- Modify: `tests/runtime/wasmArtifact.smoke.test.ts`
- Modify: `tests/runtime/wasmBackend.test.ts`
- Modify: `tests/runtime/tauriBackend.test.ts`

- [ ] **Step 1: Add failing exact host tests**

For both real bridges cover:

- valid coherent paused snapshot loads;
- unpaused semantic input rejects with:

```json
{
  "code": "invalidModeSettings",
  "context": {
    "field": "paused",
    "reason": { "kind": "persistenceRequiresPaused" }
  }
}
```

- numeric schema mismatch rejects with `{ "code": "unsupportedSchema", "context": { "expected": 4, "actual": 3 } }`;
- missing/wrong-typed/unreadable schema probe rejects with the same object and `actual: 0`;
- a semantic corruption serializes the exact Rust `PersistenceError`;
- raw snapshot deserialization/transport remains a string rejection.

TypeScript adapters must assert object failures with `rejects.toEqual`/`rejects.toMatchObject`, not message matching.

- [ ] **Step 2: Serialize `PersistenceError` at both host boundaries**

WASM:

- retain the pre-deserialization `schemaVersion` probe and `unwrap_or(0)` policy;
- construct `PersistenceError::UnsupportedSchema`;
- use `serde_wasm_bindgen` for schema and semantic persistence errors;
- leave raw deserialization mapped through `to_js_error`;
- build the replacement engine before assigning it.

Tauri:

- retain the schema probe and `actual: 0` policy;
- return the serialized `PersistenceError` object for schema/semantic failures;
- construct `GameEngine::from_snapshot(snapshot)` before taking `Mutex<EngineState>`;
- hold the lock only for the prepared-engine swap and response clone;
- keep raw JSON/transport failure as a JSON string command error.

- [ ] **Step 3: Preserve adapter rejection reasons unchanged**

`wasmBackend.ts` and `tauriBackend.ts` continue returning a snapshot on success. Do not introduce the HPA-341 result union. Let object/string rejection reasons propagate unchanged.

Update mocks so no successful semantic-load fixture is unpaused.

- [ ] **Step 4: Retire the dead gameplay schema rejection**

Remove:

- `RejectionCode::UnsupportedSnapshotSchema`;
- `GameplayRejection::unsupported_snapshot_schema`;
- expected/actual schema fields from gameplay rejection context;
- the matching TypeScript union member/context fields;
- the gameplay rejection message branch and old gameplay wire tests.

Search for remnants:

```sh
rtk rg -n 'UnsupportedSnapshotSchema|unsupportedSnapshotSchema|unsupported_snapshot_schema|expected_schema_version|actual_schema_version' crates src tests
```

Expected: no matches.

- [ ] **Step 5: Verify focused host compatibility**

```sh
rtk cargo test -p caelum-wasm
rtk cargo test -p caelum
rtk bun run test:unit -- tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/backendContract.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
rtk cargo test --workspace
```

- [ ] **Step 6: Commit**

```sh
rtk git add crates/caelum-core/src/rejection.rs crates/caelum-wasm/src/lib.rs src-tauri/src/lib.rs src/domain/types.ts src/runtime/rejectionMessages.ts src/runtime/backend/wasmBackend.ts src/runtime/backend/tauriBackend.ts tests/runtime/backendContract.test.ts tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
rtk git commit -m "feat(hosts): bridge strict persistence load errors"
```

---

### Task 9: Complete Corruption Matrix, Deterministic Continuation, and Performance Evidence

**Files:**

- Complete: `crates/caelum-core/tests/persistence_corruption.rs`
- Complete: `crates/caelum-core/tests/persistence_snapshot.rs`
- Complete: `crates/caelum-core/tests/persistence_atomicity.rs`
- Create: `crates/caelum-core/tests/persistence_determinism.rs`
- Modify only if a discovered defect requires it: persistence implementation files

- [ ] **Step 1: Audit corruption coverage against every wire leaf**

Build a review table mapping each `PersistenceError` and nested reason leaf to:

- one valid canonical baseline;
- one single-field corruption;
- the exact expected error;
- its stage number.

The test suite must include all cases listed in design Section 12.2, including topology, tombstone lifetime, stored stop-access variants, route fixed points, passenger/vehicle reciprocity, trip lifecycle, counter overflow, all metric states/reasons, rolling-window fallback, and multiple-corruption first-error cases.

- [ ] **Step 2: Build the nontrivial deterministic fixture through production APIs**

Using fixed intents and factories, create:

- ordinary roads;
- an automatic junction;
- a roundabout;
- zoning/buildings;
- present and missing transit nodes;
- a bus route and metro line;
- vehicles;
- sims and active trips;
- nonempty metrics.

Do not handpatch derived state except in named corruption tests.

- [ ] **Step 3: Prove save/restore future equivalence**

Pause/save the source engine, construct the restored engine, then apply the same fixed resume/tick/intent sequence to both. After every operation compare:

```rust
assert_eq!(original_result, restored_result);
assert_eq!(original.snapshot(), restored.snapshot());
assert_eq!(
    original.road_topology_for_test(),
    restored.road_topology_for_test()
);
```

Compare topology after every road-affecting operation. Use no random, wall-clock, or host metadata.

- [ ] **Step 4: Record non-CI performance evidence**

Expand the fixture to 100 routes/lines, 100 vehicles, 1,000 sims, and 1,000 active trips. In a release-only ignored test or example, run repeated validation after warmup and report median duration:

```sh
rtk cargo test -p caelum-core --release persistence_validation_benchmark -- --ignored --nocapture
```

Target: at most 100 ms median on the project Apple Silicon development baseline. Record hardware, sample count, native median, and WASM timing in the implementation handoff. Do not add a wall-clock CI assertion.

If validation approaches the interaction budget, profile repeated scans/recompilation and ordered-index construction. Do not weaken validation; HPA-341 owns asynchronous host invocation if needed.

- [ ] **Step 5: Re-run the complete caller inventory**

```sh
rtk rg -n 'GameEngine::from_snapshot|from_snapshot\\(' crates src-tauri tests
```

Expected production callers: only WASM and Tauri load bridges. Direct core callers are persistence construction/corruption tests; unrelated tests use `strict_engine_from_fixture` or `running_engine_from_fixture`.

- [ ] **Step 6: Run full verification**

```sh
rtk cargo fmt --all --check
rtk cargo test -p caelum-core
rtk cargo clippy -p caelum-core --all-targets -- -D warnings
rtk cargo test --workspace
rtk bun run test:unit -- tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/backendContract.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
rtk bun run check
rtk bun run format:check
```

Also run unchanged HPA-339-required gates if its landed implementation adds them. Any failure in an existing host bridge is in scope because HPA-340 changes its load error contract.

- [ ] **Step 7: Review for forbidden scope and hidden normalization**

```sh
rtk rg -n 'HashMap|HashSet|normalize|repair|migrate|unchecked|TO[D]O|T[B]D' crates/caelum-core/src/persistence crates/caelum-core/tests/persistence_*.rs
rtk git diff --check
rtk git status --short
```

Inspect every match. Allowed mentions in test names/comments must describe rejection, not implementation behavior. Confirm there is no new host command, storage module, UI, compatibility shim, unchecked engine constructor, or mutation during validation.

- [ ] **Step 8: Commit final acceptance coverage**

```sh
rtk git add crates/caelum-core/tests/persistence_corruption.rs crates/caelum-core/tests/persistence_snapshot.rs crates/caelum-core/tests/persistence_atomicity.rs crates/caelum-core/tests/persistence_determinism.rs
rtk git commit -m "test(core): prove persistence atomicity and determinism"
```

If verification required a source fix, include only the directly related persistence files and explain the defect in the commit body.

---

## Acceptance Checklist

- [ ] HPA-339 source gate passes; no HPA-340 schema-v4 shim exists.
- [ ] `snapshot_for_save` returns a validated clone differing only by `paused`.
- [ ] Pure validation and strict construction accept canonical schema-v4 sandbox/campaign snapshots.
- [ ] Valid restoration preserves the supplied snapshot exactly and rebuilds equal topology.
- [ ] Failed restoration leaves both live snapshot and topology unchanged at early, topology, and final stages.
- [ ] Every top-level and nested persistence error has exact camelCase wire coverage and rejects unknown values/keys.
- [ ] Deterministic first-error order is tested with multiple simultaneous corruptions.
- [ ] Topology compile errors are focused and exhaustively converted at gameplay and persistence boundaries.
- [ ] Route derivation is pure, idempotent, and preserves broken-route historical paths.
- [ ] Stored valid stop access is compared with the resolver, not only the first derived candidate.
- [ ] Waiting aggregates survive accepted route invalidation without an intervening tick.
- [ ] Rolling outcomes are a pruning fixed point at serialized time, including the one-older fallback.
- [ ] Objective terminal state/reason equals the existing evaluator and no other cloned field changes.
- [ ] WASM and Tauri load bridges expose equal persistence objects for schema/semantic failures and retain string transport failures.
- [ ] The obsolete gameplay schema rejection is fully removed.
- [ ] Save/restore continuation produces identical results, complete snapshots, and topology.
- [ ] Native and WASM performance measurements are recorded without flaky timing assertions.
- [ ] All focused, workspace, clippy, format, and runtime bridge gates pass from fresh output.
