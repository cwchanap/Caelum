use caelum_core::model::{
    Heading, Point, RoadStructure, RoundaboutSize, Route, ServicePattern, TransitMode,
};
use caelum_core::preview::{
    RoadMutationPreviewRequest, RouteImpact, RouteImpactKind, RoutePreviewRequest,
};
use caelum_core::road::RoadMutation;
use caelum_core::transit::BUS_COST;
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "fixture dispatch should apply: {result:?}");
}

fn road_line(engine: &mut GameEngine, points: Vec<Point>) {
    dispatch(
        engine,
        GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        },
    );
}

fn editable_network_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    for x in [2, 10] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 5) });
    }
    engine
}

fn existing_route_engine() -> GameEngine {
    let mut engine = editable_network_engine();
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: ids(&["stop-001", "stop-002"]),
        },
    );
    engine
}

fn valid_route_preview(generation: u64) -> RoutePreviewRequest {
    RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
        route_id: None,
        expected_revision: None,
        generation,
    }
}

fn newest_route(snapshot: &caelum_core::GameSnapshot) -> &Route {
    snapshot.transit.routes.last().expect("fixture route")
}

#[test]
fn preview_and_committed_route_use_identical_leg_paths() {
    let mut engine = editable_network_engine();
    let request = valid_route_preview(9);
    let preview = engine.preview_route(request.clone());
    assert_eq!(preview.generation, 9);
    assert!(preview.rejection.is_none(), "{preview:?}");

    let committed = engine.dispatch(GameIntent::CreateRoute {
        mode: request.mode,
        pattern: request.pattern,
        waypoint_ids: request.waypoint_ids,
    });
    assert_eq!(newest_route(&committed.snapshot).legs, preview.legs);
}

#[test]
fn both_preview_methods_leave_snapshot_and_cache_unchanged() {
    let engine = editable_network_engine();
    let snapshot = engine.snapshot();
    let topology = engine.road_topology_for_test().clone();

    let _ = engine.preview_route(valid_route_preview(4));
    let _ = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(3, 3) },
        generation: 12,
    });

    assert_eq!(engine.snapshot(), snapshot);
    assert_eq!(engine.road_topology_for_test(), &topology);
}

#[test]
fn mutation_preview_reports_applied_subset_cost_and_route_impacts() {
    let engine = existing_route_engine();
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::RemoveAtTiles {
            points: vec![point(6, 5), point(7, 5), point(20, 3)],
        },
        generation: 17,
    });

    assert_eq!(response.generation, 17);
    assert_eq!(response.changed_tiles, vec![point(6, 5), point(7, 5)]);
    assert_eq!(response.skipped_tiles, vec![point(20, 3)]);
    assert_eq!(response.cost, 0);
    assert_eq!(
        response
            .authored_tiles
            .iter()
            .map(|tile| tile.point)
            .collect::<Vec<_>>(),
        vec![point(6, 5), point(7, 5)]
    );
    assert!(response
        .authored_tiles
        .iter()
        .all(|tile| tile.road_connections.is_empty()));
    assert_eq!(
        response.route_impacts,
        vec![RouteImpact {
            route_id: "route-001".into(),
            kind: RouteImpactKind::Broken,
        }]
    );
}

#[test]
fn roundabout_preview_matches_commit_footprint_cost_structure_and_route_impact() {
    let mut engine = existing_route_engine();
    let request = RoadMutationPreviewRequest {
        mutation: RoadMutation::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
        generation: 41,
    };
    let preview = engine.preview_road_mutation(request);
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert_eq!(preview.generation, 41);
    assert_eq!(preview.cost, 2_000);
    assert_eq!(preview.changed_tiles.len(), 9);
    assert_eq!(preview.generated_structures.len(), 1);
    assert!(matches!(
        preview.generated_structures[0],
        RoadStructure::Roundabout { .. }
    ));
    assert_eq!(
        preview.route_impacts,
        vec![RouteImpact {
            route_id: "route-001".into(),
            kind: RouteImpactKind::Rerouted,
        }]
    );

    let committed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: point(5, 4),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(committed.applied, "{committed:?}");
    assert_eq!(committed.context.changed_tiles, preview.changed_tiles);
    assert_eq!(committed.context.cost, preview.cost);
    assert_eq!(
        committed.context.affected_route_ids,
        preview
            .route_impacts
            .iter()
            .map(|impact| impact.route_id.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn route_preview_returns_typed_validation_with_generation() {
    let mut engine = editable_network_engine();
    dispatch(&mut engine, GameIntent::LayRoad { point: point(2, 2) });
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 2) });
    dispatch(&mut engine, GameIntent::LayTrack { point: point(3, 3) });
    dispatch(
        &mut engine,
        GameIntent::AddMetroStation { point: point(3, 3) },
    );

    let cases = [
        (ids(&["stop-001"]), 21, RejectionCode::TooFewRouteNodes),
        (
            ids(&["stop-001", "stop-001"]),
            22,
            RejectionCode::DuplicateRouteNodes,
        ),
        (
            ids(&["stop-001", "missing"]),
            23,
            RejectionCode::MissingRouteNode,
        ),
        (
            ids(&["stop-001", "station-001"]),
            24,
            RejectionCode::IncompatibleRouteNode,
        ),
        (
            ids(&["stop-001", "stop-003"]),
            25,
            RejectionCode::DisconnectedLeg,
        ),
    ];

    for (waypoint_ids, generation, code) in cases {
        let response = engine.preview_route(RoutePreviewRequest {
            waypoint_ids,
            generation,
            ..valid_route_preview(generation)
        });
        assert_eq!(response.generation, generation);
        assert_eq!(response.rejection.expect("typed rejection").code, code);
    }
}

