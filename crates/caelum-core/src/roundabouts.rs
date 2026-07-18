use std::collections::{BTreeSet, HashSet};

use crate::heading::{
    canonical_headings, heading_between, heading_key, heading_rank, offset, opposite,
};
use crate::model::{
    GameMap, GameSnapshot, Heading, MovementKind, PathGeometry, Point, PortDirection, RoadPort,
    RoadStructure, RoundaboutSize, TripPosition,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::road::RoadMutationResult;
use crate::road_topology::{RoadState, RoadTransition, BUS_TILE_MILLIS, ROUNDABOUT_ENTRY_MILLIS};
use crate::transit_nodes::is_present_node;

pub const COMPACT_ROUNDABOUT_COST: i32 = 1_000;
pub const STANDARD_ROUNDABOUT_COST: i32 = 2_000;

const COMPACT_RING: &[(i32, i32)] = &[(1, 1), (1, 0), (0, 0), (0, 1)];
const STANDARD_RING: &[(i32, i32)] = &[
    (2, 2),
    (2, 1),
    (2, 0),
    (1, 0),
    (0, 0),
    (0, 1),
    (0, 2),
    (1, 2),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundaboutTemplate {
    pub size: RoundaboutSize,
    pub origin: Point,
    pub footprint: Vec<Point>,
    pub circulation_tiles: Vec<Point>,
    pub protected_island: Vec<Point>,
    pub counterclockwise_ring: Vec<Point>,
    pub port_slots: Vec<RoadPort>,
}

pub fn roundabout_template(size: RoundaboutSize, origin: Point) -> RoundaboutTemplate {
    match size {
        RoundaboutSize::Compact2x2 => compact_template(origin),
        RoundaboutSize::Standard3x3 => standard_template(origin),
    }
}

pub fn roundabout_structure_id(size: RoundaboutSize, origin: Point) -> String {
    format!(
        "roundabout:{}:{},{}",
        size.stable_id_key(),
        origin.x,
        origin.y
    )
}

pub fn roundabout_cost(size: RoundaboutSize) -> i32 {
    match size {
        RoundaboutSize::Compact2x2 => COMPACT_ROUNDABOUT_COST,
        RoundaboutSize::Standard3x3 => STANDARD_ROUNDABOUT_COST,
    }
}

/// Builds the authoritative geometry used to visualize a roundabout attempt
/// that failed validation. Unlike `place_roundabout`, this helper is tolerant
/// of off-map tiles and unsafe boundary mappings: previews must preserve the
/// attempted footprint and any reciprocal road ports even when the mutation
/// cannot be committed.
///
/// Returns `None` when the origin/size would overflow while building the
/// template (same check as `place_roundabout`), so callers can fall back to an
/// empty attempt visualization.
pub fn attempted_roundabout_structure(
    map: &GameMap,
    origin: Point,
    size: RoundaboutSize,
) -> Option<RoadStructure> {
    validate_roundabout_origin(origin, size).ok()?;
    let template = roundabout_template(size, origin);
    let ports = attempted_boundary_connections(map, &template);
    Some(RoadStructure::Roundabout {
        id: roundabout_structure_id(size, origin),
        origin,
        size,
        footprint: template.footprint,
        ports,
    })
}

pub fn place_roundabout(
    state: &GameSnapshot,
    origin: Point,
    size: RoundaboutSize,
) -> GameplayResult<RoadMutationResult> {
    // Host-sent origins near i32 extremes overflow while building the footprint
    // template; reject before any arithmetic in `translate`.
    validate_roundabout_origin(origin, size)?;
    let template = roundabout_template(size, origin);
    validate_bounds(&state.map, &template.footprint)?;
    validate_replaceable_occupancy(state, &template)?;
    validate_complete_structure_overlap(&state.map, &template)?;
    let captured_ports = capture_boundary_connections(&state.map, &template)?;
    validate_port_mapping(&state.map, &template, &captured_ports)?;
    let cost = roundabout_cost(size);
    if state.budget < cost {
        return Err(GameplayRejection::budget(cost, state.budget));
    }

    let mut candidate = state.clone();
    remove_contained_automatic_junctions(&mut candidate.map, &template);
    install_roundabout(&mut candidate.map, &template, captured_ports);
    candidate.budget -= cost;
    Ok(RoadMutationResult {
        snapshot: candidate,
        changed_tiles: template.footprint,
        skipped_tiles: Vec::new(),
        cost,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemovedRoundabouts {
    pub ids: BTreeSet<String>,
    pub member_points: BTreeSet<Point>,
}

pub fn remove_owned_roundabouts(
    candidate: &mut GameSnapshot,
    points: &[Point],
) -> RemovedRoundabouts {
    let ids: BTreeSet<_> = points
        .iter()
        .filter_map(|point| roundabout_id_at(&candidate.map, *point))
        .collect();
    let member_points = candidate
        .map
        .road_structures
        .iter()
        .filter(|structure| {
            matches!(structure, RoadStructure::Roundabout { .. }) && ids.contains(structure.id())
        })
        .flat_map(|structure| structure.footprint().iter().copied())
        .collect();
    for id in &ids {
        remove_roundabout_structure(&mut candidate.map, id);
    }
    RemovedRoundabouts { ids, member_points }
}

fn validate_bounds(map: &GameMap, footprint: &[Point]) -> GameplayResult<()> {
    if let Some(point) = footprint.iter().find(|point| map.tile(**point).is_none()) {
        let mut rejection = GameplayRejection::at(RejectionCode::OutOfBounds, *point);
        rejection.context.footprint = footprint.to_vec();
        return Err(rejection);
    }
    Ok(())
}

fn validate_replaceable_occupancy(
    state: &GameSnapshot,
    template: &RoundaboutTemplate,
) -> GameplayResult<()> {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    let has_building = state.buildings.iter().any(|building| {
        building
            .occupied_tiles
            .iter()
            .any(|point| footprint.contains(point))
    });
    let has_transit_node = state
        .transit
        .stops
        .iter()
        .any(|stop| is_present_node(stop.status) && footprint.contains(&stop.position))
        || state.transit.stations.iter().any(|station| {
            is_present_node(station.status) && footprint.contains(&station.position)
        });
    let blocked_tile = template.footprint.iter().any(|point| {
        state
            .map
            .tile(*point)
            .is_some_and(|tile| tile.has_track || !matches!(tile.kind.as_str(), "empty" | "road"))
    });
    if has_building || has_transit_node || blocked_tile {
        return Err(blocked_footprint(&template.footprint));
    }
    Ok(())
}

fn validate_complete_structure_overlap(
    map: &GameMap,
    template: &RoundaboutTemplate,
) -> GameplayResult<()> {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    for structure in &map.road_structures {
        let overlaps = structure
            .footprint()
            .iter()
            .any(|point| footprint.contains(point));
        if !overlaps {
            continue;
        }
        let fully_contained = structure
            .footprint()
            .iter()
            .all(|point| footprint.contains(point));
        if !structure.is_automatic_junction() || !fully_contained {
            return Err(blocked_footprint(&template.footprint));
        }
    }
    Ok(())
}

/// A reciprocal boundary connection candidate discovered by scanning the
/// template footprint. Each caller applies its own slot-lookup and
/// one-way-suffix policy to produce a `RoadPort`.
struct BoundaryPortCandidate {
    point: Point,
    edge: Heading,
    external_one_way: Option<Heading>,
}

/// Scan the template footprint for reciprocal boundary road connections.
/// Returns one `BoundaryPortCandidate` per (footprint tile, edge) where the
/// edge leads to an external road tile that reciprocally connects back. This
/// is the shared core of `capture_boundary_connections`,
/// `attempted_boundary_connections`, and `recapture_boundary_ports` — each
/// caller resolves the port slot and one-way suffix with its own strictness.
fn scan_boundary_port_candidates(
    map: &GameMap,
    template: &RoundaboutTemplate,
) -> Vec<BoundaryPortCandidate> {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    let mut candidates = Vec::new();
    for point in &template.footprint {
        let Some(tile) = map.tile(*point) else {
            continue;
        };
        if tile.kind != "road" {
            continue;
        }
        for edge in &tile.road_connections {
            let outside = offset(*point, *edge);
            if footprint.contains(&outside) {
                continue;
            }
            let Some(external) = map.tile(outside).filter(|neighbor| {
                neighbor.kind == "road" && neighbor.road_connections.contains(&opposite(*edge))
            }) else {
                continue;
            };
            candidates.push(BoundaryPortCandidate {
                point: *point,
                edge: *edge,
                external_one_way: external.one_way,
            });
        }
    }
    candidates
}

/// Compute the one-way direction class for a boundary port's external neighbor.
/// Returns `Some(TwoWay | Inbound | Outbound)` for compatible directions, or
/// `None` for an incompatible one-way that the caller must handle (reject,
/// label as incompatible, or skip).
fn boundary_port_direction(
    edge: Heading,
    external_one_way: Option<Heading>,
) -> Option<PortDirection> {
    match external_one_way {
        None => Some(PortDirection::TwoWay),
        Some(direction) if direction == opposite(edge) => Some(PortDirection::Inbound),
        Some(direction) if direction == edge => Some(PortDirection::Outbound),
        Some(_) => None,
    }
}

/// Sort and dedup boundary ports by (point, edge). Shared by all three
/// boundary-port scanners to keep their output ordering identical.
fn sort_and_dedup_ports(ports: &mut Vec<RoadPort>) {
    ports.sort_by_key(|port| (port.point, port.edge, port.id.clone()));
    ports.dedup_by(|left, right| left.point == right.point && left.edge == right.edge);
}

fn capture_boundary_connections(
    map: &GameMap,
    template: &RoundaboutTemplate,
) -> GameplayResult<Vec<RoadPort>> {
    let mut captured = Vec::new();
    for candidate in scan_boundary_port_candidates(map, template) {
        let Some(slot) = template
            .port_slots
            .iter()
            .find(|slot| slot.point == candidate.point && slot.edge == candidate.edge)
        else {
            return Err(unsafe_template_mapping(template));
        };
        let direction = boundary_port_direction(candidate.edge, candidate.external_one_way)
            .ok_or_else(|| unsafe_template_mapping(template))?;
        let mut captured_port = slot.clone();
        captured_port.direction = Some(direction);
        captured.push(captured_port);
    }
    sort_and_dedup_ports(&mut captured);
    Ok(captured)
}

fn attempted_boundary_connections(map: &GameMap, template: &RoundaboutTemplate) -> Vec<RoadPort> {
    let structure_id = roundabout_structure_id(template.size, template.origin);
    let mut captured = Vec::new();
    for candidate in scan_boundary_port_candidates(map, template) {
        let mut port = template
            .port_slots
            .iter()
            .find(|slot| slot.point == candidate.point && slot.edge == candidate.edge)
            .cloned()
            .unwrap_or_else(|| RoadPort {
                id: format!(
                    "{structure_id}:attempted-port:{},{}:{}",
                    candidate.point.x,
                    candidate.point.y,
                    heading_key(candidate.edge)
                ),
                point: candidate.point,
                edge: candidate.edge,
                direction: None,
            });
        port.direction = boundary_port_direction(candidate.edge, candidate.external_one_way);
        captured.push(port);
    }
    sort_and_dedup_ports(&mut captured);
    captured
}

fn validate_port_mapping(
    map: &GameMap,
    template: &RoundaboutTemplate,
    ports: &[RoadPort],
) -> GameplayResult<()> {
    for port in ports {
        let external_point = offset(port.point, port.edge);
        let external = map
            .tile(external_point)
            .ok_or_else(|| unsafe_template_mapping(template))?;
        let compatible = match (port.direction, external.one_way) {
            (Some(PortDirection::TwoWay), None) => true,
            (Some(PortDirection::Inbound), Some(dir)) if dir == opposite(port.edge) => true,
            (Some(PortDirection::Outbound), Some(dir)) if dir == port.edge => true,
            _ => false,
        };
        if !compatible {
            return Err(unsafe_template_mapping(template));
        }
    }
    Ok(())
}

fn remove_contained_automatic_junctions(map: &mut GameMap, template: &RoundaboutTemplate) {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    let removed_ids: HashSet<_> = map
        .road_structures
        .iter()
        .filter(|structure| {
            structure.is_automatic_junction()
                && structure
                    .footprint()
                    .iter()
                    .all(|point| footprint.contains(point))
        })
        .map(|structure| structure.id().to_string())
        .collect();
    map.road_structures
        .retain(|structure| !removed_ids.contains(structure.id()));
}

fn install_roundabout(
    map: &mut GameMap,
    template: &RoundaboutTemplate,
    captured_ports: Vec<RoadPort>,
) {
    let id = roundabout_structure_id(template.size, template.origin);
    for point in &template.footprint {
        let tile = map
            .tile_mut(*point)
            .expect("roundabout footprint was validated");
        tile.kind = if template.circulation_tiles.contains(point) {
            "road".to_string()
        } else {
            "empty".to_string()
        };
        tile.one_way = None;
        tile.road_connections.clear();
        tile.road_structure_id = Some(id.clone());
    }
    for port in &captured_ports {
        map.tile_mut(port.point)
            .expect("captured port belongs to footprint")
            .road_connections
            .push(port.edge);
    }
    for point in &template.footprint {
        if let Some(tile) = map.tile_mut(*point) {
            tile.road_connections.sort();
            tile.road_connections.dedup();
        }
    }
    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin: template.origin,
        size: template.size,
        footprint: template.footprint.clone(),
        ports: captured_ports,
    });
    map.road_structures
        .sort_by(|left, right| left.id().cmp(right.id()));
}

fn roundabout_id_at(map: &GameMap, point: Point) -> Option<String> {
    let id = map.tile(point)?.road_structure_id.as_deref()?;
    map.road_structures
        .iter()
        .find(|structure| {
            matches!(structure, RoadStructure::Roundabout { .. }) && structure.id() == id
        })
        .map(|structure| structure.id().to_string())
}

pub fn is_roundabout_owned(map: &GameMap, point: Point) -> bool {
    roundabout_id_at(map, point).is_some()
}

/// Attach a newly laid approach road tile to a neighboring roundabout port.
///
/// `heading` is the direction from `approach` toward the roundabout-owned tile.
/// Only template port slots accept attachments; structure ownership is preserved.
pub fn attach_approach_to_roundabout(map: &mut GameMap, approach: Point, heading: Heading) {
    let port_point = offset(approach, heading);
    let port_edge = opposite(heading);
    let Some(structure) = map.road_structures.iter().find(|structure| {
        matches!(structure, RoadStructure::Roundabout { .. })
            && structure.footprint().contains(&port_point)
    }) else {
        return;
    };
    let (size, origin) = match structure {
        RoadStructure::Roundabout { size, origin, .. } => (*size, *origin),
        RoadStructure::AutomaticJunction { .. } => return,
    };
    let template = roundabout_template(size, origin);
    if !template
        .port_slots
        .iter()
        .any(|slot| slot.point == port_point && slot.edge == port_edge)
    {
        return;
    }
    let Some(approach_tile) = map.tile(approach) else {
        return;
    };
    if approach_tile.kind != "road" || approach_tile.road_connections.contains(&heading) {
        return;
    }
    let Some(port_tile) = map.tile(port_point) else {
        return;
    };
    if port_tile.kind != "road" {
        return;
    }
    if let Some(tile) = map.tile_mut(approach) {
        tile.road_connections.push(heading);
    }
    if let Some(tile) = map.tile_mut(port_point) {
        if !tile.road_connections.contains(&port_edge) {
            tile.road_connections.push(port_edge);
        }
    }
}

/// Rebuild every roundabout's persisted ports from live reciprocal boundary
/// edges. Call after road mutations that may attach or detach approaches so
/// topology, routing, and rendering share one attachment source of truth.
pub fn sync_roundabout_ports(map: &mut GameMap) {
    let updates: Vec<(String, Vec<RoadPort>)> = map
        .road_structures
        .iter()
        .filter_map(|structure| match structure {
            RoadStructure::Roundabout {
                id, origin, size, ..
            } => {
                let template = roundabout_template(*size, *origin);
                Some((id.clone(), recapture_boundary_ports(map, &template)))
            }
            RoadStructure::AutomaticJunction { .. } => None,
        })
        .collect();
    for (id, ports) in updates {
        if let Some(structure) = map
            .road_structures
            .iter_mut()
            .find(|structure| structure.id() == id)
        {
            match structure {
                RoadStructure::Roundabout {
                    ports: stored_ports,
                    ..
                } => {
                    *stored_ports = ports;
                }
                RoadStructure::AutomaticJunction { .. } => {}
            }
        }
    }
}

fn recapture_boundary_ports(map: &GameMap, template: &RoundaboutTemplate) -> Vec<RoadPort> {
    let mut captured = Vec::new();
    for candidate in scan_boundary_port_candidates(map, template) {
        let Some(slot) = template
            .port_slots
            .iter()
            .find(|slot| slot.point == candidate.point && slot.edge == candidate.edge)
        else {
            continue;
        };
        let Some(direction) = boundary_port_direction(candidate.edge, candidate.external_one_way)
        else {
            continue;
        };
        let mut captured_port = slot.clone();
        captured_port.direction = Some(direction);
        captured.push(captured_port);
    }
    sort_and_dedup_ports(&mut captured);
    captured
}

fn remove_roundabout_structure(map: &mut GameMap, id: &str) {
    let Some(structure) = map
        .road_structures
        .iter()
        .find(|structure| {
            matches!(structure, RoadStructure::Roundabout { .. }) && structure.id() == id
        })
        .cloned()
    else {
        return;
    };
    for point in structure.footprint() {
        let connections = map
            .tile(*point)
            .map(|tile| tile.road_connections.clone())
            .unwrap_or_default();
        for edge in connections {
            if let Some(neighbor) = map.tile_mut(offset(*point, edge)) {
                neighbor
                    .road_connections
                    .retain(|candidate| *candidate != opposite(edge));
            }
        }
        if let Some(tile) = map.tile_mut(*point) {
            tile.kind = "empty".to_string();
            tile.one_way = None;
            tile.road_connections.clear();
            tile.road_structure_id = None;
        }
    }
    map.road_structures.retain(|structure| structure.id() != id);
}

fn blocked_footprint(footprint: &[Point]) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::BlockedFootprint,
        context: RejectionContext {
            footprint: footprint.to_vec(),
            ..RejectionContext::default()
        },
    }
}

fn unsafe_template_mapping(template: &RoundaboutTemplate) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::UnsafeRoundaboutPortMapping,
        context: RejectionContext {
            structure_id: Some(roundabout_structure_id(template.size, template.origin)),
            footprint: template.footprint.clone(),
            ..RejectionContext::default()
        },
    }
}

