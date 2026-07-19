use caelum_core::model::{Point, RoundaboutSize, ServicePattern, TransitMode};
use caelum_core::preview::RoutePreviewRequest;
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn road_line(engine: &mut GameEngine, points: Vec<Point>, preset: RoadPreset) {
    let result = engine.dispatch(GameIntent::LayRoadLine { points, preset });
    assert!(result.applied, "road line should apply: {result:?}");
}

fn place_roundabout(engine: &mut GameEngine, origin: Point, size: RoundaboutSize) {
    let result = engine.dispatch(GameIntent::PlaceRoundabout { origin, size });
    assert!(result.applied, "roundabout should place: {result:?}");
}

fn paint_area(engine: &mut GameEngine, start: Point, end: Point, area: &str) {
    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: area.to_string(),
        start,
        end,
    });
    assert!(result.applied, "area paint should apply: {result:?}");
}

fn add_bus_stop(engine: &mut GameEngine, point: Point) -> String {
    let result = engine.dispatch(GameIntent::AddBusStop { point });
    assert!(result.applied, "bus stop should place: {result:?}");
    let snapshot = engine.snapshot();
    snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == point)
        .map(|stop| stop.id.clone())
        .expect("stop must exist after placement")
}

/// Reproduces the e2e roundabouts.spec.ts scenario for compact2x2.
/// The e2e test lays a 2-lane vertical road that crosses two 1-way horizontal
/// roads. The 2-lane road's endpoint cross-lane connections cause the junction
/// detector to include endpoint tiles in the cluster, which then has no
/// vertical ports, triggering pruning of ALL vertical internal edges.
#[test]
fn compact_roundabout_e2e_preview_is_connected() {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(500_000);

    let origin = point(6, 12);
    let width = 2;
    let bottom_y = origin.y + width - 1; // 13
    let right = 12;

    // 1. Paint latent residential area on roundabout footprint.
    paint_area(
        &mut engine,
        origin,
        point(origin.x + width - 1, origin.y + width - 1),
        "residential",
    );

    // 2. Seed approach roads — matching e2e test exactly.
    // One-way east at y=bottom (y=13)
    road_line(
        &mut engine,
        (1..=right).map(|x| point(x, bottom_y)).collect(),
        RoadPreset::OneWay,
    );
    // One-way west at y=origin.y (y=12)
    road_line(
        &mut engine,
        (1..=right).rev().map(|x| point(x, origin.y)).collect(),
        RoadPreset::OneWay,
    );
    // 2-Lane (dualBidirectional) vertical at x=1
    road_line(
        &mut engine,
        (origin.y - 1..=bottom_y + 1)
            .map(|y| point(origin.x - 5, y))
            .collect(),
        RoadPreset::DualBidirectional,
    );

    // Verify vertical road connectivity before roundabout placement.
    let map = &engine.snapshot().map;
    let tile_1_12 = map.tile(point(1, 12)).unwrap();
    let tile_1_13 = map.tile(point(1, 13)).unwrap();
    eprintln!(
        "Before roundabout: (1,12) connections={:?} oneWay={:?}",
        tile_1_12.road_connections, tile_1_12.one_way
    );
    eprintln!(
        "Before roundabout: (1,13) connections={:?} oneWay={:?}",
        tile_1_13.road_connections, tile_1_13.one_way
    );
    assert!(
        tile_1_12.road_connections.iter().any(|h| {
            matches!(
                h,
                caelum_core::model::Heading::North | caelum_core::model::Heading::South
            )
        }),
        "vertical road at (1,12) must have vertical connections before roundabout"
    );

    // 3. Place the roundabout.
    place_roundabout(&mut engine, origin, RoundaboutSize::Compact2x2);

    // Verify vertical road connectivity AFTER roundabout placement.
    let map = &engine.snapshot().map;
    let tile_1_12 = map.tile(point(1, 12)).unwrap();
    let tile_1_13 = map.tile(point(1, 13)).unwrap();
    eprintln!(
        "After roundabout: (1,12) connections={:?} oneWay={:?}",
        tile_1_12.road_connections, tile_1_12.one_way
    );
    eprintln!(
        "After roundabout: (1,13) connections={:?} oneWay={:?}",
        tile_1_13.road_connections, tile_1_13.one_way
    );
    assert!(
        tile_1_12.road_connections.iter().any(|h| {
            matches!(
                h,
                caelum_core::model::Heading::North | caelum_core::model::Heading::South
            )
        }),
        "vertical road at (1,12) must have vertical connections after roundabout"
    );

    // 4. Place bus stops at the e2e positions.
    let first_stop = point(origin.x - 3, bottom_y); // (3, 13)
    let second_stop = point(origin.x - 2, origin.y); // (4, 12)
    let first_id = add_bus_stop(&mut engine, first_stop);
    let second_id = add_bus_stop(&mut engine, second_stop);

    // 5. Preview a Loop route.
    let response = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec![first_id.clone(), second_id.clone()],
        route_id: None,
        expected_revision: None,
        generation: 1,
    });

    eprintln!("Loop preview rejection: {:?}", response.rejection);
    for leg in &response.legs {
        eprintln!(
            "  leg: {:?} -> {:?} kind={:?} status={:?}",
            leg.from_waypoint_id, leg.to_waypoint_id, leg.kind, leg.status
        );
    }
    assert!(
        response.rejection.is_none(),
        "Loop preview must not be rejected: {:?}",
        response.rejection
    );

    // 6. Preview a Shuttle route.
    let response = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids: vec![first_id, second_id],
        route_id: None,
        expected_revision: None,
        generation: 2,
    });

    eprintln!("Shuttle preview rejection: {:?}", response.rejection);
    assert!(
        response.rejection.is_none(),
        "Shuttle preview must not be rejected: {:?}",
        response.rejection
    );
}
