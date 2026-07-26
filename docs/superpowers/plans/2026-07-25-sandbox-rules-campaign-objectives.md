# HPA-337 Sandbox Rules and Optional Campaign Objectives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rust-owned schema-v3 default a Standard Sandbox with no objectives or automatic growth while preserving explicit, deterministic campaign objectives and growth waves across Rust, WASM, Tauri, TypeScript, and the Brief UI.

**Architecture:** `caelum-core` remains the only gameplay authority. Schema-v3 adds a required `GameRules` object and required-but-nullable campaign objectives; the Rust tick pipeline gates objective evaluation and growth by mode and uses one sanitized rolling window for retention and scoring. TypeScript mirrors and normalizes the Rust wire shape, while runtime selectors turn it into display-ready sandbox or campaign copy.

**Tech Stack:** Rust 2021, Serde/serde_json, serde-wasm-bindgen, Tauri 2, TypeScript, Svelte 5 runes, Bun, Vitest, Playwright.

## Global Constraints

- Set `SNAPSHOT_SCHEMA_VERSION = 3` in Rust and TypeScript; schema-v2 snapshots are rejected, not migrated.
- `rules`, `scenario`, `scenario.objectives`, and `scenario.growthWaves` are required schema-v3 keys.
- `scenario.objectives` serializes as an object or explicit `null` in JSON; a present WASM `undefined` deserializes as `None`, but an omitted key fails.
- Rust owns mode, economy, template, demand multiplier, move-in selection, objective evaluation, growth, and metrics retention.
- `DemandMultiplier` accepts only finite values strictly greater than zero and remains a plain JSON/JS number.
- The fresh default is `sandbox` + `standard` + `growingSuburb` + demand `1.0` + `paused`, with `objectives: null` and `growthWaves: []`.
- Sandbox continues collecting metrics but cannot newly win, lose, or apply growth waves.
- Campaign growth does not require objectives; campaign objectives do not require growth waves.
- A configured rolling window is usable only when finite and greater than zero; otherwise use `ROLLING_WINDOW_SECONDS = 300.0`.
- Existing terminal snapshots remain frozen because `tick_trips_substepped` returns before mode-specific work.
- Creative cost behavior, new templates, persistence migration, and operational move-in rates remain outside HPA-337.
- Preserve deterministic simulation, immutable snapshot updates, reference-equality dispatch, and existing Svelte 5 runes conventions.

---

## File Map

- Modify `crates/caelum-core/src/model.rs`: schema version, rules types, validated demand multiplier, required nullable objectives.
- Modify `crates/caelum-core/src/scenario.rs`: objective defaults plus sandbox/campaign constructors.
- Modify `crates/caelum-core/src/state.rs`: schema-v3 Standard Sandbox initial rules.
- Modify `crates/caelum-core/src/engine.rs`: schema-v3 load documentation.
- Modify `crates/caelum-core/src/objectives.rs`: mode/option gates, serialized thresholds, effective rolling window.
- Modify `crates/caelum-core/src/trips.rs`: pass the effective window into outcome pruning.
- Modify `crates/caelum-core/src/growth.rs`: campaign-only growth and fixture migration.
- Modify Rust integration/host tests in `crates/caelum-core/tests/` and `src-tauri/src/lib.rs`.
- Modify `src/domain/types.ts`, `src/runtime/backend/types.ts`, and `src/runtime/snapshotView.ts`: schema-v3 host/domain parity.
- Modify `tests/fixtures/rustSnapshot.ts` and `tests/helpers/gameState.ts`: Standard Sandbox defaults.
- Modify `tests/runtime/backendContract.test.ts`, `tests/runtime/wasmArtifact.smoke.test.ts`, and backend tests: null/undefined parity and strict load behavior.
- Modify `src/runtime/runtimeSelectors.ts` and `src/runtime/types.ts`: display-ready Brief state.
- Modify `src/components/hud/panels/BriefPanel.svelte`: render selector-owned context.
- Modify `tests/runtime/runtimeSelectors.test.ts`, `tests/ui/appShell.test.ts`, and `tests/ui/hudPanels.test.ts`: Brief behavior and copy.
- Modify `docs/architecture.md`: schema-v3 sandbox/campaign architecture.

---

### Task 1: Rust Schema-v3 Rules and Scenario Wire Contract

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/scenario.rs`
- Modify: `crates/caelum-core/src/state.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Test: `crates/caelum-core/tests/model_wire_format.rs`
- Test: `crates/caelum-core/tests/stop_migration.rs`
- Verify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: existing `ObjectiveThresholds`, `GrowthWave`, and public objective constants.
- Produces:

```rust
pub enum GameMode {
    Sandbox,
    Campaign,
}

pub enum EconomyPreset {
    Standard,
    Creative,
}

pub enum SandboxTemplateId {
    GrowingSuburb,
}

pub enum MoveInRateSelection {
    Paused,
}

pub struct DemandMultiplier(f64);

pub struct SandboxSettings {
    pub template_id: SandboxTemplateId,
    pub demand_multiplier: DemandMultiplier,
    pub move_in_rate: MoveInRateSelection,
}

pub struct GameRules {
    pub game_mode: GameMode,
    pub economy_preset: EconomyPreset,
    pub sandbox: SandboxSettings,
}

pub fn growing_suburb_objectives() -> ObjectiveThresholds;

pub fn growing_suburb_campaign(
    objectives: ObjectiveThresholds,
    growth_waves: Vec<GrowthWave>,
) -> (GameRules, ScenarioConfig);
```

- [ ] **Step 1: Write failing schema-v3 wire tests**

Add focused tests to `model_wire_format.rs`:

