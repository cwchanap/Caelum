use caelum_core::building_catalog::building_definition;
use caelum_core::model::{
    EconomyPreset, GameSnapshot, Point, RoundaboutSize, ServicePattern, TransitMode,
};
use caelum_core::roundabouts::roundabout_cost;
use caelum_core::transit::{
    BUS_COST, BUS_STOP_COST, METRO_COST, METRO_STATION_COST, ROAD_COST, TRACK_COST,
};
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn engine_for(snapshot: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).expect("fixture snapshot should be valid")
}

fn assert_world_equal_ignoring_cost_policy(standard: &GameSnapshot, creative: &GameSnapshot) {
    let mut normalized = creative.clone();
    normalized.rules.economy_preset = standard.rules.economy_preset;
    normalized.budget = standard.budget;
    assert_eq!(standard, &normalized);
}

#[test]
fn low_budget_single_road_rejects_standard_and_applies_creative_without_deduction() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, ROAD_COST - 1);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, ROAD_COST - 1);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();

    let standard_result = standard.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    let creative_result = creative.dispatch(GameIntent::LayRoad { point: point(2, 2) });

    assert!(!standard_result.applied);
    let rejection = standard_result
        .rejection
        .expect("standard budget rejection");
    assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
    assert_eq!(rejection.context.required_budget, Some(ROAD_COST));
    assert_eq!(rejection.context.available_budget, Some(ROAD_COST - 1));
    assert_eq!(standard.snapshot(), standard_before);

    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(creative_result.context.cost, ROAD_COST);
    assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    assert_eq!(creative.snapshot(), creative_result.snapshot);
}

#[test]
fn funded_single_road_has_world_parity_and_equal_nominal_cost() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, ROAD_COST);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, ROAD_COST);

    let standard_result = standard.dispatch(GameIntent::LayRoad { point: point(2, 2) });
    let creative_result = creative.dispatch(GameIntent::LayRoad { point: point(2, 2) });

    assert!(standard_result.applied, "{standard_result:?}");
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(standard_result.context.cost, ROAD_COST);
    assert_eq!(creative_result.context.cost, ROAD_COST);
    assert_eq!(standard_result.snapshot.budget, 0);
    assert_eq!(creative_result.snapshot.budget, ROAD_COST);
    assert_world_equal_ignoring_cost_policy(&standard_result.snapshot, &creative_result.snapshot);
}

#[test]
fn low_budget_roundabouts_reject_standard_and_apply_creative_without_deduction() {
    let prepared = GameEngine::new().snapshot();
    for (origin, size) in [
        (point(5, 5), RoundaboutSize::Compact2x2),
        (point(9, 8), RoundaboutSize::Standard3x3),
    ] {
        let cost = roundabout_cost(size);
        let mut standard = engine_for(&prepared, EconomyPreset::Standard, cost - 1);
        let mut creative = engine_for(&prepared, EconomyPreset::Creative, cost - 1);
        let standard_before = standard.snapshot();
        let creative_before = creative.snapshot();

        let standard_result = standard.dispatch(GameIntent::PlaceRoundabout { origin, size });
        let creative_result = creative.dispatch(GameIntent::PlaceRoundabout { origin, size });

        assert!(!standard_result.applied, "{standard_result:?}");
        let rejection = standard_result
            .rejection
            .expect("standard budget rejection");
        assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
        assert_eq!(rejection.context.required_budget, Some(cost));
        assert_eq!(rejection.context.available_budget, Some(cost - 1));
        assert_eq!(standard.snapshot(), standard_before);

        assert!(creative_result.applied, "{creative_result:?}");
        assert_eq!(creative_result.context.cost, cost);
        assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    }
}

#[test]
fn funded_roundabouts_have_world_parity_and_equal_nominal_cost() {
    let prepared = GameEngine::new().snapshot();
    for (origin, size) in [
        (point(5, 5), RoundaboutSize::Compact2x2),
        (point(9, 8), RoundaboutSize::Standard3x3),
    ] {
        let cost = roundabout_cost(size);
        let mut standard = engine_for(&prepared, EconomyPreset::Standard, cost);
        let mut creative = engine_for(&prepared, EconomyPreset::Creative, cost);

        let standard_result = standard.dispatch(GameIntent::PlaceRoundabout { origin, size });
        let creative_result = creative.dispatch(GameIntent::PlaceRoundabout { origin, size });

        assert!(standard_result.applied, "{standard_result:?}");
        assert!(creative_result.applied, "{creative_result:?}");
        assert_eq!(standard_result.context.cost, cost);
        assert_eq!(creative_result.context.cost, cost);
        assert_eq!(standard_result.snapshot.budget, 0);
        assert_eq!(creative_result.snapshot.budget, cost);
        assert_world_equal_ignoring_cost_policy(
            &standard_result.snapshot,
            &creative_result.snapshot,
        );
    }
}

