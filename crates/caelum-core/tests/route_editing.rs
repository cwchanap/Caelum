use caelum_core::model::{
    ActiveTrip, EconomyPreset, GameMap, GameSnapshot, Heading, LegFailureReason, Point, RoadPort,
    RoadStructure, Route, RouteLeg, RouteLegKind, RouteLegPath, RouteLegStatus, RoutePlan,
    ServiceDirection, ServicePattern, StopRoadAccess, TransitMode, TransitNodeStatus, TripPosition,
    TripPurpose, TripStatus, Vehicle,
};
use caelum_core::network::resolve_route_legs;
use caelum_core::road_topology::RoadTopology;
use caelum_core::transit::{self, BUS_COST, METRO_COST};
use caelum_core::{
    route_editor, GameEngine, GameIntent, RejectionCode, RoadPreset, RoutingContext,
};

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

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    dispatch(
        engine,
        GameIntent::LayRoadLine {
            points: (from_x..=to_x).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
}

fn track_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    dispatch(
        engine,
        GameIntent::LayTrackLine {
            points: (from_x..=to_x).map(|x| point(x, y)).collect(),
        },
    );
}

fn editable_bus_engine(stop_xs: &[i32], budget: i32) -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 14);
    for x in stop_xs {
        dispatch(
            &mut engine,
            GameIntent::AddBusStop {
                point: point(*x, 4),
            },
        );
    }
    engine.set_budget_for_test(budget);
    engine
}

fn perimeter_bus_engine(budget: i32) -> GameEngine {
    let mut engine = GameEngine::new();
    for (points, preset) in [
        (
            (2..=25).map(|x| point(x, 2)).collect::<Vec<_>>(),
            RoadPreset::TwoWay,
        ),
        (
            (2..=15).map(|y| point(25, y)).collect::<Vec<_>>(),
            RoadPreset::TwoWay,
        ),
        (
            (2..=25).rev().map(|x| point(x, 15)).collect::<Vec<_>>(),
            RoadPreset::TwoWay,
        ),
        (
            (2..=15).rev().map(|y| point(2, y)).collect::<Vec<_>>(),
            RoadPreset::TwoWay,
        ),
    ] {
        dispatch(&mut engine, GameIntent::LayRoadLine { points, preset });
    }
    for point in [
        point(2, 1),
        point(25, 1),
        point(25, 16),
        point(2, 16),
        point(20, 16),
    ] {
        let result = engine.dispatch(GameIntent::AddBusStop { point });
        assert!(result.applied, "stop {point:?} should apply: {result:?}");
    }
    engine.set_budget_for_test(budget);
    engine
}

fn editable_metro_engine(station_xs: &[i32], budget: i32) -> GameEngine {
    let mut engine = GameEngine::new();
    track_line(&mut engine, 5, 2, 14);
    for x in station_xs {
        dispatch(
            &mut engine,
            GameIntent::AddMetroStation {
                point: point(*x, 5),
            },
        );
    }
    engine.set_budget_for_test(budget);
    engine
}

fn engine_for(snapshot: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).expect("fixture snapshot should be valid")
}

fn disconnected_bus_network() -> GameSnapshot {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 6);
    road_line(&mut engine, 12, 2, 6);
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    dispatch(
        &mut engine,
        GameIntent::AddBusStop {
            point: point(2, 11),
        },
    );
    engine.snapshot()
}

fn create_route(
    engine: &mut GameEngine,
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) {
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode,
        pattern,
        waypoint_ids,
    });
    assert!(created.applied, "fixture create should apply: {created:?}");
    if mode == TransitMode::Bus {
        let route_id = created
            .snapshot
            .transit
            .routes
            .last()
            .expect("created bus route")
            .id
            .clone();
        dispatch(
            engine,
            GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: route_id,
            },
        );
    }
}

fn route<'a>(snapshot: &'a GameSnapshot, route_id: &str) -> &'a Route {
    snapshot
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .expect("fixture route")
}

fn route_mut<'a>(snapshot: &'a mut GameSnapshot, route_id: &str) -> &'a mut Route {
    snapshot
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
        .expect("fixture route")
}

fn resolved_bus_legs(
    snapshot: &GameSnapshot,
    topology: &RoadTopology,
    waypoint_ids: &[&str],
) -> Vec<RouteLegPath> {
    resolved_bus_legs_with_pattern(snapshot, topology, waypoint_ids, ServicePattern::Loop)
}

fn resolved_bus_legs_with_pattern(
    snapshot: &GameSnapshot,
    topology: &RoadTopology,
    waypoint_ids: &[&str],
    pattern: ServicePattern,
) -> Vec<RouteLegPath> {
    let waypoint_ids = ids(waypoint_ids);
    resolve_route_legs(
        snapshot,
        RoutingContext {
            road_topology: topology,
        },
        TransitMode::Bus,
        &waypoint_ids,
        pattern,
    )
}

fn set_stop_access(
    snapshot: &mut GameSnapshot,
    stop_id: &str,
    position: Point,
    road_point: Point,
    preferred_heading: Option<Heading>,
) {
    let stop = snapshot
        .transit
        .stops
        .iter_mut()
        .find(|stop| stop.id == stop_id)
        .expect("fixture stop");
    stop.position = position;
    stop.road_access = Some(StopRoadAccess {
        road_point,
        preferred_heading,
    });
}

fn heading_between_points(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
    }
}