```rust
#[test]
fn default_snapshot_serializes_standard_sandbox_rules_and_null_objectives() {
    let value = serde_json::to_value(create_initial_snapshot()).unwrap();

    assert_eq!(value["schemaVersion"], json!(3));
    assert_eq!(
        value["rules"],
        json!({
            "gameMode": "sandbox",
            "economyPreset": "standard",
            "sandbox": {
                "templateId": "growingSuburb",
                "demandMultiplier": 1.0,
                "moveInRate": "paused"
            }
        })
    );
    assert_eq!(value["scenario"]["objectives"], json!(null));
    assert_eq!(value["scenario"]["growthWaves"], json!([]));
}

#[test]
fn demand_multiplier_rejects_non_positive_and_non_finite_values() {
    for value in [0.0, -1.0, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        assert!(DemandMultiplier::try_from(value).is_err());
    }
    assert!(serde_json::from_value::<DemandMultiplier>(json!(0.0)).is_err());
    assert!(serde_json::from_value::<DemandMultiplier>(json!(-1.0)).is_err());

    let multiplier = DemandMultiplier::try_from(1.5).unwrap();
    assert_eq!(serde_json::to_value(multiplier).unwrap(), json!(1.5));
}

#[test]
fn nullable_objectives_key_is_required() {
    let mut value = serde_json::to_value(create_initial_snapshot()).unwrap();
    value["scenario"]
        .as_object_mut()
        .unwrap()
        .remove("objectives");

    assert!(serde_json::from_value::<GameSnapshot>(value).is_err());
}
```

Also add table-driven invalid enum tests that replace `gameMode`,
`economyPreset`, `templateId`, and `moveInRate` with `"unknown"` and assert
`serde_json::from_value::<GameSnapshot>` returns `Err`.

- [ ] **Step 2: Run the focused test target and verify red**

Run:

```bash
cargo test -p caelum-core --test model_wire_format default_snapshot_serializes_standard_sandbox_rules_and_null_objectives -- --exact
```

Expected: compilation fails because the new rule types and schema-v3 fields do
not exist.

- [ ] **Step 3: Add the validated model types and required nullable field**

