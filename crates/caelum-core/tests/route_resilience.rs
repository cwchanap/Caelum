use caelum_core::model::{
    ActiveTrip, BusStopKind, GameSnapshot, Heading, PathGeometry, Point, Route, RouteLegStatus,
    RoutePlan, ServiceDirection, ServicePattern, TransitMode, TransitNodeStatus, TransitPath,
    TripPosition, TripPurpose, TripStatus, Vehicle,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::{
    route_lifecycle::{self, project_position_onto_path},
    transit, GameEngine, GameIntent, RoadPreset, RoutingContext,
};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn route<'a>(state: &'a GameSnapshot, route_id: &str) -> &'a Route {
    state
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .expect("fixture route exists")
}

fn vehicle<'a>(state: &'a GameSnapshot, vehicle_id: &str) -> &'a Vehicle {
    state
        .transit
        .vehicles
        .iter()
        .find(|vehicle| vehicle.id == vehicle_id)
        .expect("fixture vehicle exists")
}

fn lay_two_way_line(engine: &mut GameEngine, points: Vec<Point>) {
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "fixture road should apply: {result:?}");
}

fn set_one_way_line(engine: &mut GameEngine, points: Vec<Point>) {
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::OneWay,
    });
    assert!(result.applied, "fixture direction should apply: {result:?}");
}

fn horizontal(y: i32, from_x: i32, to_x: i32) -> Vec<Point> {
    if from_x <= to_x {
        (from_x..=to_x).map(|x| point(x, y)).collect()
    } else {
        (to_x..=from_x).rev().map(|x| point(x, y)).collect()
    }
}

fn vertical(x: i32, from_y: i32, to_y: i32) -> Vec<Point> {
    if from_y <= to_y {
        (from_y..=to_y).map(|y| point(x, y)).collect()
    } else {
        (to_y..=from_y).rev().map(|y| point(x, y)).collect()
    }
}

fn add_bus_route(engine: &mut GameEngine, stops: &[(i32, i32)]) {
    for &(x, y) in stops {
        let result = engine.dispatch(GameIntent::AddBusStop { point: point(x, y) });
        assert!(result.applied, "fixture stop should apply: {result:?}");
    }
    let stop_ids = (1..=stops.len())
        .map(|index| format!("stop-{index:03}"))
        .collect();
    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: stop_ids,
    });
    assert!(result.applied, "fixture route should apply: {result:?}");
}

fn geometry_at(path: &TransitPath, index: usize) -> &PathGeometry {
    match path {
        TransitPath::Road { steps, .. } => &steps[index].geometry,
        TransitPath::Track { steps, .. } => &steps[index].geometry,
    }
}

fn point_at(geometry: &PathGeometry, progress: f64) -> TripPosition {
    match geometry {
        PathGeometry::Line { from, to } => TripPosition {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
        },
        PathGeometry::QuadraticBezier { from, control, to } => {
            let inverse = 1.0 - progress;
            TripPosition {
                x: inverse * inverse * from.x
                    + 2.0 * inverse * progress * control.x
                    + progress * progress * to.x,
                y: inverse * inverse * from.y
                    + 2.0 * inverse * progress * control.y
                    + progress * progress * to.y,
            }
        }
    }
}

fn recompute_after_removal(previous: &GameSnapshot, removed: Point) -> GameSnapshot {
    let candidate = transit::remove_at_tile(previous, &removed).expect("fixture removal applies");
    recompute_after_candidate(previous, candidate)
}

fn recompute_after_candidate(previous: &GameSnapshot, candidate: GameSnapshot) -> GameSnapshot {
    let topology = RoadTopology::compile(&candidate.map).expect("candidate topology compiles");
    route_lifecycle::recompute_all_routes(
        previous,
        candidate,
        RoutingContext {
            road_topology: &topology,
        },
    )
    .expect("fixture route revisions are available")
}

struct BrokenServiceFixture {
    state: GameSnapshot,
    route_id: String,
    vehicle_id: String,
    rider_id: String,
    vehicle_world: TripPosition,
}

