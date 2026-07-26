use caelum_core::model::{
    ActiveTrip, BusStopKind, GameSnapshot, Heading, MetricsState, PathGeometry, PlacedBuilding,
    Platform, Point, Route, RouteLeg, RouteLegKind, RouteLegPath, RouteLegStatus, RoutePlan,
    ServiceDirection, ServicePattern, Sim, SnapshotSchemaProbe, Stop, StopRoadAccess, TransitMode,
    TransitNodeStatus, TransitPath, TripPosition, TripPurpose, TripStatus, Vehicle, WorkerProfile,
    SNAPSHOT_SCHEMA_VERSION,
};
use caelum_core::{platforms, GameEngine, GameIntent, GameplayRejection, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn bus_platform(stop_id: &str) -> Platform {
    platforms::bus_platforms(stop_id, BusStopKind::BusStop)
        .into_iter()
        .next()
        .expect("bus stop has a platform")
}

fn parked_bus(id: &str, line_id: &str, position: Point) -> Vehicle {
    Vehicle {
        id: id.to_string(),
        mode: TransitMode::Bus,
        line_id: line_id.to_string(),
        capacity: 18,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: Some(position.into()),
    }
}

fn route_leg_path(from_waypoint_id: &str, to_waypoint_id: &str) -> RouteLegPath {
    RouteLegPath {
        from_waypoint_id: from_waypoint_id.to_string(),
        to_waypoint_id: to_waypoint_id.to_string(),
        direction: ServiceDirection::Loop,
        kind: RouteLegKind::Service,
        status: RouteLegStatus::Connected,
        current_path: None,
        last_valid_path: None,
        estimated_seconds: Some(1.0),
        failure_reason: None,
    }
}

fn passenger_route_plan() -> RoutePlan {
    RoutePlan {
        legs: vec![
            RouteLeg {
                mode: TransitMode::Walk,
                from: point(1, 1),
                to: point(4, 5),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: point(4, 5),
                to: point(8, 4),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(1),
            },
        ],
        estimated_seconds: 100.0,
    }
}

fn legacy_snapshot() -> GameSnapshot {
    let mut engine = GameEngine::new();
    let roads = (2..=10).map(|x| point(x, 5)).collect();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: roads,
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "fixture road should apply: {result:?}");

    let mut snapshot = engine.snapshot();
    let stop_1_platform = bus_platform("stop-001");
    let stop_2_platform = bus_platform("stop-002");
    snapshot.transit.stops = vec![
        Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: point(4, 5),
            platforms: vec![Platform {
                route_ids: vec!["route-001".to_string()],
                ..stop_1_platform
            }],
            road_access: None,
        },
        Stop {
            id: "stop-002".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: point(8, 4),
            platforms: vec![Platform {
                route_ids: vec!["route-001".to_string()],
                ..stop_2_platform
            }],
            road_access: None,
        },
    ];
    snapshot.transit.routes = vec![Route {
        id: "route-001".to_string(),
        name: "Legacy route".to_string(),
        color: "#ffffff".to_string(),
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        vehicle_ids: vec!["vehicle-001".to_string()],
        active: true,
        pattern: ServicePattern::Loop,
        revision: 0,
        legs: vec![route_leg_path("stop-001", "stop-002")],
        path_broken: false,
    }];
    snapshot.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        // Legacy snapshots could persist the passenger anchor instead of the
        // road coordinate used by buses.
        parked_position: Some(point(4, 4).into()),
    }];
    snapshot.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: point(4, 5),
        position: point(4, 5),
        worker_profile: WorkerProfile::NonWorker,
        shift_template: None,
        workplace: Some(point(4, 5)),
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    snapshot.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(4, 5),
        destination: point(4, 5),
        position: point(4, 5).into(),
        status: TripStatus::Waiting,
        deadline: 1_000.0,
        route_plan: Some(passenger_route_plan()),
        current_leg_index: 1,
        patience_remaining: 240.0,
    }];
    snapshot.metrics.state = MetricsState::Running;
    snapshot
}

