//! Coverage for the `persistence/entities.rs` validation branches: entity ID
//! registration, buildings, transit nodes & platforms, route shape, vehicles,
//! and metro lines.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{
    self, BusStopKind, Point, Sim, Station, Stop, StopRoadAccess, TransitMode, TransitNodeStatus,
    TripPosition, WorkerProfile,
};
use caelum_core::{
    validate_snapshot, AssignmentError, EntityError, EntityKind, NumericError, OwnershipError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    entity_ref, fixture_with_bus_route, paused_snapshot, rich_fixture, road_with_structure,
};

// ===========================================================================
// entity ID registration
// ===========================================================================

#[test]
fn empty_entity_id_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![Sim {
        id: String::new(),
        home: Point { x: 2, y: 3 },
        position: Point { x: 2, y: 3 },
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, ""),
            field: SnapshotField::EntityId,
            reason: EntityError::EmptyId,
        }
    );
}

#[test]
fn non_canonical_entity_id_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![Sim {
        id: "sim-bad".to_string(),
        home: Point { x: 2, y: 3 },
        position: Point { x: 2, y: 3 },
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-bad"),
            field: SnapshotField::EntityId,
            reason: EntityError::NonCanonicalId,
        }
    );
}

#[test]
fn non_canonical_trip_id_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.active_trips = vec![caelum_core::model::ActiveTrip {
        id: "trip-bad".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: caelum_core::model::TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 3 },
        destination: Point { x: 4, y: 3 },
        position: TripPosition::from(Point { x: 2, y: 3 }),
        status: caelum_core::model::TripStatus::Idle,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-bad"),
            field: SnapshotField::EntityId,
            reason: EntityError::NonCanonicalId,
        }
    );
}

// ===========================================================================
// building validation
// ===========================================================================

#[test]
fn building_with_unknown_type_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.buildings = vec![model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "unknownType".to_string(),
        origin: Point { x: 2, y: 2 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 2, y: 2 }, Point { x: 3, y: 2 }],
        transit_node_id: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Building, "building-001"),
            field: SnapshotField::BuildingOccupiedTiles,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn building_with_invalid_rotation_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.buildings = vec![model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 2, y: 2 },
        rotation: 45,
        occupied_tiles: vec![Point { x: 2, y: 2 }, Point { x: 3, y: 2 }],
        transit_node_id: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Building, "building-001"),
            field: SnapshotField::BuildingRotation,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn building_footprint_mismatch_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].area = Some("residential".to_string());
    snapshot.map.tiles[1].area = Some("residential".to_string());
    snapshot.buildings = vec![model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 0, y: 0 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 0, y: 0 }],
        transit_node_id: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Building, "building-001"),
            reason: OwnershipError::FootprintMismatch,
        }
    );
}

#[test]
fn building_on_non_empty_tile_is_rejected() {
    let mut snapshot = paused_snapshot();
    // Make tile (0,0) a road so the building can't sit there.
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.buildings = vec![model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 0, y: 0 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 0, y: 0 }, Point { x: 1, y: 0 }],
        transit_node_id: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Building, "building-001"),
            field: SnapshotField::BuildingOccupiedTiles,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn overlapping_building_footprints_are_rejected() {
    let mut snapshot = paused_snapshot();
    for index in 0..4 {
        snapshot.map.tiles[index].area = Some("residential".to_string());
    }
    let building = model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 0, y: 0 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 0, y: 0 }, Point { x: 1, y: 0 }],
        transit_node_id: None,
    };
    snapshot.buildings = vec![
        building.clone(),
        model::PlacedBuilding {
            id: "building-002".to_string(),
            building_type: "smallHouse".to_string(),
            origin: Point { x: 0, y: 0 },
            rotation: 0,
            occupied_tiles: vec![Point { x: 0, y: 0 }, Point { x: 1, y: 0 }],
            transit_node_id: None,
        },
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Building, "building-002"),
            reason: OwnershipError::SpatialOverlap,
        }
    );
}

