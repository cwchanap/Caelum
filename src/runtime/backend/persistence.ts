import { SNAPSHOT_SCHEMA_VERSION } from "../../domain/types";
import type { Heading, Point } from "../../domain/types";
import type {
  PersistenceAssignmentError,
  PersistenceDerivedStateError,
  PersistenceEntityError,
  PersistenceEntityKind,
  PersistenceEntityRef,
  PersistenceHostErrorCode,
  PersistenceMapSize,
  PersistenceModeError,
  PersistenceNumericError,
  PersistenceOperation,
  PersistenceOperationError,
  PersistenceOwnershipError,
  PersistenceRoadStructureError,
  PersistenceRoadTopologyError,
  PersistenceScenarioError,
  PersistenceSnapshotField,
  PersistenceSnapshotResultOf,
  PersistenceTileError,
  PersistenceValidationError,
  PersistenceValidationResult,
} from "./persistenceContract";
import type { RustGameSnapshot } from "./types";

type PlainObject = Record<string, unknown>;

const SNAPSHOT_FIELDS = new Set<PersistenceSnapshotField>([
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
]);

const ENTITY_KINDS = new Set<PersistenceEntityKind>([
  "building",
  "sim",
  "activeTrip",
  "stop",
  "station",
  "platform",
  "busRoute",
  "metroLine",
  "vehicle",
]);

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: PlainObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["x", "y"]) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function isHeading(value: unknown): value is Heading {
  return (
    value === "north" ||
    value === "east" ||
    value === "south" ||
    value === "west"
  );
}

function isEntityKind(value: unknown): value is PersistenceEntityKind {
  return (
    typeof value === "string" &&
    ENTITY_KINDS.has(value as PersistenceEntityKind)
  );
}

function isSnapshotField(value: unknown): value is PersistenceSnapshotField {
  return (
    typeof value === "string" &&
    SNAPSHOT_FIELDS.has(value as PersistenceSnapshotField)
  );
}

function isPersistenceEntityRef(value: unknown): value is PersistenceEntityRef {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["kind", "id"]) &&
    isEntityKind(value.kind) &&
    typeof value.id === "string"
  );
}

function isPersistenceMapSize(value: unknown): value is PersistenceMapSize {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["width", "height"]) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

function isPointArray(value: unknown): value is Point[] {
  return Array.isArray(value) && value.every(isPoint);
}

function isExactDetails(
  value: unknown,
  required: readonly string[],
  checks: Record<string, (value: unknown) => boolean>,
): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, required) &&
    required.every((key) => checks[key]?.(value[key]) === true)
  );
}

function isUnitReason(value: PlainObject): boolean {
  return hasExactKeys(value, ["kind"]);
}

function isStructuredReason(
  value: PlainObject,
  keys: readonly string[],
  checks: Record<string, (value: unknown) => boolean>,
): boolean {
  return (
    hasExactKeys(value, ["kind", "details"]) &&
    isExactDetails(value.details, keys, checks)
  );
}

function isPersistenceNumericError(
  value: unknown,
): value is PersistenceNumericError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "notFinite":
    case "negative":
    case "overflow":
      return isUnitReason(value);
    case "outOfRange":
      return isStructuredReason(value, ["minimum", "maximum", "actual"], {
        minimum: isFiniteNumber,
        maximum: isFiniteNumber,
        actual: isFiniteNumber,
      });
    default:
      return false;
  }
}

function isPersistenceModeError(value: unknown): value is PersistenceModeError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "persistenceRequiresPaused":
    case "unsupportedSpeed":
    case "invalidEconomyForMode":
    case "sandboxObjectivesPresent":
    case "sandboxGrowthWavesPresent":
    case "sandboxTerminalState":
    case "campaignTerminalWithoutObjectives":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceScenarioError(
  value: unknown,
): value is PersistenceScenarioError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "duplicateGrowthWaveId":
      return isStructuredReason(value, ["waveId"], { waveId: isString });
    case "triggerTimesOutOfOrder":
      return isStructuredReason(value, ["previousWaveId", "waveId"], {
        previousWaveId: isString,
        waveId: isString,
      });
    case "appliedAfterUnapplied":
      return isStructuredReason(
        value,
        ["firstUnappliedWaveId", "laterAppliedWaveId"],
        { firstUnappliedWaveId: isString, laterAppliedWaveId: isString },
      );
    case "actionOutOfBounds":
      return isStructuredReason(value, ["waveId", "actionIndex", "point"], {
        waveId: isString,
        actionIndex: isFiniteNumber,
        point: isPoint,
      });
    case "unknownBuildingType":
    case "invalidBuildingRotation":
      return isStructuredReason(value, ["waveId", "actionIndex"], {
        waveId: isString,
        actionIndex: isFiniteNumber,
      });
    default:
      return false;
  }
}

