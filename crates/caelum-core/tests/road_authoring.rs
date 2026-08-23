use caelum_core::model::{
    EconomyPreset, GameMap, GameSnapshot, Heading, Point, RoadStructure, RoundaboutSize,
};
use caelum_core::road::{apply_road_mutation, RoadMutation};
use caelum_core::state::create_initial_snapshot;
use caelum_core::transit::ROAD_COST;
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadMutationPreviewRequest, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn one_way_engine(points: Vec<Point>) -> GameEngine {
    let mut request = caelum_core::canonical_default_request();
    request.template_id = "blankGrid".to_string();
    let mut engine = GameEngine::from_sandbox_request(request)
        .expect("blank grid fixture request should remain valid");
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::OneWay,
    });
    assert!(result.applied, "fixture OneWay should apply: {result:?}");
    engine
}

fn horizontal_points(y: i32) -> Vec<Point> {
    (2..=25).map(|x| point(x, y)).collect()
}

fn vertical_points(x: i32) -> Vec<Point> {
    (1..=16).map(|y| point(x, y)).collect()
}

fn lay_dual_horizontal(engine: &mut GameEngine, north_y: i32) {
    engine.dispatch(GameIntent::LayRoadLine {
        points: horizontal_points(north_y + 1),
        preset: RoadPreset::DualBidirectional,
    });
}

fn lay_dual_vertical(engine: &mut GameEngine, west_x: i32) {
    engine.dispatch(GameIntent::LayRoadLine {
        points: vertical_points(west_x),
        preset: RoadPreset::DualBidirectional,
    });
}

fn crossing_engine() -> (GameEngine, String) {
    let mut engine = GameEngine::new();
    lay_dual_horizontal(&mut engine, 8);
    lay_dual_vertical(&mut engine, 14);
    let id = engine
        .snapshot()
        .map
        .road_structures
        .iter()
        .find(|structure| structure.is_automatic_junction())
        .expect("crossing must generate a junction")
        .id()
        .to_string();
    (engine, id)
}

fn remove_points(engine: &mut GameEngine, points: &[Point]) {
    let result = engine.dispatch(GameIntent::RemoveAtTiles {
        points: points.to_vec(),
    });
    assert!(result.applied, "road removal should apply: {result:?}");
}

fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

fn offset(point: Point, heading: Heading) -> Point {
    match heading {
        Heading::North => Point {
            x: point.x,
            y: point.y - 1,
        },
        Heading::East => Point {
            x: point.x + 1,
            y: point.y,
        },
        Heading::South => Point {
            x: point.x,
            y: point.y + 1,
        },
        Heading::West => Point {
            x: point.x - 1,
            y: point.y,
        },
    }
}

fn assert_reciprocal_connections(map: &GameMap) {
    for tile in &map.tiles {
        let from = point(tile.x, tile.y);
        for heading in &tile.road_connections {
            let neighbor_point = offset(from, *heading);
            let neighbor = map
                .tile(neighbor_point)
                .unwrap_or_else(|| panic!("connection from {from:?} exits the map"));
            assert!(
                neighbor.road_connections.contains(&opposite(*heading)),
                "connection {from:?} {heading:?} is not reciprocal"
            );
        }
    }
}

fn stroke_fixture_with_budget(budget: i32) -> GameSnapshot {
    let mut state = create_initial_snapshot();
    state.budget = budget;
    state
        .map
        .tiles
        .iter_mut()
        .find(|tile| tile.x == 3 && tile.y == 2)
        .expect("fixture tile exists")
        .kind = "blocked".to_string();
    state
}

