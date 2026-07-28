use std::collections::{BTreeMap, BTreeSet};

use crate::building_catalog::building_definition;
use crate::engine::RoutingContext;
use crate::ids::entity_id;
use crate::model::{
    GameSnapshot, Platform, RouteLegPath, Sim, TransitMode, TransitNodeStatus, TransitPath,
    TripStatus,
};
use crate::platforms;
use crate::road_topology::RoadTopology;
use crate::route_lifecycle::derive_route_states;
use crate::service_itinerary::service_visits;
use crate::stop_access;

use super::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, NumericError,
    OwnershipError, PersistenceError, PersistenceResult, SnapshotField,
};

pub(super) struct EntityIndexes<'a> {
    kinds: BTreeMap<&'a str, EntityKind>,
    sims: BTreeMap<&'a str, &'a Sim>,
}

impl EntityIndexes<'_> {
    pub(super) fn sim(&self, id: &str) -> Option<&Sim> {
        self.sims.get(id).copied()
    }
}

pub(super) fn validate_entities<'a>(
    snapshot: &'a GameSnapshot,
    topology: &RoadTopology,
) -> PersistenceResult<EntityIndexes<'a>> {
    let mut indexes = EntityIndexes {
        kinds: BTreeMap::new(),
        sims: BTreeMap::new(),
    };
    for building in &snapshot.buildings {
        register(&mut indexes, EntityKind::Building, &building.id, "building")?;
    }
    for sim in &snapshot.sims {
        register(&mut indexes, EntityKind::Sim, &sim.id, "sim")?;
        indexes.sims.insert(&sim.id, sim);
    }
    for trip in &snapshot.active_trips {
        register_trip(&mut indexes, &trip.id)?;
    }
    for stop in &snapshot.transit.stops {
        register(&mut indexes, EntityKind::Stop, &stop.id, "stop")?;
        for platform in &stop.platforms {
            register_platform(&mut indexes, platform, &stop.id)?;
        }
    }
    for station in &snapshot.transit.stations {
        register(&mut indexes, EntityKind::Station, &station.id, "station")?;
        for platform in &station.platforms {
            register_platform(&mut indexes, platform, &station.id)?;
        }
    }
    for route in &snapshot.transit.routes {
        register(&mut indexes, EntityKind::BusRoute, &route.id, "route")?;
    }
    for line in &snapshot.transit.metro_lines {
        register(&mut indexes, EntityKind::MetroLine, &line.id, "metro")?;
    }
    for vehicle in &snapshot.transit.vehicles {
        register(&mut indexes, EntityKind::Vehicle, &vehicle.id, "vehicle")?;
    }

    validate_buildings(snapshot)?;
    validate_nodes_and_platforms(snapshot)?;
    validate_routes(snapshot, topology)?;
    validate_vehicles(snapshot)?;
    Ok(indexes)
}

fn register<'a>(
    indexes: &mut EntityIndexes<'a>,
    kind: EntityKind,
    id: &'a str,
    prefix: &str,
) -> PersistenceResult<()> {
    if id.is_empty() {
        return Err(invalid_entity(kind, id, EntityError::EmptyId));
    }
    if !canonical_numbered_id(id, prefix) {
        return Err(invalid_entity(kind, id, EntityError::NonCanonicalId));
    }
    register_unique(indexes, kind, id)
}

fn register_trip<'a>(indexes: &mut EntityIndexes<'a>, id: &'a str) -> PersistenceResult<()> {
    if id.is_empty() {
        return Err(invalid_entity(
            EntityKind::ActiveTrip,
            id,
            EntityError::EmptyId,
        ));
    }
    if parse_trip_id(id).is_none() {
        return Err(invalid_entity(
            EntityKind::ActiveTrip,
            id,
            EntityError::NonCanonicalId,
        ));
    }
    register_unique(indexes, EntityKind::ActiveTrip, id)
}

