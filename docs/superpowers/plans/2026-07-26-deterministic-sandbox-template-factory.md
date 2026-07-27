# HPA-339 Deterministic Sandbox Template Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rust-owned deterministic sandbox factory for Blank Grid and Crossroads, expose equivalent WASM and Tauri creation/reset contracts, and preserve the active sandbox request across reset.

**Architecture:** `crates/caelum-core/src/sandbox.rs` owns raw request validation, canonical settings, template map construction, topology invariants, and complete snapshot assembly. `GameEngine` consumes a factory candidate containing both the snapshot and compiled `RoadTopology`, while WASM and Tauri serialize the same core domain errors and TypeScript adapters normalize only recognized error objects. The frontend runtime remains snapshot-driven and adds one nonfatal reset-error channel; HPA-345 remains responsible for New City UI.

**Tech Stack:** Rust 2021, Serde/serde_json, serde-wasm-bindgen, wasm-bindgen, Tauri 2, TypeScript 5.8, Svelte 5 runes, Bun, Vitest, Playwright.

## Global Constraints

- Set `SNAPSHOT_SCHEMA_VERSION = 4` in Rust and TypeScript; schema-v3 snapshots are rejected, not migrated.
- The stable wire template IDs are exactly `"blankGrid"` and `"crossroads"`; remove `"growingSuburb"` without an alias.
- Both templates are exactly 28×18 and use canonical row-major `tile_id(x, y)` values.
- The default request is Crossroads + Standard + starting capital `120000` + demand multiplier `1.0` + move-in rate `"paused"`.
- `startingCapital` is persisted in `rules.sandbox`; mutable `budget` starts at that value and reset restores it.
- Raw numeric request fields stay `Option<f64>` until validation so missing/Tauri-null values receive typed domain errors.
- Starting capital accepts integral values in `0..=i32::MAX`; demand multiplier accepts only finite values greater than zero.
- Creation error codes are exactly `unknownTemplateId`, `unknownEconomyPreset`, `invalidStartingCapital`, `invalidDemandMultiplier`, `unknownMoveInRate`, and `templateInvariantViolation`.
- Reset error codes are exactly `unsupportedGameMode` and `templateInvariantViolation`.
- Blank Grid has no authored roads, structures, areas, track, buildings, residents, trips, transit nodes, routes, lines, or vehicles.
- Crossroads authors westbound row 8, eastbound row 9, southbound column 14, and northbound column 15.
- Crossroads uses shared automatic-junction refresh and requires the center footprint `(14,8) (15,8) (14,9) (15,9)`, eight ports, `one_way: None` on all four center tiles, and all 12 straight/right/left transitions.
- The four existing same-side U-turn transitions are allowed; HPA-339 validates the 12 required movements as a subset.
- Every sandbox snapshot has `objectives: None`, `growth_waves: []`, no starting citizens, deterministic counters, and no random or wall-clock inputs.
- `GameEngine::new()`, `Default`, and `create_initial_snapshot()` remain infallible compatibility paths for the canonical default request.
- Requested creation and sandbox reset build snapshot and topology off to the side and swap only after complete success.
- Campaign reset returns typed `unsupportedGameMode` and leaves the complete engine snapshot/topology unchanged.
- Tauri domain errors serialize as plain objects; mutex/framework failures remain unexpected host rejections.
- TypeScript guards validate the known code set plus every recognized context field before converting a rejection to `{ ok: false, error }`.
- Typed reset failure is nonfatal in the runtime; unexpected backend rejection remains fatal.
- HPA-339 adds no `RuntimeController.createSandbox` method and no player-facing New City workflow.
- Preserve Rust gameplay authority, immutable snapshots, reference-equality dispatch, deterministic ordering, and Svelte 5 runes.

---

## File Map

- Create `crates/caelum-core/src/sandbox.rs`: raw and validated creation requests, starting-capital type, creation/reset errors, canonical defaults, template builders, characterization, and topology invariants.
- Create `crates/caelum-core/tests/sandbox_factory.rs`: public factory determinism, Blank Grid, Crossroads geometry/topology, settings, and default parity.
- Create `crates/caelum-core/tests/sandbox_engine.rs`: requested engine construction, exact reset, campaign rejection, and atomicity.
- Create `crates/caelum-core/tests/fixtures/sandbox_templates.json`: compact checked-in Blank Grid/Crossroads characterization.
- Modify `crates/caelum-core/src/model.rs`: schema version, template enum, starting capital in persisted sandbox settings.
- Modify `crates/caelum-core/src/scenario.rs`: retain campaign objectives/growth only and import canonical sandbox dimensions/settings.
- Modify `crates/caelum-core/src/state.rs`: make the initial snapshot wrapper delegate to the canonical factory.
- Modify `crates/caelum-core/src/engine.rs`: requested constructor, candidate ownership, mode-aware fallible reset, and current schema comments.
- Modify `crates/caelum-core/src/lib.rs`: export the public sandbox contract.
- Modify Rust tests using reset or schema-v3 wire values, especially `model_wire_format.rs`, `stop_migration.rs`, and `engine_topology.rs`.
- Modify `crates/caelum-wasm/src/lib.rs`: requested constructor and typed reset serialization.
- Create `src/runtime/backend/sandboxErrors.ts`: serialized-domain-error guards.
- Modify `src/domain/types.ts`, `src/runtime/backend/types.ts`, and `src/runtime/backend/index.ts`: schema-v4 and sandbox request/result/error types.
- Modify `src/runtime/backend/wasmBackend.ts` and `src/runtime/backend/tauriBackend.ts`: creation/reset result normalization and atomic engine replacement.
- Modify `tests/runtime/wasmBackend.test.ts`, `tests/runtime/wasmArtifact.smoke.test.ts`, and `tests/runtime/tauriBackend.test.ts`: adapter and real-artifact contracts.
- Modify `src-tauri/src/lib.rs`: Tauri error transport, create command, fallible reset, handler registration, and real IPC tests.
- Modify `src/runtime/types.ts` and `src/runtime/createGameRuntime.ts`: nonfatal `sandboxResetError`.
- Modify `tests/runtime/gameRuntime.test.ts`, `tests/ui/pointerEvents.test.ts`, and backend doubles: reset-result contract and fatal/nonfatal behavior.
- Rename `src/scenario/growingSuburb.ts` to `src/scenario/sandbox.ts` and update every import.
- Modify `src/runtime/runtimeSelectors.ts`, UI/runtime tests, fixtures, E2E expectations, `CLAUDE.md`, and `docs/architecture.md`: Crossroads/Blank Grid/schema-v4 terminology.

