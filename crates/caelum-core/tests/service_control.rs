//! Transit service metric derivation and publication (HPA-624 Task 2).
//!
//! Rust owns all service timing and fleet math. These integration tests lock
//! the public contract: `GameEngine::snapshot()` publishes derived
//! `service_metrics` for bus routes and Metro lines, `snapshot_for_save()` keeps persisted
//! saves free of them, incoming `serviceMetrics` never becomes authority, and
//! a structurally operational bus route with zero vehicles is not a passenger
//! service until a vehicle is assigned.
//!
//! The exact cycle-time vectors (302s/402s shuttle, 600/601 fleet rounding)
//! live as unit tests inside `src/service_control.rs` next to the `pub(crate)`
//! functions they lock.

use caelum_core::model::{
    ActiveTrip, EconomyPreset, Point, PrivateCarTrip, Sim, TransitMode, TransitPath, TripPosition,
    TripPurpose, TripStatus, WorkerProfile,
};
use caelum_core::traffic::RoadFlow;
use caelum_core::transit::{BUS_CAPACITY, BUS_COST, METRO_CAPACITY, METRO_COST};
use caelum_core::{router, GameEngine, GameIntent, RejectionCode, RoadPreset, SnapshotLoadError};

/// Network used by a connected loop bus route with no assigned vehicles.
fn bus_network_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(road.applied, "fixture road should apply: {road:?}");
    for point in [Point { x: 2, y: 4 }, Point { x: 12, y: 4 }] {
        let stop = engine.dispatch(GameIntent::AddBusStop { point });
        assert!(stop.applied, "fixture stop should apply: {stop:?}");
    }
    engine
}

/// Connected loop bus route with no assigned vehicles.
fn bus_route_engine() -> GameEngine {
    let mut engine = bus_network_engine();
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "fixture route should apply: {route:?}");
    engine
}

/// A connected loop bus route whose cycle exceeds the 60-second headway floor,
/// so a target at the floor requires at least two vehicles.
fn long_bus_route_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=27).map(|x| Point { x, y: 5 }).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(road.applied, "fixture road should apply: {road:?}");
    for point in [Point { x: 2, y: 4 }, Point { x: 27, y: 4 }] {
        let stop = engine.dispatch(GameIntent::AddBusStop { point });
        assert!(stop.applied, "fixture stop should apply: {stop:?}");
    }
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "fixture route should apply: {route:?}");
    engine
}

/// Connected metro network with no line or assigned vehicles.
fn metro_network_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    let track = engine.dispatch(GameIntent::LayTrackLine {
        points: (2..=12).map(|x| Point { x, y: 4 }).collect(),
    });
    assert!(track.applied, "fixture track should apply: {track:?}");
    for point in [Point { x: 2, y: 4 }, Point { x: 12, y: 4 }] {
        let station = engine.dispatch(GameIntent::AddMetroStation { point });
        assert!(station.applied, "fixture station should apply: {station:?}");
    }
    engine
}

/// Connected metro line with no assigned vehicles.
fn metro_line_engine() -> GameEngine {
    let mut engine = metro_network_engine();
    let line = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(line.applied, "fixture line should apply: {line:?}");
    engine
}

fn long_metro_line_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(200_000);
    for points in [
        (2..=25).map(|x| Point { x, y: 2 }).collect::<Vec<_>>(),
        (2..=15).map(|y| Point { x: 25, y }).collect::<Vec<_>>(),
        (2..=25)
            .rev()
            .map(|x| Point { x, y: 15 })
            .collect::<Vec<_>>(),
        (2..=15)
            .rev()
            .map(|y| Point { x: 2, y })
            .collect::<Vec<_>>(),
    ] {
        let track = engine.dispatch(GameIntent::LayTrackLine { points });
        assert!(track.applied, "fixture track should apply: {track:?}");
    }
    for point in [
        Point { x: 2, y: 2 },
        Point { x: 25, y: 2 },
        Point { x: 25, y: 15 },
        Point { x: 2, y: 15 },
    ] {
        let station = engine.dispatch(GameIntent::AddMetroStation { point });
        assert!(station.applied, "fixture station should apply: {station:?}");
    }
    let line = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: caelum_core::model::ServicePattern::Shuttle,
        waypoint_ids: vec![
            "station-001".to_string(),
            "station-002".to_string(),
            "station-003".to_string(),
            "station-004".to_string(),
        ],
    });
    assert!(line.applied, "fixture metro line should apply: {line:?}");
    engine
}

