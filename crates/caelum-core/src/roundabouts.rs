use crate::model::{
    Heading, MovementKind, PathGeometry, Point, RoadPort, RoadStructure, RoundaboutSize,
    TripPosition,
};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::road_topology::{RoadState, RoadTransition, BUS_TILE_MILLIS, ROUNDABOUT_ENTRY_MILLIS};

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
        let inbound = port_accepts_inbound(&template, canonical_port);
        let outbound = port_accepts_outbound(&template, canonical_port);
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

fn offset(point: Point, heading: Heading) -> Point {
    match heading {
        Heading::North => translate(point, (0, -1)),
        Heading::East => translate(point, (1, 0)),
        Heading::South => translate(point, (0, 1)),
        Heading::West => translate(point, (-1, 0)),
    }
}

fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
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
