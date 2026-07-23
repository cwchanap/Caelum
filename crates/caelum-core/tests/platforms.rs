use caelum_core::model::{
    ActiveTrip, BusStopKind, Point, RouteLeg, RoutePlan, ServiceDirection, TransitMode,
    TransitNodeStatus, TripPurpose, TripStatus,
};
use caelum_core::{platforms, GameEngine};

fn waiting_trip(id: &str, position: Point, line_id: &str, patience_remaining: f64) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: format!("sim-{id}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: position,
        destination: (0, 0).into(),
        position: position.into(),
        status: TripStatus::Waiting,
        deadline: 9_999.0,
        route_plan: Some(RoutePlan {
            estimated_seconds: 100.0,
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: position,
                to: (0, 0).into(),
                line_id: Some(line_id.to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
        }),
        current_leg_index: 0,
        patience_remaining,
    }
}

#[test]
fn platform_builders_match_typescript_shapes() {
    let bus_stop = platforms::bus_platforms("stop-001", BusStopKind::BusStop);
    assert_eq!(bus_stop.len(), 1);
    assert_eq!(bus_stop[0].id, "stop-001-p0");
    assert_eq!(bus_stop[0].label, "A");
    assert_eq!(bus_stop[0].capacity, 50);
    assert!(bus_stop[0].route_ids.is_empty());

    let terminal = platforms::bus_platforms("stop-002", BusStopKind::BusTerminal);
    assert_eq!(
        terminal
            .iter()
            .map(|platform| platform.label.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B", "C"]
    );
    assert!(terminal.iter().all(|platform| platform.capacity == 50));

    let metro = platforms::metro_platforms("station-001");
    assert_eq!(
        metro
            .iter()
            .map(|platform| (platform.label.as_str(), platform.capacity))
            .collect::<Vec<_>>(),
        vec![("A", 300), ("B", 300)]
    );
}

#[test]
fn on_platform_trip_ids_include_first_capacity_waiters_by_patience_then_id() {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.transit.stops.push(caelum_core::model::Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: (5, 5).into(),
        platforms: vec![caelum_core::model::Platform {
            id: "stop-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 2,
            route_ids: vec!["route-001".to_string()],
        }],
        road_access: None,
    });
    snapshot.active_trips = vec![
        waiting_trip("c1", (5, 5).into(), "route-001", 100.0),
        waiting_trip("c2", (5, 5).into(), "route-001", 50.0),
        waiting_trip("c3", (5, 5).into(), "route-001", 10.0),
        waiting_trip("c4", (5, 5).into(), "route-002", 1.0),
    ];

    let on_platform = platforms::on_platform_trip_ids(&snapshot);

    assert!(on_platform.contains("c3"));
    assert!(on_platform.contains("c2"));
    assert!(!on_platform.contains("c1"));
    assert!(!on_platform.contains("c4"));
}

#[test]
fn station_platforms_participate_in_the_same_position_line_index() {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.transit.stations.push(caelum_core::model::Station {
        id: "station-001".to_string(),
        status: TransitNodeStatus::Present,
        position: (9, 9).into(),
        platforms: vec![caelum_core::model::Platform {
            id: "station-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 300,
            route_ids: vec!["metro-001".to_string()],
        }],
    });
    let mut trip = waiting_trip("m1", (9, 9).into(), "metro-001", 100.0);
    trip.route_plan = Some(RoutePlan {
        estimated_seconds: 100.0,
        legs: vec![RouteLeg {
            mode: TransitMode::Metro,
            from: (9, 9).into(),
            to: (0, 0).into(),
            line_id: Some("metro-001".to_string()),
            service_direction: Some(ServiceDirection::Loop),
            board_itinerary_index: Some(0),
            alight_itinerary_index: Some(0),
        }],
    });
    snapshot.active_trips = vec![trip];

    let on_platform = platforms::on_platform_trip_ids(&snapshot);

    assert!(on_platform.contains("m1"));
}

#[test]
fn missing_node_has_no_waiting_queue_or_platform_capacity() {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.transit.stops.push(caelum_core::model::Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Missing,
        position: (5, 5).into(),
        platforms: vec![caelum_core::model::Platform {
            id: "stop-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 2,
            route_ids: vec!["route-001".to_string()],
        }],
        road_access: None,
    });
    snapshot.active_trips = vec![waiting_trip(
        "missing-waiter",
        (5, 5).into(),
        "route-001",
        100.0,
    )];

    let on_platform = platforms::on_platform_trip_ids(&snapshot);

    assert!(on_platform.is_empty());
}