fn prepared_bus_stop() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoadLine {
                points: vec![point(4, 5), point(5, 5)],
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    engine.snapshot()
}

fn prepared_metro_station() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayTrack { point: point(4, 4) })
            .applied
    );
    engine.snapshot()
}

fn prepared_small_house() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: point(2, 3),
                end: point(3, 3),
            })
            .applied
    );
    engine.snapshot()
}

fn prepared_bus_terminal() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoadLine {
                points: vec![point(2, 5), point(3, 5)],
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    engine.snapshot()
}

fn prepared_bus_route_network() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=10).map(|x| point(x, 5)).collect(),
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    for x in [2, 10] {
        assert!(
            engine
                .dispatch(GameIntent::AddBusStop { point: point(x, 4) })
                .applied
        );
    }
    engine.snapshot()
}

fn prepared_metro_route_network() -> GameSnapshot {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayTrackLine {
                points: (2..=10).map(|x| point(x, 5)).collect(),
            })
            .applied
    );
    for x in [2, 10] {
        assert!(
            engine
                .dispatch(GameIntent::AddMetroStation { point: point(x, 5) })
                .applied
        );
    }
    engine.snapshot()
}

fn prepared_route(mode: TransitMode) -> GameSnapshot {
    let prepared = match mode {
        TransitMode::Bus => prepared_bus_route_network(),
        TransitMode::Metro => prepared_metro_route_network(),
        TransitMode::Walk => unreachable!("fixtures only prepare purchasable service modes"),
    };
    let cost = match mode {
        TransitMode::Bus => BUS_COST,
        TransitMode::Metro => METRO_COST,
        TransitMode::Walk => unreachable!("fixtures only prepare purchasable service modes"),
    };
    let mut engine = engine_for(&prepared, EconomyPreset::Standard, cost);
    let waypoint_ids = match mode {
        TransitMode::Bus => vec!["stop-001".into(), "stop-002".into()],
        TransitMode::Metro => vec!["station-001".into(), "station-002".into()],
        TransitMode::Walk => unreachable!("fixtures only prepare purchasable service modes"),
    };
    assert!(
        engine
            .dispatch(GameIntent::CreateRoute {
                mode,
                pattern: ServicePattern::Loop,
                waypoint_ids,
            })
            .applied
    );
    engine.snapshot()
}

fn assert_low_budget_pair(prepared: &GameSnapshot, intent: GameIntent, cost: i32) {
    let mut standard = engine_for(prepared, EconomyPreset::Standard, cost - 1);
    let mut creative = engine_for(prepared, EconomyPreset::Creative, cost - 1);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(!standard_result.applied, "{standard_result:?}");
    assert_eq!(
        standard_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::InsufficientBudget),
    );
    assert_eq!(standard_result.snapshot, standard_before);
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    assert_eq!(creative_result.context.cost, cost);
}

fn assert_funded_pair(prepared: &GameSnapshot, intent: GameIntent, cost: i32) {
    let mut standard = engine_for(prepared, EconomyPreset::Standard, cost);
    let mut creative = engine_for(prepared, EconomyPreset::Creative, cost);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(standard_result.applied, "{standard_result:?}");
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(standard_result.context.cost, cost);
    assert_eq!(creative_result.context.cost, cost);
    assert_eq!(
        standard_result.snapshot.budget,
        standard_before.budget - cost,
    );
    assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    assert_eq!(standard_result.context, creative_result.context);
    assert_world_equal_ignoring_cost_policy(&standard_result.snapshot, &creative_result.snapshot);
}

