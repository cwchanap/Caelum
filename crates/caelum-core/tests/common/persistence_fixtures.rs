//! Shared engine fixtures for integration tests that need a valid transit state.

#![allow(dead_code)]

use caelum_core::model::{Point, ServicePattern, Sim, TransitMode, WorkerProfile};
use caelum_core::{GameEngine, GameIntent, GameSnapshot, RoadPreset};

/// A minimal paused snapshot (no transit) for tests that only need the shell.
pub fn paused_snapshot() -> GameSnapshot {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.paused = true;
    snapshot
}

/// A paused snapshot with a single bus route (two stops + one vehicle), for
/// route-plan estimation tests.
pub fn fixture_with_bus_route() -> GameSnapshot {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "fixture road should apply: {result:?}");
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        let result = engine.dispatch(GameIntent::AddBusStop { point });
        assert!(result.applied, "fixture stop should apply: {result:?}");
    }
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(result.applied, "fixture route should apply: {result:?}");
    let result = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(result.applied, "fixture vehicle should apply: {result:?}");
    // Engine starts paused; snapshot_for_save enforces paused state.
    engine.snapshot_for_save()
}

/// Construct a worker sim with the given id, home tile, and optional workplace.
pub fn worker_sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}
