use std::collections::{BTreeSet, VecDeque};

use caelum_core::model::{
    EconomyPreset, GameSnapshot, Heading, MovementKind, Point, RoadPort, RoadStructure,
    RoundaboutSize,
};
use caelum_core::preview::RoadMutationPreviewRequest;
use caelum_core::road::RoadMutation;
use caelum_core::road_topology::{RoadState, RoadTransition};
use caelum_core::roundabouts::{
    compile_roundabout_transitions, roundabout_structure_id, roundabout_template,
    RoundaboutTemplate, COMPACT_ROUNDABOUT_COST, STANDARD_ROUNDABOUT_COST,
};
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn points(values: &[(i32, i32)]) -> Vec<Point> {
    values.iter().map(|(x, y)| point(*x, *y)).collect()
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

fn heading_between(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
    }
}

fn structure_from_template(template: &RoundaboutTemplate, ports: Vec<RoadPort>) -> RoadStructure {
    RoadStructure::Roundabout {
        id: roundabout_structure_id(template.size, template.origin),
        origin: template.origin,
        size: template.size,
        footprint: template.footprint.clone(),
        ports,
    }
}

struct CompiledTemplateTopology {
    transitions: Vec<(RoadState, RoadTransition)>,
}

impl CompiledTemplateTopology {
    fn has_circulation(&self, from: Point, to: Point) -> bool {
        self.transitions.iter().any(|(state, transition)| {
            state.position == from
                && transition.to.position == to
                && transition.movement == MovementKind::RoundaboutCirculation
        })
    }
}

fn compile_template_topology(template: &RoundaboutTemplate) -> CompiledTemplateTopology {
    let structure = structure_from_template(template, template.port_slots.clone());
    CompiledTemplateTopology {
        transitions: compile_roundabout_transitions(&structure).unwrap(),
    }
}

#[derive(Clone)]
struct ApproachPort {
    arm: Heading,
    port: RoadPort,
}

struct CompiledPath {
    steps: Vec<RoadTransition>,
}

impl CompiledPath {
    fn road_steps(&self) -> &[RoadTransition] {
        &self.steps
    }

    fn movements(&self) -> impl Iterator<Item = &MovementKind> {
        self.steps.iter().map(|step| &step.movement)
    }
}

struct ApproachFixture {
    transitions: Vec<(RoadState, RoadTransition)>,
    inbound_ports: Vec<ApproachPort>,
    outbound_ports: Vec<ApproachPort>,
    minimum_uturn_circulation_steps: usize,
}

impl ApproachFixture {
    fn path(&self, entry: &ApproachPort, exit: &ApproachPort) -> Option<CompiledPath> {
        let entry_state = RoadState {
            position: entry.port.point,
            incoming_heading: opposite(entry.port.edge),
        };
        let exit_destination = offset(exit.port.point, exit.port.edge);
        let mut queue = VecDeque::new();
        for (state, transition) in &self.transitions {
            if *state == entry_state && transition.movement == MovementKind::RoundaboutEntry {
                queue.push_back((transition.to, vec![transition.clone()]));
            }
        }

        let mut visited = BTreeSet::new();
        while let Some((state, path)) = queue.pop_front() {
            if !visited.insert(state) {
                continue;
            }
            for (from, transition) in &self.transitions {
                if *from != state {
                    continue;
                }
                let mut next_path = path.clone();
                next_path.push(transition.clone());
                if transition.movement == MovementKind::RoundaboutExit
                    && transition.to.position == exit_destination
                {
                    return Some(CompiledPath { steps: next_path });
                }
                if transition.movement == MovementKind::RoundaboutCirculation {
                    queue.push_back((transition.to, next_path));
                }
            }
        }
        None
    }
}

fn ring_neighbors(template: &RoundaboutTemplate, position: Point) -> (Point, Point) {
    let index = template
        .counterclockwise_ring
        .iter()
        .position(|candidate| *candidate == position)
        .unwrap();
    let previous = template.counterclockwise_ring
        [(index + template.counterclockwise_ring.len() - 1) % template.counterclockwise_ring.len()];
    let next = template.counterclockwise_ring[(index + 1) % template.counterclockwise_ring.len()];
    (previous, next)
}

fn expected_inbound(template: &RoundaboutTemplate, port: &RoadPort) -> bool {
    let (_, next) = ring_neighbors(template, port.point);
    opposite(port.edge) == heading_between(port.point, next)
}

