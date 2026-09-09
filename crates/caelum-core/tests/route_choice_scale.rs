//! HPA-348 pre-batching baseline: times route spawning and one post-spawn
//! tick for the shared mixed/stress workload. Not part of the default test
//! run — execute with:
//!
//! ```bash
//! cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
//! ```

mod common;

use std::collections::HashSet;
use std::time::Instant;

use caelum_core::model::TransitMode;
use caelum_core::{GameEngine, GameIntent};
use common::route_choice_fixture::mixed_peak_snapshot;

struct ScaleRow {
    label: &'static str,
    count: usize,
    bus_route_count: usize,
}

const ROWS: [ScaleRow; 4] = [
    ScaleRow {
        label: "mixed-wave-1000",
        count: 1000,
        bus_route_count: 1,
    },
    ScaleRow {
        label: "mixed-wave-5000",
        count: 5000,
        bus_route_count: 1,
    },
    ScaleRow {
        label: "mixed-wave-20000",
        count: 20000,
        bus_route_count: 1,
    },
    ScaleRow {
        label: "transit-stress-20000",
        count: 20000,
        bus_route_count: 7,
    },
];

#[test]
#[ignore]
fn measures_pre_batching_route_spawn_and_post_spawn_tick() {
    for row in ROWS {
        measure_row(row);
    }
}

fn measure_row(row: ScaleRow) {
    let snapshot = mixed_peak_snapshot(row.count, row.bus_route_count);
    let mut engine = GameEngine::from_snapshot(snapshot).expect("fixture loads");
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), row.count, "exactly count demands must drain");
    let spawn_start = Instant::now();
    engine.spawn_drained_demands_for_scale_harness(demands);
    let route_spawn_us = spawn_start.elapsed().as_micros();

    let snapshot = engine.snapshot();
    let services = snapshot
        .transit
        .routes
        .iter()
        .filter(|route| route.active)
        .count()
        + snapshot
            .transit
            .metro_lines
            .iter()
            .filter(|line| line.active)
            .count();
    let mut distinct_od = HashSet::new();
    let (mut walk, mut car, mut bus, mut metro, mut planless) = (0usize, 0, 0, 0, 0);
    for trip in &snapshot.active_trips {
        distinct_od.insert((trip.origin, trip.destination));
        if trip.private_car_trip.is_some() {
            car += 1;
        } else if let Some(plan) = &trip.route_plan {
            if plan.legs.iter().any(|leg| leg.mode == TransitMode::Bus) {
                bus += 1;
            } else if plan.legs.iter().any(|leg| leg.mode == TransitMode::Metro) {
                metro += 1;
            } else {
                walk += 1;
            }
        } else {
            planless += 1;
        }
    }
    let distinct_od = distinct_od.len();

    let tick_start = Instant::now();
    let _ = engine.tick(1.0);
    let post_spawn_tick_us = tick_start.elapsed().as_micros();

    println!(
        "{} count={} services={} distinct_od={} route_spawn_us={} post_spawn_tick_us={} walk={} car={} bus={} metro={} planless={}",
        row.label, row.count, services, distinct_od, route_spawn_us, post_spawn_tick_us,
        walk, car, bus, metro, planless
    );
}
