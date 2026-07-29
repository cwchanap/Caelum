//! Additional backfill coverage for uncovered error/branch lines in
//! `persistence/entities.rs` that are not already exercised by
//! `persistence_entities_branches.rs`. Each test builds a persistence-valid
//! baseline snapshot (via the shared fixtures or a local engine helper),
//! mutates a single field to exercise one rejection branch, and asserts the
//! exact `PersistenceError`.

mod common;

use caelum_core::model::{
    self, Heading, MovementKind, PathGeometry, Point, RoadPathStep, ServicePattern, TransitMode,
    TransitPath, TripPosition,
};
use caelum_core::{
    validate_snapshot, AssignmentError, DerivedStateError, EntityError, EntityKind, GameEngine,
    GameIntent, NumericError, PersistenceError, RoadPreset, SnapshotField,
};
use common::persistence_fixtures::{apply, entity_ref, fixture_with_bus_route};

// ===========================================================================
// local fixture helpers
// ===========================================================================

/// A paused snapshot with a metro line (two stations + one vehicle), for
/// station-side validation tests. Faster than `rich_fixture` (no sim/trip
/// spawning).
fn metro_fixture() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayTrackLine {
            points: (2..=12).map(|x| Point { x, y: 12 }).collect(),
        },
    );
    for point in [Point { x: 2, y: 12 }, Point { x: 10, y: 12 }] {
        apply(&mut engine, GameIntent::AddMetroStation { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Metro,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
        },
    );
    engine.snapshot_for_save().expect("metro fixture must save")
}

/// A paused snapshot with a `busTerminal` building (3×2) linked to a
/// `BusTerminal`-kind stop, for the `busTerminal` anchor branch in
/// `validate_building_node`.
fn bus_terminal_fixture() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "busTerminal".to_string(),
            origin: Point { x: 2, y: 6 },
            rotation: 0,
        },
    );
    engine
        .snapshot_for_save()
        .expect("bus terminal fixture must save")
}

// ===========================================================================
// validate_building_node: busTerminal anchor branch (lines 392-393)
// ===========================================================================

/// A `busTerminal` building linked to a `BusTerminal`-kind stop at the same
/// position exercises the `effect == "busTerminal" && kind == BusTerminal`
/// branch (positive path).
#[test]
fn bus_terminal_building_anchors_terminal_stop() {
    let snapshot = bus_terminal_fixture();
    validate_snapshot(&snapshot).expect("bus terminal building anchored to terminal stop is valid");
    let terminal = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.kind == model::BusStopKind::BusTerminal)
        .expect("fixture must contain a BusTerminal stop");
    let building = snapshot
        .buildings
        .iter()
        .find(|b| b.building_type == "busTerminal")
        .expect("fixture must contain a busTerminal building");
    assert_eq!(
        building.transit_node_id.as_deref(),
        Some(terminal.id.as_str()),
        "building must reference the terminal stop"
    );
}

// ===========================================================================
// validate_nodes_and_platforms: station-side error branches (lines 458, 475, 482)
// ===========================================================================

/// A `Present` station at an off-map position makes `validate_node_lifetime`
/// return `Err` for a station, exercising the `?` error-propagation at line 458.
#[test]
fn present_station_off_map_is_rejected() {
    let mut snapshot = metro_fixture();
    snapshot.transit.stations[0].position = Point { x: 99, y: 99 };
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Station, "station-001"),
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

/// A metro station platform with a wrong capacity exercises the
/// `validate_platform_shape` error path for stations (line 475).
#[test]
fn metro_platform_capacity_mismatch_is_rejected() {
    let mut snapshot = metro_fixture();
    snapshot.transit.stations[0].platforms[0].capacity = 99;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, "station-001-p0"),
            field: SnapshotField::PlatformCapacity,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

/// A metro station platform listing a duplicate route exercises the
/// `validate_platform_assignments` error path for stations (line 482).
#[test]
fn metro_platform_with_duplicate_route_is_rejected() {
    let mut snapshot = metro_fixture();
    // The fixture platform must already carry at least one route assignment;
    // duplicate that existing ID so the test reliably exercises
    // `DuplicateAssignment` rather than depending on a hardcoded route ID.
    let platform = &mut snapshot.transit.stations[0].platforms;
    assert!(
        !platform[0].route_ids.is_empty(),
        "fixture platform must already carry a route assignment"
    );
    let existing = platform[0].route_ids[0].clone();
    platform[0].route_ids.push(existing);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Platform, "station-001-p0"),
            reason: AssignmentError::DuplicateAssignment,
        }
    );
}

// ===========================================================================
// validate_routes: path_broken mismatch (lines 752-755)
// ===========================================================================

/// A route whose stored `path_broken` differs from the derived value exercises
/// the `RoutePathBrokenMismatch` branch.
#[test]
fn route_path_broken_mismatch_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // The bus route is connected, so derived path_broken is false. Flip the
    // stored value to true to trigger the mismatch.
    snapshot.transit.routes[0].path_broken = true;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::RoutePathBroken,
            reason: DerivedStateError::RoutePathBrokenMismatch {
                route: entity_ref(EntityKind::BusRoute, "route-001"),
            },
        }
    );
}

