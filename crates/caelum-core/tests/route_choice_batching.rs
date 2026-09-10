mod common;

use caelum_core::model::TransitMode;
use caelum_core::{GameEngine, GameIntent};
use common::route_choice_fixture::mixed_peak_snapshot;

/// Spawn `count` same-time demands for a mixed-peak configuration and assert
/// the fixture exercises every route-choice class independently — walk-only,
/// private-car, Bus, and Metro — with zero planless trips. Splitting the
/// transit modes (rather than `Bus | Metro`) ensures neither can disappear
/// silently under a routing regression.
fn assert_mixed_peak_composition(count: usize, bus_route_count: usize, expected_services: usize) {
    let snapshot = mixed_peak_snapshot(count, bus_route_count);
    assert_eq!(
        snapshot.transit.routes.len() + snapshot.transit.metro_lines.len(),
        expected_services
    );
    assert!(snapshot
        .transit
        .routes
        .iter()
        .all(|route| route.stop_ids.len() >= 4));
    assert!(snapshot
        .transit
        .metro_lines
        .iter()
        .all(|line| line.station_ids.len() >= 4));

    let mut engine = GameEngine::from_snapshot(snapshot).unwrap();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), count);
    engine.spawn_drained_demands_for_scale_harness(demands);

    let mut walk_only = 0usize;
    let mut private_car = 0usize;
    let mut bus = 0usize;
    let mut metro = 0usize;
    let mut planless = 0usize;
    for trip in &engine.snapshot().active_trips {
        if trip.private_car_trip.is_some() {
            private_car += 1;
            continue;
        }
        match &trip.route_plan {
            None => planless += 1,
            Some(plan) => {
                let has_bus = plan
                    .legs
                    .iter()
                    .any(|leg| matches!(leg.mode, TransitMode::Bus));
                let has_metro = plan
                    .legs
                    .iter()
                    .any(|leg| matches!(leg.mode, TransitMode::Metro));
                if has_bus {
                    bus += 1;
                }
                if has_metro {
                    metro += 1;
                }
                if !has_bus && !has_metro {
                    walk_only += 1;
                }
            }
        }
    }

    assert!(
        walk_only > 0,
        "({count}, {bus_route_count}) walk-only choices"
    );
    assert!(
        private_car > 0,
        "({count}, {bus_route_count}) private-car choices"
    );
    assert!(bus > 0, "({count}, {bus_route_count}) bus choices");
    assert!(metro > 0, "({count}, {bus_route_count}) metro choices");
    assert_eq!(planless, 0, "({count}, {bus_route_count}) planless trips");
}

#[test]
fn mixed_peak_fixture_has_real_car_transit_and_service_stress() {
    assert_mixed_peak_composition(128, 1, 2);
    assert_mixed_peak_composition(128, 7, 8);

    // Batched spawn must preserve the canonical sim order: the drained
    // demands arrive in fixture sim order and every spawned trip (driving,
    // transit, or planless) keeps that order in `active_trips`.
    let expected = mixed_peak_snapshot(256, 1);
    let expected_sim_order: Vec<String> = expected.sims.iter().map(|sim| sim.id.clone()).collect();
    let mut engine = GameEngine::from_snapshot(expected).unwrap();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), 256);
    engine.spawn_drained_demands_for_scale_harness(demands);
    let spawned_sim_order: Vec<String> = engine
        .snapshot()
        .active_trips
        .iter()
        .map(|trip| trip.sim_id.clone())
        .collect();
    assert_eq!(spawned_sim_order, expected_sim_order);
}
