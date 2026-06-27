use caelum_core::{
    buildings::assign_workplaces,
    commute::{shift_template_for_id, worker_profile_for_id},
    model::{PlacedBuilding, Point, Sim, WorkerProfile},
    state::create_initial_snapshot,
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

fn unassigned_worker(id: &str, home: Point) -> Sim {
    Sim {
        id: id.to_string(),
        home: home.clone(),
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: None,
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn destination_on(id: &str, building_type: &str, tiles: Vec<Point>) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: building_type.to_string(),
        origin: tiles[0].clone(),
        rotation: 0,
        occupied_tiles: tiles,
        transit_node_id: None,
    }
}

// Regression: when a worker's home tile is also a valid destination tile (which
// happens after housing is bulldozed and the footprint is rezoned as a
// destination), assign_workplaces must NOT route the worker to their own home —
// a zero-distance commute would complete instantly and inflate served metrics
// without any real travel. Mirrors `src/simulation/buildingSelectors.ts`
// `retargetCitizens`, which filters same-home destinations per citizen.
#[test]
fn assign_workplaces_skips_a_workers_home_tile_when_alternatives_exist() {
    let home = Point { x: 2, y: 3 };
    let other = Point { x: 9, y: 4 };
    let mut state = create_initial_snapshot();
    // Destinations are enumerated in building order, so `home` is index 0:
    // without the home filter, round-robin would assign the first worker home.
    state.buildings = vec![
        destination_on("building-001", "supermarket", vec![home.clone()]),
        destination_on("building-002", "factory", vec![other.clone()]),
    ];
    state.sims = vec![unassigned_worker("sim-001", home.clone())];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(other));
}

// Degenerate contract: when the worker's home is the ONLY remaining destination,
// assign_workplaces must still assign it (rather than leaving the worker
// unemployed), matching the TS fallback (`eligible.length > 0 ? eligible :
// destinations`).
#[test]
fn assign_workplaces_falls_back_to_home_when_home_is_the_only_destination() {
    let home = Point { x: 2, y: 3 };
    let mut state = create_initial_snapshot();
    state.buildings = vec![destination_on(
        "building-001",
        "supermarket",
        vec![home.clone()],
    )];
    state.sims = vec![unassigned_worker("sim-001", home.clone())];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(home));
}
