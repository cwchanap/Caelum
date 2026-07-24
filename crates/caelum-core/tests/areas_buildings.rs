use caelum_core::{
    buildings::assign_workplaces,
    commute::{shift_template_for_id, worker_profile_for_id},
    model::{BusStopKind, PlacedBuilding, Point, Sim, WorkerProfile},
    state::create_initial_snapshot,
    GameEngine, GameIntent, RejectionCode,
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
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InvalidBuildingPlacement)
    );

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
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InvalidBuildingPlacement)
    );
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
    assert_eq!(stop.kind, BusStopKind::BusStop);
    assert_eq!(stop.position, building.origin);
    assert_eq!(stop.platforms.len(), 1);
    assert_eq!(stop.platforms[0].id, "stop-001-p0");
}

#[test]
fn place_bus_terminal_building_creates_terminal_stop_platforms() {
    let mut engine = GameEngine::new();

    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(2, 5).into(), (3, 5).into()],
        preset: caelum_core::RoadPreset::TwoWay,
    });
    assert!(road.applied, "{road:?}");

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
    assert_eq!(stop.kind, BusStopKind::BusTerminal);
    assert_eq!(stop.position, building.origin);
    assert_eq!(stop.road_access.unwrap().road_point, (2, 5).into());
    assert_eq!(stop.platforms.len(), 3);
    assert_eq!(stop.platforms[2].id, "stop-001-p2");
}

#[test]
fn place_bus_terminal_without_adjacent_road_is_rejected_for_no_road_access() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 2).into(),
        rotation: 0,
    });

    assert!(!result.applied, "{result:?}");
    assert_eq!(result.rejection.unwrap().code, RejectionCode::NoRoadAccess);
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
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::TrackRequired)
    );

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
        home,
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
        origin: tiles[0],
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
        destination_on("building-001", "supermarket", vec![home]),
        destination_on("building-002", "factory", vec![other]),
    ];
    state.sims = vec![unassigned_worker("sim-001", home)];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(other));
}

// Regression: a referenced bus-stop demolition leaves a Missing tombstone at
// the former building anchor. Missing nodes are non-physical elsewhere, so
// once the road is cleared the empty tile must be zoneable (not skipped while
// other placement paths treat the tombstone as non-physical).
#[test]
fn paint_area_rectangle_zones_missing_transit_node_anchor() {
    let mut engine = GameEngine::new();

    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(4, 4).into(), (5, 4).into(), (6, 4).into()],
        preset: caelum_core::RoadPreset::TwoWay,
    });
    assert!(road.applied, "{road:?}");
    for x in [5, 6] {
        let stop = engine.dispatch(GameIntent::AddBusStop {
            point: (x, 3).into(),
        });
        assert!(stop.applied, "{stop:?}");
    }
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: caelum_core::model::TransitMode::Bus,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".into(), "stop-002".into()],
    });
    assert!(created.applied, "{created:?}");

    // Demolish the stop (tombstone + road remains), then clear the road so the
    // anchor is empty while the Missing node still occupies the position.
    let stop_removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (5, 3).into(),
    });
    assert!(stop_removed.applied, "{stop_removed:?}");
    let road_removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (5, 4).into(),
    });
    assert!(road_removed.applied, "{road_removed:?}");
    let tombstone = road_removed
        .snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-001")
        .expect("referenced stop remains as a tombstone");
    assert_eq!(
        tombstone.status,
        caelum_core::model::TransitNodeStatus::Missing
    );
    assert_eq!(tombstone.position, (5, 3).into());
    let cleared = road_removed
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 5 && tile.y == 3)
        .expect("map tile");
    assert_eq!(cleared.kind, "empty");

    let painted = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (5, 3).into(),
        end: (5, 3).into(),
    });
    assert!(
        painted.applied,
        "missing stop anchor should be paintable: {painted:?}"
    );
    let tile = painted
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 5 && tile.y == 3)
        .expect("map tile");
    assert_eq!(tile.area.as_deref(), Some("residential"));
}

// Regression: a PaintAreaRectangle intent is deserialized from the host/JS
// boundary, so `start`/`end` can carry arbitrary i32 values. The engine must
// clip the rectangle to map bounds before enumerating points; an off-map
// rectangle must reject without allocating billions of off-map coordinates.
#[test]
fn paint_area_rectangle_rejects_off_map_rectangle_without_hanging() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (1_000, 1_000).into(),
        end: (2_000, 2_000).into(),
    });

    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OutOfBounds)
    );
}

