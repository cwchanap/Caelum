use caelum_core::model::{
    EconomyPreset, Heading, LegFailureReason, Point, RoadStructure, RoundaboutSize, Route,
    RouteLegKind, RouteLegStatus, ServicePattern, TransitMode,
};
use caelum_core::preview::{
    RoadMutationPreviewRequest, RouteImpact, RouteImpactKind, RoutePreviewRequest,
};
use caelum_core::road::RoadMutation;
use caelum_core::transit::ROAD_COST;
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
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 4) });
    }
    engine
}

fn editable_metro_network_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayTrackLine {
            points: (2..=10).map(|x| point(x, 5)).collect(),
        },
    );
    for x in [2, 10] {
        dispatch(
            &mut engine,
            GameIntent::AddMetroStation { point: point(x, 5) },
        );
    }
    engine
}

fn disconnected_metro_network_engine() -> GameEngine {
    let mut engine = editable_metro_network_engine();
    dispatch(
        &mut engine,
        GameIntent::LayTrackLine {
            points: (2..=10).map(|x| point(x, 12)).collect(),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::AddMetroStation {
            point: point(2, 12),
        },
    );
    engine
}

fn engine_for(
    snapshot: &caelum_core::GameSnapshot,
    preset: EconomyPreset,
    budget: i32,
) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).expect("fixture snapshot should be valid")
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

fn valid_metro_route_preview(generation: u64) -> RoutePreviewRequest {
    RoutePreviewRequest {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["station-001", "station-002"]),
        route_id: None,
        expected_revision: None,
        generation,
    }
}

fn newest_route(snapshot: &caelum_core::GameSnapshot) -> &Route {
    snapshot.transit.routes.last().expect("fixture route")
}

fn shared_access_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=6).map(|x| point(x, 5)).collect());
    for point in [point(3, 4), point(3, 6)] {
        dispatch(&mut engine, GameIntent::AddBusStop { point });
    }
    let mut snapshot = engine.snapshot();
    for stop in &mut snapshot.transit.stops {
        stop.road_access
            .as_mut()
            .expect("shared-access fixture stop")
            .preferred_heading = None;
    }
    GameEngine::from_snapshot(snapshot).expect("shared-access fixture snapshot")
}

fn shared_access_existing_route_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=14).map(|x| point(x, 5)).collect());
    for point in [point(3, 4), point(3, 6), point(10, 4)] {
        dispatch(&mut engine, GameIntent::AddBusStop { point });
    }
    let mut snapshot = engine.snapshot().clone();
    for stop_id in ["stop-001", "stop-002"] {
        snapshot
            .transit
            .stops
            .iter_mut()
            .find(|stop| stop.id == stop_id)
            .expect("shared-access fixture stop")
            .road_access
            .as_mut()
            .expect("shared-access fixture access")
            .preferred_heading = None;
    }
    GameEngine::from_snapshot(snapshot).expect("shared-access route fixture snapshot")
}

fn assert_exact_leg_shape(
    preview: &caelum_core::model::RouteLegPath,
    committed: &caelum_core::model::RouteLegPath,
) {
    assert_eq!(preview.key(), committed.key());
    assert_eq!(preview.status, committed.status);
    assert_eq!(preview.failure_reason, committed.failure_reason);
    assert_eq!(preview.estimated_seconds, committed.estimated_seconds);
    assert_eq!(preview.current_path, committed.current_path);
    assert_eq!(preview.last_valid_path, committed.last_valid_path);
    match (&preview.current_path, &committed.current_path) {
        (Some(preview_path), Some(committed_path)) => {
            assert_eq!(
                preview_path.total_travel_seconds(),
                committed_path.total_travel_seconds()
            );
            assert_eq!(preview_path.road_steps(), committed_path.road_steps());
        }
        (None, None) => {}
        _ => panic!("preview and commit disagree on path presence"),
    }
}

#[test]
fn preview_and_committed_route_use_identical_leg_paths() {
    let mut engine = editable_network_engine();
    let request = valid_route_preview(9);
    let preview = engine.preview_route(request.clone());
    assert_eq!(preview.generation, 9);
    assert!(preview.rejection.is_none(), "{preview:?}");

    let _committed = engine.dispatch(GameIntent::CreateRoute {
        mode: request.mode,
        pattern: request.pattern,
        waypoint_ids: request.waypoint_ids,
    });
    assert_eq!(newest_route(&engine.snapshot()).legs, preview.legs);
}