#[test]
fn from_snapshot_migrates_legacy_stop_and_rebases_dependent_passenger_and_bus_state() {
    let engine = GameEngine::from_snapshot(legacy_snapshot()).unwrap();
    let snapshot = engine.snapshot();
    let stop = &snapshot.transit.stops[0];
    let waiting_trip = &snapshot.active_trips[0];
    let parked_bus = &snapshot.transit.vehicles[0];

    assert_eq!(snapshot.schema_version, SNAPSHOT_SCHEMA_VERSION);
    assert_eq!(stop.position, point(4, 4));
    assert_eq!(stop.road_access.unwrap().road_point, point(4, 5));
    assert_eq!(
        snapshot.transit.stops[1]
            .road_access
            .expect("roadside access is rederived")
            .road_point,
        point(8, 5)
    );
    assert_eq!(waiting_trip.position, (4, 4).into());
    assert_eq!(parked_bus.parked_position, Some((4, 5).into()));
    assert_eq!(
        waiting_trip.route_plan.as_ref().unwrap().legs[0].to,
        point(4, 4)
    );
    assert_eq!(
        waiting_trip.route_plan.as_ref().unwrap().legs[1].from,
        point(4, 4)
    );
    assert!(platforms::on_platform_trip_ids(&snapshot).contains("trip-001"));

    assert_eq!(waiting_trip.origin, point(4, 5));
    assert_eq!(waiting_trip.destination, point(4, 5));
    assert_eq!(snapshot.sims[0].home, point(4, 5));
    assert_eq!(snapshot.sims[0].workplace, Some(point(4, 5)));
}

#[test]
fn from_snapshot_rejects_unsupported_schema_before_normalization() {
    let mut snapshot = legacy_snapshot();
    snapshot.schema_version = SNAPSHOT_SCHEMA_VERSION - 1;

    let rejection = match GameEngine::from_snapshot(snapshot) {
        Ok(_) => panic!("unsupported snapshot schema must be rejected"),
        Err(rejection) => rejection,
    };
    let wire = serde_json::to_value(rejection).expect("rejection serializes");

    assert_eq!(wire["code"], serde_json::json!("unsupportedSnapshotSchema"));
    assert_eq!(
        wire["context"]["expectedSchemaVersion"],
        serde_json::json!(SNAPSHOT_SCHEMA_VERSION)
    );
    assert_eq!(
        wire["context"]["actualSchemaVersion"],
        serde_json::json!(SNAPSHOT_SCHEMA_VERSION - 1)
    );
}

#[test]
fn schema_v3_json_missing_starting_capital_is_rejected_before_full_deserialization() {
    let mut value = serde_json::to_value(legacy_snapshot()).expect("snapshot serializes");
    value["schemaVersion"] = serde_json::json!(3);
    value["rules"]["sandbox"]
        .as_object_mut()
        .expect("sandbox rules are an object")
        .remove("startingCapital");

    let probe: SnapshotSchemaProbe =
        serde_json::from_value(value.clone()).expect("schema probe reads schema-v3 JSON");
    let rejection = if probe.schema_version != SNAPSHOT_SCHEMA_VERSION {
        GameplayRejection::unsupported_snapshot_schema(probe.schema_version)
    } else {
        panic!("schema-v3 JSON must be rejected before the full deserialize")
    };
    let wire = serde_json::to_value(rejection).expect("rejection serializes");

    assert!(serde_json::from_value::<GameSnapshot>(value).is_err());
    assert_eq!(wire["code"], serde_json::json!("unsupportedSnapshotSchema"));
    assert_eq!(
        wire["context"]["expectedSchemaVersion"],
        serde_json::json!(4)
    );
    assert_eq!(wire["context"]["actualSchemaVersion"], serde_json::json!(3));
}

