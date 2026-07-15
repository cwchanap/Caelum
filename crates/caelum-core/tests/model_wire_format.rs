//! Wire-format lock for the soon-to-be-enum fields.
//!
//! These tests pin the exact JSON spelling of every `String` field that will become a
//! fieldless enum (`status`, `purpose`, `mode`, `Metrics.state`, `TripOutcome.outcome`,
//! `worker_profile`). They MUST stay green when the types change to enums with
//! `#[serde(rename_all = ...)]` — that is the proof the WASM/Tauri wire format is
//! byte-identical to the current TS-parity strings. If any assertion here changes, the
//! wire contract changed.

use caelum_core::model::SNAPSHOT_SCHEMA_VERSION;
use caelum_core::model::{
    ActiveTrip, Heading, Metrics, MetricsState, MovementKind, PathGeometry, PlacedBuilding, Point,
    RoadPathStep, RoadPort, RoadStructure, RoundaboutSize, Route, RouteLeg, RouteLegKind,
    RouteLegPath, RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, Sim, Station, Stop,
    Tile, TransitMode, TransitPath, TripOutcome, TripOutcomeKind, TripPosition, TripPurpose,
    TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::rejection::{GameplayRejection, RejectionCode, RejectionContext};
use caelum_core::road::RoadMutation;
use caelum_core::state::create_initial_snapshot;
use caelum_core::{
    DispatchResult, GameEngine, GameIntent, RoadMutationPreviewRequest, RoadPreset,
    RoutePreviewRequest,
};
use serde_json::json;

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

#[test]
fn transit_node_kind_and_status_are_required_schema_v2_fields() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad { point: point(2, 5) });
    let stop_result = engine.dispatch(GameIntent::AddBusStop { point: point(2, 5) });
    let mut stop_value = serde_json::to_value(&stop_result.snapshot.transit.stops[0]).unwrap();
    assert_eq!(stop_value["kind"], json!("busStop"));
    assert_eq!(stop_value["status"], json!("present"));
    stop_value.as_object_mut().unwrap().remove("status");
    assert!(serde_json::from_value::<Stop>(stop_value).is_err());

    engine.dispatch(GameIntent::LayTrack { point: point(5, 5) });
    let station_result = engine.dispatch(GameIntent::AddMetroStation { point: point(5, 5) });
    let mut station_value =
        serde_json::to_value(&station_result.snapshot.transit.stations[0]).unwrap();
    assert_eq!(station_value["status"], json!("present"));
    station_value.as_object_mut().unwrap().remove("status");
    assert!(serde_json::from_value::<Station>(station_value).is_err());
}

