use caelum_core::model::{EconomyPreset, GameSnapshot, Point, RoundaboutSize};
use caelum_core::roundabouts::roundabout_cost;
use caelum_core::transit::ROAD_COST;
use caelum_core::{GameEngine, GameIntent, RejectionCode};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn engine_for(snapshot: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).expect("fixture snapshot should be valid")
}

fn assert_world_equal_ignoring_cost_policy(standard: &GameSnapshot, creative: &GameSnapshot) {
    let mut normalized = creative.clone();
    normalized.rules.economy_preset = standard.rules.economy_preset;
    normalized.budget = standard.budget;
    assert_eq!(standard, &normalized);
}

#[test]
fn low_budget_single_road_rejects_standard_and_applies_creative_without_deduction() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, ROAD_COST - 1);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, ROAD_COST - 1);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();

    let standard_result = standard.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    let creative_result = creative.dispatch(GameIntent::LayRoad { point: point(2, 2) });

    assert!(!standard_result.applied);
    let rejection = standard_result
        .rejection
        .expect("standard budget rejection");
    assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
    assert_eq!(rejection.context.required_budget, Some(ROAD_COST));
    assert_eq!(rejection.context.available_budget, Some(ROAD_COST - 1));
    assert_eq!(standard.snapshot(), standard_before);

    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(creative_result.context.cost, ROAD_COST);
    assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    assert_eq!(creative.snapshot(), creative_result.snapshot);
}

#[test]
fn funded_single_road_has_world_parity_and_equal_nominal_cost() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, ROAD_COST);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, ROAD_COST);

    let standard_result = standard.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    let creative_result = creative.dispatch(GameIntent::LayRoad { point: point(2, 2) });

    assert!(standard_result.applied, "{standard_result:?}");
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(standard_result.context.cost, ROAD_COST);
    assert_eq!(creative_result.context.cost, ROAD_COST);
    assert_eq!(standard_result.snapshot.budget, 0);
    assert_eq!(creative_result.snapshot.budget, ROAD_COST);
    assert_world_equal_ignoring_cost_policy(&standard_result.snapshot, &creative_result.snapshot);
}

#[test]
fn low_budget_roundabouts_reject_standard_and_apply_creative_without_deduction() {
    let prepared = GameEngine::new().snapshot();
    for (origin, size) in [
        (point(5, 5), RoundaboutSize::Compact2x2),
        (point(9, 8), RoundaboutSize::Standard3x3),
    ] {
        let cost = roundabout_cost(size);
        let mut standard = engine_for(&prepared, EconomyPreset::Standard, cost - 1);
        let mut creative = engine_for(&prepared, EconomyPreset::Creative, cost - 1);
        let standard_before = standard.snapshot();
        let creative_before = creative.snapshot();

        let standard_result = standard.dispatch(GameIntent::PlaceRoundabout { origin, size });
        let creative_result = creative.dispatch(GameIntent::PlaceRoundabout { origin, size });

        assert!(!standard_result.applied, "{standard_result:?}");
        let rejection = standard_result
            .rejection
            .expect("standard budget rejection");
        assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
        assert_eq!(rejection.context.required_budget, Some(cost));
        assert_eq!(rejection.context.available_budget, Some(cost - 1));
        assert_eq!(standard.snapshot(), standard_before);

        assert!(creative_result.applied, "{creative_result:?}");
        assert_eq!(creative_result.context.cost, cost);
        assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    }
}

#[test]
fn funded_roundabouts_have_world_parity_and_equal_nominal_cost() {
    let prepared = GameEngine::new().snapshot();
    for (origin, size) in [
        (point(5, 5), RoundaboutSize::Compact2x2),
        (point(9, 8), RoundaboutSize::Standard3x3),
    ] {
        let cost = roundabout_cost(size);
        let mut standard = engine_for(&prepared, EconomyPreset::Standard, cost);
        let mut creative = engine_for(&prepared, EconomyPreset::Creative, cost);

        let standard_result = standard.dispatch(GameIntent::PlaceRoundabout { origin, size });
        let creative_result = creative.dispatch(GameIntent::PlaceRoundabout { origin, size });

        assert!(standard_result.applied, "{standard_result:?}");
        assert!(creative_result.applied, "{creative_result:?}");
        assert_eq!(standard_result.context.cost, cost);
        assert_eq!(creative_result.context.cost, cost);
        assert_eq!(standard_result.snapshot.budget, 0);
        assert_eq!(creative_result.snapshot.budget, cost);
        assert_world_equal_ignoring_cost_policy(
            &standard_result.snapshot,
            &creative_result.snapshot,
        );
    }
}
