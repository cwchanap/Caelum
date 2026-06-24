use caelum_core::{GameEngine, GameIntent};

#[test]
fn zone_build_and_route_sequence_has_stable_counts() {
    let mut engine = GameEngine::new();

    let residential = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    assert!(residential.applied);

    let house = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    assert!(house.applied);

    let commercial = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    assert!(commercial.applied);

    let supermarket = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });
    assert!(supermarket.applied);

    assert_eq!(supermarket.snapshot.buildings.len(), 2);
    assert_eq!(supermarket.snapshot.sims.len(), 4);
    assert_eq!(supermarket.snapshot.budget, 108_000);
}