fn expected_outbound(template: &RoundaboutTemplate, port: &RoadPort) -> bool {
    let (previous, _) = ring_neighbors(template, port.point);
    port.edge == heading_between(previous, port.point)
}

fn approach_fixture(size: RoundaboutSize) -> ApproachFixture {
    let template = roundabout_template(size, point(4, 4));
    let inbound_ports: Vec<_> = template
        .port_slots
        .iter()
        .filter(|port| expected_inbound(&template, port))
        .cloned()
        .map(|port| ApproachPort {
            arm: port.edge,
            port,
        })
        .collect();
    let outbound_ports: Vec<_> = template
        .port_slots
        .iter()
        .filter(|port| expected_outbound(&template, port))
        .cloned()
        .map(|port| ApproachPort {
            arm: port.edge,
            port,
        })
        .collect();
    let captured_ports = inbound_ports
        .iter()
        .chain(&outbound_ports)
        .map(|approach| approach.port.clone())
        .collect();
    let structure = structure_from_template(&template, captured_ports);
    ApproachFixture {
        transitions: compile_roundabout_transitions(&structure).unwrap(),
        inbound_ports,
        outbound_ports,
        minimum_uturn_circulation_steps: match size {
            RoundaboutSize::Compact2x2 => 2,
            RoundaboutSize::Standard3x3 => 5,
        },
    }
}

fn all_four_approach_fixtures() -> Vec<ApproachFixture> {
    vec![
        approach_fixture(RoundaboutSize::Compact2x2),
        approach_fixture(RoundaboutSize::Standard3x3),
    ]
}

struct DualLaneFixture {
    inbound_port: RoadPort,
    outbound_port: RoadPort,
    compiled: Vec<(RoadState, RoadTransition)>,
}

impl DualLaneFixture {
    fn transitions(&self) -> impl Iterator<Item = &RoadTransition> {
        self.compiled.iter().map(|(_, transition)| transition)
    }
}

fn dual_lane_roundabout_fixture() -> DualLaneFixture {
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(3, 3));
    let inbound_port = template
        .port_slots
        .iter()
        .find(|port| port.edge == Heading::North && expected_inbound(&template, port))
        .unwrap()
        .clone();
    let outbound_port = template
        .port_slots
        .iter()
        .find(|port| port.edge == Heading::North && expected_outbound(&template, port))
        .unwrap()
        .clone();
    let structure =
        structure_from_template(&template, vec![inbound_port.clone(), outbound_port.clone()]);
    DualLaneFixture {
        inbound_port,
        outbound_port,
        compiled: compile_roundabout_transitions(&structure).unwrap(),
    }
}

#[test]
fn compact_and_standard_templates_have_exact_owned_footprints() {
    let compact = roundabout_template(RoundaboutSize::Compact2x2, point(5, 6));
    assert_eq!(compact.footprint, points(&[(5, 6), (6, 6), (5, 7), (6, 7)]));
    assert!(compact.protected_island.is_empty());

    let standard = roundabout_template(RoundaboutSize::Standard3x3, point(5, 6));
    assert_eq!(standard.footprint.len(), 9);
    assert_eq!(standard.protected_island, vec![point(6, 7)]);
    assert_eq!(standard.circulation_tiles.len(), 8);
}

#[test]
fn every_ring_edge_is_counterclockwise_and_no_reverse_edge_exists() {
    for size in [RoundaboutSize::Compact2x2, RoundaboutSize::Standard3x3] {
        let template = roundabout_template(size, point(4, 4));
        let topology = compile_template_topology(&template);
        for pair in template.counterclockwise_ring.windows(2) {
            assert!(topology.has_circulation(pair[0], pair[1]));
            assert!(!topology.has_circulation(pair[1], pair[0]));
        }
        let last = *template.counterclockwise_ring.last().unwrap();
        let first = template.counterclockwise_ring[0];
        assert!(topology.has_circulation(last, first));
        assert!(!topology.has_circulation(first, last));
    }
}

#[test]
fn each_compatible_entry_can_reach_every_exit_including_its_own_arm() {
    for fixture in all_four_approach_fixtures() {
        for entry in &fixture.inbound_ports {
            for exit in &fixture.outbound_ports {
                let path = fixture.path(entry, exit).expect("compatible exit");
                assert_eq!(
                    path.road_steps().first().unwrap().movement,
                    MovementKind::RoundaboutEntry
                );
                assert_eq!(
                    path.road_steps().last().unwrap().movement,
                    MovementKind::RoundaboutExit
                );
                if entry.arm == exit.arm {
                    assert!(
                        path.movements()
                            .filter(|kind| **kind == MovementKind::RoundaboutCirculation)
                            .count()
                            >= fixture.minimum_uturn_circulation_steps
                    );
                }
            }
        }
    }
}