pub fn compile_roundabout_transitions(
    structure: &RoadStructure,
) -> GameplayResult<Vec<(RoadState, RoadTransition)>> {
    let parts = roundabout_parts(structure)?;
    let template = roundabout_template(parts.size, parts.origin);
    let mut transitions = circulation_edges(parts.id, &template)?;
    for port in parts.captured_ports {
        let Some(canonical_port) = template
            .port_slots
            .iter()
            .find(|slot| slot.point == port.point && slot.edge == port.edge)
        else {
            continue;
        };
        let inbound = match port.direction {
            Some(PortDirection::Inbound) | Some(PortDirection::TwoWay) => true,
            Some(PortDirection::Outbound) => false,
            None => port_accepts_inbound(&template, canonical_port)?,
        };
        let outbound = match port.direction {
            Some(PortDirection::Outbound) | Some(PortDirection::TwoWay) => true,
            Some(PortDirection::Inbound) => false,
            None => port_accepts_outbound(&template, canonical_port)?,
        };
        if inbound {
            transitions.push(entry_transition(parts.id, &template, canonical_port)?);
        }
        if outbound {
            transitions.push(exit_transition(parts.id, &template, canonical_port)?);
        }
    }
    canonicalize_transitions(&mut transitions);
    Ok(transitions)
}