/// Free-flow cycle time derived the same way `service_control` derives it: every
/// current-path step at its stored per-step duration (flow-free).
fn free_flow_cycle_seconds(engine: &GameEngine) -> f64 {
    engine.snapshot().transit.routes[0]
        .legs
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .flat_map(|path| path.step_refs())
        .map(|step| step.travel_seconds())
        .sum()
}

#[test]
fn bus_route_creation_is_fleet_free_and_budget_free() {
    let mut engine = bus_network_engine();
    let before = engine.snapshot();
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(created.applied, "fixture route should apply: {created:?}");

    assert!(created.snapshot.transit.routes[0].vehicle_ids.is_empty());
    assert!(created.snapshot.transit.vehicles.is_empty());
    assert_eq!(created.snapshot.budget, before.budget);
}

#[test]
fn metro_line_creation_is_fleet_free_and_budget_free() {
    let mut engine = metro_network_engine();
    let before = engine.snapshot();
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: caelum_core::model::ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(created.applied, "fixture line should apply: {created:?}");

    assert!(created.snapshot.transit.metro_lines[0]
        .vehicle_ids
        .is_empty());
    assert!(created.snapshot.transit.vehicles.is_empty());
    assert_eq!(created.snapshot.budget, before.budget);
}

#[test]
fn target_headway_is_setup_only_and_enforces_the_minimum() {
    let mut engine = bus_route_engine();
    let before = engine.snapshot();
    let revision = before.transit.routes[0].revision;

    let applied = engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(applied.applied, "minimum headway should apply: {applied:?}");
    assert_eq!(
        applied.snapshot.transit.routes[0].target_headway_seconds,
        Some(60)
    );
    assert_eq!(applied.snapshot.transit.routes[0].revision, revision);
    assert!(applied.snapshot.transit.routes[0].vehicle_ids.is_empty());

    let unchanged = engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(
        !unchanged.applied,
        "same target should be a no-op: {unchanged:?}"
    );
    assert!(unchanged.rejection.is_none());
    assert_eq!(unchanged.snapshot.transit.routes[0].revision, revision);

    let invalid = engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".to_string(),
        target_headway_seconds: 59,
    });
    assert_eq!(
        invalid.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InvalidHeadway),
    );
    assert_eq!(
        invalid.snapshot.transit.routes[0].target_headway_seconds,
        Some(60)
    );

    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "low-level assignment should remain valid: {assigned:?}"
    );
    let locked = engine.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "route-001".to_string(),
        target_headway_seconds: 120,
    });
    assert_eq!(
        locked.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );
}

#[test]
fn deployment_requires_target_and_existing_route_state() {
    let mut missing_target = bus_route_engine();
    let missing = missing_target.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        missing.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::HeadwayNotSet),
    );

    let mut inactive = bus_route_engine();
    assert!(
        inactive
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".to_string(),
                target_headway_seconds: 60,
            })
            .applied
    );
    assert!(
        inactive
            .dispatch(GameIntent::SetRouteActive {
                route_id: "route-001".to_string(),
                active: false,
            })
            .applied
    );
    let inactive_result = inactive.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        inactive_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::InactiveRoute),
    );

    let mut broken = bus_route_engine();
    assert!(
        broken
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".to_string(),
                target_headway_seconds: 60,
            })
            .applied
    );
    assert!(
        broken
            .dispatch(GameIntent::RemoveAtTile {
                point: Point { x: 6, y: 5 },
            })
            .applied
    );
    let broken_result = broken.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        broken_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::DisconnectedLeg),
    );
}

#[test]
fn deployment_rejects_existing_fleet_before_target_or_route_state() {
    let mut before_target = bus_route_engine();
    let assigned = before_target.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture vehicle should apply: {assigned:?}"
    );
    let missing_target = before_target.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        missing_target
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );

    let mut paused = bus_route_engine();
    assert!(
        paused
            .dispatch(GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: "route-001".to_string(),
            })
            .applied
    );
    assert!(
        paused
            .dispatch(GameIntent::SetRouteActive {
                route_id: "route-001".to_string(),
                active: false,
            })
            .applied
    );
    let paused_result = paused.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        paused_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );

    let mut broken = bus_route_engine();
    assert!(
        broken
            .dispatch(GameIntent::AssignVehicle {
                mode: "bus".to_string(),
                line_id: "route-001".to_string(),
            })
            .applied
    );
    assert!(
        broken
            .dispatch(GameIntent::RemoveAtTile {
                point: Point { x: 6, y: 5 },
            })
            .applied
    );
    let broken_result = broken.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        broken_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );
}

