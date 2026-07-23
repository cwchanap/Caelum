use caelum_core::model::{
    GameSnapshot, Heading, MovementKind, Point, Route, RouteLegStatus, ServicePattern, TransitMode,
};
use caelum_core::preview::RoutePreviewRequest;
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture dispatch should apply: rejection={:?}, context={:?}",
        result.rejection, result.context
    );
}

fn route(snapshot: &GameSnapshot) -> &Route {
    snapshot
        .transit
        .routes
        .iter()
        .find(|route| route.id == "route-001")
        .expect("fixture route")
}

fn dual_intersection_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| point(x, 3)).collect(),
            preset: RoadPreset::DualBidirectional,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (0..=7).map(|y| point(6, y)).collect(),
            preset: RoadPreset::DualBidirectional,
        },
    );

    let snapshot = engine.snapshot();
    let junction = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction() && structure.footprint().contains(&point(6, 2))
        })
        .expect("dual roads should generate an automatic junction");
    assert_eq!(
        junction.footprint(),
        &[point(6, 2), point(7, 2), point(6, 3), point(7, 3)]
    );
    assert_eq!(
        junction.port_keys(),
        vec![
            (point(6, 2), Heading::North),
            (point(6, 2), Heading::West),
            (point(6, 3), Heading::South),
            (point(6, 3), Heading::West),
            (point(7, 2), Heading::North),
            (point(7, 2), Heading::East),
            (point(7, 3), Heading::East),
            (point(7, 3), Heading::South),
        ]
    );

    // Keep the stop access tiles two-way while the junction approaches remain
    // dual-bidirectional. The route must still enter the junction on the
    // explicitly selected approach lane, but both service directions can use
    // the same roadside stops.
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (8..=12).map(|x| point(x, 3)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (4..=6).map(|y| point(6, y)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );

    // Stop 001 approaches from the east and stop 002 approaches from the south.
    // Their access tiles exercise horizontal and vertical approaches.
    for stop_point in [point(11, 4), point(5, 6)] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: stop_point });
    }
    engine
}

#[test]
fn dual_bidirectional_route_uses_the_legal_left_turn_and_lane() {
    let mut engine = dual_intersection_engine();
    let snapshot = engine.snapshot();
    let east_stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-001")
        .expect("east roadside stop");
    assert_eq!(east_stop.position, point(11, 4));
    assert_eq!(
        east_stop
            .road_access
            .as_ref()
            .map(|access| access.road_point),
        Some(point(11, 3))
    );
    assert_eq!(
        east_stop
            .road_access
            .as_ref()
            .and_then(|access| access.preferred_heading),
        Some(Heading::East)
    );
    let south_stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-002")
        .expect("south roadside stop");
    assert_eq!(south_stop.position, point(5, 6));
    assert_eq!(
        south_stop
            .road_access
            .as_ref()
            .map(|access| access.road_point),
        Some(point(6, 6))
    );

    let waypoint_ids = vec!["stop-001".to_string(), "stop-002".to_string()];
    let preview = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: waypoint_ids.clone(),
        route_id: None,
        expected_revision: None,
        generation: 17,
    });

    assert!(
        preview.rejection.is_none(),
        "preview should resolve: {preview:?}"
    );
    assert_eq!(preview.legs.len(), 2);
    assert!(preview
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected));

    let first_path = preview.legs[0]
        .current_path
        .as_ref()
        .expect("east-to-south path")
        .road_steps();
    let left_turn = first_path
        .iter()
        .find(|step| step.position == point(7, 3))
        .expect("east-to-south path enters the junction at the east port");
    assert_eq!(left_turn.entering_heading, Heading::West);
    assert_eq!(left_turn.leaving_heading, Heading::South);
    assert_eq!(left_turn.movement, MovementKind::LeftTurn);

    assert!(first_path.iter().all(|step| {
        engine
            .snapshot()
            .map
            .tile(step.position)
            .and_then(|tile| tile.one_way)
            .is_none_or(|heading| heading == step.leaving_heading)
    }));
    let forbidden_parallel_lane_tiles = [point(8, 2), point(7, 2), point(6, 2)];
    assert!(!first_path
        .iter()
        .any(|step| forbidden_parallel_lane_tiles.contains(&step.position)));

    let committed = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids,
    });
    assert!(committed.applied, "route should save: {committed:?}");
    assert_eq!(route(&committed.snapshot).legs, preview.legs);
}

#[test]
fn loop_closing_leg_reports_network_disconnected() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=10).map(|x| point(x, 5)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=10).map(|x| point(x, 11)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for stop_point in [point(2, 4), point(6, 4), point(2, 10)] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: stop_point });
    }

    let preview = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".into(), "stop-002".into(), "stop-003".into()],
        route_id: None,
        expected_revision: None,
        generation: 23,
    });
    let closing = preview
        .legs
        .iter()
        .find(|leg| leg.from_waypoint_id == "stop-003" && leg.to_waypoint_id == "stop-001")
        .expect("Loop closing leg");
    assert_eq!(closing.kind, caelum_core::model::RouteLegKind::Service);
    assert_eq!(
        closing.status,
        RouteLegStatus::NetworkDisconnected,
        "the closing leg must carry the coarse network failure: {closing:?}"
    );
    assert_eq!(
        closing.failure_reason,
        Some(caelum_core::model::LegFailureReason::NetworkDisconnected)
    );
    assert!(preview
        .legs
        .iter()
        .all(|leg| { leg.kind != caelum_core::model::RouteLegKind::TerminalReversal }));
}
