//! Wire-format lock for the soon-to-be-enum fields.
//!
//! These tests pin the exact JSON spelling of every `String` field that will become a
//! fieldless enum (`status`, `purpose`, `mode`, `Metrics.state`, `TripOutcome.outcome`,
//! `worker_profile`). They MUST stay green when the types change to enums with
//! `#[serde(rename_all = ...)]` — that is the proof the WASM/Tauri wire format is
//! byte-identical to the current TS-parity strings. If any assertion here changes, the
//! wire contract changed.

use caelum_core::model::{
    ActiveTrip, Metrics, MetricsState, PlacedBuilding, Point, RouteLeg, RoutePlan, Sim, Tile,
    TransitMode, TripOutcome, TripOutcomeKind, TripPosition, TripPurpose, TripStatus, Vehicle,
    WorkerProfile,
};
use caelum_core::{GameIntent, RoadPreset};
use serde_json::json;

fn active_trip_with(status: TripStatus, purpose: TripPurpose) -> ActiveTrip {
    ActiveTrip {
        id: "trip-day-0-trip-1".to_string(),
        sim_id: "sim-001".to_string(),
        purpose,
        origin: (0, 0).into(),
        destination: (1, 1).into(),
        position: TripPosition { x: 0.0, y: 0.0 },
        status,
        deadline: 0.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 0.0,
    }
}

#[test]
fn active_trip_status_serializes_to_legacy_strings() {
    for (status, wire) in [
        (TripStatus::Idle, "idle"),
        (TripStatus::Walking, "walking"),
        (TripStatus::Waiting, "waiting"),
        (TripStatus::Riding, "riding"),
        (TripStatus::Arrived, "arrived"),
        (TripStatus::Late, "late"),
        (TripStatus::Unserved, "unserved"),
    ] {
        let value = serde_json::to_value(active_trip_with(status, TripPurpose::CommuteOutbound))
            .expect("trip should serialize");
        assert_eq!(
            value["status"],
            json!(wire),
            "status wire spelling changed: {wire}"
        );
    }
}

#[test]
fn active_trip_purpose_serializes_to_legacy_strings() {
    for (purpose, wire) in [
        (TripPurpose::CommuteOutbound, "commuteOutbound"),
        (TripPurpose::CommuteReturn, "commuteReturn"),
    ] {
        let value = serde_json::to_value(active_trip_with(TripStatus::Walking, purpose))
            .expect("trip should serialize");
        assert_eq!(
            value["purpose"],
            json!(wire),
            "purpose wire spelling changed: {wire}"
        );
    }
}

#[test]
fn vehicle_and_route_leg_mode_serializes_to_legacy_strings() {
    for (mode, wire) in [
        (TransitMode::Walk, "walk"),
        (TransitMode::Bus, "bus"),
        (TransitMode::Metro, "metro"),
    ] {
        let vehicle = Vehicle {
            id: "vehicle-001".to_string(),
            mode,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            segment_index: 0,
            progress: 0.0,
        };
        let value = serde_json::to_value(&vehicle).expect("vehicle should serialize");
        assert_eq!(
            value["mode"],
            json!(wire),
            "vehicle mode wire spelling changed: {wire}"
        );

        let leg = RouteLeg {
            mode,
            from: (0, 0).into(),
            to: (1, 0).into(),
            line_id: Some("route-001".to_string()),
        };
        let value = serde_json::to_value(&leg).expect("leg should serialize");
        assert_eq!(
            value["mode"],
            json!(wire),
            "route leg mode wire spelling changed: {wire}"
        );
    }
}

#[test]
fn metrics_state_serializes_to_legacy_strings() {
    for (state, wire) in [
        (MetricsState::Running, "running"),
        (MetricsState::Won, "won"),
        (MetricsState::Lost, "lost"),
    ] {
        let metrics = Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            trip_outcomes: Vec::new(),
            state,
            loss_reason: None,
        };
        let value = serde_json::to_value(&metrics).expect("metrics should serialize");
        assert_eq!(
            value["state"],
            json!(wire),
            "metrics state wire spelling changed: {wire}"
        );
    }
}

#[test]
fn trip_outcome_kind_serializes_to_legacy_strings() {
    for (outcome, wire) in [
        (TripOutcomeKind::Arrived, "arrived"),
        (TripOutcomeKind::Late, "late"),
        (TripOutcomeKind::Unserved, "unserved"),
    ] {
        let trip_outcome = TripOutcome {
            outcome,
            wait_seconds: 0.0,
            time: 0.0,
        };
        let value = serde_json::to_value(&trip_outcome).expect("outcome should serialize");
        assert_eq!(
            value["outcome"],
            json!(wire),
            "trip outcome wire spelling changed: {wire}"
        );
    }
}

