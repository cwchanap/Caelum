use std::time::Instant;

use caelum_core::model::{
    ActiveTrip, GameSnapshot, PlacedBuilding, Point, Sim, TransitMode, TripPosition, TripPurpose,
    TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::presentation::project_update;
use caelum_core::GameEngine;

fn sim(index: usize) -> Sim {
    let home = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(Point { x: 14, y: 9 }),
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn active_trip(index: usize, destination_count: usize) -> ActiveTrip {
    assert!((1..=504).contains(&destination_count));
    let destination_index = index % destination_count;
    let destination = Point {
        x: (destination_index % 28) as i32,
        y: (destination_index / 28) as i32,
    };
    ActiveTrip {
        id: format!("trip-{index:06}"),
        sim_id: format!("sim-{index:06}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 1, y: 1 },
        destination,
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

fn occupancy_building(index: usize) -> PlacedBuilding {
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

fn measure_snapshot(label: &str, snapshot: &GameSnapshot) {
    let started = Instant::now();
    let bytes = serde_json::to_vec(snapshot).expect("snapshot serialization");
    let micros = started.elapsed().as_micros();
    println!(
        "{label}\tsims={}\ttrips={}\tbuildings={}\tvehicles={}\tbytes={}\tserialize_us={micros}",
        snapshot.sims.len(),
        snapshot.active_trips.len(),
        snapshot.buildings.len(),
        snapshot.transit.vehicles.len(),
        bytes.len(),
    );
}

fn measure_presentation(label: &str, snapshot: &GameSnapshot) {
    let started = Instant::now();
    let update = project_update(snapshot, true);
    let projection_us = started.elapsed().as_micros();

    let started = Instant::now();
    let update_bytes = serde_json::to_vec(&update).expect("presentation serialization");
    let serialize_us = started.elapsed().as_micros();
    let frame_bytes = serde_json::to_vec(&update.frame)
        .expect("frame serialization")
        .len();

    println!(
        "{label}\tpresentation_bytes={}\tframe_bytes={}\tprojection_us={}\tpresentation_serialize_us={}",
        update_bytes.len(),
        frame_bytes,
        projection_us,
        serialize_us,
    );
}

fn main() {
    let baseline = GameEngine::new().snapshot();
    measure_snapshot("current", &baseline);
    measure_presentation("current", &baseline);

    for count in [10_000, 50_000, 200_000] {
        let mut fixture = baseline.clone();
        fixture.sims = (0..count).map(sim).collect();
        measure_snapshot(&format!("sims-{count}"), &fixture);
        measure_presentation(&format!("sims-{count}"), &fixture);
    }

    for count in [1_000, 5_000, 20_000] {
        let mut fixture = baseline.clone();
        fixture.active_trips = (0..count).map(|index| active_trip(index, 504)).collect();
        measure_snapshot(&format!("trips-{count}"), &fixture);
        measure_presentation(&format!("trips-{count}"), &fixture);
    }

    for count in [1_000, 5_000, 20_000] {
        let mut fixture = baseline.clone();
        fixture.buildings = (0..count).map(occupancy_building).collect();
        measure_snapshot(&format!("buildings-{count}"), &fixture);
        measure_presentation(&format!("buildings-{count}"), &fixture);
    }

    for count in [1_000, 5_000] {
        let mut fixture = baseline.clone();
        fixture.transit.vehicles = (0..count).map(vehicle).collect();
        measure_snapshot(&format!("vehicles-{count}"), &fixture);
        measure_presentation(&format!("vehicles-{count}"), &fixture);
    }
}