fn compact_template(origin: Point) -> RoundaboutTemplate {
    build_template(RoundaboutSize::Compact2x2, origin, 2, COMPACT_RING, None)
}

fn standard_template(origin: Point) -> RoundaboutTemplate {
    build_template(
        RoundaboutSize::Standard3x3,
        origin,
        3,
        STANDARD_RING,
        Some((1, 1)),
    )
}

fn build_template(
    size: RoundaboutSize,
    origin: Point,
    width: i32,
    ring: &[(i32, i32)],
    protected_offset: Option<(i32, i32)>,
) -> RoundaboutTemplate {
    let footprint: Vec<_> = (0..width)
        .flat_map(|y| (0..width).map(move |x| translate(origin, (x, y))))
        .collect();
    let protected_island: Vec<_> = protected_offset
        .into_iter()
        .map(|offset| translate(origin, offset))
        .collect();
    let circulation_tiles: Vec<_> = footprint
        .iter()
        .copied()
        .filter(|point| !protected_island.contains(point))
        .collect();
    let counterclockwise_ring: Vec<_> = ring
        .iter()
        .copied()
        .map(|offset| translate(origin, offset))
        .collect();
    let port_slots = boundary_port_slots(size, origin, width, &counterclockwise_ring);
    RoundaboutTemplate {
        size,
        origin,
        footprint,
        circulation_tiles,
        protected_island,
        counterclockwise_ring,
        port_slots,
    }
}

