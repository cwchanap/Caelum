//! Shared fixtures for `caelum-core` integration tests.
//!
//! Each integration test file is compiled as its own crate, so shared helpers
//! live here and are pulled in via `mod common;` (with `#[path]` when the test
//! file is not directly under `tests/`).

#![allow(dead_code)]

pub mod persistence_fixtures;

use caelum_core::model::{Heading, Point};
use caelum_core::scenario::{growing_suburb_campaign, growing_suburb_objectives};
use caelum_core::state::create_initial_snapshot;
use caelum_core::{GameEngine, GameIntent, GameSnapshot};

pub fn heading_between(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
    }
}

pub fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

/// Lay hand-authored road tiles with reciprocal edge connections. `one_way`
/// stamps every tile with a one-way heading; `None` keeps them two-way.
pub fn corridor(state: &mut GameSnapshot, points: &[Point], one_way: Option<Heading>) {
    for &position in points {
        let tile = state.map.tile_mut(position).expect("fixture tile exists");
        tile.kind = "road".to_string();
        tile.one_way = one_way;
    }
    for pair in points.windows(2) {
        let heading = heading_between(pair[0], pair[1]);
        state
            .map
            .tile_mut(pair[0])
            .expect("fixture tile exists")
            .road_connections
            .push(heading);
        state
            .map
            .tile_mut(pair[1])
            .expect("fixture tile exists")
            .road_connections
            .push(opposite(heading));
    }
}

/// A campaign-mode `GameSnapshot` for the Growing Suburb scenario with the
/// default objective thresholds and no growth waves. Used by integration tests
/// that need to exercise the campaign objective/metrics path.
pub fn campaign_state() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    state.rules = rules;
    state.scenario = scenario;
    state
}

pub fn strict_engine_from_fixture(mut snapshot: GameSnapshot) -> GameEngine {
    snapshot.paused = true;
    GameEngine::from_snapshot(snapshot).expect("fixture must be persistence-valid")
}

pub fn running_engine_from_fixture(snapshot: GameSnapshot) -> GameEngine {
    let mut engine = strict_engine_from_fixture(snapshot);
    let result = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(result.applied, "fixture must resume: {result:?}");
    assert!(result.rejection.is_none());
    engine
}