#[test]
fn shared_access_shuttle_preview_and_commit_match_zero_step_terminal_legs() {
    let mut engine = shared_access_engine();
    let request = RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
        route_id: None,
        expected_revision: None,
        generation: 10,
    };

    let preview = engine.preview_route(request.clone());
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert_eq!(preview.legs.len(), 4);
    for leg in &preview.legs {
        assert_eq!(leg.status, RouteLegStatus::Connected);
        assert_eq!(leg.failure_reason, None);
        assert!(leg.current_path.is_some());
        assert_eq!(leg.estimated_seconds, Some(0.0));
        assert_eq!(
            leg.current_path
                .as_ref()
                .expect("zero-step path")
                .step_count(),
            0
        );
    }
    assert!(preview
        .legs
        .iter()
        .any(|leg| leg.kind == RouteLegKind::TerminalReversal));

    let committed = engine.dispatch(GameIntent::CreateRoute {
        mode: request.mode,
        pattern: request.pattern,
        waypoint_ids: request.waypoint_ids,
    });
    assert!(committed.applied, "{committed:?}");
    let snapshot = engine.snapshot();
    let committed_legs = &newest_route(&snapshot).legs;
    assert_eq!(preview.total_travel_seconds, 0.0);
    assert_eq!(
        preview.total_travel_seconds,
        committed_legs
            .iter()
            .filter_map(|leg| leg.estimated_seconds)
            .sum::<f64>()
    );
    assert_eq!(preview.legs.len(), committed_legs.len());
    for (preview_leg, committed_leg) in preview.legs.iter().zip(committed_legs) {
        assert_exact_leg_shape(preview_leg, committed_leg);
    }
}

#[test]
fn existing_route_update_preview_and_commit_match_failures_and_zero_step_legs() {
    let mut engine = shared_access_existing_route_engine();
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Shuttle,
            waypoint_ids: ids(&["stop-001", "stop-002", "stop-003"]),
        },
    );
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(6, 5) });
    let route = newest_route(&engine.snapshot()).clone();
    assert!(route.path_broken);

    let request = RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: route.pattern,
        waypoint_ids: route.stop_ids.clone(),
        route_id: Some(route.id.clone()),
        expected_revision: Some(route.revision),
        generation: 91,
    };
    let preview = engine.preview_route(request.clone());
    assert!(preview.rejection.is_none(), "{preview:?}");
    let failed_leg = preview
        .legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NetworkDisconnected))
        .expect("broken corridor should retain its typed failure reason");
    assert_eq!(failed_leg.status, RouteLegStatus::NetworkDisconnected);
    assert!(preview.legs.iter().any(|leg| {
        leg.current_path
            .as_ref()
            .is_some_and(|path| path.step_count() == 0)
    }));

    let committed = engine.dispatch(GameIntent::UpdateRoute {
        route_id: request.route_id.expect("existing route"),
        expected_revision: request.expected_revision.expect("route revision"),
        pattern: request.pattern,
        waypoint_ids: request.waypoint_ids,
    });
    assert!(committed.rejection.is_none(), "{committed:?}");
    let snapshot = engine.snapshot();
    let committed_legs = &newest_route(&snapshot).legs;
    assert_eq!(preview.legs.len(), committed_legs.len());
    for (preview_leg, committed_leg) in preview.legs.iter().zip(committed_legs) {
        assert_exact_leg_shape(preview_leg, committed_leg);
    }
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
    assert_eq!(
        response.changed_tiles,
        vec![point(6, 5), point(7, 5), point(5, 5), point(8, 5)]
    );
    assert_eq!(response.skipped_tiles, vec![point(20, 3)]);
    assert_eq!(response.cost, 0);
    assert_eq!(
        response
            .authored_tiles
            .iter()
            .map(|tile| tile.point)
            .collect::<Vec<_>>(),
        vec![point(6, 5), point(7, 5), point(5, 5), point(8, 5)]
    );
    assert_eq!(response.authored_tiles[0].road_connections, vec![]);
    assert_eq!(response.authored_tiles[1].road_connections, vec![]);
    assert_eq!(
        response.authored_tiles[2].road_connections,
        vec![Heading::West]
    );
    assert_eq!(
        response.authored_tiles[3].road_connections,
        vec![Heading::East]
    );
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
    let before_budget = engine.snapshot().budget;
    let before_structure_count = engine.snapshot().map.road_structures.len();
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
    let before_route = newest_route(&engine.snapshot()).clone();

    let committed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: point(5, 4),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(committed.applied, "{committed:?}");
    assert_eq!(engine.snapshot().budget, before_budget - preview.cost);
    assert_eq!(
        engine.snapshot().map.road_structures.len(),
        before_structure_count + preview.generated_structures.len()
    );
    assert_eq!(
        newest_route(&engine.snapshot()).revision,
        before_route.revision + 1
    );
}

