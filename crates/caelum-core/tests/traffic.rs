use std::collections::BTreeMap;

mod common;

use common::corridor;

use caelum_core::commute;
use caelum_core::model::{
    ActiveTrip, Heading, PathGeometry, PlacedBuilding, Point, PrivateCarTrip, RoadPathStep,
    Route as BusRoute, RouteLegKind, RouteLegPath, RouteLegStatus, ServiceDirection,
    ServicePattern, TransitMode, TransitPath, TripPosition, TripPurpose, TripStatus, Vehicle,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::state::create_initial_snapshot;
use caelum_core::traffic::{
    add_car_path_to_flow, congestion_multiplier, derive_road_flow, effective_road_path_seconds,
    effective_road_step_seconds, private_car_candidate, RoadFlow, CAR_ACCESS_SECONDS,
};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn road_step(position: Point, travel_seconds: f64) -> RoadPathStep {
    RoadPathStep {
        position,
        entering_heading: Heading::East,
        leaving_heading: Heading::East,
        movement: caelum_core::model::MovementKind::Straight,
        geometry: PathGeometry::Line {
            from: TripPosition::from(position),
            to: TripPosition::from((position.x + 1, position.y)),
        },
        travel_seconds,
    }
}

fn road_path(positions: &[Point]) -> TransitPath {
    let steps: Vec<_> = positions
        .iter()
        .copied()
        .map(|position| road_step(position, 1.0))
        .collect();
    TransitPath::Road {
        total_travel_seconds: steps.iter().map(|step| step.travel_seconds).sum(),
        steps,
    }
}

fn driving_trip(id: &str, status: TripStatus, path: TransitPath) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: format!("sim-{id}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(1, 1),
        destination: point(8, 1),
        position: TripPosition::from(point(1, 1)),
        status,
        deadline: 300.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 30.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: Some(PrivateCarTrip {
            path,
            arrival_time: 100.0,
        }),
    }
}

fn flow_fixture(trips: Vec<ActiveTrip>) -> caelum_core::GameSnapshot {
    let mut state = create_initial_snapshot();
    state.active_trips = trips;
    state
}

#[test]
fn congestion_multiplier_is_bounded_by_capacity_and_cap() {
    assert_eq!(congestion_multiplier(0), 1.0);
    assert_eq!(congestion_multiplier(4), 1.0);
    assert_eq!(congestion_multiplier(5), 1.25);
    assert_eq!(congestion_multiplier(6), 1.5);
    assert_eq!(congestion_multiplier(12), 3.0);
    assert_eq!(congestion_multiplier(u16::MAX), 3.0);
}

#[test]
fn shared_commute_cost_constants_are_explicit() {
    assert_eq!(commute::WALK_SECONDS_PER_TILE, 20.0);
    assert_eq!(CAR_ACCESS_SECONDS, 120.0);
}

#[test]
fn derive_road_flow_counts_one_driving_trip_once_per_unique_road_point() {
    let repeated = point(5, 5);
    let other = point(6, 5);
    let state = flow_fixture(vec![driving_trip(
        "001",
        TripStatus::Driving,
        road_path(&[repeated, repeated, other]),
    )]);

    assert_eq!(
        derive_road_flow(&state),
        BTreeMap::from([(repeated, 1), (other, 1)])
    );
}

#[test]
fn add_car_path_to_flow_counts_each_admitted_car_once_per_road_point() {
    let shared = point(5, 5);
    let other = point(6, 5);
    let mut flow = RoadFlow::new();

    add_car_path_to_flow(&mut flow, &road_path(&[shared, shared, other]));

    assert_eq!(flow, BTreeMap::from([(shared, 1), (other, 1)]));
}

