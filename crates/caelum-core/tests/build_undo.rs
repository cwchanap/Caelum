use caelum_core::model::{Point, ServicePattern, TransitMode, TransitPath};
use caelum_core::{GameEngine, GameIntent, GameplayUpdateResult, RejectionCode, RoadPreset};

const GROWTH_INTERVAL_SECONDS: f64 = 300.0;
const UNDO_WINDOW_SECONDS: f64 = 50.0;

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn blank_engine() -> GameEngine {
    let mut request = caelum_core::canonical_default_request();
    request.template_id = "blankGrid".to_string();
    GameEngine::from_sandbox_request(request).expect("blank grid fixture request is valid")
}

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent.clone());
    assert!(result.applied, "{intent:?} should apply: {result:?}");
}

fn rejection_code(result: &GameplayUpdateResult) -> Option<RejectionCode> {
    result
        .rejection
        .as_ref()
        .map(|rejection| rejection.code.clone())
}

fn undo(engine: &mut GameEngine) -> GameplayUpdateResult {
    engine.dispatch(GameIntent::UndoLastBuild)
}

fn lay_road_line(engine: &mut GameEngine, points: Vec<Point>) {
    apply(
        engine,
        GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        },
    );
}

fn horizontal(y: i32, from_x: i32, to_x: i32) -> Vec<Point> {
    (from_x..=to_x).map(|x| point(x, y)).collect()
}

fn vertical(x: i32, from_y: i32, to_y: i32) -> Vec<Point> {
    (from_y..=to_y).map(|y| point(x, y)).collect()
}

fn path_touches(path: &TransitPath, point: Point) -> bool {
    path.road_steps().iter().any(|step| step.position == point)
}

fn route_path_touches(engine: &GameEngine, route_id: &str, point: Point) -> bool {
    engine
        .snapshot()
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .expect("fixture route exists")
        .legs
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .any(|path| path_touches(path, point))
}

fn route_is_broken(engine: &GameEngine, route_id: &str) -> bool {
    engine
        .snapshot()
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .expect("fixture route exists")
        .path_broken
}

#[test]
fn undo_restores_pre_build_map_and_budget_then_reports_nothing() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, horizontal(8, 4, 20));
    lay_road_line(&mut engine, vertical(12, 3, 14));
    assert!(!engine.snapshot().map.road_structures.is_empty());

    let before_map = engine.snapshot().map.clone();
    let before_budget = engine.snapshot().budget;

    lay_road_line(&mut engine, horizontal(8, 21, 24));
    assert_ne!(engine.snapshot().map, before_map);
    let spent = before_budget - engine.snapshot().budget;
    assert!(spent > 0);

    let result = undo(&mut engine);
    assert!(result.applied, "undo applies: {result:?}");
    assert_eq!(engine.snapshot().map, before_map);
    assert_eq!(engine.snapshot().budget, before_budget);

    let second = undo(&mut engine);
    assert!(!second.applied);
    assert_eq!(rejection_code(&second), Some(RejectionCode::NothingToUndo));
}

#[test]
fn undo_refunds_only_the_actual_partial_stroke_charge() {
    let mut engine = blank_engine();
    engine.set_budget_for_test(350);
    lay_road_line(&mut engine, horizontal(5, 2, 11));
    let after = engine.snapshot();
    assert_eq!(after.budget, 50, "three affordable tiles at 100 each");

    let result = undo(&mut engine);
    assert!(result.applied, "undo applies: {result:?}");
    let restored = engine.snapshot();
    assert_eq!(restored.budget, 350);
    assert!(restored
        .map
        .tiles
        .iter()
        .all(|tile| tile.kind != "road" && tile.road_connections.is_empty()));
}

#[test]
fn undo_place_building_demolishes_building_and_transit_node() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, horizontal(6, 4, 8));
    let before_budget = engine.snapshot().budget;
    let before_buildings = engine.snapshot().buildings.len();
    let before_stops = engine.snapshot().transit.stops.len();

    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "busTerminal".to_string(),
            origin: point(5, 4),
            rotation: 0,
        },
    );
    let placed = engine.snapshot();
    let building = placed
        .buildings
        .iter()
        .find(|building| building.building_type == "busTerminal")
        .expect("terminal placed");
    assert!(building.transit_node_id.is_some());
    let charged = before_budget - placed.budget;
    assert_eq!(charged, 12_000);

    let result = undo(&mut engine);
    assert!(result.applied, "undo applies: {result:?}");
    let restored = engine.snapshot();
    assert_eq!(restored.budget, before_budget);
    assert_eq!(restored.buildings.len(), before_buildings);
    assert_eq!(restored.transit.stops.len(), before_stops);
}

