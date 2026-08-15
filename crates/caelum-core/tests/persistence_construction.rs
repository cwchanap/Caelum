use caelum_core::model::{
    ActiveTrip, Heading, MovementKind, PathGeometry, Point, PrivateCarTrip, RoadPathStep,
    RoadStructure, RoundaboutSize, RoutePlan, Station, TransitNodeStatus, TransitPath,
    TripPosition, TripPurpose, TripStatus,
};
use caelum_core::{GameEngine, GameIntent, RoadPreset, SnapshotLoadError};

mod common;

use common::persistence_fixtures::worker_sim;

fn invalid_snapshot(error: SnapshotLoadError) {
    assert!(
        matches!(error, SnapshotLoadError::InvalidSnapshot(_)),
        "expected an invalid snapshot error, got {error:?}"
    );
}

fn from_snapshot_error(snapshot: caelum_core::GameSnapshot) -> SnapshotLoadError {
    match GameEngine::from_snapshot(snapshot) {
        Ok(_) => panic!("expected snapshot construction to fail"),
        Err(error) => error,
    }
}

fn driving_path() -> TransitPath {
    TransitPath::Road {
        steps: vec![RoadPathStep {
            position: Point { x: 1, y: 1 },
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::Line {
                from: (1, 1).into(),
                to: (2, 1).into(),
            },
            travel_seconds: 2.5,
        }],
        total_travel_seconds: 2.5,
    }
}

fn driving_trip() -> ActiveTrip {
    ActiveTrip {
        id: "trip-driving".to_string(),
        sim_id: "sim-driving".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 1, y: 1 },
        destination: Point { x: 2, y: 1 },
        position: TripPosition { x: 1.0, y: 1.0 },
        status: TripStatus::Driving,
        deadline: 200.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: Some(PrivateCarTrip {
            path: driving_path(),
            arrival_time: 101.25,
        }),
    }
}

fn valid_driving_snapshot() -> caelum_core::GameSnapshot {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot
        .sims
        .push(worker_sim("sim-driving", Point { x: 1, y: 1 }, None));
    snapshot.active_trips.push(driving_trip());
    snapshot
}

fn assert_invalid_trip_field(snapshot: caelum_core::GameSnapshot, field: &str) {
    let SnapshotLoadError::InvalidSnapshot(diagnostic) = from_snapshot_error(snapshot) else {
        panic!("expected invalid snapshot diagnostic");
    };
    let value: serde_json::Value =
        serde_json::from_str(&diagnostic).expect("diagnostic should be JSON");
    assert_eq!(value["context"]["field"], serde_json::json!(field));
}

fn assert_invalid_transit_membership(snapshot: caelum_core::GameSnapshot) {
    let SnapshotLoadError::InvalidSnapshot(diagnostic) = from_snapshot_error(snapshot) else {
        panic!("expected invalid snapshot diagnostic");
    };
    let value: serde_json::Value =
        serde_json::from_str(&diagnostic).expect("diagnostic should be JSON");
    assert_eq!(value["code"], serde_json::json!("invalidAssignment"));
    assert_eq!(
        value["context"]["reason"]["kind"],
        serde_json::json!("passengerNotRiding")
    );
}

#[test]
fn valid_driving_trip_is_persistence_valid() {
    GameEngine::from_snapshot(valid_driving_snapshot())
        .expect("captured road path should survive save/load");
}

#[test]
fn restored_driving_trip_survives_tick_save_and_reload() {
    let mut engine =
        GameEngine::from_snapshot(valid_driving_snapshot()).expect("driving snapshot loads");
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );

    let tick = engine.tick(1.0);
    assert!(tick.applied, "running engine should advance the clock");

    let saved = engine.snapshot_for_save();
    let saved_trip = &saved.active_trips[0];
    assert_eq!(saved_trip.status, TripStatus::Driving);
    assert!(saved_trip.private_car_trip.is_some());

    let reloaded = GameEngine::from_snapshot(saved).expect("ticked driving save reloads");
    let reloaded_trip = &reloaded.snapshot().active_trips[0];
    assert_eq!(reloaded_trip.status, TripStatus::Driving);
    assert!(reloaded_trip.private_car_trip.is_some());
}

