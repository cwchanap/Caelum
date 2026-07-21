use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use crate::heading::{
    canonical_headings, heading_key, heading_rank, offset, offset_components, opposite,
};
use crate::model::{
    GameMap, Heading, MovementKind, PathGeometry, Point, RoadPathStep, RoadStructure, TransitPath,
    TripPosition,
};
use crate::rejection::GameplayResult;
use crate::roundabouts::compile_roundabout_transitions;

pub const BUS_TILE_MILLIS: u32 = 1_250;
pub const RIGHT_TURN_MILLIS: u32 = 500;
pub const LEFT_TURN_MILLIS: u32 = 1_000;
pub const U_TURN_MILLIS: u32 = 2_000;
pub const ROUNDABOUT_ENTRY_MILLIS: u32 = 750;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct RoadState {
    pub position: Point,
    pub incoming_heading: Heading,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoadTransition {
    pub to: RoadState,
    pub movement: MovementKind,
    pub geometry: PathGeometry,
    pub travel_millis: u32,
    pub stable_key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoadTopology {
    transitions: BTreeMap<RoadState, Vec<RoadTransition>>,
}

impl RoadTopology {
    /// An empty topology with no transitions. Used as a panic-free fallback
    /// when `compile` fails on a snapshot that is expected to be trivially
    /// compilable (e.g. the initial/reset snapshot, which carries no roads or
    /// road structures). A `debug_assert!` at the call site catches the
    /// unexpected failure during development; in release builds the engine
    /// degrades gracefully instead of poisoning a host `Mutex` via a panic.
    pub fn empty() -> Self {
        Self {
            transitions: BTreeMap::new(),
        }
    }

    pub fn compile(map: &GameMap) -> GameplayResult<Self> {
        let ordinary = compile_reciprocal_lane_transitions(map)?;
        let structures = compile_structure_transitions(map)?;
        Ok(Self {
            transitions: merge_and_canonicalize(ordinary, structures),
        })
    }

    pub fn find_path(&self, map: &GameMap, from: &Point, to: &Point) -> Option<TransitPath> {
        deterministic_dijkstra(self, map, from, to)
    }

    pub fn find_terminal_reversal(
        &self,
        terminal: Point,
        previous_exit_heading: Heading,
        next_required_entry_heading: Heading,
    ) -> Option<TransitPath> {
        let start = RoadState {
            position: terminal,
            incoming_heading: previous_exit_heading,
        };
        let goal = RoadState {
            position: terminal,
            incoming_heading: next_required_entry_heading,
        };

        // Same heading in and out: no reversal needed (e.g., one-way roads
        // where the return path naturally continues in the same direction).
        if start == goal {
            return Some(TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            });
        }

        // Direct U-turn at the terminal: ordinary lane U-turns end on the
        // neighbor tile (`transition.to.position`), so reuse the transition's
        // cost/headings but keep `RoadPathStep.position` as the service anchor
        // (the terminal), not the transition's to.position — avoids a backward
        // jump when the next service leg resumes. Dead-end terminals have no
        // multi-step path that returns with the reversed heading.
        if let Some(transition) = self.transition_for(start, next_required_entry_heading) {
            if transition.movement == MovementKind::UTurn {
                let travel_seconds = f64::from(transition.travel_millis) / 1_000.0;
                return Some(TransitPath::Road {
                    steps: vec![RoadPathStep {
                        position: terminal,
                        entering_heading: previous_exit_heading,
                        leaving_heading: next_required_entry_heading,
                        movement: MovementKind::UTurn,
                        geometry: in_place_uturn_geometry(terminal, previous_exit_heading),
                        travel_seconds,
                    }],
                    total_travel_seconds: travel_seconds,
                });
            }
        }

        // Multi-step reversal: Dijkstra over the finite (tile × heading)
        // state space (e.g. entry → circulation → exit through a roundabout
        // when no direct U-turn exists).
        self.find_reversal_path(start, goal)
    }

    /// Route a terminal reversal between two distinct road access tiles — the
    /// actual arrival tile (from the previous service leg) and the actual
    /// departure tile (from the next service leg). Unlike
    /// `find_terminal_reversal`, this never returns a zero-step path when the
    /// tiles differ: the bus must physically travel from `from` to `to`.
    /// Used when an off-road terminal has separate arrival and departure
    /// access lanes.
    pub fn find_reversal_between(
        &self,
        from: Point,
        from_heading: Heading,
        to: Point,
        to_heading: Heading,
    ) -> Option<TransitPath> {
        let start = RoadState {
            position: from,
            incoming_heading: from_heading,
        };
        let goal = RoadState {
            position: to,
            incoming_heading: to_heading,
        };
        // Degenerate: same tile and same heading — no movement needed. This
        // only arises when from == to; callers dispatch same-tile reversals
        // through `find_terminal_reversal` instead, but guard anyway.
        if start == goal {
            return Some(TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            });
        }
        self.find_reversal_path(start, goal)
    }

    #[doc(hidden)]
    pub fn transition_for(&self, from: RoadState, outgoing: Heading) -> Option<&RoadTransition> {
        self.transitions
            .get(&from)?
            .iter()
            .find(|transition| transition.to.incoming_heading == outgoing)
    }

    #[doc(hidden)]
    pub fn contains_ordinary_state(&self, point: Point) -> bool {
        self.transitions.keys().any(|state| state.position == point)
    }

    /// Dijkstra from `start` to `goal` within the road topology, accepting
    /// any non-empty path (at least one transition). Used for multi-step
    /// terminal reversals (e.g., through a roundabout). The state space is
    /// finite (`RoadState` = tile × heading), so the search self-terminates
    /// without an artificial step cap that would false-negative long loops.
    fn find_reversal_path(&self, start: RoadState, goal: RoadState) -> Option<TransitPath> {
        let mut best: BTreeMap<RoadState, PathRank> = BTreeMap::new();
        let mut parents: BTreeMap<RoadState, (RoadState, RoadTransition)> = BTreeMap::new();
        let mut heap = BinaryHeap::new();

        let start_rank = PathRank::zero();
        best.insert(start, start_rank.clone());
        heap.push(Reverse((start_rank, start)));

        while let Some(Reverse((rank, state))) = heap.pop() {
            if best.get(&state) != Some(&rank) {
                continue;
            }

            // Goal: reached the goal state with at least one transition.
            if state == goal && rank.movement_count > 0 {
                return Some(build_road_path(state, rank.total_millis, &parents));
            }

            for transition in self.transitions.get(&state).into_iter().flatten() {
                let next_rank = rank.with_transition(transition);
                let should_update = best
                    .get(&transition.to)
                    .map_or(true, |existing| next_rank < *existing);
                if !should_update {
                    continue;
                }
                best.insert(transition.to, next_rank.clone());
                parents.insert(transition.to, (state, transition.clone()));
                heap.push(Reverse((next_rank, transition.to)));
            }
        }
        None
    }
}