fn boundary_port_slots(
    size: RoundaboutSize,
    origin: Point,
    width: i32,
    ring: &[Point],
) -> Vec<RoadPort> {
    let structure_id = roundabout_structure_id(size, origin);
    let mut ports = Vec::new();
    for point in ring {
        for edge in canonical_headings() {
            if edge_is_on_boundary(*point, edge, origin, width) {
                ports.push(RoadPort {
                    id: format!(
                        "{structure_id}:port:{},{}:{}",
                        point.x,
                        point.y,
                        heading_key(edge)
                    ),
                    point: *point,
                    edge,
                    direction: None,
                });
            }
        }
    }
    ports.sort_by_key(|port| (port.point, port.edge));
    ports
}

fn edge_is_on_boundary(point: Point, edge: Heading, origin: Point, width: i32) -> bool {
    match edge {
        Heading::North => point.y == origin.y,
        Heading::East => origin
            .x
            .checked_add(width - 1)
            .is_some_and(|far| point.x == far),
        Heading::South => origin
            .y
            .checked_add(width - 1)
            .is_some_and(|far| point.y == far),
        Heading::West => point.x == origin.x,
    }
}

struct RoundaboutParts<'a> {
    id: &'a str,
    size: RoundaboutSize,
    origin: Point,
    captured_ports: &'a [RoadPort],
}