#[test]
fn undo_succeeds_at_exactly_one_game_hour_and_expires_beyond_it() {
    let mut engine = blank_engine();
    apply(&mut engine, GameIntent::SetPaused { paused: false });
    lay_road_line(&mut engine, horizontal(5, 2, 4));
    let before_map = engine.snapshot().map.clone();
    lay_road_line(&mut engine, horizontal(7, 2, 4));

    engine.tick(UNDO_WINDOW_SECONDS);
    let result = undo(&mut engine);
    assert!(
        result.applied,
        "undo at exactly the one-hour boundary applies: {result:?}"
    );
    assert_eq!(engine.snapshot().map, before_map);

    lay_road_line(&mut engine, horizontal(9, 2, 4));
    let budget_before_expiry = engine.snapshot().budget;
    engine.tick(UNDO_WINDOW_SECONDS + 0.5);
    let expired = undo(&mut engine);
    assert!(!expired.applied);
    assert_eq!(rejection_code(&expired), Some(RejectionCode::UndoExpired));
    assert_eq!(engine.snapshot().budget, budget_before_expiry);
    assert_eq!(
        rejection_code(&undo(&mut engine)),
        Some(RejectionCode::NothingToUndo),
        "expiry consumes the record"
    );
}

#[test]
fn undo_conflicts_when_a_new_route_now_depends_on_the_build() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, vertical(2, 5, 6));
    lay_road_line(&mut engine, vertical(12, 5, 6));
    apply(&mut engine, GameIntent::AddBusStop { point: point(2, 4) });
    apply(
        &mut engine,
        GameIntent::AddBusStop {
            point: point(12, 4),
        },
    );
    lay_road_line(&mut engine, horizontal(5, 3, 11));
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );
    assert!(!route_is_broken(&engine, "route-001"));
    let after_route = engine.snapshot();

    let conflict = undo(&mut engine);
    assert!(!conflict.applied);
    assert_eq!(rejection_code(&conflict), Some(RejectionCode::UndoConflict));
    assert_eq!(engine.snapshot(), after_route);
    assert_eq!(
        rejection_code(&undo(&mut engine)),
        Some(RejectionCode::UndoConflict)
    );
}

#[test]
fn growth_onto_a_changed_zone_tile_rejects_undo() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, horizontal(5, 2, 12));
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
    apply(
        &mut engine,
        GameIntent::AssignVehicle {
            mode: "bus".to_string(),
            line_id: "route-001".to_string(),
        },
    );
    apply(&mut engine, GameIntent::SetPaused { paused: false });

    engine.tick(GROWTH_INTERVAL_SECONDS - 1.0);
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: point(0, 2),
            end: point(4, 3),
        },
    );
    engine.tick(1.5);
    let grown = engine.snapshot();
    assert!(
        grown
            .buildings
            .iter()
            .any(|building| building.occupied_tiles.contains(&point(0, 3))),
        "growth placed a home on the painted land: {:?}",
        grown.buildings
    );

    let conflict = undo(&mut engine);
    assert!(!conflict.applied);
    assert_eq!(
        rejection_code(&conflict),
        Some(RejectionCode::UndoConflict),
        "undo must not rip the zoning out from under the grown building"
    );
    assert_eq!(engine.snapshot(), grown);
}

#[test]
fn undo_of_a_shortcut_keeps_the_earlier_connected_route() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, vertical(2, 5, 8));
    lay_road_line(&mut engine, horizontal(8, 2, 12));
    lay_road_line(&mut engine, vertical(12, 5, 8));
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
    assert!(!route_is_broken(&engine, "route-001"));

    lay_road_line(&mut engine, horizontal(5, 3, 11));
    assert!(
        route_path_touches(&engine, "route-001", point(6, 5)),
        "the recomputed route uses the shortcut"
    );
    let shortcut_budget = engine.snapshot().budget;

    let result = undo(&mut engine);
    assert!(
        result.applied,
        "undo succeeds because the line reroutes back instead of breaking"
    );
    assert!(!route_is_broken(&engine, "route-001"));
    assert!(
        route_path_touches(&engine, "route-001", point(6, 8)),
        "the line is connected via its earlier U-shaped path"
    );
    assert!(!route_path_touches(&engine, "route-001", point(6, 5)));
    assert!(engine.snapshot().budget > shortcut_budget);
}

#[test]
fn save_capture_consumes_the_undo_record() {
    let mut engine = blank_engine();
    lay_road_line(&mut engine, horizontal(5, 2, 4));

    let saved = engine.snapshot_for_save();
    let saved_json = serde_json::to_value(&saved).expect("snapshot serializes");
    assert!(saved_json.get("lastBuild").is_none());
    assert!(saved_json.get("undo").is_none());

    let result = undo(&mut engine);
    assert!(!result.applied);
    assert_eq!(
        rejection_code(&result),
        Some(RejectionCode::NothingToUndo),
        "capture-for-save consumes the pending undo record"
    );
}

#[test]
fn fieldless_undo_last_build_intent_round_trips_the_tagged_wire() {
    let intent: GameIntent = serde_json::from_value(serde_json::json!({
        "type": "undoLastBuild"
    }))
    .expect("undoLastBuild deserializes from the tagged camelCase wire");
    assert_eq!(intent, GameIntent::UndoLastBuild);
    assert_eq!(
        serde_json::to_value(&intent).expect("intent serializes"),
        serde_json::json!({ "type": "undoLastBuild" })
    );

    for (wire, code) in [
        ("nothingToUndo", RejectionCode::NothingToUndo),
        ("undoExpired", RejectionCode::UndoExpired),
        ("undoConflict", RejectionCode::UndoConflict),
    ] {
        assert_eq!(
            serde_json::to_value(&code).expect("code serializes"),
            serde_json::json!(wire)
        );
    }
}
