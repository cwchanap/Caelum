use caelum_core::{
    commute::{shift_template_for_id, worker_profile_for_id},
    model::WorkerProfile,
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
    assert_eq!(
        placed.snapshot.sims[0].worker_profile,
        WorkerProfile::Worker
    );
    assert_eq!(
        placed.snapshot.sims[9].worker_profile,
        WorkerProfile::NonWorker
    );
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
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker && sim.workplace.is_some())
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
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker && sim.workplace.is_some())
        .count();
    assert_eq!(assigned, 9);
}

#[test]
fn shift_templates_use_worker_ordinal_after_non_worker_ids() {
    assert_eq!(worker_profile_for_id("sim-001"), WorkerProfile::Worker);
    assert_eq!(shift_template_for_id("sim-001"), Some("standard"));
    assert_eq!(shift_template_for_id("sim-008"), Some("early"));
    assert_eq!(shift_template_for_id("sim-009"), Some("late"));
    assert_eq!(worker_profile_for_id("sim-010"), WorkerProfile::NonWorker);
    assert_eq!(shift_template_for_id("sim-010"), None);
    assert_eq!(worker_profile_for_id("sim-011"), WorkerProfile::Worker);
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

#[test]
fn place_bus_stop_building_creates_linked_stop() {
    let mut engine = GameEngine::new();

    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busStop".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });

    assert!(placed.applied);
    assert_eq!(placed.snapshot.buildings.len(), 1);
    assert_eq!(placed.snapshot.transit.stops.len(), 1);
    let building = &placed.snapshot.buildings[0];
    let stop = &placed.snapshot.transit.stops[0];
    assert_eq!(building.transit_node_id.as_deref(), Some("stop-001"));
    assert_eq!(stop.id, "stop-001");
    assert_eq!(stop.kind, "busStop");
    assert_eq!(stop.position, building.origin);
    assert_eq!(stop.platforms.len(), 1);
    assert_eq!(stop.platforms[0].id, "stop-001-p0");
}

#[test]
fn place_bus_terminal_building_creates_terminal_stop_platforms() {
    let mut engine = GameEngine::new();

    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });

    assert!(placed.applied);
    assert_eq!(placed.snapshot.buildings.len(), 1);
    assert_eq!(placed.snapshot.transit.stops.len(), 1);
    let building = &placed.snapshot.buildings[0];
    let stop = &placed.snapshot.transit.stops[0];
    assert_eq!(building.transit_node_id.as_deref(), Some("stop-001"));
    assert_eq!(stop.kind, "busTerminal");
    assert_eq!(stop.position, building.origin);
    assert_eq!(stop.platforms.len(), 3);
    assert_eq!(stop.platforms[2].id, "stop-001-p2");
}

#[test]
fn remove_transit_building_removes_linked_stop() {
    let mut engine = GameEngine::new();
    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busStop".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    assert!(placed.applied);

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 3).into(),
    });

    assert!(removed.applied);
    assert!(removed.snapshot.buildings.is_empty());
    assert!(removed.snapshot.transit.stops.is_empty());
}

#[test]
fn place_metro_station_building_requires_track_and_creates_linked_station() {
    let mut engine = GameEngine::new();

    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "metroStation".to_string(),
        origin: (8, 2).into(),
        rotation: 0,
    });
    assert!(!rejected.applied);
    assert_eq!(rejected.rejection.as_deref(), Some("track required"));

    engine.dispatch(GameIntent::LayTrack {
        point: (8, 2).into(),
    });
    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "metroStation".to_string(),
        origin: (8, 2).into(),
        rotation: 0,
    });

    assert!(placed.applied);
    assert_eq!(placed.snapshot.buildings.len(), 1);
    assert_eq!(placed.snapshot.transit.stations.len(), 1);
    let building = &placed.snapshot.buildings[0];
    let station = &placed.snapshot.transit.stations[0];
    assert_eq!(building.transit_node_id.as_deref(), Some("station-001"));
    assert_eq!(station.id, "station-001");
    assert_eq!(station.position, building.origin);
    assert_eq!(station.platforms.len(), 2);
    assert_eq!(station.platforms[1].id, "station-001-p1");
}
