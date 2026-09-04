use caelum_core::heading::{offset, opposite};
use caelum_core::model::{
    GameSnapshot, Heading, MovementKind, Point, Route, RouteLegStatus, ServicePattern, TransitMode,
};
use caelum_core::preview::RoutePreviewRequest;
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn assert_reciprocal_edge(snapshot: &GameSnapshot, point: Point, heading: Heading) {
    let tile = snapshot.map.tile(point).expect("edge origin tile");
    assert!(
        tile.road_connections.contains(&heading),
        "expected {heading:?} edge from {point:?}, got {:?}",
        tile.road_connections
    );
    let neighbor_point = offset(point, heading);
    let neighbor = snapshot
        .map
        .tile(neighbor_point)
        .expect("edge destination tile");
    assert!(
        neighbor.road_connections.contains(&opposite(heading)),
        "expected reciprocal {:?} edge from {neighbor_point:?}, got {:?}",
        opposite(heading),
        neighbor.road_connections
    );
}

fn assert_complete_two_by_two_at(snapshot: &GameSnapshot, top_left: Point) {
    for (point, heading) in [
        (top_left, Heading::East),
        (top_left, Heading::South),
        (point(top_left.x + 1, top_left.y), Heading::South),
        (point(top_left.x, top_left.y + 1), Heading::East),
    ] {
        assert_reciprocal_edge(snapshot, point, heading);
    }
}

fn assert_two_by_two_footprint(snapshot: &GameSnapshot, top_left: Point) {
    let expected = [
        top_left,
        point(top_left.x + 1, top_left.y),
        point(top_left.x, top_left.y + 1),
        point(top_left.x + 1, top_left.y + 1),
    ];
    let junction = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| structure.is_automatic_junction() && structure.footprint() == expected)
        .unwrap_or_else(|| panic!("expected automatic 2x2 junction at {top_left:?}"));
    assert_eq!(junction.footprint(), expected);
}

fn assert_dual_crossing_contract(snapshot: &GameSnapshot, top_left: Point) {
    assert_two_by_two_footprint(snapshot, top_left);
    assert_complete_two_by_two_at(snapshot, top_left);

    let expected_footprint = [
        top_left,
        point(top_left.x + 1, top_left.y),
        point(top_left.x, top_left.y + 1),
        point(top_left.x + 1, top_left.y + 1),
    ];
    let structure = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction() && structure.footprint() == expected_footprint
        })
        .expect("expected 2x2 automatic junction");

    assert_eq!(
        structure.port_keys(),
        vec![
            (top_left, Heading::North),
            (top_left, Heading::West),
            (point(top_left.x, top_left.y + 1), Heading::South),
            (point(top_left.x, top_left.y + 1), Heading::West),
            (point(top_left.x + 1, top_left.y), Heading::North),
            (point(top_left.x + 1, top_left.y), Heading::East),
            (point(top_left.x + 1, top_left.y + 1), Heading::East),
            (point(top_left.x + 1, top_left.y + 1), Heading::South),
        ],
    );
}

fn assert_dual_t_junction_contract(snapshot: &GameSnapshot, top_left: Point) {
    assert_two_by_two_footprint(snapshot, top_left);
    assert_complete_two_by_two_at(snapshot, top_left);

    let expected_footprint = [
        top_left,
        point(top_left.x + 1, top_left.y),
        point(top_left.x, top_left.y + 1),
        point(top_left.x + 1, top_left.y + 1),
    ];
    let structure = snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction() && structure.footprint() == expected_footprint
        })
        .expect("expected 2x2 automatic junction");

    assert_eq!(
        structure.port_keys(),
        vec![
            (top_left, Heading::North),
            (top_left, Heading::West),
            (point(top_left.x, top_left.y + 1), Heading::West),
            (point(top_left.x + 1, top_left.y), Heading::North),
            (point(top_left.x + 1, top_left.y), Heading::East),
            (point(top_left.x + 1, top_left.y + 1), Heading::East),
        ],
    );
}

fn assert_access_path(
    engine: &GameEngine,
    from: Point,
    to: Point,
    from_heading: Heading,
    to_heading: Heading,
) {
    let snapshot = engine.snapshot();
    let path = engine
        .road_topology_for_test()
        .find_path_between_access_tiles(
            &snapshot.map,
            from,
            to,
            Some(from_heading),
            Some(to_heading),
        )
        .unwrap_or_else(|reason| panic!("expected path {from:?} -> {to:?}, got {reason:?}"));
    assert!(!path.road_steps().is_empty());
}

fn blank_grid_engine() -> GameEngine {
    let mut request = caelum_core::canonical_default_request();
    request.template_id = "blankGrid".to_string();
    GameEngine::from_sandbox_request(request)
        .expect("blank grid fixture request should remain valid")
}