#[test]
fn metro_deployment_uses_line_id_and_metro_cost_atomically() {
    let mut setup = metro_line_engine();
    let targeted = setup.dispatch(GameIntent::SetServiceTargetHeadway {
        line_id: "metro-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(targeted.applied, "metro target should apply: {targeted:?}");
    let required = targeted.snapshot.transit.metro_lines[0]
        .service_metrics
        .as_ref()
        .and_then(|metrics| metrics.required_fleet)
        .expect("targeted metro line should expose required fleet");
    let total_cost = i32::try_from(required)
        .expect("fixture fleet fits i32")
        .checked_mul(METRO_COST)
        .expect("fixture fleet cost fits i32");
    let configured = setup.snapshot_for_save();

    let mut exact = GameEngine::from_snapshot(configured.clone()).expect("exact fixture loads");
    exact.set_budget_for_test(total_cost);
    let deployed = exact.dispatch(GameIntent::DeployInitialFleet {
        line_id: "metro-001".to_string(),
    });
    assert!(deployed.applied, "exact budget should deploy: {deployed:?}");
    assert_eq!(
        deployed.snapshot.transit.metro_lines[0].vehicle_ids.len(),
        required
    );
    assert_eq!(deployed.snapshot.transit.vehicles.len(), required);
    assert_eq!(deployed.snapshot.budget, 0);

    let mut short = GameEngine::from_snapshot(configured.clone()).expect("short fixture loads");
    short.set_budget_for_test(total_cost - 1);
    let before = short.snapshot();
    let rejected = short.dispatch(GameIntent::DeployInitialFleet {
        line_id: "metro-001".to_string(),
    });
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InsufficientBudget),
    );
    assert!(rejected.snapshot.transit.metro_lines[0]
        .vehicle_ids
        .is_empty());
    assert!(rejected.snapshot.transit.vehicles.is_empty());
    assert_eq!(rejected.snapshot.budget, before.budget);

    let mut creative_state = configured;
    creative_state.rules.economy_preset = EconomyPreset::Creative;
    creative_state.budget = 7;
    let mut creative = GameEngine::from_snapshot(creative_state).expect("creative fixture loads");
    let creative_budget = creative.snapshot().budget;
    let creative_result = creative.dispatch(GameIntent::DeployInitialFleet {
        line_id: "metro-001".to_string(),
    });
    assert!(
        creative_result.applied,
        "creative deploy should be free: {creative_result:?}"
    );
    assert_eq!(
        creative_result.snapshot.transit.metro_lines[0]
            .vehicle_ids
            .len(),
        required
    );
    assert_eq!(creative_result.snapshot.budget, creative_budget);
}

#[test]
fn deployment_buys_the_whole_fleet_atomically_and_is_one_shot() {
    let mut exact = bus_route_engine();
    assert!(
        exact
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".to_string(),
                target_headway_seconds: 60,
            })
            .applied
    );
    let required = exact.snapshot().transit.routes[0]
        .service_metrics
        .as_ref()
        .and_then(|metrics| metrics.required_fleet)
        .expect("targeted route should expose required fleet");
    let cost = i32::try_from(required)
        .expect("fixture fleet fits i32")
        .checked_mul(BUS_COST)
        .expect("fixture fleet cost fits i32");
    exact.set_budget_for_test(cost);
    let deployed = exact.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert!(deployed.applied, "exact budget should deploy: {deployed:?}");
    assert_eq!(
        deployed.snapshot.transit.routes[0].vehicle_ids.len(),
        required
    );
    assert_eq!(
        deployed.snapshot.transit.vehicles.len(),
        required,
        "all vehicles must be added together"
    );
    assert_eq!(deployed.snapshot.budget, 0);

    let second = exact.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        second.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );

    let mut short = bus_route_engine();
    assert!(
        short
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".to_string(),
                target_headway_seconds: 60,
            })
            .applied
    );
    short.set_budget_for_test(cost - 1);
    let before = short.snapshot();
    let rejected = short.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InsufficientBudget),
    );
    assert_eq!(rejected.snapshot.transit.routes[0].vehicle_ids.len(), 0);
    assert_eq!(rejected.snapshot.transit.vehicles.len(), 0);
    assert_eq!(rejected.snapshot.budget, before.budget);

    let mut creative_state = bus_route_engine().snapshot_for_save();
    creative_state.transit.routes[0].target_headway_seconds = Some(60);
    creative_state.rules.economy_preset = EconomyPreset::Creative;
    creative_state.budget = 0;
    let mut creative = GameEngine::from_snapshot(creative_state).expect("creative fixture loads");
    let creative_result = creative.dispatch(GameIntent::DeployInitialFleet {
        line_id: "route-001".to_string(),
    });
    assert!(
        creative_result.applied,
        "creative deploy should be free: {creative_result:?}"
    );
    assert_eq!(
        creative_result.snapshot.transit.routes[0].vehicle_ids.len(),
        required
    );
    assert_eq!(creative_result.snapshot.budget, 0);
}