In `model.rs`, set the schema constant to `3`, import `serde::Deserializer`,
and add:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameMode {
    Sandbox,
    Campaign,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EconomyPreset {
    Standard,
    Creative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxTemplateId {
    GrowingSuburb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveInRateSelection {
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct DemandMultiplier(f64);

impl DemandMultiplier {
    pub fn new(value: f64) -> Result<Self, &'static str> {
        Self::try_from(value)
    }

    pub fn value(self) -> f64 {
        self.0
    }
}

impl Default for DemandMultiplier {
    fn default() -> Self {
        Self(1.0)
    }
}

impl TryFrom<f64> for DemandMultiplier {
    type Error = &'static str;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        if value.is_finite() && value > 0.0 {
            Ok(Self(value))
        } else {
            Err("demand multiplier must be finite and greater than zero")
        }
    }
}

impl From<DemandMultiplier> for f64 {
    fn from(value: DemandMultiplier) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSettings {
    pub template_id: SandboxTemplateId,
    pub demand_multiplier: DemandMultiplier,
    pub move_in_rate: MoveInRateSelection,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRules {
    pub game_mode: GameMode,
    pub economy_preset: EconomyPreset,
    pub sandbox: SandboxSettings,
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
```

Add `pub rules: GameRules` to `GameSnapshot`. Remove the Serde default from
`scenario`, delete `default_scenario()`, change `ScenarioConfig.objectives` to:

```rust
#[serde(deserialize_with = "deserialize_required_option")]
pub objectives: Option<ObjectiveThresholds>,
```

Remove the Serde default from `growth_waves`. Do not add
`skip_serializing_if`; JSON `None` must emit `"objectives": null`.

- [ ] **Step 4: Add explicit sandbox and campaign constructors**

In `scenario.rs`, retain the existing constants and add:

```rust
pub fn growing_suburb_objectives() -> ObjectiveThresholds {
    ObjectiveThresholds {
        max_late_ratio: MAX_LATE_RATIO,
        max_unserved_ratio: MAX_UNSERVED_RATIO,
        max_average_wait: MAX_AVERAGE_WAIT_SECONDS,
        rolling_window_seconds: ROLLING_WINDOW_SECONDS,
        survival_time: SURVIVAL_TIME_SECONDS,
    }
}

pub fn growing_suburb_scenario() -> ScenarioConfig {
    ScenarioConfig {
        name: SCENARIO_NAME.to_string(),
        objectives: None,
        growth_waves: Vec::new(),
    }
}

pub fn growing_suburb_campaign(
    objectives: ObjectiveThresholds,
    growth_waves: Vec<GrowthWave>,
) -> (GameRules, ScenarioConfig) {
    (
        GameRules {
            game_mode: GameMode::Campaign,
            economy_preset: EconomyPreset::Standard,
            sandbox: SandboxSettings {
                template_id: SandboxTemplateId::GrowingSuburb,
                demand_multiplier: DemandMultiplier::default(),
                move_in_rate: MoveInRateSelection::Paused,
            },
        },
        ScenarioConfig {
            name: SCENARIO_NAME.to_string(),
            objectives: Some(objectives),
            growth_waves,
        },
    )
}
```

In `state.rs`, populate the fresh snapshot with:

```rust
rules: GameRules {
    game_mode: GameMode::Sandbox,
    economy_preset: EconomyPreset::Standard,
    sandbox: SandboxSettings {
        template_id: SandboxTemplateId::GrowingSuburb,
        demand_multiplier: DemandMultiplier::default(),
        move_in_rate: MoveInRateSelection::Paused,
    },
},
```

Update the `GameEngine::from_snapshot` doc comment from schema-v2 to
schema-v3.

- [ ] **Step 5: Complete strict-field and round-trip coverage**

In `model_wire_format.rs`:

- Replace the literal schema expectation `2` with `3`.
- Serialize `growing_suburb_objectives()` directly to retain the exact
  camelCase threshold-name assertions.
- Add a campaign `(rules, scenario)` round trip using
  `growing_suburb_campaign(growing_suburb_objectives(), Vec::new())`.
- For each required key (`rules`, `scenario`, `objectives`, `growthWaves`),
  remove it from a serialized snapshot and assert deserialization fails.
- Assert explicit `"objectives": null` deserializes to `None`.
- Replace
  `scenario_config_growth_waves_defaults_to_empty_when_omitted` with a
  rejection assertion.

In `stop_migration.rs`, replace the literal
`assert_eq!(snapshot.schema_version, 2)` with
`assert_eq!(snapshot.schema_version, SNAPSHOT_SCHEMA_VERSION)`. Keep the
unsupported-schema case at `SNAPSHOT_SCHEMA_VERSION - 1`. Tauri host tests
continue using the shared constant and therefore require no parallel schema
number.

- [ ] **Step 6: Run Rust schema and host checks**

Run:

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core --test stop_migration
cargo test -p caelum-core
cargo test -p caelum
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all commands pass; default snapshots serialize the complete
schema-v3 sandbox shape, invalid fields reject, and no dead
`default_scenario()` remains.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/scenario.rs crates/caelum-core/src/state.rs crates/caelum-core/src/engine.rs crates/caelum-core/tests/model_wire_format.rs crates/caelum-core/tests/stop_migration.rs
git commit -m "feat(core): add schema-v3 sandbox rules"
```

---

### Task 2: Mode-Gated Objectives and Safe Rolling Windows

**Files:**
- Modify: `crates/caelum-core/src/objectives.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Test: `crates/caelum-core/tests/objectives_metrics.rs`
- Test: `crates/caelum-core/tests/trip_lifecycle.rs`
- Test: `crates/caelum-core/tests/golden_sequences.rs`

**Interfaces:**
- Consumes: `GameRules`, `GameMode`, and optional `ScenarioConfig.objectives`
  from Task 1.
- Produces:

```rust
pub fn effective_rolling_window_seconds(state: &GameSnapshot) -> f64;

pub fn prune_trip_outcomes(
    outcomes: &mut Vec<TripOutcome>,
    current_time: f64,
    retention_window_seconds: f64,
);

pub fn evaluate_objectives(state: &GameSnapshot) -> GameSnapshot;
```

- [ ] **Step 1: Add campaign and sandbox fixture helpers**

At the top of `objectives_metrics.rs`, add:

```rust
fn campaign_state() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) =
        growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    state.rules = rules;
    state.scenario = scenario;
    state
}
```

Change existing win/loss threshold tests to start from `campaign_state()`.
Keep fresh-engine sandbox tests on `create_initial_snapshot()` or
`GameEngine::new()`.

- [ ] **Step 2: Write failing sandbox, custom-threshold, window, and terminal tests**

Add:

```rust
#[test]
fn sandbox_with_served_demand_runs_past_campaign_survival_time() {
    let mut snapshot = create_initial_snapshot();
    snapshot.paused = false;
    snapshot.metrics.completed_trips = 1;
    let mut engine = GameEngine::from_snapshot(snapshot).unwrap();

    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.time, 1_201.0);
    assert_eq!(result.snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn sandbox_ignores_loss_producing_metrics() {
    let mut state = create_initial_snapshot();
    state.scenario.objectives = Some(growing_suburb_objectives());
    state.metrics.completed_trips = 7;
    state.metrics.unserved_trips = 3;

    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn campaign_uses_thresholds_from_its_snapshot() {
    let mut state = campaign_state();
    state.metrics.completed_trips = 10;
    state.metrics.late_trips = 3;
    state.scenario.objectives.as_mut().unwrap().max_late_ratio = 0.5;

    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn valid_custom_campaign_window_drives_pruning_and_scoring() {
    let mut state = campaign_state();
    state.time = 1_000.0;
    state.scenario.objectives
        .as_mut()
        .unwrap()
        .rolling_window_seconds = 600.0;
    state.metrics.completed_trips = 100;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..100)
        .map(|_| TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 100.0,
        })
        .chain((0..10).map(|_| TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 500.0,
        }))
        .collect();

    let window = objectives::effective_rolling_window_seconds(&state);
    assert_eq!(window, 600.0);

    let mut retained = state.metrics.trip_outcomes.clone();
    objectives::prune_trip_outcomes(&mut retained, state.time, window);
    assert_eq!(retained.len(), 10);
    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Lost
    );
}

#[test]
fn invalid_campaign_windows_use_the_same_300_second_fallback() {
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let mut state = campaign_state();
        state.time = 1_000.0;
        state.scenario.objectives
            .as_mut()
            .unwrap()
            .rolling_window_seconds = invalid;
        state.metrics.completed_trips = 100;
        state.metrics.unserved_trips = 10;
        state.metrics.trip_outcomes = (0..100)
            .map(|_| TripOutcome {
                outcome: TripOutcomeKind::Arrived,
                wait_seconds: 0.0,
                time: 100.0,
            })
            .chain((0..10).map(|_| TripOutcome {
                outcome: TripOutcomeKind::Unserved,
                wait_seconds: 0.0,
                time: 750.0,
            }))
            .collect();

        let window = objectives::effective_rolling_window_seconds(&state);
        assert_eq!(window, objectives::ROLLING_WINDOW_SECONDS);

        let mut retained = state.metrics.trip_outcomes.clone();
        objectives::prune_trip_outcomes(&mut retained, state.time, window);
        assert_eq!(retained.len(), 10);
        assert!(retained
            .iter()
            .all(|outcome| outcome.outcome == TripOutcomeKind::Unserved));

        assert_eq!(
            objectives::evaluate_objectives(&state).metrics.state,
            MetricsState::Lost
        );
    }
}

#[test]
fn sandbox_and_objective_less_campaign_use_default_retention() {
    let mut sandbox = create_initial_snapshot();
    let mut attached = growing_suburb_objectives();
    attached.rolling_window_seconds = 600.0;
    sandbox.scenario.objectives = Some(attached);
    assert_eq!(
        objectives::effective_rolling_window_seconds(&sandbox),
        objectives::ROLLING_WINDOW_SECONDS
    );

    let (rules, mut scenario) =
        growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    scenario.objectives = None;
    sandbox.rules = rules;
    sandbox.scenario = scenario;
    assert_eq!(
        objectives::effective_rolling_window_seconds(&sandbox),
        objectives::ROLLING_WINDOW_SECONDS
    );
}