fn roundabout_parts(structure: &RoadStructure) -> GameplayResult<RoundaboutParts<'_>> {
    match structure {
        RoadStructure::Roundabout {
            id,
            size,
            origin,
            ports,
            ..
        } => Ok(RoundaboutParts {
            id,
            size: *size,
            origin: *origin,
            captured_ports: ports,
        }),
        RoadStructure::AutomaticJunction { id, .. } => Err(unsafe_port_mapping(id)),
    }
}

fn circulation_edges(
    id: &str,
    template: &RoundaboutTemplate,
) -> GameplayResult<Vec<(RoadState, RoadTransition)>> {
    let ring = &template.counterclockwise_ring;
    (0..ring.len())
        .map(|index| {
            let previous = ring[(index + ring.len() - 1) % ring.len()];
            let current = ring[index];
            let next = ring[(index + 1) % ring.len()];
            let incoming = heading_between(previous, current)
                .ok_or_else(|| unsafe_template_mapping(template))?;
            let outgoing =
                heading_between(current, next).ok_or_else(|| unsafe_template_mapping(template))?;
            Ok((
                RoadState {
                    position: current,
                    incoming_heading: incoming,
                },
                RoadTransition {
                    to: RoadState {
                        position: next,
                        incoming_heading: outgoing,
                    },
                    movement: MovementKind::RoundaboutCirculation,
                    geometry: PathGeometry::QuadraticBezier {
                        from: midpoint(previous, current),
                        control: TripPosition::from(current),
                        to: midpoint(current, next),
                    },
                    travel_millis: BUS_TILE_MILLIS,
                    stable_key: format!(
                        "{id}:circulation:{},{}>{},{}",
                        current.x, current.y, next.x, next.y
                    ),
                },
            ))
        })
        .collect()
}