#[test]
fn unowned_present_node_overlapping_building_footprint_is_rejected() {
    // A canonical bus stop placed at an ordinary building's origin (without
    // the building declaring it via `transit_node_id`) is a malformed spatial
    // state. The building's footprint tiles are valid for the building, and
    // the stop's platform/road-access fields are individually consistent, so
    // only the cross-entity building↔node occupancy check catches it.
    let mut snapshot = paused_snapshot();
    for index in 0..4 {
        snapshot.map.tiles[index].area = Some("residential".to_string());
    }
    snapshot.buildings = vec![model::PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 0, y: 0 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 0, y: 0 }, Point { x: 1, y: 0 }],
        transit_node_id: None,
    }];
    // Inject an unrelated present bus stop at the building's origin.
    snapshot.transit.stops = vec![Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: Point { x: 0, y: 0 },
        platforms: vec![model::Platform {
            id: "stop-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 1,
            route_ids: vec![],
        }],
        road_access: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Stop, "stop-001"),
            reason: OwnershipError::SpatialOverlap,
        }
    );
}

// ===========================================================================
// transit node & platform validation
// ===========================================================================

#[test]
fn missing_transit_node_not_referenced_by_any_route_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.transit.stops = vec![Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Missing,
        position: Point { x: 2, y: 4 },
        platforms: vec![],
        road_access: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Stop, "stop-001"),
            owned: entity_ref(EntityKind::Stop, "stop-001"),
            reason: OwnershipError::MissingOwner,
        }
    );
}

#[test]
fn transit_node_anchor_on_structure_tile_is_rejected() {
    let mut snapshot = road_with_structure();
    // The roundabout center occupies (6,5); place a stop there.
    snapshot.transit.stops = vec![Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: Point { x: 6, y: 5 },
        platforms: vec![model::Platform {
            id: "stop-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 1,
            route_ids: vec![],
        }],
        road_access: Some(StopRoadAccess {
            road_point: Point { x: 6, y: 5 },
            preferred_heading: None,
        }),
    }];
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidEntity {
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
            ..
        }
    ));
}

#[test]
fn station_anchor_without_track_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.transit.stations = vec![Station {
        id: "station-001".to_string(),
        status: TransitNodeStatus::Present,
        position: Point { x: 2, y: 2 },
        platforms: vec![model::Platform {
            id: "station-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 200,
            route_ids: vec![],
        }],
    }];
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidEntity {
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
            ..
        }
    ));
}

#[test]
fn platform_count_mismatch_is_rejected() {
    let mut snapshot = paused_snapshot();
    // A bus stop should have exactly one platform; supply two.
    snapshot.transit.stops = vec![Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: Point { x: 2, y: 4 },
        platforms: vec![
            model::Platform {
                id: "stop-001-p0".to_string(),
                label: "A".to_string(),
                capacity: 1,
                route_ids: vec![],
            },
            model::Platform {
                id: "stop-001-p1".to_string(),
                label: "B".to_string(),
                capacity: 1,
                route_ids: vec![],
            },
        ],
        road_access: None,
    }];
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidEntity {
            field: SnapshotField::PlatformCount,
            reason: EntityError::InvalidStaticShape,
            ..
        }
    ));
}

// ===========================================================================
// route shape validation
// ===========================================================================

#[test]
fn route_with_too_few_waypoints_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].stop_ids = vec!["stop-001".to_string()];
    // Also remove route-001 from stop-002's platform so platform assignment
    // validation doesn't fire before route shape validation.
    snapshot.transit.stops[1].platforms[0].route_ids.clear();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteWaypointIds,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn route_with_duplicate_waypoint_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].stop_ids = vec![
        "stop-001".to_string(),
        "stop-001".to_string(),
        "stop-002".to_string(),
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            reason: AssignmentError::DuplicateAssignment,
        }
    );
}

#[test]
fn route_with_dangling_waypoint_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].stop_ids = vec!["stop-001".to_string(), "stop-999".to_string()];
    // Also remove route-001 from stop-002's platform so platform assignment
    // validation doesn't fire before route shape validation.
    snapshot.transit.stops[1].platforms[0].route_ids.clear();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::DanglingReference {
            source: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteWaypointIds,
            target: entity_ref(EntityKind::Stop, "stop-999"),
        }
    );
}

#[test]
fn route_with_dangling_vehicle_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].vehicle_ids = vec!["vehicle-999".to_string()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::DanglingReference {
            source: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteVehicleIds,
            target: entity_ref(EntityKind::Vehicle, "vehicle-999"),
        }
    );
}