#[test]
fn loaded_terminal_sandbox_remains_frozen() {
    let mut snapshot = create_initial_snapshot();
    snapshot.paused = false;
    snapshot.metrics.state = MetricsState::Won;
    let mut engine = GameEngine::from_snapshot(snapshot).unwrap();

    let result = engine.tick(60.0);

    assert!(!result.applied);
    assert_eq!(result.snapshot.time, 0.0);
    assert_eq!(result.snapshot.metrics.state, MetricsState::Won);
}
```

- [ ] **Step 3: Run the objective test target and verify red**

Run:

```bash
cargo test -p caelum-core --test objectives_metrics
```

Expected: sandbox terminalizes, custom thresholds are ignored, and the new
effective-window API is missing.

- [ ] **Step 4: Implement one sanitized rolling-window policy**

In `objectives.rs`, add:

```rust
pub fn effective_rolling_window_seconds(state: &GameSnapshot) -> f64 {
    if state.rules.game_mode != GameMode::Campaign {
        return ROLLING_WINDOW_SECONDS;
    }

    let Some(objectives) = state.scenario.objectives.as_ref() else {
        return ROLLING_WINDOW_SECONDS;
    };
    let configured = objectives.rolling_window_seconds;
    if configured.is_finite() && configured > 0.0 {
        configured
    } else {
        ROLLING_WINDOW_SECONDS
    }
}
```

Change `prune_trip_outcomes` to subtract its
`retention_window_seconds` argument. Change `objective_counts` to accept
`rolling_window_seconds: f64` and use it in its filter.

Gate `evaluate_objectives` in this exact order and read all thresholds from
the snapshot:

```rust
pub fn evaluate_objectives(state: &GameSnapshot) -> GameSnapshot {
    if state.metrics.state != MetricsState::Running {
        return state.clone();
    }
    if state.rules.game_mode != GameMode::Campaign {
        return state.clone();
    }
    let Some(thresholds) = state.scenario.objectives.as_ref() else {
        return state.clone();
    };

    let rolling_window_seconds = effective_rolling_window_seconds(state);
    let counts = objective_counts(state, rolling_window_seconds);
    let total_trips = counts.completed_trips + counts.unserved_trips;

    if total_trips >= 10
        && f64::from(counts.unserved_trips) / f64::from(total_trips)
            > thresholds.max_unserved_ratio
    {
        return lose(state, "Too many unserved citizens");
    }
    if counts.completed_trips >= 10
        && f64::from(counts.late_trips) / f64::from(counts.completed_trips)
            > thresholds.max_late_ratio
    {
        return lose(state, "Too many late arrivals");
    }
    if state.metrics.waiting_trip_count > 0
        && state.metrics.average_wait_seconds > thresholds.max_average_wait
    {
        return lose(state, "Average wait time is too high");
    }
    if state.time >= thresholds.survival_time && state.metrics.completed_trips > 0 {
        let mut next = state.clone();
        next.metrics.state = MetricsState::Won;
        next.metrics.loss_reason = None;
        return next;
    }

    state.clone()
}
```

Keep the existing unserved, late, average-wait, and survival ordering and the
existing loss strings unchanged.

- [ ] **Step 5: Use serialized thresholds for objective-related substep boundaries**

In `trips.rs`, add:

```rust
fn active_objective_thresholds(state: &GameSnapshot) -> Option<&ObjectiveThresholds> {
    if state.rules.game_mode == GameMode::Campaign {
        state.scenario.objectives.as_ref()
    } else {
        None
    }
}
```

In `next_boundary_after`, derive
`let active_thresholds = active_objective_thresholds(state)`. When a finite
`survival_time` is later than `state.time + EPSILON`, pass it to
`track_next_boundary`; this makes a custom survival threshold a real coarse
tick boundary rather than evaluating only at the tick's final time.

Pass `active_thresholds.map(|value| value.max_average_wait)` into
`track_active_trip_boundary`, `track_waiting_terminal_boundaries`, and
`track_aggregate_wait_boundary`. Replace both uses of
`objectives::MAX_AVERAGE_WAIT_SECONDS` with that supplied threshold. When the
option is `None`, skip the average-wait objective boundary entirely; patience,
deadline, walking, vehicle, commute, day, and growth boundaries remain
unchanged.

- [ ] **Step 6: Feed the same effective policy into pruning**

In `trips.rs`, compute the window from the snapshot that supplied the metrics:

```rust
let retention_window_seconds = objectives::effective_rolling_window_seconds(state);
next.metrics = update_metrics(
    &state.metrics,
    &next.active_trips,
    metric_delta,
    state.time,
    retention_window_seconds,
);
```

Extend `update_metrics` with `retention_window_seconds: f64` and call:

```rust
objectives::prune_trip_outcomes(
    &mut trip_outcomes,
    current_time,
    retention_window_seconds,
);
```

Do not read the unsanitized threshold inside `prune_trip_outcomes` or
`objective_counts`.

- [ ] **Step 7: Migrate only objective-dependent Rust fixtures**

In `trip_lifecycle.rs`, add:

```rust
fn campaign_state() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) =
        growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    state.rules = rules;
    state.scenario = scenario;
    state
}
```

Use it in:

- `coarse_tick_detects_wait_loss_before_patience_expiry`
- `coarse_tick_detects_aggregate_wait_loss_between_per_trip_boundaries`
- `coarse_tick_detects_rolling_window_loss_before_outcomes_expire`

Leave ordinary trip lifecycle and stale-history pruning fixtures as sandbox.

In `golden_sequences.rs`, add:

```rust
fn nearby_walker_campaign_engine() -> GameEngine {
    let engine = nearby_walker_engine();
    let mut snapshot = engine.snapshot();
    let (rules, scenario) =
        growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    snapshot.rules = rules;
    snapshot.scenario = scenario;
    GameEngine::from_snapshot(snapshot).unwrap()
}
```

Use it only in `won_via_real_tick_pipeline`. Update the day-rollover comment:
the raw `tick_trips` call isolates rollover mechanics; it is no longer needed
to avoid a default-sandbox win.

Add this custom-window granularity test to `trip_lifecycle.rs`:

```rust
#[test]
fn custom_campaign_window_matches_coarse_and_fine_objective_ticks() {
    fn build() -> GameSnapshot {
        let mut state = campaign_state();
        state.paused = false;
        state.scenario.objectives
            .as_mut()
            .unwrap()
            .rolling_window_seconds = 600.0;
        state.active_trips = (0..10)
            .map(|index| {
                let mut waiting = trip(
                    &format!("trip-{index:03}"),
                    TripStatus::Waiting,
                    (7, 8).into(),
                    (22, 8).into(),
                );
                waiting.route_plan =
                    Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
                waiting.patience_remaining = 10.0;
                waiting
            })
            .collect();
        state
    }

    let coarse = trips::tick_trips_with_objectives(&build(), 700.0);
    let mut fine = build();
    while fine.metrics.state == MetricsState::Running {
        fine = trips::tick_trips_with_objectives(&fine, 1.0);
    }

    assert_eq!(coarse.metrics.state, MetricsState::Lost);
    assert_eq!(coarse.metrics.loss_reason, fine.metrics.loss_reason);
    assert_eq!(coarse.time, fine.time);
    assert_eq!(coarse.metrics.unserved_trips, fine.metrics.unserved_trips);
}
```

The valid-window test in `objectives_metrics.rs` proves that 600 seconds,
rather than the fallback 300, drives retention/scoring; this test separately
pins coarse/fine objective behavior while that custom window is active.

- [ ] **Step 8: Run focused and crate-wide Rust tests**

Run:

```bash
cargo test -p caelum-core --test objectives_metrics
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test golden_sequences
cargo test -p caelum-core
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: campaign gates preserve all existing objective behavior, sandbox
never newly terminalizes, invalid windows use 300 seconds for both pruning
and scoring, and coarse/fine determinism tests pass.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core/src/objectives.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/objectives_metrics.rs crates/caelum-core/tests/trip_lifecycle.rs crates/caelum-core/tests/golden_sequences.rs
git commit -m "feat(core): gate campaign objectives and retention"
```

---

### Task 3: Campaign-Only Growth

**Files:**
- Modify: `crates/caelum-core/src/growth.rs`

**Interfaces:**
- Consumes: `GameMode::Campaign`,
  `growing_suburb_campaign(growing_suburb_objectives(), waves)`, and the
  existing `tick_trips` boundary pipeline.
- Produces: `apply_due_growth_waves` as a no-op outside campaign mode.

- [ ] **Step 1: Add failing sandbox and objective-less campaign tests**

Inside `growth.rs` tests, add:

```rust
fn campaign_with_waves(waves: Vec<GrowthWave>) -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) =
        growing_suburb_campaign(growing_suburb_objectives(), waves);
    state.rules = rules;
    state.scenario = scenario;
    state.paused = false;
    state
}