fn shortfall_bus_engine() -> GameEngine {
    let mut engine = long_bus_route_engine();
    let cycle = engine.snapshot().transit.routes[0]
        .service_metrics
        .as_ref()
        .expect("fixture route has service metrics")
        .round_trip_seconds;
    assert!(cycle > 60.0, "fixture must support a multi-vehicle fleet");
    let target = ((cycle / 2.0).ceil() as u32).max(60);

    assert!(
        engine
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".into(),
                target_headway_seconds: target,
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::DeployInitialFleet {
                line_id: "route-001".into(),
            })
            .applied
    );
    assert!(
        engine.snapshot().transit.routes[0]
            .service_metrics
            .as_ref()
            .expect("deployed route has metrics")
            .assigned_fleet
            >= 2
    );

    let mut slowed = engine.snapshot_for_save();
    for leg in &mut slowed.transit.routes[0].legs {
        let Some(TransitPath::Road {
            steps,
            total_travel_seconds,
        }) = leg.current_path.as_mut()
        else {
            continue;
        };
        for step in steps.iter_mut() {
            step.travel_seconds *= 2.0;
        }
        *total_travel_seconds = steps.iter().map(|step| step.travel_seconds).sum();
    }
    let slowed_cycle: f64 = slowed.transit.routes[0]
        .legs
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .flat_map(|path| path.step_refs())
        .map(|step| step.travel_seconds())
        .sum();
    assert!(
        slowed_cycle > cycle,
        "timing fixture did not change: {slowed_cycle} vs {cycle}"
    );
    let traffic_path = slowed.transit.routes[0]
        .legs
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .find(|path| !path.road_steps().is_empty())
        .cloned()
        .expect("fixture has a road service path");
    for index in 0..8 {
        let suffix = format!("{:03}", index + 1);
        let sim_id = format!("sim-traffic-{suffix}");
        slowed.sims.push(Sim {
            id: sim_id.clone(),
            home: Point { x: 2, y: 4 },
            position: Point { x: 2, y: 4 },
            worker_profile: WorkerProfile::Worker,
            shift_template: None,
            workplace: None,
            commute_day: 0,
            outbound_resolved_today: false,
            outbound_arrived_today: false,
            return_resolved_today: false,
            returned_home_today: false,
        });
        slowed.active_trips.push(ActiveTrip {
            id: format!("traffic-{suffix}"),
            sim_id,
            purpose: TripPurpose::CommuteOutbound,
            origin: Point { x: 2, y: 5 },
            destination: Point { x: 27, y: 5 },
            position: TripPosition { x: 2.0, y: 5.0 },
            status: TripStatus::Driving,
            deadline: 300.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 30.0,
            private_car_trip: Some(PrivateCarTrip {
                path: traffic_path.clone(),
                arrival_time: 100.0,
            }),
        });
    }
    let mut engine = GameEngine::from_snapshot(slowed).expect("slowed fixture loads");
    let resumed = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(resumed.applied, "resume should apply: {resumed:?}");
    engine
}