impl RoadTransition {
    pub fn base_travel_millis(&self) -> u32 {
        self.travel_millis
            .saturating_sub(movement_extra_millis(self.movement))
    }
}

pub fn movement_extra_millis(movement: MovementKind) -> u32 {
    match movement {
        MovementKind::Straight
        | MovementKind::RoundaboutCirculation
        | MovementKind::RoundaboutExit => 0,
        MovementKind::RightTurn => RIGHT_TURN_MILLIS,
        MovementKind::LeftTurn => LEFT_TURN_MILLIS,
        MovementKind::UTurn => U_TURN_MILLIS,
        MovementKind::RoundaboutEntry => ROUNDABOUT_ENTRY_MILLIS,
    }
}

type CompiledTransition = (RoadState, RoadTransition);

fn compile_reciprocal_lane_transitions(map: &GameMap) -> GameplayResult<Vec<CompiledTransition>> {
    let mut compiled = Vec::new();
    for tile in &map.tiles {
        if tile.kind != "road" || tile.road_structure_id.is_some() {
            continue;
        }
        let position = Point {
            x: tile.x,
            y: tile.y,
        };
        for incoming in canonical_headings() {
            if !lane_accepts(tile.one_way, incoming) {
                continue;
            }
            for outgoing in canonical_headings() {
                if !tile.road_connections.contains(&outgoing)
                    || !lane_accepts(tile.one_way, outgoing)
                {
                    continue;
                }
                let destination = offset(position, outgoing);
                let Some(destination_tile) = map.tile(destination) else {
                    continue;
                };
                if destination_tile.kind != "road"
                    || !destination_tile
                        .road_connections
                        .contains(&opposite(outgoing))
                    || !lane_accepts(destination_tile.one_way, outgoing)
                {
                    continue;
                }
                let movement = classify_movement(incoming, outgoing);
                let from = RoadState {
                    position,
                    incoming_heading: incoming,
                };
                compiled.push((
                    from,
                    RoadTransition {
                        to: RoadState {
                            position: destination,
                            incoming_heading: outgoing,
                        },
                        movement,
                        geometry: transition_geometry(position, incoming, destination, outgoing),
                        travel_millis: BUS_TILE_MILLIS + movement_extra_millis(movement),
                        stable_key: format!(
                            "ordinary:{},{}:{}>{}:{}",
                            position.x,
                            position.y,
                            heading_key(incoming),
                            heading_key(outgoing),
                            destination_tile.id
                        ),
                    },
                ));
            }
        }
    }
    Ok(compiled)
}