#[test]
fn sandbox_attached_growth_waves_remain_unapplied() {
    let mut start = create_initial_snapshot();
    start.paused = false;
    start.scenario.growth_waves = growing_suburb_growth_waves();

    let next = trips::tick_trips(&start, 1.0);

    assert!(next.buildings.is_empty());
    assert!(next.sims.is_empty());
    assert!(!next.scenario.growth_waves[0].applied);
}

#[test]
fn campaign_without_objectives_still_applies_growth() {
    let mut start = campaign_with_waves(growing_suburb_growth_waves());
    start.scenario.objectives = None;

    let next = trips::tick_trips(&start, 1.0);

    assert_eq!(next.buildings.len(), 5);
    assert!(next.scenario.growth_waves[0].applied);
}
```

- [ ] **Step 2: Run growth tests and verify red**

Run:

```bash
cargo test -p caelum-core growth::tests
```

Expected: sandbox-attached waves still apply because
`apply_due_growth_waves` has no mode gate.

- [ ] **Step 3: Add the campaign gate**

At the start of `apply_due_growth_waves`:

```rust
if state.rules.game_mode != GameMode::Campaign {
    return;
}
```

Import `GameMode` alongside `GameSnapshot` and `GrowthAction`. Do not reject
or delete sandbox-attached wave data; leave it serialized and unapplied.

- [ ] **Step 4: Migrate every non-empty growth fixture**

Use `campaign_with_waves(...)` in:

- `seeded()`
- `placement_without_zoning_is_skipped_but_wave_marked_applied`
- `multiple_waves_in_one_tick_all_fire_in_declared_order`
- `mid_tick_wave_fires_at_boundary_regardless_of_granularity`

Keep `empty_growth_waves_is_a_noop` on the default sandbox. Keep these tests on
`trips::tick_trips`; they intentionally exercise growth without objective
evaluation.

- [ ] **Step 5: Run growth and full Rust checks**

Run:

```bash
cargo test -p caelum-core growth::tests
cargo test -p caelum-core
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all authored-wave tests pass in campaign mode, sandbox content
remains inert, and an objective-less campaign still grows.

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core/src/growth.rs
git commit -m "feat(core): restrict growth waves to campaigns"
```

---

### Task 4: TypeScript, WASM, and Tauri Schema Parity

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/snapshotView.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`
- Modify: `tests/helpers/gameState.ts`
- Test: `tests/runtime/backendContract.test.ts`
- Test: `tests/runtime/wasmArtifact.smoke.test.ts`
- Test: `tests/runtime/wasmBackend.test.ts`
- Test: `tests/runtime/tauriBackend.test.ts`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/ui/pointerEvents.test.ts`

**Interfaces:**
- Consumes: Rust schema-v3 wire types from Tasks 1–3.
- Produces:

```typescript
export type GameMode = "sandbox" | "campaign";
export type EconomyPreset = "standard" | "creative";
export type SandboxTemplateId = "growingSuburb";
export type MoveInRateSelection = "paused";