fn register_platform<'a>(
    indexes: &mut EntityIndexes<'a>,
    platform: &'a Platform,
    node_id: &str,
) -> PersistenceResult<()> {
    if platform.id.is_empty() {
        return Err(invalid_entity(
            EntityKind::Platform,
            &platform.id,
            EntityError::EmptyId,
        ));
    }
    let canonical = platform
        .id
        .strip_prefix(node_id)
        .and_then(|suffix| suffix.strip_prefix("-p"))
        .and_then(|suffix| suffix.parse::<usize>().ok())
        .is_some_and(|index| platform.id == format!("{node_id}-p{index}"));
    if !canonical {
        return Err(invalid_entity(
            EntityKind::Platform,
            &platform.id,
            EntityError::NonCanonicalId,
        ));
    }
    register_unique(indexes, EntityKind::Platform, &platform.id)
}

fn register_unique<'a>(
    indexes: &mut EntityIndexes<'a>,
    kind: EntityKind,
    id: &'a str,
) -> PersistenceResult<()> {
    if let Some(first_kind) = indexes.kinds.insert(id, kind) {
        return Err(PersistenceError::DuplicateEntityId {
            id: id.to_string(),
            first_kind,
            second_kind: kind,
        });
    }
    Ok(())
}

fn canonical_numbered_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(&format!("{prefix}-"))
        .and_then(|suffix| suffix.parse::<usize>().ok())
        .is_some_and(|number| number > 0 && entity_id(prefix, number) == id)
}

pub(super) fn parse_trip_id(id: &str) -> Option<(u32, u32)> {
    let rest = id.strip_prefix("trip-day-")?;
    let (day, sequence) = rest.split_once("-trip-")?;
    let day = day.parse::<u32>().ok()?;
    let sequence = sequence.parse::<u32>().ok()?;
    if sequence == 0 || format!("trip-day-{day}-trip-{sequence:03}") != id {
        return None;
    }
    Some((day, sequence))
}

fn invalid_entity(kind: EntityKind, id: &str, reason: EntityError) -> PersistenceError {
    PersistenceError::InvalidEntity {
        entity: EntityRef {
            kind,
            id: id.to_string(),
        },
        field: SnapshotField::EntityId,
        reason,
    }
}

fn validate_buildings(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let mut occupied: BTreeMap<crate::model::Point, EntityRef> = BTreeMap::new();
    let mut claimed_nodes = BTreeSet::new();
    for building in &snapshot.buildings {
        let entity = entity_ref(EntityKind::Building, &building.id);
        let Some(definition) = building_definition(&building.building_type) else {
            return Err(PersistenceError::InvalidEntity {
                entity,
                field: SnapshotField::BuildingOccupiedTiles,
                reason: EntityError::InvalidStaticShape,
            });
        };
        if !matches!(building.rotation, 0 | 90 | 180 | 270) {
            return Err(PersistenceError::InvalidEntity {
                entity,
                field: SnapshotField::BuildingRotation,
                reason: EntityError::InvalidStaticShape,
            });
        }
        let Some(expected) =
            crate::buildings::footprint(definition, &building.origin, building.rotation)
        else {
            return Err(PersistenceError::InvalidEntity {
                entity,
                field: SnapshotField::BuildingOrigin,
                reason: EntityError::InvalidStaticShape,
            });
        };
        if expected != building.occupied_tiles {
            return Err(PersistenceError::InvalidOwnership {
                owner: entity.clone(),
                owned: entity.clone(),
                reason: OwnershipError::FootprintMismatch,
            });
        }
        for point in &building.occupied_tiles {
            let Some(tile) = snapshot.map.tile(*point) else {
                return Err(PersistenceError::InvalidEntity {
                    entity: entity.clone(),
                    field: SnapshotField::BuildingOccupiedTiles,
                    reason: EntityError::InvalidStaticShape,
                });
            };
            let valid_tile = if definition.effect == "metroStation" {
                tile.has_track && tile.road_structure_id.is_none()
            } else {
                tile.kind == "empty"
                    && !tile.has_track
                    && tile.road_structure_id.is_none()
                    && definition
                        .allowed_area
                        .map_or(true, |area| tile.area.as_deref() == Some(area))
            };
            if !valid_tile {
                return Err(PersistenceError::InvalidEntity {
                    entity: entity.clone(),
                    field: SnapshotField::BuildingOccupiedTiles,
                    reason: EntityError::InvalidStaticShape,
                });
            }
            if let Some(first) = occupied.insert(*point, entity.clone()) {
                return Err(PersistenceError::InvalidOwnership {
                    owner: first,
                    owned: entity.clone(),
                    reason: OwnershipError::SpatialOverlap,
                });
            }
        }
        validate_building_node(snapshot, building, definition.effect, &mut claimed_nodes)?;
    }
    Ok(())
}

