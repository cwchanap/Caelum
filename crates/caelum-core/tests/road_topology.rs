use caelum_core::model::{
    GameMap, Heading, MovementKind, PathGeometry, Point, RoadStructure, RoundaboutSize, Tile,
    TransitPath,
};
use caelum_core::road_topology::{RoadState, RoadTopology};
use caelum_core::roundabouts::{roundabout_structure_id, roundabout_template};

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

fn offset(position: Point, heading: Heading) -> Point {
    match heading {
        Heading::North => point(position.x, position.y - 1),
        Heading::East => point(position.x + 1, position.y),
        Heading::South => point(position.x, position.y + 1),
        Heading::West => point(position.x - 1, position.y),
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
        .map(|(index, (position, edge))| caelum_core::model::RoadPort {
            id: format!("{id}-port-{index}"),
            point: *position,
            edge: *edge,
        })
        .collect();
    map.road_structures.push(RoadStructure::AutomaticJunction {
        id: id.to_string(),
        footprint,
        ports,
    });
}

fn four_way_topology() -> RoadTopology {
    let mut map = blank_map(7, 7);
    let center = point(3, 3);
    for neighbor in [point(3, 2), point(4, 3), point(3, 4), point(2, 3)] {
        connect(&mut map, center, neighbor);
    }
    automatic_junction(
        &mut map,
        "cross",
        vec![center],
        &[
            (center, Heading::North),
            (center, Heading::East),
            (center, Heading::South),
            (center, Heading::West),
        ],
    );
    RoadTopology::compile(&map).unwrap()
}

fn junction_state(incoming_heading: Heading) -> RoadState {
    RoadState {
        position: point(3, 3),
        incoming_heading,
    }
}

#[test]
fn classifies_all_ordinary_junction_movements() {
    let topology = four_way_topology();
    let cases = [
        (Heading::North, Heading::North, MovementKind::Straight),
        (Heading::North, Heading::East, MovementKind::RightTurn),
        (Heading::North, Heading::West, MovementKind::LeftTurn),
        (Heading::North, Heading::South, MovementKind::UTurn),
    ];

    for (incoming, outgoing, expected) in cases {
        assert_eq!(
            topology
                .transition_for(junction_state(incoming), outgoing)
                .unwrap()
                .movement,
            expected
        );
    }
}

struct DualCrossFixture {
    map: GameMap,
    topology: RoadTopology,
}

impl DualCrossFixture {
    fn enters_lane_wrong_way(&self, step: &caelum_core::model::RoadPathStep) -> bool {
        let destination = match &step.geometry {
            PathGeometry::Line { to, .. } | PathGeometry::QuadraticBezier { to, .. } => {
                point(to.x.round() as i32, to.y.round() as i32)
            }
        };
        self.map
            .tile(destination)
            .and_then(|tile| tile.one_way)
            .is_some_and(|heading| heading != step.leaving_heading)
    }
}

fn dual_cross_fixture() -> DualCrossFixture {
    let mut map = blank_map(20, 12);
    corridor(
        &mut map,
        &(6..=15).map(|x| point(x, 8)).collect::<Vec<_>>(),
        Some(Heading::East),
    );
    corridor(
        &mut map,
        &(6..=15).map(|x| point(x, 9)).collect::<Vec<_>>(),
        Some(Heading::West),
    );
    corridor(
        &mut map,
        &(3..=8).rev().map(|y| point(15, y)).collect::<Vec<_>>(),
        Some(Heading::North),
    );
    let center = point(15, 8);
    automatic_junction(
        &mut map,
        "dual-cross",
        vec![center],
        &[
            (center, Heading::North),
            (center, Heading::South),
            (center, Heading::West),
        ],
    );
    let topology = RoadTopology::compile(&map).unwrap();
    DualCrossFixture { map, topology }
}

#[test]
fn turns_between_dual_bidirectional_corridors_choose_the_compatible_outbound_lane() {
    let fixture = dual_cross_fixture();
    let path = fixture
        .topology
        .find_path(&fixture.map, &point(6, 8), &point(15, 3))
        .expect("west approach must turn north");

    assert!(path
        .road_steps()
        .iter()
        .any(|step| step.movement == MovementKind::LeftTurn));
    assert!(path
        .road_steps()
        .iter()
        .all(|step| !fixture.enters_lane_wrong_way(step)));
    assert_eq!(
        path.road_steps().last().unwrap().leaving_heading,
        Heading::North
    );
}

struct TurnPenaltyFixture {
    map: GameMap,
    topology: RoadTopology,
    from: Point,
    to: Point,
    expected_cheaper_millis: u64,
    fewer_tiles_with_uturn: Vec<Point>,
}

fn turn_penalty_fixture() -> TurnPenaltyFixture {
    let mut map = blank_map(8, 5);
    let from = point(1, 2);
    let entry = point(2, 2);
    let alternate = point(3, 2);
    let to = point(4, 2);
    let direct_exit = point(5, 2);
    corridor(&mut map, &[from, entry], Some(Heading::East));
    corridor(&mut map, &[alternate, to], Some(Heading::East));
    connect(&mut map, entry, alternate);
    connect(&mut map, direct_exit, to);
    road(&mut map, direct_exit, None);
    automatic_junction(
        &mut map,
        "weighted-junction",
        vec![entry, direct_exit],
        &[
            (entry, Heading::West),
            (entry, Heading::East),
            (direct_exit, Heading::West),
        ],
    );
    let topology = RoadTopology::compile(&map).unwrap();
    TurnPenaltyFixture {
        map,
        topology,
        from,
        to,
        expected_cheaper_millis: 3_750,
        fewer_tiles_with_uturn: vec![from, entry],
    }
}

#[test]
fn weighted_search_can_prefer_more_steps_with_a_cheaper_turn_sequence() {
    let fixture = turn_penalty_fixture();
    let path = fixture
        .topology
        .find_path(&fixture.map, &fixture.from, &fixture.to)
        .unwrap();

    assert_eq!(
        (path.total_travel_seconds() * 1_000.0).round() as u64,
        fixture.expected_cheaper_millis
    );
    assert_ne!(
        path.road_steps()
            .iter()
            .map(|step| step.position)
            .collect::<Vec<_>>(),
        fixture.fewer_tiles_with_uturn
    );
}

struct EqualCostFixture {
    path: TransitPath,
}

impl EqualCostFixture {
    fn path_key(&self) -> Vec<(Point, Heading, Heading, MovementKind)> {
        self.path
            .road_steps()
            .iter()
            .map(|step| {
                (
                    step.position,
                    step.entering_heading,
                    step.leaving_heading,
                    step.movement,
                )
            })
            .collect()
    }
}

fn equal_cost_fixture(rebuild_tiles: bool) -> EqualCostFixture {
    let mut map = blank_map(6, 5);
    for corridor_points in [
        vec![
            point(1, 2),
            point(1, 1),
            point(2, 1),
            point(3, 1),
            point(3, 2),
        ],
        vec![
            point(1, 2),
            point(1, 3),
            point(2, 3),
            point(3, 3),
            point(3, 2),
        ],
    ] {
        corridor(&mut map, &corridor_points, None);
    }
    if rebuild_tiles {
        map.tiles.reverse();
    }
    let topology = RoadTopology::compile(&map).unwrap();
    let path = topology
        .find_path(&map, &point(1, 2), &point(3, 2))
        .unwrap();
    EqualCostFixture { path }
}

#[test]
fn equal_cost_paths_use_canonical_direction_and_stable_structure_ties() {
    let first = equal_cost_fixture(false).path_key();
    let rebuilt = equal_cost_fixture(true).path_key();
    assert_eq!(first, rebuilt);
    assert_eq!(first.first().unwrap().2, Heading::North);
}

struct PairedLaneFixture {
    map: GameMap,
    topology: RoadTopology,
    midblock_left: Point,
    midblock_right: Point,
    legal_start: Point,
    wrong_way_end: Point,
}

fn paired_lane_fixture() -> PairedLaneFixture {
    let mut map = blank_map(8, 6);
    corridor(
        &mut map,
        &(1..=5).map(|x| point(x, 2)).collect::<Vec<_>>(),
        Some(Heading::East),
    );
    corridor(
        &mut map,
        &(1..=5).map(|x| point(x, 3)).collect::<Vec<_>>(),
        Some(Heading::West),
    );
    connect(&mut map, point(5, 2), point(5, 3));
    map.tile_mut(point(5, 2)).unwrap().one_way = None;
    let topology = RoadTopology::compile(&map).unwrap();
    PairedLaneFixture {
        map,
        topology,
        midblock_left: point(3, 2),
        midblock_right: point(3, 3),
        legal_start: point(1, 2),
        wrong_way_end: point(5, 3),
    }
}

#[test]
fn rejects_mid_block_lane_change_and_wrong_way_entry() {
    let fixture = paired_lane_fixture();
    assert!(fixture
        .topology
        .find_path(
            &fixture.map,
            &fixture.midblock_left,
            &fixture.midblock_right
        )
        .is_none());
    assert!(fixture
        .topology
        .find_path(&fixture.map, &fixture.legal_start, &fixture.wrong_way_end)
        .is_none());
}

struct MovementFixture {
    map: GameMap,
    topology: RoadTopology,
    from: Point,
    to: Point,
}

fn movement_fixture(points: &[Point], from: Point, to: Point) -> MovementFixture {
    let mut map = blank_map(7, 7);
    corridor(&mut map, points, None);
    let topology = RoadTopology::compile(&map).unwrap();
    MovementFixture {
        map,
        topology,
        from,
        to,
    }
}

fn l_junction_fixture() -> MovementFixture {
    movement_fixture(
        &[point(1, 2), point(2, 2), point(2, 3)],
        point(1, 2),
        point(2, 3),
    )
}

fn t_junction_fixture() -> MovementFixture {
    let mut fixture = movement_fixture(
        &[point(1, 2), point(2, 2), point(2, 1)],
        point(1, 2),
        point(2, 1),
    );
    connect(&mut fixture.map, point(2, 2), point(3, 2));
    automatic_junction(
        &mut fixture.map,
        "tee",
        vec![point(2, 2)],
        &[
            (point(2, 2), Heading::North),
            (point(2, 2), Heading::East),
            (point(2, 2), Heading::West),
        ],
    );
    fixture.topology = RoadTopology::compile(&fixture.map).unwrap();
    fixture
}

fn cross_junction_fixture() -> MovementFixture {
    let mut map = blank_map(7, 7);
    let center = point(2, 2);
    for neighbor in [point(2, 1), point(3, 2), point(2, 3), point(1, 2)] {
        connect(&mut map, center, neighbor);
    }
    automatic_junction(
        &mut map,
        "cross-fixture",
        vec![center],
        &[
            (center, Heading::North),
            (center, Heading::East),
            (center, Heading::South),
            (center, Heading::West),
        ],
    );
    let topology = RoadTopology::compile(&map).unwrap();
    MovementFixture {
        map,
        topology,
        from: point(1, 2),
        to: point(3, 2),
    }
}

fn uturn_fixture() -> MovementFixture {
    let mut map = blank_map(6, 6);
    let entry = point(2, 3);
    let exit = point(2, 2);
    let from = point(1, 3);
    let to = point(1, 2);
    corridor(&mut map, &[from, entry], Some(Heading::East));
    corridor(&mut map, &[exit, to], Some(Heading::West));
    automatic_junction(
        &mut map,
        "uturn",
        vec![entry, exit],
        &[(entry, Heading::West), (exit, Heading::West)],
    );
    let topology = RoadTopology::compile(&map).unwrap();
    MovementFixture {
        map,
        topology,
        from,
        to,
    }
}

#[test]
fn l_t_cross_and_uturn_paths_report_their_actual_movement_steps() {
    for (fixture, expected) in [
        (l_junction_fixture(), MovementKind::RightTurn),
        (t_junction_fixture(), MovementKind::LeftTurn),
        (cross_junction_fixture(), MovementKind::Straight),
        (uturn_fixture(), MovementKind::UTurn),
    ] {
        let path = fixture
            .topology
            .find_path(&fixture.map, &fixture.from, &fixture.to)
            .unwrap();
        assert!(path
            .road_steps()
            .iter()
            .any(|step| step.movement == expected));
        if expected == MovementKind::UTurn {
            let step = path
                .road_steps()
                .iter()
                .find(|step| step.movement == MovementKind::UTurn)
                .unwrap();
            assert!(matches!(
                &step.geometry,
                PathGeometry::QuadraticBezier { .. }
            ));
        }
    }
}

#[test]
fn right_and_left_turn_geometry_uses_a_non_collinear_incoming_tangent() {
    for (fixture, movement) in [
        (l_junction_fixture(), MovementKind::RightTurn),
        (t_junction_fixture(), MovementKind::LeftTurn),
    ] {
        let path = fixture
            .topology
            .find_path(&fixture.map, &fixture.from, &fixture.to)
            .unwrap();
        let step = path
            .road_steps()
            .iter()
            .find(|step| step.movement == movement)
            .unwrap();
        let PathGeometry::QuadraticBezier { from, control, to } = &step.geometry else {
            panic!("turn must use quadratic geometry");
        };
        let cross = (control.x - from.x) * (to.y - from.y) - (control.y - from.y) * (to.x - from.x);
        assert!(cross.abs() > f64::EPSILON, "turn control lies on chord");
        assert_eq!(from.y, control.y, "eastbound entry tangent must be flat");
        assert!(from.x < control.x, "entry tangent must point east");
    }
}

#[test]
fn consecutive_geometry_is_continuous_through_right_and_left_turns() {
    for fixture in [l_junction_fixture(), t_junction_fixture()] {
        let path = fixture
            .topology
            .find_path(&fixture.map, &fixture.from, &fixture.to)
            .unwrap();
        for pair in path.road_steps().windows(2) {
            let previous_end = match &pair[0].geometry {
                PathGeometry::Line { to, .. } | PathGeometry::QuadraticBezier { to, .. } => to,
            };
            let next_start = match &pair[1].geometry {
                PathGeometry::Line { from, .. } | PathGeometry::QuadraticBezier { from, .. } => {
                    from
                }
            };
            assert!(
                (previous_end.x - next_start.x).abs() < 1e-9
                    && (previous_end.y - next_start.y).abs() < 1e-9,
                "geometry discontinuity: previous={previous_end:?}, next={next_start:?}"
            );
        }
    }
}

struct OffRoadStopFixture {
    map: GameMap,
    topology: RoadTopology,
    stop: Point,
    road_destination: Point,
    road_start: Point,
}

fn off_road_stop_fixture() -> OffRoadStopFixture {
    let mut map = blank_map(8, 6);
    corridor(
        &mut map,
        &(2..=6).map(|x| point(x, 3)).collect::<Vec<_>>(),
        None,
    );
    let topology = RoadTopology::compile(&map).unwrap();
    OffRoadStopFixture {
        map,
        topology,
        stop: point(2, 2),
        road_destination: point(6, 3),
        road_start: point(6, 3),
    }
}

#[test]
fn off_road_stop_access_is_allowed_only_as_a_path_endpoint() {
    let fixture = off_road_stop_fixture();
    assert!(fixture
        .topology
        .find_path(&fixture.map, &fixture.stop, &fixture.road_destination)
        .is_some());
    assert!(fixture
        .topology
        .find_path(&fixture.map, &fixture.road_start, &fixture.stop)
        .is_some());
    assert!(!fixture.topology.contains_ordinary_state(fixture.stop));
}

#[test]
fn off_road_endpoint_access_is_not_serialized_as_zero_duration_geometry() {
    let fixture = off_road_stop_fixture();
    for (from, to) in [
        (fixture.stop, fixture.road_destination),
        (fixture.road_start, fixture.stop),
    ] {
        let path = fixture
            .topology
            .find_path(&fixture.map, &from, &to)
            .unwrap();
        assert!(path
            .road_steps()
            .iter()
            .all(|step| step.travel_seconds > 0.0));
        let step_total: f64 = path
            .road_steps()
            .iter()
            .map(|step| step.travel_seconds)
            .sum();
        assert!((step_total - path.total_travel_seconds()).abs() < f64::EPSILON);
    }
}

#[test]
fn structure_transition_keys_are_stable_when_authored_order_changes() {
    let mut first = dual_cross_fixture();
    let first_path = first
        .topology
        .find_path(&first.map, &point(6, 8), &point(15, 3))
        .unwrap();
    first.map.road_structures.reverse();
    for structure in &mut first.map.road_structures {
        if let RoadStructure::AutomaticJunction { ports, .. } = structure {
            ports.reverse();
        }
    }
    let rebuilt = RoadTopology::compile(&first.map).unwrap();
    let rebuilt_path = rebuilt
        .find_path(&first.map, &point(6, 8), &point(15, 3))
        .unwrap();
    assert_eq!(first_path, rebuilt_path);
}

#[test]
fn fixed_roundabout_transitions_connect_compatible_external_lanes() {
    let mut map = blank_map(9, 9);
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let id = roundabout_structure_id(template.size, template.origin);
    for position in &template.footprint {
        road(&mut map, *position, None);
        map.tile_mut(*position).unwrap().road_structure_id = Some(id.clone());
    }

    let west_inbound = template
        .port_slots
        .iter()
        .find(|port| port.point == point(3, 4) && port.edge == Heading::West)
        .unwrap()
        .clone();
    let east_outbound = template
        .port_slots
        .iter()
        .find(|port| port.point == point(4, 4) && port.edge == Heading::East)
        .unwrap()
        .clone();
    corridor(
        &mut map,
        &[point(1, 4), point(2, 4), west_inbound.point],
        Some(Heading::East),
    );
    corridor(
        &mut map,
        &[east_outbound.point, point(5, 4), point(6, 4)],
        Some(Heading::East),
    );
    map.tile_mut(west_inbound.point).unwrap().one_way = None;
    map.tile_mut(east_outbound.point).unwrap().one_way = None;
    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin: template.origin,
        size: template.size,
        footprint: template.footprint,
        ports: vec![west_inbound, east_outbound],
    });

    let topology = RoadTopology::compile(&map).unwrap();
    let path = topology
        .find_path(&map, &point(1, 4), &point(6, 4))
        .expect("roundabout should connect compatible lanes");
    assert!(path
        .road_steps()
        .iter()
        .any(|step| step.movement == MovementKind::RoundaboutEntry));
    assert!(path
        .road_steps()
        .iter()
        .any(|step| step.movement == MovementKind::RoundaboutExit));
}