---

### Task 1: Core Schema-v4 Request and Validation Contract

**Files:**
- Create: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/src/model.rs:1-83`
- Modify: `crates/caelum-core/src/scenario.rs:1-78`
- Modify: `crates/caelum-core/src/state.rs:1-50`
- Modify: `crates/caelum-core/src/lib.rs:23-64`
- Test: `crates/caelum-core/src/sandbox.rs` module tests
- Test: `crates/caelum-core/tests/model_wire_format.rs:230-390`

**Interfaces:**
- Consumes: existing `DemandMultiplier`, `EconomyPreset`, `GameMode`, `MoveInRateSelection`, `SandboxSettings`, and `GameSnapshot`.
- Produces:

```rust
pub const MAP_WIDTH: u8 = 28;
pub const MAP_HEIGHT: u8 = 18;
pub const DEFAULT_STARTING_CAPITAL: i32 = 120_000;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationRequest {
    pub template_id: String,
    pub economy_preset: String,
    pub starting_capital: Option<f64>,
    pub demand_multiplier: Option<f64>,
    pub move_in_rate: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "i32", into = "i32")]
pub struct StartingCapital(i32);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxCreationErrorCode {
    UnknownTemplateId,
    UnknownEconomyPreset,
    InvalidStartingCapital,
    InvalidDemandMultiplier,
    UnknownMoveInRate,
    TemplateInvariantViolation,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationErrorContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreationError {
    pub code: SandboxCreationErrorCode,
    pub context: SandboxCreationErrorContext,
}
```

- [ ] **Step 1: Write failing request-validation tests**

Add private module tests to the new `sandbox.rs`. Use a literal request helper and assert exact codes/context:

```rust
fn raw_request() -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: "crossroads".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(120_000.0),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    }
}

#[test]
fn validation_classifies_unknown_strings() {
    let cases = [
        ("templateId", "unknown", SandboxCreationErrorCode::UnknownTemplateId),
        (
            "economyPreset",
            "unknown",
            SandboxCreationErrorCode::UnknownEconomyPreset,
        ),
        (
            "moveInRate",
            "unknown",
            SandboxCreationErrorCode::UnknownMoveInRate,
        ),
    ];

    for (field, attempted, code) in cases {
        let mut request = raw_request();
        match field {
            "templateId" => request.template_id = attempted.to_string(),
            "economyPreset" => request.economy_preset = attempted.to_string(),
            "moveInRate" => request.move_in_rate = attempted.to_string(),
            _ => unreachable!(),
        }
        let error = validate_request(request).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.context.field.as_deref(), Some(field));
        assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
    }
}

#[test]
fn validation_rejects_every_invalid_numeric_class() {
    for (value, attempted) in [
        (None, "null"),
        (Some(-1.0), "-1"),
        (Some(1.5), "1.5"),
        (Some(f64::NAN), "NaN"),
        (Some(f64::INFINITY), "Infinity"),
        (Some(f64::NEG_INFINITY), "-Infinity"),
        (Some(f64::from(i32::MAX) + 1.0), "2147483648"),
    ] {
        let mut request = raw_request();
        request.starting_capital = value;
        let error = validate_request(request).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::InvalidStartingCapital
        );
        assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
    }

    for (value, attempted) in [
        (None, "null"),
        (Some(0.0), "0"),
        (Some(-1.0), "-1"),
        (Some(f64::NAN), "NaN"),
        (Some(f64::INFINITY), "Infinity"),
        (Some(f64::NEG_INFINITY), "-Infinity"),
    ] {
        let mut request = raw_request();
        request.demand_multiplier = value;
        let error = validate_request(request).unwrap_err();
        assert_eq!(
            error.code,
            SandboxCreationErrorCode::InvalidDemandMultiplier
        );
        assert_eq!(error.context.attempted_value.as_deref(), Some(attempted));
    }
}
```

The production change these tests catch is accepting an unknown enum spelling, fractional/out-of-range budget, or non-positive/non-finite demand before template construction.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
cargo test -p caelum-core sandbox::tests::validation_ -- --nocapture
```

Expected: compilation fails because `sandbox`, the raw request, errors, and validator do not exist.

- [ ] **Step 3: Add schema-v4 model types and strict validation**

In `model.rs`, set the schema constant to `4`, replace `GrowingSuburb` with:

```rust
pub enum SandboxTemplateId {
    BlankGrid,
    Crossroads,
}
```

Add `starting_capital: StartingCapital` to `SandboxSettings`. Implement `StartingCapital::new`, `value`, `TryFrom<i32>`, and `From<StartingCapital> for i32`; reject negative deserialization through `#[serde(try_from = "i32")]`.

In `sandbox.rs`, implement `ValidatedSandboxCreationRequest`, canonical numeric formatting, and validation in this order:

1. template ID;
2. economy preset;
3. starting capital;
4. demand multiplier;
5. move-in rate.

Use exact string matching and never deserialize raw strings directly into enums:

```rust
fn parse_template(value: &str) -> Result<SandboxTemplateId, SandboxCreationError> {
    match value {
        "blankGrid" => Ok(SandboxTemplateId::BlankGrid),
        "crossroads" => Ok(SandboxTemplateId::Crossroads),
        _ => Err(creation_error(
            SandboxCreationErrorCode::UnknownTemplateId,
            "templateId",
            value,
        )),
    }
}
```

Canonicalize numeric diagnostics with explicit non-finite branches before finite formatting. Do not pass `NaN` or infinity through `serde_json`.

- [ ] **Step 4: Keep the current default compiling against the new persisted model**

Add:

```rust
pub fn canonical_default_request() -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: "crossroads".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    }
}

pub fn canonical_default_settings() -> SandboxSettings {
    SandboxSettings {
        template_id: SandboxTemplateId::Crossroads,
        starting_capital: StartingCapital::new(DEFAULT_STARTING_CAPITAL)
            .expect("default starting capital is valid"),
        demand_multiplier: DemandMultiplier::default(),
        move_in_rate: MoveInRateSelection::Paused,
    }
}
```

Update `scenario.rs` campaign rules and the temporary `state.rs` default to use these settings and budget. Export the new public types from `lib.rs`.

- [ ] **Step 5: Update and run schema-v4 wire tests**

Change literal wire assertions in `model_wire_format.rs` to:

```rust
assert_eq!(value["schemaVersion"], json!(4));
assert_eq!(
    value["rules"]["sandbox"],
    json!({
        "templateId": "crossroads",
        "startingCapital": 120000,
        "demandMultiplier": 1.0,
        "moveInRate": "paused"
    })
);
```

Add deserialization cases proving negative `startingCapital`, `"growingSuburb"`, and a missing `startingCapital` key fail.

Run:

```bash
cargo test -p caelum-core sandbox::tests:: -- --nocapture
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --lib
```

Expected: all selected tests pass with no warnings.

- [ ] **Step 6: Commit the core request contract**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/sandbox.rs crates/caelum-core/src/scenario.rs crates/caelum-core/src/state.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat(core): add sandbox creation contract"
```

---

### Task 2: Deterministic Blank Grid and Crossroads Factory

**Files:**
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/src/scenario.rs:14-250`
- Modify: `crates/caelum-core/src/state.rs:1-50`
- Create: `crates/caelum-core/tests/sandbox_factory.rs`
- Create: `crates/caelum-core/tests/fixtures/sandbox_templates.json`

**Interfaces:**
- Consumes: `SandboxCreationRequest`, validated settings from Task 1, `author_scenario_road_line`, `refresh_all_automatic_junctions`, `RoadTopology::compile`, and `RoadTopology::transition_for`.
- Produces:

```rust
pub fn create_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError>;

pub(crate) struct SandboxCandidate {
    pub snapshot: GameSnapshot,
    pub road_topology: RoadTopology,
}

pub(crate) fn create_sandbox_candidate(
    request: SandboxCreationRequest,
) -> Result<SandboxCandidate, SandboxCreationError>;
```

- [ ] **Step 1: Write failing public factory and Blank Grid tests**

Create `sandbox_factory.rs` with:

```rust
fn request(template_id: &str) -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: template_id.to_string(),
        economy_preset: "creative".to_string(),
        starting_capital: Some(0.0),
        demand_multiplier: Some(1.5),
        move_in_rate: "paused".to_string(),
    }
}

#[test]
fn identical_requests_produce_equal_complete_snapshots() {
    for template in ["blankGrid", "crossroads"] {
        let first = create_sandbox_snapshot(request(template)).unwrap();
        let second = create_sandbox_snapshot(request(template)).unwrap();
        assert_eq!(first, second);
    }
}

#[test]
fn blank_grid_contains_only_canonical_empty_tiles() {
    let snapshot = create_sandbox_snapshot(request("blankGrid")).unwrap();
    assert_eq!((snapshot.map.width, snapshot.map.height), (28, 18));
    assert_eq!(snapshot.map.tiles.len(), 28 * 18);
    assert!(snapshot.map.road_structures.is_empty());
    assert!(snapshot.map.tiles.iter().all(|tile| {
        tile.kind == "empty"
            && tile.area.is_none()
            && !tile.has_track
            && tile.one_way.is_none()
            && tile.road_connections.is_empty()
            && tile.road_structure_id.is_none()
    }));
    assert!(snapshot.buildings.is_empty());
    assert!(snapshot.sims.is_empty());
    assert!(snapshot.active_trips.is_empty());
    assert!(snapshot.transit.stops.is_empty());
    assert!(snapshot.transit.stations.is_empty());
    assert!(snapshot.transit.routes.is_empty());
    assert!(snapshot.transit.metro_lines.is_empty());
    assert!(snapshot.transit.vehicles.is_empty());
    assert_eq!(snapshot.scenario.name, "Blank Grid");
    assert!(snapshot.scenario.objectives.is_none());
    assert!(snapshot.scenario.growth_waves.is_empty());
}
```

Also assert tile IDs at `(0,0)`, `(27,0)`, `(0,17)`, `(27,17)` and the complete row-major sequence.

Add a table-driven settings test covering both templates with:

- Standard and Creative economy;
- starting capital `0`, `120_000`, and `i32::MAX`;
- demand multiplier `1.0` and a non-default positive value; and
- paused move-in.

For every case, assert complete repeated-request equality. Compare each result's map with the same template's canonical map and assert that changing valid settings changes only the expected rules/budget fields, never authored geometry or entity collections.

- [ ] **Step 2: Run the factory tests and verify red**

Run:

```bash
cargo test -p caelum-core --test sandbox_factory -- --nocapture
```

Expected: compilation fails because the public factory and candidate do not exist.

- [ ] **Step 3: Implement the shared snapshot shell and blank map**

Move `MAP_WIDTH`/`MAP_HEIGHT` and arterial map helpers from `scenario.rs` into `sandbox.rs`. Build tiles through one row-major `blank_map()` function. Assemble every non-map `GameSnapshot` field in one `snapshot_shell(validated, name, map)` function so templates cannot drift in counters, metrics, transit defaults, objectives, or growth waves.

Use the validated values directly:

```rust
rules: GameRules {
    game_mode: GameMode::Sandbox,
    economy_preset: validated.economy_preset,
    sandbox: SandboxSettings {
        template_id: validated.template_id,
        starting_capital: validated.starting_capital,
        demand_multiplier: validated.demand_multiplier,
        move_in_rate: validated.move_in_rate,
    },
},
budget: validated.starting_capital.value(),
```

- [ ] **Step 4: Write the failing Crossroads movement-matrix test**

Add exact entry-state expectations:

```rust
let required = [
    (
        RoadState {
            position: Point { x: 14, y: 8 },
            incoming_heading: Heading::South,
        },
        [
            (Heading::South, MovementKind::Straight),
            (Heading::West, MovementKind::RightTurn),
            (Heading::East, MovementKind::LeftTurn),
        ],
    ),
    (
        RoadState {
            position: Point { x: 15, y: 8 },
            incoming_heading: Heading::West,
        },
        [
            (Heading::West, MovementKind::Straight),
            (Heading::North, MovementKind::RightTurn),
            (Heading::South, MovementKind::LeftTurn),
        ],
    ),
    (
        RoadState {
            position: Point { x: 15, y: 9 },
            incoming_heading: Heading::North,
        },
        [
            (Heading::North, MovementKind::Straight),
            (Heading::East, MovementKind::RightTurn),
            (Heading::West, MovementKind::LeftTurn),
        ],
    ),
    (
        RoadState {
            position: Point { x: 14, y: 9 },
            incoming_heading: Heading::East,
        },
        [
            (Heading::East, MovementKind::Straight),
            (Heading::South, MovementKind::RightTurn),
            (Heading::North, MovementKind::LeftTurn),
        ],
    ),
];

for (entry, movements) in required {
    for (outgoing, expected_kind) in movements {
        let transition = topology
            .transition_for(entry, outgoing)
            .expect("required Crossroads movement");
        assert_eq!(transition.movement, expected_kind);
    }
}
```

Assert the four center points, eight exact port keys, all four center tiles with four reciprocal connections and `one_way == None`, and the stable structure ID:

```text
junction-14,8;14,9;15,8;15,9-14,8:north;14,8:west;14,9:south;14,9:west;15,8:north;15,8:east;15,9:east;15,9:south
```

Do not assert U-turn absence. Add a separate characterization assertion that the current compiler exposes four U-turns without making them a factory invariant.

- [ ] **Step 5: Implement Crossroads through shared road authoring and required validation**

Author the four full lines using the existing road helper:

```rust
author_scenario_road_line(
    &mut map,
    &(0..i32::from(MAP_WIDTH))
        .rev()
        .map(|x| Point { x, y: 8 })
        .collect::<Vec<_>>(),
    RoadPreset::OneWay,
);
```

Repeat for eastbound row 9, southbound column 14, and northbound column 15. Call `refresh_all_automatic_junctions(&mut map)` and map any failure to `templateInvariantViolation`. Compile `RoadTopology` once, validate structure/ports/center tiles plus the 12 transitions above, then return `SandboxCandidate`.

Keep invariant validation private and pure:

```rust
fn validate_crossroads_candidate(
    map: &GameMap,
    topology: &RoadTopology,
) -> Result<(), SandboxCreationError>
```

Add a module-private test that removes one required center connection from a cloned candidate, recompiles, and proves the validator returns `templateInvariantViolation` with `templateId: "crossroads"`.

- [ ] **Step 6: Add and inspect the compact characterization fixture**

Serialize a review representation containing:

- dimensions and ordered tile IDs;
- all non-default tile records;
- complete structures, footprints, ordered ports, and IDs;
- rules, budget, scenario, counters, and entity ID collections.

Store it at `tests/fixtures/sandbox_templates.json`, compare byte-for-byte in the test, and inspect the initial generated diff before accepting it. The fixture must contain no timestamps, hash-map iteration output, or environment paths.

- [ ] **Step 7: Delegate default snapshot construction to the factory**

Replace manual assembly in `state.rs` with:

```rust
pub fn create_initial_snapshot() -> GameSnapshot {
    create_sandbox_snapshot(canonical_default_request())
        .expect("canonical default sandbox request and template must remain valid")
}
```

Import dimensions into campaign seed-wave logic from `sandbox`; remove sandbox map authoring and the stale non-routable comment from `scenario.rs`.

- [ ] **Step 8: Run the complete core factory gate**

Run:

```bash
cargo test -p caelum-core --test sandbox_factory
cargo test -p caelum-core sandbox::tests::
cargo test -p caelum-core --test scenario_clock
cargo test -p caelum-core --test model_wire_format
```

Expected: all selected tests pass and the checked-in characterization is unchanged on a second run.

- [ ] **Step 9: Commit deterministic templates**

```bash
git add crates/caelum-core/src/sandbox.rs crates/caelum-core/src/scenario.rs crates/caelum-core/src/state.rs crates/caelum-core/tests/sandbox_factory.rs crates/caelum-core/tests/fixtures/sandbox_templates.json
git commit -m "feat(core): build deterministic sandbox templates"
```

---

### Task 3: Requested Engine Construction and Exact Reset

**Files:**
- Modify: `crates/caelum-core/src/engine.rs:21-307`
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/src/lib.rs:53-64`
- Modify: `crates/caelum-core/tests/engine_topology.rs:1-125`
- Create: `crates/caelum-core/tests/sandbox_engine.rs`
- Modify: `crates/caelum-core/tests/stop_migration.rs:170-285`
- Modify: `crates/caelum-wasm/src/lib.rs:1-89`
- Modify: `src-tauri/src/lib.rs:33-39`

**Interfaces:**
- Consumes: `SandboxCandidate`, canonical default request, persisted `GameRules`, and `GameMode`.
- Produces:

```rust
impl GameEngine {
    pub fn from_sandbox_request(
        request: SandboxCreationRequest,
    ) -> Result<Self, SandboxCreationError>;