fn opposite_heading(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

fn ensure_road(map: &mut GameMap, point: Point, one_way: Option<Heading>) {
    let tile = map.tile_mut(point).expect("fixture tile");
    tile.kind = "road".into();
    tile.one_way = one_way;
    tile.road_structure_id = None;
}

fn connect_fixture_roads(map: &mut GameMap, first: Point, second: Point) {
    let heading = heading_between_points(first, second);
    let reverse = opposite_heading(heading);
    let first_one_way = map.tile(first).and_then(|tile| tile.one_way);
    let second_one_way = map.tile(second).and_then(|tile| tile.one_way);
    ensure_road(map, first, first_one_way);
    ensure_road(map, second, second_one_way);
    let first_tile = map.tile_mut(first).expect("fixture first road");
    if !first_tile.road_connections.contains(&heading) {
        first_tile.road_connections.push(heading);
    }
    let second_tile = map.tile_mut(second).expect("fixture second road");
    if !second_tile.road_connections.contains(&reverse) {
        second_tile.road_connections.push(reverse);
    }
}

fn terminal_snapshot() -> GameSnapshot {
    let engine = editable_bus_engine(&[2, 3], BUS_COST);
    let mut snapshot = engine.snapshot().clone();
    let access = point(3, 4);
    let terminal = point(3, 5);
    set_stop_access(&mut snapshot, "stop-001", point(3, 3), access, None);
    set_stop_access(
        &mut snapshot,
        "stop-002",
        point(3, 6),
        terminal,
        Some(Heading::West),
    );
    ensure_road(&mut snapshot.map, access, None);
    connect_fixture_roads(&mut snapshot.map, access, terminal);
    snapshot
}

fn turnaround_snapshot() -> GameSnapshot {
    let engine = editable_bus_engine(&[2, 3], BUS_COST);
    let mut snapshot = engine.snapshot().clone();
    let access = point(3, 3);
    let terminal = point(3, 5);
    let west = point(2, 5);
    let left = point(1, 5);
    let upper_left = point(1, 4);
    let upper_middle = point(1, 3);
    let upper_right = point(2, 3);
    let north = point(3, 4);
    set_stop_access(&mut snapshot, "stop-001", point(3, 2), access, None);
    set_stop_access(
        &mut snapshot,
        "stop-002",
        point(3, 6),
        terminal,
        Some(Heading::West),
    );
    for point in [left, upper_left, upper_middle, upper_right, north] {
        ensure_road(&mut snapshot.map, point, None);
    }
    connect_fixture_roads(&mut snapshot.map, west, left);
    connect_fixture_roads(&mut snapshot.map, left, upper_left);
    connect_fixture_roads(&mut snapshot.map, upper_left, upper_middle);
    connect_fixture_roads(&mut snapshot.map, upper_middle, upper_right);
    connect_fixture_roads(&mut snapshot.map, upper_right, access);
    connect_fixture_roads(&mut snapshot.map, access, north);
    connect_fixture_roads(&mut snapshot.map, north, terminal);
    snapshot
}

fn terminal_structure_topology(
    snapshot: &GameSnapshot,
    terminal: Point,
    edges: &[Heading],
) -> RoadTopology {
    let mut map = snapshot.map.clone();
    let structure_id = "fixture-terminal".to_string();
    map.tile_mut(terminal)
        .expect("fixture terminal")
        .road_structure_id = Some(structure_id.clone());
    map.road_structures.push(RoadStructure::AutomaticJunction {
        id: structure_id.clone(),
        footprint: vec![terminal],
        ports: edges
            .iter()
            .enumerate()
            .map(|(index, edge)| RoadPort {
                id: format!("{structure_id}-port-{index}"),
                point: terminal,
                edge: *edge,
                direction: None,
            })
            .collect(),
    });
    RoadTopology::compile(&map).expect("fixture topology")
}

fn turnaround_topology(snapshot: &GameSnapshot) -> RoadTopology {
    let west = point(2, 5);
    let east = point(4, 5);
    let north = point(3, 4);
    let mut map = snapshot.map.clone();
    map.tile_mut(west).expect("fixture west road").one_way = Some(Heading::West);
    map.tile_mut(east).expect("fixture east road").one_way = Some(Heading::West);
    map.tile_mut(north).expect("fixture north road").one_way = Some(Heading::South);
    RoadTopology::compile(&map).expect("fixture topology")
}

fn vehicle<'a>(snapshot: &'a GameSnapshot, vehicle_id: &str) -> &'a Vehicle {
    snapshot
        .transit
        .vehicles
        .iter()
        .find(|vehicle| vehicle.id == vehicle_id)
        .expect("fixture vehicle")
}

fn route_platform_id(snapshot: &GameSnapshot, node_id: &str, route_id: &str) -> Option<String> {
    snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == node_id)
        .map(|stop| &stop.platforms)
        .or_else(|| {
            snapshot
                .transit
                .stations
                .iter()
                .find(|station| station.id == node_id)
                .map(|station| &station.platforms)
        })?
        .iter()
        .find(|platform| platform.route_ids.iter().any(|id| id == route_id))
        .map(|platform| platform.id.clone())
}