fn isolated_parallel_lane_fixture() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    state.budget = 10_000;
    for points in [
        vec![point(2, 5), point(3, 5), point(4, 5)],
        vec![point(6, 5), point(7, 5), point(8, 5)],
        vec![point(4, 6), point(5, 6), point(6, 6)],
    ] {
        state = apply_road_mutation(
            &state,
            &RoadMutation::LayRoadLine {
                points,
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road line should be authored")
        .snapshot;
    }
    state
}

fn tile(state: &GameSnapshot, point: Point) -> &caelum_core::model::Tile {
    state.map.tile(point).expect("fixture tile exists")
}

fn snapshot_for_preset(state: &GameSnapshot, preset: EconomyPreset, budget: i32) -> GameSnapshot {
    let mut candidate = state.clone();
    candidate.rules.economy_preset = preset;
    candidate.budget = budget;
    candidate
}

#[test]
fn dual_bidirectional_crossing_preserves_both_corridors_and_lane_directions() {
    let mut engine = GameEngine::new();
    lay_dual_horizontal(&mut engine, 8);
    lay_dual_vertical(&mut engine, 14);

    let map = &engine.snapshot().map;
    let junction = map
        .road_structures
        .iter()
        .find(|structure| structure.is_automatic_junction())
        .expect("crossing must generate a junction");

    assert_eq!(
        junction.footprint(),
        &[point(14, 8), point(15, 8), point(14, 9), point(15, 9)]
    );
    assert_eq!(junction.ports().len(), 8);
    assert_eq!(map.tile(point(13, 8)).unwrap().one_way, Some(Heading::West));
    assert_eq!(map.tile(point(16, 8)).unwrap().one_way, Some(Heading::West));
    assert_eq!(
        map.tile(point(14, 7)).unwrap().one_way,
        Some(Heading::South)
    );
    assert_eq!(
        map.tile(point(14, 10)).unwrap().one_way,
        Some(Heading::South)
    );
}

#[test]
fn adjacent_opposing_lanes_do_not_connect_mid_block() {
    let mut engine = GameEngine::new();
    lay_dual_horizontal(&mut engine, 4);
    let map = &engine.snapshot().map;

    assert!(!map
        .tile(point(9, 4))
        .unwrap()
        .road_connections
        .contains(&Heading::South));
    assert!(!map
        .tile(point(9, 5))
        .unwrap()
        .road_connections
        .contains(&Heading::North));
}

#[test]
fn adjacent_same_direction_one_way_lanes_do_not_connect_laterally() {
    let mut engine = GameEngine::new();

    let standalone = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).rev().map(|x| point(x, 5)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(
        standalone.applied,
        "fixture OneWay should apply: {standalone:?}"
    );

    // East-canonical Dual at y=7 generates a westbound reverse lane at y=6,
    // adjacent to the westbound standalone lane at y=5.
    let dual = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 7)).collect(),
        preset: RoadPreset::DualBidirectional,
    });
    assert!(dual.applied, "fixture Dual should apply: {dual:?}");

    let map = &engine.snapshot().map;
    for x in [3, 10] {
        let outer = map.tile(point(x, 5)).expect("standalone endpoint");
        let inner = map.tile(point(x, 6)).expect("dual reverse endpoint");
        assert_eq!(outer.one_way, Some(Heading::West));
        assert_eq!(inner.one_way, Some(Heading::West));
        assert!(!outer.road_connections.contains(&Heading::South));
        assert!(!inner.road_connections.contains(&Heading::North));
        assert!(outer
            .road_connections
            .iter()
            .any(|edge| matches!(edge, Heading::East | Heading::West)));
        assert!(inner
            .road_connections
            .iter()
            .any(|edge| matches!(edge, Heading::East | Heading::West)));
    }
}

#[test]
fn standalone_one_way_spacing_is_three_tiles_and_longitudinally_local() {
    for y in [6, 7] {
        let mut engine = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
        let before = engine.snapshot();
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (3..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::OneWay,
        });
        assert!(!result.applied);
        assert_eq!(
            result.rejection.as_ref().map(|rejection| &rejection.code),
            Some(&RejectionCode::OneWayParallelTooClose),
        );
        assert_eq!(result.snapshot, before);
    }

    let mut distance_three = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    assert!(
        distance_three
            .dispatch(GameIntent::LayRoadLine {
                points: (3..=10).map(|x| point(x, 8)).collect(),
                preset: RoadPreset::OneWay,
            })
            .applied
    );

    let mut non_overlapping = one_way_engine((3..=6).map(|x| point(x, 5)).collect());
    assert!(
        non_overlapping
            .dispatch(GameIntent::LayRoadLine {
                points: (8..=12).map(|x| point(x, 6)).collect(),
                preset: RoadPreset::OneWay,
            })
            .applied
    );

    let mut crossing = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    assert!(
        crossing
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=8).map(|y| point(6, y)).collect(),
                preset: RoadPreset::OneWay,
            })
            .applied
    );
}

#[test]
fn standalone_one_way_checks_existing_dual_lane_but_dual_self_authoring_remains_legal() {
    let mut engine = GameEngine::new();
    let dual = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 10)).collect(),
        preset: RoadPreset::DualBidirectional,
    });
    assert!(
        dual.applied,
        "Dual must self-author its paired lane: {dual:?}"
    );

    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 12)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OneWayParallelTooClose),
    );
    assert_eq!(result.snapshot, before);
}

