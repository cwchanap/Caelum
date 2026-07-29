//! Backfill coverage for currently-uncovered error/branch lines in
//! `persistence/entities.rs`. Each test builds a persistence-valid baseline
//! snapshot (via the shared fixtures), mutates a single field to exercise one
//! rejection branch, and asserts the exact `PersistenceError` (or `matches!`
//! when an exact assertion is impractical).

mod common;

use caelum_core::model::{
    self, Heading, MovementKind, PathGeometry, PlacedBuilding, Point, RoadPathStep, RouteLeg,
    RoutePlan, StopRoadAccess, TransitMode, TransitNodeStatus, TransitPath, TripPosition,
    TripStatus,
};
use caelum_core::{
    validate_snapshot, AssignmentError, EntityError, EntityKind, NumericError, OwnershipError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    entity_ref, fixture_with_bus_route, paused_snapshot, rich_fixture, trip_fixture,
};

// ===========================================================================
// trip id registration (register_trip / parse_trip_id)
// ===========================================================================

#[test]
fn empty_trip_id_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].id = String::new();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, ""),
            field: SnapshotField::EntityId,
            reason: EntityError::EmptyId,
        }
    );
}

#[test]
fn trip_id_with_zero_sequence_is_non_canonical() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].id = "trip-day-0-trip-000".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-000"),
            field: SnapshotField::EntityId,
            reason: EntityError::NonCanonicalId,
        }
    );
}

#[test]
fn trip_id_with_extra_suffix_is_non_canonical() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].id = "trip-day-0-trip-001-extra".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001-extra"),
            field: SnapshotField::EntityId,
            reason: EntityError::NonCanonicalId,
        }
    );
}

// ===========================================================================
// platform id registration (register_platform)
// ===========================================================================

#[test]
fn empty_platform_id_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].id = String::new();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, ""),
            field: SnapshotField::EntityId,
            reason: EntityError::EmptyId,
        }
    );
}

#[test]
fn non_canonical_platform_id_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].id = "stop-001-bad".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, "stop-001-bad"),
            field: SnapshotField::EntityId,
            reason: EntityError::NonCanonicalId,
        }
    );
}

// ===========================================================================
// building validation (validate_buildings)
// ===========================================================================

/// `footprint` returns `None` when `origin + extent` overflows `i32`. This
/// exercises the `BuildingOrigin` / `InvalidStaticShape` branch.
#[test]
fn building_origin_overflow_makes_footprint_none() {
    let mut snapshot = paused_snapshot();
    snapshot.buildings = vec![PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point {
            x: i32::MAX - 1,
            y: 0,
        },
        rotation: 0,
        occupied_tiles: vec![Point {
            x: i32::MAX - 1,
            y: 0,
        }],
        transit_node_id: None,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Building, "building-001"),
            field: SnapshotField::BuildingOrigin,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

/// A building whose `occupied_tiles` (matching the footprint) extends off-map
/// triggers the `tile(point) == None` branch for `BuildingOccupiedTiles`.
#[test]
fn building_occupied_tile_off_map_is_rejected() {
    let mut snapshot = paused_snapshot();
    // Tile (27, 17) is the last on-map tile (MAP_WIDTH=28, MAP_HEIGHT=18).
    // Index = 17 * 28 + 27 = 503.
    snapshot.map.tiles[503].area = Some("residential".to_string());
    snapshot.buildings = vec![PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 27, y: 17 },
        rotation: 0,
        // footprint for smallHouse (2x1) at (27,17) rot 0 = [(27,17),(28,17)].
        occupied_tiles: vec![Point { x: 27, y: 17 }, Point { x: 28, y: 17 }],
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

/// A `metroStation` building placed on a track tile exercises the
/// `definition.effect == "metroStation"` tile-check branch (positive path).
#[test]
fn metro_station_building_on_track_tile_is_valid() {
    let mut snapshot = rich_fixture();
    // Station-001 sits at (2, 12) on the metro track; add the corresponding
    // metroStation building so the metroStation tile branch runs.
    snapshot.buildings.push(PlacedBuilding {
        id: "building-003".to_string(),
        building_type: "metroStation".to_string(),
        origin: Point { x: 2, y: 12 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 2, y: 12 }],
        transit_node_id: Some("station-001".to_string()),
    });
    validate_snapshot(&snapshot).expect("metro station building on track is valid");
}

// ===========================================================================
// validate_building_node
// ===========================================================================

/// A non-transit building (smallHouse) carrying a `transit_node_id` hits the
/// `(None, Some)` arm → `OwnerTypeMismatch`.
#[test]
fn non_transit_building_with_node_id_is_owner_type_mismatch() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].area = Some("residential".to_string());
    snapshot.map.tiles[1].area = Some("residential".to_string());
    snapshot.buildings = vec![PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "smallHouse".to_string(),
        origin: Point { x: 0, y: 0 },
        rotation: 0,
        occupied_tiles: vec![Point { x: 0, y: 0 }, Point { x: 1, y: 0 }],
        transit_node_id: Some("stop-001".to_string()),
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Stop, "stop-001"),
            reason: OwnershipError::OwnerTypeMismatch,
        }
    );
}

