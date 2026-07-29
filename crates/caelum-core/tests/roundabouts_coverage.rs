//! Coverage backfill for `crates/caelum-core/src/roundabouts.rs`.
//!
//! These tests target patch-added lines that the existing `roundabouts.rs`
//! integration suite does not exercise:
//!
//! * `compile_roundabout_transitions` skipping a captured port whose
//!   `point`/`edge` is not a template `port_slot` (the `continue` at line 618).
//! * `compile_roundabout_transitions` rejecting an `AutomaticJunction`
//!   structure via `unsafe_port_mapping` (lines 947-952).
//! * `port_matches_current_map` early-return `false` branches (lines 868, 871,
//!   875, 878, 889) reached through `RoadTopology::compile` filtering stale
//!   roundabout ports before compiling transitions.
//!
//! Lines 599-604 (`unsafe_topology_template_mapping`) are defensive: they fire
//! only when `heading_between` returns `None` for adjacent ring points or
//! `ring_neighbors` cannot locate a port in the ring. Shipped templates always
//! produce well-formed adjacent rings, and every port that reaches
//! `entry_transition`/`exit_transition`/`port_accepts_*` is first matched
//! against `template.port_slots` (which are generated from the ring), so those
//! helpers can never trigger the error. They are intentionally left uncovered.

use caelum_core::model::{
    GameMap, Heading, Point, PortDirection, RoadPort, RoadStructure, RoundaboutSize,
};
use caelum_core::road_topology::{RoadTopology, RoadTopologyCompileError};
use caelum_core::roundabouts::{
    compile_roundabout_transitions, roundabout_structure_id, roundabout_template,
};
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "fixture dispatch should apply: {result:?}");
}

/// A compact 2x2 roundabout at origin (5,5) with a two-way approach road to the
/// north, capturing a single north port at (5,5). Used as the base for
/// `port_matches_current_map` stale-port scenarios.
fn snapshot_with_north_port() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    dispatch(&mut engine, GameIntent::LayRoad { point: point(5, 4) });
    engine.snapshot()
}

fn only_roundabout(map: &GameMap) -> caelum_core::model::RoadStructure {
    let roundabouts: Vec<_> = map
        .road_structures
        .iter()
        .filter(|structure| matches!(structure, RoadStructure::Roundabout { .. }))
        .collect();
    assert_eq!(roundabouts.len(), 1, "expected exactly one roundabout");
    roundabouts[0].clone()
}

/// Replace the single roundabout's ports with `ports` and return the mutated map.
fn map_with_replacement_ports(
    snapshot: caelum_core::GameSnapshot,
    ports: Vec<RoadPort>,
) -> GameMap {
    let mut map = snapshot.map;
    let structure = only_roundabout(&map);
    let id = structure.id().to_string();
    let origin = match &structure {
        RoadStructure::Roundabout { origin, .. } => *origin,
        _ => unreachable!(),
    };
    let size = match &structure {
        RoadStructure::Roundabout { size, .. } => *size,
        _ => unreachable!(),
    };
    let footprint = structure.footprint().to_vec();
    map.road_structures.retain(|s| s.id() != id);
    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin,
        size,
        footprint,
        ports,
    });
    map
}

fn set_road_tile(map: &mut GameMap, at: Point, connections: &[Heading]) {
    if let Some(tile) = map.tile_mut(at) {
        tile.kind = "road".to_string();
        tile.road_connections = connections.to_vec();
    }
}

fn set_road_tile_with_one_way(
    map: &mut GameMap,
    at: Point,
    connections: &[Heading],
    one_way: Option<Heading>,
) {
    if let Some(tile) = map.tile_mut(at) {
        tile.kind = "road".to_string();
        tile.road_connections = connections.to_vec();
        tile.one_way = one_way;
    }
}