fn validate_building_node(
    snapshot: &GameSnapshot,
    building: &crate::model::PlacedBuilding,
    effect: &str,
    claimed_nodes: &mut BTreeSet<String>,
) -> PersistenceResult<()> {
    let owner = entity_ref(EntityKind::Building, &building.id);
    let expected_kind = match effect {
        "busStop" | "busTerminal" => Some(EntityKind::Stop),
        "metroStation" => Some(EntityKind::Station),
        _ => None,
    };
    match (expected_kind, building.transit_node_id.as_deref()) {
        (None, None) => Ok(()),
        (None, Some(id)) => Err(PersistenceError::InvalidOwnership {
            owner,
            owned: entity_ref(EntityKind::Stop, id),
            reason: OwnershipError::OwnerTypeMismatch,
        }),
        (Some(_), None) => Err(PersistenceError::InvalidOwnership {
            owner: owner.clone(),
            owned: owner,
            reason: OwnershipError::ReciprocalLinkMissing,
        }),
        (Some(kind), Some(id)) => {
            if !claimed_nodes.insert(id.to_string()) {
                return Err(PersistenceError::InvalidOwnership {
                    owner,
                    owned: entity_ref(kind, id),
                    reason: OwnershipError::MultipleOwners,
                });
            }
            let matches = match kind {
                EntityKind::Stop => snapshot.transit.stops.iter().any(|node| {
                    node.id == id
                        && node.status == TransitNodeStatus::Present
                        && node.position == building.origin
                        && ((effect == "busStop"
                            && node.kind == crate::model::BusStopKind::BusStop)
                            || (effect == "busTerminal"
                                && node.kind == crate::model::BusStopKind::BusTerminal))
                }),
                EntityKind::Station => snapshot.transit.stations.iter().any(|node| {
                    node.id == id
                        && node.status == TransitNodeStatus::Present
                        && node.position == building.origin
                }),
                _ => false,
            };
            if !matches {
                return Err(PersistenceError::InvalidOwnership {
                    owner,
                    owned: entity_ref(kind, id),
                    reason: OwnershipError::AnchorMismatch,
                });
            }
            Ok(())
        }
    }
}

