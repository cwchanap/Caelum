//! Shared fixtures for the `persistence_*_validation` integration tests.
//!
//! Each persistence validation test file builds a persistence-valid baseline
//! snapshot (via the engine's own intent pipeline + `snapshot_for_save`) and
//! then mutates a single field to exercise one rejection branch. The helpers
//! here produce those baselines so each test file does not need to reconstruct
//! them.

#![allow(dead_code)]

use caelum_core::model::{
    self, ActiveTrip, Point, RoadStructure, RouteLeg, RoutePlan, ServicePattern, Sim, TransitMode,
    TripPosition, TripPurpose, TripStatus, WorkerProfile,
};
use caelum_core::scenario::{growing_suburb_campaign, growing_suburb_objectives};
use caelum_core::{
    EntityKind, EntityRef, GameEngine, GameIntent, GameSnapshot, RoadPreset, SandboxCreationRequest,
};

/// Dispatch an intent and assert it was applied (not rejected or unchanged).
pub fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent was rejected or unchanged: {:?}",
        result.rejection
    );
}

/// A paused, persistence-valid snapshot with a bus route (two stops + vehicle),
/// a metro line (two stations + vehicle), residential + commercial buildings,
/// a sim with a walking commute trip, and a riding trip on the bus route.
pub fn rich_fixture() -> GameSnapshot {
    let mut engine = GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "crossroads".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(150_000.0),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    })
    .expect("rich fixture sandbox request must be supported");

    // Bus road along y=5, stops at x=2 and x=10.
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        apply(&mut engine, GameIntent::AddBusStop { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );

    // Metro track along y=12, stations at x=2 and x=10.
    apply(
        &mut engine,
        GameIntent::LayTrackLine {
            points: (2..=12).map(|x| Point { x, y: 12 }).collect(),
        },
    );
    for point in [Point { x: 2, y: 12 }, Point { x: 10, y: 12 }] {
        apply(&mut engine, GameIntent::AddMetroStation { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Metro,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
        },
    );

    // Residential + commercial buildings so sims can commute.
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: Point { x: 2, y: 2 },
            end: Point { x: 3, y: 2 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 2, y: 2 },
            rotation: 0,
        },
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "commercial".to_string(),
            start: Point { x: 10, y: 2 },
            end: Point { x: 11, y: 3 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "supermarket".to_string(),
            origin: Point { x: 10, y: 2 },
            rotation: 0,
        },
    );

    // Run the clock long enough to spawn a sim and an active trip, then pause.
    apply(&mut engine, GameIntent::SetPaused { paused: false });
    assert!(engine.tick(350.9).applied);
    let mut ticks = 0;
    loop {
        if !engine.snapshot().sims.is_empty()
            && !engine.snapshot().active_trips.is_empty()
            && engine
                .snapshot()
                .active_trips
                .iter()
                .any(|trip| matches!(trip.status, TripStatus::Riding))
        {
            break;
        }
        assert!(engine.tick(1.0).applied);
        ticks += 1;
        if ticks > 600 {
            panic!("fixture did not produce a riding trip within 600 ticks");
        }
    }
    apply(&mut engine, GameIntent::SetPaused { paused: true });
    let snapshot = engine.snapshot_for_save().expect("rich fixture must save");
    // Verify the riding trip is associated with its vehicle: some vehicle must
    // list the riding trip among its passenger_ids.
    let riding = snapshot
        .active_trips
        .iter()
        .find(|trip| matches!(trip.status, TripStatus::Riding))
        .expect("fixture must contain a riding trip at save time");
    assert!(
        snapshot
            .transit
            .vehicles
            .iter()
            .any(|v| v.passenger_ids.iter().any(|id| id == &riding.id)),
        "riding trip {} must be listed among some vehicle's passengers",
        riding.id
    );
    snapshot
}

