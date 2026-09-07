//! Shared engine fixtures for integration tests that need a valid transit state.

#![allow(dead_code)]

use caelum_core::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use caelum_core::commute::departure_minute_for_sim;
use caelum_core::model::{
    CitizenRoutine, Point, ScheduledActivity, ScheduledActivityKind, ServicePattern, Sim,
    TransitMode,
};
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

/// The citizen's canonical day-0 outbound departure as a `DailyRoutine` wake:
/// the exact schedule an idle fixture Worker carries, matching what the
/// scheduler would derive for a fresh day-0 commuter.
fn day0_outbound_wake(sim_id: &str) -> ScheduledActivity {
    ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: f64::from(departure_minute_for_sim(sim_id, "standard", "outbound"))
            / f64::from(MINUTES_PER_DAY)
            * GAME_DAY_SECONDS,
    }
}

/// A travelling Worker anchor: no next activity, because an active (hand-
/// authored) trip owns the citizen until it resolves. Pair with an active trip
/// for the same id.
pub fn travelling_worker_sim(id: &str, home: Point) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: None,
        },
        next_activity: None,
    }
}

/// An idle Worker with the given workplace and a standard day-0 outbound
/// wake, so a resumed engine spawns their commute exactly like a live commuter.
pub fn worker_sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace,
        },
        next_activity: Some(day0_outbound_wake(id)),
    }
}