function isPersistenceTileError(value: unknown): value is PersistenceTileError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "wrongRowMajorCoordinate":
      return isStructuredReason(value, ["expected", "actual"], {
        expected: isPoint,
        actual: isPoint,
      });
    case "countMismatch":
      return isStructuredReason(value, ["expected", "actual"], {
        expected: isFiniteNumber,
        actual: isFiniteNumber,
      });
    case "nonCanonicalId":
      return isStructuredReason(value, ["expected"], { expected: isString });
    case "connectionOutOfBounds":
      return isStructuredReason(value, ["heading"], { heading: isHeading });
    case "connectionToNonRoad":
    case "nonReciprocalConnection":
      return isStructuredReason(value, ["neighbor"], { neighbor: isPoint });
    case "unsupportedKind":
    case "unsupportedArea":
    case "nonRoadHasRoadState":
    case "duplicateRoadConnection":
    case "nonCanonicalRoadConnectionOrder":
    case "invalidOneWayAxis":
    case "invalidInfrastructureCoexistence":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceRoadStructureError(
  value: unknown,
): value is PersistenceRoadStructureError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "nonCanonicalId":
    case "emptyFootprint":
    case "duplicateFootprintPoint":
    case "overlappingFootprint":
    case "nonRoadFootprintTile":
    case "tileOwnerMismatch":
    case "danglingTileOwner":
    case "duplicatePortId":
    case "duplicatePortPointEdge":
    case "invalidBoundaryPort":
    case "nonCanonicalFootprint":
    case "nonCanonicalLaneFacts":
    case "nonCanonicalMovementFacts":
    case "automaticJunctionMismatch":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceEntityError(
  value: unknown,
): value is PersistenceEntityError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "emptyId":
    case "nonCanonicalId":
    case "invalidStaticShape":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceOwnershipError(
  value: unknown,
): value is PersistenceOwnershipError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "missingOwner":
    case "multipleOwners":
    case "ownerTypeMismatch":
    case "footprintMismatch":
    case "anchorMismatch":
    case "reciprocalLinkMissing":
    case "spatialOverlap":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceAssignmentError(
  value: unknown,
): value is PersistenceAssignmentError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "duplicateAssignment":
    case "modeMismatch":
    case "waypointMissing":
    case "platformMismatch":
    case "vehicleMissingFromLine":
    case "vehicleListedByMultipleLines":
    case "passengerNotRiding":
    case "passengerInMultipleVehicles":
    case "itineraryIndexOutOfBounds":
    case "pathStepIndexOutOfBounds":
    case "progressOutOfRange":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceDerivedStateError(
  value: unknown,
): value is PersistenceDerivedStateError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "stopAccessMismatch":
      return isStructuredReason(value, ["node"], {
        node: isPersistenceEntityRef,
      });
    case "routeLegMismatch":
    case "routePathBrokenMismatch":
    case "routeOracleNotIdempotent":
      return isStructuredReason(value, ["route"], {
        route: isPersistenceEntityRef,
      });
    case "tripStateMismatch":
    case "tripPositionMismatch":
      return isStructuredReason(value, ["trip"], {
        trip: isPersistenceEntityRef,
      });
    case "clockMismatch":
    case "tripCounterMismatch":
    case "metricsRelationshipMismatch":
    case "outcomeWindowMismatch":
    case "objectiveStateMismatch":
    case "lossReasonMismatch":
      return isUnitReason(value);
    default:
      return false;
  }
}