/// A paused, persistence-valid snapshot used by every host-parity fixture.
///
/// The state is built entirely through public engine operations. After the
/// rich transit/trip state exists, removing one metro track tile produces a
/// valid broken metro line whose `currentPath` serializes as `null` while the
/// active bus trip retains its route plan.
pub fn host_parity_fixture() -> GameSnapshot {
    let mut engine = GameEngine::from_snapshot(rich_fixture())
        .expect("rich fixture must restore into an engine");
    apply(
        &mut engine,
        GameIntent::RemoveAtTile {
            point: Point { x: 6, y: 12 },
        },
    );

    let snapshot = engine
        .snapshot_for_save()
        .expect("host-parity fixture must save");
    assert!(snapshot.paused, "host-parity fixture must be paused");
    caelum_core::validate_snapshot(&snapshot).expect("host-parity fixture must validate");
    assert!(
        snapshot.scenario.objectives.is_none(),
        "sandbox fixture must omit objectives"
    );
    assert!(
        snapshot.metrics.loss_reason.is_none(),
        "sandbox fixture must omit a loss reason"
    );
    assert!(
        snapshot
            .active_trips
            .iter()
            .any(|trip| trip.route_plan.is_some()),
        "fixture must contain an active trip with a route plan"
    );
    assert!(
        snapshot.active_trips.iter().any(|trip| {
            trip.route_plan.as_ref().is_some_and(|plan| {
                plan.legs.iter().any(|leg| {
                    leg.service_direction.is_none()
                        && leg.board_itinerary_index.is_none()
                        && leg.alight_itinerary_index.is_none()
                })
            })
        }),
        "fixture must contain a route-plan leg with required null option fields"
    );
    assert!(
        snapshot
            .transit
            .vehicles
            .iter()
            .any(|vehicle| vehicle.parked_position.is_none()),
        "fixture must contain a vehicle without a parked position"
    );

    let serialized = serde_json::to_value(&snapshot).expect("fixture must serialize");
    assert!(
        ["routes", "metroLines"].iter().any(|collection| {
            serialized["transit"][collection]
                .as_array()
                .is_some_and(|lines| {
                    lines.iter().any(|line| {
                        line["legs"].as_array().is_some_and(|legs| {
                            legs.iter().any(|leg| {
                                leg.get("currentPath")
                                    .is_some_and(serde_json::Value::is_null)
                                    || leg
                                        .get("lastValidPath")
                                        .is_some_and(serde_json::Value::is_null)
                            })
                        })
                    })
                })
        }),
        "fixture must serialize a non-skipped route-path option as null"
    );

    snapshot
}

/// A minimal paused snapshot (no transit) for tests that only need the shell.
pub fn paused_snapshot() -> GameSnapshot {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.paused = true;
    snapshot
}

/// A campaign-mode paused snapshot (Growing Suburb) for rules/scenario tests.
pub fn campaign_snapshot() -> GameSnapshot {
    let mut snapshot = paused_snapshot();
    let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    snapshot.rules = rules;
    snapshot.scenario = scenario;
    snapshot
}

/// A paused snapshot with a single road roundabout structure, for tests that
/// need an existing road structure on the map.
pub fn road_with_structure() -> GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: Point { x: 6, y: 5 },
            size: model::RoundaboutSize::Compact2x2,
        },
    );
    // Engine starts paused; snapshot_for_save enforces paused state.
    engine.snapshot_for_save().expect("fixture must save")
}

/// A paused snapshot with a single bus route (two stops + one vehicle), for
/// route shape and vehicle validation tests.
pub fn fixture_with_bus_route() -> GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        apply(&mut engine, GameIntent::AddBusStop { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );
    // Engine starts paused; snapshot_for_save enforces paused state.
    engine.snapshot_for_save().expect("fixture must save")
}

/// Build an `EntityRef` for use in expected `PersistenceError` assertions.
pub fn entity_ref(kind: EntityKind, id: &str) -> EntityRef {
    EntityRef {
        kind,
        id: id.to_string(),
    }
}

/// Construct a worker sim with the given id, home tile, and optional workplace.
pub fn worker_sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

/// A paused snapshot with one worker sim and one idle commute trip, for trip
/// endpoint and position validation tests.
pub fn trip_fixture() -> GameSnapshot {
    let home = Point { x: 2, y: 3 };
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![worker_sim("sim-001", home, Some(Point { x: 4, y: 3 }))];
    snapshot.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: Point { x: 4, y: 3 },
        position: TripPosition::from(home),
        status: TripStatus::Idle,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    snapshot.trip_sequence_day = 0;
    snapshot.next_trip_sequence = 2;
    snapshot
}

/// A walking `RoutePlan` from `home` to `destination` with the correct
/// estimated seconds, for positive router validation cases.
pub fn walking_plan(home: Point, destination: Point) -> RoutePlan {
    RoutePlan {
        legs: vec![RouteLeg {
            mode: TransitMode::Walk,
            from: home,
            to: destination,
            line_id: None,
            service_direction: None,
            board_itinerary_index: None,
            alight_itinerary_index: None,
        }],
        estimated_seconds: f64::from(
            (home.x - destination.x).abs() + (home.y - destination.y).abs(),
        ) * 20.0,
    }
}

/// Derive a row-major tile index from `snapshot.map.width` and `(x, y)`
/// coordinates, replacing hardcoded `y * 28 + x` calculations in the
/// persistence map/entity tests so they track the fixture's actual map width.
pub fn tile_index(snapshot: &GameSnapshot, x: i32, y: i32) -> usize {
    (usize::try_from(y).unwrap() * usize::from(snapshot.map.width)) + usize::try_from(x).unwrap()
}

/// Find the roundabout structure ID in the snapshot, panicking when the
/// snapshot lacks one. Shared by the persistence map coverage tests that need
/// to reference the fixture's roundabout by ID.
pub fn roundabout_id(snapshot: &GameSnapshot) -> String {
    snapshot
        .map
        .road_structures
        .iter()
        .find_map(|structure| match structure {
            RoadStructure::Roundabout { id, .. } => Some(id.clone()),
            _ => None,
        })
        .expect("snapshot must contain a roundabout")
}