#[test]
fn already_broken_route_still_reports_a_changed_connected_leg_with_commit_parity() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=20).map(|x| point(x, 5)).collect());
    for x in [2, 10, 20] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 4) });
    }
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: ids(&["stop-001", "stop-002", "stop-003"]),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::RemoveAtTile {
            point: point(15, 5),
        },
    );
    let before = newest_route(&engine.snapshot()).clone();
    assert!(before.path_broken);
    assert_eq!(
        before.legs[0].status,
        caelum_core::model::RouteLegStatus::Connected
    );
    assert_ne!(
        before.legs[1].status,
        caelum_core::model::RouteLegStatus::Connected
    );

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 53,
        mutation: RoadMutation::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert_eq!(
        preview.route_impacts,
        vec![RouteImpact {
            route_id: before.id.clone(),
            kind: RouteImpactKind::Rerouted,
        }]
    );

    let committed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: point(5, 4),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(committed.applied, "{committed:?}");
    let snapshot = engine.snapshot();
    let after = newest_route(&snapshot);
    assert_eq!(after.revision, before.revision + 1);
    assert!(after.path_broken);
    assert_eq!(
        after.legs[0].status,
        caelum_core::model::RouteLegStatus::Connected
    );
    assert_ne!(after.legs[0].current_path, before.legs[0].current_path);
    assert_ne!(
        after.legs[1].status,
        caelum_core::model::RouteLegStatus::Connected
    );
}

// Regression: once a leg is disconnected, raw resolve drops `last_valid_path`.
// Preview must merge candidate legs with stored history so an unrelated road
// mutation does not falsely report `Rerouted` while commit leaves the route
// unchanged.
#[test]
fn unrelated_road_preview_does_not_reroute_already_broken_route() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=20).map(|x| point(x, 5)).collect());
    for x in [2, 10, 20] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 4) });
    }
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: ids(&["stop-001", "stop-002", "stop-003"]),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::RemoveAtTile {
            point: point(15, 5),
        },
    );
    let before = newest_route(&engine.snapshot()).clone();
    assert!(before.path_broken);
    assert!(before.legs.iter().any(|leg| {
        leg.status != caelum_core::model::RouteLegStatus::Connected && leg.last_valid_path.is_some()
    }));

    // Road far from the route corridor: commit must leave the broken route
    // (including last_valid_path history) identical.
    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 61,
        mutation: RoadMutation::LayRoad {
            point: point(3, 12),
        },
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert!(
        preview.route_impacts.is_empty(),
        "unrelated road must not classify a broken route as rerouted: {:?}",
        preview.route_impacts
    );

    let committed = engine.dispatch(GameIntent::LayRoad {
        point: point(3, 12),
    });
    assert!(committed.applied, "{committed:?}");
    let snapshot = engine.snapshot();
    let after = newest_route(&snapshot);
    assert_eq!(after.legs, before.legs);
    assert_eq!(after.revision, before.revision);
}

