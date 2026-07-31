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

export const PERSISTENCE_VALIDATION_CODES = [
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
] as const satisfies readonly PersistenceValidationError["code"][];

export const PERSISTENCE_SNAPSHOT_FIELDS = [
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
] as const satisfies readonly PersistenceSnapshotField[];

export const PERSISTENCE_ENTITY_KINDS = [
  "building",
  "sim",
  "activeTrip",
  "stop",
  "station",
  "platform",
  "busRoute",
  "metroLine",
  "vehicle",
] as const satisfies readonly PersistenceEntityKind[];

export const PERSISTENCE_HEADINGS = [
  "north",
  "east",
  "south",
  "west",
] as const satisfies readonly Heading[];

export const PERSISTENCE_REASON_KINDS = {
  numeric: ["notFinite", "negative", "outOfRange", "overflow"],
  mode: [
    "persistenceRequiresPaused",
    "unsupportedSpeed",
    "invalidEconomyForMode",
    "sandboxObjectivesPresent",
    "sandboxGrowthWavesPresent",
    "sandboxTerminalState",
    "campaignTerminalWithoutObjectives",
  ],
  scenario: [
    "duplicateGrowthWaveId",
    "triggerTimesOutOfOrder",
    "appliedAfterUnapplied",
    "actionOutOfBounds",
    "unknownBuildingType",
    "invalidBuildingRotation",
  ],
  tile: [
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
    "invalidInfrastructureCoexistence",
  ],
  roadStructure: [
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
    "automaticJunctionMismatch",
  ],
  entity: ["emptyId", "nonCanonicalId", "invalidStaticShape"],
  ownership: [
    "missingOwner",
    "multipleOwners",
    "ownerTypeMismatch",
    "footprintMismatch",
    "anchorMismatch",
    "reciprocalLinkMissing",
    "spatialOverlap",
  ],
  assignment: [
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
    "progressOutOfRange",
  ],
  derivedState: [
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
    "lossReasonMismatch",
  ],
  roadTopology: ["unsafeRoundaboutPortMapping"],
} as const satisfies {
  numeric: readonly PersistenceNumericError["kind"][];
  mode: readonly PersistenceModeError["kind"][];
  scenario: readonly PersistenceScenarioError["kind"][];
  tile: readonly PersistenceTileError["kind"][];
  roadStructure: readonly PersistenceRoadStructureError["kind"][];
  entity: readonly PersistenceEntityError["kind"][];
  ownership: readonly PersistenceOwnershipError["kind"][];
  assignment: readonly PersistenceAssignmentError["kind"][];
  derivedState: readonly PersistenceDerivedStateError["kind"][];
  roadTopology: readonly PersistenceRoadTopologyError["kind"][];
};

const VALIDATION_CODES = new Set<PersistenceValidationError["code"]>(
  PERSISTENCE_VALIDATION_CODES,
);
const SNAPSHOT_FIELDS = new Set<PersistenceSnapshotField>(
  PERSISTENCE_SNAPSHOT_FIELDS,
);
const ENTITY_KINDS = new Set<PersistenceEntityKind>(PERSISTENCE_ENTITY_KINDS);
const HEADINGS = new Set<Heading>(PERSISTENCE_HEADINGS);
const REASON_KINDS = {
  numeric: new Set<string>(PERSISTENCE_REASON_KINDS.numeric),
  mode: new Set<string>(PERSISTENCE_REASON_KINDS.mode),
  scenario: new Set<string>(PERSISTENCE_REASON_KINDS.scenario),
  tile: new Set<string>(PERSISTENCE_REASON_KINDS.tile),
  roadStructure: new Set<string>(PERSISTENCE_REASON_KINDS.roadStructure),
  entity: new Set<string>(PERSISTENCE_REASON_KINDS.entity),
  ownership: new Set<string>(PERSISTENCE_REASON_KINDS.ownership),
  assignment: new Set<string>(PERSISTENCE_REASON_KINDS.assignment),
  derivedState: new Set<string>(PERSISTENCE_REASON_KINDS.derivedState),
  roadTopology: new Set<string>(PERSISTENCE_REASON_KINDS.roadTopology),
};

function isPlainObject(value: unknown): value is PlainObject {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: PlainObject,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  try {
    const allowed = new Set([...required, ...optional]);
    return (
      required.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key),
      ) &&
      Reflect.ownKeys(value).every(
        (key) => typeof key === "string" && allowed.has(key),
      )
    );
  } catch {
    return false;
  }
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
  return typeof value === "string" && HEADINGS.has(value as Heading);
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
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.numeric.has(value.kind)
  )
    return false;
  const kind = value.kind as PersistenceNumericError["kind"];
  switch (kind) {
    case "outOfRange":
      return isStructuredReason(value, ["minimum", "maximum", "actual"], {
        minimum: isFiniteNumber,
        maximum: isFiniteNumber,
        actual: isFiniteNumber,
      });
    case "notFinite":
    case "negative":
    case "overflow":
      return isUnitReason(value);
  }
}

function isPersistenceModeError(value: unknown): value is PersistenceModeError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.mode.has(value.kind)
  )
    return false;
  return isUnitReason(value);
}

