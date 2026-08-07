use std::collections::{BTreeMap, BTreeSet};

use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::engine::RoutingContext;
use crate::model::{
    ActiveTrip, GameSnapshot, MetroLine, PathGeometry, PlacedBuilding, Platform, Point, Route,
    RouteLegPath, Sim, Station, Stop, TransitMode, TransitNodeStatus, TransitPath, TripPosition,
    TripStatus, Vehicle,
};
use crate::platforms;
use crate::road_topology::RoadTopology;
use crate::route_lifecycle::derive_route_states;
use crate::service_itinerary::service_visits;
use crate::stop_access;
use crate::transit::vehicle_capacity;

use super::{
    AssignmentError, EntityError, EntityKind, EntityRef, NumericError, OwnershipError,
    PersistenceError, PersistenceResult, SnapshotField,
};

pub(super) struct EntityIndexes<'a> {
    kinds: BTreeMap<&'a str, EntityKind>,
    sims: BTreeMap<&'a str, &'a Sim>,
    trips: BTreeMap<&'a str, &'a ActiveTrip>,
    stops: BTreeMap<&'a str, &'a Stop>,
    stations: BTreeMap<&'a str, &'a Station>,
    platforms: BTreeMap<&'a str, &'a Platform>,
    routes: BTreeMap<&'a str, &'a Route>,
    metro_lines: BTreeMap<&'a str, &'a MetroLine>,
    vehicles: BTreeMap<&'a str, &'a Vehicle>,
    /// Reverse index: waypoint node ID → route/line IDs that include it.
    node_routes: BTreeMap<&'a str, BTreeSet<&'a str>>,
    /// Reverse index: trip ID → vehicle IDs that carry it as a passenger.
    trip_vehicles: BTreeMap<&'a str, BTreeSet<&'a str>>,
}

impl EntityIndexes<'_> {
    pub(super) fn sim(&self, id: &str) -> Option<&Sim> {
        self.sims.get(id).copied()
    }

    pub(super) fn trip(&self, id: &str) -> Option<&ActiveTrip> {
        self.trips.get(id).copied()
    }

    pub(super) fn stop(&self, id: &str) -> Option<&Stop> {
        self.stops.get(id).copied()
    }

    pub(super) fn station(&self, id: &str) -> Option<&Station> {
        self.stations.get(id).copied()
    }

    pub(super) fn vehicle(&self, id: &str) -> Option<&Vehicle> {
        self.vehicles.get(id).copied()
    }

    pub(super) fn route(&self, id: &str) -> Option<&Route> {
        self.routes.get(id).copied()
    }

    pub(super) fn metro_line(&self, id: &str) -> Option<&MetroLine> {
        self.metro_lines.get(id).copied()
    }

    /// Returns the set of route/line IDs that include `node_id` as a waypoint.
    pub(super) fn routes_for_node(&self, node_id: &str) -> Option<&BTreeSet<&str>> {
        self.node_routes.get(node_id)
    }

    /// Returns the set of vehicle IDs that carry `trip_id` as a passenger.
    pub(super) fn vehicles_for_trip(&self, trip_id: &str) -> Option<&BTreeSet<&str>> {
        self.trip_vehicles.get(trip_id)
    }
}

pub(super) fn validate_entities<'a>(
    snapshot: &'a GameSnapshot,
    _topology: &RoadTopology,
) -> PersistenceResult<EntityIndexes<'a>> {
    let indexes = validate_entity_references(snapshot)?;
    validate_routes(snapshot, &indexes)?;
    validate_vehicles(snapshot, &indexes)?;
    Ok(indexes)
}

pub(super) fn validate_entities_for_normalization(
    snapshot: &GameSnapshot,
    _topology: &RoadTopology,
) -> PersistenceResult<()> {
    let _ = validate_entity_references(snapshot)?;
    Ok(())
}

fn validate_entity_references<'a>(
    snapshot: &'a GameSnapshot,
) -> PersistenceResult<EntityIndexes<'a>> {
    let indexes = build_indexes(snapshot)?;
    validate_route_references(snapshot, &indexes)?;
    let building_footprint = validate_buildings(snapshot, &indexes)?;
    validate_nodes_and_platforms(snapshot, &indexes, &building_footprint)?;
    Ok(indexes)
}

pub(super) fn normalize_direct_fields(snapshot: &mut GameSnapshot, topology: &RoadTopology) {
    let _ = normalize_building_footprints(snapshot);
    *snapshot = stop_access::normalize_snapshot_stops(snapshot.clone());
    normalize_platform_values(snapshot);
    normalize_vehicle_capacities(snapshot);
    normalize_route_states(snapshot, topology);
}