fn compile_structure_transitions(map: &GameMap) -> GameplayResult<Vec<CompiledTransition>> {
    let mut structures: Vec<_> = map.road_structures.iter().collect();
    structures.sort_by(|left, right| left.id().cmp(right.id()));
    let mut compiled = Vec::new();

    for structure in structures {
        match structure {
            RoadStructure::AutomaticJunction { .. } => {
                compiled.extend(compile_automatic_junction_transitions(map, structure)?);
            }
            RoadStructure::Roundabout {
                id,
                origin,
                size,
                footprint,
                ports,
            } => {
                // Captured ports snapshot the neighboring boundary road's
                // reciprocal connection and one-way direction at placement
                // time. If that neighbor is later demolished or its one-way
                // direction is cycled, the stored port suffix is stale and
                // must not emit entry/exit transitions through a disconnected
                // or re-oriented edge. Filter to ports that still match the
                // live map before compiling, mirroring the per-port
                // revalidation `compile_automatic_junction_transitions`
                // performs internally.
                let current_ports: Vec<_> = ports
                    .iter()
                    .filter(|port| crate::roundabouts::port_matches_current_map(map, port))
                    .cloned()
                    .collect();
                let filtered = RoadStructure::Roundabout {
                    id: id.clone(),
                    origin: *origin,
                    size: *size,
                    footprint: footprint.clone(),
                    ports: current_ports,
                };
                compiled.extend(compile_roundabout_transitions(&filtered)?);
            }
        }
    }
    Ok(compiled)
}