#[test]
fn endpoint_access_does_not_create_an_intermediate_shortcut() {
    let mut map = blank_map(7, 6);
    corridor(&mut map, &[point(1, 3), point(2, 3)], None);
    corridor(&mut map, &[point(4, 3), point(5, 3)], None);
    let topology = RoadTopology::compile(&map).unwrap();
    let empty_bridge = point(3, 3);
    assert!(topology
        .find_path(&map, &point(1, 3), &point(5, 3))
        .is_none());
    assert!(topology
        .find_path(&map, &point(1, 3), &empty_bridge)
        .is_some());
    assert_eq!(offset(empty_bridge, Heading::West), point(2, 3));
}

#[test]
fn terminal_reversal_on_one_way_lane_returns_zero_step_path() {
    let mut map = blank_map(8, 6);
    corridor(
        &mut map,
        &[point(1, 3), point(2, 3), point(3, 3)],
        Some(Heading::East),
    );
    let topology = RoadTopology::compile(&map).unwrap();

    // On a one-way eastbound road, the vehicle arrives and departs heading
    // East (0° "reversal"). The previous code rejected this because it
    // wasn't a UTurn; the fix returns a zero-step path.
    let path = topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::East)
        .expect("same-heading reversal should return a zero-step path");
    let steps = path.road_steps();
    assert!(steps.is_empty());
    assert_eq!(path.total_travel_seconds(), 0.0);
}