fn lay(engine: &mut GameEngine, points: Vec<Point>, preset: RoadPreset) {
    dispatch(engine, GameIntent::LayRoadLine { points, preset });
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture dispatch should apply: rejection={:?}",
        result.rejection
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
    let horizontal_two_way: Vec<_> = (8..=12).map(|x| point(x, 3)).collect();
    dispatch(
        &mut engine,
        GameIntent::RemoveAtTiles {
            points: horizontal_two_way.clone(),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: horizontal_two_way,
            preset: RoadPreset::TwoWay,
        },
    );

    let vertical_two_way: Vec<_> = (4..=6).map(|y| point(6, y)).collect();
    dispatch(
        &mut engine,
        GameIntent::RemoveAtTiles {
            points: vertical_two_way.clone(),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vertical_two_way,
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

fn vertical_first_dual_intersection_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (0..=7).map(|y| point(6, y)).collect(),
            preset: RoadPreset::DualBidirectional,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| point(x, 3)).collect(),
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
    engine
}

// HPA-551 reproduction mapping:
// - horizontal->vertical upgrade: product behavior is now BlockedTile;
//   horizontal_first_dual_intersection_* is the legal topology equivalent.
// - vertical->horizontal upgrade: product behavior is now BlockedTile;
//   vertical_first_dual_intersection_* is the legal topology equivalent.
// - pre-existing OneWay overlay: product behavior is now BlockedTile;
//   clean horizontal-first plus reversed-input tests retain junction evidence.
#[test]
fn horizontal_first_dual_intersection_satisfies_the_full_crossing_contract() {
    let engine = dual_intersection_engine();
    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
    assert_access_path(
        &engine,
        point(5, 3),
        point(8, 3),
        Heading::East,
        Heading::East,
    );
    assert_access_path(
        &engine,
        point(6, 1),
        point(6, 4),
        Heading::South,
        Heading::South,
    );
}

#[test]
fn vertical_first_dual_intersection_satisfies_the_full_crossing_contract() {
    let engine = vertical_first_dual_intersection_engine();
    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
    assert_access_path(
        &engine,
        point(5, 3),
        point(8, 3),
        Heading::East,
        Heading::East,
    );
    assert_access_path(
        &engine,
        point(6, 1),
        point(6, 4),
        Heading::South,
        Heading::South,
    );
}

#[test]
fn reversed_horizontal_stroke_satisfies_the_full_crossing_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=12).rev().map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );

    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
    assert_access_path(
        &engine,
        point(5, 3),
        point(8, 3),
        Heading::East,
        Heading::East,
    );
    assert_access_path(
        &engine,
        point(6, 1),
        point(6, 4),
        Heading::South,
        Heading::South,
    );
}

#[test]
fn reversed_vertical_stroke_satisfies_the_full_crossing_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).rev().map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );

    assert_dual_crossing_contract(&engine.snapshot(), point(6, 2));
    assert_access_path(
        &engine,
        point(5, 3),
        point(8, 3),
        Heading::East,
        Heading::East,
    );
    assert_access_path(
        &engine,
        point(6, 1),
        point(6, 4),
        Heading::South,
        Heading::South,
    );
}

#[test]
fn adjacent_empty_collinear_extension_satisfies_the_full_crossing_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=9).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (10..=12).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );

    let snapshot = engine.snapshot();
    assert_dual_crossing_contract(&snapshot, point(6, 2));
}

#[test]
fn dual_t_junction_at_vertical_endpoint_satisfies_the_t_junction_contract() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (0..=3).map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );

    let snapshot = engine.snapshot();
    assert_dual_t_junction_contract(&snapshot, point(6, 2));
}

#[test]
fn recapture_dual_crossings_with_adjacent_refreshes_have_all_four_internal_edges() {
    let mut engine = blank_grid_engine();
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 3)).collect(),
        RoadPreset::DualBidirectional,
    );
    // y=5 merges the two crossings into one 2x4 automatic junction, so the
    // nearest separate-junction variant leaves one vertical-only row at y=4.
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 6)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).map(|y| point(6, y)).collect(),
        RoadPreset::DualBidirectional,
    );

    let snapshot = engine.snapshot();
    assert_two_by_two_footprint(&snapshot, point(6, 2));
    assert_complete_two_by_two_at(&snapshot, point(6, 2));
    assert_two_by_two_footprint(&snapshot, point(6, 5));
    assert_complete_two_by_two_at(&snapshot, point(6, 5));
}

#[test]
fn recapture_crossroads_starter_beside_dual_crossing_has_all_four_internal_edges() {
    let mut engine = GameEngine::new();
    lay(
        &mut engine,
        (2..=12).map(|x| point(x, 6)).collect(),
        RoadPreset::DualBidirectional,
    );
    lay(
        &mut engine,
        (0..=7).map(|y| point(10, y)).collect(),
        RoadPreset::DualBidirectional,
    );

    let snapshot = engine.snapshot();
    assert_two_by_two_footprint(&snapshot, point(10, 5));
    assert_complete_two_by_two_at(&snapshot, point(10, 5));
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
    assert_eq!(route(&engine.snapshot()).legs, preview.legs);
}

#[test]
fn loop_closing_leg_reports_network_disconnected() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| point(x, 5)).collect(),
            preset: RoadPreset::OneWay,
        },
    );
    for stop_point in [point(2, 4), point(6, 4), point(10, 4)] {
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
    let non_closing: Vec<_> = preview
        .legs
        .iter()
        .filter(|leg| !(leg.from_waypoint_id == "stop-003" && leg.to_waypoint_id == "stop-001"))
        .collect();
    assert!(
        !non_closing.is_empty(),
        "expected at least one non-closing service leg: {preview:?}",
    );
    for leg in &non_closing {
        assert_eq!(
            leg.status,
            RouteLegStatus::Connected,
            "non-closing legs should be connected on the one-way east road: {leg:?}",
        );
    }
}