#[test]
fn paired_lanes_use_separate_ports_and_only_entry_adds_delay() {
    let fixture = dual_lane_roundabout_fixture();
    assert_ne!(fixture.inbound_port.id, fixture.outbound_port.id);
    let transitions = fixture.transitions();
    for transition in transitions {
        let extra = transition.travel_millis - transition.base_travel_millis();
        match transition.movement {
            MovementKind::RoundaboutEntry => assert_eq!(extra, 750),
            MovementKind::RoundaboutCirculation | MovementKind::RoundaboutExit => {
                assert_eq!(extra, 0)
            }
            other => panic!("unexpected roundabout movement: {other:?}"),
        }
    }
}

#[test]
fn ids_ports_and_prices_are_canonical() {
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(5, 6));
    assert_eq!(
        roundabout_structure_id(template.size, template.origin),
        "roundabout:compact2x2:5,6"
    );
    assert_eq!(template.port_slots.len(), 8);
    assert_eq!(
        template.port_slots[0].id,
        "roundabout:compact2x2:5,6:port:5,6:north"
    );
    assert!(template
        .port_slots
        .windows(2)
        .all(|ports| { (ports[0].point, ports[0].edge) < (ports[1].point, ports[1].edge) }));
    assert_eq!(COMPACT_ROUNDABOUT_COST, 1_000);
    assert_eq!(STANDARD_ROUNDABOUT_COST, 2_000);
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "fixture dispatch should apply: {result:?}");
}

fn road_line(engine: &mut GameEngine, points: Vec<Point>) {
    dispatch(
        engine,
        GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        },
    );
}

fn crossing_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    road_line(&mut engine, (1..=9).map(|y| point(6, y)).collect());
    engine
}

fn engine_for(snapshot: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut candidate = snapshot.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate.paused = true;
    GameEngine::from_snapshot(candidate).expect("fixture snapshot should be valid")
}

fn place_standard_roundabout() -> GameIntent {
    GameIntent::PlaceRoundabout {
        origin: point(5, 4),
        size: RoundaboutSize::Standard3x3,
    }
}

fn only_roundabout(snapshot: &caelum_core::GameSnapshot) -> &RoadStructure {
    let roundabouts: Vec<_> = snapshot
        .map
        .road_structures
        .iter()
        .filter(|structure| matches!(structure, RoadStructure::Roundabout { .. }))
        .collect();
    assert_eq!(roundabouts.len(), 1);
    roundabouts[0]
}

fn roundabout_with_id<'a>(snapshot: &'a caelum_core::GameSnapshot, id: &str) -> &'a RoadStructure {
    snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            matches!(structure, RoadStructure::Roundabout { .. }) && structure.id() == id
        })
        .expect("roundabout with id should exist")
}

fn only_roundabout_a(snapshot: &caelum_core::GameSnapshot) -> &RoadStructure {
    // A is the roundabout whose footprint contains (5,5).
    snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| {
            matches!(structure, RoadStructure::Roundabout { .. })
                && structure.footprint().contains(&point(5, 5))
        })
        .expect("roundabout A should exist")
}

#[test]
fn compact_and_standard_charge_rust_authoritative_flat_costs() {
    for (origin, size, expected) in [
        (point(5, 5), RoundaboutSize::Compact2x2, 1_000),
        (point(9, 8), RoundaboutSize::Standard3x3, 2_000),
    ] {
        let mut engine = GameEngine::new();
        let before = engine.snapshot();
        let result = engine.dispatch(GameIntent::PlaceRoundabout { origin, size });
        assert!(result.applied, "{result:?}");
        assert_eq!(result.snapshot.budget, before.budget - expected);
        assert_eq!(result.context.cost, expected);
    }
}

#[test]
fn replacing_bare_roads_captures_every_crossing_boundary_connection() {
    let mut engine = crossing_engine();
    let result = engine.dispatch(place_standard_roundabout());
    assert!(result.applied, "{result:?}");
    let structure = only_roundabout(&result.snapshot);

    assert_eq!(
        structure.port_keys(),
        vec![
            (point(5, 5), Heading::West),
            (point(6, 4), Heading::North),
            (point(6, 6), Heading::South),
            (point(7, 5), Heading::East),
        ]
    );
    assert!(structure.footprint().iter().all(|point| {
        result
            .snapshot
            .map
            .tile(*point)
            .unwrap()
            .road_structure_id
            .as_deref()
            == Some(structure.id())
    }));
}