#[test]
fn route_resolution_preserves_typed_failure_reasons_and_coarse_status() {
    let engine = editable_bus_engine(&[2, 10], BUS_COST);
    let topology = engine.road_topology_for_test();

    let mut no_access = engine.snapshot();
    no_access.transit.stops[0].position = point(2, 2);
    no_access.transit.stops[0].road_access = None;
    let no_access_legs = resolved_bus_legs(&no_access, topology, &["stop-001", "stop-002"]);
    let no_access_leg = no_access_legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NoRoadAccess))
        .expect("missing road access should be diagnosed");
    assert_eq!(no_access_leg.status, RouteLegStatus::NetworkDisconnected);

    let mut disconnected_engine = editable_bus_engine(&[2, 10], BUS_COST);
    road_line(&mut disconnected_engine, 11, 2, 10);
    dispatch(
        &mut disconnected_engine,
        GameIntent::AddBusStop {
            point: point(2, 10),
        },
    );
    let disconnected_legs = resolved_bus_legs(
        &disconnected_engine.snapshot(),
        disconnected_engine.road_topology_for_test(),
        &["stop-001", "stop-003"],
    );
    let disconnected_leg = disconnected_legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NetworkDisconnected))
        .expect("disconnected access tiles should be diagnosed");
    assert_eq!(disconnected_leg.status, RouteLegStatus::NetworkDisconnected);

    let missing_legs = resolved_bus_legs(&engine.snapshot(), topology, &["stop-001", "missing"]);
    let missing_leg = missing_legs
        .iter()
        .find(|leg| leg.status == RouteLegStatus::MissingNode)
        .expect("missing waypoint should remain a missing node");
    assert_eq!(missing_leg.failure_reason, None);

    let tombstoned =
        transit::remove_at_tile(&engine.snapshot(), &point(2, 4)).expect("fixture tombstone");
    let tombstoned_legs = resolved_bus_legs(&tombstoned, topology, &["stop-001", "stop-002"]);
    let tombstoned_leg = tombstoned_legs
        .iter()
        .find(|leg| leg.status == RouteLegStatus::MissingNode)
        .expect("tombstoned waypoint should remain a missing node");
    assert_eq!(tombstoned_leg.failure_reason, None);

    let mut loop_engine = editable_bus_engine(&[2, 10], BUS_COST);
    road_line(&mut loop_engine, 11, 2, 10);
    dispatch(
        &mut loop_engine,
        GameIntent::AddBusStop {
            point: point(2, 10),
        },
    );
    let loop_legs = resolved_bus_legs_with_pattern(
        &loop_engine.snapshot(),
        loop_engine.road_topology_for_test(),
        &["stop-001", "stop-002", "stop-003"],
        ServicePattern::Loop,
    );
    let closing_leg = loop_legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::Service
                && leg.from_waypoint_id == "stop-003"
                && leg.to_waypoint_id == "stop-001"
        })
        .expect("Loop closing service leg");
    assert_eq!(closing_leg.status, RouteLegStatus::NetworkDisconnected);
    assert_eq!(
        closing_leg.failure_reason,
        Some(LegFailureReason::NetworkDisconnected)
    );
}

#[test]
fn route_resolution_preserves_terminal_typed_failure_reasons_and_coarse_status() {
    let snapshot = terminal_snapshot();

    let no_entry_topology = RoadTopology::empty();
    let no_entry_legs = resolved_bus_legs_with_pattern(
        &snapshot,
        &no_entry_topology,
        &["stop-001", "stop-002"],
        ServicePattern::Shuttle,
    );
    let no_entry = no_entry_legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NoLegalEntryHeading))
        .expect("service resolution should preserve no-entry diagnosis");
    assert_eq!(no_entry.kind, RouteLegKind::Service);
    assert_eq!(no_entry.status, RouteLegStatus::NetworkDisconnected);

    let mut structure_snapshot = terminal_snapshot();
    let terminal = point(3, 5);
    let access = point(3, 4);
    let east = point(4, 5);
    let detour = point(4, 4);
    ensure_road(&mut structure_snapshot.map, detour, None);
    connect_fixture_roads(&mut structure_snapshot.map, east, detour);
    connect_fixture_roads(&mut structure_snapshot.map, detour, access);
    let no_exit_topology =
        terminal_structure_topology(&structure_snapshot, terminal, &[Heading::East]);
    let no_exit_legs = resolved_bus_legs_with_pattern(
        &structure_snapshot,
        &no_exit_topology,
        &["stop-001", "stop-002"],
        ServicePattern::Shuttle,
    );
    let no_exit = no_exit_legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NoLegalExitHeading))
        .expect("terminal reversal should preserve no-exit diagnosis");
    assert_eq!(no_exit.kind, RouteLegKind::TerminalReversal);
    assert_eq!(no_exit.status, RouteLegStatus::NetworkDisconnected);

    let no_turnaround_snapshot = turnaround_snapshot();
    let no_turnaround_topology = turnaround_topology(&no_turnaround_snapshot);
    let no_turnaround_legs = resolved_bus_legs_with_pattern(
        &no_turnaround_snapshot,
        &no_turnaround_topology,
        &["stop-001", "stop-002"],
        ServicePattern::Shuttle,
    );
    let no_turnaround = no_turnaround_legs
        .iter()
        .find(|leg| leg.failure_reason == Some(LegFailureReason::NoLegalTurnaround))
        .expect("terminal reversal should preserve no-turnaround diagnosis");
    assert_eq!(no_turnaround.kind, RouteLegKind::TerminalReversal);
    assert_eq!(no_turnaround.status, RouteLegStatus::NetworkDisconnected);
}