fn moving_vehicle_with_rider_fixture() -> BrokenServiceFixture {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(5, 2, 10));
    add_bus_route(&mut engine, &[(2, 5), (10, 5)]);
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture vehicle should apply: {assigned:?}"
    );

    let mut state = assigned.snapshot;
    let path = state.transit.routes[0].legs[0]
        .current_path
        .as_ref()
        .expect("fixture route is connected");
    let path_step_index = path.step_count() - 1;
    let vehicle_world = point_at(geometry_at(path, path_step_index), 0.75);
    let rider_id = "trip-001".to_string();
    state.transit.vehicles[0].path_step_index = path_step_index;
    state.transit.vehicles[0].step_progress = 0.75;
    state.transit.vehicles[0].passenger_ids = vec![rider_id.clone()];
    state.active_trips.push(ActiveTrip {
        id: rider_id.clone(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(2, 5),
        destination: point(10, 5),
        position: vehicle_world.clone(),
        status: TripStatus::Riding,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: vec![caelum_core::model::RouteLeg {
                mode: TransitMode::Bus,
                from: point(2, 5),
                to: point(10, 5),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: path.total_travel_seconds(),
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    });

    BrokenServiceFixture {
        state,
        route_id: "route-001".to_string(),
        vehicle_id: "vehicle-001".to_string(),
        rider_id,
        vehicle_world,
    }
}

struct AlternateRouteFixture {
    state: GameSnapshot,
    route_id: String,
    vehicle_id: String,
    rider_id: String,
    old_path: TransitPath,
    old_heading: Heading,
}

fn route_with_alternate_path_and_rider() -> AlternateRouteFixture {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(5, 2, 10));
    lay_two_way_line(&mut engine, horizontal(7, 2, 10));
    lay_two_way_line(&mut engine, vertical(2, 5, 7));
    lay_two_way_line(&mut engine, vertical(10, 5, 7));
    add_bus_route(&mut engine, &[(2, 5), (10, 5)]);
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture vehicle should apply: {assigned:?}"
    );

    let mut state = engine.snapshot();
    let old_path = state.transit.routes[0].legs[0]
        .current_path
        .clone()
        .expect("fixture route is connected");
    let step_index = old_path.step_count() / 2;
    let old_heading = match &old_path {
        TransitPath::Road { steps, .. } => steps[step_index].leaving_heading,
        TransitPath::Track { .. } => unreachable!("fixture route is a bus route"),
    };
    let rider_id = "trip-001".to_string();
    state.transit.vehicles[0].itinerary_index = 0;
    state.transit.vehicles[0].path_step_index = step_index;
    state.transit.vehicles[0].step_progress = 0.5;
    state.transit.vehicles[0].passenger_ids = vec![rider_id.clone()];
    state.active_trips.push(ActiveTrip {
        id: rider_id.clone(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(2, 5),
        destination: point(10, 5),
        position: point(5, 5).into(),
        status: TripStatus::Riding,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: vec![caelum_core::model::RouteLeg {
                mode: TransitMode::Bus,
                from: point(2, 5),
                to: point(10, 5),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: old_path.total_travel_seconds(),
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    });

    AlternateRouteFixture {
        state,
        route_id: "route-001".to_string(),
        vehicle_id: "vehicle-001".to_string(),
        rider_id,
        old_path,
        old_heading,
    }
}

fn one_way_three_leg_route() -> GameSnapshot {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(5, 2, 10));
    lay_two_way_line(&mut engine, vertical(10, 5, 9));
    lay_two_way_line(&mut engine, horizontal(9, 10, 2));
    lay_two_way_line(&mut engine, vertical(2, 9, 5));

    set_one_way_line(&mut engine, horizontal(5, 3, 5));
    set_one_way_line(&mut engine, horizontal(5, 7, 9));
    set_one_way_line(&mut engine, vertical(10, 6, 8));
    set_one_way_line(&mut engine, horizontal(9, 9, 3));
    set_one_way_line(&mut engine, vertical(2, 8, 6));

    add_bus_route(&mut engine, &[(2, 5), (6, 5), (10, 5)]);
    let state = engine.snapshot();
    assert!(state.transit.routes[0]
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected));
    state
}

#[test]
fn alternate_road_path_replaces_current_and_last_valid_without_ejecting_riders() {
    let fixture = route_with_alternate_path_and_rider();
    let before_trip = fixture.state.active_trips[0].clone();
    let old_vehicle = vehicle(&fixture.state, &fixture.vehicle_id);
    let old_world = point_at(
        geometry_at(&fixture.old_path, old_vehicle.path_step_index),
        old_vehicle.step_progress,
    );

    let next = recompute_after_removal(&fixture.state, point(6, 5));
    let route = route(&next, &fixture.route_id);
    let vehicle = vehicle(&next, &fixture.vehicle_id);
    let new_path = route.legs[0]
        .current_path
        .as_ref()
        .expect("alternate path keeps the leg connected");
    let projection = project_position_onto_path(new_path, old_world, fixture.old_heading);

    assert!(route
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected));
    assert_eq!(route.legs[0].current_path, route.legs[0].last_valid_path);
    assert_ne!(route.legs[0].current_path, Some(fixture.old_path));
    assert_eq!(vehicle.passenger_ids, vec![fixture.rider_id]);
    assert_eq!(vehicle.path_step_index, projection.path_step_index);
    assert_eq!(vehicle.step_progress, projection.step_progress);
    assert_eq!(next.active_trips[0], before_trip);
}