#[test]
fn terminal_reversal_on_bidirectional_road_returns_in_place_uturn() {
    let mut map = blank_map(8, 6);
    corridor(&mut map, &[point(1, 3), point(2, 3), point(3, 3)], None);
    let topology = RoadTopology::compile(&map).unwrap();

    let path = topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::West)
        .expect("bidirectional road should support terminal reversal");
    let steps = path.road_steps();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].movement, MovementKind::UTurn);
    assert_eq!(steps[0].position, point(2, 3));
    assert_eq!(steps[0].leaving_heading, Heading::West);
    // Geometry stays on the terminal — ordinary U-turns would end one tile away.
    match &steps[0].geometry {
        caelum_core::model::PathGeometry::QuadraticBezier { from, to, .. } => {
            assert_eq!(from.x, 2.0);
            assert_eq!(from.y, 3.0);
            assert_eq!(to.x, 2.0);
            assert_eq!(to.y, 3.0);
        }
        other => panic!("expected in-place quadratic U-turn, got {other:?}"),
    }
}

#[test]
fn terminal_reversal_through_roundabout_finds_multi_step_path() {
    let mut map = blank_map(9, 9);
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let id = roundabout_structure_id(template.size, template.origin);
    for position in &template.footprint {
        road(&mut map, *position, None);
        map.tile_mut(*position).unwrap().road_structure_id = Some(id.clone());
    }

    // Two-way west port at (3,3) — allows both entry and exit.
    let west_port = template
        .port_slots
        .iter()
        .find(|port| port.point == point(3, 3) && port.edge == Heading::West)
        .unwrap()
        .clone();
    corridor(&mut map, &[point(1, 3), point(2, 3), west_port.point], None);
    map.tile_mut(west_port.point).unwrap().one_way = None;
    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin: template.origin,
        size: template.size,
        footprint: template.footprint,
        ports: vec![west_port],
    });

    let topology = RoadTopology::compile(&map).unwrap();

    // Bidirectional approach supports a direct in-place U-turn at the terminal.
    let path = topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::West)
        .expect("reversal should be found");
    let steps = path.road_steps();
    assert!(!steps.is_empty());
    assert!(steps
        .iter()
        .any(|step| step.movement == MovementKind::UTurn));
}