#[test]
fn terminal_reversal_does_not_leak_bounding_leg_failure_reason() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 6);
    road_line(&mut engine, 12, 2, 6);
    dispatch(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    dispatch(
        &mut engine,
        GameIntent::AddBusStop {
            point: point(2, 11),
        },
    );

    let legs = resolved_bus_legs_with_pattern(
        &engine.snapshot(),
        engine.road_topology_for_test(),
        &["stop-001", "stop-002"],
        ServicePattern::Shuttle,
    );
    let service = legs
        .iter()
        .find(|leg| leg.kind == RouteLegKind::Service)
        .expect("service leg");
    assert_eq!(
        service.status,
        RouteLegStatus::NetworkDisconnected,
        "service leg should be disconnected across separate roads: {service:?}",
    );

    let reversal = legs
        .iter()
        .find(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .expect("terminal reversal leg");
    assert_ne!(
        reversal.failure_reason,
        Some(LegFailureReason::NetworkDisconnected),
        "reversal leg must not leak the bounding service leg's NetworkDisconnected: {reversal:?}",
    );
    assert_ne!(
        reversal.failure_reason,
        Some(LegFailureReason::NoRoadAccess),
        "reversal leg must not leak NoRoadAccess from the bounding service leg: {reversal:?}",
    );
}

#[test]
fn create_bus_route_is_fleet_free_and_budget_free() {
    let mut engine = editable_bus_engine(&[2, 10], BUS_COST);
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    assert!(result.applied, "{result:?}");
    assert_eq!(result.snapshot.transit.routes.len(), 1);
    assert!(result.snapshot.transit.vehicles.is_empty());
    assert_eq!(result.snapshot.budget, before.budget);
    let created = route(&result.snapshot, "route-001");
    assert!(created.vehicle_ids.is_empty());
    assert_eq!(created.pattern, ServicePattern::Loop);
    assert!(!created.path_broken);
    assert!(created
        .stop_ids
        .iter()
        .all(|id| route_platform_id(&result.snapshot, id, &created.id).is_some()));
}

#[test]
fn bus_route_creation_does_not_require_vehicle_budget() {
    let mut engine = editable_bus_engine(&[2, 10], BUS_COST - 1);
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    assert!(result.applied, "{result:?}");
    assert_eq!(result.snapshot.budget, before.budget);
    assert!(result.snapshot.transit.routes[0].vehicle_ids.is_empty());
}

#[test]
fn deployed_fleet_survives_structural_route_edit_without_respace_or_resize() {
    let mut engine = perimeter_bus_engine(BUS_COST * 4);
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002", "stop-003", "stop-004"]),
    });
    assert!(created.applied, "{created:?}");
    assert!(
        engine
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".into(),
                target_headway_seconds: 60,
            })
            .applied
    );
    let required = route(&engine.snapshot(), "route-001")
        .service_metrics
        .as_ref()
        .and_then(|metrics| metrics.required_fleet)
        .expect("perimeter route should derive a required fleet");
    assert!(required > 1, "perimeter fixture must deploy multiple buses");
    engine.set_budget_for_test(
        i32::try_from(required)
            .unwrap()
            .checked_mul(BUS_COST)
            .unwrap(),
    );
    let deployed = engine.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".into(),
    });
    assert!(deployed.applied, "{deployed:?}");
    let before = route(&deployed.snapshot, "route-001").clone();

    let edited = engine.dispatch(GameIntent::UpdateRoute {
        route_id: "route-001".into(),
        expected_revision: before.revision,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-005", "stop-002", "stop-003", "stop-004"]),
    });
    assert!(edited.applied, "{edited:?}");
    let after = route(&edited.snapshot, "route-001");
    assert_eq!(after.vehicle_ids, before.vehicle_ids);
    assert_eq!(
        edited
            .snapshot
            .transit
            .vehicles
            .iter()
            .filter(|vehicle| vehicle.line_id == "route-001")
            .count(),
        required
    );
    assert_eq!(after.target_headway_seconds, Some(60));
    // UpdateRoute rebases surviving vehicles: itinerary_index is recomputed
    // while path_step_index and step_progress reset to their parked values.
    for vehicle in edited
        .snapshot
        .transit
        .vehicles
        .iter()
        .filter(|vehicle| vehicle.line_id == "route-001")
    {
        assert_eq!(
            vehicle.path_step_index, 0,
            "rebase resets path_step_index: {vehicle:?}"
        );
        assert_eq!(
            vehicle.step_progress, 0.0,
            "rebase resets step_progress: {vehicle:?}"
        );
    }
    assert!(after.revision > before.revision);
}

#[test]
fn route_creation_checks_connectivity_before_the_policy_quote_in_both_presets() {
    let prepared = disconnected_bus_network();
    let intent = GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    };
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, BUS_COST - 1);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, BUS_COST - 1);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    for result in [&standard_result, &creative_result] {
        assert!(!result.applied, "{result:?}");
        assert_eq!(
            result.rejection.as_ref().map(|rejection| &rejection.code),
            Some(&RejectionCode::DisconnectedLeg),
        );
    }
    assert_eq!(standard_result.rejection, creative_result.rejection);
    // Snapshot equality includes routes, lines, vehicles, platforms, budget, and
    // the entity inventories that determine the next stable IDs.
    assert_eq!(standard.snapshot(), standard_before);
    assert_eq!(creative.snapshot(), creative_before);
}