/// A `busStop` building without a `transit_node_id` hits the `(Some, None)`
/// arm → `ReciprocalLinkMissing`.
#[test]
fn bus_stop_building_without_node_id_is_reciprocal_link_missing() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.buildings.push(bus_stop_building(
        "building-001",
        Point { x: 2, y: 4 },
        None,
    ));
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Building, "building-001"),
            reason: OwnershipError::ReciprocalLinkMissing,
        }
    );
}

/// Two `busStop` buildings claiming the same stop id hit `MultipleOwners`.
#[test]
fn two_buildings_claiming_same_stop_are_multiple_owners() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.buildings.push(bus_stop_building(
        "building-001",
        Point { x: 2, y: 4 },
        Some("stop-001".to_string()),
    ));
    snapshot.buildings.push(bus_stop_building(
        "building-002",
        Point { x: 3, y: 4 },
        Some("stop-001".to_string()),
    ));
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-002"),
            owned: entity_ref(EntityKind::Stop, "stop-001"),
            reason: OwnershipError::MultipleOwners,
        }
    );
}

/// A `busStop` building whose `transit_node_id` points to a stop at a
/// different position hits `AnchorMismatch`.
#[test]
fn bus_stop_building_pointing_to_wrong_stop_is_anchor_mismatch() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.buildings.push(bus_stop_building(
        "building-001",
        Point { x: 2, y: 4 },
        Some("stop-002".to_string()),
    ));
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Building, "building-001"),
            owned: entity_ref(EntityKind::Stop, "stop-002"),
            reason: OwnershipError::AnchorMismatch,
        }
    );
}

// ===========================================================================
// validate_node_lifetime
// ===========================================================================

/// A `Missing` stop that IS referenced by a route takes the early `Ok(())`
/// return. The overall snapshot may still fail later (derived route legs), but
// the `MissingOwner` branch must not fire.
#[test]
fn missing_stop_referenced_by_route_is_not_missing_owner() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].status = TransitNodeStatus::Missing;
    snapshot.transit.stops[0].road_access = None;
    let result = validate_snapshot(&snapshot);
    assert!(!matches!(
        result,
        Err(PersistenceError::InvalidOwnership {
            reason: OwnershipError::MissingOwner,
            ..
        })
    ));
}

/// A `Present` stop at an off-map position hits the `tile(point) == None`
/// branch → `NodeAnchor` / `InvalidStaticShape`.
#[test]
fn present_stop_off_map_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].position = Point { x: 99, y: 99 };
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Stop, "stop-001"),
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

/// Two `Present` stops at the same position hit `SpatialOverlap`.
#[test]
fn two_present_stops_at_same_position_are_spatial_overlap() {
    let mut snapshot = fixture_with_bus_route();
    // Move stop-001 onto stop-002's anchor and copy its (valid) road access so
    // the derived road-access check passes for stop-001 before stop-002 is
    // validated.
    let shared = Point { x: 10, y: 4 };
    snapshot.transit.stops[0].position = shared;
    snapshot.transit.stops[0].road_access = Some(StopRoadAccess {
        road_point: Point { x: 10, y: 5 },
        preferred_heading: Some(model::Heading::East),
    });
    snapshot.transit.stops[1].position = shared;
    snapshot.transit.stops[1].road_access = Some(StopRoadAccess {
        road_point: Point { x: 10, y: 5 },
        preferred_heading: Some(model::Heading::East),
    });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Stop, "stop-001"),
            owned: entity_ref(EntityKind::Stop, "stop-002"),
            reason: OwnershipError::SpatialOverlap,
        }
    );
}

// ===========================================================================
// validate_platform_shape
// ===========================================================================