#[test]
fn add_service_vehicle_fills_bus_shortfall_without_repositioning_existing_fleet() {
    let mut engine = shortfall_bus_engine();
    let before = engine.snapshot();
    let metrics = before.transit.routes[0]
        .service_metrics
        .as_ref()
        .expect("slowed route has metrics");
    assert!(
        metrics.required_fleet.expect("target is set") > metrics.assigned_fleet,
        "slowed cycle should create a shortfall: {metrics:?}"
    );
    assert_eq!(metrics.next_vehicle_cost, Some(BUS_COST));
    let wire_before = serde_json::to_value(&before).expect("shortfall response serializes");
    assert_eq!(
        wire_before["transit"]["routes"][0]["serviceMetrics"]["nextVehicleCost"],
        serde_json::json!(BUS_COST)
    );
    let mut paused = engine.clone();
    let paused_result = paused.dispatch(GameIntent::SetPaused { paused: true });
    assert!(
        paused_result.applied,
        "pause should apply: {paused_result:?}"
    );
    assert_eq!(
        paused_result.snapshot.transit.routes[0]
            .service_metrics
            .as_ref()
            .expect("paused response has metrics")
            .next_vehicle_cost,
        None,
        "paused service must not publish a top-up offer"
    );
    let existing = before.transit.vehicles.clone();
    let before_budget = before.budget;

    let added = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(added.applied, "top-up should apply: {added:?}");
    assert_eq!(added.snapshot.transit.vehicles.len(), existing.len() + 1);
    assert_eq!(
        &added.snapshot.transit.vehicles[..existing.len()],
        existing.as_slice(),
        "existing vehicles must remain byte-for-byte unchanged"
    );
    let new_vehicle = added
        .snapshot
        .transit
        .vehicles
        .last()
        .expect("top-up appends one vehicle");
    assert_eq!(new_vehicle.mode, TransitMode::Bus);
    assert_eq!(new_vehicle.capacity, BUS_CAPACITY);
    assert!(
        existing.iter().all(|vehicle| {
            (
                new_vehicle.itinerary_index,
                new_vehicle.path_step_index,
                new_vehicle.step_progress,
            ) != (
                vehicle.itinerary_index,
                vehicle.path_step_index,
                vehicle.step_progress,
            )
        }),
        "new vehicle cursor must occupy a distinct cycle offset"
    );
    assert_eq!(added.snapshot.budget, before_budget - BUS_COST);
    assert_eq!(
        added.snapshot.transit.routes[0]
            .service_metrics
            .as_ref()
            .expect("top-up response has metrics")
            .next_vehicle_cost,
        None
    );
    let wire = serde_json::to_value(&added.snapshot).expect("top-up response serializes");
    assert_eq!(
        wire["transit"]["routes"][0]["serviceMetrics"]["nextVehicleCost"],
        serde_json::json!(null)
    );
}

#[test]
fn add_service_vehicle_is_free_in_creative_mode() {
    let mut state = shortfall_bus_engine().snapshot_for_save();
    state.rules.economy_preset = EconomyPreset::Creative;
    state.budget = 7;
    let mut engine = GameEngine::from_snapshot(state).expect("creative shortfall loads");
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(result.applied, "creative top-up should apply: {result:?}");
    assert_eq!(result.snapshot.budget, before.budget);
    assert_eq!(
        result.snapshot.transit.routes[0].vehicle_ids.len(),
        before.transit.routes[0].vehicle_ids.len() + 1
    );
}

#[test]
fn add_service_vehicle_rejects_insufficient_standard_budget_atomically() {
    let mut engine = shortfall_bus_engine();
    engine.set_budget_for_test(BUS_COST - 1);
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::InsufficientBudget)
    );
    assert_eq!(result.snapshot.budget, before.budget);
    assert_eq!(
        result.snapshot.transit.vehicles.len(),
        before.transit.vehicles.len()
    );
}

#[test]
fn repeated_top_up_actions_stop_at_the_live_requirement() {
    let mut engine = shortfall_bus_engine();
    let before = engine.snapshot();
    let first = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(first.applied, "first top-up should apply: {first:?}");
    let after_first = engine.snapshot();
    assert_eq!(
        after_first.transit.routes[0]
            .service_metrics
            .as_ref()
            .expect("metrics after first top-up")
            .next_vehicle_cost,
        None
    );
    let stale = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(!stale.applied, "stale top-up should be a no-op: {stale:?}");
    assert!(stale.rejection.is_none());
    assert_eq!(stale.snapshot.budget, after_first.budget);
    assert_eq!(
        stale.snapshot.transit.routes[0].vehicle_ids.len(),
        before.transit.routes[0].vehicle_ids.len() + 1
    );
}

#[test]
fn add_service_vehicle_validates_service_state_before_budget() {
    let mut inactive = shortfall_bus_engine();
    inactive.set_budget_for_test(0);
    assert!(
        inactive
            .dispatch(GameIntent::SetRouteActive {
                route_id: "route-001".into(),
                active: false,
            })
            .applied
    );
    let inactive_result = inactive.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert_eq!(
        inactive_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::InactiveRoute)
    );

    let mut disconnected = shortfall_bus_engine();
    disconnected.set_budget_for_test(0);
    assert!(
        disconnected
            .dispatch(GameIntent::RemoveAtTile {
                point: Point { x: 6, y: 5 },
            })
            .applied
    );
    let disconnected_result = disconnected.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert_eq!(
        disconnected_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::DisconnectedLeg)
    );

    let mut missing = GameEngine::new();
    missing.set_budget_for_test(0);
    let missing_result = missing.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert_eq!(
        missing_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::RouteNotFound)
    );
}