#[test]
fn whole_roundabout_removal_preview_matches_commit_and_route_revision() {
    let mut engine = existing_route_engine();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    );
    let before = newest_route(&engine.snapshot()).clone();
    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 54,
        mutation: RoadMutation::RemoveAtTile { point: point(6, 5) },
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert_eq!(preview.changed_tiles.len(), 11);
    assert_eq!(
        preview.route_impacts,
        vec![RouteImpact {
            route_id: before.id.clone(),
            kind: RouteImpactKind::Broken,
        }]
    );

    let committed = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });
    assert!(committed.applied, "{committed:?}");
    let snapshot = engine.snapshot();
    let after = newest_route(&snapshot);
    assert_eq!(after.revision, before.revision + 1);
    assert!(after.path_broken);
}

#[test]
fn route_preview_returns_typed_validation_with_generation() {
    let mut engine = editable_network_engine();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vec![point(2, 2), point(3, 2)],
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 1) });
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
fn metro_preview_is_geometry_only_with_zero_budget() {
    let mut engine = editable_metro_network_engine();
    engine.set_budget_for_test(0);
    let response = engine.preview_route(RoutePreviewRequest {
        expected_revision: Some(4),
        generation: 31,
        ..valid_metro_route_preview(31)
    });

    assert!(!response.legs.is_empty(), "{response:?}");
    assert!(response
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected));
    assert!(response.rejection.is_none(), "{response:?}");
    let wire = serde_json::to_value(&response).expect("preview serializes");
    assert!(wire.get("initialVehicleCost").is_none());
    assert!(wire.get("affordable").is_none());
}

#[test]
fn metro_preview_reports_disconnected_geometry_without_budget_rejection() {
    let mut engine = disconnected_metro_network_engine();
    engine.set_budget_for_test(0);

    let response = engine.preview_route(RoutePreviewRequest {
        waypoint_ids: ids(&["station-001", "station-003"]),
        generation: 40,
        ..valid_metro_route_preview(40)
    });

    let rejection = response.rejection.expect("disconnected-leg rejection");
    assert_eq!(rejection.code, RejectionCode::DisconnectedLeg);
}

#[test]
fn metro_preview_geometry_is_independent_of_economy_preset_and_early_returns() {
    let prepared = editable_metro_network_engine().snapshot();
    let standard = engine_for(&prepared, EconomyPreset::Standard, 0);
    let creative = engine_for(&prepared, EconomyPreset::Creative, 0);
    let standard_preview = standard.preview_route(valid_metro_route_preview(61));
    let creative_preview = creative.preview_route(valid_metro_route_preview(61));

    assert!(standard_preview.rejection.is_none(), "{standard_preview:?}");
    assert!(creative_preview.rejection.is_none(), "{creative_preview:?}");
    assert_eq!(standard_preview.legs, creative_preview.legs);

    let standard_early = standard.preview_route(RoutePreviewRequest {
        waypoint_ids: ids(&["station-001"]),
        generation: 62,
        ..valid_metro_route_preview(62)
    });
    let creative_early = creative.preview_route(RoutePreviewRequest {
        waypoint_ids: ids(&["station-001"]),
        generation: 62,
        ..valid_metro_route_preview(62)
    });
    assert_eq!(
        standard_early
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::TooFewRouteNodes),
    );
    assert_eq!(standard_early.rejection, creative_early.rejection);
}

#[test]
fn metro_preview_preserves_failure_and_edit_revision_behavior_at_zero_budget() {
    let prepared = disconnected_metro_network_engine().snapshot();
    let standard = engine_for(&prepared, EconomyPreset::Standard, 0);
    let creative = engine_for(&prepared, EconomyPreset::Creative, 0);
    let request = RoutePreviewRequest {
        waypoint_ids: ids(&["station-001", "station-003"]),
        generation: 63,
        ..valid_metro_route_preview(63)
    };
    let standard_preview = standard.preview_route(request.clone());
    let creative_preview = creative.preview_route(request);

    assert_eq!(
        standard_preview
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::DisconnectedLeg),
    );
    assert_eq!(standard_preview.rejection, creative_preview.rejection);

    let existing = existing_route_engine().snapshot();
    let standard_edit = engine_for(&existing, EconomyPreset::Standard, 0);
    let creative_edit = engine_for(&existing, EconomyPreset::Creative, 0);
    let edit = RoutePreviewRequest {
        route_id: Some("route-001".into()),
        expected_revision: Some(4),
        generation: 64,
        ..valid_route_preview(64)
    };
    let standard_edit_preview = standard_edit.preview_route(edit.clone());
    let creative_edit_preview = creative_edit.preview_route(edit);
    assert_eq!(
        standard_edit_preview.rejection,
        creative_edit_preview.rejection
    );
    assert_eq!(
        standard_edit_preview
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::RouteChangedWhileEditing),
    );
}

