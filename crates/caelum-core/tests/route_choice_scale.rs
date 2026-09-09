//! HPA-348 route-choice batching evidence: times batched route spawning and
//! one post-spawn tick for the shared mixed/stress workload and records the
//! batch's final structural counts. Not part of the default test run —
//! execute with:
//!
//! ```bash
//! cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
//! ```

mod common;

use std::collections::HashSet;
use std::time::Instant;

use caelum_core::model::TransitMode;
use caelum_core::{GameEngine, GameIntent, RouteChoiceBatchStats};
use common::route_choice_fixture::mixed_peak_snapshot;

#[derive(Clone, Copy)]
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
fn measures_batched_route_spawn_and_post_spawn_tick() {
    let mut base_shape_count: Option<usize> = None;
    let mut stress_shape_count: Option<usize> = None;
    let mut any_access_paths_strictly_below_od = false;
    for row in ROWS {
        let evidence = measure_row(row);

        let expected_services = if row.bus_route_count == 1 { 2 } else { 8 };
        assert_eq!(
            evidence.stats.transit_service_count, expected_services,
            "{} must plan against {} active services",
            row.label, expected_services
        );
        assert!(
            evidence.stats.transit_shape_count > 0,
            "{} must enumerate batch-invariant route shapes",
            row.label
        );

        let shape_slot = if row.bus_route_count == 1 {
            &mut base_shape_count
        } else {
            &mut stress_shape_count
        };
        match *shape_slot {
            None => *shape_slot = Some(evidence.stats.transit_shape_count),
            Some(previous) => assert_eq!(
                evidence.stats.transit_shape_count, previous,
                "shape cardinality must not depend on demand count for the same service fixture"
            ),
        }

        assert!(
            evidence.stats.car_prepared_access_paths <= evidence.distinct_od,
            "{} prepared access paths are keyed per access pair, never per tile OD",
            row.label
        );
        any_access_paths_strictly_below_od |=
            evidence.stats.car_prepared_access_paths < evidence.distinct_od;
    }
    assert!(
        any_access_paths_strictly_below_od,
        "multi-tile buildings sharing one access pair must collapse several tile ODs onto one prepared path"
    );
}

struct RowEvidence {
    stats: RouteChoiceBatchStats,
    distinct_od: usize,
}

fn measure_row(row: ScaleRow) -> RowEvidence {
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
    let stats = engine.spawn_drained_demands_for_scale_harness(demands);
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
        "{} count={} services={} distinct_od={} route_spawn_us={} post_spawn_tick_us={} walk={} car={} bus={} metro={} planless={} transit_service_count={} transit_shape_count={} transit_flow_refreshes={} car_prepared_access_paths={}",
        row.label, row.count, services, distinct_od, route_spawn_us, post_spawn_tick_us,
        walk, car, bus, metro, planless,
        stats.transit_service_count, stats.transit_shape_count, stats.transit_flow_refreshes,
        stats.car_prepared_access_paths,
    );
    RowEvidence { stats, distinct_od }
}
