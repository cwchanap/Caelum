//! Wire-format lock for the soon-to-be-enum fields.
//!
//! These tests pin the exact JSON spelling of every `String` field that will become a
//! fieldless enum (`status`, `purpose`, `mode`, `Metrics.state`, `TripOutcome.outcome`,
//! `worker_profile`). They MUST stay green when the types change to enums with
//! `#[serde(rename_all = ...)]` — that is the proof the WASM/Tauri wire format is
//! byte-identical to the current TS-parity strings. If any assertion here changes, the
//! wire contract changed.

use caelum_core::model::{
    ActiveTrip, Metrics, MetricsState, RouteLeg, RoutePlan, Sim, Tile, TransitMode, TripOutcome,
    TripOutcomeKind, TripPosition, TripPurpose, TripStatus, Vehicle, WorkerProfile,
};
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
        id: "0,0".to_string(),
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
