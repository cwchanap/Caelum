#![allow(deprecated)]

//! Integration tests that backfill code coverage for patch-added and
//! defensive branches in `crates/caelum-core/src/road_topology.rs`.
//!
//! These tests exercise:
//! - `From<RoadTopologyCompileError> for GameplayRejection` (the
//!   `UnsafeRoundaboutPortMapping` conversion).
//! - `continue` branches in `compile_reciprocal_lane_transitions` and
//!   `compile_automatic_junction_transitions` when port/destination tiles are
//!   off-map or missing.
//! - `deterministic_dijkstra` early returns (same-tile shortcut, empty start
//!   set).
//! - `deterministic_access_tile_dijkstra` off-map endpoint rejections.
//!
//! `transition_geometry`'s `RoundaboutEntry | RoundaboutCirculation |
//! RoundaboutExit` arm is genuinely unreachable through the public API:
//! `transition_geometry` is only called from
//! `compile_reciprocal_lane_transitions` and
//! `compile_automatic_junction_transitions`, both of which classify movements
//! via `classify_movement`, which never produces a `Roundabout*` variant.
//! Roundabout transitions build their geometry directly in `roundabouts.rs`.

use caelum_core::model::{
    GameMap, Heading, LegFailureReason, Point, RoadPort, RoadStructure, Tile, TransitPath,
};
use caelum_core::rejection::{GameplayRejection, RejectionCode};
use caelum_core::road_topology::{RoadTopology, RoadTopologyCompileError};
use caelum_core::roundabouts::compile_roundabout_transitions;

// ---------------------------------------------------------------------------
// Fixture helpers (mirroring `tests/road_topology.rs` so this file stays
// self-contained).
// ---------------------------------------------------------------------------

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn blank_map(width: u8, height: u8) -> GameMap {
    let tiles = (0..i32::from(height))
        .flat_map(|y| {
            (0..i32::from(width)).map(move |x| Tile {
                id: format!("tile-{x}-{y}"),
                x,
                y,
                kind: "empty".to_string(),
                area: None,
                has_track: false,
                one_way: None,
                road_connections: Vec::new(),
                road_structure_id: None,
            })
        })
        .collect();
    GameMap {
        width,
        height,
        tiles,
        road_structures: Vec::new(),
    }
}