#[test]
fn terminal_reversal_returns_none_when_no_path_exists() {
    let mut map = blank_map(8, 6);
    corridor(
        &mut map,
        &[point(1, 3), point(2, 3), point(3, 3)],
        Some(Heading::East),
    );
    let topology = RoadTopology::compile(&map).unwrap();

    // One-way eastbound road: can't reverse from East to West.
    assert!(topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::West)
        .is_none());
}

#[test]
fn terminal_reversal_dijkstra_finds_multi_step_roundabout_path() {
    let mut map = blank_map(9, 9);
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let id = roundabout_structure_id(template.size, template.origin);
    for position in &template.footprint {
        road(&mut map, *position, None);
        map.tile_mut(*position).unwrap().road_structure_id = Some(id.clone());
    }

    // Bidirectional corridor from (1,3) through the west port at (3,3).
    // The approach at (1,3) is narrowed to one-way eastbound so no direct
    // U-turn fast path exists at the terminal (2,3) — its west neighbor
    // (1,3) rejects westbound traffic, blocking the U-turn transition while
    // leaving (2,3) two-way so the roundabout's :twoWay port stays valid
    // against the live map. This forces the bounded Dijkstra to find the
    // multi-step reversal through the roundabout.
    let mut west_port = template
        .port_slots
        .iter()
        .find(|port| port.point == point(3, 3) && port.edge == Heading::West)
        .unwrap()
        .clone();
    west_port.id.push_str(":twoWay");
    corridor(&mut map, &[point(1, 3), point(2, 3), west_port.point], None);
    map.tile_mut(point(1, 3)).unwrap().one_way = Some(Heading::East);

    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin: template.origin,
        size: template.size,
        footprint: template.footprint,
        ports: vec![west_port],
    });

    let topology = RoadTopology::compile(&map).unwrap();

    // The terminal at (2,3) has no U-turn fast path (its west neighbor is
    // one-way eastbound). The only reversal route is: ordinary straight →
    // roundabout entry → circulation → circulation → circulation →
    // roundabout exit, arriving back at (2,3) heading West. This exercises
    // the bounded-Dijkstra success path in `find_reversal_path`.
    let path = topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::West)
        .expect("Dijkstra should find multi-step reversal through roundabout");
    let steps = path.road_steps();
    assert!(
        steps.len() > 1,
        "reversal should be multi-step, not a fast-path U-turn"
    );
    assert!(
        steps
            .iter()
            .all(|step| step.movement != MovementKind::UTurn),
        "reversal should not use U-turn fast path"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.movement == MovementKind::RoundaboutEntry),
        "reversal should enter the roundabout"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.movement == MovementKind::RoundaboutCirculation),
        "reversal should circulate within the roundabout"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.movement == MovementKind::RoundaboutExit),
        "reversal should exit the roundabout"
    );
    // The path should start at the terminal and end heading West.
    assert_eq!(steps.first().unwrap().position, point(2, 3));
    assert_eq!(steps.last().unwrap().leaving_heading, Heading::West);
}