#[test]
fn edit_preview_rejects_stale_revision_with_full_context() {
    let engine = existing_route_engine();
    let response = engine.preview_route(RoutePreviewRequest {
        route_id: Some("route-001".into()),
        expected_revision: Some(4),
        generation: 34,
        ..valid_route_preview(34)
    });

    let rejection = response.rejection.expect("stale revision rejection");
    assert_eq!(rejection.code, RejectionCode::RouteChangedWhileEditing);
    assert_eq!(rejection.context.route_id.as_deref(), Some("route-001"));
    assert_eq!(rejection.context.expected_revision, Some(4));
    assert_eq!(rejection.context.actual_revision, Some(0));
}

#[test]
fn retained_tombstone_is_missing_in_preview_but_edit_save_is_allowed() {
    let mut engine = existing_route_engine();
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(2, 4) });
    let before = engine.snapshot();
    let route = newest_route(&before).clone();
    assert_eq!(
        before.transit.stops[0].status,
        caelum_core::model::TransitNodeStatus::Missing
    );

    let preview = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: route.pattern,
        waypoint_ids: route.stop_ids.clone(),
        route_id: Some(route.id.clone()),
        expected_revision: Some(route.revision),
        generation: 82,
    });

    assert_eq!(preview.missing_waypoint_ids, vec!["stop-001"]);
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert!(preview
        .warnings
        .iter()
        .any(|warning| warning.code == caelum_core::preview::WarningCode::ExistingBrokenLeg));

    let committed = engine.dispatch(GameIntent::UpdateRoute {
        route_id: route.id,
        expected_revision: route.revision,
        pattern: route.pattern,
        waypoint_ids: route.stop_ids,
    });
    assert!(committed.rejection.is_none(), "{committed:?}");
    assert!(newest_route(&engine.snapshot()).path_broken);
    assert_eq!(
        engine.snapshot().transit.stops[0].status,
        caelum_core::model::TransitNodeStatus::Missing
    );
}

#[test]
fn edit_preview_and_commit_reject_newly_introduced_missing_nodes() {
    let mut engine = existing_route_engine();
    // Third present stop on the existing corridor so a second route can try to
    // introduce route-001's tombstone as a brand-new waypoint.
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(6, 4) });
    dispatch(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: ids(&["stop-002", "stop-003"]),
        },
    );
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(2, 4) });
    let snapshot = engine.snapshot();
    let route = snapshot
        .transit
        .routes
        .iter()
        .find(|route| route.id == "route-002")
        .expect("second route")
        .clone();
    assert_eq!(
        snapshot
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == "stop-001")
            .map(|stop| stop.status),
        Some(caelum_core::model::TransitNodeStatus::Missing)
    );

    let waypoint_ids = ids(&["stop-001", "stop-002", "stop-003"]);
    let preview = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: route.pattern,
        waypoint_ids: waypoint_ids.clone(),
        route_id: Some(route.id.clone()),
        expected_revision: Some(route.revision),
        generation: 83,
    });
    assert_eq!(
        preview.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::MissingRouteNode)
    );

    let committed = engine.dispatch(GameIntent::UpdateRoute {
        route_id: route.id,
        expected_revision: route.revision,
        pattern: route.pattern,
        waypoint_ids,
    });
    assert!(!committed.applied);
    assert_eq!(
        committed
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::MissingRouteNode)
    );
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
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 3) });
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
    let mut engine = GameEngine::new();
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2), point(4, 2)],
            preset: RoadPreset::TwoWay,
        },
        generation: 33,
    });
    assert_eq!(
        response.authored_tiles[1].road_connections,
        vec![Heading::East, Heading::West]
    );

    let committed = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![point(2, 2), point(3, 2), point(4, 2)],
        preset: RoadPreset::TwoWay,
    });
    assert!(committed.applied, "{committed:?}");
    assert_eq!(
        engine
            .snapshot()
            .map
            .tile(point(3, 2))
            .unwrap()
            .road_connections,
        response.authored_tiles[1].road_connections
    );
}