#[test]
fn one_way_overlay_is_checked_before_merge_lane_direction() {
    let mut engine = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    let two_way = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 7)).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(two_way.applied, "TwoWay fixture should apply: {two_way:?}");

    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 7)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OneWayParallelTooClose),
    );
    assert_eq!(result.snapshot, before);
}

#[test]
fn one_way_spacing_rejection_matches_preview_and_commit() {
    let mut engine = one_way_engine((3..=10).map(|x| point(x, 5)).collect());
    let mutation = RoadMutation::LayRoadLine {
        points: (3..=10).map(|x| point(x, 6)).collect(),
        preset: RoadPreset::OneWay,
    };

    let preview = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: mutation.clone(),
        generation: 1,
    });
    assert_eq!(
        preview.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OneWayParallelTooClose),
    );

    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: (3..=10).map(|x| point(x, 6)).collect(),
        preset: RoadPreset::OneWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::OneWayParallelTooClose),
    );
    assert_eq!(result.snapshot, before);
}

#[test]
fn direction_edit_removes_inherited_parallel_one_way_lateral_link() {
    let mut engine = GameEngine::new();
    for y in [5, 6] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (3..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture TwoWay should apply: {result:?}");
    }

    let before = engine.snapshot();
    assert!(before
        .map
        .tile(point(3, 5))
        .expect("upper endpoint")
        .road_connections
        .contains(&Heading::South));

    // None -> North -> East on each endpoint.
    for point in [point(3, 5), point(3, 6)] {
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
    }

    let map = &engine.snapshot().map;
    let upper = map.tile(point(3, 5)).expect("upper endpoint");
    let lower = map.tile(point(3, 6)).expect("lower endpoint");
    assert_eq!(upper.one_way, Some(Heading::East));
    assert_eq!(lower.one_way, Some(Heading::East));
    assert!(!upper.road_connections.contains(&Heading::South));
    assert!(!lower.road_connections.contains(&Heading::North));
    assert!(upper.road_connections.contains(&Heading::East));
    assert!(lower.road_connections.contains(&Heading::East));
}

#[test]
fn direction_edit_endpoints_strip_upstream_and_keep_downstream_lateral_links() {
    let mut engine = GameEngine::new();
    for y in [5, 6] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (3..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture TwoWay should apply: {result:?}");
    }

    // Left (upstream) ends: arrows point into the lanes, so the arrow-aligned
    // continuation evidence holds and the inherited bridge is stripped.
    for point in [point(3, 5), point(3, 6)] {
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
    }
    let map = &engine.snapshot().map;
    assert!(!map
        .tile(point(3, 5))
        .expect("upstream upper endpoint")
        .road_connections
        .contains(&Heading::South));
    assert!(!map
        .tile(point(3, 6))
        .expect("upstream lower endpoint")
        .road_connections
        .contains(&Heading::North));

    // Right (downstream) ends: arrows point off the lane ends, so no
    // arrow-aligned continuation exists. This state is a rotation of the
    // protected 2x2-loop transient (loop_with_spur_repro), and keeping the
    // dead-end bridge is the accepted cost of preserving ring edges.
    for point in [point(10, 5), point(10, 6)] {
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
    }
    let map = &engine.snapshot().map;
    let upper = map.tile(point(10, 5)).expect("downstream upper endpoint");
    let lower = map.tile(point(10, 6)).expect("downstream lower endpoint");
    assert_eq!(upper.one_way, Some(Heading::East));
    assert_eq!(lower.one_way, Some(Heading::East));
    assert!(upper.road_connections.contains(&Heading::South));
    assert!(lower.road_connections.contains(&Heading::North));
    assert!(upper.road_connections.contains(&Heading::West));
    assert!(lower.road_connections.contains(&Heading::West));
}

#[test]
fn direction_cycle_intermediate_state_preserves_through_edges() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![point(3, 5), point(4, 5)],
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied, "fixture TwoWay should apply: {result:?}");

    // One step per tile across separate dispatches: both arrows are transiently
    // North while the real through-edge between them stays East/West.
    for point in [point(3, 5), point(4, 5)] {
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
    }

    let map = &engine.snapshot().map;
    assert!(map
        .tile(point(3, 5))
        .expect("west tile")
        .road_connections
        .contains(&Heading::East));
    assert!(map
        .tile(point(4, 5))
        .expect("east tile")
        .road_connections
        .contains(&Heading::West));

    for point in [point(3, 5), point(4, 5)] {
        assert!(
            engine
                .dispatch(GameIntent::CycleRoadDirection { point })
                .applied
        );
    }

    let map = &engine.snapshot().map;
    assert_eq!(map.tile(point(3, 5)).unwrap().one_way, Some(Heading::East));
    assert_eq!(map.tile(point(4, 5)).unwrap().one_way, Some(Heading::East));
    assert!(map
        .tile(point(3, 5))
        .expect("west tile")
        .road_connections
        .contains(&Heading::East));
    assert!(map
        .tile(point(4, 5))
        .expect("east tile")
        .road_connections
        .contains(&Heading::West));
}