#[test]
fn sim_worker_profile_serializes_to_legacy_strings() {
    for (profile, wire) in [
        (WorkerProfile::Worker, "worker"),
        (WorkerProfile::NonWorker, "nonWorker"),
    ] {
        let sim = Sim {
            id: "sim-001".to_string(),
            home: (0, 0).into(),
            position: (0, 0).into(),
            worker_profile: profile,
            shift_template: None,
            workplace: None,
            commute_day: 0,
            outbound_resolved_today: false,
            outbound_arrived_today: false,
            return_resolved_today: false,
            returned_home_today: false,
        };
        let value = serde_json::to_value(&sim).expect("sim should serialize");
        assert_eq!(
            value["workerProfile"],
            json!(wire),
            "worker_profile wire spelling changed: {wire}"
        );
    }
}

#[test]
fn line_intents_use_camel_case_wire_names() {
    let intent = GameIntent::LayRoadLine {
        points: vec![(1, 2).into(), (3, 2).into()],
        preset: RoadPreset::DualBidirectional,
    };

    let json = serde_json::to_value(intent).expect("intent serializes");

    assert_eq!(json["type"], "layRoadLine");
    assert_eq!(json["preset"], "dualBidirectional");
    assert_eq!(json["points"][0]["x"], 1);
    assert_eq!(json["points"][1]["y"], 2);
}

