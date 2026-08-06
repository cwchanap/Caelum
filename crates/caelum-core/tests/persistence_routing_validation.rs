//! Coverage for the road topology compile error path, `route_lifecycle`'s
//! `derive_route_states`, and `router`'s `route_plan_estimated_seconds`. These
//! modules feed into persistence validation indirectly, so the tests exercise
//! them through `validate_snapshot` or the `RoadTopologyCompileError` ->
//! `PersistenceError` conversion.

mod common;

use caelum_core::model::{Point, TripStatus};
use caelum_core::{validate_snapshot, PersistenceError, RoadTopologyError};
use common::persistence_fixtures::{fixture_with_bus_route, trip_fixture, walking_plan};

// ===========================================================================
// road_topology.rs / roundabouts.rs — compile error path
// ===========================================================================

#[test]
fn unsafe_roundabout_port_mapping_surfaces_as_persistence_error() {
    // The RoadTopologyCompileError -> PersistenceError conversion is the
    // path that persistence validation uses when RoadTopology::compile fails.
    // Verify the mapping directly since constructing a map that triggers the
    // compile error without first failing structure validation is not possible
    // through the public API.
    let compile_error =
        caelum_core::road_topology::RoadTopologyCompileError::UnsafeRoundaboutPortMapping {
            structure_id: "rb-test".to_string(),
            footprint: vec![Point { x: 0, y: 0 }],
        };
    let persistence_error: PersistenceError = compile_error.into();
    assert_eq!(
        persistence_error,
        PersistenceError::InvalidRoadTopology {
            reason: RoadTopologyError::UnsafeRoundaboutPortMapping {
                structure_id: "rb-test".to_string(),
                footprint: vec![Point { x: 0, y: 0 }],
            },
        }
    );
}

// ===========================================================================
// route_lifecycle.rs — derive_route_states on a real fixture
// ===========================================================================

#[test]
fn derive_route_states_matches_stored_legs_on_a_valid_fixture() {
    let snapshot = fixture_with_bus_route();
    // derive_route_states is crate-private; exercise it indirectly through
    // validate_snapshot, which calls it internally and must succeed.
    validate_snapshot(&snapshot).unwrap();
    // The fixture has exactly one bus route with derived legs.
    assert_eq!(snapshot.transit.routes.len(), 1);
    assert!(!snapshot.transit.routes[0].legs.is_empty());
}

// ===========================================================================
// router.rs — route_plan_estimated_seconds
// ===========================================================================

#[test]
fn route_plan_estimated_seconds_is_exercised_through_trip_validation() {
    // route_plan_estimated_seconds is called by trip validation; a walking
    // trip with a correct plan must pass, and one with a wrong estimate must
    // fail. This is already covered by persistence_corruption, but we add a
    // positive case here.
    let mut snapshot = trip_fixture();
    let home = Point { x: 2, y: 3 };
    let destination = Point { x: 4, y: 3 };
    snapshot.active_trips[0].status = TripStatus::Walking;
    snapshot.active_trips[0].route_plan = Some(walking_plan(home, destination));
    validate_snapshot(&snapshot).unwrap();
}
