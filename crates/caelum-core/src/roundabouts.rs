use std::collections::{BTreeSet, HashSet};

use crate::heading::{offset, opposite};
use crate::model::{
    GameMap, GameSnapshot, Heading, MovementKind, PathGeometry, Point, RoadPort, RoadStructure,
    RoundaboutSize, TripPosition,
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
pub fn attempted_roundabout_structure(
    map: &GameMap,
    origin: Point,
    size: RoundaboutSize,
) -> RoadStructure {
    let template = roundabout_template(size, origin);
    let ports = attempted_boundary_connections(map, &template);
    RoadStructure::Roundabout {
        id: roundabout_structure_id(size, origin),
        origin,
        size,
        footprint: template.footprint,
        ports,
    }
}

pub fn place_roundabout(
    state: &GameSnapshot,
    origin: Point,
    size: RoundaboutSize,
) -> GameplayResult<RoadMutationResult> {
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

fn capture_boundary_connections(
    map: &GameMap,
    template: &RoundaboutTemplate,
) -> GameplayResult<Vec<RoadPort>> {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    let mut captured = Vec::new();
    for point in &template.footprint {
        let tile = map
            .tile(*point)
            .expect("roundabout footprint was validated");
        for edge in &tile.road_connections {
            let outside = offset(*point, *edge);
            if footprint.contains(&outside) {
                continue;
            }
            let reciprocal = map.tile(outside).is_some_and(|neighbor| {
                neighbor.kind == "road" && neighbor.road_connections.contains(&opposite(*edge))
            });
            if !reciprocal {
                continue;
            }
            let Some(slot) = template
                .port_slots
                .iter()
                .find(|slot| slot.point == *point && slot.edge == *edge)
            else {
                return Err(unsafe_template_mapping(template));
            };
            let mut captured_port = slot.clone();
            let external = map
                .tile(outside)
                .expect("reciprocal boundary connection has an external tile");
            captured_port.id.push_str(match external.one_way {
                None => ":twoWay",
                Some(direction) if direction == opposite(*edge) => ":inbound",
                Some(direction) if direction == *edge => ":outbound",
                Some(_) => return Err(unsafe_template_mapping(template)),
            });
            captured.push(captured_port);
        }
    }
    captured.sort_by_key(|port| (port.point, port.edge, port.id.clone()));
    captured.dedup_by(|left, right| left.point == right.point && left.edge == right.edge);
    Ok(captured)
}

fn attempted_boundary_connections(map: &GameMap, template: &RoundaboutTemplate) -> Vec<RoadPort> {
    let footprint: HashSet<_> = template.footprint.iter().copied().collect();
    let structure_id = roundabout_structure_id(template.size, template.origin);
    let mut captured = Vec::new();
    for point in &template.footprint {
        let Some(tile) = map.tile(*point) else {
            continue;
        };
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
            let mut port = template
                .port_slots
                .iter()
                .find(|slot| slot.point == *point && slot.edge == *edge)
                .cloned()
                .unwrap_or_else(|| RoadPort {
                    id: format!(
                        "{structure_id}:attempted-port:{},{}:{}",
                        point.x,
                        point.y,
                        heading_key(*edge)
                    ),
                    point: *point,
                    edge: *edge,
                });
            port.id.push_str(match external.one_way {
                None => ":twoWay",
                Some(direction) if direction == opposite(*edge) => ":inbound",
                Some(direction) if direction == *edge => ":outbound",
                Some(_) => ":incompatible",
            });
            captured.push(port);
        }
    }
    captured.sort_by_key(|port| (port.point, port.edge, port.id.clone()));
    captured.dedup_by(|left, right| left.point == right.point && left.edge == right.edge);
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
        let compatible = match external.one_way {
            None => port.id.ends_with(":twoWay"),
            Some(direction) if direction == opposite(port.edge) => port.id.ends_with(":inbound"),
            Some(direction) if direction == port.edge => port.id.ends_with(":outbound"),
            Some(_) => false,
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
    let mut transitions = circulation_edges(parts.id, &template);
    for port in parts.captured_ports {
        let Some(canonical_port) = template
            .port_slots
            .iter()
            .find(|slot| slot.point == port.point && slot.edge == port.edge)
        else {
            continue;
        };
        let inbound = port.id.ends_with(":inbound")
            || port.id.ends_with(":twoWay")
            || (!port.id.ends_with(":outbound") && port_accepts_inbound(&template, canonical_port));
        let outbound = port.id.ends_with(":outbound")
            || port.id.ends_with(":twoWay")
            || (!port.id.ends_with(":inbound") && port_accepts_outbound(&template, canonical_port));
        if inbound {
            transitions.push(entry_transition(parts.id, &template, canonical_port));
        }
        if outbound {
            transitions.push(exit_transition(parts.id, &template, canonical_port));
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
        Heading::East => point.x == origin.x + width - 1,
        Heading::South => point.y == origin.y + width - 1,
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

fn circulation_edges(id: &str, template: &RoundaboutTemplate) -> Vec<(RoadState, RoadTransition)> {
    let ring = &template.counterclockwise_ring;
    (0..ring.len())
        .map(|index| {
            let previous = ring[(index + ring.len() - 1) % ring.len()];
            let current = ring[index];
            let next = ring[(index + 1) % ring.len()];
            let incoming = heading_between(previous, current);
            let outgoing = heading_between(current, next);
            (
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
            )
        })
        .collect()
}

fn entry_transition(
    id: &str,
    template: &RoundaboutTemplate,
    port: &RoadPort,
) -> (RoadState, RoadTransition) {
    let (_, next) = ring_neighbors(template, port.point);
    let incoming = opposite(port.edge);
    let outgoing = heading_between(port.point, next);
    (
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
    )
}

fn exit_transition(
    id: &str,
    template: &RoundaboutTemplate,
    port: &RoadPort,
) -> (RoadState, RoadTransition) {
    let (previous, _) = ring_neighbors(template, port.point);
    let incoming = heading_between(previous, port.point);
    let destination = offset(port.point, port.edge);
    (
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
    )
}

fn port_accepts_inbound(template: &RoundaboutTemplate, port: &RoadPort) -> bool {
    let (_, next) = ring_neighbors(template, port.point);
    opposite(port.edge) == heading_between(port.point, next)
}

fn port_accepts_outbound(template: &RoundaboutTemplate, port: &RoadPort) -> bool {
    let (previous, _) = ring_neighbors(template, port.point);
    port.edge == heading_between(previous, port.point)
}

fn ring_neighbors(template: &RoundaboutTemplate, point: Point) -> (Point, Point) {
    let ring = &template.counterclockwise_ring;
    let index = ring
        .iter()
        .position(|candidate| *candidate == point)
        .expect("canonical roundabout port belongs to the circulation ring");
    (
        ring[(index + ring.len() - 1) % ring.len()],
        ring[(index + 1) % ring.len()],
    )
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

fn translate(origin: Point, offset: (i32, i32)) -> Point {
    Point {
        x: origin.x + offset.0,
        y: origin.y + offset.1,
    }
}

fn midpoint(first: Point, second: Point) -> TripPosition {
    TripPosition {
        x: f64::from(first.x + second.x) / 2.0,
        y: f64::from(first.y + second.y) / 2.0,
    }
}

fn heading_between(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => unreachable!("roundabout ring points must be adjacent: {delta:?}"),
    }
}

fn canonical_headings() -> [Heading; 4] {
    [Heading::North, Heading::East, Heading::South, Heading::West]
}

fn heading_rank(heading: Heading) -> u8 {
    match heading {
        Heading::North => 0,
        Heading::East => 1,
        Heading::South => 2,
        Heading::West => 3,
    }
}

fn heading_key(heading: Heading) -> &'static str {
    match heading {
        Heading::North => "north",
        Heading::East => "east",
        Heading::South => "south",
        Heading::West => "west",
    }
}