#[test]
fn disconnected_leg_clears_only_current_and_retains_its_last_alignment() {
    let state = one_way_three_leg_route();
    let before = state.transit.routes[0].legs.clone();

    let next = recompute_after_removal(&state, point(8, 5));
    let legs = &next.transit.routes[0].legs;

    assert_eq!(legs[0], before[0]);
    assert_eq!(legs[1].status, RouteLegStatus::NetworkDisconnected);
    assert!(legs[1].current_path.is_none());
    assert_eq!(legs[1].last_valid_path, before[1].last_valid_path);
    assert_eq!(legs[2], before[2]);
}

#[test]
fn one_topology_transaction_increments_route_revision_once() {
    let fixture = route_with_alternate_path_and_rider();
    let before = route(&fixture.state, &fixture.route_id).revision;

    let next = recompute_after_removal(&fixture.state, point(6, 5));

    assert_eq!(route(&next, &fixture.route_id).revision, before + 1);
}

#[test]
fn first_broken_transition_parks_at_nearest_live_waypoint_and_replans_riders() {
    let fixture = moving_vehicle_with_rider_fixture();
    let old_active = route(&fixture.state, &fixture.route_id).active;

    let next = recompute_after_removal(&fixture.state, point(6, 5));
    let route = route(&next, &fixture.route_id);
    let vehicle = vehicle(&next, &fixture.vehicle_id);
    let rider = next
        .active_trips
        .iter()
        .find(|trip| trip.id == fixture.rider_id)
        .expect("fixture rider remains active for replanning");

    assert!(route.path_broken);
    assert_eq!(route.active, old_active);
    assert_eq!(vehicle.parked_position, Some(point(10, 5).into()));
    assert!(vehicle.passenger_ids.is_empty());
    assert_eq!(rider.position, point(10, 5).into());
    assert_eq!(rider.status, TripStatus::Idle);
    assert!(rider.route_plan.is_none());
    assert_eq!(rider.current_leg_index, 0);
}

#[test]
fn no_live_waypoint_keeps_the_current_world_position_as_out_of_service_parking() {
    let fixture = moving_vehicle_with_rider_fixture();
    let candidate = transit::remove_at_tiles(&fixture.state, &[point(2, 5), point(10, 5)])
        .expect("fixture waypoint removal applies");

    let next = recompute_after_candidate(&fixture.state, candidate);
    let vehicle = vehicle(&next, &fixture.vehicle_id);

    assert!(route(&next, &fixture.route_id).path_broken);
    assert_eq!(vehicle.parked_position, Some(fixture.vehicle_world.clone()));
    assert_eq!(next.active_trips[0].position, fixture.vehicle_world);
}

#[test]
fn broken_transition_skips_a_vehicle_without_an_exact_world_position() {
    let mut fixture = moving_vehicle_with_rider_fixture();
    fixture.state.transit.vehicles[0].path_step_index = usize::MAX;

    let next = recompute_after_removal(&fixture.state, point(6, 5));
    let skipped_vehicle = vehicle(&next, &fixture.vehicle_id);

    // The route is still broken — the service transition completed.
    assert!(route(&next, &fixture.route_id).path_broken);
    // The vehicle was skipped (not parked): it has no parked position.
    assert!(skipped_vehicle.parked_position.is_none());
    // The cursor is defensively reset so a corrupted step index cannot
    // survive a skip→restore cycle and trigger a deferred panic.
    assert_eq!(skipped_vehicle.path_step_index, 0);
    assert_eq!(skipped_vehicle.step_progress, 0.0);
    // The ghost passenger scrub still cleared its passengers.
    assert!(skipped_vehicle.passenger_ids.is_empty());
    // The rider was invalidated even though the vehicle was skipped.
    let rider = next
        .active_trips
        .iter()
        .find(|trip| trip.id == fixture.rider_id)
        .expect("rider trip exists");
    assert_eq!(rider.status, TripStatus::Idle);
    assert!(rider.route_plan.is_none());
}