// ===========================================================================
// validate_route_leg: path total_travel_seconds / step travel_seconds (lines 868, 874)
// ===========================================================================

/// A compatible (Road) path with a negative `total_travel_seconds` exercises
/// the `finite_non_negative` check on the path's total (line 868).
#[test]
fn route_leg_with_negative_path_total_seconds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // The fixture route leg must carry a Road `current_path`; panic if it is
    // absent or a different variant so the mutation below is guaranteed to run.
    let TransitPath::Road {
        total_travel_seconds,
        ..
    } = snapshot.transit.routes[0].legs[0]
        .current_path
        .as_mut()
        .expect("fixture route leg must have a current_path")
    else {
        panic!("fixture route leg current_path must be a Road path");
    };
    *total_travel_seconds = -1.0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::BusRoute, "route-001")),
            field: SnapshotField::RouteEstimatedSeconds,
            reason: NumericError::Negative,
        }
    );
}

/// A compatible (Road) path whose first step has a negative `travel_seconds`
/// exercises the per-step `finite_non_negative` check (line 874).
#[test]
fn route_leg_with_negative_step_travel_seconds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // The fixture route leg must carry a Road `current_path` with at least one
    // step; panic if absent or a different variant so the mutation is
    // guaranteed to run.
    let TransitPath::Road { steps, .. } = snapshot.transit.routes[0].legs[0]
        .current_path
        .as_mut()
        .expect("fixture route leg must have a current_path")
    else {
        panic!("fixture route leg current_path must be a Road path");
    };
    steps[0].travel_seconds = -1.0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::BusRoute, "route-001")),
            field: SnapshotField::RouteEstimatedSeconds,
            reason: NumericError::Negative,
        }
    );
}

// ===========================================================================
// validate_path_structure: geometry endpoints out of bounds (lines 908-912)
// ===========================================================================

/// A step whose tile position is in-bounds but whose geometry `from` endpoint
/// is outside world bounds exercises the `world_position_in_bounds` rejection
/// (lines 908-912), distinct from the `tile_point_in_bounds` rejection.
#[test]
fn route_leg_with_geometry_endpoint_out_of_bounds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].legs[0].last_valid_path = Some(TransitPath::Road {
        steps: vec![RoadPathStep {
            position: Point { x: 5, y: 5 },
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::Line {
                from: TripPosition { x: -1.0, y: 5.0 },
                to: TripPosition { x: 6.0, y: 5.0 },
            },
            travel_seconds: 1.0,
        }],
        total_travel_seconds: 1.0,
    });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteLegs,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// geometry_endpoints: QuadraticBezier arm (line 941)
// ===========================================================================

/// A path step with `QuadraticBezier` geometry exercises the
/// `PathGeometry::QuadraticBezier` arm of `geometry_endpoints` (line 941).
/// The geometry endpoints are in-bounds and consistent with the step position,
/// so `validate_path_structure` passes; the overall validation then fails with
/// `RouteLegMismatch` because the adversarial `last_valid_path` differs from
/// the derived one.
#[test]
fn route_leg_with_quadratic_bezier_geometry_passes_structure_check() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].legs[0].last_valid_path = Some(TransitPath::Road {
        steps: vec![RoadPathStep {
            position: Point { x: 5, y: 5 },
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::QuadraticBezier {
                from: TripPosition { x: 5.0, y: 5.0 },
                control: TripPosition { x: 5.5, y: 5.0 },
                to: TripPosition { x: 6.0, y: 5.0 },
            },
            travel_seconds: 1.0,
        }],
        total_travel_seconds: 1.0,
    });
    // The path-structure check (including the QuadraticBezier arm) must pass;
    // the snapshot is rejected later by the derived-state leg mismatch.
    assert!(matches!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::RouteLegs,
            reason: DerivedStateError::RouteLegMismatch { .. },
        }
    ));
}

// ===========================================================================
// validate_vehicles: valid parked_position (line 1057)
// ===========================================================================

/// A vehicle with a finite, in-bounds `parked_position` exercises the
/// successful path through the parked-position checks (line 1057).
#[test]
fn vehicle_with_valid_parked_position_is_accepted() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].parked_position = Some(TripPosition { x: 5.0, y: 5.0 });
    validate_snapshot(&snapshot).expect("vehicle with valid parked position is valid");
}

// ===========================================================================
// validate_vehicles: parked_position out of bounds (lines 1047-1056)
// ===========================================================================

/// A vehicle with a finite but out-of-bounds `parked_position` exercises the
/// `world_position_in_bounds` rejection with `NumericError::OutOfRange`.
#[test]
fn vehicle_with_out_of_bounds_parked_position_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].parked_position = Some(TripPosition { x: 99.0, y: 99.0 });
    let max_dim = snapshot.map.width.max(snapshot.map.height);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::Vehicle, "vehicle-001")),
            field: SnapshotField::VehicleParkedPosition,
            reason: NumericError::OutOfRange {
                minimum: 0.0,
                maximum: f64::from(max_dim),
                actual: 99.0,
            },
        }
    );
}
