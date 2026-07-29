use caelum_core::{
    DerivedStateError, EntityKind, EntityRef, PersistenceError, RoadStructureError, SnapshotField,
    TileError,
};
use serde_json::json;

#[test]
fn persistence_errors_use_the_exact_closed_camel_case_shape() {
    let unsupported = PersistenceError::UnsupportedSchema {
        expected: 4,
        actual: 3,
    };
    assert_eq!(
        serde_json::to_value(unsupported).unwrap(),
        json!({
            "code": "unsupportedSchema",
            "context": { "expected": 4, "actual": 3 }
        })
    );

    let derived = PersistenceError::InvalidDerivedState {
        field: SnapshotField::RouteLegs,
        reason: DerivedStateError::RouteLegMismatch {
            route: EntityRef {
                kind: EntityKind::BusRoute,
                id: "route-001".to_string(),
            },
        },
    };
    assert_eq!(
        serde_json::to_value(derived).unwrap(),
        json!({
            "code": "invalidDerivedState",
            "context": {
                "field": "routeLegs",
                "reason": {
                    "kind": "routeLegMismatch",
                    "details": {
                        "route": { "kind": "busRoute", "id": "route-001" }
                    }
                }
            }
        })
    );
}

#[test]
fn tile_count_mismatch_serializes_with_expected_and_actual_counts() {
    let error = PersistenceError::InvalidTile {
        tile_id: String::new(),
        reason: TileError::CountMismatch {
            expected: 504,
            actual: 503,
        },
    };
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({
            "code": "invalidTile",
            "context": {
                "tileId": "",
                "reason": {
                    "kind": "countMismatch",
                    "details": { "expected": 504, "actual": 503 }
                }
            }
        })
    );
}

#[test]
fn duplicate_port_point_edge_serializes_with_the_exact_closed_shape() {
    let error = PersistenceError::InvalidRoadStructure {
        structure_id: "roundabout:compact2x2:4,2".to_string(),
        reason: RoadStructureError::DuplicatePortPointEdge,
    };
    let expected = json!({
        "code": "invalidRoadStructure",
        "context": {
            "structureId": "roundabout:compact2x2:4,2",
            "reason": { "kind": "duplicatePortPointEdge" }
        }
    });
    assert_eq!(serde_json::to_value(&error).unwrap(), expected);
    let round_trip: PersistenceError = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(round_trip, error);
    // The closed v1 wire policy rejects additive keys inside the context and
    // inside the unit-variant `reason` payload.
    let extra_context = json!({
        "code": "invalidRoadStructure",
        "context": {
            "structureId": "roundabout:compact2x2:4,2",
            "reason": { "kind": "duplicatePortPointEdge" },
            "extra": true
        }
    });
    assert!(
        serde_json::from_value::<PersistenceError>(extra_context).is_err(),
        "invalidRoadStructure context must reject unknown keys"
    );
    let extra_reason = json!({
        "code": "invalidRoadStructure",
        "context": {
            "structureId": "roundabout:compact2x2:4,2",
            "reason": { "kind": "duplicatePortPointEdge", "details": {} }
        }
    });
    assert!(
        serde_json::from_value::<PersistenceError>(extra_reason).is_err(),
        "unit-variant road structure reasons must not carry a details payload"
    );
    let unknown_kind = json!({
        "code": "invalidRoadStructure",
        "context": {
            "structureId": "roundabout:compact2x2:4,2",
            "reason": { "kind": "unknown" }
        }
    });
    assert!(
        serde_json::from_value::<PersistenceError>(unknown_kind).is_err(),
        "unknown road structure reason kind must be rejected"
    );
}

#[test]
fn persistence_errors_reject_unknown_codes_fields_kinds_and_keys() {
    for value in [
        json!({ "code": "unknown", "context": {} }),
        json!({
            "code": "unsupportedSchema",
            "context": { "expected": 4, "actual": 3, "extra": true }
        }),
        json!({
            "code": "invalidDerivedState",
            "context": {
                "field": "unknown",
                "reason": { "kind": "tripCounterMismatch" }
            }
        }),
        json!({
            "code": "invalidDerivedState",
            "context": {
                "field": "routeLegs",
                "reason": { "kind": "unknown" }
            }
        }),
        json!({
            "code": "invalidDerivedState",
            "context": {
                "field": "routeLegs",
                "reason": {
                    "kind": "routeLegMismatch",
                    "details": {
                        "route": {
                            "kind": "unknown",
                            "id": "route-001"
                        }
                    }
                }
            }
        }),
    ] {
        assert!(
            serde_json::from_value::<PersistenceError>(value).is_err(),
            "unknown persistence vocabulary must be rejected"
        );
    }
}
