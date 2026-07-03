# Growth Waves in `caelum-core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust core a deterministic growth-wave mechanic — timed scenario intents (zone + place building) applied through the existing engine handlers — plus a grid-derived seed helper, without changing shipped Growing Suburb behavior.

**Architecture:** A `GrowthWave` is a batch of `GrowthAction`s (`PaintAreaRectangle`/`PlaceBuilding`) carried on `ScenarioConfig.growth_waves`. A new `tick_growth` step applies due waves at the top of each tick substep by replaying them through `areas::paint_area_rectangle` / a budget-exempt `buildings::place_building_core`; sims and workplaces then arise via the normal zone→build→spawn coupling. The grid-scaled seed wave is implemented and unit-tested but **not wired** into `growing_suburb_scenario()` (ships `[]`), so the deterministic core suite and golden traces stay untouched.

**Tech Stack:** Rust (`crates/caelum-core`, serde), TypeScript (Svelte 5 shell wire types), Bun + Vitest, cargo test/clippy/fmt.

## Global Constraints

- **Package manager: Bun.** Never npm/yarn. TS tests: `bunx vitest run <path>`.
- **Rust lint is strict:** `cargo clippy --workspace --all-targets -- -D warnings` must pass. Unused vars prefixed `_`.
- **Format gates:** `cargo fmt --all` (Rust) and prettier (TS) must be clean.
- **Wire parity:** all new serialized fields use camelCase (`#[serde(rename_all = "camelCase")]`); enum variants tagged `type` with `rename_all_fields = "camelCase"`, mirroring `intent::GameIntent`.
- **Determinism is a contract:** no `Math.random`/RNG/wall-clock in gameplay code; IDs via `ids::next_entity_id`; fixed action order.
- **Immutable state:** sim/handler functions return new `GameSnapshot`s; never mutate in place except the localized `apply_due_growth_waves(&mut …)` which threads snapshots via the existing handlers.
- **`tests/` mirrors `src/`**; Rust integration tests live in `crates/caelum-core/tests/`, unit tests in `#[cfg(test)] mod tests` within the source file.
- **Scope:** the seed wave is NOT wired into `growing_suburb_scenario()`; it must continue to ship `growth_waves: vec![]`.

---

### Task 1: Rust model — `GrowthWave` / `GrowthAction` + `ScenarioConfig.growth_waves` (ships empty)

**Files:**
- Modify: `crates/caelum-core/src/model.rs` (add types after `ScenarioConfig`; add field to `ScenarioConfig` ~line 97; update `scenario` doc comment ~lines 74-79)
- Modify: `crates/caelum-core/src/scenario.rs:18` (add `growth_waves` to the `ScenarioConfig` literal)
- Test: `crates/caelum-core/tests/model_wire_format.rs`

**Interfaces:**
- Produces: `caelum_core::model::GrowthWave { id: String, trigger_time: f64, message: String, applied: bool, actions: Vec<GrowthAction> }`; `caelum_core::model::GrowthAction` enum with variants `PaintAreaRectangle { area: String, start: Point, end: Point }` and `PlaceBuilding { building_type: String, origin: Point, rotation: u16 }`; `ScenarioConfig.growth_waves: Vec<GrowthWave>`.

- [ ] **Step 1: Write the failing wire-format tests**

Append to `crates/caelum-core/tests/model_wire_format.rs`:

```rust
#[test]
fn growth_action_serializes_to_ts_parity_tagged_shape() {
    use caelum_core::model::{GrowthAction, Point};

    let place = GrowthAction::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: Point { x: 2, y: 3 },
        rotation: 0,
    };
    let value = serde_json::to_value(&place).expect("placeBuilding serializes");
    assert_eq!(value["type"], json!("placeBuilding"));
    assert_eq!(value["buildingType"], json!("smallHouse"));
    assert_eq!(value["origin"], json!({ "x": 2, "y": 3 }));
    assert_eq!(value["rotation"], json!(0));
    assert!(
        value.get("building_type").is_none(),
        "must not leak snake_case building_type"
    );

    let paint = GrowthAction::PaintAreaRectangle {
        area: "residential".to_string(),
        start: Point { x: 2, y: 3 },
        end: Point { x: 11, y: 3 },
    };
    let value = serde_json::to_value(&paint).expect("paintAreaRectangle serializes");
    assert_eq!(value["type"], json!("paintAreaRectangle"));
    assert_eq!(value["area"], json!("residential"));
    assert_eq!(value["end"], json!({ "x": 11, "y": 3 }));
}

#[test]
fn shipped_scenario_growth_waves_serialize_to_empty_list() {
    use caelum_core::state::create_initial_snapshot;

    let snapshot = create_initial_snapshot();
    let value = serde_json::to_value(&snapshot.scenario).expect("scenario serializes");
    assert_eq!(value["growthWaves"], json!([]));
}
```