fn validate_nodes_and_platforms(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let mut anchors = BTreeMap::new();
    for stop in &snapshot.transit.stops {
        let node = entity_ref(EntityKind::Stop, &stop.id);
        validate_node_lifetime(
            snapshot,
            node.clone(),
            stop.status,
            stop.position,
            snapshot
                .transit
                .routes
                .iter()
                .any(|route| route.stop_ids.contains(&stop.id)),
            &mut anchors,
        )?;
        if stop.status == TransitNodeStatus::Present
            && stop.road_access != stop_access::resolve_stop_access(snapshot, &stop.id)
        {
            return Err(PersistenceError::InvalidDerivedState {
                field: SnapshotField::NodeRoadAccess,
                reason: DerivedStateError::StopAccessMismatch { node },
            });
        }
        validate_platform_shape(
            &node,
            &stop.platforms,
            platforms::bus_platforms(&stop.id, stop.kind),
        )?;
        validate_platform_assignments(
            snapshot,
            &node,
            &stop.id,
            TransitMode::Bus,
            &stop.platforms,
        )?;
    }
    for station in &snapshot.transit.stations {
        let node = entity_ref(EntityKind::Station, &station.id);
        validate_node_lifetime(
            snapshot,
            node.clone(),
            station.status,
            station.position,
            snapshot
                .transit
                .metro_lines
                .iter()
                .any(|line| line.station_ids.contains(&station.id)),
            &mut anchors,
        )?;
        if station.status == TransitNodeStatus::Present
            && !snapshot
                .map
                .tile(station.position)
                .is_some_and(|tile| tile.has_track && tile.road_structure_id.is_none())
        {
            return Err(PersistenceError::InvalidEntity {
                entity: node.clone(),
                field: SnapshotField::NodeAnchor,
                reason: EntityError::InvalidStaticShape,
            });
        }
        validate_platform_shape(
            &node,
            &station.platforms,
            platforms::metro_platforms(&station.id),
        )?;
        validate_platform_assignments(
            snapshot,
            &node,
            &station.id,
            TransitMode::Metro,
            &station.platforms,
        )?;
    }
    Ok(())
}

fn validate_node_lifetime(
    snapshot: &GameSnapshot,
    node: EntityRef,
    status: TransitNodeStatus,
    point: crate::model::Point,
    referenced: bool,
    anchors: &mut BTreeMap<crate::model::Point, EntityRef>,
) -> PersistenceResult<()> {
    if status == TransitNodeStatus::Missing {
        if !referenced {
            return Err(PersistenceError::InvalidOwnership {
                owner: node.clone(),
                owned: node,
                reason: OwnershipError::MissingOwner,
            });
        }
        return Ok(());
    }
    let Some(tile) = snapshot.map.tile(point) else {
        return Err(PersistenceError::InvalidEntity {
            entity: node,
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
        });
    };
    if tile.road_structure_id.is_some() {
        return Err(PersistenceError::InvalidEntity {
            entity: node,
            field: SnapshotField::NodeAnchor,
            reason: EntityError::InvalidStaticShape,
        });
    }
    if let Some(first) = anchors.insert(point, node.clone()) {
        return Err(PersistenceError::InvalidOwnership {
            owner: first,
            owned: node,
            reason: OwnershipError::SpatialOverlap,
        });
    }
    Ok(())
}

