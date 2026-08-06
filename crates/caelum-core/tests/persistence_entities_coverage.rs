//! Additional backfill coverage for uncovered error/branch lines in
//! `persistence/entities.rs` that are not already exercised by
//! `persistence_entities_branches.rs`. Each test builds a persistence-valid
//! baseline snapshot (via the shared fixtures or a local engine helper),
//! mutates a single field to exercise one rejection branch, and asserts the
//! exact `PersistenceError`.

mod common;

use caelum_core::model::{self, Point, ServicePattern, TransitMode, TripPosition};
use caelum_core::{
    validate_snapshot, AssignmentError, EntityError, EntityKind, GameEngine, GameIntent,
    NumericError, PersistenceError, RoadPreset, SnapshotField,
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
    engine.snapshot_for_save()
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
    engine.snapshot_for_save()
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
