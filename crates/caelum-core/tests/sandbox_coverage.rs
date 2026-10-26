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
//! - **`sandbox_reset_error_from_creation_error`**: private helper
//!   only invoked from `sandbox_candidate_from_persisted_rules`'s `.map_err`
//!   when `create_sandbox_candidate` returns `Err`. That candidate builder is
//!   fed a request reconstructed from already-validated `GameRules` fields
//!   (typed enums + `StartingCapital`/`DemandMultiplier` newtypes whose
//!   constructors reject invalid values), so `validate_request` always
//!   succeeds and the canonical template map always compiles/validates. There
//!   is no public path that produces a creation error from persisted rules, so
//!   both the `None` and `Some(error.code)` arms are
//!   unreachable.
//! - **`map.tile(point)` else arm** in the private
//!   `validate_crossroads_candidate`, which is only called
//!   from `create_sandbox_candidate` with a freshly built 28x18 map. The four
//!   footprint points (14,8)/(14,9)/(15,8)/(15,9) always exist in that map, so
//!   `map.tile(...)` always yields `Some`. Not callable from integration tests
//!   (private function) and not triggerable via the public factory.
//! - **`BlankGrid` and `SmallTown` arms** (`"blankGrid"` / `"smallTown"`) of
//!   `template_invariant_error`: only reached when fixed developer-authored
//!   construction fails. A blank grid has no road structures, so
//!   `compile_structure_transitions` returns `Ok(empty)` and compile succeeds;
//!   the `?` on the topology compile never propagates an error. Small Town
//!   construction is likewise fixed and succeeds for every public valid request.
//! - **`StartingCapital::new(value as i32).map_err(...)` closure** in
//!   `parse_starting_capital`: the value has already been gated to be finite,
//!   `>= 0.0`, integral, and `<= i32::MAX`, so
//!   `value as i32` is always a non-negative i32 that `StartingCapital::new`
//!   accepts. The closure can never run.
//! - **`_ => unreachable!()` arm** in the in-crate `tests` module: a
//!   defensive match arm in an existing unit test; covering it would require
//!   panicking, which the task forbids.
//!
//! The tests below lock in the reachable behavior adjacent to those defensive
//! paths so regressions that *would* make them reachable are caught.

use caelum_core::model::Point;
use caelum_core::{
    create_sandbox_snapshot, validate_request, GameEngine, GameIntent, SandboxCreationErrorCode,
    SandboxCreationRequest,
};

fn request(template_id: &str, starting_capital: f64) -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: template_id.to_string(),
        map_size: "small".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(starting_capital),
        demand_multiplier: Some(1.0),
    }
}

/// The reachable happy path through `sandbox_candidate_from_persisted_rules`
/// (used by `GameEngine::reset`): persisted sandbox rules reconstruct a
/// candidate identical to the original factory snapshot, for all templates.
/// This is the reachable path that *would* feed
/// `sandbox_reset_error_from_creation_error` if the
/// reconstruction could ever fail — it cannot for valid rules.
#[test]
fn reset_replays_validated_rules_for_all_templates_without_entering_error_mapper() {
    for template in ["blankGrid", "crossroads", "smallTown"] {
        let req = request(template, 42_000.0);
        let expected = create_sandbox_snapshot(req.clone()).unwrap();
        let mut engine = GameEngine::from_sandbox_request(req).unwrap();

        // Mutate engine state so reset has something to undo.
        engine.set_budget_for_test(7);
        let _ = engine.dispatch(GameIntent::LayRoad {
            point: Point { x: 3, y: 3 },
        });

        engine.reset().unwrap();
        assert_eq!(engine.snapshot(), expected);
    }
}

/// The reachable path through `parse_starting_capital` at the upper boundary:
/// `i32::MAX` passes the finiteness and range gate and is accepted by
/// `StartingCapital::new`, so the `.map_err` closure is never entered. Locks
/// in that the boundary value is valid end-to-end.
#[test]
fn validate_request_accepts_starting_capital_at_i32_max_boundary() {
    let validated = validate_request(request("blankGrid", f64::from(i32::MAX))).unwrap();
    assert_eq!(validated.starting_capital.value(), i32::MAX);
}

/// The reachable path through `create_sandbox_candidate` for the blank grid:
/// `RoadTopology::compile` succeeds, so
/// `template_invariant_error(BlankGrid)` is never invoked.
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
/// (hence `sandbox_reset_error_from_creation_error` is unreachable).
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
}

/// `validate_request` accepts a canonical default request end-to-end, covering
/// the reachable success path through every parser (the path the reset
/// reconstruction always takes, so the creation-error mapper stays unreachable).
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
}