#[test]
fn platform_order_mismatch_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].id = "stop-001-p9".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, "stop-001-p9"),
            field: SnapshotField::PlatformOrder,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn platform_label_mismatch_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].label = "Z".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, "stop-001-p0"),
            field: SnapshotField::PlatformLabel,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn platform_capacity_mismatch_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].capacity = 99;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Platform, "stop-001-p0"),
            field: SnapshotField::PlatformCapacity,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// validate_platform_assignments
// ===========================================================================

#[test]
fn platform_with_duplicate_route_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].route_ids =
        vec!["route-001".to_string(), "route-001".to_string()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Platform, "stop-001-p0"),
            reason: AssignmentError::DuplicateAssignment,
        }
    );
}

#[test]
fn platform_with_route_not_containing_stop_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.stops[0].platforms[0].route_ids = vec!["route-999".to_string()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Platform, "stop-001-p0"),
            reason: AssignmentError::PlatformMismatch,
        }
    );
}

#[test]
fn platform_missing_route_that_contains_stop_is_reciprocal_link_missing() {
    let mut snapshot = fixture_with_bus_route();
    // route-001 still lists stop-001, but the platform no longer lists it.
    snapshot.transit.stops[0].platforms[0].route_ids = vec![];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidOwnership {
            owner: entity_ref(EntityKind::Stop, "stop-001"),
            owned: entity_ref(EntityKind::Stop, "stop-001"),
            reason: OwnershipError::ReciprocalLinkMissing,
        }
    );
}

// ===========================================================================
// validate_route_shape / validate_route_leg
// ===========================================================================

#[test]
fn route_with_duplicate_vehicle_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].vehicle_ids =
        vec!["vehicle-001".to_string(), "vehicle-001".to_string()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            reason: AssignmentError::DuplicateAssignment,
        }
    );
}

#[test]
fn route_leg_with_negative_estimated_seconds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].legs[0].estimated_seconds = Some(-1.0);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::BusRoute, "route-001")),
            field: SnapshotField::RouteEstimatedSeconds,
            reason: NumericError::Negative,
        }
    );
}

#[test]
fn route_leg_with_nan_estimated_seconds_is_not_finite() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.routes[0].legs[0].estimated_seconds = Some(f64::NAN);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::BusRoute, "route-001")),
            field: SnapshotField::RouteEstimatedSeconds,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn route_leg_with_wrong_path_mode_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Swap a bus leg's road path for a track path → mode mismatch.
    snapshot.transit.routes[0].legs[0].current_path = Some(TransitPath::Track {
        steps: vec![],
        total_travel_seconds: 0.0,
    });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            reason: AssignmentError::ModeMismatch,
        }
    );
}

// ===========================================================================
// validate_vehicles
// ===========================================================================

#[test]
fn vehicle_with_walk_mode_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Add a walk vehicle that is NOT listed by any route so route-shape
    // validation never sees it; validate_vehicles rejects it directly.
    snapshot.transit.vehicles.push(model::Vehicle {
        id: "vehicle-002".to_string(),
        mode: TransitMode::Walk,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: vec![],
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: None,
    });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-002"),
            reason: AssignmentError::ModeMismatch,
        }
    );
}

#[test]
fn vehicle_with_unknown_line_id_is_mode_mismatch() {
    let mut snapshot = fixture_with_bus_route();
    // Remove the vehicle from the route so route-shape validation passes, then
    // point its line_id at a non-existent line.
    snapshot.transit.routes[0].vehicle_ids.clear();
    snapshot.transit.vehicles[0].line_id = "route-999".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-001"),
            reason: AssignmentError::ModeMismatch,
        }
    );
}

#[test]
fn vehicle_itinerary_index_out_of_bounds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].itinerary_index = 99;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-001"),
            reason: AssignmentError::ItineraryIndexOutOfBounds,
        }
    );
}

#[test]
fn vehicle_path_step_index_out_of_bounds_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].path_step_index = 999;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-001"),
            reason: AssignmentError::PathStepIndexOutOfBounds,
        }
    );
}

