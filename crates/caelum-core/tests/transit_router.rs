use caelum_core::model::{ActiveTrip, RouteLeg, RoutePlan};
use caelum_core::{transit, GameEngine, GameIntent};

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

#[test]
fn bus_route_vehicle_carries_commute_trip() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);

    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
        kind: "busStop".to_string(),
    });
    let route = engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied);
    assert_eq!(route.snapshot.transit.routes[0].path_broken, false);

    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(vehicle.applied);
    assert_eq!(vehicle.snapshot.transit.vehicles.len(), 1);

    let mut snapshot = vehicle.snapshot;
    snapshot.active_trips.push(ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commute".to_string(),
        origin: (2, 5).into(),
        destination: (12, 5).into(),
        position: (2, 5).into(),
        status: "waiting".to_string(),
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: "bus".to_string(),
                from: (2, 5).into(),
                to: (12, 5).into(),
                line_id: Some("route-001".to_string()),
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 30.0,
    });

    let boarded = transit::tick_vehicles(&snapshot, 0.0);
    assert!(boarded.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let boarded_trip = boarded
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after boarding");
    assert_eq!(boarded_trip.status, "riding");

    let arrived = transit::tick_vehicles(&boarded, 20.0);
    assert!(!arrived.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let arrived_trip = arrived
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after disembark");
    assert_eq!(arrived_trip.status, "walking");
    assert_eq!(arrived_trip.position, (12, 5).into());
    assert_eq!(arrived_trip.current_leg_index, 1);
}

#[test]
fn removing_road_marks_route_broken() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (7, 5).into(),
    });

    assert!(removed.applied);
    assert!(removed.snapshot.transit.routes[0].path_broken);
}