#[test]
fn vehicle_assignment_keeps_budget_first_and_preserves_later_rejections() {
    let prepared = editable_bus_engine(&[2, 10], BUS_COST).snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, BUS_COST - 1);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, BUS_COST - 1);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let missing = GameIntent::AssignVehicle {
        mode: "bus".into(),
        line_id: "route-missing".into(),
    };

    let standard_result = standard.dispatch(missing.clone());
    let creative_result = creative.dispatch(missing);

    assert_eq!(
        standard_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::InsufficientBudget),
    );
    assert_eq!(
        creative_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::RouteNotFound),
    );
    assert_eq!(standard.snapshot(), standard_before);
    assert_eq!(creative.snapshot(), creative_before);

    for (intent, expected) in [
        (
            GameIntent::AssignVehicle {
                mode: "tram".into(),
                line_id: "route-001".into(),
            },
            RejectionCode::IncompatibleRouteNode,
        ),
        (
            GameIntent::AssignVehicle {
                mode: "bus".into(),
                line_id: "route-missing".into(),
            },
            RejectionCode::RouteNotFound,
        ),
    ] {
        let mut funded_standard = engine_for(&prepared, EconomyPreset::Standard, BUS_COST);
        let mut funded_creative = engine_for(&prepared, EconomyPreset::Creative, BUS_COST);
        let standard_before = funded_standard.snapshot();
        let creative_before = funded_creative.snapshot();
        let standard_result = funded_standard.dispatch(intent.clone());
        let creative_result = funded_creative.dispatch(intent);

        assert_eq!(
            standard_result
                .rejection
                .as_ref()
                .map(|rejection| &rejection.code),
            Some(&expected),
        );
        assert_eq!(standard_result.rejection, creative_result.rejection);
        assert_eq!(funded_standard.snapshot(), standard_before);
        assert_eq!(funded_creative.snapshot(), creative_before);
    }
}

#[test]
fn funded_inactive_and_disconnected_assignments_remain_atomic_in_both_presets() {
    let mut inactive = editable_bus_engine(&[2, 10], BUS_COST * 2);
    create_route(
        &mut inactive,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    dispatch(
        &mut inactive,
        GameIntent::SetRouteActive {
            route_id: "route-001".into(),
            active: false,
        },
    );

    let mut disconnected = editable_bus_engine(&[2, 10], BUS_COST * 2);
    create_route(
        &mut disconnected,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    dispatch(
        &mut disconnected,
        GameIntent::RemoveAtTile { point: point(6, 5) },
    );

    for (prepared, expected) in [
        (inactive.snapshot(), RejectionCode::InactiveRoute),
        (disconnected.snapshot(), RejectionCode::DisconnectedLeg),
    ] {
        let mut standard = engine_for(&prepared, EconomyPreset::Standard, BUS_COST);
        let mut creative = engine_for(&prepared, EconomyPreset::Creative, BUS_COST);
        let standard_before = standard.snapshot();
        let creative_before = creative.snapshot();
        let intent = GameIntent::AssignVehicle {
            mode: "bus".into(),
            line_id: "route-001".into(),
        };

        let standard_result = standard.dispatch(intent.clone());
        let creative_result = creative.dispatch(intent);
        assert_eq!(
            standard_result
                .rejection
                .as_ref()
                .map(|rejection| &rejection.code),
            Some(&expected),
        );
        assert_eq!(standard_result.rejection, creative_result.rejection);
        assert_eq!(standard.snapshot(), standard_before);
        assert_eq!(creative.snapshot(), creative_before);
    }
}

#[test]
fn stale_update_rejects_without_mutating_latest_metadata() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let expected_revision = route(&engine.snapshot(), "route-001").revision;
    dispatch(
        &mut engine,
        GameIntent::RenameRoute {
            route_id: "route-001".into(),
            name: "Latest name".into(),
        },
    );
    // A single-platform stop cannot be reassigned, so use a topology mutation
    // to create the structural revision race captured by the editor.
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(4, 5) });
    let before = engine.snapshot();
    assert!(route(&before, "route-001").revision > expected_revision);

    let result = engine.dispatch(GameIntent::UpdateRoute {
        route_id: "route-001".into(),
        expected_revision,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-003"]),
    });

    let rejection = result.rejection.expect("stale revision rejection");
    assert_eq!(rejection.code, RejectionCode::RouteChangedWhileEditing);
    assert_eq!(rejection.context.expected_revision, Some(expected_revision));
    assert_eq!(
        rejection.context.actual_revision,
        Some(route(&before, "route-001").revision)
    );
    assert_eq!(result.snapshot, before);
}

#[test]
fn exhausted_route_revision_rejects_without_mutating_the_snapshot() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let mut state = engine.snapshot();
    route_mut(&mut state, "route-001").revision = u32::MAX;
    let before = state.clone();
    let topology = RoadTopology::compile(&state.map).expect("fixture topology");

    let result = route_editor::update_route(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        "route-001",
        u32::MAX,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-003"]),
    );

    let rejection = result.expect_err("exhausted revision must reject");
    assert_eq!(rejection.code, RejectionCode::RouteRevisionExhausted);
    assert_eq!(rejection.context.route_id.as_deref(), Some("route-001"));
    assert_eq!(rejection.context.actual_revision, Some(u32::MAX));
    assert_eq!(state, before);
}