export interface GameRules {
  gameMode: GameMode;
  economyPreset: EconomyPreset;
  sandbox: {
    templateId: SandboxTemplateId;
    demandMultiplier: number;
    moveInRate: MoveInRateSelection;
  };
}

export interface ObjectiveThresholds {
  maxLateRatio: number;
  maxUnservedRatio: number;
  maxAverageWait: number;
  rollingWindowSeconds: number;
  survivalTime: number;
}
```

- [ ] **Step 1: Write failing normalization and schema-v3 contract tests**

In `backendContract.test.ts`, add:

```typescript
it("normalizes both Rust None encodings to null objectives", () => {
  const tauri = normalizeRustSnapshot(
    createRustSnapshot({
      scenario: {
        name: "Growing Suburb",
        objectives: null,
        growthWaves: [],
      },
    }),
  );
  const wasm = normalizeRustSnapshot(
    createRustSnapshot({
      scenario: {
        name: "Growing Suburb",
        objectives: undefined,
        growthWaves: [],
      },
    }),
  );

  expect(tauri.scenario.objectives).toBeNull();
  expect(wasm.scenario.objectives).toBeNull();
});

it("maps only known scenario fields", () => {
  const raw = createRustSnapshot() as RustGameSnapshot & {
    scenario: RustGameSnapshot["scenario"] & { unknownField: string };
  };
  raw.scenario.unknownField = "discard me";

  const normalized = normalizeRustSnapshot(raw);

  expect(normalized.scenario).toEqual({
    name: "Growing Suburb",
    objectives: null,
    growthWaves: [],
  });
  expect("unknownField" in normalized.scenario).toBe(false);
});
```

Update the existing custom-threshold test so the fixture explicitly supplies
an objective object and the normalized result preserves it unchanged.

- [ ] **Step 2: Run TypeScript checking and verify red**

Run:

```bash
bun run check
```

Expected: schema/rules types and nullable objectives do not yet match Rust.

- [ ] **Step 3: Add the canonical domain and raw host types**

In `src/domain/types.ts`:

- Set `SNAPSHOT_SCHEMA_VERSION = 3 as const`.
- Add the interfaces from this task's `Produces` block.
- Change `Scenario.objectives` to `ObjectiveThresholds | null`.
- Add `rules: GameRules` to `GameState`.

In `src/runtime/backend/types.ts`:

```typescript
export interface RustScenarioConfig {
  name: string;
  objectives: RustObjectiveThresholds | null | undefined;
  growthWaves: GrowthWave[];
}

export interface RustGameSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  rules: GameRules;
  time: number;
  day: number;
  clockMinutes: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  transit: TransitNetwork;
  sims: Sim[];
  activeTrips: ActiveTrip[];
  tripSequenceDay: number;
  nextTripSequence: number;
  metrics: RustMetrics;
  scenario: RustScenarioConfig;
}
```

Import `GameRules` and `SNAPSHOT_SCHEMA_VERSION` from the domain model. The
`undefined` union models a present WASM property; do not make `objectives`
optional.

- [ ] **Step 4: Normalize the raw scenario explicitly**

In `normalizeRustSnapshot`, keep the current schema check and use:

```typescript
scenario: {
  name: snapshot.scenario.name,
  objectives: snapshot.scenario.objectives ?? null,
  growthWaves: snapshot.scenario.growthWaves,
},
```

Leave the global serde-wasm-bindgen serializer unchanged. Do not invent rules,
thresholds, or growth events in TypeScript.

- [ ] **Step 5: Make shared fixtures Standard Sandbox**

In `createRustSnapshot`, add:

```typescript
rules: {
  gameMode: "sandbox",
  economyPreset: "standard",
  sandbox: {
    templateId: "growingSuburb",
    demandMultiplier: 1,
    moveInRate: "paused",
  },
},
scenario: {
  name: "Growing Suburb",
  objectives: null,
  growthWaves: [],
},
```

`createTestGameState()` continues normalizing this fixture and merging
explicit overrides; no separate TypeScript default rules factory is added.
The existing backend, runtime, and UI fixtures already construct their full
raw snapshots through `createRustSnapshot()`, so this one fixture update
propagates the required rules without local fallback objects.

- [ ] **Step 6: Prove the real WASM undefined and missing-key behavior**

Rename the real-artifact test to schema-v3 and add:

```typescript
it("round-trips present undefined objectives but rejects an omitted key", async () => {
  const backend = await createWasmBackend();
  const raw = await backend.snapshot();

  expect(Object.hasOwn(raw.scenario, "objectives")).toBe(true);
  expect(raw.scenario.objectives).toBeUndefined();
  const loaded = await backend.loadSnapshot!(raw);
  expect(loaded.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  expect(Object.hasOwn(loaded.scenario, "objectives")).toBe(true);
  expect(loaded.scenario.objectives).toBeUndefined();

  const missing = {
    ...raw,
    scenario: { ...raw.scenario },
  };
  delete (missing.scenario as { objectives?: unknown }).objectives;

  await expect(
    backend.loadSnapshot!(missing as RustGameSnapshot),
  ).rejects.toThrow(/objectives|missing field/i);
});

it("rejects invalid demand multipliers at the real WASM Rust boundary", async () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const backend = await createWasmBackend();
    const raw = await backend.snapshot();
    raw.rules.sandbox.demandMultiplier = invalid;

    await expect(backend.loadSnapshot!(raw)).rejects.toThrow(
      /demand multiplier/i,
    );
  }
});
```

Update the default real-WASM assertions to require the complete rules object,
`growthWaves: []`, and raw `objectives: undefined`. Tauri/backend fixture
assertions require `objectives: null`.

- [ ] **Step 7: Run host contract, real WASM, and type checks**

Run:

```bash
bun run ensure-wasm
bunx vitest run --project runtime tests/runtime/backendContract.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/gameRuntime.test.ts
bunx vitest run --project runtime tests/runtime/wasmArtifact.smoke.test.ts
bun run check
```

Expected: raw WASM/Tauri nullability differs only before normalization, both
normalize to the same schema-v3 `GameState`, and deleting the required
objectives key fails in the real WASM loader.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/runtime/backend/types.ts src/runtime/snapshotView.ts tests/fixtures/rustSnapshot.ts tests/helpers/gameState.ts tests/runtime/backendContract.test.ts tests/runtime/wasmArtifact.smoke.test.ts tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/gameRuntime.test.ts tests/ui/pointerEvents.test.ts
git commit -m "feat(runtime): normalize schema-v3 sandbox rules"
```