fn compile_automatic_junction_transitions(
    map: &GameMap,
    structure: &RoadStructure,
) -> GameplayResult<Vec<CompiledTransition>> {
    let mut compiled = Vec::new();
    let mut ports: Vec<_> = structure.ports().iter().collect();
    ports.sort_by(|left, right| {
        (left.point, left.edge, left.id.as_str()).cmp(&(right.point, right.edge, right.id.as_str()))
    });
    for entry in &ports {
        let incoming = opposite(entry.edge);
        let Some(entry_port_tile) = map.tile(entry.point) else {
            continue;
        };
        if entry_port_tile.kind != "road" || !entry_port_tile.road_connections.contains(&entry.edge)
        {
            continue;
        }
        let entry_outside = offset(entry.point, entry.edge);
        let Some(entry_tile) = map.tile(entry_outside) else {
            continue;
        };
        if entry_tile.kind != "road"
            || !entry_tile.road_connections.contains(&opposite(entry.edge))
            || !lane_accepts(entry_tile.one_way, incoming)
        {
            continue;
        }

        for exit in &ports {
            let outgoing = exit.edge;
            let Some(exit_port_tile) = map.tile(exit.point) else {
                continue;
            };
            if exit_port_tile.kind != "road" || !exit_port_tile.road_connections.contains(&outgoing)
            {
                continue;
            }
            let exit_outside = offset(exit.point, outgoing);
            let Some(exit_tile) = map.tile(exit_outside) else {
                continue;
            };
            if exit_tile.kind != "road"
                || !exit_tile.road_connections.contains(&opposite(outgoing))
                || !lane_accepts(exit_tile.one_way, outgoing)
            {
                continue;
            }

            let movement = classify_movement(incoming, outgoing);
            let structure_tiles =
                entry.point.x.abs_diff(exit.point.x) + entry.point.y.abs_diff(exit.point.y) + 1;
            let base_millis = BUS_TILE_MILLIS.saturating_mul(structure_tiles);
            compiled.push((
                RoadState {
                    position: entry.point,
                    incoming_heading: incoming,
                },
                RoadTransition {
                    to: RoadState {
                        position: exit_outside,
                        incoming_heading: outgoing,
                    },
                    movement,
                    geometry: transition_geometry(entry.point, incoming, exit_outside, outgoing),
                    travel_millis: base_millis + movement_extra_millis(movement),
                    stable_key: format!(
                        "structure:{}:{}>{}:{}:{}",
                        structure.id(),
                        entry.id,
                        exit.id,
                        heading_key(outgoing),
                        exit_tile.id
                    ),
                },
            ));
        }
    }
    Ok(compiled)
}

