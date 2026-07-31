import type { Heading, Point } from "../../domain/types";

export interface PersistenceSnapshotRequest {
  snapshot: unknown;
}

export type PersistenceOperation =
  | "snapshotForSave"
  | "validateSnapshot"
  | "restoreSnapshot";

export type PersistenceValidationSource = "activeEngine" | "candidate";

export type PersistenceSerializationPhase = "snapshotDecode" | "snapshotEncode";

export type PersistenceHostErrorCode =
  | "stateUnavailable"
  | "invokeFailed"
  | "malformedSuccess"
  | "malformedError";

export type PersistenceOperationError =
  | {
      kind: "validation";
      operation: PersistenceOperation;
      source: PersistenceValidationSource;
      error: PersistenceValidationError;
    }
  | {
      kind: "serialization";
      operation: PersistenceOperation;
      phase: PersistenceSerializationPhase;
      diagnostic: string;
    }
  | {
      kind: "host";
      operation: PersistenceOperation;
      code: PersistenceHostErrorCode;
      diagnostic: string;
    };

export type PersistenceSnapshotResultOf<TSnapshot> =
  | { ok: true; snapshot: TSnapshot }
  | { ok: false; error: PersistenceOperationError };

export type PersistenceValidationResult =
  | { ok: true }
  | { ok: false; error: PersistenceOperationError };

export type PersistenceEntityKind =
  | "building"
  | "sim"
  | "activeTrip"
  | "stop"
  | "station"
  | "platform"
  | "busRoute"
  | "metroLine"
  | "vehicle";

export interface PersistenceEntityRef {
  kind: PersistenceEntityKind;
  id: string;
}

export interface PersistenceMapSize {
  width: number;
  height: number;
}

export type PersistenceSnapshotField =
  | "time"
  | "day"
  | "clockMinutes"
  | "speed"
  | "paused"
  | "budget"
  | "gameMode"
  | "economyPreset"
  | "sandboxTemplateId"
  | "startingCapital"
  | "demandMultiplier"
  | "scenarioObjectives"
  | "scenarioGrowthWaves"
  | "objectiveThresholds"
  | "growthWaveId"
  | "growthWaveTriggerTime"
  | "growthWaveActions"
  | "mapWidth"
  | "mapHeight"
  | "tileCount"
  | "tileCoordinates"
  | "tileId"
  | "tileKind"
  | "tileArea"
  | "tileRoadConnections"
  | "tileOneWay"
  | "tileRoadStructureId"
  | "entityId"
  | "buildingOrigin"
  | "buildingRotation"
  | "buildingOccupiedTiles"
  | "buildingTransitNodeId"
  | "nodeKind"
  | "nodeStatus"
  | "nodeAnchor"
  | "nodeRoadAccess"
  | "platformLabel"
  | "platformCapacity"
  | "platformCount"
  | "platformOrder"
  | "platformRouteIds"
  | "routePattern"
  | "routeWaypointIds"
  | "routeLegs"
  | "routeEstimatedSeconds"
  | "routePathBroken"
  | "routeRevision"
  | "routeVehicleIds"
  | "vehicleMode"
  | "vehicleLineId"
  | "vehicleCapacity"
  | "vehiclePassengerIds"
  | "vehicleItineraryIndex"
  | "vehiclePathStepIndex"
  | "vehicleStepProgress"
  | "vehicleParkedPosition"
  | "simHome"
  | "simPosition"
  | "simWorkerProfile"
  | "simShiftTemplate"
  | "simWorkplace"
  | "simCommuteDay"
  | "simDailyFlags"
  | "tripServiceDay"
  | "tripPurpose"
  | "tripStatus"
  | "tripOrigin"
  | "tripDestination"
  | "tripPosition"
  | "tripDeadline"
  | "tripPatience"
  | "tripRoutePlan"
  | "tripEstimatedSeconds"
  | "tripCurrentLegIndex"
  | "tripSequenceDay"
  | "nextTripSequence"
  | "metricsCounters"
  | "metricsWaits"
  | "metricsTripOutcomes"
  | "outcomeWaitSeconds"
  | "outcomeTimestamp"
  | "metricsState"
  | "metricsLossReason";

export type PersistenceNumericError =
  | { kind: "notFinite" }
  | { kind: "negative" }
  | {
      kind: "outOfRange";
      details: { minimum: number; maximum: number; actual: number };
    }
  | { kind: "overflow" };

export type PersistenceModeError =
  | { kind: "persistenceRequiresPaused" }
  | { kind: "unsupportedSpeed" }
  | { kind: "invalidEconomyForMode" }
  | { kind: "sandboxObjectivesPresent" }
  | { kind: "sandboxGrowthWavesPresent" }
  | { kind: "sandboxTerminalState" }
  | { kind: "campaignTerminalWithoutObjectives" };

export type PersistenceScenarioError =
  | { kind: "duplicateGrowthWaveId"; details: { waveId: string } }
  | {
      kind: "triggerTimesOutOfOrder";
      details: { previousWaveId: string; waveId: string };
    }
  | {
      kind: "appliedAfterUnapplied";
      details: { firstUnappliedWaveId: string; laterAppliedWaveId: string };
    }
  | {
      kind: "actionOutOfBounds";
      details: { waveId: string; actionIndex: number; point: Point };
    }
  | {
      kind: "unknownBuildingType";
      details: { waveId: string; actionIndex: number };
    }
  | {
      kind: "invalidBuildingRotation";
      details: { waveId: string; actionIndex: number };
    };