    pub fn reset(&mut self) -> Result<GameSnapshot, SandboxResetError>;
}
```

Both hosts are updated in this task so the workspace compiles end-to-end. The WASM wrapper serializes the typed reset error as an object (thrown as `JsValue`); the Tauri command maps `SandboxResetError` to a string for now — Task 5 upgrades the Tauri command to `TauriCommandError<SandboxResetError>` and Task 4 upgrades the TS-side `wasmBackend` to return the discriminated union.

- [ ] **Step 1: Write failing requested-constructor and reset tests**

Create `sandbox_engine.rs`:

```rust
#[test]
fn requested_engine_matches_public_factory() {
    let request = request("blankGrid", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let engine = GameEngine::from_sandbox_request(request).unwrap();
    assert_eq!(engine.snapshot(), expected);
}

#[test]
fn reset_replays_the_complete_original_sandbox_request() {
    let request = request("blankGrid", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    engine.set_budget_for_test(7);
    let _ = engine.dispatch(GameIntent::LayRoad {
        point: Point { x: 3, y: 3 },
    });

    let reset = engine.reset().unwrap();
    assert_eq!(reset, expected);
    assert_eq!(engine.snapshot(), expected);
}
```

Add the same exact-request reset for Crossroads and assert default `GameEngine::new()`, `GameEngine::default()`, and `create_initial_snapshot()` equal the canonical factory snapshot.

- [ ] **Step 2: Run the engine tests and verify red**

Run:

```bash
cargo test -p caelum-core --test sandbox_engine -- --nocapture
```

Expected: compilation fails because requested construction and fallible reset are absent.

- [ ] **Step 3: Install factory candidates atomically**

Make `GameEngine::from_sandbox_request` destructure the already-compiled `SandboxCandidate`. Change `new()` to use the canonical infallible candidate and remove the empty-topology fallback/stale comment. Do not compile the map again after the candidate is built.

For reset, reconstruct the typed request from persisted rules, build a candidate before mutating either engine field, and assign both only after success:

```rust
let candidate = sandbox_candidate_from_persisted_rules(&self.snapshot.rules)
    .map_err(SandboxResetError::from)?;
self.snapshot = candidate.snapshot;
self.road_topology = candidate.road_topology;
Ok(self.snapshot())
```

Map only a factory invariant failure into `SandboxResetErrorCode::TemplateInvariantViolation`.

- [ ] **Step 4: Write and pass the campaign atomicity test**

Construct a campaign engine through `GameEngine::from_snapshot`, capture snapshot and topology, call reset, and assert:

```rust
assert_eq!(error.code, SandboxResetErrorCode::UnsupportedGameMode);
assert_eq!(error.context.game_mode, Some(GameMode::Campaign));
assert_eq!(engine.snapshot(), before_snapshot);
assert_eq!(engine.road_topology_for_test(), &before_topology);
```

Update `engine_topology.rs` callers to unwrap successful sandbox reset and retain topology assertions.

- [ ] **Step 5: Prove schema-v3 loads remain rejected**

Update schema comments/expected versions in `engine.rs` and `stop_migration.rs`. Build a schema-v3-shaped JSON object, omit schema-v4 `startingCapital`, and assert the schema probe returns `unsupportedSnapshotSchema` with expected `4` and actual `3`.

- [ ] **Step 6: Update both hosts so the workspace compiles**

In `crates/caelum-wasm/src/lib.rs`, change `reset` to handle the new `Result` without serializing the nested Rust `Result` representation:

```rust
pub fn reset(&mut self) -> Result<JsValue, JsValue> {
    self.inner
        .reset()
        .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))
        .and_then(|snapshot| serde_wasm_bindgen::to_value(&snapshot).map_err(to_js_error))
}
```

The error is thrown as a serialized `SandboxResetError` object; the TS-side `wasmBackend` still rejects on throw (handled by `failBackend`) until Task 4 introduces the discriminated-union contract and guard-based catch.

In `src-tauri/src/lib.rs`, map `SandboxResetError` to a string for now (Task 5 replaces this with `TauriCommandError<SandboxResetError>`):

```rust
fn game_reset(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    let mut engine = state.lock().map_err(|error| error.to_string())?;
    engine.reset().map_err(|error| error.to_string())
}
```

- [ ] **Step 7: Run the core lifecycle gate and workspace check**

Run:

```bash
cargo test -p caelum-core --test sandbox_engine
cargo test -p caelum-core --test engine_topology
cargo test -p caelum-core --test stop_migration
cargo test -p caelum-core
cargo check --workspace
```

Expected: all core unit/integration tests pass and the entire workspace (including `caelum-wasm` and `src-tauri`) compiles.

- [ ] **Step 8: Commit engine lifecycle and host adapters**

```bash
git add crates/caelum-core/src/engine.rs crates/caelum-core/src/sandbox.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/sandbox_engine.rs crates/caelum-core/tests/engine_topology.rs crates/caelum-core/tests/stop_migration.rs crates/caelum-wasm/src/lib.rs src-tauri/src/lib.rs
git commit -m "feat(core): reset active sandbox exactly"
```

---

### Task 4: TypeScript Contract and Real WASM Boundary

**Files:**
- Modify: `src/domain/types.ts:1-16`
- Modify: `src/runtime/backend/types.ts:1-245`
- Modify: `src/runtime/backend/index.ts:1-24`
- Create: `src/runtime/backend/sandboxErrors.ts`
- Modify: `crates/caelum-wasm/src/lib.rs:1-89`
- Modify: `src/runtime/backend/wasmBackend.ts:1-87`
- Modify: `src/runtime/backend/tauriBackend.ts:1-63`
- Modify: `src/runtime/createGameRuntime.ts:1018-1030`
- Modify: `src/runtime/runtimeSelectors.ts:44-46`
- Modify: `tests/fixtures/rustSnapshot.ts:1-95`
- Modify: `tests/runtime/wasmBackend.test.ts`
- Modify: `tests/runtime/tauriBackend.test.ts`
- Modify: `tests/runtime/wasmArtifact.smoke.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts` (reset test backends to return `{ ok: true, snapshot }`)
- Modify: `tests/runtime/backendContract.test.ts` (reset doubles return discriminated result)
- Modify: `tests/ui/pointerEvents.test.ts` (reset doubles return discriminated result)

**Interfaces:**
- Consumes: core request/error/reset types and `WasmGameEngine`.
- Produces:

```typescript
export interface SandboxCreationRequest {
  templateId: string;
  economyPreset: string;
  startingCapital: number;
  demandMultiplier: number;
  moveInRate: string;
}

export type SandboxCreationResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxCreationError };

export type SandboxResetResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SandboxResetError };

