//! Coverage backfill for `crates/caelum-core/src/sandbox.rs`.
//!
//! These tests exercise the *reachable* branches that surround the defensive
//! code paths llvm-cov reported as uncovered. Every reported-uncovered line in
//! `sandbox.rs` is genuinely unreachable defensive code (see the per-line
//! analysis below); none can be hit from the public API without either
//! invoking a private function or constructing an impossible internal state,
//! so this file does **not** attempt to panic on `unreachable!`.
//!
//! Uncovered-line analysis (llvm-cov `DA:...,0`):
//!
//! - **119-137** (`sandbox_reset_error_from_creation_error`): private helper
//!   only invoked from `sandbox_candidate_from_persisted_rules`'s `.map_err`
//!   when `create_sandbox_candidate` returns `Err`. That candidate builder is
//!   fed a request reconstructed from already-validated `GameRules` fields
//!   (typed enums + `StartingCapital`/`DemandMultiplier` newtypes whose
//!   constructors reject invalid values), so `validate_request` always
//!   succeeds and the canonical template map always compiles/validates. There
//!   is no public path that produces a creation error from persisted rules, so
//!   both the `None` (line 125) and `Some(error.code)` (line 127) arms are
//!   unreachable. The only reachable reset failure,
//!   `UnsupportedGameMode`, returns early at line 259 and never enters this
//!   function.
//! - **347** (`let Some(tile) = map.tile(point) else { return Err(fail()); }`):
//!   inside the private `validate_crossroads_candidate`, which is only called
//!   from `create_sandbox_candidate` with a freshly built 28x18 map. The four
//!   footprint points (14,8)/(14,9)/(15,8)/(15,9) always exist in that map, so
//!   `map.tile(...)` always yields `Some`. Not callable from integration tests
//!   (private function) and not triggerable via the public factory.
//! - **475** (`SandboxTemplateId::BlankGrid => "blankGrid"` arm of
//!   `template_invariant_error`): only reached when
//!   `RoadTopology::compile` fails on a blank grid. A blank grid has no road
//!   structures, so `compile_structure_transitions` returns `Ok(empty)` and
//!   compile succeeds; the `?` at line 206 never propagates an error.
//! - **527-530, 532** (`StartingCapital::new(value as i32).map_err(...)`
//!   closure in `parse_starting_capital`): the value has already been gated at
//!   line 518 to be finite, `>= 0.0`, integral, and `<= i32::MAX`, so
//!   `value as i32` is always a non-negative i32 that `StartingCapital::new`
//!   accepts. The closure can never run.
//! - **635** (`_ => unreachable!()` arm in the in-crate `tests` module): a
//!   defensive match arm in an existing unit test; covering it would require
//!   panicking, which the task forbids.
//!
//! The tests below lock in the reachable behavior adjacent to those defensive
//! paths so regressions that *would* make them reachable are caught.

use caelum_core::model::{GameMode, Point};
use caelum_core::{
    create_sandbox_snapshot, validate_request, GameEngine, GameIntent, SandboxCreationErrorCode,
    SandboxCreationRequest, SandboxResetErrorCode,
};

fn request(template_id: &str, starting_capital: f64) -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: template_id.to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(starting_capital),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    }
}

/// The reachable happy path through `sandbox_candidate_from_persisted_rules`
/// (used by `GameEngine::reset`): persisted sandbox rules reconstruct a
/// candidate identical to the original factory snapshot, for both templates.
/// This is the reachable path that *would* feed
/// `sandbox_reset_error_from_creation_error` (lines 119-137) if the
/// reconstruction could ever fail — it cannot for valid rules.
#[test]
fn reset_replays_validated_rules_for_both_templates_without_entering_error_mapper() {
    for template in ["blankGrid", "crossroads"] {
        let req = request(template, 42_000.0);
        let expected = create_sandbox_snapshot(req.clone()).unwrap();
        let mut engine = GameEngine::from_sandbox_request(req).unwrap();

        // Mutate engine state so reset has something to undo.
        engine.set_budget_for_test(7);
        let _ = engine.dispatch(GameIntent::LayRoad {
            point: Point { x: 3, y: 3 },
        });

        let reset = engine.reset().unwrap();
        assert_eq!(reset, expected);
        assert_eq!(engine.snapshot(), expected);
    }
}

