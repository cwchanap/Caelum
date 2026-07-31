use std::fs;
use std::path::Path;

use caelum_core::model::{Heading, Point};
use caelum_core::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, MapSize, ModeError,
    NumericError, OwnershipError, PersistenceError, RoadStructureError, RoadTopologyError,
    ScenarioError, SnapshotField, TileError,
};
use serde::Deserialize;
use serde_json::{json, Value};

const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistenceErrorCatalogue {
    top_level_codes: Vec<String>,
    snapshot_fields: Vec<String>,
    entity_kinds: Vec<String>,
    headings: Vec<String>,
    reason_kinds: ReasonKinds,
    embedded_shapes: EmbeddedShapes,
    errors: Vec<Value>,
    reasons: ReasonSamples,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasonKinds {
    numeric: Vec<String>,
    mode: Vec<String>,
    scenario: Vec<String>,
    tile: Vec<String>,
    road_structure: Vec<String>,
    entity: Vec<String>,
    ownership: Vec<String>,
    assignment: Vec<String>,
    derived_state: Vec<String>,
    road_topology: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedShapes {
    point: Point,
    heading: Heading,
    entity_ref: EntityRef,
    map_size: MapSize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasonSamples {
    numeric: Vec<Value>,
    mode: Vec<Value>,
    scenario: Vec<Value>,
    tile: Vec<Value>,
    road_structure: Vec<Value>,
    entity: Vec<Value>,
    ownership: Vec<Value>,
    assignment: Vec<Value>,
    derived_state: Vec<Value>,
    road_topology: Vec<Value>,
}

fn persistence_error_catalogue() -> PersistenceErrorCatalogue {
    let path = Path::new(PERSISTENCE_FIXTURES_DIR).join("persistence-errors.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn serialized_names<T>(values: &[String]) -> Vec<String>
where
    T: for<'de> Deserialize<'de> + serde::Serialize,
{
    values
        .iter()
        .map(|value| serde_json::from_value::<T>(Value::String(value.clone())).unwrap())
        .map(|value| {
            serde_json::to_value(value)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn assert_round_trips<T>(values: &[Value])
where
    T: for<'de> Deserialize<'de> + serde::Serialize,
{
    for value in values {
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *value);
    }
}

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

#[test]
fn persistence_error_catalogue_round_trips_the_closed_cross_language_vocabulary() {
    let catalogue = persistence_error_catalogue();

    assert_eq!(
        catalogue.top_level_codes,
        strings(&[
            "unsupportedSchema",
            "invalidNumericValue",
            "invalidModeSettings",
            "invalidScenario",
            "invalidMapDimensions",
            "invalidTile",
            "invalidRoadStructure",
            "duplicateEntityId",
            "invalidEntity",
            "danglingReference",
            "invalidOwnership",
            "invalidAssignment",
            "invalidDerivedState",
            "invalidRoadTopology",
        ])
    );
    assert_eq!(
        serialized_names::<SnapshotField>(&catalogue.snapshot_fields),
        strings(&[
            "time",
            "day",
            "clockMinutes",
            "speed",
            "paused",
            "budget",
            "gameMode",
            "economyPreset",
            "sandboxTemplateId",
            "startingCapital",
            "demandMultiplier",
            "scenarioObjectives",
            "scenarioGrowthWaves",
            "objectiveThresholds",
            "growthWaveId",
            "growthWaveTriggerTime",
            "growthWaveActions",
            "mapWidth",
            "mapHeight",
            "tileCount",
            "tileCoordinates",
            "tileId",
            "tileKind",
            "tileArea",
            "tileRoadConnections",
            "tileOneWay",
            "tileRoadStructureId",
            "entityId",
            "buildingOrigin",
            "buildingRotation",
            "buildingOccupiedTiles",
            "buildingTransitNodeId",
            "nodeKind",
            "nodeStatus",
            "nodeAnchor",
            "nodeRoadAccess",
            "platformLabel",
            "platformCapacity",
            "platformCount",
            "platformOrder",
            "platformRouteIds",
            "routePattern",
            "routeWaypointIds",
            "routeLegs",
            "routeEstimatedSeconds",
            "routePathBroken",
            "routeRevision",
            "routeVehicleIds",
            "vehicleMode",
            "vehicleLineId",
            "vehicleCapacity",
            "vehiclePassengerIds",
            "vehicleItineraryIndex",
            "vehiclePathStepIndex",
            "vehicleStepProgress",
            "vehicleParkedPosition",
            "simHome",
            "simPosition",
            "simWorkerProfile",
            "simShiftTemplate",
            "simWorkplace",
            "simCommuteDay",
            "simDailyFlags",
            "tripServiceDay",
            "tripPurpose",
            "tripStatus",
            "tripOrigin",
            "tripDestination",
            "tripPosition",
            "tripDeadline",
            "tripPatience",
            "tripRoutePlan",
            "tripEstimatedSeconds",
            "tripCurrentLegIndex",
            "tripSequenceDay",
            "nextTripSequence",
            "metricsCounters",
            "metricsWaits",
            "metricsTripOutcomes",
            "outcomeWaitSeconds",
            "outcomeTimestamp",
            "metricsState",
            "metricsLossReason",
        ])
    );
    assert_eq!(
        serialized_names::<EntityKind>(&catalogue.entity_kinds),
        strings(&[
            "building",
            "sim",
            "activeTrip",
            "stop",
            "station",
            "platform",
            "busRoute",
            "metroLine",
            "vehicle"
        ])
    );
    assert_eq!(
        serialized_names::<Heading>(&catalogue.headings),
        strings(&["north", "east", "south", "west"])
    );

    assert_eq!(
        catalogue.reason_kinds.numeric,
        strings(&["notFinite", "negative", "outOfRange", "overflow"])
    );
    assert_eq!(
        catalogue.reason_kinds.mode,
        strings(&[
            "persistenceRequiresPaused",
            "unsupportedSpeed",
            "invalidEconomyForMode",
            "sandboxObjectivesPresent",
            "sandboxGrowthWavesPresent",
            "sandboxTerminalState",
            "campaignTerminalWithoutObjectives"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.scenario,
        strings(&[
            "duplicateGrowthWaveId",
            "triggerTimesOutOfOrder",
            "appliedAfterUnapplied",
            "actionOutOfBounds",
            "unknownBuildingType",
            "invalidBuildingRotation"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.tile,
        strings(&[
            "wrongRowMajorCoordinate",
            "countMismatch",
            "nonCanonicalId",
            "unsupportedKind",
            "unsupportedArea",
            "nonRoadHasRoadState",
            "duplicateRoadConnection",
            "nonCanonicalRoadConnectionOrder",
            "connectionOutOfBounds",
            "connectionToNonRoad",
            "nonReciprocalConnection",
            "invalidOneWayAxis",
            "invalidInfrastructureCoexistence"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.road_structure,
        strings(&[
            "nonCanonicalId",
            "emptyFootprint",
            "duplicateFootprintPoint",
            "overlappingFootprint",
            "nonRoadFootprintTile",
            "tileOwnerMismatch",
            "danglingTileOwner",
            "duplicatePortId",
            "duplicatePortPointEdge",
            "invalidBoundaryPort",
            "nonCanonicalFootprint",
            "nonCanonicalLaneFacts",
            "nonCanonicalMovementFacts",
            "automaticJunctionMismatch"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.entity,
        strings(&["emptyId", "nonCanonicalId", "invalidStaticShape"])
    );
    assert_eq!(
        catalogue.reason_kinds.ownership,
        strings(&[
            "missingOwner",
            "multipleOwners",
            "ownerTypeMismatch",
            "footprintMismatch",
            "anchorMismatch",
            "reciprocalLinkMissing",
            "spatialOverlap"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.assignment,
        strings(&[
            "duplicateAssignment",
            "modeMismatch",
            "waypointMissing",
            "platformMismatch",
            "vehicleMissingFromLine",
            "vehicleListedByMultipleLines",
            "passengerNotRiding",
            "passengerInMultipleVehicles",
            "itineraryIndexOutOfBounds",
            "pathStepIndexOutOfBounds",
            "progressOutOfRange"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.derived_state,
        strings(&[
            "clockMismatch",
            "stopAccessMismatch",
            "routeLegMismatch",
            "routePathBrokenMismatch",
            "routeOracleNotIdempotent",
            "tripStateMismatch",
            "tripPositionMismatch",
            "tripCounterMismatch",
            "metricsRelationshipMismatch",
            "outcomeWindowMismatch",
            "objectiveStateMismatch",
            "lossReasonMismatch"
        ])
    );
    assert_eq!(
        catalogue.reason_kinds.road_topology,
        strings(&["unsafeRoundaboutPortMapping"])
    );

    assert_eq!(catalogue.embedded_shapes.point, Point { x: 1, y: 2 });
    assert_eq!(catalogue.embedded_shapes.heading, Heading::East);
    assert_eq!(
        catalogue.embedded_shapes.entity_ref,
        EntityRef {
            kind: EntityKind::BusRoute,
            id: "route-001".to_string()
        }
    );
    assert_eq!(
        catalogue.embedded_shapes.map_size,
        MapSize {
            width: 28,
            height: 18
        }
    );

    assert_round_trips::<PersistenceError>(&catalogue.errors);
    assert_round_trips::<NumericError>(&catalogue.reasons.numeric);
    assert_round_trips::<ModeError>(&catalogue.reasons.mode);
    assert_round_trips::<ScenarioError>(&catalogue.reasons.scenario);
    assert_round_trips::<TileError>(&catalogue.reasons.tile);
    assert_round_trips::<RoadStructureError>(&catalogue.reasons.road_structure);
    assert_round_trips::<EntityError>(&catalogue.reasons.entity);
    assert_round_trips::<OwnershipError>(&catalogue.reasons.ownership);
    assert_round_trips::<AssignmentError>(&catalogue.reasons.assignment);
    assert_round_trips::<DerivedStateError>(&catalogue.reasons.derived_state);
    assert_round_trips::<RoadTopologyError>(&catalogue.reasons.road_topology);
}