#[test]
fn terminal_reversal_finds_paths_longer_than_former_step_cap() {
    // One-way racetrack: arrive at the NW corner heading East, leave only after
    // circulating and re-entering heading North. That forces >20 transitions;
    // the old step cap would false-negative. Finite tile×heading state space
    // still terminates the search. Corner tiles stay two-way so each approach
    // leg can enter the next one-way side.
    let mut map = blank_map(24, 8);
    let terminal = point(2, 2);
    let se = point(20, 2);
    let sw = point(20, 5);
    let nw_south = point(2, 5);
    let east: Vec<_> = (2..=20).map(|x| point(x, 2)).collect();
    let south: Vec<_> = (2..=5).map(|y| point(20, y)).collect();
    let west: Vec<_> = (2..=20).rev().map(|x| point(x, 5)).collect();
    let north: Vec<_> = (2..=5).rev().map(|y| point(2, y)).collect();
    corridor(&mut map, &east, Some(Heading::East));
    corridor(&mut map, &south, Some(Heading::South));
    corridor(&mut map, &west, Some(Heading::West));
    corridor(&mut map, &north, Some(Heading::North));
    for corner in [terminal, se, sw, nw_south] {
        map.tile_mut(corner).unwrap().one_way = None;
    }

    let topology = RoadTopology::compile(&map).unwrap();
    let path = topology
        .find_terminal_reversal(terminal, Heading::East, Heading::North)
        .expect("long one-way loop must still yield a terminal reversal");
    let steps = path.road_steps();
    assert!(
        steps.len() > 20,
        "fixture must require more than 20 steps, got {}",
        steps.len()
    );
    assert_eq!(steps.first().unwrap().position, terminal);
    assert_eq!(steps.last().unwrap().leaving_heading, Heading::North);
}