#[test]
fn update_preserves_latest_name_color_active_and_vehicle_set() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST * 2);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let captured = route(&engine.snapshot(), "route-001").clone();
    dispatch(
        &mut engine,
        GameIntent::RenameRoute {
            route_id: captured.id.clone(),
            name: "Latest name".into(),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::RecolorRoute {
            route_id: captured.id.clone(),
            color: "#123456".into(),
        },
    );
    dispatch(
        &mut engine,
        GameIntent::SetRouteActive {
            route_id: captured.id.clone(),
            active: false,
        },
    );

    let result = engine.dispatch(GameIntent::UpdateRoute {
        route_id: captured.id.clone(),
        expected_revision: captured.revision,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-003"]),
    });
    assert!(result.applied, "{result:?}");
    let updated = route(&result.snapshot, &captured.id);
    assert_eq!(updated.name, "Latest name");
    assert_eq!(updated.color, "#123456");
    assert!(!updated.active);
    assert_eq!(updated.vehicle_ids, captured.vehicle_ids);
}

#[test]
fn identical_update_leaves_structural_revision_unchanged() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let before = route(&engine.snapshot(), "route-001").clone();

    let result = engine.dispatch(GameIntent::UpdateRoute {
        route_id: before.id.clone(),
        expected_revision: before.revision,
        pattern: before.pattern,
        waypoint_ids: before.stop_ids.clone(),
    });
    // True structural no-ops leave the snapshot equal (no vehicle rebase), so
    // the engine may report applied=false while still accepting the save.
    assert!(result.rejection.is_none(), "{result:?}");
    let updated = route(&result.snapshot, &before.id);
    assert_eq!(updated.revision, before.revision);
    assert_eq!(updated.stop_ids, before.stop_ids);
    assert_eq!(updated.pattern, before.pattern);
    assert_eq!(updated.legs, before.legs);
}

#[test]
fn update_applies_platform_delta_and_one_revision_increment() {
    let mut engine = editable_metro_engine(&[2, 6, 10], METRO_COST * 2);
    create_route(
        &mut engine,
        TransitMode::Metro,
        ServicePattern::Loop,
        ids(&["station-001", "station-002"]),
    );
    create_route(
        &mut engine,
        TransitMode::Metro,
        ServicePattern::Loop,
        ids(&["station-001", "station-003"]),
    );
    let before = engine.snapshot();
    let old_revision = before.transit.metro_lines[0].revision;
    assert_eq!(
        route_platform_id(&before, "station-001", "metro-001").as_deref(),
        Some("station-001-p0")
    );
    assert_eq!(
        route_platform_id(&before, "station-003", "metro-002").as_deref(),
        Some("station-003-p0")
    );

    let result = engine.dispatch(GameIntent::UpdateRoute {
        route_id: "metro-001".into(),
        expected_revision: old_revision,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["station-001", "station-003"]),
    });
    assert!(result.applied, "{result:?}");
    let updated = &result.snapshot.transit.metro_lines[0];
    assert_eq!(updated.revision, old_revision + 1);
    assert_eq!(
        route_platform_id(&result.snapshot, "station-001", "metro-001").as_deref(),
        Some("station-001-p0")
    );
    assert!(route_platform_id(&result.snapshot, "station-002", "metro-001").is_none());
    assert_eq!(
        route_platform_id(&result.snapshot, "station-003", "metro-001").as_deref(),
        Some("station-003-p1")
    );
}

#[test]
fn only_structural_mutations_increment_revision() {
    let mut engine = editable_metro_engine(&[2, 10], METRO_COST * 2);
    create_route(
        &mut engine,
        TransitMode::Metro,
        ServicePattern::Loop,
        ids(&["station-001", "station-002"]),
    );
    let revision = engine.snapshot().transit.metro_lines[0].revision;
    for intent in [
        GameIntent::RenameRoute {
            route_id: "metro-001".into(),
            name: "Renamed".into(),
        },
        GameIntent::RecolorRoute {
            route_id: "metro-001".into(),
            color: "#010203".into(),
        },
        GameIntent::AssignVehicle {
            mode: "metro".into(),
            line_id: "metro-001".into(),
        },
        GameIntent::SetRouteActive {
            route_id: "metro-001".into(),
            active: false,
        },
    ] {
        dispatch(&mut engine, intent);
        assert_eq!(engine.snapshot().transit.metro_lines[0].revision, revision);
    }

    dispatch(
        &mut engine,
        GameIntent::AssignRouteToPlatform {
            node_id: "station-001".into(),
            route_id: "metro-001".into(),
            platform_id: "station-001-p1".into(),
        },
    );
    assert_eq!(
        engine.snapshot().transit.metro_lines[0].revision,
        revision + 1
    );
}