#[test]
fn vehicle_parked_position_not_finite_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    snapshot.transit.vehicles[0].parked_position = Some(TripPosition {
        x: f64::NAN,
        y: 0.0,
    });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::Vehicle, "vehicle-001")),
            field: SnapshotField::VehicleParkedPosition,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn vehicle_with_duplicate_passenger_is_rejected() {
    let mut snapshot = rich_fixture();
    // Turn the walking trip into a riding trip on the bus route so the first
    // passenger iteration is compatible; the second iteration hits the
    // per-vehicle duplicate check.
    let trip = &mut snapshot.active_trips[0];
    trip.status = TripStatus::Riding;
    trip.current_leg_index = 1;
    trip.route_plan = Some(RoutePlan {
        legs: vec![
            RouteLeg {
                mode: TransitMode::Walk,
                from: Point { x: 2, y: 2 },
                to: Point { x: 2, y: 4 },
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: Point { x: 2, y: 4 },
                to: Point { x: 10, y: 4 },
                line_id: Some("route-001".to_string()),
                service_direction: Some(model::ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(1),
            },
        ],
        estimated_seconds: 200.0,
    });
    let trip_id = trip.id.clone();
    snapshot.transit.vehicles[0].passenger_ids = vec![trip_id.clone(), trip_id];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-001"),
            reason: AssignmentError::PassengerInMultipleVehicles,
        }
    );
}

#[test]
fn vehicle_with_passenger_not_riding_is_rejected() {
    let mut snapshot = rich_fixture();
    // The rich fixture's trip is Walking; attaching it as a passenger of the
    // bus vehicle fails the riding compatibility check.
    snapshot.transit.vehicles[0].passenger_ids = vec!["trip-day-0-trip-001".to_string()];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidAssignment {
            entity: entity_ref(EntityKind::Vehicle, "vehicle-001"),
            reason: AssignmentError::PassengerNotRiding,
        }
    );
}

// ===========================================================================
// path structure: in-bounds points and step adjacency
// ===========================================================================

fn adversarial_road_path(
    position: Point,
    geo_from: TripPosition,
    geo_to: TripPosition,
) -> TransitPath {
    TransitPath::Road {
        steps: vec![RoadPathStep {
            position,
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::Line {
                from: geo_from,
                to: geo_to,
            },
            travel_seconds: 1.0,
        }],
        total_travel_seconds: 1.0,
    }
}

#[test]
fn route_leg_with_out_of_bounds_step_position_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Step position at (255, 255) is outside the sandbox map bounds.
    snapshot.transit.routes[0].legs[0].last_valid_path = Some(adversarial_road_path(
        Point { x: 255, y: 255 },
        TripPosition { x: 255.0, y: 255.0 },
        TripPosition { x: 255.0, y: 255.0 },
    ));
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteLegs,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn route_leg_with_geometry_from_mismatching_step_position_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Step position is in-bounds (5, 5) but geometry.from is (3, 5) —
    // self-inconsistency.
    snapshot.transit.routes[0].legs[0].last_valid_path = Some(adversarial_road_path(
        Point { x: 5, y: 5 },
        TripPosition { x: 3.0, y: 5.0 },
        TripPosition { x: 6.0, y: 5.0 },
    ));
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::BusRoute, "route-001"),
            field: SnapshotField::RouteLegs,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn route_leg_with_broken_step_adjacency_is_rejected() {
    let mut snapshot = fixture_with_bus_route();
    // Two steps: step[0] ends at (6, 5) but step[1] starts at (8, 5) — gap.
    snapshot.transit.routes[0].legs[0].last_valid_path = Some(TransitPath::Road {
        steps: vec![
            RoadPathStep {
                position: Point { x: 5, y: 5 },
                entering_heading: Heading::East,
                leaving_heading: Heading::East,
                movement: MovementKind::Straight,
                geometry: PathGeometry::Line {
                    from: TripPosition { x: 5.0, y: 5.0 },
                    to: TripPosition { x: 6.0, y: 5.0 },
                },
                travel_seconds: 1.0,
            },
            RoadPathStep {
                position: Point { x: 8, y: 5 },
                entering_heading: Heading::East,
                leaving_heading: Heading::East,
                movement: MovementKind::Straight,
                geometry: PathGeometry::Line {
                    from: TripPosition { x: 8.0, y: 5.0 },
                    to: TripPosition { x: 9.0, y: 5.0 },
                },
                travel_seconds: 1.0,
            },
        ],
        total_travel_seconds: 2.0,
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
// helpers
// ===========================================================================

/// Construct a 1x1 `busStop` building at `origin` with the given transit node
/// link. The tile at `origin` must be empty with no track/structure.
fn bus_stop_building(id: &str, origin: Point, transit_node_id: Option<String>) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: "busStop".to_string(),
        origin,
        rotation: 0,
        occupied_tiles: vec![origin],
        transit_node_id,
    }
}
