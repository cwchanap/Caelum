mod common;

use caelum_core::model::TransitMode;
use caelum_core::{GameEngine, GameIntent};
use common::route_choice_fixture::mixed_peak_snapshot;

#[test]
fn mixed_peak_fixture_has_real_car_transit_and_service_stress() {
    let base = mixed_peak_snapshot(128, 1);
    assert_eq!(
        base.transit.routes.len() + base.transit.metro_lines.len(),
        2
    );
    assert!(base
        .transit
        .routes
        .iter()
        .all(|route| route.stop_ids.len() >= 4));
    assert!(base
        .transit
        .metro_lines
        .iter()
        .all(|line| line.station_ids.len() >= 4));

    let mut engine = GameEngine::from_snapshot(base).unwrap();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), 128);
    engine.spawn_drained_demands_for_scale_harness(demands);

    let snapshot = engine.snapshot();
    assert!(snapshot
        .active_trips
        .iter()
        .any(|trip| trip.private_car_trip.is_some()));
    assert!(snapshot.active_trips.iter().any(|trip| {
        trip.route_plan.as_ref().is_some_and(|plan| {
            plan.legs
                .iter()
                .any(|leg| matches!(leg.mode, TransitMode::Bus | TransitMode::Metro))
        })
    }));

    let stress = mixed_peak_snapshot(128, 7);
    assert_eq!(
        stress.transit.routes.len() + stress.transit.metro_lines.len(),
        8
    );
    assert!(stress
        .transit
        .routes
        .iter()
        .all(|route| route.stop_ids.len() >= 4));
    assert!(stress
        .transit
        .metro_lines
        .iter()
        .all(|line| line.station_ids.len() >= 4));
}