- [ ] **Step 2: Run tests to verify they fail (won't compile)**

Run: `cargo test -p caelum-core --test model_wire_format growth_action_serializes_to_ts_parity_tagged_shape`
Expected: FAIL — `no GrowthAction in caelum_core::model`.

- [ ] **Step 3: Add the model types**

In `crates/caelum-core/src/model.rs`, immediately after the `ScenarioConfig` struct (after line ~100), add:

```rust
/// A batch of scheduled scenario intents applied at `trigger_time` by
/// `crate::growth::apply_due_growth_waves`. `applied` flips to `true` once the
/// wave has fired (idempotent). Serialized as the TS `Scenario.growthWaves` wire
/// shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrowthWave {
    pub id: String,
    pub trigger_time: f64,
    pub message: String,
    pub applied: bool,
    pub actions: Vec<GrowthAction>,
}

/// A single growth mutation. Mirrors the corresponding `intent::GameIntent`
/// variants and their wire spelling so a wave replays the player's own handlers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrowthAction {
    PaintAreaRectangle { area: String, start: Point, end: Point },
    PlaceBuilding { building_type: String, origin: Point, rotation: u16 },
}
```

Then add the field to `ScenarioConfig` (after `pub objectives: ObjectiveThresholds,`):

```rust
    #[serde(default)]
    pub growth_waves: Vec<GrowthWave>,
```

And update the `scenario` field doc comment on `GameSnapshot` (lines ~74-79) — replace the parenthetical `(Growth waves stay a TS-side concept until the core models spawning.)` with:

```rust
    /// `growth_waves` carries scenario-authored growth; entries' `applied` flag
    /// mutates as the tick pipeline fires them (see `crate::growth`).
```

- [ ] **Step 4: Seed the empty list in the scenario constructor**

In `crates/caelum-core/src/scenario.rs`, in `growing_suburb_scenario()` (the `ScenarioConfig { … }` literal at line 18), add as the last field:

```rust
        // Growth waves are implemented and unit-tested (see
        // `growing_suburb_growth_waves`) but intentionally NOT wired here: firing
        // a seed wave on the first tick would perturb the deterministic core
        // suite + golden traces. Wiring the live seed is a deliberate follow-up.
        growth_waves: Vec::new(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p caelum-core --test model_wire_format`
Expected: PASS (new tests + existing `snapshot_scenario_objectives_serialize_to_ts_parity_names` still green).

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/caelum-core/src/model.rs crates/caelum-core/src/scenario.rs crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat(core): add GrowthWave/GrowthAction model and empty scenario.growth_waves"
```

---

### Task 2: Rust — budget-exempt `place_building_core` extraction

**Files:**
- Modify: `crates/caelum-core/src/buildings.rs:128-224` (`place_building`)
- Test: `crates/caelum-core/tests/areas_buildings.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `caelum_core::buildings::place_building_core(state: &GameSnapshot, building_type: &str, origin: &Point, rotation: u16) -> Result<GameSnapshot, String>` — identical to `place_building` but does **not** check or deduct budget. `place_building` keeps its exact public behavior (checks budget, deducts cost).

- [ ] **Step 1: Write the failing test**

Append to `crates/caelum-core/tests/areas_buildings.rs`:

```rust
#[test]
fn place_building_core_is_budget_exempt_but_place_building_charges() {
    use caelum_core::model::Point;
    use caelum_core::state::create_initial_snapshot;
    use caelum_core::{areas, buildings};

    let base = create_initial_snapshot();
    let zoned = areas::paint_area_rectangle(
        &base,
        "residential",
        &Point { x: 2, y: 3 },
        &Point { x: 3, y: 3 },
    )
    .expect("residential zone applied");
    let budget = zoned.budget;

    let core = buildings::place_building_core(&zoned, "smallHouse", &Point { x: 2, y: 3 }, 0)
        .expect("core placement succeeds");
    assert_eq!(core.budget, budget, "world growth must not charge the player");
    assert_eq!(core.buildings.len(), 1);
    assert_eq!(core.sims.len(), 4);

    let charged = buildings::place_building(&zoned, "smallHouse", &Point { x: 2, y: 3 }, 0)
        .expect("player placement succeeds");
    assert_eq!(charged.budget, budget - 4_000, "player placement deducts cost");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p caelum-core --test areas_buildings place_building_core_is_budget_exempt_but_place_building_charges`
Expected: FAIL — `no function place_building_core`.

- [ ] **Step 3: Extract the core**

In `crates/caelum-core/src/buildings.rs`:

1. Rename the existing `pub fn place_building(` (line 128) to `pub fn place_building_core(`.
2. Inside it, DELETE the budget-check block:

```rust
    if state.budget < definition.cost {
        return Err("insufficient budget".to_string());
    }
```

and DELETE the deduction line:

```rust
    next.budget -= definition.cost;
```

3. Add the thin wrapper immediately ABOVE `place_building_core`:

```rust
pub fn place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> Result<GameSnapshot, String> {
    let definition = building_definition(building_type)
        .ok_or_else(|| format!("unknown building: {building_type}"))?;
    if state.budget < definition.cost {
        return Err("insufficient budget".to_string());
    }
    let mut next = place_building_core(state, building_type, origin, rotation)?;
    next.budget -= definition.cost;
    Ok(next)
}
```

(`place_building_core` still binds `let definition = …` for `definition.effect` / `definition.citizen_count`; it no longer references `definition.cost`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p caelum-core --test areas_buildings`
Expected: PASS. Also run `cargo test -p caelum-core --test golden_sequences` — the `budget == 108_000` assertion must still hold (proves `place_building` behavior is unchanged).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/caelum-core/src/buildings.rs crates/caelum-core/tests/areas_buildings.rs
git commit -m "refactor(core): extract budget-exempt place_building_core"
```

---

### Task 3: Rust — grid-derived seed helper `growing_suburb_growth_waves()` (unwired)

**Files:**
- Modify: `crates/caelum-core/src/scenario.rs` (imports; add constants + helper; add `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `GrowthWave`/`GrowthAction`/`Point` from Task 1.
- Produces: `caelum_core::scenario::growing_suburb_growth_waves() -> Vec<GrowthWave>` (one seed wave); `pub const GRID_CELLS_PER_HOUSING_UNIT: i32`.

- [ ] **Step 1: Write the failing tests**

At the bottom of `crates/caelum-core/src/scenario.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::GrowthAction;

    #[test]
    fn seed_wave_unit_count_scales_with_grid() {
        let grid = i32::from(MAP_WIDTH) * i32::from(MAP_HEIGHT);
        let expected = (grid / GRID_CELLS_PER_HOUSING_UNIT).max(1);
        assert_eq!(expected, 5, "28*18/100 == 5 units on the shipped map");

        let waves = growing_suburb_growth_waves();
        assert_eq!(waves.len(), 1);
        let placements = waves[0]
            .actions
            .iter()
            .filter(|action| matches!(action, GrowthAction::PlaceBuilding { .. }))
            .count();
        assert_eq!(placements as i32, expected);
    }

    #[test]
    fn seed_wave_is_well_formed_and_clear_of_the_arterial() {
        let waves = growing_suburb_growth_waves();
        let wave = &waves[0];
        assert_eq!(wave.id, "wave-seed-residential");
        assert_eq!(wave.trigger_time, 0.0);
        assert!(!wave.applied);

        match &wave.actions[0] {
            GrowthAction::PaintAreaRectangle { area, .. } => assert_eq!(area, "residential"),
            other => panic!("first action must be the zoning paint, got {other:?}"),
        }
        for action in &wave.actions[1..] {
            let GrowthAction::PlaceBuilding { building_type, origin, .. } = action else {
                panic!("expected a building placement, got {action:?}");
            };
            assert_eq!(building_type, "smallHouse");
            // On-map and west/north of the arterial cross (x in {14,15}, y in {8,9}).
            assert!(origin.x >= 0 && origin.x + 1 < 14, "footprint west of x=14");
            assert!(origin.y >= 0 && origin.y < i32::from(MAP_HEIGHT));
            assert_ne!(origin.y, 8);
            assert_ne!(origin.y, 9);
        }
    }

    #[test]
    fn shipped_scenario_ships_no_waves() {
        assert!(growing_suburb_scenario().growth_waves.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p caelum-core --lib scenario::tests`
Expected: FAIL — `no function growing_suburb_growth_waves` / `no GRID_CELLS_PER_HOUSING_UNIT`.

- [ ] **Step 3: Add imports, constants, and the helper**

In `crates/caelum-core/src/scenario.rs`, extend the model import to include the new types and `Point`:

```rust
use crate::model::{GameMap, GrowthAction, GrowthWave, ObjectiveThresholds, Point, ScenarioConfig, Tile};
```

Add near the other `pub const`s (after `SCENARIO_NAME`):

```rust
/// One seed housing unit is authored per this many grid cells (tunable). For the
/// shipped 28×18 map this yields `504 / 100 = 5` `smallHouse` units.
pub const GRID_CELLS_PER_HOUSING_UNIT: i32 = 100;

const SEED_ANCHOR_X: i32 = 2;
const SEED_ANCHOR_Y: i32 = 3;
const SEED_UNITS_PER_ROW: i32 = 6;
```

Add the helper (below `growing_suburb_scenario`):

```rust
/// Grid-derived seed wave: authors `max(1, grid / GRID_CELLS_PER_HOUSING_UNIT)`
/// `smallHouse` units packed row-major from a fixed anchor west of the arterial
/// cross, zoning their bounding rectangle residential first (zone precedes build).
///
/// Pure and deterministic. NOTE: not wired into `growing_suburb_scenario()` — see
/// the comment there. Validated by unit tests; ready to wire in a follow-up.
pub fn growing_suburb_growth_waves() -> Vec<GrowthWave> {
    // `smallHouse` footprint (see building_catalog): 2 wide, 1 tall.
    const UNIT_WIDTH: i32 = 2;
    const UNIT_HEIGHT: i32 = 1;

    let grid = i32::from(MAP_WIDTH) * i32::from(MAP_HEIGHT);
    let n_units = (grid / GRID_CELLS_PER_HOUSING_UNIT).max(1);

    let origins: Vec<Point> = (0..n_units)
        .map(|k| Point {
            x: SEED_ANCHOR_X + (k % SEED_UNITS_PER_ROW) * UNIT_WIDTH,
            y: SEED_ANCHOR_Y + (k / SEED_UNITS_PER_ROW) * UNIT_HEIGHT,
        })
        .collect();

    let max_x = origins
        .iter()
        .map(|p| p.x + UNIT_WIDTH - 1)
        .max()
        .unwrap_or(SEED_ANCHOR_X);
    let max_y = origins
        .iter()
        .map(|p| p.y + UNIT_HEIGHT - 1)
        .max()
        .unwrap_or(SEED_ANCHOR_Y);

    let mut actions = Vec::with_capacity(origins.len() + 1);
    actions.push(GrowthAction::PaintAreaRectangle {
        area: "residential".to_string(),
        start: Point { x: SEED_ANCHOR_X, y: SEED_ANCHOR_Y },
        end: Point { x: max_x, y: max_y },
    });
    for origin in origins {
        actions.push(GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin,
            rotation: 0,
        });
    }

    vec![GrowthWave {
        id: "wave-seed-residential".to_string(),
        trigger_time: 0.0,
        message: "First residents arrive — build destinations so they can commute."
            .to_string(),
        applied: false,
        actions,
    }]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p caelum-core --lib scenario::tests`
Expected: PASS (all three).

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/caelum-core/src/scenario.rs
git commit -m "feat(core): add grid-derived growing_suburb_growth_waves seed helper (unwired)"
```

---

### Task 4: Rust — `growth.rs` `apply_due_growth_waves` + tick-pipeline wiring

**Files:**
- Create: `crates/caelum-core/src/growth.rs`
- Modify: `crates/caelum-core/src/lib.rs:18-34` (register module)
- Modify: `crates/caelum-core/src/trips.rs` (substep loop ~74-95 and final flush ~111-112; `max_tick_substeps` ~154-158; `next_boundary_after` ~466-472)

**Interfaces:**
- Consumes: `GrowthAction` (Task 1), `buildings::place_building_core` (Task 2), `growing_suburb_growth_waves` (Task 3), `areas::paint_area_rectangle`, `trips::tick_trips`.
- Produces: `caelum_core::growth::apply_due_growth_waves(state: &mut GameSnapshot)`.

- [ ] **Step 1: Create `growth.rs` with the function and failing tests**

Create `crates/caelum-core/src/growth.rs`:

```rust
use crate::areas;
use crate::buildings;
use crate::model::{GameSnapshot, GrowthAction};

/// Apply every growth wave whose `trigger_time` has arrived, in declared order,
/// by replaying its actions through the engine's own handlers. Placements are
/// budget-exempt (`place_building_core`): a wave is the world growing, not the
/// player spending. Idempotent via each wave's `applied` flag. A wave whose
/// action is invalid at fire time (e.g. an unzoned placement) skips that action
/// deterministically, exactly as a player's invalid click is a no-op.
pub fn apply_due_growth_waves(state: &mut GameSnapshot) {
    let due: Vec<usize> = state
        .scenario
        .growth_waves
        .iter()
        .enumerate()
        .filter(|(_, wave)| !wave.applied && wave.trigger_time <= state.time)
        .map(|(index, _)| index)
        .collect();
    if due.is_empty() {
        return;
    }

    for index in due {
        let actions = state.scenario.growth_waves[index].actions.clone();
        for action in actions {
            match action {
                GrowthAction::PaintAreaRectangle { area, start, end } => {
                    if let Some(next) = areas::paint_area_rectangle(state, &area, &start, &end) {
                        *state = next;
                    }
                }
                GrowthAction::PlaceBuilding {
                    building_type,
                    origin,
                    rotation,
                } => {
                    if let Ok(next) =
                        buildings::place_building_core(state, &building_type, &origin, rotation)
                    {
                        *state = next;
                    }
                }
            }
        }
        state.scenario.growth_waves[index].applied = true;
    }
}

#[cfg(test)]
mod tests {
    use crate::model::{GameSnapshot, GrowthAction, GrowthWave, Point};
    use crate::scenario::growing_suburb_growth_waves;
    use crate::state::create_initial_snapshot;
    use crate::trips;

    fn seeded() -> GameSnapshot {
        let mut state = create_initial_snapshot();
        state.paused = false;
        state.scenario.growth_waves = growing_suburb_growth_waves();
        state
    }

    #[test]
    fn seed_wave_zones_places_houses_and_spawns_sims() {
        let start = seeded();
        let budget_before = start.budget;
        let next = trips::tick_trips(&start, 1.0);

        assert_eq!(next.buildings.len(), 5, "5 smallHouse units placed");
        assert_eq!(next.sims.len(), 20, "5 units * 4 citizens");
        assert!(next.scenario.growth_waves[0].applied);
        assert_eq!(next.budget, budget_before, "budget-exempt world growth");
        assert_eq!(next.sims[0].id, "sim-001");
        assert_eq!(next.sims[19].id, "sim-020");

        let anchor = next
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 2 && tile.y == 3)
            .expect("anchor tile exists");
        assert_eq!(anchor.area.as_deref(), Some("residential"));
    }

    #[test]
    fn application_is_idempotent() {
        let once = trips::tick_trips(&seeded(), 1.0);
        let twice = trips::tick_trips(&once, 1.0);
        assert_eq!(twice.buildings.len(), once.buildings.len());
        assert_eq!(twice.sims.len(), once.sims.len());
    }

    #[test]
    fn empty_growth_waves_is_a_noop() {
        let mut start = create_initial_snapshot();
        start.paused = false;
        let next = trips::tick_trips(&start, 1.0);
        assert!(next.buildings.is_empty());
        assert!(next.sims.is_empty());
    }

    #[test]
    fn coarse_and_fine_ticks_produce_identical_growth() {
        let start = seeded();
        let coarse = trips::tick_trips(&start, 5.0);
        let mut fine = start.clone();
        for _ in 0..5 {
            fine = trips::tick_trips(&fine, 1.0);
        }
        assert_eq!(coarse.buildings, fine.buildings);
        assert_eq!(coarse.sims, fine.sims);
        assert_eq!(coarse.map, fine.map);
    }

    #[test]
    fn placement_without_zoning_is_skipped_but_wave_marked_applied() {
        let mut start = create_initial_snapshot();
        start.paused = false;
        start.scenario.growth_waves = vec![GrowthWave {
            id: "w".to_string(),
            trigger_time: 0.0,
            message: String::new(),
            applied: false,
            actions: vec![GrowthAction::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: Point { x: 2, y: 3 },
                rotation: 0,
            }],
        }];
        let next = trips::tick_trips(&start, 1.0);
        assert!(next.buildings.is_empty(), "unzoned placement skipped");
        assert!(next.scenario.growth_waves[0].applied);
    }
}
```

- [ ] **Step 2: Register the module and run tests to verify they fail**

In `crates/caelum-core/src/lib.rs`, add `pub mod growth;` in module-alphabetical order (between `pub mod engine;` and `pub mod ids;`).

Run: `cargo test -p caelum-core --lib growth::tests`
Expected: FAIL — `seed_wave_zones_places_houses_and_spawns_sims` fails (growth not wired into the tick yet: `next.buildings` is empty).

- [ ] **Step 3: Wire `apply_due_growth_waves` into the substep loop**

In `crates/caelum-core/src/trips.rs`, inside `tick_trips_substepped`'s `for` loop, add the growth call as the first statement after the break check, so the block reads:

```rust
        if final_time - next.time <= EPSILON {
            break;
        }

        crate::growth::apply_due_growth_waves(&mut next);
        reset_daily_commute_flags(&mut next);
        spawn_due_commute_trips(&mut next);
```

And in the final flush block (the `if !early_termination { … }` tail), add the same call before `reset_daily_commute_flags`:

```rust
        crate::growth::apply_due_growth_waves(&mut next);
        reset_daily_commute_flags(&mut next);
        spawn_due_commute_trips(&mut next);
```

- [ ] **Step 4: Add wave trigger times as substep boundaries**

In `max_tick_substeps`, add a growth term to the saturating chain (before the final `.saturating_add(1)`):

```rust
    day_count
        .saturating_mul(events_per_day)
        .saturating_add(per_second_net)
        .saturating_add(vehicle_bound)
        .saturating_add(state.scenario.growth_waves.len())
        .saturating_add(1)
```

In `next_boundary_after`, after the vehicle loop and before the final `next`, add:

```rust
    for wave in &state.scenario.growth_waves {
        if !wave.applied {
            track_next_boundary(&mut next, wave.trigger_time, after);
        }
    }

    next
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p caelum-core --lib growth::tests`
Expected: PASS (all five). Then run the full core suite to confirm no regression from the pipeline edits:
Run: `cargo test -p caelum-core`
Expected: PASS (golden/lifecycle unaffected — shipped `growth_waves` is empty).

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
git add crates/caelum-core/src/growth.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/trips.rs
git commit -m "feat(core): apply due growth waves in the tick pipeline with boundary-exact timing"
```

---

### Task 5: TypeScript — reshape wire types, pass waves through, update consumers & tests

**Files:**
- Modify: `src/domain/types.ts` (reshape `GrowthWave` ~218-224; add `GrowthAction`; remove `GrowthWaveTile` ~205-216)
- Modify: `src/runtime/backend/types.ts:48-51` (add `growthWaves` to `RustScenarioConfig`)
- Modify: `src/runtime/snapshotView.ts:16-29` (pass-through)
- Modify: `src/render/overlayRenderer.ts:372-378` (derive tiles from actions)
- Modify: `src/scenario/growingSuburb.ts:8-10` (TODO comment)
- Modify: `tests/fixtures/rustSnapshot.ts:60-69` (default `growthWaves: []`)
- Modify: `tests/runtime/backendContract.test.ts` (add pass-through case; add `growthWaves` to existing scenario overrides)
- Modify: `tests/render/overlayRenderer.test.ts:695-733` (actions shape)

**Interfaces:**
- Consumes: the Rust wire shape from Tasks 1/4 (`scenario.growthWaves: GrowthWave[]`).
- Produces: TS `GrowthWave { id; triggerTime; message; applied; actions: GrowthAction[] }` and `GrowthAction` union.

- [ ] **Step 1: Reshape the domain types**

In `src/domain/types.ts`, DELETE the `GrowthWaveTile` interface (lines ~205-216) and REPLACE the `GrowthWave` interface with:

```ts
export type GrowthAction =
  | { type: "paintAreaRectangle"; area: AreaKind; start: Point; end: Point }
  | {
      type: "placeBuilding";
      buildingType: BuildingType;
      origin: Point;
      rotation: BuildingRotation;
    };

export interface GrowthWave {
  id: string;
  triggerTime: number;
  message: string;
  applied: boolean;
  actions: GrowthAction[];
}
```

(`AreaKind`, `BuildingType`, `BuildingRotation`, `Point` already exist in this file.)

- [ ] **Step 2: Add `growthWaves` to the Rust scenario wire type**

In `src/runtime/backend/types.ts`, add `GrowthWave` to the existing `import type { … } from "../../domain/types";` list, and add the field to `RustScenarioConfig`:

```ts
export interface RustScenarioConfig {
  name: string;
  objectives: RustObjectiveThresholds;
  growthWaves: GrowthWave[];
}
```

Update its doc comment (lines ~46-47) — replace "Growth waves are NOT included — they remain a TS-side concept until the core models spawning." with "Growth waves ship here too (empty for Growing Suburb); the shell reads them read-only."

- [ ] **Step 3: Pass waves through in `snapshotView.ts`**

Replace the body of `normalizeRustSnapshot` (and drop the stale HPA-118 TODO block) so the `scenario` object reads:

```ts
    scenario: {
      name: snapshot.scenario.name,
      objectives: snapshot.scenario.objectives,
      growthWaves: snapshot.scenario.growthWaves,
    },
```

- [ ] **Step 4: Derive the growth overlay from actions**

In `src/render/overlayRenderer.ts`, replace the growth-wave loop (lines ~372-378) with:

```ts
    for (const wave of state.scenario.growthWaves) {
      if (wave.applied) {
        continue;
      }
      for (const action of wave.actions) {
        if (action.type !== "paintAreaRectangle") {
          continue;
        }
        const minX = Math.min(action.start.x, action.end.x);
        const maxX = Math.max(action.start.x, action.end.x);
        const minY = Math.min(action.start.y, action.end.y);
        const maxY = Math.max(action.start.y, action.end.y);
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            fillTile(ctx, { x, y });
          }
        }
      }
    }
```

- [ ] **Step 5: Update the fixture default + scenario TODO comment**

In `tests/fixtures/rustSnapshot.ts`, add `growthWaves: []` inside the default `scenario` object (after `objectives: { … }`).

In `src/scenario/growingSuburb.ts`, update the `TODO(HPA-118)` comment (lines ~8-10) to:

```ts
// Growth waves now live in `crates/caelum-core` (ScenarioConfig.growth_waves);
// the shell reads `snapshot.scenario.growthWaves` read-only. The Growing Suburb
// seed wave is implemented (`growing_suburb_growth_waves`) but not yet wired.
```

- [ ] **Step 6: Update the backend-contract test**

In `tests/runtime/backendContract.test.ts`: to both existing `scenario:` overrides (the `Growing Suburb` and `Tight Suburb` objects), add `growthWaves: [],`. Update the comment at lines ~68-71 to "Growth waves pass through from the Rust snapshot (empty for the shipped scenario)." Then add a new test inside the `describe` block:

```ts
  it("passes growth waves through from the Rust snapshot", () => {
    const withWave = createRustSnapshot({
      scenario: {
        name: "Growing Suburb",
        objectives: {
          maxLateRatio: 0.25,
          maxUnservedRatio: 0.2,
          maxAverageWait: 180,
          rollingWindowSeconds: 300,
          survivalTime: 1_200,
        },
        growthWaves: [
          {
            id: "wave-1",
            triggerTime: 0,
            message: "grow",
            applied: false,
            actions: [
              {
                type: "paintAreaRectangle",
                area: "residential",
                start: { x: 2, y: 3 },
                end: { x: 3, y: 3 },
              },
              {
                type: "placeBuilding",
                buildingType: "smallHouse",
                origin: { x: 2, y: 3 },
                rotation: 0,
              },
            ],
          },
        ],
      },
    });

    const normalized = normalizeRustSnapshot(withWave);
    expect(normalized.scenario.growthWaves).toEqual(withWave.scenario.growthWaves);
    expect(normalized.scenario.growthWaves[0].actions[1]).toMatchObject({
      type: "placeBuilding",
      buildingType: "smallHouse",
    });
  });
```

- [ ] **Step 7: Update the overlay growth test to the actions shape**

In `tests/render/overlayRenderer.test.ts`, replace the two `growthWaves` entries (lines ~695-733) with:

```ts
        growthWaves: [
          {
            id: "wave-001",
            triggerTime: 100,
            message: "Wave 1",
            applied: false,
            actions: [
              {
                type: "paintAreaRectangle" as const,
                area: "residential" as const,
                start: { x: 5, y: 5 },
                end: { x: 6, y: 5 },
              },
            ],
          },
          {
            id: "wave-002",
            triggerTime: 200,
            message: "Wave 2",
            applied: true,
            actions: [
              {
                type: "paintAreaRectangle" as const,
                area: "commercial" as const,
                start: { x: 7, y: 5 },
                end: { x: 7, y: 5 },
              },
            ],
          },
        ],
```

(The existing assertions — fills `(5,5)` and `(6,5)`, not `(7,5)` — stay unchanged.)

- [ ] **Step 8: Type-check and run tests**

Run: `bun run check`
Expected: PASS (no type errors from the reshape).

Run: `bunx vitest run tests/runtime/backendContract.test.ts tests/render/overlayRenderer.test.ts`
Expected: PASS.

- [ ] **Step 9: Format and commit**

```bash
bunx prettier --write src/domain/types.ts src/runtime/backend/types.ts src/runtime/snapshotView.ts src/render/overlayRenderer.ts src/scenario/growingSuburb.ts tests/fixtures/rustSnapshot.ts tests/runtime/backendContract.test.ts tests/render/overlayRenderer.test.ts
git add src/domain/types.ts src/runtime/backend/types.ts src/runtime/snapshotView.ts src/render/overlayRenderer.ts src/scenario/growingSuburb.ts tests/fixtures/rustSnapshot.ts tests/runtime/backendContract.test.ts tests/render/overlayRenderer.test.ts
git commit -m "feat(shell): read growth waves from the Rust snapshot; reshape wire types to actions"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Rust suite + lint + fmt**

Run: `cargo test --workspace`
Expected: PASS.
Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: no warnings.
Run: `cargo fmt --all --check`
Expected: clean.

- [ ] **Step 2: TS check, lint, unit tests, build**

Run: `bun run check`
Expected: PASS.
Run: `bun run lint`
Expected: PASS.
Run: `bun run test:unit`
Expected: PASS.
Run: `bun run build`
Expected: succeeds.

- [ ] **Step 3: Confirm no runtime behavior change for Growing Suburb**

Run: `cargo test -p caelum-core --lib growth::tests::empty_growth_waves_is_a_noop`
Expected: PASS — proves the shipped (empty) scenario spawns nothing on tick.

---

## Self-Review

**Spec coverage:**
- §1 data model → Task 1. §2 seed helper → Task 3. §3 tick_growth + timing → Task 4 (steps 3-4). §4 apply + budget-exempt core → Tasks 2 & 4. §5 TS shim/consumers → Task 5. §6 testing → Tasks 1-5 tests + Task 6. All acceptance criteria map to tasks.
- "Ships empty / suite untouched" → Task 4 Step 5 full-suite run + Task 6 Step 3 no-op guard.

**Placeholder scan:** No TBD/TODO-as-work; every code step shows complete code; the only in-code `TODO`/`NOTE` comments are intentional documentation of the unwired seed.

**Type consistency:** `growth_waves` (Rust) ↔ `growthWaves` (TS, via serde camelCase); `GrowthAction` variants `PaintAreaRectangle`/`PlaceBuilding` ↔ TS `type: "paintAreaRectangle"|"placeBuilding"`; `building_type`↔`buildingType`; `place_building_core` name identical across Tasks 2 and 4; `growing_suburb_growth_waves` identical across Tasks 3 and 4; `apply_due_growth_waves` signature `(&mut GameSnapshot)` consistent in Task 4 def and trips.rs call sites.
