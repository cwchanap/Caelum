use caelum_core::model::{
    ActiveTrip, GameSnapshot, Point, Route, RouteLeg, RoutePlan, ServiceDirection, ServicePattern,
    TransitMode, TransitNodeStatus, TripPosition, TripPurpose, TripStatus, Vehicle,
};
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
                point: point(*x, 5),
            },
        );
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

fn create_route(
    engine: &mut GameEngine,
    mode: TransitMode,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
) {
    dispatch(
        engine,
        GameIntent::CreateRoute {
            mode,
            pattern,
            waypoint_ids,
        },
    );
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
fn create_route_atomically_adds_line_platforms_vehicle_and_budget_charge() {
    let mut engine = editable_bus_engine(&[2, 10], BUS_COST);
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    assert!(result.applied, "{result:?}");
    assert_eq!(
        result.context.affected_route_ids,
        vec!["route-001".to_string()]
    );
    assert_eq!(result.snapshot.transit.routes.len(), 1);
    assert_eq!(result.snapshot.transit.vehicles.len(), 1);
    assert_eq!(result.snapshot.budget, before.budget - BUS_COST);
    let created = route(&result.snapshot, "route-001");
    assert_eq!(created.vehicle_ids, ids(&["vehicle-001"]));
    assert_eq!(created.pattern, ServicePattern::Loop);
    assert!(!created.path_broken);
    assert!(created
        .stop_ids
        .iter()
        .all(|id| route_platform_id(&result.snapshot, id, &created.id).is_some()));
}

#[test]
fn failed_create_commits_none_of_the_staged_entities_or_budget() {
    let mut engine = editable_bus_engine(&[2, 10], BUS_COST - 1);
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    assert!(!result.applied);
    assert_eq!(
        result.rejection.expect("budget rejection").code,
        RejectionCode::InsufficientBudget
    );
    assert_eq!(result.snapshot, before);
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
        origin: point(2, 5),
        destination: point(10, 5),
        position: point(4, 5).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: point(2, 5),
                to: point(10, 5),
                line_id: Some(route_id.into()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: 10.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }
}

fn trip_with_future_route_leg(route_id: &str) -> ActiveTrip {
    ActiveTrip {
        id: "trip-002".into(),
        sim_id: "sim-002".into(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(0, 5),
        destination: point(10, 5),
        position: point(1, 5).into(),
        status: TripStatus::Walking,
        deadline: 100.0,
        route_plan: Some(RoutePlan {
            legs: vec![
                RouteLeg {
                    mode: TransitMode::Walk,
                    from: point(0, 5),
                    to: point(2, 5),
                    line_id: None,
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: point(2, 5),
                    to: point(10, 5),
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
    state = transit::remove_at_tile(&state, &point(6, 5)).expect("tombstone middle stop");
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
    state = transit::remove_at_tile(&state, &point(6, 5)).expect("tombstone stop");
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
fn update_reports_route_not_found_and_uses_world_parking_without_retained_nodes() {
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

    let mut engine = editable_bus_engine(&[2, 6, 10, 13], BUS_COST);
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
    assert_eq!(
        vehicle(&result, "vehicle-001").parked_position,
        Some(before_world)
    );
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