fn bus_route_fixture() -> Route {
    let mut engine = GameEngine::new();
    for x in 2..=10 {
        engine.dispatch(GameIntent::LayRoad { point: point(x, 5) });
    }
    engine.dispatch(GameIntent::AddBusStop { point: point(2, 5) });
    engine.dispatch(GameIntent::AddBusStop {
        point: point(10, 5),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine.snapshot().transit.routes[0].clone()
}

#[test]
fn route_wire_uses_directional_legs_without_legacy_segments() {
    let route = bus_route_fixture();
    let value = serde_json::to_value(route).unwrap();

    assert_eq!(value["pattern"], json!("loop"));
    assert_eq!(value["revision"], json!(0));
    assert!(value.get("legs").is_some());
    assert!(value.get("segments").is_none());
    assert_eq!(value["legs"][0]["direction"], json!("loop"));
    assert_eq!(value["legs"][0]["kind"], json!("service"));
    assert_eq!(value["legs"][0]["status"], json!("connected"));
    assert_eq!(value["legs"][0]["currentPath"]["kind"], json!("road"));
}

#[test]
fn movement_kind_serializes_to_camel_case_wire_strings() {
    for (movement, wire) in [
        (MovementKind::Straight, "straight"),
        (MovementKind::RightTurn, "rightTurn"),
        (MovementKind::LeftTurn, "leftTurn"),
        (MovementKind::UTurn, "uTurn"),
        (MovementKind::RoundaboutEntry, "roundaboutEntry"),
        (MovementKind::RoundaboutCirculation, "roundaboutCirculation"),
        (MovementKind::RoundaboutExit, "roundaboutExit"),
    ] {
        let step = RoadPathStep {
            position: Point { x: 1, y: 2 },
            entering_heading: Heading::North,
            leaving_heading: Heading::East,
            movement,
            geometry: PathGeometry::Line {
                from: TripPosition { x: 0.0, y: 0.0 },
                to: TripPosition { x: 1.0, y: 0.0 },
            },
            travel_seconds: 1.5,
        };
        let value = serde_json::to_value(&step).expect("road path step should serialize");
        assert_eq!(
            value["movement"],
            json!(wire),
            "movement kind wire spelling changed: {wire}"
        );
    }
}

#[test]
fn route_leg_status_and_kind_pin_failure_path_wire_strings() {
    for (status, wire) in [
        (RouteLegStatus::Connected, "connected"),
        (RouteLegStatus::NetworkDisconnected, "networkDisconnected"),
        (RouteLegStatus::MissingNode, "missingNode"),
    ] {
        let value = serde_json::to_value(status).expect("status should serialize");
        assert_eq!(
            value,
            json!(wire),
            "route leg status wire spelling changed: {wire}"
        );
    }
    for (kind, wire) in [
        (RouteLegKind::Service, "service"),
        (RouteLegKind::TerminalReversal, "terminalReversal"),
    ] {
        let value = serde_json::to_value(kind).expect("kind should serialize");
        assert_eq!(
            value,
            json!(wire),
            "route leg kind wire spelling changed: {wire}"
        );
    }
}

#[test]
fn route_leg_path_serializes_status_and_kind_in_camel_case() {
    let leg = RouteLegPath {
        from_waypoint_id: "stop-001".to_string(),
        to_waypoint_id: "stop-002".to_string(),
        direction: ServiceDirection::Loop,
        kind: RouteLegKind::TerminalReversal,
        status: RouteLegStatus::MissingNode,
        current_path: None,
        last_valid_path: None,
        estimated_seconds: None,
    };
    let value = serde_json::to_value(&leg).unwrap();
    assert_eq!(value["status"], json!("missingNode"));
    assert_eq!(value["kind"], json!("terminalReversal"));
    assert_eq!(value["currentPath"], serde_json::Value::Null);
    assert_eq!(value["lastValidPath"], serde_json::Value::Null);
    assert_eq!(value["estimatedSeconds"], serde_json::Value::Null);
}

#[test]
fn vehicle_wire_uses_tagged_path_cursor_without_legacy_progress() {
    let vehicle = Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: Vec::new(),
        itinerary_index: 1,
        path_step_index: 2,
        step_progress: 0.25,
        parked_position: Some(TripPosition { x: 3.0, y: 4.0 }),
    };
    let value = serde_json::to_value(vehicle).unwrap();

    assert_eq!(value["itineraryIndex"], json!(1));
    assert_eq!(value["pathStepIndex"], json!(2));
    assert_eq!(value["stepProgress"], json!(0.25));
    assert_eq!(value["parkedPosition"], json!({ "x": 3.0, "y": 4.0 }));
    assert!(value.get("segmentIndex").is_none());
    assert!(value.get("progress").is_none());
}

#[test]
fn snapshot_carries_the_authoritative_schema_version() {
    let snapshot = create_initial_snapshot();
    assert_eq!(snapshot.schema_version, SNAPSHOT_SCHEMA_VERSION);
    assert_eq!(
        serde_json::to_value(snapshot).unwrap()["schemaVersion"],
        json!(2)
    );
}

#[test]
fn path_geometry_struct_variant_fields_use_camel_case() {
    let geometry = PathGeometry::QuadraticBezier {
        from: TripPosition { x: 0.0, y: 0.0 },
        control: TripPosition { x: 1.5, y: 2.5 },
        to: TripPosition { x: 3.0, y: 0.0 },
    };

    assert_eq!(
        serde_json::to_value(geometry).unwrap(),
        json!({
            "kind": "quadraticBezier",
            "from": { "x": 0.0, "y": 0.0 },
            "control": { "x": 1.5, "y": 2.5 },
            "to": { "x": 3.0, "y": 0.0 }
        })
    );
}

#[test]
fn transit_path_struct_variant_fields_use_camel_case() {
    let path = TransitPath::Road {
        steps: Vec::new(),
        total_travel_seconds: 3.75,
    };

    assert_eq!(
        serde_json::to_value(path).unwrap(),
        json!({
            "kind": "road",
            "steps": [],
            "totalTravelSeconds": 3.75
        })
    );
}

#[test]
fn gameplay_rejection_uses_stable_camel_case_wire_names() {
    let rejection = GameplayRejection {
        code: RejectionCode::InsufficientBudget,
        context: RejectionContext {
            required_budget: Some(8_000),
            available_budget: Some(7_999),
            ..RejectionContext::default()
        },
    };

    assert_eq!(
        serde_json::to_value(rejection).unwrap(),
        json!({
            "code": "insufficientBudget",
            "context": {
                "requiredBudget": 8000,
                "availableBudget": 7999,
                "affectedRouteIds": []
            }
        })
    );
}

#[test]
fn route_revision_exhausted_rejection_uses_stable_camel_case_wire_name() {
    let rejection = GameplayRejection {
        code: RejectionCode::RouteRevisionExhausted,
        context: RejectionContext {
            route_id: Some("route-001".into()),
            actual_revision: Some(u32::MAX),
            ..RejectionContext::default()
        },
    };

    assert_eq!(
        serde_json::to_value(rejection).unwrap(),
        json!({
            "code": "routeRevisionExhausted",
            "context": {
                "routeId": "route-001",
                "actualRevision": 4294967295_u64,
                "affectedRouteIds": []
            }
        })
    );
}

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
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: None,
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
            service_direction: (mode != TransitMode::Walk).then_some(ServiceDirection::Loop),
            board_itinerary_index: (mode != TransitMode::Walk).then_some(0),
            alight_itinerary_index: (mode != TransitMode::Walk).then_some(0),
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
fn route_leg_visit_fields_are_required_and_walk_fields_serialize_as_null() {
    let walk = RouteLeg {
        mode: TransitMode::Walk,
        from: (0, 0).into(),
        to: (1, 0).into(),
        line_id: None,
        service_direction: None,
        board_itinerary_index: None,
        alight_itinerary_index: None,
    };
    let walk_value = serde_json::to_value(&walk).unwrap();
    assert_eq!(walk_value["serviceDirection"], serde_json::Value::Null);
    assert_eq!(walk_value["boardItineraryIndex"], serde_json::Value::Null);
    assert_eq!(walk_value["alightItineraryIndex"], serde_json::Value::Null);

    let transit = RouteLeg {
        mode: TransitMode::Bus,
        from: (2, 5).into(),
        to: (6, 5).into(),
        line_id: Some("route-001".to_string()),
        service_direction: Some(ServiceDirection::Return),
        board_itinerary_index: Some(4),
        alight_itinerary_index: Some(4),
    };
    let transit_value = serde_json::to_value(&transit).unwrap();
    assert_eq!(transit_value["serviceDirection"], json!("return"));
    assert_eq!(transit_value["boardItineraryIndex"], json!(4));
    assert_eq!(transit_value["alightItineraryIndex"], json!(4));

    for field in [
        "serviceDirection",
        "boardItineraryIndex",
        "alightItineraryIndex",
    ] {
        let mut missing = transit_value.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<RouteLeg>(missing).is_err(),
            "schema-v2 RouteLeg field {field} must be required"
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
fn trip_outcome_field_names_serialize_to_camel_case_wire() {
    let trip_outcome = TripOutcome {
        outcome: TripOutcomeKind::Late,
        wait_seconds: 42.5,
        time: 7.25,
    };
    let value = serde_json::to_value(&trip_outcome).expect("outcome should serialize");
    assert_eq!(
        value["waitSeconds"],
        json!(42.5),
        "trip outcome wait_seconds must serialize as camelCase waitSeconds on the wire"
    );
    assert_eq!(
        value["time"],
        json!(7.25),
        "trip outcome time must serialize as camelCase time on the wire"
    );
    // snake_case must NOT leak onto the wire — the TS host adapters read
    // camelCase field names.
    assert!(
        value.get("wait_seconds").is_none(),
        "trip outcome leaked snake_case wait_seconds onto the wire"
    );
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
            GameIntent::CreateRoute {
                mode: TransitMode::Bus,
                pattern: ServicePattern::Loop,
                waypoint_ids: vec!["stop-1".to_string(), "stop-2".to_string()],
            },
            "createRoute",
            vec![
                ("mode", json!("bus")),
                ("pattern", json!("loop")),
                ("waypointIds", json!(["stop-1", "stop-2"])),
            ],
        ),
        (
            GameIntent::UpdateRoute {
                route_id: "metro-001".to_string(),
                expected_revision: 7,
                pattern: ServicePattern::Shuttle,
                waypoint_ids: vec!["station-1".to_string(), "station-2".to_string()],
            },
            "updateRoute",
            vec![
                ("routeId", json!("metro-001")),
                ("expectedRevision", json!(7)),
                ("pattern", json!("shuttle")),
                ("waypointIds", json!(["station-1", "station-2"])),
            ],
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
        (
            GameIntent::PlaceRoundabout {
                origin: p(5, 6),
                size: RoundaboutSize::Compact2x2,
            },
            "placeRoundabout",
            vec![
                ("origin", json!({ "x": 5, "y": 6 })),
                ("size", json!("compact2x2")),
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
            GameIntent::PlaceRoundabout { .. } => "placeRoundabout",
            GameIntent::LayTrack { .. } => "layTrack",
            GameIntent::LayTrackLine { .. } => "layTrackLine",
            GameIntent::RemoveAtTile { .. } => "removeAtTile",
            GameIntent::RemoveAtTiles { .. } => "removeAtTiles",
            GameIntent::AddBusStop { .. } => "addBusStop",
            GameIntent::AddMetroStation { .. } => "addMetroStation",
            GameIntent::CreateRoute { .. } => "createRoute",
            GameIntent::UpdateRoute { .. } => "updateRoute",
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
        itinerary_index: 2,
        path_step_index: 3,
        step_progress: 0.25,
        parked_position: Some(TripPosition { x: 4.0, y: 5.0 }),
    };
    let json = serde_json::to_value(&vehicle).expect("serialize");
    let back: Vehicle = serde_json::from_value(json).expect("deserialize");
    assert_eq!(back, vehicle);

    let leg = RouteLeg {
        mode: TransitMode::Bus,
        from: (0, 0).into(),
        to: (1, 0).into(),
        line_id: None,
        service_direction: None,
        board_itinerary_index: None,
        alight_itinerary_index: None,
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
        road_connections: vec![Heading::East, Heading::West],
        road_structure_id: None,
    };
    let value = serde_json::to_value(&tile).expect("tile should serialize");
    assert_eq!(value["kind"], json!("road"));
    assert_eq!(value["roadConnections"], json!(["east", "west"]));
}

#[test]
fn road_structures_use_stable_camel_case_wire_shapes() {
    let junction = RoadStructure::AutomaticJunction {
        id: "junction-1".to_string(),
        footprint: vec![point(4, 5)],
        ports: vec![RoadPort {
            id: "junction-1-port-4-5-west".to_string(),
            point: point(4, 5),
            edge: Heading::West,
        }],
    };
    assert_eq!(
        serde_json::to_value(junction).unwrap(),
        json!({
            "kind": "automaticJunction",
            "id": "junction-1",
            "footprint": [{ "x": 4, "y": 5 }],
            "ports": [{
                "id": "junction-1-port-4-5-west",
                "point": { "x": 4, "y": 5 },
                "edge": "west"
            }]
        })
    );

    let roundabout = RoadStructure::Roundabout {
        id: "roundabout-1".to_string(),
        origin: point(8, 9),
        size: RoundaboutSize::Compact2x2,
        footprint: vec![point(8, 9)],
        ports: Vec::new(),
    };
    let value = serde_json::to_value(roundabout).unwrap();
    assert_eq!(value["kind"], json!("roundabout"));
    assert_eq!(value["size"], json!("compact2x2"));
}

#[test]
fn place_roundabout_intent_and_preview_mutation_use_camel_case_wire() {
    let intent = GameIntent::PlaceRoundabout {
        origin: point(5, 6),
        size: RoundaboutSize::Compact2x2,
    };
    assert_eq!(
        serde_json::to_value(intent).unwrap(),
        json!({
            "type": "placeRoundabout",
            "origin": { "x": 5, "y": 6 },
            "size": "compact2x2"
        })
    );

    let mutation = RoadMutation::PlaceRoundabout {
        origin: point(8, 9),
        size: RoundaboutSize::Standard3x3,
    };
    assert_eq!(
        serde_json::to_value(mutation).unwrap(),
        json!({
            "type": "placeRoundabout",
            "origin": { "x": 8, "y": 9 },
            "size": "standard3x3"
        })
    );
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

#[test]
fn dispatch_result_round_trips_through_serde_json() {
    // The Tauri host (`src-tauri/src/lib.rs`) returns `DispatchResult` from
    // `game_dispatch` / `game_tick` through Tauri's IPC, which serializes via
    // `serde_json`. The WASM host instead uses `serde-wasm-bindgen`. The two
    // serializers differ on `Option<T>` (`None` -> `null` in JSON vs `undefined`
    // in JS, which is why `normalizeDispatchResult` exists on the TS side). This
    // test pins the `serde_json` path specifically: a `DispatchResult` produced
    // by the Rust core must round-trip through `serde_json::to_value` ->
    // `serde_json::from_value` byte-for-byte, proving the Tauri IPC serializer
    // cannot silently drop or rename a field that the WASM path handles.
    //
    // Both the applied (rejection = None) and rejected (rejection = Some) cases
    // are covered, since `Option<GameplayRejection>` is the field most likely to diverge
    // between serializers.
    use caelum_core::state::create_initial_snapshot;

    let snapshot = create_initial_snapshot();

    // Applied case: rejection is None -> serializes to JSON `null`.
    let applied = DispatchResult::applied(snapshot.clone());
    let value = serde_json::to_value(&applied).expect("applied result should serialize");
    assert_eq!(value["applied"], json!(true));
    assert_eq!(value["rejection"], json!(null));
    assert_eq!(value["snapshot"]["paused"], json!(true));
    let back: DispatchResult =
        serde_json::from_value(value).expect("applied result should deserialize back");
    assert_eq!(back, applied);

    // Rejected case: rejection is Some -> serializes to structured JSON.
    let rejected = DispatchResult::rejected(
        snapshot.clone(),
        GameplayRejection::new(RejectionCode::InvalidSpeed),
    );
    let value = serde_json::to_value(&rejected).expect("rejected result should serialize");
    assert_eq!(value["applied"], json!(false));
    assert_eq!(
        value["rejection"],
        json!({ "code": "invalidSpeed", "context": { "affectedRouteIds": [] } })
    );
    assert_eq!(
        value["context"],
        json!({
            "changedTiles": [],
            "skippedTiles": [],
            "affectedRouteIds": [],
            "cost": 0
        })
    );
    let back: DispatchResult =
        serde_json::from_value(value.clone()).expect("rejected result should deserialize back");
    assert_eq!(back, rejected);

    // Cross-check: the serialized JSON shape matches what the TS `DispatchResult`
    // interface expects (`{ snapshot, applied, rejection, context }`), so a Tauri IPC
    // response is structurally identical to a WASM `engine.dispatch()` return.
    let keys: std::collections::HashSet<String> = value
        .as_object()
        .expect("serialized result is a JSON object")
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        keys,
        ["snapshot", "applied", "rejection", "context"]
            .into_iter()
            .map(String::from)
            .collect(),
        "DispatchResult must serialize exactly the TS-contract keys"
    );
}

#[test]
fn growth_action_serializes_to_ts_parity_tagged_shape() {
    use caelum_core::model::GrowthAction;

    let place = GrowthAction::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: Point { x: 2, y: 3 },
        rotation: 0,
    };
    let value = serde_json::to_value(&place).expect("placeBuilding serializes");
    assert_eq!(value["type"], json!("placeBuilding"));
    assert_eq!(value["buildingType"], json!("smallHouse"));
    assert_eq!(value["origin"], json!({ "x": 2, "y": 3 }));
    assert_eq!(value["rotation"], json!(0));
    assert!(
        value.get("building_type").is_none(),
        "must not leak snake_case building_type"
    );

    let paint = GrowthAction::PaintAreaRectangle {
        area: "residential".to_string(),
        start: Point { x: 2, y: 3 },
        end: Point { x: 11, y: 3 },
    };
    let value = serde_json::to_value(&paint).expect("paintAreaRectangle serializes");
    assert_eq!(value["type"], json!("paintAreaRectangle"));
    assert_eq!(value["area"], json!("residential"));
    assert_eq!(value["end"], json!({ "x": 11, "y": 3 }));
}

#[test]
fn shipped_scenario_growth_waves_serialize_to_empty_list() {
    use caelum_core::state::create_initial_snapshot;

    let snapshot = create_initial_snapshot();
    let value = serde_json::to_value(&snapshot.scenario).expect("scenario serializes");
    assert_eq!(value["growthWaves"], json!([]));
}

#[test]
fn scenario_config_growth_waves_defaults_to_empty_when_omitted() {
    use caelum_core::model::ScenarioConfig;

    let value = json!({
        "name": "Growing Suburb",
        "objectives": {
            "maxLateRatio": 0.1,
            "maxUnservedRatio": 0.1,
            "maxAverageWait": 180.0,
            "rollingWindowSeconds": 300.0,
            "survivalTime": 600.0
        }
    });
    let config: ScenarioConfig =
        serde_json::from_value(value).expect("scenario without growthWaves deserializes");
    assert!(config.growth_waves.is_empty());
}

#[test]
fn preview_contract_serializes_with_camel_case_tags_and_explicit_nulls() {
    let route_request = RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".into(), "stop-002".into()],
        route_id: None,
        expected_revision: None,
        generation: 61,
    };
    assert_eq!(
        serde_json::to_value(&route_request).unwrap(),
        json!({
            "mode": "bus",
            "pattern": "loop",
            "waypointIds": ["stop-001", "stop-002"],
            "routeId": null,
            "expectedRevision": null,
            "generation": 61
        })
    );

    let road_request = RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoadLine {
            points: vec![point(2, 2), point(3, 2)],
            preset: RoadPreset::TwoWay,
        },
        generation: 62,
    };
    assert_eq!(
        serde_json::to_value(&road_request).unwrap(),
        json!({
            "mutation": {
                "type": "layRoadLine",
                "points": [{ "x": 2, "y": 2 }, { "x": 3, "y": 2 }],
                "preset": "twoWay"
            },
            "generation": 62
        })
    );

    let mut engine = GameEngine::new();
    for x in 2..=10 {
        engine.dispatch(GameIntent::LayRoad { point: point(x, 5) });
    }
    engine.dispatch(GameIntent::AddBusStop { point: point(2, 5) });
    engine.dispatch(GameIntent::AddBusStop {
        point: point(10, 5),
    });
    let route_response = engine.preview_route(route_request);
    let route_value = serde_json::to_value(route_response).unwrap();
    assert_eq!(route_value["generation"], json!(61));
    assert_eq!(route_value["rejection"], json!(null));
    assert_eq!(route_value["initialVehicleCost"], json!(8_000));
    assert!(route_value.get("total_travel_seconds").is_none());

    let road_response = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(3, 3) },
        generation: 63,
    });
    let road_value = serde_json::to_value(road_response).unwrap();
    assert_eq!(road_value["generation"], json!(63));
    assert_eq!(road_value["rejection"], json!(null));
    assert_eq!(road_value["authoredTiles"][0]["oneWay"], json!(null));
    assert_eq!(
        road_value["authoredTiles"][0]["roadStructureId"],
        json!(null)
    );

    engine.set_budget_for_test(99);
    let rejected_road = engine.preview_road_mutation(RoadMutationPreviewRequest {
        mutation: RoadMutation::LayRoad { point: point(4, 3) },
        generation: 64,
    });
    let rejected_value = serde_json::to_value(rejected_road).unwrap();
    assert_eq!(rejected_value["generation"], json!(64));
    assert_eq!(rejected_value["cost"], json!(100));
    assert_eq!(
        rejected_value["rejection"],
        json!({
            "code": "insufficientBudget",
            "context": {
                "requiredBudget": 100,
                "availableBudget": 99,
                "affectedRouteIds": []
            }
        })
    );
    assert!(rejected_value.get("affordable").is_none());
}