fn entry_transition(
    id: &str,
    template: &RoundaboutTemplate,
    port: &RoadPort,
) -> GameplayResult<(RoadState, RoadTransition)> {
    let (_, next) = ring_neighbors(template, port.point)?;
    let incoming = opposite(port.edge);
    let outgoing =
        heading_between(port.point, next).ok_or_else(|| unsafe_template_mapping(template))?;
    Ok((
        RoadState {
            position: port.point,
            incoming_heading: incoming,
        },
        RoadTransition {
            to: RoadState {
                position: next,
                incoming_heading: outgoing,
            },
            movement: MovementKind::RoundaboutEntry,
            geometry: PathGeometry::Line {
                from: TripPosition::from(port.point),
                to: midpoint(port.point, next),
            },
            travel_millis: BUS_TILE_MILLIS + ROUNDABOUT_ENTRY_MILLIS,
            stable_key: format!("{id}:entry:{}", port.id),
        },
    ))
}

fn exit_transition(
    id: &str,
    template: &RoundaboutTemplate,
    port: &RoadPort,
) -> GameplayResult<(RoadState, RoadTransition)> {
    let (previous, _) = ring_neighbors(template, port.point)?;
    let incoming =
        heading_between(previous, port.point).ok_or_else(|| unsafe_template_mapping(template))?;
    let destination = offset(port.point, port.edge);
    Ok((
        RoadState {
            position: port.point,
            incoming_heading: incoming,
        },
        RoadTransition {
            to: RoadState {
                position: destination,
                incoming_heading: port.edge,
            },
            movement: MovementKind::RoundaboutExit,
            geometry: PathGeometry::QuadraticBezier {
                from: midpoint(previous, port.point),
                control: TripPosition::from(port.point),
                to: TripPosition::from(destination),
            },
            travel_millis: BUS_TILE_MILLIS,
            stable_key: format!("{id}:exit:{}", port.id),
        },
    ))
}