function isPersistenceScenarioError(
  value: unknown,
): value is PersistenceScenarioError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.scenario.has(value.kind)
  )
    return false;
  const kind = value.kind as PersistenceScenarioError["kind"];
  switch (kind) {
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
  }
}

function isPersistenceTileError(value: unknown): value is PersistenceTileError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.tile.has(value.kind)
  )
    return false;
  const kind = value.kind as PersistenceTileError["kind"];
  switch (kind) {
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
  }
}

function isPersistenceRoadStructureError(
  value: unknown,
): value is PersistenceRoadStructureError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.roadStructure.has(value.kind)
  )
    return false;
  return isUnitReason(value);
}

function isPersistenceEntityError(
  value: unknown,
): value is PersistenceEntityError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.entity.has(value.kind)
  )
    return false;
  return isUnitReason(value);
}

function isPersistenceOwnershipError(
  value: unknown,
): value is PersistenceOwnershipError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.ownership.has(value.kind)
  )
    return false;
  return isUnitReason(value);
}

function isPersistenceAssignmentError(
  value: unknown,
): value is PersistenceAssignmentError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.assignment.has(value.kind)
  )
    return false;
  return isUnitReason(value);
}

function isPersistenceDerivedStateError(
  value: unknown,
): value is PersistenceDerivedStateError {
  if (
    !isPlainObject(value) ||
    typeof value.kind !== "string" ||
    !REASON_KINDS.derivedState.has(value.kind)
  )
    return false;
  const kind = value.kind as PersistenceDerivedStateError["kind"];
  switch (kind) {
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
  }
}

function isPersistenceRoadTopologyError(
  value: unknown,
): value is PersistenceRoadTopologyError {
  return (
    isPlainObject(value) &&
    typeof value.kind === "string" &&
    REASON_KINDS.roadTopology.has(value.kind) &&
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

function isPersistenceValidationErrorUnchecked(
  value: unknown,
): value is PersistenceValidationError {
  if (
    !isPlainObject(value) ||
    typeof value.code !== "string" ||
    !VALIDATION_CODES.has(value.code as PersistenceValidationError["code"]) ||
    !isPlainObject(value.context) ||
    !hasExactKeys(value, ["code", "context"])
  )
    return false;
  const context = value.context;
  const code = value.code as PersistenceValidationError["code"];
  switch (code) {
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
        (!Object.hasOwn(context, "entity") ||
          isPersistenceEntityRef(context.entity))
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
  }
}

export function isPersistenceValidationError(
  value: unknown,
): value is PersistenceValidationError {
  try {
    return isPersistenceValidationErrorUnchecked(value);
  } catch {
    return false;
  }
}

function isPersistenceOperationErrorUnchecked(
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

export function isPersistenceOperationError(
  value: unknown,
): value is PersistenceOperationError {
  try {
    return isPersistenceOperationErrorUnchecked(value);
  } catch {
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
  return hostErrorWithDiagnostic(operation, code, safeDiagnostic(value));
}

function hostErrorWithDiagnostic(
  operation: PersistenceOperation,
  code: PersistenceHostErrorCode,
  diagnostic: string,
): PersistenceOperationError {
  return { kind: "host", operation, code, diagnostic };
}

type PersistenceFailureSnapshot =
  | {
      kind: "recognized";
      error: PersistenceOperationError;
      diagnostic: string;
    }
  | { kind: "unrecognized"; plain: boolean; diagnostic: string }
  | { kind: "unreadable"; diagnostic: string };

function snapshotPersistenceFailure(
  value: unknown,
): PersistenceFailureSnapshot {
  try {
    if (isPersistenceOperationErrorUnchecked(value)) {
      const error = { ...value } as PersistenceOperationError;
      return { kind: "recognized", error, diagnostic: safeDiagnostic(error) };
    }
    return {
      kind: "unrecognized",
      plain: isPlainObject(value),
      diagnostic: safeDiagnostic(value),
    };
  } catch {
    return {
      kind: "unreadable",
      diagnostic: "[unreadable persistence failure]",
    };
  }
}

function normalizePersistenceFailure(
  operation: PersistenceOperation,
  value: unknown,
): { ok: false; error: PersistenceOperationError } {
  const snapshot = snapshotPersistenceFailure(value);
  if (
    snapshot.kind === "recognized" &&
    snapshot.error.operation === operation
  ) {
    return { ok: false, error: snapshot.error };
  }
  if (snapshot.kind === "unreadable") {
    return {
      ok: false,
      error: hostErrorWithDiagnostic(
        operation,
        "invokeFailed",
        snapshot.diagnostic,
      ),
    };
  }
  return {
    ok: false,
    error: hostErrorWithDiagnostic(
      operation,
      snapshot.kind === "recognized" || snapshot.plain
        ? "malformedError"
        : "invokeFailed",
      snapshot.diagnostic,
    ),
  };
}

function isSnapshotSuccess(value: unknown): value is RustGameSnapshot {
  try {
    return (
      isPlainObject(value) &&
      Object.hasOwn(value, "schemaVersion") &&
      value.schemaVersion === SNAPSHOT_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
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