export interface GameBackend {
  createSandbox(request: SandboxCreationRequest): Promise<SandboxCreationResult>;
  reset(): Promise<SandboxResetResult>;
}
```

- [ ] **Step 1: Write failing guard and mocked-WASM tests**

Test `isSandboxCreationError` and `isSandboxResetError` with:

- every exact known code and valid context;
- unknown code;
- array/null context;
- `attemptedValue: 42`;
- reset `gameMode: "unknown"`;
- reset `templateId: "growingSuburb"`;
- additional unknown context fields, which remain accepted.

Extend the WASM mock with a static `from_sandbox_request` spy and configurable object/string rejections. Assert successful construction replaces the local engine, typed object failure returns `ok: false` without replacement, and string failure rejects.

- [ ] **Step 2: Run focused Vitest and verify red**

Run:

```bash
bunx vitest run tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts
```

Expected: tests fail because the request/result types, guards, and adapter methods are missing.

- [ ] **Step 3: Add schema-v4 TypeScript types and strict guards**

Set the TypeScript schema constant to `4`; change the template union to `"blankGrid" | "crossroads"`; add `startingCapital` to `GameRules.sandbox`.

In `sandboxErrors.ts`, use a plain-object predicate:

```typescript
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
```

Validate code membership, a plain `context`, and every recognized present field. Preserve unknown context fields. Export guards through `backend/index.ts`.

- [ ] **Step 4: Add the WASM requested constructor and typed reset**

In Rust, add the requested constructor (the `reset` wrapper was already updated in Task 3 to serialize `SandboxResetError` as an object):

```rust
pub fn from_sandbox_request(request: JsValue) -> Result<WasmGameEngine, JsValue> {
    let request: SandboxCreationRequest =
        serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
    let inner = GameEngine::from_sandbox_request(request)
        .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
    Ok(WasmGameEngine { inner })
}
```

Leave serialization/module failures as strings.

In `wasmBackend.ts`, construct a candidate first and replace `engine` only after success. Catch only values passing the relevant guard; rethrow everything else. Return discriminated reset results.

Update `tauriBackend.ts` to the same public TypeScript contract by invoking `game_create_sandbox`/`game_reset`; `game_reset` already compiles from Task 3 (stringified error) and is upgraded to `TauriCommandError<SandboxResetError>` in Task 5.

- [ ] **Step 5: Migrate TS consumers so `bun run check` compiles**

The `GameBackend.reset()` signature and template union change ripple to `createGameRuntime`, `runtimeSelectors`, and every test backend double. Apply the minimal adaptations here so the TypeScript workspace compiles end-to-end; Task 6 refines the `ok: false` branch from fatal to nonfatal, and Task 7 keeps the file rename + docs.

In `src/runtime/runtimeSelectors.ts`, replace the label map (Task 7 renames the shared dimension module and updates docs):

```typescript
const SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string> = {
  blankGrid: "Blank Grid",
  crossroads: "Crossroads",
};
```

In `src/runtime/createGameRuntime.ts`, branch on the discriminated result. For `ok: false`, route through the existing `failBackend` path for now (Task 6 replaces this with the nonfatal `sandboxResetError` channel):

```typescript
reset() {
  clearHoverPreviewTimer();
  previewCoordinator.invalidateRoute();
  invalidateRoadPreview();
  return queueBackend(async () => {
    const result = await backend.reset();
    if (!result.ok) {
      return failBackend(result.error);
    }
    backendError = null;
    rejection = null;
    state = normalizeRustSnapshot(result.snapshot);
    ui = createUiState();
    return publish();
  });
},
```

Update every test backend double (`tests/runtime/gameRuntime.test.ts`, `tests/runtime/backendContract.test.ts`, `tests/ui/pointerEvents.test.ts`, and any other `GameBackend` implementor surfaced by `rg -n 'reset\(\)' tests`) to return `{ ok: true, snapshot: resetSnapshot }` instead of the bare snapshot. Add no `ok: false` doubles here — Task 6 introduces the typed reset rejection test backend.

Update `tests/fixtures/rustSnapshot.ts` and any fixture referenced by `rg -n '"growingSuburb"|templateId' tests` to schema `4` with `templateId: "crossroads"` and `startingCapital`. Task 7 performs the exhaustive fixture/label/E2E migration; this step only updates the fixtures needed for `bun run check` and the Task 4 smoke tests to pass.

- [ ] **Step 6: Add real built-artifact creation/reset tests**

In `wasmArtifact.smoke.test.ts`, use the real generated module through `createWasmBackend()` and assert:

- Blank Grid and Crossroads return schema-v4 snapshots with the requested rules/budget;
- repeated identical requests produce equal complete snapshots;
- invalid values return exact typed codes/contexts;
- NaN/infinity use WASM canonical diagnostic strings;
- failed creation leaves the prior engine snapshot unchanged;
- reset restores the exact request after budget/map mutation;
- default constructor equals canonical Crossroads.

The production changes these tests catch are bypassing Rust validation, replacing the engine before validation, stringifying domain errors, or resetting to the hard-coded default.

- [ ] **Step 7: Rebuild WASM and run the host gate**

Run:

```bash
bun run wasm:build
bunx vitest run tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/backendContract.test.ts tests/ui/pointerEvents.test.ts
bun run check
```

Expected: all selected tests and TypeScript/Svelte checks pass.

- [ ] **Step 8: Commit the WASM/backend contract**

```bash
git add crates/caelum-wasm/src/lib.rs src/domain/types.ts src/runtime/backend/types.ts src/runtime/backend/index.ts src/runtime/backend/sandboxErrors.ts src/runtime/backend/wasmBackend.ts src/runtime/backend/tauriBackend.ts src/runtime/createGameRuntime.ts src/runtime/runtimeSelectors.ts tests/fixtures/rustSnapshot.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/gameRuntime.test.ts tests/runtime/backendContract.test.ts tests/ui/pointerEvents.test.ts
git commit -m "feat(runtime): expose sandbox factory through WASM"
```

---

### Task 5: Real Tauri Creation, Reset, and IPC Parity

**Files:**
- Modify: `src-tauri/src/lib.rs:1-232`
- Modify: `tests/runtime/tauriBackend.test.ts`

**Interfaces:**
- Consumes: `GameEngine::from_sandbox_request`, fallible `GameEngine::reset`, `SandboxCreationRequest`, and serialized domain errors. The `game_reset` command already compiles from Task 3 (stringified `SandboxResetError`); this task introduces `TauriCommandError<E>` and upgrades both commands to typed domain/host error transport.
- Produces:

```rust
#[derive(Serialize)]
#[serde(untagged)]
enum TauriCommandError<E> {
    Domain(E),
    Host(String),
}