#[test]
fn complete_automatic_junction_may_be_replaced_but_partial_overlap_rejects() {
    let mut full = crossing_engine();
    assert!(full.dispatch(place_standard_roundabout()).applied);

    let mut partial = GameEngine::new();
    for y in [8, 9] {
        road_line(&mut partial, (7..=12).map(|x| point(x, y)).collect());
    }
    for x in [9, 10] {
        road_line(&mut partial, (6..=11).map(|y| point(x, y)).collect());
    }
    let before = partial.snapshot();
    let result = partial.dispatch(GameIntent::PlaceRoundabout {
        origin: point(10, 8),
        size: RoundaboutSize::Compact2x2,
    });
    assert_eq!(
        result.rejection.unwrap().code,
        RejectionCode::BlockedFootprint
    );
    assert_eq!(result.snapshot, before);
}

#[test]
fn invalid_footprint_rejections_are_all_or_nothing() {
    let mut fixtures = Vec::new();

    let mut out_of_bounds = GameEngine::new();
    fixtures.push((
        out_of_bounds.snapshot(),
        out_of_bounds.dispatch(GameIntent::PlaceRoundabout {
            origin: point(-1, 0),
            size: RoundaboutSize::Compact2x2,
        }),
    ));

    // Origins near i32 extremes must reject before template arithmetic overflows.
    let mut overflowing = GameEngine::new();
    fixtures.push((
        overflowing.snapshot(),
        overflowing.dispatch(GameIntent::PlaceRoundabout {
            origin: point(i32::MAX, i32::MAX),
            size: RoundaboutSize::Standard3x3,
        }),
    ));

    let mut insufficient = GameEngine::new();
    insufficient.set_budget_for_test(999);
    fixtures.push((
        insufficient.snapshot(),
        insufficient.dispatch(GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        }),
    ));

    let mut existing = GameEngine::new();
    dispatch(
        &mut existing,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    fixtures.push((
        existing.snapshot(),
        existing.dispatch(GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        }),
    ));

    for (before, result) in fixtures {
        assert!(!result.applied);
        assert!(result.rejection.is_some());
        assert_eq!(result.snapshot, before);
    }
}

#[test]
fn roundabout_geometry_rejection_precedes_budget_in_both_presets() {
    let prepared = GameEngine::new().snapshot();
    let mut standard = engine_for(&prepared, EconomyPreset::Standard, 0);
    let mut creative = engine_for(&prepared, EconomyPreset::Creative, 0);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_topology = standard.road_topology_for_test().clone();
    let creative_topology = creative.road_topology_for_test().clone();
    let intent = GameIntent::PlaceRoundabout {
        origin: point(-1, 0),
        size: RoundaboutSize::Compact2x2,
    };

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(!standard_result.applied);
    assert!(!creative_result.applied);
    assert_eq!(standard_result.rejection, creative_result.rejection);
    assert_eq!(
        standard_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::OutOfBounds)
    );
    assert_eq!(standard.snapshot(), standard_before);
    assert_eq!(creative.snapshot(), creative_before);
    assert_eq!(standard.road_topology_for_test(), &standard_topology);
    assert_eq!(creative.road_topology_for_test(), &creative_topology);
}