#[test]
fn non_driving_trips_and_buses_do_not_contribute_to_flow() {
    let car_point = point(5, 5);
    let mut state = flow_fixture(vec![
        driving_trip("001", TripStatus::Idle, road_path(&[car_point])),
        driving_trip("002", TripStatus::Driving, road_path(&[car_point])),
    ]);
    // The bus serves a route whose captured road path overlaps the car's
    // point, so the vehicle is present on the congested road yet must still
    // be excluded from the derived car flow.
    state.transit.routes.push(BusRoute {
        id: "route-001".to_string(),
        name: "R1".to_string(),
        color: "#f00".to_string(),
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        vehicle_ids: vec!["vehicle-001".to_string()],
        active: true,
        pattern: ServicePattern::Loop,
        revision: 0,
        legs: vec![RouteLegPath {
            from_waypoint_id: "stop-001".to_string(),
            to_waypoint_id: "stop-002".to_string(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: Some(road_path(&[car_point])),
            last_valid_path: None,
            estimated_seconds: Some(1.0),
            failure_reason: None,
        }],
        path_broken: false,
        target_headway_seconds: None,
        service_metrics: None,
    });
    state.transit.vehicles.push(Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 30,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: None,
    });

    assert_eq!(derive_road_flow(&state), BTreeMap::from([(car_point, 1)]));
}

#[test]
fn two_driving_cars_sharing_a_point_produce_flow_two() {
    let shared = point(5, 5);
    let state = flow_fixture(vec![
        driving_trip("001", TripStatus::Driving, road_path(&[shared])),
        driving_trip(
            "002",
            TripStatus::Driving,
            road_path(&[shared, point(6, 5)]),
        ),
    ]);

    assert_eq!(derive_road_flow(&state).get(&shared), Some(&2));
    assert_eq!(derive_road_flow(&state).get(&point(6, 5)), Some(&1));
}

fn blank_snapshot(width: u8, height: u8) -> caelum_core::GameSnapshot {
    let mut state = create_initial_snapshot();
    state.map.width = width;
    state.map.height = height;
    state.map.tiles = (0..i32::from(height))
        .flat_map(|y| {
            (0..i32::from(width)).map(move |x| caelum_core::model::Tile {
                id: format!("tile-{x}-{y}"),
                x,
                y,
                kind: "empty".to_string(),
                area: None,
                has_track: false,
                one_way: None,
                road_connections: Vec::new(),
                road_structure_id: None,
            })
        })
        .collect();
    state.map.road_structures.clear();
    state.buildings.clear();
    state
}

fn building(id: &str, tile: Point) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: "smallHouse".to_string(),
        origin: tile,
        rotation: 0,
        occupied_tiles: vec![tile],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn endpoint_fixture(one_way: Option<Heading>) -> (caelum_core::GameSnapshot, RoadTopology) {
    let mut state = blank_snapshot(16, 10);
    corridor(
        &mut state,
        &(4..=8).map(|x| point(x, 5)).collect::<Vec<_>>(),
        one_way,
    );
    state.buildings = vec![building("home", point(3, 5)), building("work", point(9, 5))];
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology)
}

#[test]
fn private_car_requires_usable_home_access() {
    let (mut state, topology) = endpoint_fixture(None);
    state.buildings[0].occupied_tiles = vec![point(1, 1)];

    assert!(private_car_candidate(
        &state,
        &topology,
        &RoadFlow::new(),
        point(1, 1),
        point(9, 5)
    )
    .is_none());
}

#[test]
fn private_car_requires_usable_workplace_access() {
    let (mut state, topology) = endpoint_fixture(None);
    state.buildings[1].occupied_tiles = vec![point(12, 1)];

    assert!(private_car_candidate(
        &state,
        &topology,
        &RoadFlow::new(),
        point(3, 5),
        point(12, 1)
    )
    .is_none());
}

#[test]
fn private_car_rejects_disconnected_access_roads() {
    let mut state = blank_snapshot(16, 10);
    corridor(&mut state, &[point(4, 5), point(5, 5)], None);
    corridor(&mut state, &[point(7, 5), point(8, 5)], None);
    state.buildings = vec![building("home", point(3, 5)), building("work", point(9, 5))];
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");

    assert!(private_car_candidate(
        &state,
        &topology,
        &RoadFlow::new(),
        point(3, 5),
        point(9, 5)
    )
    .is_none());
}

#[test]
fn private_car_uses_connected_two_way_road() {
    let (state, topology) = endpoint_fixture(None);

    let candidate = private_car_candidate(
        &state,
        &topology,
        &RoadFlow::new(),
        point(3, 5),
        point(9, 5),
    );
    assert!(
        candidate.is_some(),
        "connected two-way road should produce a car candidate"
    );
    if let Some(candidate) = candidate {
        assert!(matches!(candidate.path, TransitPath::Road { ref steps, .. } if !steps.is_empty()));
        assert!(candidate.estimated_seconds > 0.0);
    }
}