fn build_indexes<'a>(snapshot: &'a GameSnapshot) -> PersistenceResult<EntityIndexes<'a>> {
    let mut indexes = EntityIndexes {
        kinds: BTreeMap::new(),
        sims: BTreeMap::new(),
        trips: BTreeMap::new(),
        stops: BTreeMap::new(),
        stations: BTreeMap::new(),
        platforms: BTreeMap::new(),
        routes: BTreeMap::new(),
        metro_lines: BTreeMap::new(),
        vehicles: BTreeMap::new(),
        node_routes: BTreeMap::new(),
        trip_vehicles: BTreeMap::new(),
    };
    for building in &snapshot.buildings {
        register(&mut indexes, EntityKind::Building, &building.id)?;
    }
    for sim in &snapshot.sims {
        register(&mut indexes, EntityKind::Sim, &sim.id)?;
        indexes.sims.insert(&sim.id, sim);
    }
    for trip in &snapshot.active_trips {
        register_trip(&mut indexes, &trip.id)?;
        indexes.trips.insert(&trip.id, trip);
    }
    for stop in &snapshot.transit.stops {
        register(&mut indexes, EntityKind::Stop, &stop.id)?;
        indexes.stops.insert(&stop.id, stop);
        for platform in &stop.platforms {
            register_platform(&mut indexes, platform, &stop.id)?;
            indexes.platforms.insert(&platform.id, platform);
        }
    }
    for station in &snapshot.transit.stations {
        register(&mut indexes, EntityKind::Station, &station.id)?;
        indexes.stations.insert(&station.id, station);
        for platform in &station.platforms {
            register_platform(&mut indexes, platform, &station.id)?;
            indexes.platforms.insert(&platform.id, platform);
        }
    }
    for route in &snapshot.transit.routes {
        register(&mut indexes, EntityKind::BusRoute, &route.id)?;
        indexes.routes.insert(&route.id, route);
        for stop_id in &route.stop_ids {
            indexes
                .node_routes
                .entry(stop_id.as_str())
                .or_default()
                .insert(&route.id);
        }
    }
    for line in &snapshot.transit.metro_lines {
        register(&mut indexes, EntityKind::MetroLine, &line.id)?;
        indexes.metro_lines.insert(&line.id, line);
        for station_id in &line.station_ids {
            indexes
                .node_routes
                .entry(station_id.as_str())
                .or_default()
                .insert(&line.id);
        }
    }
    for vehicle in &snapshot.transit.vehicles {
        register(&mut indexes, EntityKind::Vehicle, &vehicle.id)?;
        indexes.vehicles.insert(&vehicle.id, vehicle);
        for passenger_id in &vehicle.passenger_ids {
            indexes
                .trip_vehicles
                .entry(passenger_id.as_str())
                .or_default()
                .insert(&vehicle.id);
        }
    }

    Ok(indexes)
}

/// Building footprint occupancy entry used by node validation to reject
/// present transit nodes that overlap a building without being declared by it.
pub(super) struct BuildingOccupant<'a> {
    pub id: &'a str,
    pub transit_node_id: Option<&'a str>,
}

/// Look up the building definition, validate its rotation, and derive the
/// canonical footprint. Shared by normalization (which writes the result into
/// `occupied_tiles`) and validation (which compares against the footprint and
/// reads further fields from the definition), so the two paths cannot drift on
/// what a building resolves to.
fn expected_footprint(
    building: &PlacedBuilding,
) -> PersistenceResult<(&'static BuildingDefinition, Vec<Point>)> {
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
    let footprint = crate::buildings::footprint(definition, &building.origin, building.rotation)
        .ok_or(PersistenceError::InvalidEntity {
            entity,
            field: SnapshotField::BuildingOrigin,
            reason: EntityError::InvalidStaticShape,
        })?;
    Ok((definition, footprint))
}

fn normalize_building_footprints(snapshot: &mut GameSnapshot) -> PersistenceResult<()> {
    for building in &mut snapshot.buildings {
        let (_, footprint) = expected_footprint(building)?;
        building.occupied_tiles = footprint;
    }
    Ok(())
}

fn normalize_platform_values(snapshot: &mut GameSnapshot) {
    for stop in &mut snapshot.transit.stops {
        let expected = platforms::bus_platforms(&stop.id, stop.kind);
        for (stored, canonical) in stop.platforms.iter_mut().zip(expected) {
            stored.label = canonical.label;
            stored.capacity = canonical.capacity;
        }
    }
    for station in &mut snapshot.transit.stations {
        let expected = platforms::metro_platforms(&station.id);
        for (stored, canonical) in station.platforms.iter_mut().zip(expected) {
            stored.label = canonical.label;
            stored.capacity = canonical.capacity;
        }
    }
}