#[test]
fn restored_road_endpoint_connects_to_new_adjacent_stroke() {
    let mut engine = GameEngine::new();
    let first = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![point(1, 1), point(2, 1), point(3, 1)],
        preset: RoadPreset::TwoWay,
    });
    assert!(first.applied);

    let saved = engine.snapshot_for_save();
    let mut restored = GameEngine::from_snapshot(saved).expect("saved road snapshot restores");
    let second = restored.dispatch(GameIntent::LayRoadLine {
        points: vec![point(1, 2), point(2, 2), point(3, 2)],
        preset: RoadPreset::TwoWay,
    });
    assert!(second.applied);

    let map = &restored.snapshot().map;
    assert!(map
        .tile(point(1, 1))
        .unwrap()
        .road_connections
        .contains(&Heading::South));
    assert!(map
        .tile(point(1, 2))
        .unwrap()
        .road_connections
        .contains(&Heading::North));
}

#[test]
fn removing_one_crossing_arm_regenerates_or_dissolves_the_junction() {
    let (mut engine, original_id) = crossing_engine();
    remove_points(&mut engine, &[point(14, 7), point(15, 7)]);

    let remaining = &engine.snapshot().map.road_structures;
    assert!(remaining
        .iter()
        .all(|structure| structure.id() != original_id));
    assert_reciprocal_connections(&engine.snapshot().map);
}

#[test]
fn removing_both_vertical_approaches_dissolves_orphaned_crossing_edges() {
    let (mut engine, _) = crossing_engine();
    remove_points(
        &mut engine,
        &[point(14, 7), point(15, 7), point(14, 10), point(15, 10)],
    );

    let map = &engine.snapshot().map;
    assert!(map
        .road_structures
        .iter()
        .all(|structure| !structure.is_automatic_junction()));
    assert!(!map
        .tile(point(14, 8))
        .unwrap()
        .road_connections
        .contains(&Heading::South));
    assert_eq!(map.tile(point(14, 8)).unwrap().one_way, Some(Heading::West));
    assert_reciprocal_connections(map);
}

#[test]
fn cycling_a_structure_tile_is_a_silent_no_op() {
    let (mut engine, _) = crossing_engine();
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::CycleRoadDirection {
        point: point(14, 8),
    });

    assert!(!result.applied);
    assert!(result.rejection.is_none());
    assert_eq!(result.snapshot, before);
}

#[test]
fn partial_stroke_skips_invalid_tiles_in_input_order() {
    let state = stroke_fixture_with_budget(ROAD_COST * 2);
    let result = apply_road_mutation(
        &state,
        &RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2), point(4, 2), point(5, 2)],
            preset: RoadPreset::TwoWay,
        },
    )
    .unwrap();
    assert_eq!(result.changed_tiles, vec![point(2, 2), point(4, 2)]);
    assert_eq!(result.skipped_tiles, vec![point(3, 2), point(5, 2)]);
    assert_eq!(result.snapshot.budget, state.budget - ROAD_COST * 2);
}

#[test]
fn budget_limited_road_stroke_diverges_only_by_ordered_affordability() {
    let prepared = create_initial_snapshot();
    let mutation = RoadMutation::LayRoadLine {
        points: vec![point(2, 2), point(3, 2), point(4, 2)],
        preset: RoadPreset::TwoWay,
    };
    let standard = apply_road_mutation(
        &snapshot_for_preset(&prepared, EconomyPreset::Standard, ROAD_COST * 2),
        &mutation,
    )
    .expect("standard stroke should partially apply");
    let creative = apply_road_mutation(
        &snapshot_for_preset(&prepared, EconomyPreset::Creative, ROAD_COST * 2),
        &mutation,
    )
    .expect("creative stroke should apply");

    assert_eq!(standard.changed_tiles, vec![point(2, 2), point(3, 2)]);
    assert_eq!(standard.skipped_tiles, vec![point(4, 2)]);
    assert_eq!(standard.cost, ROAD_COST * 2);
    assert_eq!(standard.snapshot.budget, 0);
    assert_eq!(
        creative.changed_tiles,
        vec![point(2, 2), point(3, 2), point(4, 2)]
    );
    assert!(creative.skipped_tiles.is_empty());
    assert_eq!(creative.cost, ROAD_COST * 3);
    assert_eq!(creative.snapshot.budget, ROAD_COST * 2);
}

