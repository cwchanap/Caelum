use caelum_core::model::{
    ActiveTrip, BusStopKind, GameSnapshot, MetricsState, PlacedBuilding, Platform, Point, Route,
    RouteLeg, RouteLegKind, RouteLegPath, RouteLegStatus, RoutePlan, ServiceDirection,
    ServicePattern, Sim, Stop, TransitMode, TransitNodeStatus, TripPurpose, TripStatus, Vehicle,
    WorkerProfile,
};
use caelum_core::{platforms, GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn bus_platform(stop_id: &str) -> Platform {
    platforms::bus_platforms(stop_id, BusStopKind::BusStop)
        .into_iter()
        .next()
        .expect("bus stop has a platform")
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
        parked_position: Some(point(4, 5).into()),
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
fn from_snapshot_migrates_legacy_stop_and_rebases_dependent_passenger_state() {
    let engine = GameEngine::from_snapshot(legacy_snapshot()).unwrap();
    let snapshot = engine.snapshot();
    let stop = &snapshot.transit.stops[0];
    let waiting_trip = &snapshot.active_trips[0];
    let parked_bus = &snapshot.transit.vehicles[0];

    assert_eq!(snapshot.schema_version, 2);
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
