use caelum_core::model::{
    ActiveTrip, GameSnapshot, PlacedBuilding, Point, Sim, TransitMode, TripPosition, TripPurpose,
    TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::presentation::project_update;
use caelum_core::state::create_initial_snapshot;

fn sim(index: usize) -> Sim {
    let home = Point { x: 1, y: 1 };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn fixture_with_sims(count: usize) -> GameSnapshot {
    let mut snapshot = create_initial_snapshot();
    snapshot.buildings.clear();
    snapshot.active_trips.clear();
    snapshot.transit.stops.clear();
    snapshot.transit.stations.clear();
    snapshot.transit.routes.clear();
    snapshot.transit.metro_lines.clear();
    snapshot.transit.vehicles.clear();
    snapshot.sims = (0..count).map(sim).collect();
    snapshot
}

fn trip(index: usize, destination_count: usize) -> ActiveTrip {
    assert!((1..=504).contains(&destination_count));
    let destination_index = index % destination_count;
    ActiveTrip {
        id: format!("trip-{index:06}"),
        sim_id: format!("sim-{index:06}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 1, y: 1 },
        destination: Point {
            x: (destination_index % 28) as i32,
            y: (destination_index / 28) as i32,
        },
        position: TripPosition::from(Point { x: 1, y: 1 }),
        status: TripStatus::Walking,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}

fn fixture_with_active_trips(trip_count: usize, destination_count: usize) -> GameSnapshot {
    let mut snapshot = create_initial_snapshot();
    snapshot.active_trips = (0..trip_count)
        .map(|index| trip(index, destination_count))
        .collect();
    snapshot
}

fn building(index: usize) -> PlacedBuilding {
    let point = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    PlacedBuilding {
        id: format!("building-{index:06}"),
        building_type: "smallHouse".to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn vehicle(index: usize) -> Vehicle {
    Vehicle {
        id: format!("vehicle-{index:06}"),
        mode: TransitMode::Bus,
        line_id: "route-scale".to_string(),
        capacity: 30,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: (index % 100) as f64 / 100.0,
        parked_position: Some(TripPosition::from(Point {
            x: (index % 28) as i32,
            y: ((index / 28) % 18) as i32,
        })),
    }
}

#[test]
fn latent_population_has_no_row_per_sim_payload_growth() {
    let small = fixture_with_sims(0);
    let large = fixture_with_sims(200_000);

    let small_frame = project_update(&small, false).frame;
    let large_frame = project_update(&large, false).frame;

    assert_eq!(
        small_frame.building_occupancy.len(),
        large_frame.building_occupancy.len()
    );
    assert_eq!(small_frame.demand_flow.len(), large_frame.demand_flow.len());

    let small_bytes = serde_json::to_vec(&small_frame).unwrap().len();
    let large_bytes = serde_json::to_vec(&large_frame).unwrap().len();
    assert!(large_bytes.saturating_sub(small_bytes) < 64);
}

#[test]
fn demand_rows_follow_distinct_destinations_not_trip_count() {
    let one_destination = fixture_with_active_trips(20_000, 1);
    let map_destinations = fixture_with_active_trips(20_000, 504);

    assert_eq!(
        project_update(&one_destination, false)
            .frame
            .demand_flow
            .len(),
        1
    );
    assert_eq!(
        project_update(&map_destinations, false)
            .frame
            .demand_flow
            .len(),
        504
    );
}

#[test]
fn scale_fixtures_exercise_building_and_vehicle_terms() {
    for count in [1_000, 5_000, 20_000] {
        let mut snapshot = create_initial_snapshot();
        snapshot.sims.clear();
        snapshot.buildings = (0..count).map(building).collect();
        assert_eq!(snapshot.buildings.len(), count);
        assert_eq!(
            project_update(&snapshot, false)
                .frame
                .building_occupancy
                .len(),
            count
        );
    }

    for count in [1_000, 5_000] {
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.vehicles = (0..count).map(vehicle).collect();
        assert_eq!(snapshot.transit.vehicles.len(), count);
        assert_eq!(project_update(&snapshot, false).frame.vehicles.len(), count);
    }
}