fn assert_funded_paired_rejection(
    prepared: &GameSnapshot,
    intent: GameIntent,
    expected: RejectionCode,
) {
    let mut standard = engine_for(prepared, EconomyPreset::Standard, 120_000);
    let mut creative = engine_for(prepared, EconomyPreset::Creative, 120_000);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_topology = standard.road_topology_for_test().clone();
    let creative_topology = creative.road_topology_for_test().clone();

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(!standard_result.applied, "{standard_result:?}");
    assert!(!creative_result.applied, "{creative_result:?}");
    assert_eq!(
        standard_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&expected)
    );
    assert_eq!(standard_result.rejection, creative_result.rejection);
    assert_eq!(standard_result.snapshot, standard_before);
    assert_eq!(creative_result.snapshot, creative_before);
    assert_eq!(standard.road_topology_for_test(), &standard_topology);
    assert_eq!(creative.road_topology_for_test(), &creative_topology);
}

#[test]
fn low_budget_transit_nodes_tracks_and_buildings_reject_standard_and_apply_creative() {
    let small_house_cost = building_definition("smallHouse").unwrap().cost;
    let terminal_cost = building_definition("busTerminal").unwrap().cost;

    assert_low_budget_pair(
        &GameEngine::new().snapshot(),
        GameIntent::LayTrack { point: point(2, 2) },
        TRACK_COST,
    );
    assert_low_budget_pair(
        &prepared_bus_stop(),
        GameIntent::AddBusStop { point: point(4, 4) },
        BUS_STOP_COST,
    );
    assert_low_budget_pair(
        &prepared_metro_station(),
        GameIntent::AddMetroStation { point: point(4, 4) },
        METRO_STATION_COST,
    );
    assert_low_budget_pair(
        &prepared_small_house(),
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: point(2, 3),
            rotation: 0,
        },
        small_house_cost,
    );
    assert_low_budget_pair(
        &prepared_bus_terminal(),
        GameIntent::PlaceBuilding {
            building_type: "busTerminal".to_string(),
            origin: point(2, 3),
            rotation: 0,
        },
        terminal_cost,
    );
    assert_low_budget_pair(
        &prepared_bus_stop(),
        GameIntent::PlaceBuilding {
            building_type: "busStop".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
        BUS_STOP_COST,
    );
    assert_low_budget_pair(
        &prepared_metro_station(),
        GameIntent::PlaceBuilding {
            building_type: "metroStation".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
        METRO_STATION_COST,
    );
}

#[test]
fn funded_transit_nodes_tracks_and_buildings_have_nominal_cost_parity() {
    let small_house_cost = building_definition("smallHouse").unwrap().cost;
    let terminal_cost = building_definition("busTerminal").unwrap().cost;

    assert_funded_pair(
        &GameEngine::new().snapshot(),
        GameIntent::LayTrack { point: point(2, 2) },
        TRACK_COST,
    );
    assert_funded_pair(
        &GameEngine::new().snapshot(),
        GameIntent::LayTrackLine {
            points: vec![point(2, 2), point(3, 2)],
        },
        2 * TRACK_COST,
    );
    assert_funded_pair(
        &prepared_bus_stop(),
        GameIntent::AddBusStop { point: point(4, 4) },
        BUS_STOP_COST,
    );
    assert_funded_pair(
        &prepared_metro_station(),
        GameIntent::AddMetroStation { point: point(4, 4) },
        METRO_STATION_COST,
    );
    assert_funded_pair(
        &prepared_small_house(),
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: point(2, 3),
            rotation: 0,
        },
        small_house_cost,
    );
    assert_funded_pair(
        &prepared_bus_terminal(),
        GameIntent::PlaceBuilding {
            building_type: "busTerminal".to_string(),
            origin: point(2, 3),
            rotation: 0,
        },
        terminal_cost,
    );
    assert_funded_pair(
        &prepared_bus_stop(),
        GameIntent::PlaceBuilding {
            building_type: "busStop".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
        BUS_STOP_COST,
    );
    assert_funded_pair(
        &prepared_metro_station(),
        GameIntent::PlaceBuilding {
            building_type: "metroStation".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
        METRO_STATION_COST,
    );
}

#[test]
fn transit_service_creation_and_assignment_follow_the_cost_policy_matrix() {
    for (mode, creation_cost, creation_intent, assignment_mode, line_id) in [
        (
            TransitMode::Bus,
            BUS_COST,
            GameIntent::CreateRoute {
                mode: TransitMode::Bus,
                pattern: ServicePattern::Loop,
                waypoint_ids: vec!["stop-001".into(), "stop-002".into()],
            },
            "bus",
            "route-001",
        ),
        (
            TransitMode::Metro,
            METRO_COST,
            GameIntent::CreateRoute {
                mode: TransitMode::Metro,
                pattern: ServicePattern::Loop,
                waypoint_ids: vec!["station-001".into(), "station-002".into()],
            },
            "metro",
            "metro-001",
        ),
    ] {
        let network = match mode {
            TransitMode::Bus => prepared_bus_route_network(),
            TransitMode::Metro => prepared_metro_route_network(),
            TransitMode::Walk => unreachable!("fixtures only prepare purchasable service modes"),
        };
        assert_low_budget_pair(&network, creation_intent.clone(), creation_cost);
        assert_funded_pair(&network, creation_intent, creation_cost);

        let route = prepared_route(mode);
        let assignment_intent = GameIntent::AssignVehicle {
            mode: assignment_mode.into(),
            line_id: line_id.into(),
        };
        assert_low_budget_pair(&route, assignment_intent.clone(), creation_cost);
        assert_funded_pair(&route, assignment_intent, creation_cost);
    }
}

#[test]
fn dedicated_and_generic_transit_node_intents_report_the_same_nominal_price() {
    let bus_dedicated = engine_for(&prepared_bus_stop(), EconomyPreset::Creative, 0)
        .dispatch(GameIntent::AddBusStop { point: point(4, 4) });
    let bus_generic = engine_for(&prepared_bus_stop(), EconomyPreset::Creative, 0).dispatch(
        GameIntent::PlaceBuilding {
            building_type: "busStop".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
    );
    let metro_dedicated = engine_for(&prepared_metro_station(), EconomyPreset::Creative, 0)
        .dispatch(GameIntent::AddMetroStation { point: point(4, 4) });
    let metro_generic = engine_for(&prepared_metro_station(), EconomyPreset::Creative, 0).dispatch(
        GameIntent::PlaceBuilding {
            building_type: "metroStation".to_string(),
            origin: point(4, 4),
            rotation: 0,
        },
    );

    assert_eq!(bus_dedicated.context.cost, BUS_STOP_COST);
    assert_eq!(bus_generic.context.cost, BUS_STOP_COST);
    assert_eq!(metro_dedicated.context.cost, METRO_STATION_COST);
    assert_eq!(metro_generic.context.cost, METRO_STATION_COST);
}

#[test]
fn over_budget_track_stroke_truncates_standard_but_creative_authors_every_valid_tile() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, TRACK_COST);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, TRACK_COST);
    let intent = GameIntent::LayTrackLine {
        points: vec![point(2, 2), point(3, 2), point(4, 2)],
    };

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(standard_result.applied, "{standard_result:?}");
    assert_eq!(standard_result.context.cost, TRACK_COST);
    assert_eq!(standard_result.context.changed_tiles, vec![point(2, 2)]);
    assert_eq!(
        standard_result.context.skipped_tiles,
        vec![point(3, 2), point(4, 2)]
    );
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(creative_result.context.cost, 3 * TRACK_COST);
    assert_eq!(creative_result.snapshot.budget, TRACK_COST);
    assert_eq!(
        creative_result.context.changed_tiles,
        vec![point(2, 2), point(3, 2), point(4, 2)]
    );
}

