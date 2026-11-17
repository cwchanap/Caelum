use caelum_core::model::{
    GameSnapshot, Heading, LegFailureReason, Point, PortDirection, RoadPort, RoadStructure,
    RoundaboutSize, RouteLegKind, RouteLegPath, RouteLegStatus, ServicePattern, TransitMode,
};
use caelum_core::preview::RoutePreviewRequest;
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn blank_grid_engine() -> GameEngine {
    let mut request = caelum_core::canonical_default_request();
    request.template_id = "blankGrid".to_string();
    let mut engine = GameEngine::from_sandbox_request(request)
        .expect("blank grid fixture request should remain valid");
    engine.set_budget_for_test(500_000);
    engine
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "fixture dispatch should apply: {result:?}");
}

fn road_line(engine: &mut GameEngine, points: Vec<Point>, preset: RoadPreset) {
    dispatch(engine, GameIntent::LayRoadLine { points, preset });
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn preview_legs(
    engine: &GameEngine,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) -> Vec<RouteLegPath> {
    engine
        .preview_route(RoutePreviewRequest {
            mode: TransitMode::Bus,
            pattern,
            waypoint_ids,
            route_id: None,
            expected_revision: None,
            generation: 41,
        })
        .legs
}

fn leg<'a>(legs: &'a [RouteLegPath], from: &str, to: &str) -> &'a RouteLegPath {
    legs.iter()
        .find(|leg| {
            leg.kind == RouteLegKind::Service
                && leg.from_waypoint_id == from
                && leg.to_waypoint_id == to
        })
        .unwrap_or_else(|| panic!("missing service leg {from} -> {to}: {legs:?}"))
}

fn roundabout_ports(snapshot: &GameSnapshot) -> Vec<RoadPort> {
    snapshot
        .map
        .road_structures
        .iter()
        .find_map(|structure| match structure {
            RoadStructure::Roundabout { ports, .. } => Some(ports.clone()),
            RoadStructure::AutomaticJunction { .. } => None,
        })
        .expect("fixture roundabout")
}

#[test]
fn one_way_return_leg_reports_one_way_no_return() {
    let mut engine = blank_grid_engine();
    road_line(
        &mut engine,
        (2..=12).map(|x| point(x, 5)).collect(),
        RoadPreset::OneWay,
    );
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    dispatch(
        &mut engine,
        GameIntent::AddBusStop {
            point: point(10, 4),
        },
    );

    let legs = preview_legs(
        &engine,
        ServicePattern::Shuttle,
        ids(&["stop-001", "stop-002"]),
    );

    assert_eq!(
        leg(&legs, "stop-001", "stop-002").status,
        RouteLegStatus::Connected
    );
    let returning = leg(&legs, "stop-002", "stop-001");
    assert_eq!(returning.status, RouteLegStatus::NetworkDisconnected);
    assert_eq!(
        returning.failure_reason,
        Some(LegFailureReason::OneWayNoReturn)
    );
    let reversals: Vec<_> = legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .collect();
    assert_eq!(reversals.len(), 2, "shuttle has two terminal reversals");
    for reversal in reversals {
        assert_eq!(
            reversal.status,
            RouteLegStatus::Connected,
            "terminal reversal must keep its connected result: {reversal:?}"
        );
        assert_eq!(reversal.failure_reason, None);
    }
}

#[test]
fn roundabout_connected_to_one_way_avenues_reports_one_way_no_return() {
    let mut engine = blank_grid_engine();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    // One-way avenue flowing away from the roundabout on its north port.
    road_line(
        &mut engine,
        (0..=4).rev().map(|y| point(5, y)).collect(),
        RoadPreset::OneWay,
    );
    // One-way avenue flowing into the roundabout on its east port.
    road_line(
        &mut engine,
        (7..=10).rev().map(|x| point(x, 6)).collect(),
        RoadPreset::OneWay,
    );
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(4, 3) });
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(8, 7) });

    let before = engine.snapshot();
    let ports_before = roundabout_ports(&before);
    let captured_directions: Vec<_> = ports_before
        .iter()
        .map(|port| (port.point, port.edge, port.direction))
        .collect();
    assert!(
        captured_directions.contains(&(point(5, 5), Heading::North, Some(PortDirection::Outbound))),
        "north port must capture the outbound avenue: {captured_directions:?}"
    );
    assert!(
        captured_directions.contains(&(point(6, 6), Heading::East, Some(PortDirection::Inbound))),
        "east port must capture the inbound avenue: {captured_directions:?}"
    );

    let legs = preview_legs(
        &engine,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );

    let blocked = leg(&legs, "stop-001", "stop-002");
    assert_eq!(blocked.status, RouteLegStatus::NetworkDisconnected);
    assert_eq!(
        blocked.failure_reason,
        Some(LegFailureReason::OneWayNoReturn)
    );
    assert_eq!(
        leg(&legs, "stop-002", "stop-001").status,
        RouteLegStatus::Connected,
        "the legal return leg must stay connected: {legs:?}"
    );

    // The diagnostic works on a clone: the authoritative map keeps both the
    // captured port directions and the authored one-way avenues.
    let after = engine.snapshot();
    assert_eq!(roundabout_ports(&after), ports_before);
    let one_way_avenue = after.map.tile(point(5, 3)).expect("north avenue tile");
    assert_eq!(one_way_avenue.one_way, Some(Heading::North));
    let inbound_avenue = after.map.tile(point(8, 6)).expect("east avenue tile");
    assert_eq!(inbound_avenue.one_way, Some(Heading::West));
}

#[test]
fn disconnected_geometry_stays_network_disconnected_after_arrow_relaxation() {
    let mut engine = blank_grid_engine();
    // One-way stub with no geometry connection to the second stub: removing
    // its arrows cannot create a path.
    road_line(
        &mut engine,
        (2..=6).map(|x| point(x, 5)).collect(),
        RoadPreset::OneWay,
    );
    road_line(
        &mut engine,
        (2..=6).map(|x| point(x, 9)).collect(),
        RoadPreset::TwoWay,
    );
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 8) });

    let legs = preview_legs(
        &engine,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );

    for service_leg in legs.iter().filter(|leg| leg.kind == RouteLegKind::Service) {
        assert_eq!(service_leg.status, RouteLegStatus::NetworkDisconnected);
        assert_eq!(
            service_leg.failure_reason,
            Some(LegFailureReason::NetworkDisconnected),
            "missing geometry is not a one-way failure: {service_leg:?}"
        );
    }
}

#[test]
fn connected_two_way_service_legs_stay_connected() {
    let mut engine = blank_grid_engine();
    road_line(
        &mut engine,
        (2..=12).map(|x| point(x, 5)).collect(),
        RoadPreset::TwoWay,
    );
    for x in [2, 6, 10] {
        dispatch(&mut engine, GameIntent::AddBusStop { point: point(x, 4) });
    }

    let legs = preview_legs(
        &engine,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002", "stop-003"]),
    );

    assert_eq!(legs.len(), 3);
    for service_leg in &legs {
        assert_eq!(service_leg.status, RouteLegStatus::Connected);
        assert_eq!(service_leg.failure_reason, None);
        assert!(service_leg.current_path.is_some());
    }
}