#[test]
fn exhausted_platform_revision_rejects_without_reassigning_the_platform() {
    let mut engine = editable_metro_engine(&[2, 10], METRO_COST * 2);
    create_route(
        &mut engine,
        TransitMode::Metro,
        ServicePattern::Loop,
        ids(&["station-001", "station-002"]),
    );
    engine.set_route_revision_for_test("metro-001", u32::MAX);
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::AssignRouteToPlatform {
        node_id: "station-001".into(),
        route_id: "metro-001".into(),
        platform_id: "station-001-p1".into(),
    });

    assert!(!result.applied);
    let rejection = result
        .rejection
        .expect("exhausted platform revision must reject");
    assert_eq!(rejection.code, RejectionCode::RouteRevisionExhausted);
    assert_eq!(rejection.context.route_id.as_deref(), Some("metro-001"));
    assert_eq!(rejection.context.actual_revision, Some(u32::MAX));
    assert_eq!(result.snapshot, before);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn only_identical_preexisting_broken_directional_legs_may_carry_forward() {
    let mut engine = editable_bus_engine(&[2, 10, 3, 12], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(4, 5) });
    let broken = engine.snapshot();
    let revision = route(&broken, "route-001").revision;
    assert!(route(&broken, "route-001").path_broken);

    let unchanged = engine.dispatch(GameIntent::UpdateRoute {
        route_id: "route-001".into(),
        expected_revision: revision,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    // Identical Save is not a DisconnectedLeg rejection; pure structural no-op
    // may report applied=false and leaves the revision alone.
    assert!(unchanged.rejection.is_none(), "{unchanged:?}");
    assert_eq!(route(&unchanged.snapshot, "route-001").revision, revision);
    assert!(route(&unchanged.snapshot, "route-001").path_broken);

    for (pattern, waypoint_ids) in [
        (ServicePattern::Loop, ids(&["stop-003", "stop-002"])),
        (ServicePattern::Loop, ids(&["stop-001", "stop-004"])),
        (ServicePattern::Shuttle, ids(&["stop-001", "stop-002"])),
        (
            ServicePattern::Loop,
            ids(&["stop-001", "stop-003", "stop-002"]),
        ),
    ] {
        let mut candidate = editable_bus_engine(&[2, 10, 3, 12], BUS_COST);
        create_route(
            &mut candidate,
            TransitMode::Bus,
            ServicePattern::Loop,
            ids(&["stop-001", "stop-002"]),
        );
        dispatch(
            &mut candidate,
            GameIntent::RemoveAtTile { point: point(4, 5) },
        );
        let expected_revision = route(&candidate.snapshot(), "route-001").revision;
        let result = candidate.dispatch(GameIntent::UpdateRoute {
            route_id: "route-001".into(),
            expected_revision,
            pattern,
            waypoint_ids,
        });
        let rejection = result.rejection.expect("new broken leg rejection");
        assert_eq!(rejection.code, RejectionCode::DisconnectedLeg);
        assert!(rejection.context.from_waypoint_id.is_some());
        assert!(rejection.context.to_waypoint_id.is_some());
    }
}

fn riding_trip(route_id: &str, passenger_id: &str) -> ActiveTrip {
    ActiveTrip {
        id: passenger_id.into(),
        sim_id: "sim-001".into(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(2, 4),
        destination: point(10, 4),
        position: point(4, 5).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: point(2, 4),
                to: point(10, 4),
                line_id: Some(route_id.into()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: 10.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }
}

fn trip_with_future_route_leg(route_id: &str) -> ActiveTrip {
    ActiveTrip {
        id: "trip-002".into(),
        sim_id: "sim-002".into(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(0, 5),
        destination: point(10, 4),
        position: point(1, 5).into(),
        status: TripStatus::Walking,
        deadline: 100.0,
        route_plan: Some(RoutePlan {
            legs: vec![
                RouteLeg {
                    mode: TransitMode::Walk,
                    from: point(0, 5),
                    to: point(2, 4),
                    line_id: None,
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: point(2, 4),
                    to: point(10, 4),
                    line_id: Some(route_id.into()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                },
            ],
            estimated_seconds: 30.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }
}

fn update_direct(
    state: &GameSnapshot,
    route_id: &str,
    expected_revision: u32,
    waypoint_ids: Vec<String>,
) -> GameSnapshot {
    let topology = RoadTopology::compile(&state.map).expect("fixture topology");
    route_editor::update_route(
        state,
        RoutingContext {
            road_topology: &topology,
        },
        route_id,
        expected_revision,
        ServicePattern::Loop,
        waypoint_ids,
    )
    .expect("fixture update should apply")
}

#[test]
fn identical_save_skips_vehicle_rebase_and_trip_invalidation() {
    let mut engine = editable_bus_engine(&[2, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let mut state = engine.snapshot();
    state.transit.vehicles[0].path_step_index = 2;
    state.transit.vehicles[0].step_progress = 0.4;
    state.transit.vehicles[0].passenger_ids = ids(&["trip-001"]);
    state.active_trips = vec![riding_trip("route-001", "trip-001")];
    let revision = route(&state, "route-001").revision;
    let before_vehicle = state.transit.vehicles[0].clone();
    let before_trip = state.active_trips[0].clone();

    let result = update_direct(
        &state,
        "route-001",
        revision,
        ids(&["stop-001", "stop-002"]),
    );

    assert_eq!(route(&result, "route-001").revision, revision);
    let vehicle = vehicle(&result, "vehicle-001");
    assert_eq!(vehicle.path_step_index, before_vehicle.path_step_index);
    assert_eq!(vehicle.step_progress, before_vehicle.step_progress);
    assert_eq!(vehicle.passenger_ids, before_vehicle.passenger_ids);
    assert_eq!(vehicle.parked_position, before_vehicle.parked_position);
    assert_eq!(result.active_trips[0].status, before_trip.status);
    assert_eq!(result.active_trips[0].route_plan, before_trip.route_plan);
}

#[test]
fn edit_may_retain_preexisting_missing_waypoint_while_changing_another() {
    let mut engine = editable_bus_engine(&[2, 6, 10, 12], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002", "stop-003"]),
    );
    let mut state = engine.snapshot();
    state = transit::remove_at_tile(&state, &point(6, 4)).expect("tombstone middle stop");
    assert!(state
        .transit
        .stops
        .iter()
        .any(|stop| stop.id == "stop-002" && stop.status == TransitNodeStatus::Missing));
    let revision = route(&state, "route-001").revision;

    let result = update_direct(
        &state,
        "route-001",
        revision,
        ids(&["stop-001", "stop-002", "stop-004"]),
    );

    assert_eq!(
        route(&result, "route-001").stop_ids,
        ids(&["stop-001", "stop-002", "stop-004"])
    );
    assert!(route(&result, "route-001").path_broken);
    assert!(result
        .transit
        .stops
        .iter()
        .any(|stop| stop.id == "stop-002" && stop.status == TransitNodeStatus::Missing));
}

#[test]
fn live_update_rebases_vehicles_replans_riders_and_collects_last_tombstone() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002", "stop-003"]),
    );
    let mut state = engine.snapshot();
    state.transit.vehicles[0].path_step_index = 1;
    state.transit.vehicles[0].step_progress = 0.5;
    state.transit.vehicles[0].passenger_ids = ids(&["trip-001"]);
    state.active_trips = vec![riding_trip("route-001", "trip-001")];
    state = transit::remove_at_tile(&state, &point(6, 4)).expect("tombstone stop");
    assert!(state
        .transit
        .stops
        .iter()
        .any(|stop| { stop.id == "stop-002" && stop.status == TransitNodeStatus::Missing }));
    let revision = route(&state, "route-001").revision;

    let result = update_direct(
        &state,
        "route-001",
        revision,
        ids(&["stop-001", "stop-003"]),
    );

    let edited_vehicle = vehicle(&result, "vehicle-001");
    assert_eq!(edited_vehicle.parked_position, Some(point(2, 5).into()));
    assert!(edited_vehicle.passenger_ids.is_empty());
    assert_eq!(result.active_trips[0].status, TripStatus::Idle);
    assert!(result.active_trips[0].route_plan.is_none());
    assert!(!result
        .transit
        .stops
        .iter()
        .any(|stop| stop.id == "stop-002"));
}

#[test]
fn live_update_replans_trip_with_edited_route_only_in_a_future_remaining_leg() {
    let mut engine = editable_bus_engine(&[2, 6, 10], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let mut state = engine.snapshot();
    state.active_trips = vec![trip_with_future_route_leg("route-001")];
    let original_position = state.active_trips[0].position.clone();
    let revision = route(&state, "route-001").revision;

    let result = update_direct(
        &state,
        "route-001",
        revision,
        ids(&["stop-001", "stop-003"]),
    );

    let trip = &result.active_trips[0];
    assert_eq!(trip.status, TripStatus::Idle);
    assert!(trip.route_plan.is_none());
    assert_eq!(trip.current_leg_index, 0);
    assert_eq!(trip.position, original_position);
}

#[test]
fn update_reports_route_not_found_and_rebases_to_new_live_stop_without_retained_nodes() {
    let mut missing_engine = editable_bus_engine(&[2, 10], BUS_COST);
    let missing = missing_engine.dispatch(GameIntent::UpdateRoute {
        route_id: "route-999".into(),
        expected_revision: 0,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    assert_eq!(
        missing.rejection.expect("missing route rejection").code,
        RejectionCode::RouteNotFound
    );

    let mut engine = editable_bus_engine(&[2, 6, 10, 12], BUS_COST);
    create_route(
        &mut engine,
        TransitMode::Bus,
        ServicePattern::Loop,
        ids(&["stop-001", "stop-002"]),
    );
    let mut state = engine.snapshot();
    state.transit.vehicles[0].path_step_index = 1;
    state.transit.vehicles[0].step_progress = 0.25;
    let topology = RoadTopology::compile(&state.map).expect("fixture topology");
    let before_world =
        route_lifecycle_world_position(&state, &topology, "route-001", &state.transit.vehicles[0]);
    let revision = route(&state, "route-001").revision;

    let result = update_direct(
        &state,
        "route-001",
        revision,
        ids(&["stop-003", "stop-004"]),
    );
    // With no retained waypoints, the vehicle is rebased to the nearest present
    // stop on the new operational route (stop-003 at x=10) rather than parked at
    // its old world coordinate, which would teleport on the next tick when
    // `tick_vehicles` clears `parked_position` and advances the reset itinerary.
    let stop_003 = result
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-003")
        .expect("stop-003 present");
    let parked = vehicle(&result, "vehicle-001")
        .parked_position
        .as_ref()
        .expect("vehicle is parked at a new live stop");
    let road_access = stop_003.road_access.expect("stop has road access");
    assert_eq!(parked.x, f64::from(road_access.road_point.x));
    assert_eq!(parked.y, f64::from(road_access.road_point.y));
    assert_ne!(parked, &before_world);
}

fn route_lifecycle_world_position(
    state: &GameSnapshot,
    _topology: &RoadTopology,
    route_id: &str,
    vehicle: &Vehicle,
) -> TripPosition {
    let route = route(state, route_id);
    let leg = &route.legs[vehicle.itinerary_index % route.legs.len()];
    let path = leg.current_path.as_ref().expect("connected fixture path");
    let step = path
        .step(vehicle.path_step_index)
        .expect("fixture path step");
    match step {
        caelum_core::model::TransitPathStepRef::Road(step) => match &step.geometry {
            caelum_core::model::PathGeometry::Line { from, to } => TripPosition {
                x: from.x + (to.x - from.x) * vehicle.step_progress,
                y: from.y + (to.y - from.y) * vehicle.step_progress,
            },
            geometry => panic!("expected straight fixture geometry, got {geometry:?}"),
        },
        caelum_core::model::TransitPathStepRef::Track(_) => unreachable!("bus fixture"),
    }
}
