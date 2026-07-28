use caelum_core::{
    DerivedStateError, EntityKind, EntityRef, PersistenceError, SnapshotField, TileError,
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
