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

fn assert_preview_connected(
    engine: &GameEngine,
    pattern: ServicePattern,
    waypoint_ids: Vec<String>,
    generation: u64,
) {
    let response = engine.preview_route(RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern,
        waypoint_ids,
        route_id: None,
        expected_revision: None,
        generation,
    });

    eprintln!("{pattern:?} preview rejection: {:?}", response.rejection);
    for leg in &response.legs {
        eprintln!(
            "  leg: {:?} -> {:?} kind={:?} status={:?}",
            leg.from_waypoint_id, leg.to_waypoint_id, leg.kind, leg.status
        );
    }
    assert!(
        response.rejection.is_none(),
        "{pattern:?} preview must not be rejected: {:?}",
        response.rejection
    );
}

/// Reproduces the browser scenario for both roundabout sizes: two opposing
/// one-way approaches cross a dual-bidirectional vertical road before entering
/// the roundabout. The Shuttle return service reaches its first terminal through
/// an automatic-junction transition that can span more than one tile.
fn assert_roundabout_e2e_preview_is_connected(
    origin: Point,
    size: RoundaboutSize,
    width: i32,
    right: i32,
) {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(500_000);

    let bottom_y = origin.y + width - 1;
    let vertical_x = origin.x - 5;

    paint_area(
        &mut engine,
        origin,
        point(origin.x + width - 1, origin.y + width - 1),
        "residential",
    );

    road_line(
        &mut engine,
        (vertical_x..=right).map(|x| point(x, bottom_y)).collect(),
        RoadPreset::OneWay,
    );
    road_line(
        &mut engine,
        (vertical_x..=right)
            .rev()
            .map(|x| point(x, origin.y))
            .collect(),
        RoadPreset::OneWay,
    );
    road_line(
        &mut engine,
        (origin.y - 1..=bottom_y + 1)
            .map(|y| point(vertical_x, y))
            .collect(),
        RoadPreset::DualBidirectional,
    );

    let map = &engine.snapshot().map;
    let crossing = map.tile(point(vertical_x, origin.y)).unwrap();
    assert!(
        crossing
            .road_connections
            .iter()
            .any(|heading| matches!(
                heading,
                caelum_core::model::Heading::North | caelum_core::model::Heading::South
            )),
        "vertical crossing must remain connected before roundabout placement"
    );

    place_roundabout(&mut engine, origin, size);

    let map = &engine.snapshot().map;
    let crossing = map.tile(point(vertical_x, origin.y)).unwrap();
    assert!(
        crossing
            .road_connections
            .iter()
            .any(|heading| matches!(
                heading,
                caelum_core::model::Heading::North | caelum_core::model::Heading::South
            )),
        "vertical crossing must remain connected after roundabout placement"
    );

    let first_stop = point(origin.x - 3, bottom_y);
    let second_stop = point(origin.x - 2, origin.y);
    let first_id = add_bus_stop(&mut engine, first_stop);
    let second_id = add_bus_stop(&mut engine, second_stop);

    assert_preview_connected(
        &engine,
        ServicePattern::Loop,
        vec![first_id.clone(), second_id.clone()],
        1,
    );
    assert_preview_connected(
        &engine,
        ServicePattern::Shuttle,
        vec![first_id, second_id],
        2,
    );
}

#[test]
fn compact_roundabout_e2e_preview_is_connected() {
    assert_roundabout_e2e_preview_is_connected(point(6, 12), RoundaboutSize::Compact2x2, 2, 12);
}

#[test]
fn standard_roundabout_e2e_preview_is_connected() {
    assert_roundabout_e2e_preview_is_connected(point(21, 12), RoundaboutSize::Standard3x3, 3, 28);
}