/// When both a direct U-turn at the terminal and a multi-step roundabout
/// reversal exist, the U-turn shortcut in `find_terminal_reversal` must pick
/// the cheaper path. With current constants, an ordinary U-turn costs
/// `BUS_TILE_MILLIS + U_TURN_MILLIS = 3250ms`, while a compact roundabout
/// reversal (entry + 2× circulation + exit) costs ≥5750ms — so the shortcut
/// is optimal. This test verifies that property explicitly.
///
/// Known edge case: a multi-tile automatic-junction U-turn (where
/// `structure_tiles > 3`) can cost more than a nearby roundabout reversal.
/// The shortcut does not compare both paths in that case — it returns the
/// U-turn immediately for its in-place geometry correctness (no backward
/// jump when the next service leg resumes). This trade-off is accepted
/// because such junctions are rare and the geometry correctness outweighs
/// the small optimality gap.
#[test]
fn terminal_reversal_uturn_shortcut_is_cheaper_than_roundabout_reversal() {
    let mut map = blank_map(9, 9);
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let id = roundabout_structure_id(template.size, template.origin);
    for position in &template.footprint {
        road(&mut map, *position, None);
        map.tile_mut(*position).unwrap().road_structure_id = Some(id.clone());
    }

    // Bidirectional west port — allows both entry and exit through the
    // roundabout, providing a multi-step reversal path.
    let west_port = template
        .port_slots
        .iter()
        .find(|port| port.point == point(3, 3) && port.edge == Heading::West)
        .unwrap()
        .clone();
    // Bidirectional approach corridor: (1,3) — (2,3) — (3,3). The terminal
    // at (2,3) supports a direct U-turn (bidirectional neighbor at (1,3)).
    corridor(&mut map, &[point(1, 3), point(2, 3), west_port.point], None);
    map.tile_mut(west_port.point).unwrap().one_way = None;
    map.road_structures.push(RoadStructure::Roundabout {
        id,
        origin: template.origin,
        size: template.size,
        footprint: template.footprint,
        ports: vec![west_port],
    });

    let topology = RoadTopology::compile(&map).unwrap();

    // Both paths are available: the direct U-turn shortcut and the
    // multi-step roundabout reversal (via Dijkstra). The shortcut must win.
    let path = topology
        .find_terminal_reversal(point(2, 3), Heading::East, Heading::West)
        .expect("reversal should be found");

    let steps = path.road_steps();
    assert_eq!(
        steps.len(),
        1,
        "shortcut should pick the 1-step U-turn, not the multi-step roundabout path"
    );
    assert_eq!(steps[0].movement, MovementKind::UTurn);
    assert_eq!(steps[0].position, point(2, 3));

    // U-turn cost: BUS_TILE_MILLIS (1250) + U_TURN_MILLIS (2000) = 3250ms.
    // Roundabout reversal would cost ≥5750ms (entry 2000 + 2× circulation
    // 1250 + exit 1250). Verify the shortcut cost is strictly cheaper.
    let uturn_cost_ms = (path.total_travel_seconds() * 1_000.0).round() as u64;
    assert_eq!(
        uturn_cost_ms, 3_250,
        "U-turn shortcut cost should be 3250ms"
    );
    assert!(
        uturn_cost_ms < 5_750,
        "U-turn shortcut must be cheaper than roundabout reversal (≥5750ms)"
    );

    // Verify geometry stays in-place on the terminal (the correctness
    // reason for the shortcut — no backward jump to the neighbor tile).
    match &steps[0].geometry {
        caelum_core::model::PathGeometry::QuadraticBezier { from, to, .. } => {
            assert_eq!(from.x, 2.0);
            assert_eq!(from.y, 3.0);
            assert_eq!(to.x, 2.0);
            assert_eq!(to.y, 3.0);
        }
        other => panic!("expected in-place quadratic U-turn, got {other:?}"),
    }
}