#[test]
fn driving_trip_requires_a_private_car_payload() {
    let mut snapshot = valid_driving_snapshot();
    snapshot.active_trips[0].private_car_trip = None;

    assert_invalid_trip_field(snapshot, "tripPrivateCar");
}

#[test]
fn driving_trip_rejects_a_route_plan() {
    let mut snapshot = valid_driving_snapshot();
    snapshot.active_trips[0].route_plan = Some(RoutePlan {
        legs: Vec::new(),
        estimated_seconds: 0.0,
    });

    assert_invalid_trip_field(snapshot, "tripRoutePlan");
}

#[test]
fn non_driving_trip_rejects_a_private_car_payload() {
    let mut snapshot = valid_driving_snapshot();
    snapshot.active_trips[0].status = TripStatus::Idle;

    assert_invalid_trip_field(snapshot, "tripPrivateCar");
}

#[test]
fn driving_trip_rejects_transit_vehicle_membership() {
    let mut snapshot = engine_with_bus_route().snapshot();
    snapshot
        .sims
        .push(worker_sim("sim-driving", Point { x: 1, y: 1 }, None));
    snapshot.active_trips.push(driving_trip());
    snapshot.transit.vehicles[0].passenger_ids = vec!["trip-driving".to_string()];

    assert_invalid_transit_membership(snapshot);
}

#[test]
fn driving_trip_requires_a_road_private_car_path() {
    let mut snapshot = valid_driving_snapshot();
    snapshot.active_trips[0].private_car_trip = Some(PrivateCarTrip {
        path: TransitPath::Track {
            steps: Vec::new(),
            total_travel_seconds: 0.0,
        },
        arrival_time: 101.25,
    });

    assert_invalid_trip_field(snapshot, "tripPrivateCar");
}

#[test]
fn driving_trip_rejects_negative_or_nonfinite_arrival_time() {
    for arrival_time in [-1.0, f64::NAN, f64::INFINITY] {
        let mut snapshot = valid_driving_snapshot();
        snapshot.active_trips[0]
            .private_car_trip
            .as_mut()
            .expect("fixture car payload")
            .arrival_time = arrival_time;

        assert_invalid_trip_field(snapshot, "tripPrivateCarArrivalTime");
    }
}

fn engine_with_bus_route() -> GameEngine {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        assert!(engine.dispatch(GameIntent::AddBusStop { point }).applied);
    }
    assert!(
        engine
            .dispatch(GameIntent::CreateRoute {
                mode: caelum_core::model::TransitMode::Bus,
                pattern: caelum_core::model::ServicePattern::Loop,
                waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            })
            .applied
    );
    engine
}

#[test]
fn unsupported_schema_rejects_before_replacing_the_target() {
    let mut target = GameEngine::new();
    let before = target.snapshot();
    let mut candidate = before.clone();
    candidate.schema_version -= 1;

    let error = target.restore_snapshot(candidate).unwrap_err();

    assert_eq!(
        error,
        SnapshotLoadError::UnsupportedSchema {
            expected: caelum_core::SNAPSHOT_SCHEMA_VERSION,
            actual: caelum_core::SNAPSHOT_SCHEMA_VERSION - 1,
        }
    );
    assert_eq!(target.snapshot(), before);
}