#[test]
fn all_game_intent_variants_use_camel_case_wire_names() {
    // Pin the `type` tag and the camelCase field names for every `GameIntent`
    // variant. The wire contract is shared with the TS host adapters; a
    // snake_case leak or a renamed tag would silently break gameplay dispatch
    // in browser/WASM and Tauri builds. `LayRoadLine` is also covered by
    // `line_intents_use_camel_case_wire_names` (which additionally pins every
    // `RoadPreset`), but it is included here so this test enumerates the full
    // enum and any newly added variant that is not wired up here will fail the
    // exhaustiveness check below.
    fn p(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    type FieldAssertions = Vec<(&'static str, serde_json::Value)>;
    let cases: Vec<(GameIntent, &'static str, FieldAssertions)> = vec![
        (
            GameIntent::SetPaused { paused: true },
            "setPaused",
            vec![("paused", json!(true))],
        ),
        (
            GameIntent::SetSpeed { speed: 3 },
            "setSpeed",
            vec![("speed", json!(3))],
        ),
        (
            GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: "route-001".to_string(),
            },
            "assignVehicle",
            vec![("mode", json!("bus")), ("lineId", json!("route-001"))],
        ),
        (
            GameIntent::LayRoad { point: p(1, 2) },
            "layRoad",
            vec![("point", json!({ "x": 1, "y": 2 }))],
        ),
        (
            GameIntent::LayRoadLine {
                points: vec![p(1, 2), p(3, 2)],
                preset: RoadPreset::DualBidirectional,
            },
            "layRoadLine",
            vec![
                ("points", json!([{ "x": 1, "y": 2 }, { "x": 3, "y": 2 }])),
                ("preset", json!("dualBidirectional")),
            ],
        ),
        (
            GameIntent::CycleRoadDirection { point: p(4, 5) },
            "cycleRoadDirection",
            vec![("point", json!({ "x": 4, "y": 5 }))],
        ),
        (
            GameIntent::LayTrack { point: p(6, 7) },
            "layTrack",
            vec![("point", json!({ "x": 6, "y": 7 }))],
        ),
        (
            GameIntent::LayTrackLine {
                points: vec![p(0, 0), p(2, 0)],
            },
            "layTrackLine",
            vec![("points", json!([{ "x": 0, "y": 0 }, { "x": 2, "y": 0 }]))],
        ),
        (
            GameIntent::RemoveAtTile { point: p(8, 9) },
            "removeAtTile",
            vec![("point", json!({ "x": 8, "y": 9 }))],
        ),
        (
            GameIntent::RemoveAtTiles {
                points: vec![p(1, 1), p(2, 2)],
            },
            "removeAtTiles",
            vec![("points", json!([{ "x": 1, "y": 1 }, { "x": 2, "y": 2 }]))],
        ),
        (
            GameIntent::AddBusStop { point: p(3, 4) },
            "addBusStop",
            vec![("point", json!({ "x": 3, "y": 4 }))],
        ),
        (
            GameIntent::AddMetroStation { point: p(5, 6) },
            "addMetroStation",
            vec![("point", json!({ "x": 5, "y": 6 }))],
        ),
        (
            GameIntent::AddBusRoute {
                stop_ids: vec!["stop-1".to_string(), "stop-2".to_string()],
            },
            "addBusRoute",
            vec![("stopIds", json!(["stop-1", "stop-2"]))],
        ),
        (
            GameIntent::AddMetroLine {
                station_ids: vec!["station-1".to_string()],
            },
            "addMetroLine",
            vec![("stationIds", json!(["station-1"]))],
        ),
        (
            GameIntent::SetRouteActive {
                route_id: "route-001".to_string(),
                active: false,
            },
            "setRouteActive",
            vec![("routeId", json!("route-001")), ("active", json!(false))],
        ),
        (
            GameIntent::RenameRoute {
                route_id: "route-001".to_string(),
                name: "Main Line".to_string(),
            },
            "renameRoute",
            vec![
                ("routeId", json!("route-001")),
                ("name", json!("Main Line")),
            ],
        ),
        (
            GameIntent::RecolorRoute {
                route_id: "route-001".to_string(),
                color: "#ff0000".to_string(),
            },
            "recolorRoute",
            vec![("routeId", json!("route-001")), ("color", json!("#ff0000"))],
        ),
        (
            GameIntent::DeleteRoute {
                route_id: "route-001".to_string(),
            },
            "deleteRoute",
            vec![("routeId", json!("route-001"))],
        ),
        (
            GameIntent::AssignRouteToPlatform {
                node_id: "node-1".to_string(),
                route_id: "route-001".to_string(),
                platform_id: "platform-2".to_string(),
            },
            "assignRouteToPlatform",
            vec![
                ("nodeId", json!("node-1")),
                ("routeId", json!("route-001")),
                ("platformId", json!("platform-2")),
            ],
        ),
        (
            GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: p(0, 0),
                end: p(3, 3),
            },
            "paintAreaRectangle",
            vec![
                ("area", json!("residential")),
                ("start", json!({ "x": 0, "y": 0 })),
                ("end", json!({ "x": 3, "y": 3 })),
            ],
        ),
        (
            GameIntent::PlaceBuilding {
                building_type: "largeHouse".to_string(),
                origin: p(2, 3),
                rotation: 90,
            },
            "placeBuilding",
            vec![
                ("buildingType", json!("largeHouse")),
                ("origin", json!({ "x": 2, "y": 3 })),
                ("rotation", json!(90)),
            ],
        ),
    ];

    // Exhaustiveness guard: every `GameIntent` variant must be wired up here.
    // A new variant that is not added to `cases` will fail this match so the
    // wire contract cannot silently regress when the enum grows.
    fn expected_type_tag(intent: &GameIntent) -> &'static str {
        match intent {
            GameIntent::SetPaused { .. } => "setPaused",
            GameIntent::SetSpeed { .. } => "setSpeed",
            GameIntent::AssignVehicle { .. } => "assignVehicle",
            GameIntent::LayRoad { .. } => "layRoad",
            GameIntent::LayRoadLine { .. } => "layRoadLine",
            GameIntent::CycleRoadDirection { .. } => "cycleRoadDirection",
            GameIntent::LayTrack { .. } => "layTrack",
            GameIntent::LayTrackLine { .. } => "layTrackLine",
            GameIntent::RemoveAtTile { .. } => "removeAtTile",
            GameIntent::RemoveAtTiles { .. } => "removeAtTiles",
            GameIntent::AddBusStop { .. } => "addBusStop",
            GameIntent::AddMetroStation { .. } => "addMetroStation",
            GameIntent::AddBusRoute { .. } => "addBusRoute",
            GameIntent::AddMetroLine { .. } => "addMetroLine",
            GameIntent::SetRouteActive { .. } => "setRouteActive",
            GameIntent::RenameRoute { .. } => "renameRoute",
            GameIntent::RecolorRoute { .. } => "recolorRoute",
            GameIntent::DeleteRoute { .. } => "deleteRoute",
            GameIntent::AssignRouteToPlatform { .. } => "assignRouteToPlatform",
            GameIntent::PaintAreaRectangle { .. } => "paintAreaRectangle",
            GameIntent::PlaceBuilding { .. } => "placeBuilding",
        }
    }

    let covered_tags: std::collections::HashSet<&str> =
        cases.iter().map(|(_, tag, _)| *tag).collect();
    assert_eq!(
        covered_tags.len(),
        cases.len(),
        "duplicate type tags in wire-format cases"
    );

    for (intent, type_tag, field_assertions) in &cases {
        let value = serde_json::to_value(intent)
            .unwrap_or_else(|_| panic!("intent {type_tag} should serialize"));
        assert_eq!(
            value["type"],
            json!(type_tag),
            "GameIntent type tag changed: {type_tag}"
        );
        assert_eq!(
            expected_type_tag(intent),
            *type_tag,
            "case for {type_tag} is not reachable in the exhaustiveness match; \
             a variant was likely added to GameIntent without wiring it here"
        );
        for (field, expected) in field_assertions {
            assert_eq!(
                value[field], *expected,
                "GameIntent {type_tag} field `{field}` wire spelling changed"
            );
        }
    }
}

