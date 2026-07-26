use caelum_core::model::{Point, ServicePattern, TransitMode};
use caelum_core::road::RoadMutation;
use caelum_core::road_topology::RoadTopology;
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadMutationPreviewRequest, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn lay_an_extra_road(engine: &mut GameEngine) {
    let result = engine.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    assert!(result.applied, "fixture road should apply: {result:?}");
}

fn crossing_engine() -> GameEngine {
    GameEngine::new()
}

fn block_partial_stroke_tail(engine: &mut GameEngine) {
    let painted = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: point(4, 2),
        end: point(5, 2),
    });
    assert!(painted.applied, "fixture area should apply: {painted:?}");
    let building = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: point(4, 2),
        rotation: 0,
    });
    assert!(
        building.applied,
        "fixture building should apply: {building:?}"
    );
}

#[test]
fn new_and_reset_cache_match_the_serialized_authored_map() {
    let mut engine = GameEngine::new();
    assert_eq!(
        engine.road_topology_for_test(),
        &RoadTopology::compile(&engine.snapshot().map).unwrap()
    );

    lay_an_extra_road(&mut engine);
    let reset = engine.reset().unwrap();
    assert_eq!(
        engine.road_topology_for_test(),
        &RoadTopology::compile(&reset.map).unwrap()
    );
}

#[test]
fn accepted_network_dispatch_commits_snapshot_and_cache_together() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    assert!(result.applied);
    assert_eq!(
        engine.road_topology_for_test(),
        &RoadTopology::compile(&result.snapshot.map).unwrap()
    );
}

#[test]
fn rejected_direction_change_mutates_neither_snapshot_nor_cache() {
    let mut engine = crossing_engine();
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();
    let result = engine.dispatch(GameIntent::CycleRoadDirection {
        point: point(14, 8),
    });

    assert!(!result.applied);
    assert_eq!(
        result
            .rejection
            .as_ref()
            .map(|rejection| rejection.code.clone()),
        Some(RejectionCode::InvalidDirectionChange)
    );
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}

#[test]
fn partial_stroke_commits_one_topology_for_the_applied_subset() {
    let mut engine = GameEngine::new();
    block_partial_stroke_tail(&mut engine);

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![point(2, 2), point(3, 2), point(4, 2)],
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied);
    assert_eq!(result.context.changed_tiles, vec![point(2, 2), point(3, 2)]);
    assert_eq!(result.context.skipped_tiles, vec![point(4, 2)]);
    assert_eq!(
        engine.road_topology_for_test(),
        &RoadTopology::compile(&result.snapshot.map).unwrap()
    );
}

#[test]
fn previewed_candidate_topology_is_never_committed() {
    let engine = GameEngine::new();
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();

    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2), point(4, 2)],
            preset: RoadPreset::TwoWay,
        },
        generation: 71,
    });

    assert!(response.rejection.is_none());
    assert_eq!(response.changed_tiles.len(), 3);
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}

#[test]
fn exhausted_route_revision_clamps_on_network_mutation_without_rejecting_unrelated_edits() {
    let mut engine = GameEngine::new();
    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=10).map(|x| point(x, 5)).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(road.applied, "{road:?}");
    for x in [2, 10] {
        let stop = engine.dispatch(GameIntent::AddBusStop { point: point(x, 4) });
        assert!(stop.applied, "{stop:?}");
    }
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".into(), "stop-002".into()],
    });
    assert!(route.applied, "{route:?}");
    engine.set_route_revision_for_test("route-001", u32::MAX);

    let result = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });

    assert!(result.applied, "{result:?}");
    assert!(result.rejection.is_none());
    let snapshot = engine.snapshot();
    let route = snapshot
        .transit
        .routes
        .iter()
        .find(|route| route.id == "route-001")
        .expect("route survives network mutation");
    assert_eq!(route.revision, u32::MAX);
    assert!(route.path_broken);
}
