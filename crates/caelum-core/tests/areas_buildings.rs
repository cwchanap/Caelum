use caelum_core::{
    commute::{shift_template_for_id, worker_profile_for_id},
    GameEngine, GameIntent,
};

#[test]
fn paint_area_rectangle_skips_starter_roads() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (13, 8).into(),
        end: (16, 10).into(),
    });

    assert!(result.applied);
    let road = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 14 && tile.y == 8)
        .unwrap();
    assert_eq!(road.kind, "road");
    assert_eq!(road.area, None);

    let empty = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 13 && tile.y == 10)
        .unwrap();
    assert_eq!(empty.area.as_deref(), Some("residential"));
}

#[test]
fn housing_requires_residential_area_and_creates_deterministic_sims() {
    let mut engine = GameEngine::new();

    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    assert!(!rejected.applied);
    assert_eq!(rejected.rejection.as_deref(), Some("area mismatch"));

    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (4, 4).into(),
    });
    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });

    assert!(placed.applied);
    assert_eq!(placed.snapshot.buildings.len(), 1);
    assert_eq!(placed.snapshot.sims.len(), 10);
    assert_eq!(placed.snapshot.sims[0].id, "sim-001");
    assert_eq!(placed.snapshot.sims[0].home.x, 2);
    assert_eq!(placed.snapshot.sims[0].worker_profile, "worker");
    assert_eq!(placed.snapshot.sims[9].worker_profile, "nonWorker");
}

#[test]
fn destination_assigns_workplaces_to_unassigned_workers() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (4, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    let result = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });

    assert!(result.applied);
    let assigned = result
        .snapshot
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == "worker" && sim.workplace.is_some())
        .count();
    assert_eq!(assigned, 9);
}

#[test]
fn destination_placed_before_housing_assigns_new_workers() {
    let mut engine = GameEngine::new();

    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    let destination = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });
    assert!(destination.applied);

    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (4, 4).into(),
    });
    let housing = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });

    assert!(housing.applied);
    let assigned = housing
        .snapshot
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == "worker" && sim.workplace.is_some())
        .count();
    assert_eq!(assigned, 9);
}

#[test]
fn shift_templates_use_worker_ordinal_after_non_worker_ids() {
    assert_eq!(worker_profile_for_id("sim-001"), "worker");
    assert_eq!(shift_template_for_id("sim-001"), Some("standard"));
    assert_eq!(shift_template_for_id("sim-008"), Some("early"));
    assert_eq!(shift_template_for_id("sim-009"), Some("late"));
    assert_eq!(worker_profile_for_id("sim-010"), "nonWorker");
    assert_eq!(shift_template_for_id("sim-010"), None);
    assert_eq!(worker_profile_for_id("sim-011"), "worker");
    assert_eq!(shift_template_for_id("sim-011"), Some("offPeak"));
}

#[test]
fn place_building_rejects_invalid_rotation_without_placing() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (4, 4).into(),
    });

    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 45,
    });

    assert!(!rejected.applied);
    assert_eq!(rejected.rejection.as_deref(), Some("invalid rotation"));
    assert!(rejected.snapshot.buildings.is_empty());
}