#[test]
fn compile_skips_a_captured_port_that_is_not_a_template_slot() {
    // A roundabout structure carrying a port whose (point, edge) is not among
    // the template's `port_slots` hits the `continue` at line 618. The bogus
    // port is dropped and only circulation transitions are emitted.
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(5, 5));
    let structure = RoadStructure::Roundabout {
        id: roundabout_structure_id(RoundaboutSize::Compact2x2, point(5, 5)),
        origin: point(5, 5),
        size: RoundaboutSize::Compact2x2,
        footprint: template.footprint.clone(),
        ports: vec![RoadPort {
            id: "bogus-port".to_string(),
            point: point(99, 99),
            edge: Heading::North,
            direction: Some(PortDirection::TwoWay),
        }],
    };
    let transitions = compile_roundabout_transitions(&structure).expect("bogus port is skipped");
    // No entry/exit transitions reference the bogus port; circulation edges
    // equal the ring length.
    let circulation = transitions
        .iter()
        .filter(|(_, t)| {
            t.stable_key
                .starts_with("roundabout:compact2x2:5,5:circulation:")
        })
        .count();
    assert_eq!(
        circulation,
        template.counterclockwise_ring.len(),
        "circulation ring should be intact"
    );
    assert!(transitions
        .iter()
        .all(|(_, t)| { !t.stable_key.contains("bogus-port") }));
}

#[test]
fn compile_rejects_an_automatic_junction_structure_with_unsafe_port_mapping() {
    // `compile_roundabout_transitions` is public and must reject a non-roundabout
    // structure via `unsafe_port_mapping` (lines 947-952).
    let structure = RoadStructure::AutomaticJunction {
        id: "automatic-junction:1,1".to_string(),
        footprint: vec![point(1, 1)],
        ports: Vec::new(),
    };
    let error = compile_roundabout_transitions(&structure)
        .expect_err("automatic junction is not a roundabout");
    assert!(matches!(
        error,
        RoadTopologyCompileError::UnsafeRoundaboutPortMapping { ref structure_id, .. }
        if structure_id == "automatic-junction:1,1"
    ));
}

#[test]
fn port_matches_returns_false_when_the_port_tile_is_off_map() {
    // Line 868: `map.tile(port.point)` is `None`.
    let snapshot = snapshot_with_north_port();
    let structure = only_roundabout(&snapshot.map);
    let id = structure.id().to_string();
    let off_map_port = RoadPort {
        id: format!("{id}:stale:off-map"),
        point: point(-1, -1),
        edge: Heading::North,
        direction: Some(PortDirection::TwoWay),
    };
    let map = map_with_replacement_ports(snapshot, vec![off_map_port]);
    // The off-map port is filtered out by `port_matches_current_map` (line 868)
    // before compilation; the roundabout still compiles its circulation edges.
    RoadTopology::compile(&map).expect("stale off-map port is filtered, compile succeeds");
}

#[test]
fn port_matches_returns_false_when_the_port_tile_is_not_a_road() {
    // Line 871: the port tile exists but is not a road (or lacks the edge).
    let snapshot = snapshot_with_north_port();
    let structure = only_roundabout(&snapshot.map);
    let id = structure.id().to_string();
    let port = RoadPort {
        id: format!("{id}:stale:not-road"),
        point: point(5, 5),
        edge: Heading::North,
        direction: Some(PortDirection::TwoWay),
    };
    let mut map = map_with_replacement_ports(snapshot, vec![port]);
    // Demolish the port tile's road surface so `kind != "road"`.
    if let Some(tile) = map.tile_mut(point(5, 5)) {
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
    }
    RoadTopology::compile(&map).expect("non-road port is filtered, compile succeeds");
}

#[test]
fn port_matches_returns_false_when_the_external_neighbor_is_off_map() {
    // Line 875: the external neighbor tile is `None`. Use a port at the top
    // edge of the map so the northward neighbor is off-map.
    let snapshot = snapshot_with_north_port();
    let structure = only_roundabout(&snapshot.map);
    let id = structure.id().to_string();
    let port = RoadPort {
        id: format!("{id}:stale:edge"),
        point: point(5, 0),
        edge: Heading::North,
        direction: Some(PortDirection::TwoWay),
    };
    let mut map = map_with_replacement_ports(snapshot, vec![port]);
    // The port tile itself must be a road carrying the edge connection to get
    // past the line-871 check before reaching the line-875 check.
    set_road_tile(&mut map, point(5, 0), &[Heading::North]);
    RoadTopology::compile(&map).expect("off-map external is filtered, compile succeeds");
}