---

### Task 5: Sandbox and Campaign Brief Presentation

**Files:**
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/components/hud/panels/BriefPanel.svelte`
- Test: `tests/runtime/runtimeSelectors.test.ts`
- Test: `tests/ui/hudPanels.test.ts`
- Test: `tests/ui/appShell.test.ts`

**Interfaces:**
- Consumes: canonical `GameState.rules`, nullable objectives, and growth waves
  from Task 4.
- Produces:

```typescript
export interface ShellBriefState {
  title: string;
  context: string;
  status: string;
  objective: string;
  lossNote: string;
  nextGrowth: string;
  selectedId: string;
  activeTool: string;
}

export function formatObjective(
  objectives: ObjectiveThresholds,
): string;
```

- [ ] **Step 1: Add the failing Brief selector matrix**

In `runtimeSelectors.test.ts`, add:

```typescript
describe("selectShellState Brief", () => {
  const thresholds = {
    maxLateRatio: 0.25,
    maxUnservedRatio: 0.2,
    maxAverageWait: 180,
    rollingWindowSeconds: 300,
    survivalTime: 1_200,
  };

  it.each([
    {
      name: "standard sandbox",
      rules: {
        gameMode: "sandbox" as const,
        economyPreset: "standard" as const,
      },
      objectives: null,
      title: "Standard Sandbox",
      context: "Template · Growing Suburb",
      objective: "Open-ended city — no campaign objective.",
      lossNote: "Metrics continue without win/loss.",
    },
    {
      name: "creative sandbox",
      rules: {
        gameMode: "sandbox" as const,
        economyPreset: "creative" as const,
      },
      objectives: thresholds,
      title: "Creative Sandbox",
      context: "Template · Growing Suburb",
      objective: "Open-ended city — no campaign objective.",
      lossNote: "Metrics continue without win/loss.",
    },
    {
      name: "campaign with objectives",
      rules: {
        gameMode: "campaign" as const,
        economyPreset: "standard" as const,
      },
      objectives: thresholds,
      title: "Growing Suburb",
      context: "Campaign · Growing Suburb",
      objective:
        "Hold late trips below 25%, unserved below 20%, average wait under 180s.",
      lossNote: "Within tolerances. Hold the line.",
    },
    {
      name: "campaign without objectives",
      rules: {
        gameMode: "campaign" as const,
        economyPreset: "creative" as const,
      },
      objectives: null,
      title: "Growing Suburb",
      context: "Campaign · Growing Suburb",
      objective: "No campaign objective.",
      lossNote: "Metrics continue without win/loss.",
    },
  ])("renders $name", (entry) => {
    const state = createTestGameState({
      rules: {
        ...createTestGameState().rules,
        gameMode: entry.rules.gameMode,
        economyPreset: entry.rules.economyPreset,
      },
      scenario: {
        name: "Growing Suburb",
        objectives: entry.objectives,
        growthWaves: [],
      },
    });

    expect(selectShellState(state, createUiState()).brief).toMatchObject({
      title: entry.title,
      context: entry.context,
      objective: entry.objective,
      lossNote: entry.lossNote,
      nextGrowth: "No automatic growth",
    });
  });

it("uses campaign wave copy and preserves a Rust loss reason", () => {
  const base = createTestGameState();
  const state = createTestGameState({
    rules: {
      ...base.rules,
      gameMode: "campaign",
      economyPreset: "creative",
    },
    metrics: {
      ...base.metrics,
      state: "lost",
      lossReason: "Existing campaign loss",
    },
    scenario: {
      name: "Authored Campaign",
      objectives: thresholds,
      growthWaves: [
        {
          id: "wave-1",
          triggerTime: 60,
          message: "New residents arrive soon.",
          applied: false,
          actions: [],
        },
      ],
    },
  });

  expect(selectShellState(state, createUiState()).brief).toMatchObject({
    title: "Authored Campaign",
    context: "Campaign · Growing Suburb",
    lossNote: "Existing campaign loss",
    nextGrowth: "New residents arrive soon.",
  });
});

it("ignores sandbox-attached objectives and waves", () => {
  const state = createTestGameState({
    scenario: {
      name: "Growing Suburb",
      objectives: thresholds,
      growthWaves: [
        {
          id: "inert-wave",
          triggerTime: 0,
          message: "Must not render",
          applied: false,
          actions: [],
        },
      ],
    },
  });

  expect(selectShellState(state, createUiState()).brief).toMatchObject({
    title: "Standard Sandbox",
    objective: "Open-ended city — no campaign objective.",
    nextGrowth: "No automatic growth",
  });
});
});
```

- [ ] **Step 2: Run selector tests and verify red**

Run:

```bash
bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
```

Expected: current selectors dereference nullable objectives, use the scenario
name for sandbox, and emit the old sandbox growth fallback.

- [ ] **Step 3: Implement display-ready Brief selection**

Import `ObjectiveThresholds` and `SandboxTemplateId`, then add:

```typescript
const SANDBOX_TEMPLATE_LABELS: Record<SandboxTemplateId, string> = {
  growingSuburb: "Growing Suburb",
};