pub(crate) fn port_matches_current_map(map: &GameMap, port: &RoadPort) -> bool {
    let Some(port_tile) = map.tile(port.point) else {
        return false;
    };
    if port_tile.kind != "road" || !port_tile.road_connections.contains(&port.edge) {
        return false;
    }
    let external_point = offset(port.point, port.edge);
    let Some(external) = map.tile(external_point) else {
        return false;
    };
    if external.kind != "road" || !external.road_connections.contains(&opposite(port.edge)) {
        return false;
    }
    // Captured ports carry a typed `direction` encoding the neighbor's one-way
    // direction at capture time. A port without a direction (`None`) falls back
    // to geometry-based acceptance, so only apply the direction check when set.
    match port.direction {
        None => true,
        Some(direction) => match external.one_way {
            None => direction == PortDirection::TwoWay,
            Some(dir) if dir == opposite(port.edge) => direction == PortDirection::Inbound,
            Some(dir) if dir == port.edge => direction == PortDirection::Outbound,
            Some(_) => false,
        },
    }
}

fn port_accepts_inbound(template: &RoundaboutTemplate, port: &RoadPort) -> GameplayResult<bool> {
    let (_, next) = ring_neighbors(template, port.point)?;
    let outgoing =
        heading_between(port.point, next).ok_or_else(|| unsafe_template_mapping(template))?;
    Ok(opposite(port.edge) == outgoing)
}