#[test]
fn road_stroke_keeps_scanning_to_a_later_free_existing_road_overlay() {
    let initial = create_initial_snapshot();
    let prepared = apply_road_mutation(&initial, &RoadMutation::LayRoad { point: point(4, 2) })
        .expect("fixture road should apply")
        .snapshot;
    let state = snapshot_for_preset(&prepared, EconomyPreset::Standard, ROAD_COST);

    let result = apply_road_mutation(
        &state,
        &RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2), point(4, 2)],
            preset: RoadPreset::OneWay,
        },
    )
    .expect("stroke should retain the free existing overlay");

    assert_eq!(result.changed_tiles, vec![point(2, 2), point(4, 2)]);
    assert_eq!(result.skipped_tiles, vec![point(3, 2)]);
    assert_eq!(result.cost, ROAD_COST);
    assert_eq!(result.snapshot.budget, 0);
    assert_eq!(
        tile(&result.snapshot, point(4, 2)).one_way,
        Some(Heading::East)
    );
}

#[test]
fn duplicate_road_points_contribute_nominal_cost_once() {
    let prepared = create_initial_snapshot();
    let mutation = RoadMutation::LayRoadLine {
        points: vec![point(2, 2), point(2, 2), point(2, 2)],
        preset: RoadPreset::TwoWay,
    };

    for preset in [EconomyPreset::Standard, EconomyPreset::Creative] {
        let budget = ROAD_COST;
        let result =
            apply_road_mutation(&snapshot_for_preset(&prepared, preset, budget), &mutation)
                .expect("duplicate stroke should author its unique tile once");

        assert_eq!(result.changed_tiles, vec![point(2, 2)]);
        assert!(result.skipped_tiles.is_empty());
        assert_eq!(result.cost, ROAD_COST);
        assert_eq!(
            result.snapshot.budget,
            if preset == EconomyPreset::Standard {
                0
            } else {
                budget
            }
        );
    }
}

#[test]
fn dual_bidirectional_overlapping_carriageways_charge_each_new_tile_once() {
    let prepared = create_initial_snapshot();
    let mutation = RoadMutation::LayRoadLine {
        // The reverse east-bound carriageway is shifted north, so its middle
        // point overlaps the final forward-carriageway point at (4, 2).
        points: vec![point(3, 3), point(4, 3), point(4, 2)],
        preset: RoadPreset::DualBidirectional,
    };

    for preset in [EconomyPreset::Standard, EconomyPreset::Creative] {
        let budget = ROAD_COST * 5;
        let result =
            apply_road_mutation(&snapshot_for_preset(&prepared, preset, budget), &mutation)
                .expect("overlapping dual stroke should apply");

        assert_eq!(result.cost, ROAD_COST * 5);
        assert_eq!(
            result.snapshot.budget,
            if preset == EconomyPreset::Standard {
                0
            } else {
                budget
            }
        );
    }
}

#[test]
fn fully_skipped_paired_stroke_retains_invalid_road_stroke() {
    let mut prepared = create_initial_snapshot();
    prepared.map.tile_mut(point(2, 2)).unwrap().kind = "blocked".to_string();
    let mutation = RoadMutation::LayRoadLine {
        points: vec![point(2, 2)],
        preset: RoadPreset::TwoWay,
    };

    for preset in [EconomyPreset::Standard, EconomyPreset::Creative] {
        let state = snapshot_for_preset(&prepared, preset, ROAD_COST);
        let rejection = match apply_road_mutation(&state, &mutation) {
            Ok(_) => panic!("fully skipped stroke should reject"),
            Err(rejection) => rejection,
        };
        assert_eq!(rejection.code, RejectionCode::InvalidRoadStroke);
        assert_eq!(rejection.context.point, Some(point(2, 2)));
    }
}