fn normalize_vehicle_capacities(snapshot: &mut GameSnapshot) {
    for vehicle in &mut snapshot.transit.vehicles {
        vehicle.capacity = vehicle_capacity(vehicle.mode);
    }
}

fn normalize_route_states(snapshot: &mut GameSnapshot, topology: &RoadTopology) {
    let derived = derive_route_states(
        snapshot,
        RoutingContext {
            road_topology: topology,
        },
    );
    for state in derived {
        match state.mode {
            TransitMode::Bus => {
                if let Some(route) = snapshot
                    .transit
                    .routes
                    .iter_mut()
                    .find(|route| route.id == state.route_id)
                {
                    route.legs = state.legs;
                    route.path_broken = state.path_broken;
                }
            }
            TransitMode::Metro => {
                if let Some(line) = snapshot
                    .transit
                    .metro_lines
                    .iter_mut()
                    .find(|line| line.id == state.route_id)
                {
                    line.legs = state.legs;
                    line.path_broken = state.path_broken;
                }
            }
            TransitMode::Walk => {}
        }
    }
}

fn validate_route_references(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<()> {
    for route in &snapshot.transit.routes {
        validate_route_waypoint_references(
            indexes,
            EntityKind::BusRoute,
            &route.id,
            TransitMode::Bus,
            &route.stop_ids,
        )?;
        validate_route_vehicle_references(
            indexes,
            EntityKind::BusRoute,
            &route.id,
            TransitMode::Bus,
            &route.vehicle_ids,
        )?;
    }
    for line in &snapshot.transit.metro_lines {
        validate_route_waypoint_references(
            indexes,
            EntityKind::MetroLine,
            &line.id,
            TransitMode::Metro,
            &line.station_ids,
        )?;
        validate_route_vehicle_references(
            indexes,
            EntityKind::MetroLine,
            &line.id,
            TransitMode::Metro,
            &line.vehicle_ids,
        )?;
    }
    Ok(())
}

fn validate_route_waypoint_references(
    indexes: &EntityIndexes<'_>,
    kind: EntityKind,
    route_id: &str,
    mode: TransitMode,
    waypoint_ids: &[String],
) -> PersistenceResult<()> {
    let route = entity_ref(kind, route_id);
    if waypoint_ids.len() < 2 {
        return Err(PersistenceError::InvalidEntity {
            entity: route,
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
            TransitMode::Bus => indexes.stop(waypoint_id).is_some(),
            TransitMode::Metro => indexes.station(waypoint_id).is_some(),
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
    Ok(())
}

fn validate_route_vehicle_references(
    indexes: &EntityIndexes<'_>,
    kind: EntityKind,
    route_id: &str,
    mode: TransitMode,
    vehicle_ids: &[String],
) -> PersistenceResult<()> {
    let route = entity_ref(kind, route_id);
    let mut vehicles = BTreeSet::new();
    for vehicle_id in vehicle_ids {
        if !vehicles.insert(vehicle_id.as_str()) {
            return Err(PersistenceError::InvalidAssignment {
                entity: route.clone(),
                reason: AssignmentError::DuplicateAssignment,
            });
        }
        let Some(vehicle) = indexes.vehicle(vehicle_id) else {
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
    Ok(())
}

fn register<'a>(
    indexes: &mut EntityIndexes<'a>,
    kind: EntityKind,
    id: &'a str,
) -> PersistenceResult<()> {
    if id.is_empty() {
        return Err(invalid_entity(kind, id, EntityError::EmptyId));
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
    register_unique(indexes, EntityKind::ActiveTrip, id)
}

fn register_platform<'a>(
    indexes: &mut EntityIndexes<'a>,
    platform: &'a Platform,
    _node_id: &str,
) -> PersistenceResult<()> {
    if platform.id.is_empty() {
        return Err(invalid_entity(
            EntityKind::Platform,
            &platform.id,
            EntityError::EmptyId,
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

fn validate_buildings<'a>(
    snapshot: &'a GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<BTreeMap<crate::model::Point, BuildingOccupant<'a>>> {
    let mut occupied: BTreeMap<crate::model::Point, BuildingOccupant<'a>> = BTreeMap::new();
    let mut claimed_nodes = BTreeSet::new();
    for building in &snapshot.buildings {
        let entity = entity_ref(EntityKind::Building, &building.id);
        let (definition, expected) = expected_footprint(building)?;
        for point in &expected {
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
            let occupant = BuildingOccupant {
                id: &building.id,
                transit_node_id: building.transit_node_id.as_deref(),
            };
            if let Some(first) = occupied.insert(*point, occupant) {
                return Err(PersistenceError::InvalidOwnership {
                    owner: entity_ref(EntityKind::Building, first.id),
                    owned: entity.clone(),
                    reason: OwnershipError::SpatialOverlap,
                });
            }
        }
        validate_building_node(indexes, building, definition.effect, &mut claimed_nodes)?;
    }
    Ok(occupied)
}

fn validate_building_node(
    indexes: &EntityIndexes<'_>,
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
                EntityKind::Stop => indexes.stop(id).is_some_and(|node| {
                    node.status == TransitNodeStatus::Present
                        && node.position == building.origin
                        && ((effect == "busStop"
                            && node.kind == crate::model::BusStopKind::BusStop)
                            || (effect == "busTerminal"
                                && node.kind == crate::model::BusStopKind::BusTerminal))
                }),
                EntityKind::Station => indexes.station(id).is_some_and(|node| {
                    node.status == TransitNodeStatus::Present && node.position == building.origin
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

fn validate_nodes_and_platforms(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
    building_footprint: &BTreeMap<crate::model::Point, BuildingOccupant<'_>>,
) -> PersistenceResult<()> {
    let mut anchors = BTreeMap::new();
    for stop in &snapshot.transit.stops {
        let node = entity_ref(EntityKind::Stop, &stop.id);
        validate_node_lifetime(
            snapshot,
            node.clone(),
            stop.status,
            stop.position,
            indexes
                .routes_for_node(&stop.id)
                .is_some_and(|routes| !routes.is_empty()),
            &mut anchors,
            building_footprint,
        )?;
        validate_platform_shape(
            &node,
            &stop.platforms,
            platforms::bus_platforms(&stop.id, stop.kind),
        )?;
        validate_platform_assignments(indexes, &node, &stop.id, TransitMode::Bus, &stop.platforms)?;
    }
    for station in &snapshot.transit.stations {
        let node = entity_ref(EntityKind::Station, &station.id);
        validate_node_lifetime(
            snapshot,
            node.clone(),
            station.status,
            station.position,
            indexes
                .routes_for_node(&station.id)
                .is_some_and(|routes| !routes.is_empty()),
            &mut anchors,
            building_footprint,
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
            indexes,
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
    building_footprint: &BTreeMap<crate::model::Point, BuildingOccupant<'_>>,
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
    // A present transit node may overlap a building footprint only when that
    // exact building declares the node through `transit_node_id` (validated
    // reciprocally by `validate_building_node`). An unowned node sitting on an
    // ordinary building's footprint is a malformed spatial state.
    if let Some(occupant) = building_footprint.get(&point) {
        if occupant.transit_node_id != Some(node.id.as_str()) {
            return Err(PersistenceError::InvalidOwnership {
                owner: entity_ref(EntityKind::Building, occupant.id),
                owned: node,
                reason: OwnershipError::SpatialOverlap,
            });
        }
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
    }
    Ok(())
}

fn validate_platform_assignments(
    indexes: &EntityIndexes<'_>,
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
                TransitMode::Bus => indexes
                    .route(route_id)
                    .is_some_and(|route| route.stop_ids.iter().any(|id| id == node_id)),
                TransitMode::Metro => indexes
                    .metro_line(route_id)
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
    let expected: BTreeSet<&str> = indexes
        .routes_for_node(node_id)
        .map(|routes| routes.iter().copied().collect())
        .unwrap_or_default();
    if assigned != expected {
        return Err(PersistenceError::InvalidOwnership {
            owner: node.clone(),
            owned: node.clone(),
            reason: OwnershipError::ReciprocalLinkMissing,
        });
    }
    Ok(())
}

fn validate_routes(snapshot: &GameSnapshot, indexes: &EntityIndexes<'_>) -> PersistenceResult<()> {
    for route in &snapshot.transit.routes {
        validate_route_shape(
            snapshot,
            indexes,
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
            indexes,
            EntityKind::MetroLine,
            &line.id,
            TransitMode::Metro,
            &line.station_ids,
            &line.vehicle_ids,
            &line.legs,
        )?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_route_shape(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
    kind: EntityKind,
    route_id: &str,
    mode: TransitMode,
    waypoint_ids: &[String],
    vehicle_ids: &[String],
    legs: &[RouteLegPath],
) -> PersistenceResult<()> {
    validate_route_waypoint_references(indexes, kind, route_id, mode, waypoint_ids)?;
    validate_route_vehicle_references(indexes, kind, route_id, mode, vehicle_ids)?;
    let route = entity_ref(kind, route_id);
    for leg in legs {
        validate_route_leg(snapshot, route.clone(), mode, leg)?;
    }
    Ok(())
}

fn validate_route_leg(
    snapshot: &GameSnapshot,
    route: EntityRef,
    mode: TransitMode,
    leg: &RouteLegPath,
) -> PersistenceResult<()> {
    if let Some(seconds) = leg.estimated_seconds {
        super::finite_non_negative(
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
        super::finite_non_negative(
            Some(route.clone()),
            SnapshotField::RouteEstimatedSeconds,
            path.total_travel_seconds(),
        )?;
        for step in path.step_refs() {
            super::finite_non_negative(
                Some(route.clone()),
                SnapshotField::RouteEstimatedSeconds,
                step.travel_seconds(),
            )?;
        }
        validate_path_structure(snapshot, route.clone(), path)?;
    }
    Ok(())
}

fn validate_path_structure(
    snapshot: &GameSnapshot,
    route: EntityRef,
    path: &TransitPath,
) -> PersistenceResult<()> {
    let width = snapshot.map.width;
    let height = snapshot.map.height;
    let steps: Vec<(&Point, &PathGeometry)> = match path {
        TransitPath::Road { steps, .. } => {
            steps.iter().map(|s| (&s.position, &s.geometry)).collect()
        }
        TransitPath::Track { steps, .. } => {
            steps.iter().map(|s| (&s.position, &s.geometry)).collect()
        }
    };
    for (index, (position, geometry)) in steps.iter().enumerate() {
        if !tile_point_in_bounds(position, width, height) {
            return Err(PersistenceError::InvalidEntity {
                entity: route.clone(),
                field: SnapshotField::RouteLegs,
                reason: EntityError::InvalidStaticShape,
            });
        }
        let (geo_from, geo_to) = geometry_endpoints(geometry);
        if !world_position_in_bounds(snapshot, &geo_from)
            || !world_position_in_bounds(snapshot, &geo_to)
        {
            return Err(PersistenceError::InvalidEntity {
                entity: route.clone(),
                field: SnapshotField::RouteLegs,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if geo_from != TripPosition::from(**position) {
            return Err(PersistenceError::InvalidEntity {
                entity: route.clone(),
                field: SnapshotField::RouteLegs,
                reason: EntityError::InvalidStaticShape,
            });
        }
        if let Some((next_position, _)) = steps.get(index + 1) {
            if geo_to != TripPosition::from(**next_position) {
                return Err(PersistenceError::InvalidEntity {
                    entity: route.clone(),
                    field: SnapshotField::RouteLegs,
                    reason: EntityError::InvalidStaticShape,
                });
            }
        }
    }
    Ok(())
}

fn tile_point_in_bounds(point: &Point, width: u8, height: u8) -> bool {
    point.x >= 0 && point.y >= 0 && point.x < i32::from(width) && point.y < i32::from(height)
}

fn geometry_endpoints(geometry: &PathGeometry) -> (TripPosition, TripPosition) {
    match geometry {
        PathGeometry::Line { from, to } => (from.clone(), to.clone()),
        PathGeometry::QuadraticBezier { from, to, .. } => (from.clone(), to.clone()),
    }
}

fn validate_vehicles(
    snapshot: &GameSnapshot,
    indexes: &EntityIndexes<'_>,
) -> PersistenceResult<()> {
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
        let line = line_view(indexes, vehicle.mode, &vehicle.line_id);
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
        let expected_capacity = vehicle_capacity(vehicle.mode);
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
            let Some(trip) = indexes.trip(passenger_id) else {
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
    indexes: &'a EntityIndexes<'a>,
    mode: TransitMode,
    line_id: &str,
) -> Option<(&'a [String], &'a [RouteLegPath], &'a [String])> {
    match mode {
        TransitMode::Bus => indexes.route(line_id).map(|route| {
            (
                route.stop_ids.as_slice(),
                route.legs.as_slice(),
                route.vehicle_ids.as_slice(),
            )
        }),
        TransitMode::Metro => indexes.metro_line(line_id).map(|line| {
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

fn entity_ref(kind: EntityKind, id: &str) -> EntityRef {
    EntityRef {
        kind,
        id: id.to_string(),
    }
}