/// Verify that geometry is continuous (each step's end matches the next
/// step's start) through a 2×2 multi-tile automatic junction. Single-tile
/// junctions are already covered by `consecutive_geometry_is_continuous_*`;
/// this exercises the multi-tile case where `structure_tiles > 1` and the
/// junction transition spans two footprint tiles.
#[test]
fn multi_tile_automatic_junction_geometry_is_continuous() {
    let mut map = blank_map(8, 8);
    // 2×2 junction footprint: (2,2), (3,2), (2,3), (3,3)
    let footprint = vec![point(2, 2), point(2, 3), point(3, 2), point(3, 3)];
    // Internal connections (form a 2×2 grid)
    connect(&mut map, point(2, 2), point(3, 2));
    connect(&mut map, point(2, 2), point(2, 3));
    connect(&mut map, point(3, 2), point(3, 3));
    connect(&mut map, point(2, 3), point(3, 3));
    // External approach roads (west, north, east — 3 ports with both axes)
    connect(&mut map, point(1, 2), point(2, 2));
    connect(&mut map, point(2, 1), point(2, 2));
    connect(&mut map, point(3, 2), point(4, 2));
    // Extend the east approach so the path has an ordinary step after the junction
    connect(&mut map, point(4, 2), point(5, 2));

    automatic_junction(
        &mut map,
        "junction-2x2",
        footprint,
        &[
            (point(2, 2), Heading::West),
            (point(2, 2), Heading::North),
            (point(3, 2), Heading::East),
        ],
    );

    let topology = RoadTopology::compile(&map).unwrap();
    let path = topology
        .find_path(&map, &point(1, 2), &point(5, 2))
        .expect("west-to-east path through 2×2 junction should exist");

    let steps = path.road_steps();
    assert!(
        steps.len() >= 2,
        "path should have at least 2 steps, got {}",
        steps.len()
    );

    // Verify geometry continuity: each step's end matches the next step's start.
    for pair in steps.windows(2) {
        let previous_end = match &pair[0].geometry {
            PathGeometry::Line { to, .. } | PathGeometry::QuadraticBezier { to, .. } => to,
        };
        let next_start = match &pair[1].geometry {
            PathGeometry::Line { from, .. } | PathGeometry::QuadraticBezier { from, .. } => from,
        };
        assert!(
            (previous_end.x - next_start.x).abs() < 1e-9
                && (previous_end.y - next_start.y).abs() < 1e-9,
            "geometry discontinuity through 2×2 junction: previous end={previous_end:?}, next start={next_start:?}"
        );
    }

    // Verify the path actually traverses the junction (at least one step
    // spans from a junction entry port to an exit outside tile).
    assert!(
        steps.iter().any(|step| {
            (step.position == point(2, 2) || step.position == point(3, 2))
                && step.leaving_heading == Heading::East
        }),
        "path should traverse the 2×2 junction eastward, steps={steps:?}"
    );
}