#[test]
fn unsafe_port_mapping_and_structure_ownership_reject_identically_in_both_presets() {
    let mut unsafe_mapping = GameEngine::new();
    road_line(&mut unsafe_mapping, (2..=10).map(|x| point(x, 5)).collect());
    let mut unsafe_snapshot = unsafe_mapping.snapshot();
    unsafe_snapshot.map.tile_mut(point(4, 5)).unwrap().one_way = Some(Heading::North);

    let mut structure_owned = GameEngine::new();
    dispatch(
        &mut structure_owned,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    let structure_snapshot = structure_owned.snapshot();

    let mut unsafe_standard = unsafe_snapshot.clone();
    unsafe_standard.rules.economy_preset = EconomyPreset::Standard;
    unsafe_standard.budget = 10_000;
    let mut unsafe_creative = unsafe_snapshot;
    unsafe_creative.rules.economy_preset = EconomyPreset::Creative;
    unsafe_creative.budget = 10_000;
    let unsafe_standard_rejection = match caelum_core::roundabouts::place_roundabout(
        &unsafe_standard,
        point(5, 4),
        RoundaboutSize::Standard3x3,
    ) {
        Ok(_) => panic!("unsafe port mapping should reject"),
        Err(rejection) => rejection,
    };
    let unsafe_creative_rejection = match caelum_core::roundabouts::place_roundabout(
        &unsafe_creative,
        point(5, 4),
        RoundaboutSize::Standard3x3,
    ) {
        Ok(_) => panic!("unsafe port mapping should reject"),
        Err(rejection) => rejection,
    };
    assert_eq!(unsafe_standard_rejection, unsafe_creative_rejection);
    assert_eq!(
        unsafe_standard_rejection.code,
        RejectionCode::UnsafeRoundaboutPortMapping
    );

    let intent = GameIntent::PlaceRoundabout {
        origin: point(5, 5),
        size: RoundaboutSize::Compact2x2,
    };
    let mut standard = engine_for(&structure_snapshot, EconomyPreset::Standard, 10_000);
    let mut creative = engine_for(&structure_snapshot, EconomyPreset::Creative, 10_000);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(!standard_result.applied, "{standard_result:?}");
    assert!(!creative_result.applied, "{creative_result:?}");
    assert_eq!(standard_result.rejection, creative_result.rejection);
    assert_eq!(
        standard_result.rejection.as_ref().unwrap().code,
        RejectionCode::BlockedFootprint
    );
    assert_eq!(standard.snapshot(), standard_before);
    assert_eq!(creative.snapshot(), creative_before);
}

#[test]
fn tracks_transit_nodes_and_buildings_reject_the_whole_placement() {
    let mut track = GameEngine::new();
    dispatch(&mut track, GameIntent::LayTrack { point: point(5, 5) });

    let mut node = GameEngine::new();
    dispatch(
        &mut node,
        GameIntent::LayRoadLine {
            points: points(&[(5, 6), (6, 6)]),
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(&mut node, GameIntent::AddBusStop { point: point(5, 5) });

    let mut building = GameEngine::new();
    dispatch(
        &mut building,
        GameIntent::PaintAreaRectangle {
            area: "residential".into(),
            start: point(5, 5),
            end: point(6, 5),
        },
    );
    dispatch(
        &mut building,
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".into(),
            origin: point(5, 5),
            rotation: 0,
        },
    );

    for mut engine in [track, node, building] {
        let before = engine.snapshot();
        let result = engine.dispatch(GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        });
        assert!(!result.applied);
        assert_eq!(
            result.rejection.unwrap().code,
            RejectionCode::BlockedFootprint
        );
        assert_eq!(result.snapshot, before);
    }
}

#[test]
fn removing_any_member_removes_the_structure_once_and_never_restores_old_roads() {
    // Paint a residential area over the roundabout footprint BEFORE laying
    // roads, so the latent area is non-`None`. Without this, the latent-area
    // assertion below is a tautology (`None == None`) because `crossing_engine`
    // never paints areas. Painting first means road tiles carry the area as
    // latent state; the roundabout preserves it; removal must restore it.
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: point(5, 4),
            end: point(7, 6),
        },
    );
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    road_line(&mut engine, (1..=9).map(|y| point(6, y)).collect());
    dispatch(&mut engine, place_standard_roundabout());
    let structure = only_roundabout(&engine.snapshot()).clone();
    let budget_after_placement = engine.snapshot().budget;
    let latent_areas: Vec<_> = structure
        .footprint()
        .iter()
        .map(|point| engine.snapshot().map.tile(*point).unwrap().area.clone())
        .collect();
    // Verify the latent areas are actually non-None (the test would be
    // vacuous otherwise).
    assert!(
        latent_areas
            .iter()
            .all(|area| area.as_deref() == Some("residential")),
        "footprint tiles should carry residential latent area, got {latent_areas:?}"
    );
    let result = engine.dispatch(GameIntent::RemoveAtTiles {
        points: vec![structure.footprint()[0], structure.footprint()[4]],
    });

    assert!(result.applied, "{result:?}");
    assert_eq!(result.snapshot.budget, budget_after_placement);
    assert!(result
        .snapshot
        .map
        .road_structures
        .iter()
        .all(|candidate| candidate.id() != structure.id()));
    for (point, latent_area) in structure.footprint().iter().zip(latent_areas) {
        let tile = result.snapshot.map.tile(*point).unwrap();
        assert!(tile.road_structure_id.is_none());
        assert_ne!(tile.kind, "road");
        assert_eq!(tile.area, latent_area);
    }
}

