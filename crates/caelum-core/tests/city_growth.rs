//! Service-driven city growth: zoned land near running transit develops on its
//! own every six game hours.

use caelum_core::model::{Point, ServicePattern, TransitMode};
use caelum_core::{GameEngine, GameIntent, RoadPreset};

const GROWTH_INTERVAL_SECONDS: f64 = 300.0;

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent.clone());
    assert!(result.applied, "{intent:?} should apply: {result:?}");
}

fn zone(engine: &mut GameEngine, area: &str, start: Point, end: Point) {
    apply(
        engine,
        GameIntent::PaintAreaRectangle {
            area: area.to_string(),
            start,
            end,
        },
    );
}

/// A two-stop bus loop along y=5 with stops at (2,4) and (12,4). With
/// `fleet`, the line runs one bus.
fn bus_line_engine(fleet: bool) -> GameEngine {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| point(x, 5)).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    apply(
        &mut engine,
        GameIntent::AddBusStop {
            point: point(12, 4),
        },
    );
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );
    if fleet {
        apply(
            &mut engine,
            GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: "route-001".to_string(),
            },
        );
    }
    engine
}

fn run(engine: &mut GameEngine) {
    apply(engine, GameIntent::SetPaused { paused: false });
}

fn building_types(engine: &GameEngine) -> Vec<(String, Point)> {
    engine
        .snapshot()
        .buildings
        .iter()
        .map(|building| (building.building_type.clone(), building.origin))
        .collect()
}

#[test]
fn zoned_land_beside_a_running_line_grows_homes_then_jobs() {
    let mut engine = bus_line_engine(true);
    zone(&mut engine, "residential", point(0, 2), point(4, 3));
    zone(&mut engine, "office", point(10, 2), point(14, 3));
    // Zoned, but far from both stops.
    zone(&mut engine, "residential", point(20, 12), point(24, 13));
    run(&mut engine);
    let budget = engine.snapshot().budget;

    let before = engine.tick(GROWTH_INTERVAL_SECONDS - 1.0);
    assert!(before.update.scene.is_none(), "no growth before 06:00");
    assert!(engine.snapshot().buildings.is_empty());

    let grew = engine.tick(1.0);
    assert!(
        grew.update.scene.is_some(),
        "a growing tick carries the scene"
    );
    // With no homes or jobs, the first stop grows a home; the home's workers
    // then need jobs, so the second stop grows a workplace.
    assert_eq!(
        building_types(&engine),
        vec![
            ("smallHouse".to_string(), point(0, 3)),
            ("officeTower".to_string(), point(10, 2)),
        ]
    );
    let snapshot = engine.snapshot();
    assert!(snapshot
        .buildings
        .iter()
        .all(|building| building.placed_at == GROWTH_INTERVAL_SECONDS));
    assert_eq!(snapshot.budget, budget, "growth is free");

    // Residents move into the grown home hourly, like a placed house.
    engine.tick(200.0);
    assert_eq!(engine.snapshot().sims.len(), 4);
}

#[test]
fn growth_waits_for_running_service_and_balanced_zoning() {
    // A line with no vehicles serves nobody.
    let mut idle = bus_line_engine(false);
    zone(&mut idle, "residential", point(0, 2), point(4, 3));
    run(&mut idle);
    idle.tick(GROWTH_INTERVAL_SECONDS * 2.0);
    assert!(idle.snapshot().buildings.is_empty());

    // Only residential land: one home grows, then its workers need jobs that
    // no zoned land can provide, so growth stalls.
    let mut engine = bus_line_engine(true);
    zone(&mut engine, "residential", point(0, 2), point(4, 3));
    zone(&mut engine, "residential", point(10, 2), point(14, 3));
    run(&mut engine);
    engine.tick(GROWTH_INTERVAL_SECONDS * 2.0);
    assert_eq!(
        building_types(&engine),
        vec![("smallHouse".to_string(), point(0, 3))]
    );

    // Zoning jobs near the line lets the next pass grow a workplace.
    zone(&mut engine, "commercial", point(10, 6), point(13, 7));
    engine.tick(GROWTH_INTERVAL_SECONDS);
    assert_eq!(
        building_types(&engine),
        vec![
            ("smallHouse".to_string(), point(0, 3)),
            ("supermarket".to_string(), point(10, 6)),
        ]
    );
}

#[test]
fn a_coarse_tick_grows_exactly_like_fine_ticks() {
    let prepare = || {
        let mut engine = bus_line_engine(true);
        zone(&mut engine, "residential", point(0, 2), point(4, 3));
        zone(&mut engine, "industrial", point(9, 1), point(14, 3));
        run(&mut engine);
        engine
    };

    let mut coarse = prepare();
    coarse.tick(GROWTH_INTERVAL_SECONDS * 3.0 + 10.0);

    let mut fine = prepare();
    for _ in 0..(GROWTH_INTERVAL_SECONDS as usize * 3 + 10) {
        fine.tick(1.0);
    }

    let coarse = coarse.snapshot();
    let fine = fine.snapshot();
    assert!(coarse.buildings.len() >= 3, "three passes grew buildings");
    assert_eq!(coarse.buildings, fine.buildings);
    assert_eq!(coarse.sims, fine.sims);
}