#[test]
fn snapshot_scenario_objectives_serialize_to_ts_parity_names() {
    // The shell reads these threshold names verbatim (runtimeSelectors formats
    // the objective copy from them), and they must match the TS domain
    // `Scenario.objectives` shape exactly — including `rollingWindowSeconds`,
    // which a previous TS shim had drifted to 600 while the core evaluates 300.
    use caelum_core::state::create_initial_snapshot;

    let snapshot = create_initial_snapshot();
    let value = serde_json::to_value(&snapshot.scenario).expect("scenario serializes");
    assert_eq!(value["name"], json!("Growing Suburb"));
    assert_eq!(value["objectives"]["maxLateRatio"], json!(0.25));
    assert_eq!(value["objectives"]["maxUnservedRatio"], json!(0.2));
    assert_eq!(value["objectives"]["maxAverageWait"], json!(180.0));
    assert_eq!(value["objectives"]["rollingWindowSeconds"], json!(300.0));
    assert_eq!(value["objectives"]["survivalTime"], json!(1_200.0));
    // No leaked snake_case keys from the Rust field names. These fields live on
    // the nested `ObjectiveThresholds` struct, so the leak check must inspect
    // `value["objectives"]` — checking the scenario root would always pass and
    // miss a regression in the `rename_all = "camelCase"` on that struct.
    let objectives = &value["objectives"];
    assert!(
        objectives.get("rolling_window_seconds").is_none(),
        "objectives must not leak the snake_case `rolling_window_seconds` field"
    );
    assert!(
        objectives.get("survival_time").is_none(),
        "objectives must not leak the snake_case `survival_time` field"
    );
}

#[test]
fn snapshot_round_trips_through_json() {
    // A representative vehicle + leg must deserialize back to an equal value, proving
    // the enum rename round-trips (not just serializes one way).
    let vehicle = Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Metro,
        line_id: "metro-001".to_string(),
        capacity: 90,
        passenger_ids: vec!["sim-001".to_string()],
        segment_index: 2,
        progress: 0.25,
    };
    let json = serde_json::to_value(&vehicle).expect("serialize");
    let back: Vehicle = serde_json::from_value(json).expect("deserialize");
    assert_eq!(back, vehicle);

    let leg = RouteLeg {
        mode: TransitMode::Bus,
        from: (0, 0).into(),
        to: (1, 0).into(),
        line_id: None,
    };
    let plan = RoutePlan {
        legs: vec![leg],
        estimated_seconds: 40.0,
    };
    let json = serde_json::to_value(&plan).expect("serialize");
    let back: RoutePlan = serde_json::from_value(json).expect("deserialize");
    assert_eq!(back, plan);

    // Tile.kind stays a string (not in the enum-refactor scope) but confirm it still
    // serializes plainly so a later TileKind change would be caught here too.
    let tile = Tile {
        id: "tile-0-0".to_string(),
        x: 0,
        y: 0,
        kind: "road".to_string(),
        area: None,
        has_track: false,
        one_way: None,
    };
    let value = serde_json::to_value(&tile).expect("tile should serialize");
    assert_eq!(value["kind"], json!("road"));
}

#[test]
fn placed_building_serializes_type_to_legacy_field() {
    // TS `PlacedBuilding` exposes `type` (src/domain/types.ts), and every
    // selector/renderer reads `building.type` (buildingSelectors.ts,
    // buildingRenderer.ts, actions.ts). The Rust field `building_type` must
    // serialize as `type` so the WASM/Tauri snapshot is byte-identical to the
    // legacy TS GameState — not `buildingType`, which the container
    // `rename_all = "camelCase"` would produce.
    let building = PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "largeHouse".to_string(),
        origin: Point { x: 2, y: 3 },
        rotation: 90,
        occupied_tiles: vec![Point { x: 2, y: 3 }],
        transit_node_id: None,
    };
    let value = serde_json::to_value(&building).expect("building should serialize");
    assert_eq!(
        value["type"],
        json!("largeHouse"),
        "PlacedBuilding.building_type must serialize as `type` for TS parity"
    );
    assert!(
        value.get("buildingType").is_none(),
        "PlacedBuilding must not serialize `buildingType`; TS reads `building.type`"
    );
    assert_eq!(value["occupiedTiles"], json!([{ "x": 2, "y": 3 }]));
    assert_eq!(value["rotation"], json!(90));

    // Round-trip: a TS-shaped JSON object must deserialize back into the struct,
    // proving the rename applies to both directions of the wire contract.
    let back: PlacedBuilding = serde_json::from_value(json!({
        "id": "building-001",
        "type": "largeHouse",
        "origin": { "x": 2, "y": 3 },
        "rotation": 90,
        "occupiedTiles": [{ "x": 2, "y": 3 }]
    }))
    .expect("TS-shaped building JSON should deserialize");
    assert_eq!(back, building);
}