#[test]
fn private_car_respects_one_way_direction() {
    let (state, topology) = endpoint_fixture(Some(Heading::East));

    assert!(private_car_candidate(
        &state,
        &topology,
        &RoadFlow::new(),
        point(9, 5),
        point(3, 5)
    )
    .is_none());
}

#[test]
fn effective_road_path_seconds_uses_current_flow_per_transition() {
    let repeated = point(5, 5);
    let other = point(6, 5);
    let state = flow_fixture(vec![
        driving_trip("001", TripStatus::Driving, road_path(&[repeated])),
        driving_trip("002", TripStatus::Driving, road_path(&[repeated])),
        driving_trip("003", TripStatus::Driving, road_path(&[repeated])),
        driving_trip("004", TripStatus::Driving, road_path(&[repeated])),
    ]);
    let candidate_path = road_path(&[repeated, repeated, other]);

    let flow = derive_road_flow(&state);
    assert_eq!(flow.get(&repeated), Some(&4));
    assert_eq!(effective_road_path_seconds(&flow, &candidate_path), 3.0);
}

#[test]
fn private_car_candidate_eta_includes_its_own_flow_unit() {
    let (empty_state, topology) = endpoint_fixture(None);
    let free_flow = private_car_candidate(
        &empty_state,
        &topology,
        &RoadFlow::new(),
        point(3, 5),
        point(9, 5),
    );
    assert!(
        free_flow.is_some(),
        "connected two-way road should produce a free-flow candidate"
    );
    let Some(free_flow) = free_flow else {
        return;
    };
    let road_positions: Vec<_> = free_flow
        .path
        .road_steps()
        .iter()
        .map(|step| step.position)
        .collect();
    let mut state = empty_state;
    state.active_trips = (0..4)
        .map(|index| {
            driving_trip(
                &format!("{index:03}"),
                TripStatus::Driving,
                road_path(&road_positions),
            )
        })
        .collect();

    let flow = derive_road_flow(&state);
    let congested = private_car_candidate(&state, &topology, &flow, point(3, 5), point(9, 5));
    assert!(
        congested.is_some(),
        "active flow should not invalidate the captured candidate"
    );
    if let Some(congested) = congested {
        let free_road_seconds: f64 = free_flow
            .path
            .road_steps()
            .iter()
            .map(|step| step.travel_seconds)
            .sum();
        assert!(
            (congested.estimated_seconds
                - (free_flow.estimated_seconds + free_road_seconds * 0.25))
                .abs()
                < 1e-9
        );
    }
}

#[test]
fn empty_road_path_keeps_its_stored_total_duration() {
    let path = TransitPath::Road {
        steps: Vec::new(),
        total_travel_seconds: 3.75,
    };

    assert_eq!(effective_road_path_seconds(&RoadFlow::new(), &path), 3.75);
}

#[test]
fn effective_track_path_seconds_ignore_road_flow() {
    let state = flow_fixture(vec![driving_trip(
        "001",
        TripStatus::Driving,
        road_path(&[point(5, 5)]),
    )]);
    let step = caelum_core::model::TrackPathStep {
        position: point(5, 5),
        heading: Heading::East,
        geometry: PathGeometry::Line {
            from: TripPosition::from(point(5, 5)),
            to: TripPosition::from(point(6, 5)),
        },
        travel_seconds: 2.0,
    };
    let path = TransitPath::Track {
        steps: vec![step],
        total_travel_seconds: 2.0,
    };

    assert_eq!(
        effective_road_path_seconds(&derive_road_flow(&state), &path),
        2.0
    );
}

#[test]
fn effective_road_step_seconds_applies_current_derived_flow() {
    let position = point(5, 5);
    let state = flow_fixture(
        (0..6)
            .map(|index| {
                driving_trip(
                    &format!("{index:03}"),
                    TripStatus::Driving,
                    road_path(&[position]),
                )
            })
            .collect(),
    );
    let step = road_step(position, 1.25);

    assert_eq!(
        effective_road_step_seconds(&derive_road_flow(&state), &step),
        1.875
    );
}