#[test]
fn wrong_tile_count_is_rejected() {
    let mut candidate = GameEngine::new().snapshot();
    candidate.map.tiles.pop();

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn duplicate_entity_id_is_rejected() {
    let mut candidate = engine_with_bus_route().snapshot();
    candidate.transit.stations.push(Station {
        id: "stop-001".to_string(),
        status: TransitNodeStatus::Missing,
        position: Point { x: 4, y: 4 },
        platforms: Vec::new(),
    });

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn missing_route_reference_is_rejected() {
    let mut candidate = engine_with_bus_route().snapshot();
    candidate.transit.routes[0].stop_ids[0] = "missing-node".to_string();

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn non_reciprocal_ordinary_road_is_rejected_before_topology_compile() {
    let mut candidate = GameEngine::new();
    assert!(
        candidate
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=4).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    let mut snapshot = candidate.snapshot();
    snapshot
        .map
        .tile_mut(Point { x: 3, y: 5 })
        .expect("fixture road tile")
        .road_connections
        .clear();

    invalid_snapshot(from_snapshot_error(snapshot));
}

#[test]
fn genuine_structure_compile_failure_is_rejected_by_from_snapshot() {
    let mut snapshot = GameEngine::new().snapshot();
    let structure_id = "roundabout-unsafe".to_string();
    let footprint = vec![Point { x: 4, y: 2 }, Point { x: 5, y: 2 }];
    for point in &footprint {
        let tile = snapshot.map.tile_mut(*point).expect("fixture tile");
        tile.kind = "road".to_string();
        tile.road_structure_id = Some(structure_id.clone());
    }
    snapshot
        .map
        .road_structures
        .push(RoadStructure::Roundabout {
            id: structure_id,
            origin: Point {
                x: i32::MAX,
                y: i32::MAX,
            },
            size: RoundaboutSize::Compact2x2,
            footprint,
            ports: Vec::new(),
        });

    invalid_snapshot(from_snapshot_error(snapshot));
}

#[test]
fn failed_restore_preserves_the_active_engine() {
    let mut target = GameEngine::new();
    let before = target.snapshot();
    let mut candidate = before.clone();
    candidate.map.tiles.pop();

    invalid_snapshot(target.restore_snapshot(candidate).unwrap_err());
    assert_eq!(target.snapshot(), before);
}

#[test]
fn save_returns_a_paused_clone_without_mutating_live_state() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let before = engine.snapshot();

    let saved = engine.snapshot_for_save();

    assert!(saved.paused);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn accepts_stale_derived_building_footprint_and_vehicle_capacity() {
    let mut engine = engine_with_bus_route();
    assert!(
        engine
            .dispatch(GameIntent::PaintAreaRectangle {
                area: "residential".to_string(),
                start: Point { x: 2, y: 3 },
                end: Point { x: 3, y: 3 },
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::PlaceBuilding {
                building_type: "smallHouse".to_string(),
                origin: Point { x: 2, y: 3 },
                rotation: 0,
            })
            .applied
    );

    let mut candidate = engine.snapshot();
    candidate.buildings[0].occupied_tiles.clear();
    candidate.transit.vehicles[0].capacity = 0;

    let restored = GameEngine::from_snapshot(candidate).expect("derived fields normalize");

    assert_eq!(
        restored.snapshot().buildings[0].occupied_tiles,
        engine.snapshot().buildings[0].occupied_tiles
    );
    assert_eq!(
        restored.snapshot().transit.vehicles[0].capacity,
        engine.snapshot().transit.vehicles[0].capacity
    );
}

#[test]
fn rejects_vehicle_path_step_index_outside_the_normalized_route_path() {
    let engine = engine_with_bus_route();
    let mut candidate = engine.snapshot();
    let step_count = candidate.transit.routes[0].legs[0]
        .current_path
        .as_ref()
        .expect("fixture route has a serialized path")
        .step_count();
    assert!(step_count > 1);
    // A path step equal to the leg's step count is out of bounds; this is the
    // sole mutation, so the rejection is attributable only to it.
    candidate.transit.vehicles[0].path_step_index = step_count;

    let SnapshotLoadError::InvalidSnapshot(diagnostic) = from_snapshot_error(candidate) else {
        panic!("expected an invalid snapshot error");
    };
    assert!(
        diagnostic.contains("pathStepIndexOutOfBounds"),
        "expected the path-step-index diagnostic, got: {diagnostic}"
    );
}

#[test]
fn deterministic_round_trip_preserves_the_save_snapshot() {
    let engine = engine_with_bus_route();
    let saved = engine.snapshot_for_save();
    let restored = GameEngine::from_snapshot(saved.clone()).expect("save must load");

    assert_eq!(restored.snapshot_for_save(), saved);
}