#[test]
fn repaired_active_route_rebases_and_resumes_without_flipping_active() {
    let fixture = moving_vehicle_with_rider_fixture();
    let broken = recompute_after_removal(&fixture.state, point(6, 5));
    let repair_candidate = transit::lay_road(&broken, &point(6, 5)).expect("repair applies");

    let repaired = recompute_after_candidate(&broken, repair_candidate);
    let route = route(&repaired, &fixture.route_id);
    let vehicle = vehicle(&repaired, &fixture.vehicle_id);

    assert!(!route.path_broken);
    assert!(route.active);
    assert!(vehicle.parked_position.is_none());
    assert_eq!(vehicle.itinerary_index, 1);
    assert_eq!(vehicle.path_step_index, 0);
    assert_eq!(vehicle.step_progress, 0.0);
}

#[test]
fn repaired_paused_route_stays_paused() {
    let fixture = moving_vehicle_with_rider_fixture();
    let mut broken = recompute_after_removal(&fixture.state, point(6, 5));
    broken.transit.routes[0].active = false;
    let repair_candidate = transit::lay_road(&broken, &point(6, 5)).expect("repair applies");

    let repaired = recompute_after_candidate(&broken, repair_candidate);

    assert!(!route(&repaired, &fixture.route_id).active);
    assert!(vehicle(&repaired, &fixture.vehicle_id)
        .parked_position
        .is_some());
}

#[test]
fn restoring_one_live_waypoint_reparks_a_still_broken_vehicle_there() {
    let fixture = moving_vehicle_with_rider_fixture();
    let no_nodes_candidate = transit::remove_at_tiles(&fixture.state, &[point(2, 5), point(10, 5)])
        .expect("fixture waypoint removal applies");
    let no_nodes = recompute_after_candidate(&fixture.state, no_nodes_candidate);
    let restore_candidate =
        transit::add_bus_stop(&no_nodes, &point(10, 5)).expect("waypoint restoration applies");

    let one_node = recompute_after_candidate(&no_nodes, restore_candidate);

    assert!(route(&one_node, &fixture.route_id).path_broken);
    assert_eq!(
        vehicle(&one_node, &fixture.vehicle_id).parked_position,
        Some(point(10, 5).into())
    );
}

#[test]
fn mutations_while_already_broken_do_not_repeat_break_side_effects() {
    let fixture = moving_vehicle_with_rider_fixture();
    let mut broken = recompute_after_removal(&fixture.state, point(6, 5));
    broken.active_trips.push(ActiveTrip {
        id: "trip-after-break".to_string(),
        sim_id: "sim-002".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: point(2, 5),
        destination: point(10, 5),
        position: point(2, 5).into(),
        status: TripStatus::Waiting,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: vec![caelum_core::model::RouteLeg {
                mode: TransitMode::Bus,
                from: point(2, 5),
                to: point(10, 5),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: 10.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    });
    let before_parking = vehicle(&broken, &fixture.vehicle_id)
        .parked_position
        .clone();
    let candidate = transit::lay_road(&broken, &point(20, 12)).expect("unrelated road applies");

    let next = recompute_after_candidate(&broken, candidate);
    let untouched_trip = next
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-after-break")
        .expect("fixture trip remains");

    assert_eq!(
        vehicle(&next, &fixture.vehicle_id).parked_position,
        before_parking
    );
    assert_eq!(untouched_trip.status, TripStatus::Waiting);
    assert!(untouched_trip.route_plan.is_some());
}

fn shared_stop_route_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(5, 2, 10));
    for x in [2, 6, 10] {
        let added = engine.dispatch(GameIntent::AddBusStop { point: point(x, 5) });
        assert!(added.applied, "fixture stop should apply: {added:?}");
    }
    for stop_ids in [
        vec!["stop-001".to_string(), "stop-002".to_string()],
        vec!["stop-002".to_string(), "stop-003".to_string()],
    ] {
        let added = engine.dispatch(GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: stop_ids,
        });
        assert!(added.applied, "fixture route should apply: {added:?}");
    }
    engine
}