#[test]
fn preview_matches_roundabout_cost_footprint_ports_and_structure() {
    let engine = crossing_engine();
    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 41,
        mutation: RoadMutation::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    });
    assert!(response.rejection.is_none(), "{response:?}");
    assert_eq!(response.generation, 41);
    assert_eq!(response.cost, 2_000);
    assert_eq!(
        response.changed_tiles,
        roundabout_template(RoundaboutSize::Standard3x3, point(5, 4)).footprint
    );
    assert_eq!(response.generated_structures.len(), 1);
    assert_eq!(
        response.generated_structures[0].port_keys(),
        vec![
            (point(5, 5), Heading::West),
            (point(6, 4), Heading::North),
            (point(6, 6), Heading::South),
            (point(7, 5), Heading::East),
        ]
    );
}

#[test]
fn low_budget_roundabout_preview_rejects_standard_and_preserves_creative_without_mutation() {
    let prepared = GameEngine::new().snapshot();
    for (origin, size) in [
        (point(5, 5), RoundaboutSize::Compact2x2),
        (point(9, 8), RoundaboutSize::Standard3x3),
    ] {
        let cost = match size {
            RoundaboutSize::Compact2x2 => COMPACT_ROUNDABOUT_COST,
            RoundaboutSize::Standard3x3 => STANDARD_ROUNDABOUT_COST,
        };
        let standard = engine_for(&prepared, EconomyPreset::Standard, cost - 1);
        let creative = engine_for(&prepared, EconomyPreset::Creative, cost - 1);
        let standard_before = standard.snapshot();
        let creative_before = creative.snapshot();
        let standard_topology = standard.road_topology_for_test().clone();
        let creative_topology = creative.road_topology_for_test().clone();
        let request = |generation| RoadMutationPreviewRequest {
            generation,
            mutation: RoadMutation::PlaceRoundabout { origin, size },
        };

        let standard_response = standard.preview_road_mutation(request(61));
        let creative_response = creative.preview_road_mutation(request(62));

        let standard_rejection = standard_response.rejection.expect("budget rejection");
        assert_eq!(standard_rejection.code, RejectionCode::InsufficientBudget);
        assert_eq!(standard_rejection.context.required_budget, Some(cost));
        assert_eq!(standard_rejection.context.available_budget, Some(cost - 1));
        assert_eq!(standard_response.cost, cost);
        assert!(
            creative_response.rejection.is_none(),
            "{creative_response:?}"
        );
        assert_eq!(creative_response.cost, cost);
        assert_eq!(standard.snapshot(), standard_before);
        assert_eq!(creative.snapshot(), creative_before);
        assert_eq!(standard.road_topology_for_test(), &standard_topology);
        assert_eq!(creative.road_topology_for_test(), &creative_topology);
    }
}

#[test]
fn blocked_roundabout_preview_keeps_attempted_geometry_and_cost_without_mutation() {
    let mut engine = GameEngine::new();
    dispatch(&mut engine, GameIntent::LayTrack { point: point(5, 5) });
    let before = engine.snapshot();
    let topology = engine.road_topology_for_test().clone();
    let template = roundabout_template(RoundaboutSize::Standard3x3, point(5, 5));

    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 42,
        mutation: RoadMutation::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Standard3x3,
        },
    });

    assert_eq!(
        response
            .rejection
            .as_ref()
            .map(|rejection| rejection.code.clone()),
        Some(RejectionCode::BlockedFootprint)
    );
    assert_eq!(response.changed_tiles, template.footprint);
    assert_eq!(response.cost, STANDARD_ROUNDABOUT_COST);
    assert!(matches!(
        response.generated_structures.as_slice(),
        [RoadStructure::Roundabout {
            origin,
            size: RoundaboutSize::Standard3x3,
            footprint,
            ..
        }] if *origin == point(5, 5) && *footprint == template.footprint
    ));
    assert_eq!(engine.snapshot(), before);
    assert_eq!(engine.road_topology_for_test(), &topology);
}