#[test]
fn single_road_is_budget_first_in_standard_and_geometry_first_in_creative() {
    let prepared = create_initial_snapshot();
    let mut standard = GameEngine::from_snapshot(snapshot_for_preset(
        &prepared,
        EconomyPreset::Standard,
        ROAD_COST - 1,
    ))
    .expect("standard fixture snapshot should be valid");
    let mut creative = GameEngine::from_snapshot(snapshot_for_preset(
        &prepared,
        EconomyPreset::Creative,
        ROAD_COST - 1,
    ))
    .expect("creative fixture snapshot should be valid");
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_topology = standard.road_topology_for_test().clone();
    let creative_topology = creative.road_topology_for_test().clone();

    let standard_result = standard.dispatch(GameIntent::LayRoad {
        point: point(-1, 0),
    });
    let creative_result = creative.dispatch(GameIntent::LayRoad {
        point: point(-1, 0),
    });
    let standard_rejection = standard_result.rejection.expect("standard rejection");
    let creative_rejection = creative_result.rejection.expect("creative rejection");

    assert_eq!(standard_rejection.code, RejectionCode::InsufficientBudget);
    assert_eq!(standard_rejection.context.required_budget, Some(ROAD_COST));
    assert_eq!(
        standard_rejection.context.available_budget,
        Some(ROAD_COST - 1)
    );
    assert_eq!(creative_rejection.code, RejectionCode::OutOfBounds);
    assert_eq!(creative_rejection.context.point, Some(point(-1, 0)));
    assert_eq!(standard.snapshot(), standard_before);
    assert_eq!(creative.snapshot(), creative_before);
    assert_eq!(standard.road_topology_for_test(), &standard_topology);
    assert_eq!(creative.road_topology_for_test(), &creative_topology);
}

#[test]
fn laying_a_road_against_an_automatic_junction_extends_its_ports() {
    let (mut engine, _junction_id) = crossing_engine();
    // Drop the north arm, then re-lay one approach tile against the junction.
    remove_points(&mut engine, &[point(14, 7), point(15, 7)]);
    let after_removal = engine
        .snapshot()
        .map
        .road_structures
        .iter()
        .find(|structure| structure.is_automatic_junction())
        .map(|structure| structure.ports().len());

    let result = engine.dispatch(GameIntent::LayRoad {
        point: point(14, 7),
    });
    assert!(result.applied, "{result:?}");
    let after_snapshot = engine.snapshot();
    let junction = after_snapshot
        .map
        .road_structures
        .iter()
        .find(|structure| structure.is_automatic_junction())
        .expect("junction should still exist or regenerate with the new arm");
    let after_ports = junction.ports().len();
    assert!(
        after_ports >= after_removal.unwrap_or(0),
        "re-laid approach must connect into the junction (after_removal={after_removal:?}, after={after_ports})"
    );
    assert!(
        junction
            .port_keys()
            .contains(&(point(14, 8), Heading::North)),
        "re-laid approach must restore the north-facing port adjoining (14, 7), got {:?}",
        junction.port_keys()
    );
    assert!(after_snapshot
        .map
        .tile(point(14, 7))
        .unwrap()
        .road_connections
        .contains(&Heading::South));
    assert_reciprocal_connections(&after_snapshot.map);
}

#[test]
fn single_point_road_connects_only_neighbor_endpoints() {
    let state = isolated_parallel_lane_fixture();
    let result =
        apply_road_mutation(&state, &RoadMutation::LayRoad { point: point(5, 5) }).unwrap();
    assert_eq!(
        tile(&result.snapshot, point(5, 5)).road_connections,
        vec![Heading::East, Heading::West]
    );
    assert!(tile(&result.snapshot, point(5, 6))
        .road_connections
        .iter()
        .all(|edge| *edge != Heading::North));
    assert_reciprocal_connections(&result.snapshot.map);
}

#[test]
fn unrelated_structure_ownership_is_independent_of_tile_kind() {
    let mut state = create_initial_snapshot();
    let structure_point = point(1, 1);
    state
        .map
        .tile_mut(structure_point)
        .expect("fixture tile exists")
        .road_structure_id = Some("roundabout-fixture".to_string());
    state.map.road_structures.push(RoadStructure::Roundabout {
        id: "roundabout-fixture".to_string(),
        origin: structure_point,
        size: RoundaboutSize::Compact2x2,
        footprint: vec![structure_point],
        ports: Vec::new(),
    });

    let result =
        apply_road_mutation(&state, &RoadMutation::LayRoad { point: point(2, 2) }).unwrap();

    assert_eq!(
        result
            .snapshot
            .map
            .tile(structure_point)
            .unwrap()
            .road_structure_id
            .as_deref(),
        Some("roundabout-fixture")
    );
}