#[test]
fn zero_fleet_and_at_target_top_ups_are_no_ops() {
    let mut zero = bus_route_engine();
    assert!(
        zero.dispatch(GameIntent::SetServiceTargetHeadway {
            line_id: "route-001".into(),
            target_headway_seconds: 60,
        })
        .applied
    );
    let zero_before = zero.snapshot();
    let zero_result = zero.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(!zero_result.applied);
    assert!(zero_result.rejection.is_none());
    assert_eq!(zero_result.snapshot.budget, zero_before.budget);
    assert!(zero_result.snapshot.transit.vehicles.is_empty());

    let mut at_target = bus_route_engine();
    assert!(
        at_target
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "route-001".into(),
                target_headway_seconds: 60,
            })
            .applied
    );
    assert!(
        at_target
            .dispatch(GameIntent::DeployInitialFleet {
                line_id: "route-001".into(),
            })
            .applied
    );
    let at_target_before = at_target.snapshot();
    assert_eq!(
        at_target_before.transit.routes[0]
            .service_metrics
            .as_ref()
            .expect("at-target metrics")
            .next_vehicle_cost,
        None
    );
    let at_target_result = at_target.dispatch(GameIntent::AddServiceVehicle {
        line_id: "route-001".into(),
    });
    assert!(!at_target_result.applied);
    assert!(at_target_result.rejection.is_none());
    assert_eq!(at_target_result.snapshot.budget, at_target_before.budget);
    assert_eq!(
        at_target_result.snapshot.transit.vehicles.len(),
        at_target_before.transit.vehicles.len()
    );
}

#[test]
fn metro_shortfall_adds_one_metro_vehicle_by_line_id() {
    let mut engine = long_metro_line_engine();
    let cycle = engine.snapshot().transit.metro_lines[0]
        .service_metrics
        .as_ref()
        .expect("fixture line has service metrics")
        .round_trip_seconds;
    assert!(cycle > 60.0, "fixture must support a metro shortfall");
    assert!(
        engine
            .dispatch(GameIntent::SetServiceTargetHeadway {
                line_id: "metro-001".into(),
                target_headway_seconds: 60,
            })
            .applied
    );
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "metro".into(),
        line_id: "metro-001".into(),
    });
    assert!(
        assigned.applied,
        "initial metro vehicle should apply: {assigned:?}"
    );
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    engine.set_budget_for_test(METRO_COST);
    let before = engine.snapshot();
    let metrics = before.transit.metro_lines[0]
        .service_metrics
        .as_ref()
        .expect("metro shortfall has metrics");
    assert!(metrics.required_fleet.expect("metro target is set") > metrics.assigned_fleet);
    assert_eq!(metrics.next_vehicle_cost, Some(METRO_COST));
    let result = engine.dispatch(GameIntent::AddServiceVehicle {
        line_id: "metro-001".into(),
    });
    assert!(result.applied, "metro top-up should apply: {result:?}");
    assert_eq!(result.snapshot.budget, before.budget - METRO_COST);
    assert_eq!(result.snapshot.transit.metro_lines[0].vehicle_ids.len(), 2);
    let vehicle = result
        .snapshot
        .transit
        .vehicles
        .last()
        .expect("metro vehicle appended");
    assert_eq!(vehicle.mode, TransitMode::Metro);
    assert_eq!(vehicle.capacity, METRO_CAPACITY);
}

#[test]
fn zero_fleet_bus_route_is_not_a_passenger_service_until_a_vehicle_is_assigned() {
    let engine = bus_route_engine();
    let state = engine.snapshot();

    // Active, connected, but no vehicles: passengers must not plan on it.
    let no_service =
        router::find_route_plan(&state, &RoadFlow::new(), &(2, 4).into(), &(12, 4).into())
            .expect("walking fallback remains available");
    assert!(
        no_service
            .legs
            .iter()
            .all(|leg| leg.mode == TransitMode::Walk),
        "zero-fleet bus route must not appear in passenger plans: {no_service:?}"
    );

    // The route stays structurally operational: one low-level `AssignVehicle`
    // makes it passenger-service eligible again.
    let mut restored = GameEngine::from_snapshot(state).expect("zero-fleet state loads");
    let assigned = restored.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "AssignVehicle seam must stay valid: {assigned:?}"
    );

    let planned = router::find_route_plan(
        &restored.snapshot(),
        &RoadFlow::new(),
        &(2, 4).into(),
        &(12, 4).into(),
    )
    .expect("assigned route is routable");
    assert!(
        planned.legs.iter().any(|leg| leg.mode == TransitMode::Bus),
        "assigned bus route must be a passenger service: {planned:?}"
    );
}