fn merge_and_canonicalize(
    ordinary: Vec<CompiledTransition>,
    structures: Vec<CompiledTransition>,
) -> BTreeMap<RoadState, Vec<RoadTransition>> {
    let mut transitions: BTreeMap<RoadState, Vec<RoadTransition>> = BTreeMap::new();
    for (from, transition) in ordinary.into_iter().chain(structures) {
        transitions.entry(from).or_default().push(transition);
    }
    for outgoing in transitions.values_mut() {
        outgoing.sort_by(|left, right| {
            (
                heading_rank(left.to.incoming_heading),
                left.stable_key.as_str(),
                left.to,
            )
                .cmp(&(
                    heading_rank(right.to.incoming_heading),
                    right.stable_key.as_str(),
                    right.to,
                ))
        });
        outgoing.dedup_by(|left, right| left.stable_key == right.stable_key);
    }
    transitions
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct PathRank {
    total_millis: u64,
    movement_count: u32,
    direction_key: Vec<u8>,
    stable_keys: Vec<String>,
}

impl PathRank {
    fn zero() -> Self {
        Self {
            total_millis: 0,
            movement_count: 0,
            direction_key: Vec::new(),
            stable_keys: Vec::new(),
        }
    }

    fn with_transition(&self, transition: &RoadTransition) -> Self {
        let mut next = self.clone();
        next.total_millis += u64::from(transition.travel_millis);
        next.movement_count += 1;
        next.direction_key
            .push(heading_rank(transition.to.incoming_heading));
        next.stable_keys.push(transition.stable_key.clone());
        next
    }
}

fn deterministic_dijkstra(
    topology: &RoadTopology,
    map: &GameMap,
    from: &Point,
    to: &Point,
) -> Option<TransitPath> {
    map.tile(*from)?;
    map.tile(*to)?;
    if from == to {
        return Some(TransitPath::Road {
            steps: Vec::new(),
            total_travel_seconds: 0.0,
        });
    }

    let starts = start_states(topology, map, *from);
    if starts.is_empty() {
        return None;
    }
    let target_is_road = is_road(map, *to);
    let mut best = BTreeMap::new();
    let mut parents: BTreeMap<RoadState, (RoadState, RoadTransition)> = BTreeMap::new();
    let mut heap = BinaryHeap::new();

    for state in starts {
        let rank = PathRank::zero();
        let should_insert = best
            .get(&state)
            .map_or(true, |existing: &PathRank| rank < *existing);
        if should_insert {
            best.insert(state, rank.clone());
            heap.push(Reverse((rank, state)));
        }
    }

    while let Some(Reverse((rank, state))) = heap.pop() {
        if best.get(&state) != Some(&rank) {
            continue;
        }
        // Require at least one road transition before accepting the goal. The
        // start states for an off-road endpoint are seeded at adjacent road
        // access tiles with `PathRank::zero()`; without this guard, a target
        // that is manhattan-1 from a seeded access tile (or that IS the
        // seeded tile, for an on-road target) would be accepted on the first
        // pop with empty parents, producing a connected, zero-duration,
        // zero-step service leg. The bus must physically enter the road
        // network before the endpoint is reached. Mirrors the
        // `movement_count > 0` guard in `find_reversal_path`.
        if rank.movement_count > 0 {
            if target_is_road && state.position == *to {
                return Some(build_road_path(state, rank.total_millis, &parents));
            }
            if !target_is_road && manhattan(state.position, *to) == 1 {
                return Some(build_road_path(state, rank.total_millis, &parents));
            }
        }

        for transition in topology.transitions.get(&state).into_iter().flatten() {
            let next_rank = rank.with_transition(transition);
            let should_update = best
                .get(&transition.to)
                .map_or(true, |existing| next_rank < *existing);
            if !should_update {
                continue;
            }
            best.insert(transition.to, next_rank.clone());
            parents.insert(transition.to, (state, transition.clone()));
            heap.push(Reverse((next_rank, transition.to)));
        }
    }
    None
}

fn start_states(topology: &RoadTopology, map: &GameMap, from: Point) -> Vec<RoadState> {
    if is_road(map, from) {
        return road_start_states(topology, from);
    }

    let mut starts = Vec::new();
    for heading in canonical_headings() {
        let adjacent = offset(from, heading);
        if !is_road(map, adjacent) {
            continue;
        }
        starts.extend(road_start_states(topology, adjacent));
    }
    starts.sort();
    starts.dedup();
    starts
}

fn road_start_states(topology: &RoadTopology, position: Point) -> Vec<RoadState> {
    let mut states: Vec<_> = topology
        .transitions
        .iter()
        .filter_map(|(state, transitions)| {
            (state.position == position
                && transitions.iter().any(|transition| {
                    transition.to.incoming_heading == state.incoming_heading
                        && transition.movement == MovementKind::Straight
                }))
            .then_some(*state)
        })
        .collect();
    if states.is_empty() {
        states.extend(
            topology
                .transitions
                .keys()
                .filter(|state| state.position == position)
                .copied(),
        );
    }
    states.sort_by_key(|state| heading_rank(state.incoming_heading));
    states.dedup();
    states
}

fn build_road_path(
    goal: RoadState,
    total_millis: u64,
    parents: &BTreeMap<RoadState, (RoadState, RoadTransition)>,
) -> TransitPath {
    let mut cursor = goal;
    let mut reversed = Vec::new();
    while let Some((parent, transition)) = parents.get(&cursor) {
        reversed.push((*parent, transition.clone()));
        cursor = *parent;
    }
    reversed.reverse();

    let steps = reversed
        .into_iter()
        .map(|(from, transition)| RoadPathStep {
            position: from.position,
            entering_heading: from.incoming_heading,
            leaving_heading: transition.to.incoming_heading,
            movement: transition.movement,
            geometry: transition.geometry,
            travel_seconds: f64::from(transition.travel_millis) / 1_000.0,
        })
        .collect();
    TransitPath::Road {
        steps,
        total_travel_seconds: total_millis as f64 / 1_000.0,
    }
}

fn transition_geometry(
    from: Point,
    incoming: Heading,
    to: Point,
    outgoing: Heading,
) -> PathGeometry {
    let movement = classify_movement(incoming, outgoing);
    let from_position = TripPosition::from(from);
    let to_position = TripPosition::from(to);
    match movement {
        MovementKind::Straight => PathGeometry::Line {
            from: from_position,
            to: to_position,
        },
        MovementKind::RightTurn | MovementKind::LeftTurn => {
            let (incoming_dx, incoming_dy) = offset_components(incoming);
            PathGeometry::QuadraticBezier {
                from: from_position,
                control: TripPosition {
                    x: f64::from(from.x) + f64::from(incoming_dx) * 0.5,
                    y: f64::from(from.y) + f64::from(incoming_dy) * 0.5,
                },
                to: to_position,
            }
        }
        MovementKind::UTurn => {
            // The control point bows the curve to the LEFT of the incoming
            // heading. `(dy, -dx)` is the left perpendicular of the incoming
            // direction `(dx, dy)` in screen coordinates (+x east, +y south),
            // and the `+ 0.5 * (dx, dy)` term nudges it half a tile forward so
            // the bezier apex sits ahead of `from` rather than directly beside
            // it. This keeps every U-turn curve on the same side regardless of
            // heading.
            let (dx, dy) = offset_components(incoming);
            PathGeometry::QuadraticBezier {
                from: from_position,
                control: TripPosition {
                    x: f64::from(from.x + dy) + f64::from(dx) * 0.5,
                    y: f64::from(from.y - dx) + f64::from(dy) * 0.5,
                },
                to: to_position,
            }
        }
        MovementKind::RoundaboutEntry
        | MovementKind::RoundaboutCirculation
        | MovementKind::RoundaboutExit => PathGeometry::Line {
            from: from_position,
            to: to_position,
        },
    }
}

/// Terminal-reversal U-turn that stays on the terminal tile. Same left-bow
/// control as ordinary U-turns, but both endpoints are the terminal so vehicle
/// progress ends where the next service leg begins.
fn in_place_uturn_geometry(terminal: Point, incoming: Heading) -> PathGeometry {
    let (dx, dy) = offset_components(incoming);
    let at = TripPosition::from(terminal);
    PathGeometry::QuadraticBezier {
        from: at.clone(),
        control: TripPosition {
            x: f64::from(terminal.x + dy) + f64::from(dx) * 0.5,
            y: f64::from(terminal.y - dx) + f64::from(dy) * 0.5,
        },
        to: at,
    }
}

fn classify_movement(incoming: Heading, outgoing: Heading) -> MovementKind {
    // The expression is `% 4`, so it is always in `0..=3`. The wildcard arm
    // covers `3` (LeftTurn) and any hypothetical out-of-range value from a
    // future regression, classifying it as a left turn instead of panicking
    // under the Tauri Mutex.
    match (heading_rank(outgoing) + 4 - heading_rank(incoming)) % 4 {
        0 => MovementKind::Straight,
        1 => MovementKind::RightTurn,
        2 => MovementKind::UTurn,
        _ => MovementKind::LeftTurn,
    }
}

fn lane_accepts(one_way: Option<Heading>, heading: Heading) -> bool {
    one_way.map_or(true, |allowed| allowed == heading)
}

fn is_road(map: &GameMap, point: Point) -> bool {
    map.tile(point).is_some_and(|tile| tile.kind == "road")
}

fn manhattan(first: Point, second: Point) -> u32 {
    first.x.abs_diff(second.x) + first.y.abs_diff(second.y)
}