export type PersistenceTileError =
  | {
      kind: "wrongRowMajorCoordinate";
      details: { expected: Point; actual: Point };
    }
  | { kind: "countMismatch"; details: { expected: number; actual: number } }
  | { kind: "nonCanonicalId"; details: { expected: string } }
  | { kind: "unsupportedKind" }
  | { kind: "unsupportedArea" }
  | { kind: "nonRoadHasRoadState" }
  | { kind: "duplicateRoadConnection" }
  | { kind: "nonCanonicalRoadConnectionOrder" }
  | { kind: "connectionOutOfBounds"; details: { heading: Heading } }
  | { kind: "connectionToNonRoad"; details: { neighbor: Point } }
  | { kind: "nonReciprocalConnection"; details: { neighbor: Point } }
  | { kind: "invalidOneWayAxis" }
  | { kind: "invalidInfrastructureCoexistence" };

export type PersistenceRoadStructureError =
  | { kind: "nonCanonicalId" }
  | { kind: "emptyFootprint" }
  | { kind: "duplicateFootprintPoint" }
  | { kind: "overlappingFootprint" }
  | { kind: "nonRoadFootprintTile" }
  | { kind: "tileOwnerMismatch" }
  | { kind: "danglingTileOwner" }
  | { kind: "duplicatePortId" }
  | { kind: "duplicatePortPointEdge" }
  | { kind: "invalidBoundaryPort" }
  | { kind: "nonCanonicalFootprint" }
  | { kind: "nonCanonicalLaneFacts" }
  | { kind: "nonCanonicalMovementFacts" }
  | { kind: "automaticJunctionMismatch" };

export type PersistenceEntityError =
  | { kind: "emptyId" }
  | { kind: "nonCanonicalId" }
  | { kind: "invalidStaticShape" };

export type PersistenceOwnershipError =
  | { kind: "missingOwner" }
  | { kind: "multipleOwners" }
  | { kind: "ownerTypeMismatch" }
  | { kind: "footprintMismatch" }
  | { kind: "anchorMismatch" }
  | { kind: "reciprocalLinkMissing" }
  | { kind: "spatialOverlap" };

export type PersistenceAssignmentError =
  | { kind: "duplicateAssignment" }
  | { kind: "modeMismatch" }
  | { kind: "waypointMissing" }
  | { kind: "platformMismatch" }
  | { kind: "vehicleMissingFromLine" }
  | { kind: "vehicleListedByMultipleLines" }
  | { kind: "passengerNotRiding" }
  | { kind: "passengerInMultipleVehicles" }
  | { kind: "itineraryIndexOutOfBounds" }
  | { kind: "pathStepIndexOutOfBounds" }
  | { kind: "progressOutOfRange" };

export type PersistenceDerivedStateError =
  | { kind: "clockMismatch" }
  | { kind: "stopAccessMismatch"; details: { node: PersistenceEntityRef } }
  | { kind: "routeLegMismatch"; details: { route: PersistenceEntityRef } }
  | {
      kind: "routePathBrokenMismatch";
      details: { route: PersistenceEntityRef };
    }
  | {
      kind: "routeOracleNotIdempotent";
      details: { route: PersistenceEntityRef };
    }
  | { kind: "tripStateMismatch"; details: { trip: PersistenceEntityRef } }
  | { kind: "tripPositionMismatch"; details: { trip: PersistenceEntityRef } }
  | { kind: "tripCounterMismatch" }
  | { kind: "metricsRelationshipMismatch" }
  | { kind: "outcomeWindowMismatch" }
  | { kind: "objectiveStateMismatch" }
  | { kind: "lossReasonMismatch" };

export type PersistenceRoadTopologyError = {
  kind: "unsafeRoundaboutPortMapping";
  details: { structureId: string; footprint: Point[] };
};

export type PersistenceValidationError =
  | { code: "unsupportedSchema"; context: { expected: number; actual: number } }
  | {
      code: "invalidNumericValue";
      context: {
        entity?: PersistenceEntityRef;
        field: PersistenceSnapshotField;
        reason: PersistenceNumericError;
      };
    }
  | {
      code: "invalidModeSettings";
      context: {
        field: PersistenceSnapshotField;
        reason: PersistenceModeError;
      };
    }
  | {
      code: "invalidScenario";
      context: {
        field: PersistenceSnapshotField;
        reason: PersistenceScenarioError;
      };
    }
  | {
      code: "invalidMapDimensions";
      context: { expected: PersistenceMapSize; actual: PersistenceMapSize };
    }
  | {
      code: "invalidTile";
      context: { tileId: string; reason: PersistenceTileError };
    }
  | {
      code: "invalidRoadStructure";
      context: { structureId: string; reason: PersistenceRoadStructureError };
    }
  | {
      code: "duplicateEntityId";
      context: {
        id: string;
        firstKind: PersistenceEntityKind;
        secondKind: PersistenceEntityKind;
      };
    }
  | {
      code: "invalidEntity";
      context: {
        entity: PersistenceEntityRef;
        field: PersistenceSnapshotField;
        reason: PersistenceEntityError;
      };
    }
  | {
      code: "danglingReference";
      context: {
        source: PersistenceEntityRef;
        field: PersistenceSnapshotField;
        target: PersistenceEntityRef;
      };
    }
  | {
      code: "invalidOwnership";
      context: {
        owner: PersistenceEntityRef;
        owned: PersistenceEntityRef;
        reason: PersistenceOwnershipError;
      };
    }
  | {
      code: "invalidAssignment";
      context: {
        entity: PersistenceEntityRef;
        reason: PersistenceAssignmentError;
      };
    }
  | {
      code: "invalidDerivedState";
      context: {
        field: PersistenceSnapshotField;
        reason: PersistenceDerivedStateError;
      };
    }
  | {
      code: "invalidRoadTopology";
      context: { reason: PersistenceRoadTopologyError };
    };