// Regression: a PaintAreaRectangle spanning the entire i32 range must not hang
// or OOM the engine; it should clip to the map and paint only in-bounds tiles.
#[test]
fn paint_area_rectangle_clips_i32_range_to_map_bounds() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (i32::MIN, i32::MIN).into(),
        end: (i32::MAX, i32::MAX).into(),
    });

    // The map has empty (non-road) tiles, so clamping paints them residential.
    assert!(result.applied);
    assert!(result.snapshot.map.tiles.iter().any(|tile| tile
        .area
        .as_deref()
        .is_some_and(|area| area == "residential")));
}

// Regression: a PlaceBuilding intent is deserialized from the host/JS boundary,
// so `origin` can carry i32::MAX. `origin.x + width` would overflow before
// off-map validation runs (panic in debug, wrap in release). The engine must
// reject the footprint instead of constructing overflowing ranges.
#[test]
fn place_building_rejects_overflowing_origin_without_panicking() {
    let mut engine = GameEngine::new();

    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "largeHouse".to_string(),
        origin: (i32::MAX, i32::MAX).into(),
        rotation: 0,
    });

    assert!(!rejected.applied);
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InvalidBuildingPlacement)
    );
    assert!(rejected.snapshot.buildings.is_empty());
}

// Degenerate contract: when the worker's home is the ONLY remaining destination,
// assign_workplaces must still assign it (rather than leaving the worker
// unemployed), matching the TS fallback (`eligible.length > 0 ? eligible :
// destinations`).
#[test]
fn assign_workplaces_falls_back_to_home_when_home_is_the_only_destination() {
    let home = Point { x: 2, y: 3 };
    let mut state = create_initial_snapshot();
    state.buildings = vec![destination_on("building-001", "supermarket", vec![home])];
    state.sims = vec![unassigned_worker("sim-001", home)];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(home));
}

// Regression: a worker previously assigned to their own home (the degenerate
// fallback when home was the only destination) must be promoted to a real
// non-home destination once one becomes available, instead of being skipped
// because they already hold a workplace. Without this the worker's outbound
// trip stays dormant forever (`is_home_fallback_trip`) even though a valid
// workplace now exists. Mirrors the TS `retargetCitizens(...,
// isHomeFallbackCitizen)` flow invoked when a destination is placed
// (src/simulation/buildings.ts).
#[test]
fn assign_workplaces_promotes_home_fallback_worker_when_a_real_destination_appears() {
    let home = Point { x: 2, y: 3 };
    let other = Point { x: 9, y: 4 };
    let mut state = create_initial_snapshot();

    // First pass: the only destination is the worker's home tile, so the
    // worker falls back to a home workplace.
    state.buildings = vec![destination_on("building-001", "supermarket", vec![home])];
    state.sims = vec![unassigned_worker("sim-001", home)];
    assign_workplaces(&mut state);
    assert_eq!(state.sims[0].workplace, Some(home));

    // A real non-home destination is built later; the worker must be promoted.
    state
        .buildings
        .push(destination_on("building-002", "factory", vec![other]));
    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(other));
}

// Contract: a worker already holding a real (non-home) workplace must not be
// reshuffled by a later assign_workplaces call (no load-balancing churn). This
// guards the promotion guard against over-reassignment.
#[test]
fn assign_workplaces_leaves_an_existing_real_workplace_unchanged() {
    let home = Point { x: 2, y: 3 };
    let first = Point { x: 9, y: 4 };
    let second = Point { x: 7, y: 8 };
    let mut state = create_initial_snapshot();
    state.buildings = vec![
        destination_on("building-001", "supermarket", vec![first]),
        destination_on("building-002", "factory", vec![second]),
    ];
    let mut worker = unassigned_worker("sim-001", home);
    worker.workplace = Some(first);
    state.sims = vec![worker];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, Some(first));
}

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
    assert_eq!(
        core.budget, budget,
        "world growth must not charge the player"
    );
    assert_eq!(core.buildings.len(), 1);
    assert_eq!(core.sims.len(), 4);

    let charged = buildings::place_building(&zoned, "smallHouse", &Point { x: 2, y: 3 }, 0)
        .expect("player placement succeeds");
    assert_eq!(
        charged.budget,
        budget - 4_000,
        "player placement deducts cost"
    );
}