fn validate_platform_shape(
    node: &EntityRef,
    actual: &[Platform],
    expected: Vec<Platform>,
) -> PersistenceResult<()> {
    if actual.len() != expected.len() {
        return Err(PersistenceError::InvalidEntity {
            entity: node.clone(),
            field: SnapshotField::PlatformCount,
            reason: EntityError::InvalidStaticShape,
        });
    }
    for (stored, canonical) in actual.iter().zip(expected) {
        if stored.id != canonical.id {
            return Err(PersistenceError::InvalidEntity {
                entity: entity_ref(EntityKind::Platform, &stored.id),
                field: SnapshotField::PlatformOrder,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if stored.label != canonical.label {
            return Err(PersistenceError::InvalidEntity {
                entity: entity_ref(EntityKind::Platform, &stored.id),
                field: SnapshotField::PlatformLabel,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if stored.capacity != canonical.capacity {
            return Err(PersistenceError::InvalidEntity {
                entity: entity_ref(EntityKind::Platform, &stored.id),
                field: SnapshotField::PlatformCapacity,
                reason: EntityError::InvalidStaticShape,
            });
        }
    }
    Ok(())
}

fn validate_platform_assignments(
    snapshot: &GameSnapshot,
    node: &EntityRef,
    node_id: &str,
    mode: TransitMode,
    platforms: &[Platform],
) -> PersistenceResult<()> {
    let mut assigned = BTreeSet::new();
    for platform in platforms {
        let platform_ref = entity_ref(EntityKind::Platform, &platform.id);
        let mut local = BTreeSet::new();
        for route_id in &platform.route_ids {
            if !local.insert(route_id.as_str()) || !assigned.insert(route_id.as_str()) {
                return Err(PersistenceError::InvalidAssignment {
                    entity: platform_ref.clone(),
                    reason: AssignmentError::DuplicateAssignment,
                });
            }
            let contains_node = match mode {
                TransitMode::Bus => snapshot
                    .transit
                    .routes
                    .iter()
                    .find(|route| route.id == *route_id)
                    .is_some_and(|route| route.stop_ids.iter().any(|id| id == node_id)),
                TransitMode::Metro => snapshot
                    .transit
                    .metro_lines
                    .iter()
                    .find(|line| line.id == *route_id)
                    .is_some_and(|line| line.station_ids.iter().any(|id| id == node_id)),
                TransitMode::Walk => false,
            };
            if !contains_node {
                return Err(PersistenceError::InvalidAssignment {
                    entity: platform_ref.clone(),
                    reason: AssignmentError::PlatformMismatch,
                });
            }
        }
    }
    let expected: BTreeSet<&str> = match mode {
        TransitMode::Bus => snapshot
            .transit
            .routes
            .iter()
            .filter(|route| route.stop_ids.iter().any(|id| id == node_id))
            .map(|route| route.id.as_str())
            .collect(),
        TransitMode::Metro => snapshot
            .transit
            .metro_lines
            .iter()
            .filter(|line| line.station_ids.iter().any(|id| id == node_id))
            .map(|line| line.id.as_str())
            .collect(),
        TransitMode::Walk => BTreeSet::new(),
    };
    if assigned != expected {
        return Err(PersistenceError::InvalidOwnership {
            owner: node.clone(),
            owned: node.clone(),
            reason: OwnershipError::ReciprocalLinkMissing,
        });
    }
    Ok(())
}

fn validate_routes(snapshot: &GameSnapshot, topology: &RoadTopology) -> PersistenceResult<()> {
    for route in &snapshot.transit.routes {
        validate_route_shape(
            snapshot,
            EntityKind::BusRoute,
            &route.id,
            TransitMode::Bus,
            &route.stop_ids,
            &route.vehicle_ids,
            &route.legs,
        )?;
    }
    for line in &snapshot.transit.metro_lines {
        validate_route_shape(
            snapshot,
            EntityKind::MetroLine,
            &line.id,
            TransitMode::Metro,
            &line.station_ids,
            &line.vehicle_ids,
            &line.legs,
        )?;
    }

    let context = RoutingContext {
        road_topology: topology,
    };
    let derived = derive_route_states(snapshot, context);
    let mut fixed_point = snapshot.clone();
    for state in &derived {
        match state.mode {
            TransitMode::Bus => {
                let route = fixed_point
                    .transit
                    .routes
                    .iter_mut()
                    .find(|route| route.id == state.route_id)
                    .expect("derived bus route retains source identity");
                route.legs.clone_from(&state.legs);
                route.path_broken = state.path_broken;
            }
            TransitMode::Metro => {
                let line = fixed_point
                    .transit
                    .metro_lines
                    .iter_mut()
                    .find(|line| line.id == state.route_id)
                    .expect("derived metro line retains source identity");
                line.legs.clone_from(&state.legs);
                line.path_broken = state.path_broken;
            }
            TransitMode::Walk => unreachable!("walk is not a persisted service"),
        }
    }
    let second = derive_route_states(&fixed_point, context);
    if derived != second {
        let route = derived
            .first()
            .map(|state| {
                entity_ref(
                    if state.mode == TransitMode::Bus {
                        EntityKind::BusRoute
                    } else {
                        EntityKind::MetroLine
                    },
                    &state.route_id,
                )
            })
            .unwrap_or_else(|| entity_ref(EntityKind::BusRoute, ""));
        return Err(PersistenceError::InvalidDerivedState {
            field: SnapshotField::RouteLegs,
            reason: DerivedStateError::RouteOracleNotIdempotent { route },
        });
    }
    for state in derived {
        let (kind, legs, path_broken) = match state.mode {
            TransitMode::Bus => snapshot
                .transit
                .routes
                .iter()
                .find(|route| route.id == state.route_id)
                .map(|route| (EntityKind::BusRoute, &route.legs, route.path_broken)),
            TransitMode::Metro => snapshot
                .transit
                .metro_lines
                .iter()
                .find(|line| line.id == state.route_id)
                .map(|line| (EntityKind::MetroLine, &line.legs, line.path_broken)),
            TransitMode::Walk => None,
        }
        .expect("derived route retains source identity");
        let route_ref = entity_ref(kind, &state.route_id);
        if legs != &state.legs {
            return Err(PersistenceError::InvalidDerivedState {
                field: SnapshotField::RouteLegs,
                reason: DerivedStateError::RouteLegMismatch { route: route_ref },
            });
        }
        if path_broken != state.path_broken {
            return Err(PersistenceError::InvalidDerivedState {
                field: SnapshotField::RoutePathBroken,
                reason: DerivedStateError::RoutePathBrokenMismatch { route: route_ref },
            });
        }
    }
    Ok(())
}

fn validate_route_shape(
    snapshot: &GameSnapshot,
    kind: EntityKind,
    route_id: &str,
    mode: TransitMode,
    waypoint_ids: &[String],
    vehicle_ids: &[String],
    legs: &[RouteLegPath],
) -> PersistenceResult<()> {
    let route = entity_ref(kind, route_id);
    if waypoint_ids.len() < 2 {
        return Err(PersistenceError::InvalidEntity {
            entity: route.clone(),
            field: SnapshotField::RouteWaypointIds,
            reason: EntityError::InvalidStaticShape,
        });
    }
    let mut waypoints = BTreeSet::new();
    for waypoint_id in waypoint_ids {
        if !waypoints.insert(waypoint_id.as_str()) {
            return Err(PersistenceError::InvalidAssignment {
                entity: route.clone(),
                reason: AssignmentError::DuplicateAssignment,
            });
        }
        let exists = match mode {
            TransitMode::Bus => snapshot
                .transit
                .stops
                .iter()
                .any(|stop| stop.id == *waypoint_id),
            TransitMode::Metro => snapshot
                .transit
                .stations
                .iter()
                .any(|station| station.id == *waypoint_id),
            TransitMode::Walk => false,
        };
        if !exists {
            return Err(PersistenceError::DanglingReference {
                source: route.clone(),
                field: SnapshotField::RouteWaypointIds,
                target: entity_ref(
                    if mode == TransitMode::Bus {
                        EntityKind::Stop
                    } else {
                        EntityKind::Station
                    },
                    waypoint_id,
                ),
            });
        }
    }
    let mut vehicles = BTreeSet::new();
    for vehicle_id in vehicle_ids {
        if !vehicles.insert(vehicle_id.as_str()) {
            return Err(PersistenceError::InvalidAssignment {
                entity: route.clone(),
                reason: AssignmentError::DuplicateAssignment,
            });
        }
        let Some(vehicle) = snapshot
            .transit
            .vehicles
            .iter()
            .find(|vehicle| vehicle.id == *vehicle_id)
        else {
            return Err(PersistenceError::DanglingReference {
                source: route.clone(),
                field: SnapshotField::RouteVehicleIds,
                target: entity_ref(EntityKind::Vehicle, vehicle_id),
            });
        };
        if vehicle.mode != mode || vehicle.line_id != route_id {
            return Err(PersistenceError::InvalidAssignment {
                entity: route.clone(),
                reason: AssignmentError::ModeMismatch,
            });
        }
    }
    for leg in legs {
        validate_route_leg(route.clone(), mode, leg)?;
    }
    Ok(())
}

fn validate_route_leg(
    route: EntityRef,
    mode: TransitMode,
    leg: &RouteLegPath,
) -> PersistenceResult<()> {
    if let Some(seconds) = leg.estimated_seconds {
        finite_non_negative(
            Some(route.clone()),
            SnapshotField::RouteEstimatedSeconds,
            seconds,
        )?;
    }
    for path in [leg.current_path.as_ref(), leg.last_valid_path.as_ref()]
        .into_iter()
        .flatten()
    {
        let compatible = matches!(
            (mode, path),
            (TransitMode::Bus, TransitPath::Road { .. })
                | (TransitMode::Metro, TransitPath::Track { .. })
        );
        if !compatible {
            return Err(PersistenceError::InvalidAssignment {
                entity: route.clone(),
                reason: AssignmentError::ModeMismatch,
            });
        }
        finite_non_negative(
            Some(route.clone()),
            SnapshotField::RouteEstimatedSeconds,
            path.total_travel_seconds(),
        )?;
        for step in path.step_refs() {
            finite_non_negative(
                Some(route.clone()),
                SnapshotField::RouteEstimatedSeconds,
                step.travel_seconds(),
            )?;
        }
    }
    Ok(())
}

fn validate_vehicles(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let mut line_owners = BTreeMap::new();
    for route in &snapshot.transit.routes {
        for vehicle_id in &route.vehicle_ids {
            if line_owners
                .insert(vehicle_id.as_str(), route.id.as_str())
                .is_some()
            {
                return Err(PersistenceError::InvalidAssignment {
                    entity: entity_ref(EntityKind::Vehicle, vehicle_id),
                    reason: AssignmentError::VehicleListedByMultipleLines,
                });
            }
        }
    }
    for line in &snapshot.transit.metro_lines {
        for vehicle_id in &line.vehicle_ids {
            if line_owners
                .insert(vehicle_id.as_str(), line.id.as_str())
                .is_some()
            {
                return Err(PersistenceError::InvalidAssignment {
                    entity: entity_ref(EntityKind::Vehicle, vehicle_id),
                    reason: AssignmentError::VehicleListedByMultipleLines,
                });
            }
        }
    }

    let mut passengers = BTreeSet::new();
    for vehicle in &snapshot.transit.vehicles {
        let entity = entity_ref(EntityKind::Vehicle, &vehicle.id);
        if vehicle.mode == TransitMode::Walk {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::ModeMismatch,
            });
        }
        let line = line_view(snapshot, vehicle.mode, &vehicle.line_id);
        let Some((waypoints, legs, vehicle_ids)) = line else {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::ModeMismatch,
            });
        };
        if vehicle_ids.iter().filter(|id| **id == vehicle.id).count() != 1 {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::VehicleMissingFromLine,
            });
        }
        let expected_capacity = if vehicle.mode == TransitMode::Bus {
            18
        } else {
            90
        };
        if vehicle.capacity != expected_capacity {
            return Err(PersistenceError::InvalidEntity {
                entity: entity.clone(),
                field: SnapshotField::VehicleCapacity,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if !vehicle.step_progress.is_finite() || !(0.0..=1.0).contains(&vehicle.step_progress) {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::ProgressOutOfRange,
            });
        }
        if legs.is_empty() {
            if vehicle.itinerary_index != 0 {
                return Err(PersistenceError::InvalidAssignment {
                    entity,
                    reason: AssignmentError::ItineraryIndexOutOfBounds,
                });
            }
        } else if vehicle.itinerary_index >= legs.len() {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::ItineraryIndexOutOfBounds,
            });
        } else {
            let step_count = legs[vehicle.itinerary_index]
                .current_path
                .as_ref()
                .map_or(0, TransitPath::step_count);
            if (step_count == 0 && vehicle.path_step_index != 0)
                || (step_count > 0 && vehicle.path_step_index >= step_count)
            {
                return Err(PersistenceError::InvalidAssignment {
                    entity,
                    reason: AssignmentError::PathStepIndexOutOfBounds,
                });
            }
        }
        if let Some(position) = &vehicle.parked_position {
            if !position.x.is_finite() || !position.y.is_finite() {
                return Err(PersistenceError::InvalidNumericValue {
                    entity: Some(entity.clone()),
                    field: SnapshotField::VehicleParkedPosition,
                    reason: NumericError::NotFinite,
                });
            }
            if !world_position_in_bounds(snapshot, position) {
                return Err(PersistenceError::InvalidNumericValue {
                    entity: Some(entity.clone()),
                    field: SnapshotField::VehicleParkedPosition,
                    reason: NumericError::OutOfRange {
                        minimum: 0.0,
                        maximum: f64::from(snapshot.map.width.max(snapshot.map.height)),
                        actual: position.x.max(position.y),
                    },
                });
            }
        }
        let visits = service_visits(waypoints, legs);
        if !legs.is_empty()
            && visits.is_empty()
            && vehicle.parked_position.is_none()
            && !vehicle.passenger_ids.is_empty()
        {
            return Err(PersistenceError::InvalidAssignment {
                entity,
                reason: AssignmentError::ItineraryIndexOutOfBounds,
            });
        }
        let mut local = BTreeSet::new();
        for passenger_id in &vehicle.passenger_ids {
            if !local.insert(passenger_id.as_str()) || !passengers.insert(passenger_id.as_str()) {
                return Err(PersistenceError::InvalidAssignment {
                    entity: entity.clone(),
                    reason: AssignmentError::PassengerInMultipleVehicles,
                });
            }
            let Some(trip) = snapshot
                .active_trips
                .iter()
                .find(|trip| trip.id == *passenger_id)
            else {
                return Err(PersistenceError::DanglingReference {
                    source: entity.clone(),
                    field: SnapshotField::VehiclePassengerIds,
                    target: entity_ref(EntityKind::ActiveTrip, passenger_id),
                });
            };
            let compatible = trip.status == TripStatus::Riding
                && trip
                    .route_plan
                    .as_ref()
                    .and_then(|plan| plan.legs.get(trip.current_leg_index))
                    .is_some_and(|leg| {
                        leg.mode == vehicle.mode
                            && leg.line_id.as_deref() == Some(vehicle.line_id.as_str())
                    });
            if !compatible {
                return Err(PersistenceError::InvalidAssignment {
                    entity: entity.clone(),
                    reason: AssignmentError::PassengerNotRiding,
                });
            }
        }
    }
    Ok(())
}

