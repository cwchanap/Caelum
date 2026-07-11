use caelum_core::model::{
    ActiveTrip, GameSnapshot, Heading, MovementKind, PathGeometry, Point, RoadPathStep, Route,
    RouteLegStatus, RoutePlan, TransitMode, TransitPath, TripPosition, TripPurpose, TripStatus,
    Vehicle,
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
    let result = engine.dispatch(GameIntent::AddBusRoute { stop_ids });
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
        PathGeometry::Arc {
            center,
            radius,
            start_radians,
            sweep_radians,
        } => {
            let radians = start_radians + sweep_radians * progress;
            TripPosition {
                x: center.x + radius * radians.cos(),
                y: center.y + radius * radians.sin(),
            }
        }
    }
}

fn recompute_after_removal(previous: &GameSnapshot, removed: Point) -> GameSnapshot {
    let candidate = transit::remove_at_tile(previous, &removed).expect("fixture removal applies");
    let topology = RoadTopology::compile(&candidate.map).expect("candidate topology compiles");
    route_lifecycle::recompute_affected_routes(
        previous,
        candidate,
        RoutingContext {
            road_topology: &topology,
        },
    )
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
fn arc_projection_normalizes_authored_angles_before_clamping() {
    let start_radians = std::f64::consts::TAU * 10.0;
    let sweep_radians = std::f64::consts::PI;
    let path = TransitPath::Road {
        steps: vec![RoadPathStep {
            position: point(0, 0),
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::RoundaboutCirculation,
            geometry: PathGeometry::Arc {
                center: TripPosition { x: 0.0, y: 0.0 },
                radius: 2.0,
                start_radians,
                sweep_radians,
            },
            travel_seconds: 1.0,
        }],
        total_travel_seconds: 1.0,
    };
    let world = TripPosition { x: 0.0, y: 2.0 };

    let projection = project_position_onto_path(&path, world, Heading::East);

    assert!((projection.step_progress - 0.5).abs() < 1e-12);
    assert!(projection.distance_squared < 1e-24);
}