export function formatObjective(
  objectives: ObjectiveThresholds,
): string {
  return `Hold late trips below ${Math.round(objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
    objectives.maxUnservedRatio * 100,
  )}%, average wait under ${objectives.maxAverageWait}s.`;
}
```

Before returning `ShellState`, derive:

```typescript
const templateLabel =
  SANDBOX_TEMPLATE_LABELS[state.rules.sandbox.templateId];
const isCampaign = state.rules.gameMode === "campaign";
const campaignObjectives = isCampaign
  ? state.scenario.objectives
  : null;
const defaultLossNote =
  campaignObjectives === null
    ? "Metrics continue without win/loss."
    : "Within tolerances. Hold the line.";
const pendingCampaignWave = isCampaign
  ? state.scenario.growthWaves.find((wave) => !wave.applied)
  : undefined;
```

Construct `brief` with:

```typescript
title: isCampaign
  ? state.scenario.name
  : state.rules.economyPreset === "creative"
    ? "Creative Sandbox"
    : "Standard Sandbox",
context: isCampaign
  ? `Campaign · ${templateLabel}`
  : `Template · ${templateLabel}`,
status: state.metrics.state.toUpperCase(),
objective: isCampaign
  ? campaignObjectives === null
    ? "No campaign objective."
    : formatObjective(campaignObjectives)
  : "Open-ended city — no campaign objective.",
lossNote: state.metrics.lossReason ?? defaultLossNote,
nextGrowth: pendingCampaignWave?.message ?? "No automatic growth",
```

Keep `selectedId` and `activeTool` unchanged.

- [ ] **Step 4: Render the selector-owned context**

Add `context: string` to `ShellBriefState`. In `BriefPanel.svelte`, replace:

```svelte
<p class="brief-id">Scenario · 001</p>
```

with:

```svelte
<p class="brief-id">{shell.context}</p>
```

Do not branch on rules or objectives in Svelte.

- [ ] **Step 5: Update component and app-shell tests**

Add `context: "Template · Growing Suburb"` to the `ShellBriefState` fixture in
`hudPanels.test.ts`, then assert the Brief panel renders it.

In `appShell.test.ts`, replace the old default expectations with:

```typescript
expect(screen.getByText("Standard Sandbox")).toBeVisible();
expect(screen.getByText("Template · Growing Suburb")).toBeVisible();
expect(
  screen.getByText("Open-ended city — no campaign objective."),
).toBeVisible();
expect(
  screen.getByText("Metrics continue without win/loss."),
).toBeVisible();
expect(screen.getByText("No automatic growth")).toBeVisible();
```

Remove the assertion for `Sandbox: paint areas to grow.`.

- [ ] **Step 6: Run selector and UI checks**

Run:

```bash
bunx vitest run --project runtime tests/runtime/runtimeSelectors.test.ts
bunx vitest run --project ui tests/ui/hudPanels.test.ts tests/ui/appShell.test.ts
bun run check
bun run lint
```

Expected: all four Brief modes match the agreed mapping, Svelte renders the
provided context, and sandbox content stays inert in presentation.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/runtimeSelectors.ts src/runtime/types.ts src/components/hud/panels/BriefPanel.svelte tests/runtime/runtimeSelectors.test.ts tests/ui/hudPanels.test.ts tests/ui/appShell.test.ts
git commit -m "feat(ui): present sandbox and campaign Brief states"
```

---

### Task 6: Architecture Documentation and Full Verification

**Files:**
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: completed Rust and TypeScript behavior from Tasks 1–5.
- Produces: one current architecture description and a fully verified branch.

- [ ] **Step 1: Update the architecture contract**

Replace the schema-v2 runtime-boundary paragraph with:

```markdown
The host contract is `SNAPSHOT_SCHEMA_VERSION = 3`. Every snapshot carries
required Rust-owned `GameRules` plus a required `ScenarioConfig`; objectives
are explicitly an object or absent campaign content (`null` in JSON and
normalized from WASM `undefined`). Loading is strict: schema-v2 or malformed
schema-v3 snapshots are rejected rather than heuristically migrated.
```

Update the Growing Suburb paragraph to state:

```markdown
The fresh Growing Suburb game is Standard Sandbox: `growingSuburb`, demand
multiplier `1.0`, paused move-in, no campaign objectives, and no growth waves.
Sandbox ticks continue trips and metrics but never newly win, lose, or apply
authored growth. Explicit campaign snapshots may independently attach
objective thresholds and ordered growth waves; Rust evaluates and applies
those features only in campaign mode.
```

Document that serialized campaign thresholds are authoritative and that an
invalid rolling window falls back to the deterministic 300-second constant
for both retention and scoring.

- [ ] **Step 2: Scan for stale schema and sandbox copy**

Run:

```bash
rg -n "schema-v2|schemaVersion: 2|schema_version, 2|Sandbox: paint areas to grow|Scenario · 001" crates src src-tauri tests docs/architecture.md --glob '!src/generated/**'
```

Expected: no HPA-337-owned stale schema/copy references. Inspect any match
whose wording deliberately describes rejection of schema 2 rather than
blindly replacing it.

- [ ] **Step 3: Run all repository gates**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run format:check
bun run check
bun run lint
bun run test
bun run build
bun run test:e2e
```

Expected: every command exits zero. The Bun pre-hooks rebuild the WASM
artifact from the changed Rust core before TypeScript test/build gates.

- [ ] **Step 4: Review the final diff against the design**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Verify all acceptance points directly:

- Fresh Rust/WASM/Tauri/TypeScript snapshot is schema 3 Standard Sandbox.
- Required nullable objectives distinguish null/present undefined from
  omission.
- Sandbox stays running and keeps bounded metrics.
- Campaign uses serialized thresholds and sanitized rolling windows.
- Growth is campaign-only and independent from objectives.
- Brief copy matches the four-row selector matrix.
- No creative-cost, new-template, persistence, or move-in behavior leaked into
  this slice.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/architecture.md
git commit -m "docs: document sandbox and campaign rules"
```

- [ ] **Step 6: Verify the committed branch is clean**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: no worktree changes and one focused commit for each implementation
unit plus this documentation commit.
