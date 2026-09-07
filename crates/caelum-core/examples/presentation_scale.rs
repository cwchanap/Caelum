use std::time::Instant;

use caelum_core::building_catalog::building_definition;
use caelum_core::model::{
    ActiveTrip, CitizenRoutine, GameSnapshot, PlacedBuilding, Point, ScheduledActivity,
    ScheduledActivityKind, Sim, TransitMode, TripPosition, TripPurpose, TripStatus, Vehicle,
};
use caelum_core::presentation::{population_aggregates_from_snapshot, project_update};
use caelum_core::{create_sandbox_snapshot, GameEngine, SandboxCreationRequest};

fn sim(index: usize) -> Sim {
    let home = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(Point { x: 14, y: 9 }),
        },
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: 350.0,
        }),
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
    let update = project_update(
        snapshot,
        &population_aggregates_from_snapshot(snapshot),
        true,
    );
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

/// Final runtime rows for the ECS-owned population. Times, in order: the
/// candidate-first runtime build (`from_snapshot`: shell validation, topology
/// compile, ECS world/schedule construction, shell mirror clear), one quiet
/// engine tick that crosses no wake, the runtime presentation (ECS-built
/// aggregates through the one projector), and the explicit durable snapshot
/// reconstruction (`engine.snapshot()`, O(population)). The fixture workers
/// are dormant (their workplace point resolves to no job building), so the
/// quiet tick exercises the exact-time scheduler without emitting demand.
fn measure_ecs_row(label: &str, fixture: &GameSnapshot, count: usize) {
    let started = Instant::now();
    let mut engine = GameEngine::from_snapshot(fixture.clone()).expect("scale fixture loads");
    let runtime_build_us = started.elapsed().as_micros();

    assert!(
        engine
            .dispatch(caelum_core::GameIntent::SetPaused { paused: false })
            .applied
    );
    let started = Instant::now();
    let result = engine.tick(0.5);
    let quiet_tick_us = started.elapsed().as_micros();
    assert_eq!(result.update.frame.time - fixture.time, 0.5);
    assert!(result.applied, "quiet tick must still advance time");

    let started = Instant::now();
    let update = engine.presentation();
    let runtime_presentation_us = started.elapsed().as_micros();
    let presentation_bytes = serde_json::to_vec(&update)
        .expect("presentation serialization")
        .len();

    let started = Instant::now();
    let durable = engine.snapshot();
    let full_snapshot_us = started.elapsed().as_micros();

    assert_eq!(durable.sims.len(), count, "durable reconstruction size");
    println!(
        "{label}\truntime_build_us={runtime_build_us}\tquiet_tick_us={quiet_tick_us}\truntime_presentation_us={runtime_presentation_us}\tfull_snapshot_us={full_snapshot_us}\tsims={}\tpresentation_bytes={presentation_bytes}",
        durable.sims.len(),
    );
}

/// A due-wave fixture: `count` Workers on the small-town template, every one
/// waking at the same exact time (t = 300 s on day 0) with a live job-building
/// workplace. Day-0 day-off citizens (`numeric id suffix % 7 == 0`) are
/// excluded from generation so exactly `count` demands emit; template housing
/// is dropped so no move-in competes with the wave.
fn wave_snapshot(count: usize) -> GameSnapshot {
    let mut snapshot = create_sandbox_snapshot(SandboxCreationRequest {
        template_id: "smallTown".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(caelum_core::DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
    })
    .expect("small town template must remain valid");
    snapshot.day = 0;
    snapshot.time = 0.0;
    snapshot.paused = true;
    snapshot.speed = 1;

    let job_tile = snapshot
        .buildings
        .iter()
        .find(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.job_capacity > 0)
        })
        .map(|building| building.occupied_tiles[0])
        .expect("small town template must contain a job building");
    snapshot.buildings.retain(|building| {
        building_definition(&building.building_type)
            .is_some_and(|definition| definition.resident_capacity == 0)
    });

    let mut sims = Vec::with_capacity(count);
    let mut index = 1usize;
    while sims.len() < count {
        if !index.is_multiple_of(7) {
            let id = format!("sim-{index:06}");
            let home = Point::from(((index % 8) as i32, ((index / 8) % 8) as i32));
            sims.push(Sim {
                id: id.clone(),
                home,
                position: home,
                routine: CitizenRoutine::Worker {
                    shift_template: "standard".to_string(),
                    workplace: Some(job_tile),
                },
                next_activity: Some(ScheduledActivity {
                    kind: ScheduledActivityKind::DailyRoutine,
                    due_time: 300.0,
                }),
            });
        }
        index += 1;
    }
    snapshot.sims = sims;
    snapshot
}

/// Wave rows: time the two due-wave phases separately, mirroring the tick's
/// demand bridge. `schedule_emit_us` covers the exact-time scheduler emission
/// (`run_due` growth/scheduler pass plus the demand drain) without routing;
/// `route_spawn_us` covers `spawn_pending_trip_demands` over the drained
/// demands (route choice + private-car candidacy per row — the O(due demand)
/// path HPA-348 owns batching for).
fn measure_wave_row(label: &str, count: usize) {
    let mut engine = GameEngine::from_snapshot(wave_snapshot(count)).expect("wave fixture loads");
    assert!(
        engine
            .dispatch(caelum_core::GameIntent::SetPaused { paused: false })
            .applied
    );
    let _ = engine.tick(299.0); // quiet advance to just before the shared wake

    let started = Instant::now();
    let demands = engine.run_due_and_drain_for_scale_harness(2.0);
    let schedule_emit_us = started.elapsed().as_micros();
    assert_eq!(demands.len(), count, "exactly the wave emits demand");

    let started = Instant::now();
    engine.spawn_drained_demands_for_scale_harness(demands);
    let route_spawn_us = started.elapsed().as_micros();

    println!("{label}\tschedule_emit_us={schedule_emit_us}\troute_spawn_us={route_spawn_us}");
}

fn main() {
    let baseline = GameEngine::new().snapshot();
    measure_snapshot("current", &baseline);
    measure_presentation("current", &baseline);

    // HPA-544 presentation-cardinality rows (retained).
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

    // Final HPA-347 runtime rows.
    for count in [10_000, 50_000, 200_000] {
        let mut fixture = baseline.clone();
        fixture.sims = (0..count).map(sim).collect();
        measure_ecs_row(&format!("ecs-{count}"), &fixture, count);
    }

    for count in [1_000, 5_000, 20_000] {
        measure_wave_row(&format!("wave-{count}"), count);
    }
}