#[test]
fn referenced_demolition_preserves_shared_node_and_route_identity() {
    let mut engine = shared_stop_route_engine();
    let before = engine.snapshot();
    let original_platforms = before.transit.stops[1].platforms.clone();

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });

    assert!(removed.applied);
    let preserved = removed
        .snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-002")
        .expect("a referenced stop should be retained as a tombstone");
    assert_eq!(preserved.status, TransitNodeStatus::Missing);
    assert_eq!(preserved.position, point(6, 5));
    assert_eq!(preserved.platforms, original_platforms);
    assert_eq!(
        removed
            .snapshot
            .transit
            .routes
            .iter()
            .map(|route| route.id.as_str())
            .collect::<Vec<_>>(),
        vec!["route-001", "route-002"]
    );
    assert!(removed.snapshot.transit.routes.iter().all(|route| {
        route.path_broken
            && route
                .legs
                .iter()
                .any(|leg| leg.status == RouteLegStatus::MissingNode)
    }));

    let reused = engine.dispatch(GameIntent::LayTrack { point: point(6, 5) });
    assert!(
        reused.applied,
        "a missing stop must not occupy its anchor: {reused:?}"
    );
}

#[test]
fn same_kind_same_anchor_rebuild_restores_shared_node_once() {
    let mut engine = shared_stop_route_engine();
    let original_platforms = engine.snapshot().transit.stops[1].platforms.clone();
    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });
    assert!(removed.applied);

    let restored = engine.dispatch(GameIntent::AddBusStop { point: point(6, 5) });

    assert!(restored.applied, "restore should apply: {restored:?}");
    let matching: Vec<_> = restored
        .snapshot
        .transit
        .stops
        .iter()
        .filter(|stop| stop.position == point(6, 5))
        .collect();
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].id, "stop-002");
    assert_eq!(matching[0].status, TransitNodeStatus::Present);
    assert_eq!(matching[0].platforms, original_platforms);
    assert!(restored
        .snapshot
        .transit
        .routes
        .iter()
        .all(|route| !route.path_broken));
}

#[test]
fn unreferenced_node_deletes_instead_of_tombstoning() {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(5, 2, 4));
    let added = engine.dispatch(GameIntent::AddBusStop { point: point(2, 5) });
    assert!(added.applied);

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(2, 5) });

    assert!(removed.applied);
    assert!(removed.snapshot.transit.stops.is_empty());
}

#[test]
fn removing_last_route_reference_garbage_collects_tombstone() {
    let mut engine = shared_stop_route_engine();
    engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });

    let first = engine.dispatch(GameIntent::DeleteRoute {
        route_id: "route-001".to_string(),
    });
    assert!(first
        .snapshot
        .transit
        .stops
        .iter()
        .any(|stop| stop.id == "stop-002"));

    let second = engine.dispatch(GameIntent::DeleteRoute {
        route_id: "route-002".to_string(),
    });
    assert!(second
        .snapshot
        .transit
        .stops
        .iter()
        .all(|stop| stop.id != "stop-002"));
}

#[test]
fn ambiguous_same_kind_anchor_rejects_without_mutating_candidate() {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(7, 6, 8));
    engine.dispatch(GameIntent::AddBusStop { point: point(7, 7) });
    let mut state = engine.snapshot();
    state.transit.stops[0].status = TransitNodeStatus::Missing;
    let mut duplicate = state.transit.stops[0].clone();
    duplicate.id = "stop-002".to_string();
    for platform in &mut duplicate.platforms {
        platform.id = platform.id.replace("stop-001", "stop-002");
    }
    state.transit.stops.push(duplicate);
    let before = state.clone();

    let rejection = transit::add_bus_stop(&state, &point(7, 7)).unwrap_err();

    assert_eq!(
        rejection.code,
        caelum_core::RejectionCode::AmbiguousTransitNode
    );
    assert_eq!(state, before);
}

#[test]
fn incompatible_tombstone_kind_allocates_without_restoring_it() {
    let mut engine = GameEngine::new();
    lay_two_way_line(&mut engine, horizontal(7, 6, 8));
    engine.dispatch(GameIntent::AddBusStop { point: point(7, 7) });
    let mut state = engine.snapshot();
    state.transit.stops[0].kind = BusStopKind::BusTerminal;
    state.transit.stops[0].status = TransitNodeStatus::Missing;

    let next = transit::add_bus_stop(&state, &point(7, 7)).expect("new bus stop allocates");

    assert_eq!(next.transit.stops.len(), 2);
    assert_eq!(next.transit.stops[0].status, TransitNodeStatus::Missing);
    assert_eq!(next.transit.stops[0].kind, BusStopKind::BusTerminal);
    assert_eq!(next.transit.stops[1].id, "stop-002");
    assert_eq!(next.transit.stops[1].kind, BusStopKind::BusStop);
    assert_eq!(next.transit.stops[1].status, TransitNodeStatus::Present);
}