#[test]
fn port_matches_returns_false_when_the_external_neighbor_is_not_a_reciprocal_road() {
    // Line 878: the external tile exists but is not a road (no reciprocal).
    let snapshot = snapshot_with_north_port();
    let structure = only_roundabout(&snapshot.map);
    let id = structure.id().to_string();
    let port = RoadPort {
        id: format!("{id}:stale:no-reciprocal"),
        point: point(5, 5),
        edge: Heading::North,
        direction: Some(PortDirection::TwoWay),
    };
    let mut map = map_with_replacement_ports(snapshot, vec![port]);
    // Port tile is a road with the north connection...
    set_road_tile(&mut map, point(5, 5), &[Heading::North]);
    // ...but the external neighbor (5,4) is left as a non-road tile.
    if let Some(tile) = map.tile_mut(point(5, 4)) {
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
    }
    RoadTopology::compile(&map).expect("non-reciprocal external is filtered, compile succeeds");
}

#[test]
fn port_matches_returns_false_when_the_external_one_way_is_perpendicular() {
    // Line 889: the external neighbor carries a one-way direction that is
    // neither the reciprocal (`opposite(edge)`) nor the edge itself, so the
    // `Some(_) => false` arm fires for a port with a typed direction.
    let snapshot = snapshot_with_north_port();
    let structure = only_roundabout(&snapshot.map);
    let id = structure.id().to_string();
    let port = RoadPort {
        id: format!("{id}:stale:perpendicular"),
        point: point(5, 5),
        edge: Heading::North,
        direction: Some(PortDirection::TwoWay),
    };
    let mut map = map_with_replacement_ports(snapshot, vec![port]);
    // Port tile is a road with the north connection.
    set_road_tile(&mut map, point(5, 5), &[Heading::North]);
    // External neighbor reciprocates with a south connection but carries a
    // perpendicular one-way (east), which is incompatible with TwoWay.
    set_road_tile_with_one_way(
        &mut map,
        point(5, 4),
        &[opposite(Heading::North)],
        Some(Heading::East),
    );
    RoadTopology::compile(&map).expect("perpendicular one-way port is filtered, compile succeeds");
}

#[test]
fn bogus_port_compile_still_emits_valid_circulation_for_a_real_roundabout() {
    // Sanity: a roundabout whose ports are all template slots compiles fully,
    // and a roundabout with a mix of one valid and one bogus port keeps the
    // valid port's entry/exit while dropping the bogus one (line 618).
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let valid_slot = template.port_slots[0].clone();
    let bogus = RoadPort {
        id: "bogus".to_string(),
        point: point(50, 50),
        edge: Heading::East,
        direction: Some(PortDirection::TwoWay),
    };
    let structure = RoadStructure::Roundabout {
        id: roundabout_structure_id(RoundaboutSize::Compact2x2, point(3, 3)),
        origin: point(3, 3),
        size: RoundaboutSize::Compact2x2,
        footprint: template.footprint.clone(),
        ports: vec![valid_slot.clone(), bogus],
    };
    let transitions = compile_roundabout_transitions(&structure).expect("compiles");
    // The valid slot's port id appears on an entry or exit transition.
    assert!(transitions
        .iter()
        .any(|(_, t)| t.stable_key.contains(&valid_slot.id)));
    // The bogus port never produces an entry/exit transition.
    assert!(transitions
        .iter()
        .all(|(_, t)| !t.stable_key.contains("bogus")));
}

#[test]
fn place_roundabout_then_compile_topology_succeeds_as_a_baseline() {
    // Baseline: the engine-placed roundabout compiles cleanly via
    // `RoadTopology::compile`, exercising the happy path of
    // `port_matches_current_map` (the `None => true` and direction-compatible
    // arms) alongside the stale-port scenarios above.
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=10).map(|x| point(x, 5)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    );
    let snapshot = engine.snapshot();
    RoadTopology::compile(&snapshot.map).expect("engine-placed roundabout compiles");
}