fn heading_between(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
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

fn road(map: &mut GameMap, position: Point, one_way: Option<Heading>) {
    let tile = map.tile_mut(position).expect("fixture road is in bounds");
    tile.kind = "road".to_string();
    tile.one_way = one_way;
}

fn connect(map: &mut GameMap, first: Point, second: Point) {
    let heading = heading_between(first, second);
    road(map, first, map.tile(first).and_then(|tile| tile.one_way));
    road(map, second, map.tile(second).and_then(|tile| tile.one_way));
    map.tile_mut(first).unwrap().road_connections.push(heading);
    map.tile_mut(second)
        .unwrap()
        .road_connections
        .push(opposite(heading));
}

fn corridor(map: &mut GameMap, points: &[Point], one_way: Option<Heading>) {
    for position in points {
        road(map, *position, one_way);
    }
    for pair in points.windows(2) {
        connect(map, pair[0], pair[1]);
    }
}

fn automatic_junction(
    map: &mut GameMap,
    id: &str,
    footprint: Vec<Point>,
    port_keys: &[(Point, Heading)],
) {
    for position in &footprint {
        road(map, *position, None);
        map.tile_mut(*position).unwrap().road_structure_id = Some(id.to_string());
    }
    let ports = port_keys
        .iter()
        .enumerate()
        .map(|(index, (position, edge))| RoadPort {
            id: format!("{id}-port-{index}"),
            point: *position,
            edge: *edge,
            direction: None,
        })
        .collect();
    map.road_structures.push(RoadStructure::AutomaticJunction {
        id: id.to_string(),
        footprint,
        ports,
    });
}

// ---------------------------------------------------------------------------
// From<RoadTopologyCompileError> for GameplayRejection — lines 49-63.
//
// `RoadTopology::compile` delegates to `compile_structure_transitions`, which
// only calls `compile_roundabout_transitions` for `RoadStructure::Roundabout`
// variants.  For any valid template (produced by `roundabout_template` from a
// fixed size+origin), the ring geometry is always well-formed, so the
// `UnsafeRoundaboutPortMapping` error is unreachable through `compile` on its
// own.  The error IS reachable through the public `compile_roundabout_transitions`
// entry point when handed a non-roundabout structure (`roundabout_parts`
// rejects `AutomaticJunction`), so we exercise the conversion there.
// ---------------------------------------------------------------------------

#[test]
fn compile_roundabout_transitions_rejects_non_roundabout_structure() {
    let junction = RoadStructure::AutomaticJunction {
        id: "bogus-junction".to_string(),
        footprint: vec![point(1, 1)],
        ports: Vec::new(),
    };

    let error = compile_roundabout_transitions(&junction)
        .expect_err("AutomaticJunction must not compile as a roundabout");
    assert!(matches!(
        error,
        RoadTopologyCompileError::UnsafeRoundaboutPortMapping { .. }
    ));

    // Exercise the `From<RoadTopologyCompileError> for GameplayRejection` impl.
    let rejection: GameplayRejection = error.into();
    assert_eq!(rejection.code, RejectionCode::UnsafeRoundaboutPortMapping);
    assert_eq!(
        rejection.context.structure_id.as_deref(),
        Some("bogus-junction")
    );
    assert_eq!(rejection.context.footprint, vec![point(1, 1)]);
}

// ---------------------------------------------------------------------------
// compile_reciprocal_lane_transitions — line 278 (destination tile off-map).
// compile_automatic_junction_transitions — lines 378, 386, 398, 406 (port
// tiles or their outside neighbors missing/off-map).
//
// A single map exercises all five `continue` branches:
// - An ordinary road at the west edge with a one-sided West connection whose
//   destination is off-map (line 278).
// - An automatic junction with valid ports plus two bogus ports whose points
//   or outside neighbors are off-map (lines 378, 386, 398, 406).
// ---------------------------------------------------------------------------

#[test]
fn compile_skips_off_map_and_disconnected_ports() {
    let mut map = blank_map(10, 10);

    // Ordinary road at the west edge with a one-sided West connection pointing
    // off-map.  `compile_reciprocal_lane_transitions` hits the
    // `map.tile(destination) -> None` continue (line 278) for every incoming
    // heading.
    road(&mut map, point(0, 2), None);
    map.tile_mut(point(0, 2))
        .unwrap()
        .road_connections
        .push(Heading::West);

    // Valid junction spine so at least one entry/exit pair compiles.
    let center = point(2, 2);
    connect(&mut map, center, point(2, 1));
    connect(&mut map, center, point(2, 3));
    automatic_junction(
        &mut map,
        "aj",
        vec![center],
        &[
            // Valid entry/exit ports.
            (center, Heading::North),
            (center, Heading::South),
            // Port whose point is off-map -> line 378 (entry) / 398 (exit).
            (point(-1, 2), Heading::West),
            // Port whose point exists but whose outside neighbor is off-map
            // -> line 386 (entry) / 406 (exit).  (0, 2) is already a road
            // with a West connection from the ordinary-road setup above.
            (point(0, 2), Heading::West),
        ],
    );

    // Compilation must succeed — the bogus ports are skipped, not fatal.
    let topology = RoadTopology::compile(&map).expect("valid junction must compile");

    // The valid North/South pair should produce at least one transition.
    assert!(topology
        .find_path_between_access_tiles(&map, point(2, 1), point(2, 3), None, None)
        .is_ok());
}

// ---------------------------------------------------------------------------
// deterministic_dijkstra — lines 534-537 (from == to zero-step shortcut).
// Exercised through the deprecated `find_path` entry point.
// ---------------------------------------------------------------------------

#[test]
fn find_path_same_tile_returns_empty_road_path() {
    let mut map = blank_map(5, 5);
    corridor(&mut map, &[point(1, 2), point(2, 2), point(3, 2)], None);
    let topology = RoadTopology::compile(&map).unwrap();

    let path = topology
        .find_path(&map, &point(2, 2), &point(2, 2))
        .expect("same-tile shortcut must return a path");
    assert_eq!(path.step_count(), 0);
    assert_eq!(path.total_travel_seconds(), 0.0);
    assert!(matches!(path, TransitPath::Road { steps, .. } if steps.is_empty()));
}

// ---------------------------------------------------------------------------
// deterministic_dijkstra — line 542 (starts empty -> None).
// ---------------------------------------------------------------------------

#[test]
fn find_path_returns_none_when_origin_has_no_adjacent_road() {
    let mut map = blank_map(5, 5);
    corridor(&mut map, &[point(1, 2), point(2, 2), point(3, 2)], None);
    let topology = RoadTopology::compile(&map).unwrap();

    // (0, 0) is an empty tile whose neighbours are all empty/off-map, so
    // `start_states` returns an empty vec and the search short-circuits.
    let path = topology.find_path(&map, &point(0, 0), &point(2, 2));
    assert!(path.is_none());
}

// ---------------------------------------------------------------------------
// deterministic_access_tile_dijkstra — lines 607, 610 (off-map from/to).
// ---------------------------------------------------------------------------

#[test]
fn access_tile_dijkstra_rejects_off_map_endpoints() {
    let mut map = blank_map(5, 5);
    corridor(&mut map, &[point(1, 2), point(2, 2), point(3, 2)], None);
    let topology = RoadTopology::compile(&map).unwrap();

    let off_map = point(-1, 0);

    // Off-map `from_tile` -> NoLegalEntryHeading (line 607).
    assert_eq!(
        topology.find_path_between_access_tiles(&map, off_map, point(2, 2), None, None),
        Err(LegFailureReason::NoLegalEntryHeading)
    );

    // Off-map `to_tile` -> NetworkDisconnected (line 610).
    assert_eq!(
        topology.find_path_between_access_tiles(&map, point(2, 2), off_map, None, None),
        Err(LegFailureReason::NetworkDisconnected)
    );
}