#[test]
fn from_snapshot_handles_extreme_stop_and_footprint_coordinates_without_overflow() {
    let mut snapshot = legacy_snapshot();
    snapshot.transit.routes.clear();
    snapshot.transit.vehicles.clear();
    snapshot.transit.stops[0].position = point(i32::MAX, i32::MAX);
    snapshot.transit.stops[0].road_access = None;
    snapshot.transit.stops[1].road_access = None;
    snapshot.buildings.push(PlacedBuilding {
        id: "malformed-footprint".to_string(),
        building_type: "fixture".to_string(),
        origin: point(i32::MAX, i32::MAX),
        rotation: 0,
        occupied_tiles: vec![point(i32::MAX, i32::MAX)],
        transit_node_id: Some("stop-002".to_string()),
    });

    let engine = GameEngine::from_snapshot(snapshot).expect("malformed coordinates are ignored");
    let loaded = engine.snapshot();

    assert_eq!(loaded.schema_version, SNAPSHOT_SCHEMA_VERSION);
    assert!(loaded
        .transit
        .stops
        .iter()
        .all(|stop| stop.road_access.is_none()));
}

/// Mirror of the `i32::MAX` case above, exercising the negative-overflow
/// side of `checked_offset`: a stop at `i32::MIN` with a building footprint
/// at the same corner must not panic when the access deriver subtracts a
/// heading offset, and must leave `road_access` as `None`.
#[test]
fn from_snapshot_handles_negative_extreme_stop_and_footprint_coordinates_without_overflow() {
    let mut snapshot = legacy_snapshot();
    snapshot.transit.routes.clear();
    snapshot.transit.vehicles.clear();
    snapshot.transit.stops[0].position = point(i32::MIN, i32::MIN);
    snapshot.transit.stops[0].road_access = None;
    snapshot.transit.stops[1].road_access = None;
    snapshot.buildings.push(PlacedBuilding {
        id: "malformed-footprint-min".to_string(),
        building_type: "fixture".to_string(),
        origin: point(i32::MIN, i32::MIN),
        rotation: 0,
        occupied_tiles: vec![point(i32::MIN, i32::MIN)],
        transit_node_id: Some("stop-002".to_string()),
    });

    let engine = GameEngine::from_snapshot(snapshot).expect("malformed coordinates are ignored");
    let loaded = engine.snapshot();

    assert_eq!(loaded.schema_version, SNAPSHOT_SCHEMA_VERSION);
    assert!(loaded
        .transit
        .stops
        .iter()
        .all(|stop| stop.road_access.is_none()));
}

#[test]
fn from_snapshot_preserves_out_of_service_and_unrelated_bus_parking() {
    let mut snapshot = legacy_snapshot();
    snapshot.transit.routes.push(Route {
        id: "route-002".to_string(),
        name: "Out of service route".to_string(),
        color: "#000000".to_string(),
        stop_ids: vec!["stop-001".to_string()],
        vehicle_ids: vec!["vehicle-002".to_string()],
        active: false,
        pattern: ServicePattern::Loop,
        revision: 0,
        legs: Vec::new(),
        path_broken: true,
    });
    snapshot.transit.vehicles.extend([
        parked_bus("vehicle-002", "route-002", point(17, 12)),
        parked_bus("vehicle-003", "route-999", point(18, 12)),
    ]);

    let engine = GameEngine::from_snapshot(snapshot).unwrap();
    let snapshot = engine.snapshot();

    assert_eq!(
        snapshot
            .transit
            .vehicles
            .iter()
            .find(|vehicle| vehicle.id == "vehicle-002")
            .expect("out-of-service bus")
            .parked_position,
        Some(point(17, 12).into())
    );
    assert_eq!(
        snapshot
            .transit
            .vehicles
            .iter()
            .find(|vehicle| vehicle.id == "vehicle-003")
            .expect("unrelated bus")
            .parked_position,
        Some(point(18, 12).into())
    );
}