function isPersistenceRoadTopologyError(
  value: unknown,
): value is PersistenceRoadTopologyError {
  return (
    isPlainObject(value) &&
    value.kind === "unsafeRoundaboutPortMapping" &&
    isStructuredReason(value, ["structureId", "footprint"], {
      structureId: isString,
      footprint: isPointArray,
    })
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isPersistenceValidationError(
  value: unknown,
): value is PersistenceValidationError {
  if (
    !isPlainObject(value) ||
    typeof value.code !== "string" ||
    !isPlainObject(value.context) ||
    !hasExactKeys(value, ["code", "context"])
  )
    return false;
  const context = value.context;
  switch (value.code) {
    case "unsupportedSchema":
      return (
        hasExactKeys(context, ["expected", "actual"]) &&
        isFiniteNumber(context.expected) &&
        isFiniteNumber(context.actual)
      );
    case "invalidNumericValue":
      return (
        hasExactKeys(context, ["field", "reason"], ["entity"]) &&
        isSnapshotField(context.field) &&
        isPersistenceNumericError(context.reason) &&
        (!("entity" in context) || isPersistenceEntityRef(context.entity))
      );
    case "invalidModeSettings":
      return (
        hasExactKeys(context, ["field", "reason"]) &&
        isSnapshotField(context.field) &&
        isPersistenceModeError(context.reason)
      );
    case "invalidScenario":
      return (
        hasExactKeys(context, ["field", "reason"]) &&
        isSnapshotField(context.field) &&
        isPersistenceScenarioError(context.reason)
      );
    case "invalidMapDimensions":
      return (
        hasExactKeys(context, ["expected", "actual"]) &&
        isPersistenceMapSize(context.expected) &&
        isPersistenceMapSize(context.actual)
      );
    case "invalidTile":
      return (
        hasExactKeys(context, ["tileId", "reason"]) &&
        isString(context.tileId) &&
        isPersistenceTileError(context.reason)
      );
    case "invalidRoadStructure":
      return (
        hasExactKeys(context, ["structureId", "reason"]) &&
        isString(context.structureId) &&
        isPersistenceRoadStructureError(context.reason)
      );
    case "duplicateEntityId":
      return (
        hasExactKeys(context, ["id", "firstKind", "secondKind"]) &&
        isString(context.id) &&
        isEntityKind(context.firstKind) &&
        isEntityKind(context.secondKind)
      );
    case "invalidEntity":
      return (
        hasExactKeys(context, ["entity", "field", "reason"]) &&
        isPersistenceEntityRef(context.entity) &&
        isSnapshotField(context.field) &&
        isPersistenceEntityError(context.reason)
      );
    case "danglingReference":
      return (
        hasExactKeys(context, ["source", "field", "target"]) &&
        isPersistenceEntityRef(context.source) &&
        isSnapshotField(context.field) &&
        isPersistenceEntityRef(context.target)
      );
    case "invalidOwnership":
      return (
        hasExactKeys(context, ["owner", "owned", "reason"]) &&
        isPersistenceEntityRef(context.owner) &&
        isPersistenceEntityRef(context.owned) &&
        isPersistenceOwnershipError(context.reason)
      );
    case "invalidAssignment":
      return (
        hasExactKeys(context, ["entity", "reason"]) &&
        isPersistenceEntityRef(context.entity) &&
        isPersistenceAssignmentError(context.reason)
      );
    case "invalidDerivedState":
      return (
        hasExactKeys(context, ["field", "reason"]) &&
        isSnapshotField(context.field) &&
        isPersistenceDerivedStateError(context.reason)
      );
    case "invalidRoadTopology":
      return (
        hasExactKeys(context, ["reason"]) &&
        isPersistenceRoadTopologyError(context.reason)
      );
    default:
      return false;
  }
}

export function isPersistenceOperationError(
  value: unknown,
): value is PersistenceOperationError {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "validation":
      return (
        hasExactKeys(value, ["kind", "operation", "source", "error"]) &&
        isPersistenceOperation(value.operation) &&
        (value.source === "activeEngine" || value.source === "candidate") &&
        isPersistenceValidationError(value.error)
      );
    case "serialization":
      return (
        hasExactKeys(value, ["kind", "operation", "phase", "diagnostic"]) &&
        isPersistenceOperation(value.operation) &&
        (value.phase === "snapshotDecode" ||
          value.phase === "snapshotEncode") &&
        isString(value.diagnostic)
      );
    case "host":
      return (
        hasExactKeys(value, ["kind", "operation", "code", "diagnostic"]) &&
        isPersistenceOperation(value.operation) &&
        isPersistenceHostErrorCode(value.code) &&
        isString(value.diagnostic)
      );
    default:
      return false;
  }
}

function isPersistenceOperation(value: unknown): value is PersistenceOperation {
  return (
    value === "snapshotForSave" ||
    value === "validateSnapshot" ||
    value === "restoreSnapshot"
  );
}

function isPersistenceHostErrorCode(
  value: unknown,
): value is PersistenceHostErrorCode {
  return (
    value === "stateUnavailable" ||
    value === "invokeFailed" ||
    value === "malformedSuccess" ||
    value === "malformedError"
  );
}

function safeDiagnostic(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "[unserializable diagnostic]";
  }
}

function hostError(
  operation: PersistenceOperation,
  code: PersistenceHostErrorCode,
  value: unknown,
): PersistenceOperationError {
  return { kind: "host", operation, code, diagnostic: safeDiagnostic(value) };
}

function normalizePersistenceFailure(
  operation: PersistenceOperation,
  value: unknown,
): { ok: false; error: PersistenceOperationError } {
  if (isPersistenceOperationError(value) && value.operation === operation)
    return { ok: false, error: value };
  return {
    ok: false,
    error: hostError(
      operation,
      isPlainObject(value) ? "malformedError" : "invokeFailed",
      value,
    ),
  };
}

function isSnapshotSuccess(value: unknown): value is RustGameSnapshot {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, "schemaVersion") &&
    value.schemaVersion === SNAPSHOT_SCHEMA_VERSION
  );
}

export async function runPersistenceSnapshotOperation(
  operation: "snapshotForSave" | "restoreSnapshot",
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceSnapshotResultOf<RustGameSnapshot>> {
  try {
    const value = await invoke();
    if (isSnapshotSuccess(value)) return { ok: true, snapshot: value };
    return {
      ok: false,
      error: hostError(operation, "malformedSuccess", value),
    };
  } catch (error) {
    return normalizePersistenceFailure(operation, error);
  }
}

export async function runPersistenceValidationOperation(
  successMarker: null | undefined,
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceValidationResult> {
  try {
    const value = await invoke();
    if (value === successMarker) return { ok: true };
    return {
      ok: false,
      error: hostError("validateSnapshot", "malformedSuccess", value),
    };
  } catch (error) {
    return normalizePersistenceFailure("validateSnapshot", error);
  }
}
