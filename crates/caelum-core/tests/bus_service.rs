//! Bus service metric derivation and publication (HPA-624 Task 2).
//!
//! Rust owns all service timing and fleet math. These integration tests lock
//! the public contract: `GameEngine::snapshot()` publishes derived
//! `service_metrics` for bus routes, `snapshot_for_save()` keeps persisted
//! saves free of them, incoming `serviceMetrics` never becomes authority, and
//! a structurally operational bus route with zero vehicles is not a passenger
//! service until a vehicle is assigned.
//!
//! The exact cycle-time vectors (302s/402s shuttle, 600/601 fleet rounding)
//! live as unit tests inside `src/bus_service.rs` next to the `pub(crate)`
//! functions they lock.

use caelum_core::model::{EconomyPreset, Point, TransitMode};
use caelum_core::traffic::RoadFlow;
use caelum_core::transit::BUS_COST;
use caelum_core::{router, GameEngine, GameIntent, RejectionCode, RoadPreset};

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

/// Free-flow cycle time derived the same way `bus_service` derives it: every
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
fn target_headway_is_setup_only_and_enforces_the_minimum() {
    let mut engine = bus_route_engine();
    let before = engine.snapshot();
    let revision = before.transit.routes[0].revision;

    let applied = engine.dispatch(GameIntent::SetBusTargetHeadway {
        route_id: "route-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(applied.applied, "minimum headway should apply: {applied:?}");
    assert_eq!(
        applied.snapshot.transit.routes[0].target_headway_seconds,
        Some(60)
    );
    assert_eq!(applied.snapshot.transit.routes[0].revision, revision);
    assert!(applied.snapshot.transit.routes[0].vehicle_ids.is_empty());

    let unchanged = engine.dispatch(GameIntent::SetBusTargetHeadway {
        route_id: "route-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(
        !unchanged.applied,
        "same target should be a no-op: {unchanged:?}"
    );
    assert!(unchanged.rejection.is_none());
    assert_eq!(unchanged.snapshot.transit.routes[0].revision, revision);

    let invalid = engine.dispatch(GameIntent::SetBusTargetHeadway {
        route_id: "route-001".to_string(),
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
    let locked = engine.dispatch(GameIntent::SetBusTargetHeadway {
        route_id: "route-001".to_string(),
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
    let missing = missing_target.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
    });
    assert_eq!(
        missing.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::HeadwayNotSet),
    );

    let mut inactive = bus_route_engine();
    assert!(
        inactive
            .dispatch(GameIntent::SetBusTargetHeadway {
                route_id: "route-001".to_string(),
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
    let inactive_result = inactive.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
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
            .dispatch(GameIntent::SetBusTargetHeadway {
                route_id: "route-001".to_string(),
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
    let broken_result = broken.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
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
fn deployment_buys_the_whole_fleet_atomically_and_is_one_shot() {
    let mut exact = bus_route_engine();
    assert!(
        exact
            .dispatch(GameIntent::SetBusTargetHeadway {
                route_id: "route-001".to_string(),
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
    let deployed = exact.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
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

    let second = exact.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
    });
    assert_eq!(
        second.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::FleetAlreadyAssigned),
    );

    let mut short = bus_route_engine();
    assert!(
        short
            .dispatch(GameIntent::SetBusTargetHeadway {
                route_id: "route-001".to_string(),
                target_headway_seconds: 60,
            })
            .applied
    );
    short.set_budget_for_test(cost - 1);
    let before = short.snapshot();
    let rejected = short.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
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
    let creative_result = creative.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
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
    state.transit.routes[0].target_headway_seconds = Some(14);
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
        Some((cycle / 14.0).ceil() as usize),
        "required fleet is ceil(cycle / target)"
    );
    assert_eq!(metrics.nominal_headway_seconds, Some(cycle));

    // Hosts receive the derived metrics on the wire.
    let value = serde_json::to_value(&snapshot).expect("snapshot serializes");
    let route_json = &value["transit"]["routes"][0];
    assert!(route_json.get("serviceMetrics").is_some(), "{route_json}");
    assert_eq!(route_json["serviceMetrics"]["assignedFleet"], 1);
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
    forged.transit.routes[0].service_metrics = Some(caelum_core::model::BusServiceMetrics {
        round_trip_seconds: 1.0,
        assigned_fleet: 99,
        required_fleet: Some(99),
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