fn port_accepts_outbound(template: &RoundaboutTemplate, port: &RoadPort) -> GameplayResult<bool> {
    let (previous, _) = ring_neighbors(template, port.point)?;
    let incoming =
        heading_between(previous, port.point).ok_or_else(|| unsafe_template_mapping(template))?;
    Ok(port.edge == incoming)
}

fn ring_neighbors(template: &RoundaboutTemplate, point: Point) -> GameplayResult<(Point, Point)> {
    let ring = &template.counterclockwise_ring;
    let index = ring
        .iter()
        .position(|candidate| *candidate == point)
        .ok_or_else(|| unsafe_template_mapping(template))?;
    Ok((
        ring[(index + ring.len() - 1) % ring.len()],
        ring[(index + 1) % ring.len()],
    ))
}

fn canonicalize_transitions(transitions: &mut Vec<(RoadState, RoadTransition)>) {
    transitions.sort_by(|(left_from, left), (right_from, right)| {
        (
            *left_from,
            heading_rank(left.to.incoming_heading),
            left.stable_key.as_str(),
            left.to,
        )
            .cmp(&(
                *right_from,
                heading_rank(right.to.incoming_heading),
                right.stable_key.as_str(),
                right.to,
            ))
    });
    transitions.dedup_by(|(_, left), (_, right)| left.stable_key == right.stable_key);
}

fn unsafe_port_mapping(structure_id: &str) -> GameplayRejection {
    GameplayRejection {
        code: RejectionCode::UnsafeRoundaboutPortMapping,
        context: RejectionContext {
            structure_id: Some(structure_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

fn size_width(size: RoundaboutSize) -> i32 {
    match size {
        RoundaboutSize::Compact2x2 => 2,
        RoundaboutSize::Standard3x3 => 3,
    }
}

/// Rejects origins whose footprint or exterior neighbors would overflow i32
/// before any template arithmetic runs.
fn validate_roundabout_origin(origin: Point, size: RoundaboutSize) -> GameplayResult<()> {
    let width = size_width(size);
    // Footprint spans origin..(origin+width-1); exterior neighbors reach
    // origin-1 and origin+width.
    let extent_ok = origin.x.checked_add(width).is_some()
        && origin.y.checked_add(width).is_some()
        && origin.x.checked_sub(1).is_some()
        && origin.y.checked_sub(1).is_some();
    if !extent_ok {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, origin));
    }
    Ok(())
}

fn translate(origin: Point, offset: (i32, i32)) -> Point {
    Point {
        x: origin
            .x
            .checked_add(offset.0)
            .expect("roundabout origin must be validated before template construction"),
        y: origin
            .y
            .checked_add(offset.1)
            .expect("roundabout origin must be validated before template construction"),
    }
}

fn midpoint(first: Point, second: Point) -> TripPosition {
    TripPosition {
        x: f64::from(first.x + second.x) / 2.0,
        y: f64::from(first.y + second.y) / 2.0,
    }
}