#[test]
fn route_vehicle_with_wrong_mode_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Reassign the bus vehicle to a metro line id so mode mismatches.
    snapshot.transit.vehicles[0].mode = TransitMode::Metro;
    snapshot.transit.vehicles[0].line_id = "metro-001".to_string();
    snapshot.transit.routes[0].vehicle_ids = vec![snapshot.transit.vehicles[0].id.clone()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            reason: AssignmentError::ModeMismatch,
        }
    );
}

// ===========================================================================
// vehicle validation
// ===========================================================================

#[test]
fn vehicle_with_walk_mode_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].mode = TransitMode::Walk;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidAssignment {
            reason: AssignmentError::ModeMismatch,
            ..
        }
    ));
}

#[test]
fn vehicle_missing_from_line_vehicle_list_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Remove the vehicle from the route's vehicle_ids but keep it in the vehicles list.
    snapshot.transit.routes[0].vehicle_ids.clear();
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidAssignment {
            reason: AssignmentError::VehicleMissingFromLine,
            ..
        }
    ));
}

#[test]
fn vehicle_with_wrong_capacity_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].capacity = 99;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidEntity {
            field: SnapshotField::VehicleCapacity,
            reason: EntityError::InvalidStaticShape,
            ..
        }
    ));
}

#[test]
fn vehicle_with_progress_out_of_range_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].step_progress = 1.5;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidAssignment {
            reason: AssignmentError::ProgressOutOfRange,
            ..
        }
    ));
}

#[test]
fn vehicle_with_parked_position_out_of_bounds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].parked_position = Some(TripPosition { x: 999.0, y: 0.0 });
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidNumericValue {
            field: SnapshotField::VehicleParkedPosition,
            reason: NumericError::OutOfRange { .. },
            ..
        }
    ));
}

#[test]
fn vehicle_with_dangling_passenger_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].passenger_ids = vec!["trip-day-0-trip-999".to_string()];
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::DanglingReference {
            field: SnapshotField::VehiclePassengerIds,
            ..
        }
    ));
}

#[test]
fn vehicle_listed_by_a_second_route_is_rejected_as_mode_mismatch() {
    let mut snapshot = fixture_with_bus_route();
    // Duplicate the route so both list the same vehicle. The vehicle's
    // line_id is "route-001", so route-002's shape validation fires
    // ModeMismatch before the vehicle-stage VehicleListedByMultipleLines
    // defense-in-depth check ever runs.
    let mut duplicate = snapshot.transit.routes[0].clone();
    duplicate.id = "route-002".to_string();
    duplicate.vehicle_ids = snapshot.transit.routes[0].vehicle_ids.clone();
    let route_002_id = duplicate.id.clone();
    snapshot.transit.routes.push(duplicate);
    for stop in &mut snapshot.transit.stops {
        stop.platforms[0].route_ids.push(route_002_id.clone());
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::BusRoute, "route-002"),
            reason: AssignmentError::ModeMismatch,
        }
    );
}

// ===========================================================================
// metro line validation
// ===========================================================================

#[test]
fn rich_fixture_with_bus_and_metro_is_persistence_valid() {
    let snapshot = rich_fixture();
    validate_snapshot(&snapshot).unwrap();
    assert!(!snapshot.transit.routes.is_empty());
    assert!(!snapshot.transit.metro_lines.is_empty());
    assert!(!snapshot.transit.vehicles.is_empty());
    assert!(!snapshot.sims.is_empty());
    assert!(!snapshot.active_trips.is_empty());
}

#[test]
fn metro_line_with_dangling_station_is_rejected() {
    let mut snapshot = rich_fixture();
    snapshot.transit.metro_lines[0].station_ids = vec![
        snapshot.transit.metro_lines[0].station_ids[0].clone(),
        "station-999".to_string(),
    ];
    // Remove the line from station-002's platform so platform assignment
    // validation doesn't fire before route shape validation.
    let line_id = snapshot.transit.metro_lines[0].id.clone();
    // Remove the line from station-002's platform route_ids.
    for station in &mut snapshot.transit.stations {
        if station.id != snapshot.transit.metro_lines[0].station_ids[0] {
            for platform in &mut station.platforms {
                platform.route_ids.retain(|id| id != &line_id);
            }
        }
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::DanglingReference {
            source: entity_ref(EntityKind::MetroLine, &line_id),
            field: SnapshotField::RouteWaypointIds,
            target: entity_ref(EntityKind::Station, "station-999"),
        }
    );
}