#[test]
fn endpoint_connection_preview_and_commit_include_the_reciprocal_neighbor() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vec![point(2, 2), point(3, 2)],
            preset: RoadPreset::TwoWay,
        },
    );

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(4, 2) },
        generation: 83,
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert!(preview.changed_tiles.contains(&point(3, 2)));
    assert!(preview.changed_tiles.contains(&point(4, 2)));
    assert!(preview
        .authored_tiles
        .iter()
        .any(|tile| tile.point == point(3, 2)
            && tile.road_connections == vec![Heading::East, Heading::West]));

    let committed = engine.dispatch(GameIntent::LayRoad { point: point(4, 2) });
    assert!(committed.applied, "{committed:?}");
    assert_eq!(
        engine
            .snapshot()
            .map
            .tile(point(3, 2))
            .unwrap()
            .road_connections,
        preview
            .authored_tiles
            .iter()
            .find(|tile| tile.point == point(3, 2))
            .expect("preview includes reciprocal neighbor")
            .road_connections
    );
}

#[test]
fn roundabout_removal_preview_and_commit_include_reciprocal_port_neighbors() {
    let mut engine = existing_route_engine();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    );

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 84,
        mutation: RoadMutation::RemoveAtTile { point: point(6, 5) },
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    assert_eq!(preview.changed_tiles.len(), 11);
    assert!(preview.changed_tiles.contains(&point(4, 5)));
    assert!(preview.changed_tiles.contains(&point(8, 5)));

    let committed = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });
    assert!(committed.applied, "{committed:?}");
    for point in &preview.changed_tiles {
        let authored = preview
            .authored_tiles
            .iter()
            .find(|tile| tile.point == *point)
            .expect("every changed map tile has an authored preview");
        let committed_snapshot = engine.snapshot();
        let committed_tile = committed_snapshot.map.tile(*point).unwrap();
        assert_eq!(authored.road_connections, committed_tile.road_connections);
    }
}

#[test]
fn unaffordable_road_preview_preserves_required_cost_and_engine_state() {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(99);
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();
    let mut creative_snapshot = before_snapshot.clone();
    creative_snapshot.rules.economy_preset = EconomyPreset::Creative;
    creative_snapshot.paused = true;
    let creative_before_snapshot = creative_snapshot.clone();
    let creative = GameEngine::from_snapshot(creative_snapshot)
        .expect("creative preview fixture snapshot should be valid");
    let creative_before_topology = creative.road_topology_for_test().clone();

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
    // Attempted tile is retained so the host can render invalid feedback and
    // anchor the badge (empty changed_tiles would suppress hover fallback).
    assert_eq!(response.changed_tiles, vec![point(2, 2)]);
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);

    let creative_response = creative.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(2, 2) },
        generation: 81,
    });
    assert!(
        creative_response.rejection.is_none(),
        "{creative_response:?}"
    );
    assert_eq!(creative_response.cost, ROAD_COST);
    assert_eq!(creative.snapshot(), creative_before_snapshot);
    assert_eq!(creative.road_topology_for_test(), &creative_before_topology);
}

#[test]
fn rejected_road_preview_preserves_attempted_points() {
    let engine = GameEngine::new();
    // Direction-cycle on a non-road tile rejects; keep the attempted point so
    // the host can highlight invalid targets and anchor the feedback badge.
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::CycleRoadDirection { point: point(3, 3) },
        generation: 82,
    });
    assert!(response.rejection.is_some());
    assert_eq!(response.changed_tiles, vec![point(3, 3)]);

    let line = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoadLine {
            points: vec![point(20, 20), point(21, 20), point(22, 20)],
            preset: RoadPreset::TwoWay,
        },
        generation: 83,
    });
    assert!(line.rejection.is_some());
    assert_eq!(
        line.changed_tiles,
        vec![point(20, 20), point(21, 20), point(22, 20)]
    );
}