#[test]
fn engine_snapshot_publishes_metro_service_metrics() {
    let engine = metro_line_engine();
    let snapshot = engine.snapshot();
    let metrics = snapshot.transit.metro_lines[0]
        .service_metrics
        .as_ref()
        .expect("snapshot() publishes metro service metrics");

    assert!(metrics.round_trip_seconds > 0.0);
    assert_eq!(metrics.assigned_fleet, 0);
    assert_eq!(metrics.required_fleet, None);
    assert_eq!(metrics.estimated_deployment_cost, None);
    assert_eq!(metrics.next_vehicle_cost, None);
    assert_eq!(metrics.nominal_headway_seconds, None);

    let value = serde_json::to_value(&snapshot).expect("snapshot serializes");
    let line_json = &value["transit"]["metroLines"][0];
    assert!(line_json.get("serviceMetrics").is_some(), "{line_json}");
    assert_eq!(line_json["serviceMetrics"]["assignedFleet"], 0);
}

#[test]
fn engine_snapshot_publishes_bus_service_metrics() {
    let mut engine = bus_route_engine();
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture assignment should apply: {assigned:?}"
    );
    let mut state = engine.snapshot();
    state.transit.routes[0].target_headway_seconds = Some(120);
    let engine = GameEngine::from_snapshot(state).expect("targeted state loads");

    let cycle = free_flow_cycle_seconds(&engine);
    assert!(cycle > 0.0, "fixture route must have a positive cycle");

    let snapshot = engine.snapshot();
    let metrics = snapshot.transit.routes[0]
        .service_metrics
        .as_ref()
        .expect("snapshot() publishes bus service metrics");
    assert_eq!(metrics.round_trip_seconds, cycle);
    assert_eq!(metrics.assigned_fleet, 1);
    assert_eq!(
        metrics.required_fleet,
        Some((cycle / 120.0).ceil() as usize),
        "required fleet is ceil(cycle / target)"
    );
    assert_eq!(metrics.nominal_headway_seconds, Some(cycle));
    assert_eq!(metrics.next_vehicle_cost, None);

    // Hosts receive the derived metrics on the wire.
    let value = serde_json::to_value(&snapshot).expect("snapshot serializes");
    let route_json = &value["transit"]["routes"][0];
    assert!(route_json.get("serviceMetrics").is_some(), "{route_json}");
    assert_eq!(route_json["serviceMetrics"]["assignedFleet"], 1);
}

#[test]
fn snapshot_restore_rejects_bus_headway_below_floor() {
    // `MIN_HEADWAY_SECONDS` (60) is the authoritative floor enforced by
    // both `SetServiceTargetHeadway` and `DeployInitialFleet`. A persisted target
    // below it is a service state the gameplay API cannot create, so
    // `GameEngine::from_snapshot` must reject it rather than adopt it as
    // engine authority. 59 is one second below the floor.
    let engine = bus_route_engine();
    let mut state = engine.snapshot();
    state.transit.routes[0].target_headway_seconds = Some(59);
    let error = match GameEngine::from_snapshot(state) {
        Ok(_) => panic!("sub-floor headway should be rejected on restore"),
        Err(error) => error,
    };
    let SnapshotLoadError::InvalidSnapshot(diagnostic) = error else {
        panic!("expected an invalid snapshot diagnostic, got {error:?}");
    };
    let value: serde_json::Value =
        serde_json::from_str(&diagnostic).expect("diagnostic should be JSON");
    assert_eq!(value["code"], serde_json::json!("invalidNumericValue"));
    assert_eq!(
        value["context"]["field"],
        serde_json::json!("routeTargetHeadway")
    );
    assert_eq!(
        value["context"]["reason"]["kind"],
        serde_json::json!("outOfRange")
    );
    assert_eq!(value["context"]["reason"]["details"]["minimum"], 60.0);
    assert_eq!(value["context"]["reason"]["details"]["actual"], 59.0);
    assert_eq!(
        value["context"]["entity"]["kind"],
        serde_json::json!("busRoute")
    );
}

#[test]
fn snapshot_restore_accepts_bus_headway_at_floor() {
    // The floor itself (60) is valid and must load.
    let engine = bus_route_engine();
    let mut state = engine.snapshot();
    state.transit.routes[0].target_headway_seconds = Some(60);
    let restored = GameEngine::from_snapshot(state).expect("floor headway loads");
    assert_eq!(
        restored.snapshot().transit.routes[0].target_headway_seconds,
        Some(60)
    );
}