#[test]
fn funded_rejections_preserve_policy_parity_and_engine_state() {
    assert_funded_paired_rejection(
        &GameEngine::new().snapshot(),
        GameIntent::LayTrack {
            point: point(999, 999),
        },
        RejectionCode::OutOfBounds,
    );

    let mut structure = GameEngine::new();
    assert!(
        structure
            .dispatch(GameIntent::PlaceRoundabout {
                origin: point(5, 5),
                size: RoundaboutSize::Compact2x2,
            })
            .applied
    );
    assert_funded_paired_rejection(
        &structure.snapshot(),
        GameIntent::LayTrack { point: point(5, 5) },
        RejectionCode::BlockedTile,
    );

    let mut existing_node = engine_for(&prepared_bus_stop(), EconomyPreset::Standard, 120_000);
    assert!(
        existing_node
            .dispatch(GameIntent::AddBusStop { point: point(4, 4) })
            .applied
    );
    assert_funded_paired_rejection(
        &existing_node.snapshot(),
        GameIntent::AddBusStop { point: point(4, 4) },
        RejectionCode::BlockedTile,
    );

    assert_funded_paired_rejection(
        &prepared_bus_stop(),
        GameIntent::PlaceBuilding {
            building_type: "busStop".to_string(),
            origin: point(4, 5),
            rotation: 0,
        },
        RejectionCode::BlockedFootprint,
    );
}