#[test]
fn route_preview_reports_cost_affordability_and_revision_context() {
    let mut engine = editable_network_engine();
    engine.set_budget_for_test(BUS_COST - 1);
    let response = engine.preview_route(RoutePreviewRequest {
        expected_revision: Some(4),
        generation: 31,
        ..valid_route_preview(31)
    });

    assert_eq!(response.initial_vehicle_cost, BUS_COST);
    assert!(!response.affordable);
    assert_eq!(
        response
            .rejection
            .expect("budget rejection")
            .context
            .expected_revision,
        Some(4)
    );
}

#[test]
fn edit_preview_is_free_and_rejects_stale_revision_with_full_context() {
    let engine = existing_route_engine();
    let response = engine.preview_route(RoutePreviewRequest {
        route_id: Some("route-001".into()),
        expected_revision: Some(4),
        generation: 34,
        ..valid_route_preview(34)
    });

    assert_eq!(response.initial_vehicle_cost, 0);
    assert!(response.affordable);
    let rejection = response.rejection.expect("stale revision rejection");
    assert_eq!(rejection.code, RejectionCode::RouteChangedWhileEditing);
    assert_eq!(rejection.context.route_id.as_deref(), Some("route-001"));
    assert_eq!(rejection.context.expected_revision, Some(4));
    assert_eq!(rejection.context.actual_revision, Some(0));
}

fn alternate_path_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=5).map(|x| point(x, 4)).collect());
    road_line(&mut engine, (7..=10).map(|x| point(x, 4)).collect());
    road_line(&mut engine, (2..=10).map(|x| point(x, 6)).collect());
    road_line(&mut engine, (4..=6).map(|y| point(2, y)).collect());
    road_line(&mut engine, (4..=6).map(|y| point(10, y)).collect());
    road_line(&mut engine, (2..=3).map(|y| point(6, y)).collect());
    road_line(&mut engine, (5..=6).map(|y| point(6, y)).collect());
    for x in [2, 10] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 4) });
    }
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: ids(&["stop-001", "stop-002"]),
        },
    );
    engine
}

#[test]
fn road_preview_reports_generated_junction_and_stable_reroute_impact() {
    let engine = alternate_path_engine();
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(6, 4) },
        generation: 32,
    });
    assert!(response.rejection.is_none(), "{response:?}");
    assert!(response
        .generated_structures
        .iter()
        .any(RoadStructure::is_automatic_junction));
    assert_eq!(
        response.route_impacts,
        vec![RouteImpact {
            route_id: "route-001".into(),
            kind: RouteImpactKind::Rerouted,
        }]
    );
}

#[test]
fn road_preview_preserves_candidate_connection_order() {
    let engine = GameEngine::new();
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2), point(4, 2)],
            preset: RoadPreset::TwoWay,
        },
        generation: 33,
    });
    assert_eq!(
        response.authored_tiles[1].road_connections,
        vec![Heading::West, Heading::East]
    );
}

#[test]
fn unaffordable_road_preview_preserves_required_cost_and_engine_state() {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(99);
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();

    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(2, 2) },
        generation: 81,
    });

    assert_eq!(response.generation, 81);
    assert_eq!(response.cost, 100);
    let rejection = response.rejection.expect("budget rejection");
    assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
    assert_eq!(rejection.context.required_budget, Some(100));
    assert_eq!(rejection.context.available_budget, Some(99));
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}