fn game_create_sandbox(
    state: State<'_, EngineState>,
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, TauriCommandError<SandboxCreationError>>;

fn game_reset(
    state: State<'_, EngineState>,
) -> Result<GameSnapshot, TauriCommandError<SandboxResetError>>;
```

- [ ] **Step 1: Write failing real IPC tests**

Use the existing `tauri::test::mock_builder`/`get_ipc_response` harness and a shared request-body helper. Through IPC, assert:

- default and non-default Blank Grid/Crossroads snapshots equal direct core factory results;
- successful creation replaces managed state;
- invalid request returns an object-shaped domain error and `game_snapshot` still returns the prior snapshot;
- JSON `null` capital/demand produce the appropriate code with `"null"` attempted value;
- campaign reset returns `unsupportedGameMode` and preserves state;
- valid sandbox reset reproduces the complete original request.

Register `game_create_sandbox`, `game_reset`, and `game_snapshot` in the test mock app. Decode successful `InvokeResponse` JSON to `GameSnapshot` and compare complete values rather than selected fields.

- [ ] **Step 2: Run the Tauri tests and verify red**

Run:

```bash
cargo test -p caelum --lib game_create_sandbox -- --nocapture
```

Expected: compilation fails because the command and mixed error transport do not exist.

- [ ] **Step 3: Implement mixed domain/host command errors**

Build a complete candidate engine before acquiring the managed mutex:

```rust
let candidate =
    GameEngine::from_sandbox_request(request).map_err(TauriCommandError::Domain)?;
let snapshot = candidate.snapshot();
let mut engine = state
    .lock()
    .map_err(|error| TauriCommandError::Host(error.to_string()))?;
*engine = candidate;
Ok(snapshot)
```

For reset, lock the existing engine, map `SandboxResetError` to `Domain`, and mutex poisoning to `Host`. Register the command in the production `generate_handler!`.

- [ ] **Step 4: Prove host-shaped failures stay unexpected**

Add a unit-level serialization assertion proving:

```rust
assert!(serde_json::to_value(TauriCommandError::<SandboxCreationError>::Host(
    "mutex poisoned".to_string()
))
.unwrap()
.is_string());
```

Keep the existing TypeScript adapter test that rejects the same string rather than normalizing it to a domain result.

- [ ] **Step 5: Run real IPC plus adapter tests**

Run:

```bash
cargo test -p caelum --lib
bunx vitest run tests/runtime/tauriBackend.test.ts
```

Expected: all Tauri IPC and adapter tests pass.

- [ ] **Step 6: Commit the Tauri host**

```bash
git add src-tauri/src/lib.rs tests/runtime/tauriBackend.test.ts
git commit -m "feat(tauri): expose atomic sandbox creation"
```

---

### Task 6: Nonfatal Runtime Reset Error Channel

**Files:**
- Modify: `src/runtime/types.ts:188-212`
- Modify: `src/runtime/createGameRuntime.ts:183-209`
- Modify: `src/runtime/createGameRuntime.ts:1018-1029`
- Modify: `tests/runtime/gameRuntime.test.ts:720-890`
- Modify: `tests/runtime/gameRuntime.test.ts:1568-1585`
- Modify: `tests/ui/pointerEvents.test.ts`

**Interfaces:**
- Consumes: `GameBackend.reset(): Promise<SandboxResetResult>`.
- Produces:

```typescript
export interface RuntimeSnapshot {
  state: GameState;
  ui: UiState;
  shell: ShellState;
  backendError: string | null;
  rejection: GameplayRejection | null;
  sandboxResetError: SandboxResetError | null;
}
```

- [ ] **Step 1: Update backend doubles and write failing runtime tests**

Make every test backend return:

```typescript
async reset(): Promise<SandboxResetResult> {
  return { ok: true, snapshot: resetSnapshot };
}
```

Add one backend whose reset returns:

```typescript
{
  ok: false,
  error: {
    code: "unsupportedGameMode",
    context: { gameMode: "campaign" },
  },
}
```

Assert after `await runtime.reset()`:

- state and UI object values are unchanged;
- existing gameplay rejection is unchanged;
- `sandboxResetError` equals the typed error;
- `backendError` remains null;
- `runtime.isRunning()` remains true when started;
- a subsequent `setSpeed(2)` reaches the backend.

Add a pending-preview rejection test: arm a bus/metro route draft, add waypoints so a route preview is in flight (`ui.routeDraft.previewPending === true` and a `previewCoordinator.requestRoute` promise is unresolved), then call `runtime.reset()` against the `ok: false` backend. Assert after the reset resolves:

- `ui.routeDraft` is still present (not cleared);
- `ui.routeDraft.previewPending` is still `true`;
- the in-flight `requestRoute` promise resolves to the preview response (not `null`), i.e. the route epoch was NOT bumped by reset;
- `ui.roadMutationPreview` and the hover preview timer are untouched (a scheduled hover preview still fires).

This catches the regression where the reset preamble invalidates previews before the backend result is known, disturbing UI state on a typed rejection.

Add a separate rejected-promise test proving reset still sets `backendError`, stops the runtime, and prevents a subsequent backend call.

- [ ] **Step 2: Run the runtime test and verify red**

Run:

```bash
bunx vitest run tests/runtime/gameRuntime.test.ts -t "reset"
```

Expected: type/test failure because `RuntimeSnapshot` and reset do not distinguish typed results.

- [ ] **Step 3: Implement the lifecycle channel without touching shell errors**

Initialize `sandboxResetError = null`, include it in `getSnapshot`, and move the preview invalidation preamble INTO the success branch so a typed rejection does not disturb pending previews:

```typescript
reset() {
  return queueBackend(async () => {
    const result = await backend.reset();
    if (!result.ok) {
      sandboxResetError = result.error;
      return publish();
    }
    clearHoverPreviewTimer();
    previewCoordinator.invalidateRoute();
    invalidateRoadPreview();
    sandboxResetError = null;
    backendError = null;
    rejection = null;
    state = normalizeRustSnapshot(result.snapshot);
    ui = createUiState();
    return publish();
  });
},
```

The previous preamble (`clearHoverPreviewTimer` / `invalidateRoute` / `invalidateRoadPreview` before the backend call) is removed from `reset()` — it bumped the route epoch and cancelled the hover timer before the result was known, so an `ok: false` response would resolve an in-flight route preview as `null` (clearing `previewPending`) and prevent a scheduled hover preview from firing. On success, invalidation still runs before `ui = createUiState()` replaces the UI, so stale previews do not leak into the fresh state.

Do not set `dead`, call `stop`, clear the gameplay rejection, or replace UI for `ok: false`. Leave rejected promises on the existing `failBackend` path. Keep the typed reset error until the next successful reset.

- [ ] **Step 4: Run runtime and UI contract tests**

Run:

```bash
bunx vitest run tests/runtime/gameRuntime.test.ts tests/ui/pointerEvents.test.ts
bun run check
```

Expected: all selected tests and checks pass.

- [ ] **Step 5: Commit runtime reset behavior**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts tests/ui/pointerEvents.test.ts
git commit -m "feat(runtime): surface sandbox reset errors nonfatally"
```

---

### Task 7: Compatibility Migration, Labels, Documentation, and Full Verification

**Files:**
- Rename: `src/scenario/growingSuburb.ts` → `src/scenario/sandbox.ts`
- Modify: all imports returned by `rg -l 'scenario/growingSuburb' src tests`
- Modify: `tests/fixtures/rustSnapshot.ts` (exhaustive migration beyond the Task 4 minimal subset)
- Modify: `tests/helpers/gameState.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/e2e/roundabouts.spec.ts`
- Modify: `tests/runtime/backendContract.test.ts`
- Modify: `tests/runtime/e2eHelpers.test.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts:990-1115`
- Modify: `tests/runtime/wasmBackend.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/ui/hudPanels.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: schema-v4 domain contract and canonical template labels. The `SANDBOX_TEMPLATE_LABELS` map and the minimal fixture subset were already migrated in Task 4 so `bun run check` compiles; this task performs the exhaustive fixture/E2E/docs migration and the shared-dimension module rename.
- Produces: exhaustive schema-v4 fixture/label/E2E/docs coverage with no remaining `"growingSuburb"` or schema-v3 references.

- [ ] **Step 1: Write failing selector/UI expectations**

Change sandbox Brief assertions from `"Template · Growing Suburb"` to `"Template · Crossroads"`. Add a Blank Grid selector case. Keep campaign title/context as `"Growing Suburb"` because campaign identity is independent from sandbox template identity.

Update the E2E default-start expectation to show `"Crossroads"` as the sandbox template context while retaining `"Standard Sandbox"` mode/economy copy.

- [ ] **Step 2: Run affected TS/UI tests and verify red**

Run:

```bash
bunx vitest run tests/runtime/backendContract.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts
```

Expected: failures identify remaining schema-v3, `"growingSuburb"`, missing `startingCapital`, and old-label fixtures.

- [ ] **Step 3: Complete the exhaustive fixture and label migration**

Update every fixture to schema `4` and:

```typescript
sandbox: {
  templateId: "crossroads",
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
}
```

Add Blank Grid fixture overrides only where a test explicitly exercises that template. Rename the shared dimension module with `git mv`, keep only `MAP_WIDTH = 28` and `MAP_HEIGHT = 18`, and update comments to describe shared sandbox dimensions rather than Growing Suburb ownership.

Run:

```bash
rg -n '"growingSuburb"|schema-v3|schemaVersion.?[:=].?3|SNAPSHOT_SCHEMA_VERSION\s*[:=]\s*3|schema_version\s*[:=]\s*3|scenario/growingSuburb' crates src src-tauri tests CLAUDE.md docs/architecture.md
```

The gate covers both JSON-style schema fields (`"schemaVersion": 3`) and language-level constant declarations (TypeScript `SNAPSHOT_SCHEMA_VERSION = 3`, Rust `schema_version = 3`). Every remaining match must refer to a deliberate rejected legacy payload or historical issue text; rewrite all current-contract matches.

- [ ] **Step 4: Update architecture documentation**

Document:

- schema-v4 required `startingCapital`;
- Rust sandbox factory/default request;
- Blank Grid and Crossroads map contracts;
- Crossroads existing routable automatic junction and required 12-movement subset;
- exact sandbox reset and campaign rejection;
- WASM/Tauri error separation and parity tests;
- TypeScript `sandboxResetError` as nonfatal.

Correct the stale `CLAUDE.md` schema number and replace sandbox-specific Growing Suburb wording while preserving campaign references.

- [ ] **Step 5: Run focused tests after migration**

Run:

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test sandbox_factory
cargo test -p caelum-core --test sandbox_engine
cargo test -p caelum --lib
bunx vitest run tests/runtime/backendContract.test.ts tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/runtimeSelectors.test.ts tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts
```

Expected: all focused Rust, host, runtime, and UI tests pass.

- [ ] **Step 6: Run repository gates**

Run in this order:

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run check
bun run format:check
bun run test
bun run build
bun run test:e2e
```

Expected: every command exits zero with no warnings or failing tests.

- [ ] **Step 7: Review the complete HPA-339 acceptance contract**

Re-fetch live Linear HPA-339 and verify:

- repeated equal snapshots/stable IDs;
- structurally empty Blank Grid;
- Crossroads required movements;
- typed invalid request errors;
- real browser/Tauri parity;
- exact active-template reset.

Inspect:

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors and only intentional task-owned changes.

- [ ] **Step 8: Commit compatibility and documentation**

```bash
git add src/scenario/sandbox.ts src/runtime/runtimeSelectors.ts tests/fixtures/rustSnapshot.ts tests/helpers/gameState.ts tests/e2e/helpers.ts tests/e2e/roundabouts.spec.ts tests/e2e/smoke.spec.ts tests/runtime/backendContract.test.ts tests/runtime/e2eHelpers.test.ts tests/runtime/runtimeSelectors.test.ts tests/runtime/wasmBackend.test.ts tests/ui/appShell.test.ts tests/ui/hudPanels.test.ts CLAUDE.md docs/architecture.md
git commit -m "docs: align sandbox factory compatibility contracts"
```
