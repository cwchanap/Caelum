use caelum_core::model::{
    ActiveTrip, RouteLeg, RouteLegStatus, RoutePlan, TransitMode, TripPurpose, TripStatus,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::{router, transit, GameEngine, GameIntent, RoutingContext};

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
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
    });
    let route = engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied);
    assert!(!route.snapshot.transit.routes[0].path_broken);

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
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (12, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Waiting,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: (2, 5).into(),
                to: (12, 5).into(),
                line_id: Some("route-001".to_string()),
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 30.0,
    });

    let topology = RoadTopology::compile(&snapshot.map).unwrap();
    let boarded = transit::tick_vehicles(
        &snapshot,
        RoutingContext {
            road_topology: &topology,
        },
        0.0,
    );
    assert!(boarded.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let boarded_trip = boarded
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after boarding");
    assert_eq!(boarded_trip.status, TripStatus::Riding);

    let ride_seconds =
        transit::seconds_until_next_vehicle_stop(&boarded, &boarded.transit.vehicles[0])
            .expect("vehicle has a next stop");
    let arrived = transit::tick_vehicles(
        &boarded,
        RoutingContext {
            road_topology: &topology,
        },
        ride_seconds,
    );
    assert!(!arrived.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let arrived_trip = arrived
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after disembark");
    assert_eq!(arrived_trip.status, TripStatus::Walking);
    assert_eq!(arrived_trip.position, (12, 5).into());
    assert_eq!(arrived_trip.current_leg_index, 1);
}

#[test]
fn removing_road_marks_route_broken() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
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

#[test]
fn routing_ignores_a_route_with_any_disconnected_leg() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
    });
    let route = engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    let mut state = route.snapshot;
    state.transit.routes[0].path_broken = false;
    state.transit.routes[0].legs[0].status = RouteLegStatus::NetworkDisconnected;
    state.transit.routes[0].legs[0].current_path = None;

    let plan = router::find_route_plan(&state, &(2, 5).into(), &(12, 5).into())
        .expect("walking fallback remains available");

    assert!(plan.legs.iter().all(|leg| leg.mode == TransitMode::Walk));
}