/// The only reachable reset failure: a non-sandbox `game_mode` returns
/// `UnsupportedGameMode` early (line 259) and never reaches the
/// `sandbox_reset_error_from_creation_error` mapper (lines 119-137).
#[test]
fn reset_rejects_non_sandbox_mode_via_unsupported_game_mode_early_return() {
    let mut campaign = create_sandbox_snapshot(request("crossroads", 1_000.0)).unwrap();
    campaign.rules.game_mode = GameMode::Campaign;
    let mut engine = GameEngine::from_snapshot(campaign).unwrap();
    let before = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();

    let error = engine.reset().unwrap_err();

    assert_eq!(error.code, SandboxResetErrorCode::UnsupportedGameMode);
    assert_eq!(error.context.game_mode, Some(GameMode::Campaign));
    assert_eq!(error.context.creation_error_code, None);
    assert_eq!(engine.snapshot(), before);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}

/// The reachable path through `parse_starting_capital` at the upper boundary:
/// `i32::MAX` passes the line-518 gate and is accepted by
/// `StartingCapital::new`, so the `.map_err` closure (lines 527-532) is never
/// entered. Locks in that the boundary value is valid end-to-end.
#[test]
fn validate_request_accepts_starting_capital_at_i32_max_boundary() {
    let validated = validate_request(request("blankGrid", f64::from(i32::MAX))).unwrap();
    assert_eq!(validated.starting_capital.value(), i32::MAX);
}

/// The reachable path through `create_sandbox_candidate` for the blank grid:
/// `RoadTopology::compile` succeeds (line 206 Ok), so
/// `template_invariant_error(BlankGrid)` (line 475) is never invoked.
#[test]
fn blank_grid_factory_compiles_topology_without_invoking_template_invariant_error() {
    let snapshot = create_sandbox_snapshot(request("blankGrid", 0.0)).unwrap();
    assert!(snapshot.map.road_structures.is_empty());
    // Compiling the authored blank map must succeed (defensive `?` never fires).
    caelum_core::road_topology::RoadTopology::compile(&snapshot.map).unwrap();
}

/// `validate_request` surfaces typed field-level errors for each invalid
/// field. This exercises the reachable parse-error branches that, in the
/// reset path, are impossible because persisted rules hold validated values
/// (hence lines 119-137 are unreachable).
#[test]
fn validate_request_surfaces_typed_field_errors_for_each_invalid_field() {
    let unknown_template = {
        let mut req = request("blankGrid", 0.0);
        req.template_id = "nope".to_string();
        validate_request(req).unwrap_err()
    };
    assert_eq!(
        unknown_template.code,
        SandboxCreationErrorCode::UnknownTemplateId
    );
    assert_eq!(
        unknown_template.context.field.as_deref(),
        Some("templateId")
    );

    let unknown_economy = {
        let mut req = request("blankGrid", 0.0);
        req.economy_preset = "nope".to_string();
        validate_request(req).unwrap_err()
    };
    assert_eq!(
        unknown_economy.code,
        SandboxCreationErrorCode::UnknownEconomyPreset
    );

    let null_capital = {
        let mut req = request("blankGrid", 0.0);
        req.starting_capital = None;
        validate_request(req).unwrap_err()
    };
    assert_eq!(
        null_capital.code,
        SandboxCreationErrorCode::InvalidStartingCapital
    );
    assert_eq!(
        null_capital.context.attempted_value.as_deref(),
        Some("null")
    );

    let null_demand = {
        let mut req = request("blankGrid", 0.0);
        req.demand_multiplier = None;
        validate_request(req).unwrap_err()
    };
    assert_eq!(
        null_demand.code,
        SandboxCreationErrorCode::InvalidDemandMultiplier
    );
    assert_eq!(null_demand.context.attempted_value.as_deref(), Some("null"));

    let unknown_move_in = {
        let mut req = request("blankGrid", 0.0);
        req.move_in_rate = "nope".to_string();
        validate_request(req).unwrap_err()
    };
    assert_eq!(
        unknown_move_in.code,
        SandboxCreationErrorCode::UnknownMoveInRate
    );
}

/// `validate_request` accepts a canonical default request end-to-end, covering
/// the reachable success path through every parser (the path the reset
/// reconstruction always takes, which is why lines 119-137 stay unreachable).
#[test]
fn validate_request_accepts_canonical_default_request() {
    let validated = validate_request(caelum_core::canonical_default_request()).unwrap();
    assert_eq!(
        validated.template_id,
        caelum_core::model::SandboxTemplateId::Crossroads
    );
    assert_eq!(
        validated.economy_preset,
        caelum_core::model::EconomyPreset::Standard
    );
    assert_eq!(
        validated.move_in_rate,
        caelum_core::model::MoveInRateSelection::Paused
    );
}