#[test]
fn out_of_bounds_roundabout_preview_keeps_full_off_map_footprint_and_anchor() {
    let engine = GameEngine::new();
    let before = engine.snapshot();
    let template = roundabout_template(RoundaboutSize::Compact2x2, point(-1, 0));

    let response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 43,
        mutation: RoadMutation::PlaceRoundabout {
            origin: point(-1, 0),
            size: RoundaboutSize::Compact2x2,
        },
    });

    assert_eq!(
        response
            .rejection
            .as_ref()
            .map(|rejection| rejection.code.clone()),
        Some(RejectionCode::OutOfBounds)
    );
    assert_eq!(response.changed_tiles, template.footprint);
    assert_eq!(response.changed_tiles.first(), Some(&point(-1, 0)));
    assert_eq!(response.cost, COMPACT_ROUNDABOUT_COST);
    assert_eq!(response.generated_structures.len(), 1);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn unsafe_port_preview_keeps_relevant_boundary_port_and_attempted_structure() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    let mut snapshot = engine.snapshot();
    snapshot.map.tile_mut(point(4, 5)).unwrap().one_way = Some(Heading::North);
    let before = snapshot.clone();
    let template = roundabout_template(RoundaboutSize::Standard3x3, point(5, 4));

    let response = caelum_core::preview::preview_road_mutation(
        &snapshot,
        RoadMutationPreviewRequest {
            generation: 44,
            mutation: RoadMutation::PlaceRoundabout {
                origin: point(5, 4),
                size: RoundaboutSize::Standard3x3,
            },
        },
    );

    assert_eq!(
        response
            .rejection
            .as_ref()
            .map(|rejection| rejection.code.clone()),
        Some(RejectionCode::UnsafeRoundaboutPortMapping)
    );
    assert_eq!(response.changed_tiles, template.footprint);
    assert_eq!(response.cost, STANDARD_ROUNDABOUT_COST);
    assert!(response.generated_structures[0]
        .port_keys()
        .contains(&(point(5, 5), Heading::West)));
    assert_eq!(snapshot, before);
}

#[test]
fn every_roundabout_owned_tile_blocks_other_infrastructure_and_zoning() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    );
    let before = engine.snapshot();
    for intent in [
        GameIntent::LayRoad { point: point(6, 5) },
        GameIntent::LayTrack { point: point(5, 4) },
        GameIntent::AddBusStop { point: point(5, 4) },
        GameIntent::PaintAreaRectangle {
            area: "residential".into(),
            start: point(6, 5),
            end: point(6, 5),
        },
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".into(),
            origin: point(6, 5),
            rotation: 0,
        },
    ] {
        let result = engine.dispatch(intent);
        assert!(!result.applied, "{result:?}");
        assert!(result.rejection.is_some());
        assert_eq!(result.snapshot, before);
    }
}

#[test]
fn removing_roundabout_recomputes_an_adjacent_automatic_junction_in_preview_and_commit() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    road_line(&mut engine, (2..=8).map(|y| point(4, y)).collect());
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 4),
            size: RoundaboutSize::Standard3x3,
        },
    );
    let old_junction = engine
        .snapshot()
        .map
        .road_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction() && structure.footprint().contains(&point(4, 5))
        })
        .expect("adjacent automatic junction")
        .clone();
    assert!(old_junction
        .port_keys()
        .contains(&(point(4, 5), Heading::East)));

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        generation: 52,
        mutation: RoadMutation::RemoveAtTile { point: point(6, 5) },
    });
    assert!(preview.rejection.is_none(), "{preview:?}");
    let regenerated = preview
        .generated_structures
        .iter()
        .find(|structure| {
            structure.is_automatic_junction() && structure.footprint().contains(&point(4, 5))
        })
        .expect("preview regenerates adjacent junction");
    assert_ne!(regenerated.id(), old_junction.id());
    assert!(!regenerated
        .port_keys()
        .contains(&(point(4, 5), Heading::East)));

    let committed = engine.dispatch(GameIntent::RemoveAtTile { point: point(6, 5) });
    assert!(committed.applied, "{committed:?}");
    assert!(committed
        .snapshot
        .map
        .road_structures
        .iter()
        .all(|structure| structure.id() != old_junction.id()));
    assert_eq!(
        committed
            .snapshot
            .map
            .tile(point(4, 5))
            .unwrap()
            .road_structure_id
            .as_deref(),
        Some(regenerated.id())
    );
}