#[test]
fn from_snapshot_rebases_parked_bus_when_road_access_is_re_derived() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=10).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "south road: {result:?}");
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=10).map(|x| point(x, 3)).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "north road: {result:?}");

    let mut snapshot = engine.snapshot();
    let stop_platform = bus_platform("stop-001");
    snapshot.transit.stops = vec![Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: point(4, 4),
        platforms: vec![Platform {
            route_ids: vec!["route-001".to_string()],
            ..stop_platform
        }],
        road_access: Some(StopRoadAccess {
            road_point: point(4, 5),
            preferred_heading: None,
        }),
    }];
    snapshot.transit.routes = vec![Route {
        id: "route-001".to_string(),
        name: "Test route".to_string(),
        color: "#ffffff".to_string(),
        stop_ids: vec!["stop-001".to_string()],
        vehicle_ids: vec!["vehicle-001".to_string()],
        active: true,
        pattern: ServicePattern::Shuttle,
        revision: 0,
        legs: Vec::new(),
        path_broken: false,
    }];
    snapshot.transit.vehicles = vec![parked_bus("vehicle-001", "route-001", point(4, 5))];

    let tile = snapshot.map.tile_mut(point(4, 5)).expect("old road tile");
    tile.kind = "empty".to_string();
    tile.road_connections.clear();
    tile.one_way = None;

    let engine = GameEngine::from_snapshot(snapshot).unwrap();
    let loaded = engine.snapshot();
    let stop = &loaded.transit.stops[0];
    let new_road_point = stop.road_access.expect("re-derived access").road_point;
    assert_eq!(
        new_road_point,
        point(4, 3),
        "access should re-derive to the north road after demolition",
    );
    let bus = loaded
        .transit
        .vehicles
        .iter()
        .find(|v| v.id == "vehicle-001")
        .expect("bus");
    assert_eq!(
        bus.parked_position,
        Some(point(4, 3).into()),
        "parked bus should be rebased from demolished road_point (4,5) to re-derived (4,3)",
    );
}

#[test]
fn legacy_stop_with_no_free_neighbor_uses_on_road_access_fallback() {
    let mut legacy = legacy_snapshot();
    legacy.buildings.extend([
        PlacedBuilding {
            id: "building-north".to_string(),
            building_type: "fixture".to_string(),
            origin: point(4, 4),
            rotation: 0,
            occupied_tiles: vec![point(4, 4)],
            transit_node_id: None,
        },
        PlacedBuilding {
            id: "building-south".to_string(),
            building_type: "fixture".to_string(),
            origin: point(4, 6),
            rotation: 0,
            occupied_tiles: vec![point(4, 6)],
            transit_node_id: None,
        },
    ]);

    let engine = GameEngine::from_snapshot(legacy).unwrap();
    let stop = &engine.snapshot().transit.stops[0];
    let access = stop.road_access.expect("fallback access is recorded");

    assert_eq!(stop.position, access.road_point);
    assert_eq!(access.road_point, point(4, 5));
}

fn point_at(path: &TransitPath, index: usize, progress: f64) -> TripPosition {
    let step = &path.road_steps()[index];
    match &step.geometry {
        PathGeometry::Line { from, to } => TripPosition {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
        },
        PathGeometry::QuadraticBezier { from, control, to } => {
            let inverse = 1.0 - progress;
            TripPosition {
                x: inverse * inverse * from.x
                    + 2.0 * inverse * progress * control.x
                    + progress * progress * to.x,
                y: inverse * inverse * from.y
                    + 2.0 * inverse * progress * control.y
                    + progress * progress * to.y,
            }
        }
    }
}