fn line_view<'a>(
    snapshot: &'a GameSnapshot,
    mode: TransitMode,
    line_id: &str,
) -> Option<(&'a [String], &'a [RouteLegPath], &'a [String])> {
    match mode {
        TransitMode::Bus => snapshot
            .transit
            .routes
            .iter()
            .find(|route| route.id == line_id)
            .map(|route| {
                (
                    route.stop_ids.as_slice(),
                    route.legs.as_slice(),
                    route.vehicle_ids.as_slice(),
                )
            }),
        TransitMode::Metro => snapshot
            .transit
            .metro_lines
            .iter()
            .find(|line| line.id == line_id)
            .map(|line| {
                (
                    line.station_ids.as_slice(),
                    line.legs.as_slice(),
                    line.vehicle_ids.as_slice(),
                )
            }),
        TransitMode::Walk => None,
    }
}

fn world_position_in_bounds(
    snapshot: &GameSnapshot,
    position: &crate::model::TripPosition,
) -> bool {
    position.x.is_finite()
        && position.y.is_finite()
        && position.x >= 0.0
        && position.y >= 0.0
        && position.x < f64::from(snapshot.map.width)
        && position.y < f64::from(snapshot.map.height)
}

fn finite_non_negative(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
) -> PersistenceResult<()> {
    if !value.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::NotFinite,
        });
    }
    if value < 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}

fn entity_ref(kind: EntityKind, id: &str) -> EntityRef {
    EntityRef {
        kind,
        id: id.to_string(),
    }
}