#[test]
fn snapshot_restore_rejects_metro_headway_below_floor() {
    let engine = metro_line_engine();
    let mut state = engine.snapshot();
    state.transit.metro_lines[0].target_headway_seconds = Some(59);
    let error = match GameEngine::from_snapshot(state) {
        Ok(_) => panic!("sub-floor metro headway should be rejected on restore"),
        Err(error) => error,
    };
    let SnapshotLoadError::InvalidSnapshot(diagnostic) = error else {
        panic!("expected an invalid snapshot diagnostic, got {error:?}");
    };
    let value: serde_json::Value =
        serde_json::from_str(&diagnostic).expect("diagnostic should be JSON");
    assert_eq!(value["code"], serde_json::json!("invalidNumericValue"));
    assert_eq!(
        value["context"]["field"],
        serde_json::json!("routeTargetHeadway")
    );
    assert_eq!(
        value["context"]["reason"]["kind"],
        serde_json::json!("outOfRange")
    );
    assert_eq!(value["context"]["reason"]["details"]["minimum"], 60.0);
    assert_eq!(value["context"]["reason"]["details"]["actual"], 59.0);
    assert_eq!(
        value["context"]["entity"]["kind"],
        serde_json::json!("metroLine")
    );
}

#[test]
fn snapshot_restore_accepts_metro_headway_at_floor() {
    let engine = metro_line_engine();
    let mut state = engine.snapshot();
    state.transit.metro_lines[0].target_headway_seconds = Some(60);
    let restored = GameEngine::from_snapshot(state).expect("metro floor headway loads");
    assert_eq!(
        restored.snapshot().transit.metro_lines[0].target_headway_seconds,
        Some(60)
    );
}

#[test]
fn snapshot_for_save_omits_derived_service_metrics() {
    let engine = bus_route_engine();
    let mut state = engine.snapshot();
    state.transit.routes[0].target_headway_seconds = Some(60);
    let engine = GameEngine::from_snapshot(state).expect("targeted state loads");

    let save = engine.snapshot_for_save();
    assert!(
        save.transit.routes[0].service_metrics.is_none(),
        "normalization must clear derived metrics before persistence"
    );
    let value = serde_json::to_value(&save).expect("save serializes");
    let route_json = &value["transit"]["routes"][0];
    assert!(
        route_json.get("serviceMetrics").is_none(),
        "persisted saves must omit serviceMetrics: {route_json}"
    );

    let metro_save = metro_line_engine().snapshot_for_save();
    assert!(
        metro_save.transit.metro_lines[0].service_metrics.is_none(),
        "normalization must clear metro derived metrics before persistence"
    );
    let metro_value = serde_json::to_value(&metro_save).expect("metro save serializes");
    let line_json = &metro_value["transit"]["metroLines"][0];
    assert!(
        line_json.get("serviceMetrics").is_none(),
        "persisted metro saves must omit serviceMetrics: {line_json}"
    );
}

#[test]
fn incoming_service_metrics_never_become_authority() {
    let mut engine = bus_route_engine();
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture assignment should apply: {assigned:?}"
    );
    // `engine.snapshot()` carries derived metrics; deserializing such a
    // payload must still land with `service_metrics = None` (serde skips the
    // field entirely).
    let value = serde_json::to_value(engine.snapshot()).expect("snapshot serializes");
    assert!(
        value["transit"]["routes"][0]
            .get("serviceMetrics")
            .is_some(),
        "fixture payload must carry derived metrics for this lock"
    );
    let restored: caelum_core::model::GameSnapshot =
        serde_json::from_value(value).expect("snapshot round-trips");
    assert!(
        restored.transit.routes[0].service_metrics.is_none(),
        "deserialized serviceMetrics must not become authority"
    );

    // A forged metric on a direct restore is cleared by normalization: the
    // engine never retains it internally (snapshot_for_save stays clean even
    // though snapshot() re-derives fresh values).
    let mut forged = engine.snapshot();
    forged.transit.routes[0].service_metrics = Some(caelum_core::model::ServiceMetrics {
        round_trip_seconds: 1.0,
        assigned_fleet: 99,
        required_fleet: Some(99),
        estimated_deployment_cost: Some(99),
        next_vehicle_cost: Some(99),
        nominal_headway_seconds: Some(1.0),
    });
    let restored = GameEngine::from_snapshot(forged).expect("forged state loads");
    let save = restored.snapshot_for_save();
    assert!(
        save.transit.routes[0].service_metrics.is_none(),
        "forged metrics must be cleared, not retained"
    );
    let republished = restored.snapshot().transit.routes[0]
        .service_metrics
        .clone()
        .expect("snapshot() re-derives real metrics");
    assert_eq!(republished.assigned_fleet, 1);
}