fn stale_access_route_snapshot() -> (GameSnapshot, TransitPath, usize, f64, Heading) {
    let mut engine = GameEngine::new();
    let old_road = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=10).map(|x| point(x, 2)).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(old_road.applied, "fixture road should apply: {old_road:?}");

    for points in [
        (2..=5).map(|x| point(x, 4)).collect::<Vec<_>>(),
        (7..=10).map(|x| point(x, 4)).collect::<Vec<_>>(),
        (5..=7).map(|x| point(x, 5)).collect::<Vec<_>>(),
    ] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture road should apply: {result:?}");
    }

    for point in [point(4, 3), point(8, 3)] {
        let stop = engine.dispatch(GameIntent::AddBusStop { point });
        assert!(stop.applied, "fixture stop should apply: {stop:?}");
    }
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(created.applied, "fixture route should apply: {created:?}");

    let mut snapshot = created.snapshot;
    let old_path = snapshot.transit.routes[0].legs[0]
        .current_path
        .clone()
        .expect("old route path");
    let path_step_index = old_path.step_count() / 2;
    let step = &old_path.road_steps()[path_step_index];
    let old_heading = step.leaving_heading;
    let step_progress = 0.5;
    snapshot.transit.routes[0].vehicle_ids = vec!["vehicle-001".to_string()];
    snapshot.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index,
        step_progress,
        parked_position: None,
    }];

    for tile in snapshot.map.tiles.iter_mut().filter(|tile| tile.y == 2) {
        tile.kind = "empty".to_string();
        tile.has_track = false;
        tile.one_way = None;
        tile.road_connections.clear();
        tile.road_structure_id = None;
    }

    // Encode the two reciprocal turn edges that the serialized candidate map
    // retained for the surviving detour.
    for (point, heading) in [
        (point(5, 4), Heading::South),
        (point(5, 5), Heading::North),
        (point(7, 4), Heading::South),
        (point(7, 5), Heading::North),
    ] {
        snapshot
            .map
            .tile_mut(point)
            .expect("detour tile")
            .road_connections
            .push(heading);
    }

    (
        snapshot,
        old_path,
        path_step_index,
        step_progress,
        old_heading,
    )
}

#[test]
fn from_snapshot_recomputes_stale_route_paths_after_access_normalization() {
    let (snapshot, old_path, old_step_index, old_progress, old_heading) =
        stale_access_route_snapshot();
    let old_world = point_at(&old_path, old_step_index, old_progress);

    let engine = GameEngine::from_snapshot(snapshot).unwrap();
    let loaded = engine.snapshot();
    assert_eq!(
        loaded.transit.stops[0]
            .road_access
            .expect("normalized stop access")
            .road_point,
        point(4, 4)
    );
    assert_eq!(
        loaded.transit.stops[1]
            .road_access
            .expect("normalized stop access")
            .road_point,
        point(8, 4)
    );

    let route = &loaded.transit.routes[0];
    let path = route.legs[0]
        .current_path
        .as_ref()
        .expect("route path is re-resolved on load");
    assert!(
        path.road_steps().iter().any(|step| step.position.y == 5),
        "the loaded path must use the surviving detour rather than stale y=2 roads"
    );
    assert!(path.road_steps().iter().all(|step| step.position.y != 2));

    let projection =
        caelum_core::route_lifecycle::project_position_onto_path(path, old_world, old_heading);
    let vehicle = &loaded.transit.vehicles[0];
    assert_eq!(vehicle.path_step_index, projection.path_step_index);
    assert!((vehicle.step_progress - projection.step_progress).abs() < 1e-9);
}

#[test]
fn map_mutation_rederives_stale_stop_access_before_route_recompute() {
    let mut seed = GameEngine::new();
    for y in [2, 4] {
        let result = seed.dispatch(GameIntent::LayRoadLine {
            points: (2..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture road should apply: {result:?}");
    }
    let added = seed.dispatch(GameIntent::AddBusStop { point: point(4, 3) });
    assert!(added.applied, "fixture stop should apply: {added:?}");

    let mut engine = GameEngine::from_snapshot(seed.snapshot()).unwrap();
    assert_eq!(
        engine.snapshot().transit.stops[0]
            .road_access
            .expect("fixture access")
            .road_point,
        point(4, 2)
    );

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(4, 2) });
    assert!(
        removed.applied,
        "fixture road removal should apply: {removed:?}"
    );
    assert_eq!(
        engine.snapshot().transit.stops[0]
            .road_access
            .expect("access should be rederived")
            .road_point,
        point(4, 4)
    );
}