#[test]
fn laying_an_approach_after_empty_placement_attaches_a_boundary_port() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    assert!(only_roundabout(&engine.snapshot()).ports().is_empty());

    // North of the NW footprint tile (5,5): approach (5,4) attaches south→north port.
    dispatch(&mut engine, GameIntent::LayRoad { point: point(5, 4) });

    let snapshot = engine.snapshot();
    let structure = only_roundabout(&snapshot);
    assert_eq!(structure.port_keys(), vec![(point(5, 5), Heading::North)]);
    assert!(snapshot
        .map
        .tile(point(5, 4))
        .unwrap()
        .road_connections
        .contains(&Heading::South));
    assert!(snapshot
        .map
        .tile(point(5, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::North));
    assert_eq!(
        snapshot
            .map
            .tile(point(5, 5))
            .unwrap()
            .road_structure_id
            .as_deref(),
        Some(structure.id())
    );
}

#[test]
fn demolishing_an_approach_drops_the_detached_port_from_the_structure() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    dispatch(&mut engine, GameIntent::LayRoad { point: point(5, 4) });
    assert_eq!(only_roundabout(&engine.snapshot()).ports().len(), 1);

    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(5, 4) });

    let snapshot = engine.snapshot();
    assert!(only_roundabout(&snapshot).ports().is_empty());
    assert!(!snapshot
        .map
        .tile(point(5, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::North));
}

#[test]
fn removing_a_roundabout_built_on_a_neighbors_approach_drops_the_stale_port() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    // Approach road on (5,4) attaches a north port to A at (5,5).
    dispatch(&mut engine, GameIntent::LayRoad { point: point(5, 4) });
    assert_eq!(
        only_roundabout(&engine.snapshot()).port_keys(),
        vec![(point(5, 5), Heading::North)]
    );

    // Build roundabout B whose footprint replaces A's approach road tile (5,4).
    // B's footprint (5,3),(6,3),(5,4),(6,4) captures a reciprocal south port at
    // (5,4) facing A's (5,5); A's existing north port now points at B's tile.
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 3),
            size: RoundaboutSize::Compact2x2,
        },
    );
    let a_id = only_roundabout_a(&engine.snapshot()).id().to_string();
    assert_eq!(
        roundabout_with_id(&engine.snapshot(), &a_id).port_keys(),
        vec![(point(5, 5), Heading::North)],
        "A's port should still target B's footprint tile while B exists"
    );

    // Remove B. Without `sync_roundabout_ports`, A's north port would remain
    // pointing at the now-empty (5,4) tile, leaving a stale port in the
    // serialized snapshot and a dangling renderer stub.
    dispatch(&mut engine, GameIntent::RemoveAtTile { point: point(5, 3) });

    let snapshot = engine.snapshot();
    assert!(
        roundabout_with_id(&snapshot, &a_id).ports().is_empty(),
        "surviving roundabout ports must be resynced after neighbor removal"
    );
    assert!(!snapshot
        .map
        .tile(point(5, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::North));
    assert_eq!(snapshot.map.tile(point(5, 4)).unwrap().kind, "empty");
}

#[test]
fn approach_line_ending_at_roundabout_attaches_and_is_routable() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(5, 5),
            size: RoundaboutSize::Compact2x2,
        },
    );
    // Line from further north down to the approach cell.
    road_line(&mut engine, (2..=4).map(|y| point(5, y)).collect());

    let snapshot = engine.snapshot();
    assert_eq!(
        only_roundabout(&snapshot).port_keys(),
        vec![(point(5, 5), Heading::North)]
    );
    let topology = caelum_core::road_topology::RoadTopology::compile(&snapshot.map)
        .expect("topology must compile after approach attach");
    let path = topology
        .find_path_between_access_tiles(&snapshot.map, point(5, 2), point(5, 5), None, None)
        .expect("approach must reach the attached port tile");
    assert!(path.total_travel_seconds() > 0.0);
}

#[test]
fn perpendicular_one_way_boundary_lane_rejects_with_the_complete_footprint() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, (2..=10).map(|x| point(x, 5)).collect());
    let mut snapshot = engine.snapshot();
    snapshot.map.tile_mut(point(4, 5)).unwrap().one_way = Some(Heading::North);
    let before = snapshot.clone();
    let template = roundabout_template(RoundaboutSize::Standard3x3, point(5, 4));

    let rejection = match caelum_core::roundabouts::place_roundabout(
        &snapshot,
        point(5, 4),
        RoundaboutSize::Standard3x3,
    ) {
        Ok(_) => panic!("perpendicular lane is unsafe"),
        Err(rejection) => rejection,
    };
    assert_eq!(rejection.code, RejectionCode::UnsafeRoundaboutPortMapping);
    assert_eq!(rejection.context.footprint, template.footprint);
    assert_eq!(snapshot, before);
}
