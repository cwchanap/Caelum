# HPA-341: Equivalent WASM and Tauri Persistence Backends

**Status:** Implemented, including final whole-branch review fixes

**This pull request:** Implements the HPA-341 contract described here.

**Linear:** [HPA-341](https://linear.app/cwchanap/issue/HPA-341/expose-persistence-validation-and-restoration-through-equivalent-wasm)

**Prerequisite:** [HPA-340](https://linear.app/cwchanap/issue/HPA-340/implement-rust-persistence-snapshots-and-atomic-validated-engine), implemented in PR #17

## Outcome

The frontend can request a persistence-safe snapshot, validate untrusted gameplay
state without mutating the active engine, and restore a validated engine through one
host-neutral `GameBackend` contract.

Browser WASM and Tauri expose the same operation names, persistence success shapes,
error categories, core validation payloads, and replacement semantics. Rust remains
the only authority that can accept gameplay state. TypeScript may transport and
normalize snapshots for read-only view consumption, but it never repairs gameplay
state or installs an imported candidate directly.

This document is the single normative HPA-341 design. Earlier amendment documents are
retired; implementers must not need precedence rules between multiple specifications.

## Current State

HPA-340 established the authoritative core persistence boundary:

- `GameEngine::snapshot_for_save` clones committed state, sets only `paused = true`,
  validates the clone, and leaves the live engine unchanged;
- `validate_snapshot` performs pure, deterministic whole-snapshot validation;
- `GameEngine::from_snapshot` validates the complete snapshot and recompiles the
  non-serialized road topology before constructing an engine;
- `GameEngine::restore_snapshot` prepares a complete candidate before mutating the
  target engine; and
- `PersistenceError` is a closed Serde-tagged contract independent of ordinary
  gameplay rejection.

The host boundary has not yet adopted those APIs as its public contract:

- `GameBackend` still exposes optional `loadSnapshot`, returning a snapshot or
  rejecting a promise;
- the WASM adapter replaces its local wrapper through the exported static
  `WasmGameEngine::from_snapshot` constructor;
- Tauri exposes `game_load_snapshot`, which returns structured core errors but raw
  string deserialization and mutex failures;
- TypeScript does not have a closed persistence error model;
- several raw Rust wire fields are typed as already-normalized domain values even
  though ordinary WASM may emit `undefined`; and
- ordinary WASM snapshot serialization differs from Tauri JSON for non-skipped
  `Option::None` fields.

HPA-340 intentionally preserved the compatibility path only until HPA-341 could
replace it with explicit save, validate, and restore operations. HPA-341 removes the
compatibility API rather than layering a second persistence API beside it.

## Approved Decisions

1. HPA-341 is one cross-host parity slice and one pull request. WASM and Tauri do
   not land independently behind an optional frontend contract.
2. The public operations are `snapshotForSave`, `validateSnapshot`, and
   `restoreSnapshot`.
3. Imported input is `unknown` at the TypeScript boundary. It does not become a
   trusted `GameSnapshot` until Rust deserialization succeeds.
4. Once a `GameBackend` exists, expected persistence failures resolve as typed result
   unions. Consumers do not classify rejected promises or parse diagnostics.
5. Every operation error carries its originating `PersistenceOperation`.
6. Core validation failures preserve the exact serialized `PersistenceError` and
   identify whether Rust rejected an untrusted `candidate` or found corruption in the
   `activeEngine` while producing a save.
7. Full snapshot deserialization and response serialization failures remain separate
   from semantic validation failures.
8. Successful validation accepts only raw WASM `undefined` or Tauri `null`.
9. `validateSnapshot` is pure and returns no snapshot on success.
10. Only Rust-backed `restoreSnapshot` may replace authoritative gameplay state.
11. Core exposes one must-use prepared-restore token containing the validated
    candidate engine and its exact accepted snapshot.
12. Both hosts encode that snapshot before consuming the token and committing the
    candidate. A response-encoding or lock failure cannot leave the host mutated while
    returning failure.
13. Tauri save captures only a typed, engine-minted committed-snapshot token while
    holding the mutex. It does not clone `GameEngine` or cached `RoadTopology`.
14. A successful restore preserves every serialized gameplay field exactly. Only the
    non-serialized road topology is recompiled.
15. Persistence operations use JSON-compatible WASM serialization. Ordinary gameplay
    `snapshot`/`dispatch`/`tick` wire serialization remains unchanged.
16. Persistence success values remain raw backend wire snapshots. Backend adapters do
    not call `normalizeRustSnapshot`.
17. Raw runtime and persistence wire shapes may differ in `undefined` versus `null`,
    but the shared runtime-view normalizer must produce equal `GameState` values for
    equal logical Rust state.
18. Snapshot success transport checks require
    `schemaVersion === SNAPSHOT_SCHEMA_VERSION`, not merely a numeric version.
19. `loadSnapshot`, `game_load_snapshot`, and the wasm-bindgen-exported
    `WasmGameEngine::from_snapshot` constructor are removed.
20. The full Rust persistence-error vocabulary is mirrored by TypeScript and guarded
    through a shared cross-language fixture catalogue.
21. The catalogue is a manual bidirectional tripwire, not code generation. Vocabulary
    changes must update Rust, fixtures, TypeScript types, guards, and tests together.
22. `validateSnapshot` remains on the initialized `GameBackend`; a separate
    pre-initialization validator is not introduced.
23. No dynamic production serializer injection or mutable test hook is introduced.
24. Runtime publication, transient UI reset, envelopes, storage, dirty tracking, and
    autosave scheduling belong to HPA-342 and later issues.
25. No worker boundary is introduced without measured WASM evidence. HPA-342 must
    nevertheless revisit main-thread save latency before enabling autosave.

## Goals

- Expose a safe save snapshot from both hosts without changing the live pause state.
- Make the provenance of save preparation type-enforced rather than prose-enforced.
- Validate untrusted snapshots without reading or mutating live engine state.
- Restore snapshots atomically in WASM and Tauri.
- Return equal persistable JSON values for equal engine state.
- Prove that JSON text round-trip preserves a save that Rust accepts again.
- Produce equal runtime `GameState` values from ordinary and persistence wire
  encodings of equal logical state.
- Give frontend consumers one closed result/error contract.
- Distinguish invalid candidate data from invariant-corrupt active engine state.
- Preserve every core validation error without host-specific variant mapping.
- Distinguish schema rejection, semantic corruption, malformed current-schema input,
  response encoding failure, invocation failure, malformed success, malformed error,
  and unavailable managed state.
- Assert that representative states reachable through public gameplay operations
  remain savable after every accepted dispatch and tick.
- Remove every production TypeScript path that directly constructs or replaces an
  engine from imported state.
- Keep gameplay dispatch, tick, preview, sandbox construction, and reset behavior
  unchanged.

## Non-goals

- Save-envelope IDs, names, timestamps, checksums, app versions, or metadata.
- UTF-8, JSON text, or portable `.caelum` file parsing outside the focused
  JSON-stringify round-trip proof.
- Browser IndexedDB or Tauri filesystem storage.
- Active-city tracking, dirty tracking, autosave scheduling, checkpoints, or recovery
  generations.
- Runtime UI reset or city-library presentation.
- Schema migration, compatibility aliases, repair, or normalization of imported
  gameplay state.
- Replacing the complete persistence error contract with generated TypeScript.
- A validator that works before the selected Rust host initializes.
- Moving the WASM engine to a Web Worker without performance evidence.
- Changing ordinary gameplay backend wire values or dispatch/tick error behavior.
- Making a shared-CI wall-clock assertion without a controlled performance runner.

## 1. Terminology and Invariants

### 1.1 Runtime snapshot

`GameBackend.snapshot()` and gameplay dispatch/tick results return the host's
ordinary gameplay wire value. Browser WASM retains default `serde_wasm_bindgen`
behavior, under which a non-skipped Rust `Option::None` may arrive as `undefined`;
Tauri JSON emits `null` for the same field.

HPA-341 does not change those ordinary host methods. The runtime must not expose their
serializer differences to UI consumers; Section 11 defines the shared view
normalization requirement.

### 1.2 Persistence snapshot

A persistence snapshot is the output of `snapshotForSave`. It is:

- derived from an engine-minted capture of committed state;
- paused in the returned value;
- validated by the same complete core pipeline used for import;
- JSON-compatible on both hosts; and
- safe to place inside the future HPA-342 `SaveEnvelope`.

The operation does not pause or otherwise mutate the live engine.

### 1.3 Imported candidate

An imported candidate is an arbitrary JavaScript value supplied to
`validateSnapshot` or `restoreSnapshot`. TypeScript treats it as `unknown`. The host
bridge performs the schema probe, complete deserialization, and core validation.

### 1.4 Canonical raw snapshot

For HPA-341, “canonical” means the canonical JSON-compatible host serialization of
the exact Rust-accepted snapshot.

It does **not** mean that Rust repairs or rewrites the candidate. A valid restore
preserves the supplied `GameSnapshot` exactly; only internal `RoadTopology` is rebuilt.
Fields carrying `skip_serializing_if = "Option::is_none"` remain omitted. Other
`Option::None` fields serialize as `null` on the persistence path.

### 1.5 Parsed JSON equality

“Deeply equal persistence JSON” means equality of parsed JavaScript/JSON values. It
does not mean byte-for-byte JSON text equality. Object-key ordering, whitespace, and
floating-point text formatting are not parity requirements.

### 1.6 State authority

TypeScript may store, forward, transport-check, normalize for read-only view
consumption, and display snapshots. It may not:

- cast an imported value and install it as authoritative state;
- construct a replacement WASM engine from imported state;
- assign gameplay state directly inside `createGameRuntime`;
- repair rejected fields; or
- publish a candidate before Rust restoration succeeds.

## 2. Public TypeScript Contract

The file placement is fixed before implementation:

- `src/runtime/backend/persistenceContract.ts` owns the closed persistence vocabulary
  and host-neutral generic request/result/error types. It imports stable domain shapes
  such as `Point` and `Heading`, but not `RustGameSnapshot`.
- `src/runtime/backend/types.ts` owns raw Rust wire mirrors, the concrete persistence
  result alias, and `GameBackend`.
- `src/runtime/backend/persistence.ts` owns strict guards, safe diagnostics, transport
  success checks, and shared WASM/Tauri operation normalization.

```ts
export interface PersistenceSnapshotRequest {
  snapshot: unknown;
}

export type PersistenceOperation =
  | "snapshotForSave"
  | "validateSnapshot"
  | "restoreSnapshot";

export type PersistenceValidationSource = "activeEngine" | "candidate";

export type PersistenceSerializationPhase =
  | "snapshotDecode"
  | "snapshotEncode";

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
```

`src/runtime/backend/types.ts` adds:

```ts
export type PersistenceSnapshotResult =
  PersistenceSnapshotResultOf<RustGameSnapshot>;

export interface GameBackend {
  snapshot(): Promise<RustGameSnapshot>;
  snapshotForSave(): Promise<PersistenceSnapshotResult>;
  validateSnapshot(
    request: PersistenceSnapshotRequest,
  ): Promise<PersistenceValidationResult>;
  restoreSnapshot(
    request: PersistenceSnapshotRequest,
  ): Promise<PersistenceSnapshotResult>;

  createSandbox(
    request: SandboxCreationRequest,
  ): Promise<SandboxCreationResult>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<SandboxResetResult>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse>;
}
```

`loadSnapshot` is removed rather than retained as deprecated or optional. Keeping an
alias would preserve the rejected-promise contract and allow new code to bypass the
explicit result model.

### 2.1 Result semantics

- `ok: true` means the Rust operation completed and its success value passed the
  operation-specific transport check.
- `validation/candidate` means an untrusted candidate failed schema probing or core
  persistence validation.
- `validation/activeEngine` is emitted only by `snapshotForSave`; it means the engine
  failed to produce a snapshot accepted by its own restore contract. Consumers treat
  it as an internal invariant failure, not a bad imported file.
- `serialization/snapshotDecode` means a current-schema candidate could not deserialize
  into `GameSnapshot`.
- `serialization/snapshotEncode` means a successful Rust snapshot could not be encoded
  for the host response.
- `host/stateUnavailable` means Tauri managed state could not be acquired. WASM never
  emits this code.
- `host/invokeFailed` means the invocation failed outside the recognized bridge
  contract, including an opaque fallback when bridge-error encoding itself fails.
- `host/malformedSuccess` means an invocation resolved with an unrecognized value.
- `host/malformedError` means an invocation rejected with a plain object that is not a
  recognized bridge error.

The `operation` property is present on all failures, so logging and HPA-342 can
attribute the failure without reconstructing call context. `diagnostic` is opaque and
must never be parsed for control flow.

### 2.2 Validation success

The raw Rust methods return unit on success:

```rust
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;

#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), EncodedPersistenceBridgeError>;
```

wasm-bindgen returns `undefined`; Tauri JSON returns `null`. The shared normalizer
accepts exactly the marker selected by its adapter:

```ts
export async function runPersistenceValidationOperation(
  successMarker: null | undefined,
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceValidationResult> {
  try {
    const value = await invoke();
    if (value === successMarker) return { ok: true };
    return {
      ok: false,
      error: malformedSuccess("validateSnapshot", value),
    };
  } catch (error: unknown) {
    return normalizePersistenceFailure("validateSnapshot", error);
  }
}
```

WASM passes `undefined`; Tauri passes `null`. The other nullish marker, resolved
booleans, numbers, strings, arrays, plain objects, and snapshot-shaped values are
`host/malformedSuccess`. Success never depends on truthiness.

### 2.3 Why validation remains on `GameBackend`

`GameBackend` represents an initialized Rust host capability, not merely mutable city
state. Caelum currently always constructs a default engine when the host starts; there
is no supported “host initialized but no engine exists” lifecycle.

Keeping validation on `GameBackend` means import and recovery code do not repeat host
detection or obtain a second capability. The Tauri command remains stateless and the
WASM method does not read its receiver. A free-standing browser validator would still
require WASM initialization and would not solve initialization failure.

### 2.4 Backend initialization

`createWasmBackend()` finishes WASM initialization before constructing and returning a
backend. Initialization failure remains a backend-factory rejection because no
`GameBackend` exists yet to return a persistence result.

Tests prove failed initialization:

- rejects backend construction;
- does not construct `WasmGameEngine`; and
- does not cache a false successful state.

## 3. Closed Core Validation Error Mirror

`PersistenceValidationError` is a closed TypeScript mirror of the Rust
`PersistenceError` wire contract. TypeScript recognizes Rust output; it does not
recreate validation logic.

### 3.1 Shared shapes

```ts
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
```

### 3.2 Nested reason unions

```ts
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
      details: {
        firstUnappliedWaveId: string;
        laterAppliedWaveId: string;
      };
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
```

### 3.3 Top-level validation union

```ts
export type PersistenceValidationError =
  | {
      code: "unsupportedSchema";
      context: { expected: number; actual: number };
    }
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
      context: {
        expected: PersistenceMapSize;
        actual: PersistenceMapSize;
      };
    }
  | {
      code: "invalidTile";
      context: { tileId: string; reason: PersistenceTileError };
    }
  | {
      code: "invalidRoadStructure";
      context: {
        structureId: string;
        reason: PersistenceRoadStructureError;
      };
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
```

### 3.4 Strict runtime guard

`isPersistenceValidationError(value)` is a strict structural guard:

- the outer value and every context/details value is a plain object;
- arrays are accepted only for documented fields and every element is checked;
- `Point` is exactly `{ x: number, y: number }`;
- `PersistenceMapSize` is exactly `{ width: number, height: number }`;
- `PersistenceEntityRef` is exactly `{ kind: PersistenceEntityKind, id: string }`;
- `Heading` is exactly `north | east | south | west`;
- each `code`, `field`, entity kind, and reason kind belongs to the closed vocabulary;
- required keys have the documented primitive or structured type;
- omitted `entity` on `invalidNumericValue.context` is distinct from `entity: null`;
- unit reason variants do not carry `details`;
- structured variants carry exactly the documented `details` keys;
- unknown keys are rejected at every closed object level; and
- numbers are finite wherever the Rust error wire guarantees finiteness, while
  gameplay ranges remain Rust-owned.

Required keys must be own properties; inherited keys never satisfy a closed shape.
Every public guard and normalization entrypoint is exception-safe for hostile unknown
values, including proxies that throw from prototype/key traps and objects with throwing
getters. Such values are rejected or converted into the typed host fallback result
rather than escaping the backend contract.

The guard recognizes Rust output. It is not an alternate validator for candidate
snapshots.

### 3.5 Vocabulary-change checklist

Every change to the persistence wire vocabulary or an embedded closed shape updates
all affected artifacts in one reviewed change:

1. the Rust enum/reason type or embedded shape (`Point`, `Heading`, `EntityRef`, or
   `MapSize`);
2. the Rust exhaustive vocabulary/shape list and exact Serde tests;
3. `tests/fixtures/persistence/persistence-errors.json`;
4. the TypeScript union and strict structural guard; and
5. the TypeScript catalogue test.

A Rust test cannot inspect TypeScript source and a TypeScript test cannot reflect over
Rust enums. The catalogue is therefore a manual tripwire rather than code generation.

## 4. Core Preparation Boundaries

### 4.1 Type-enforced save capture

A public free function that accepts arbitrary `GameSnapshot` and force-pauses it would
allow Rust callers to launder an untrusted unpaused candidate past
`PersistenceRequiresPaused`. HPA-341 therefore does **not** expose
`prepare_snapshot_for_save(GameSnapshot)`.

Instead, only `GameEngine` can mint an opaque capture of committed state:

```rust
#[must_use = "a captured committed snapshot must be prepared or deliberately discarded"]
pub struct SaveSnapshotCapture {
    snapshot: GameSnapshot,
}

impl GameEngine {
    pub fn capture_snapshot_for_save(&self) -> SaveSnapshotCapture {
        SaveSnapshotCapture {
            snapshot: self.snapshot(),
        }
    }

    pub fn snapshot_for_save(&self) -> PersistenceResult<GameSnapshot> {
        self.capture_snapshot_for_save().prepare()
    }
}

impl SaveSnapshotCapture {
    pub fn prepare(mut self) -> PersistenceResult<GameSnapshot> {
        self.snapshot.paused = true;
        validate_snapshot(&self.snapshot)?;
        Ok(self.snapshot)
    }
}
```

`SaveSnapshotCapture.snapshot` is private and there is no public constructor from
`GameSnapshot`. Tauri can carry the capture outside the mutex, but untrusted import
code cannot manufacture one. Candidate validation and restoration still require the
candidate itself to already be paused.

### 4.2 Prepared restore

```rust
#[must_use = "a prepared restore has no effect until its engine is consumed and assigned by the host"]
pub struct PreparedEngineRestore {
    engine: GameEngine,
}

impl PreparedEngineRestore {
    pub fn snapshot(&self) -> &GameSnapshot;
    pub fn into_engine(self) -> GameEngine;
}

impl GameEngine {
    pub fn prepare_restore(
        snapshot: GameSnapshot,
    ) -> PersistenceResult<PreparedEngineRestore>;
}
```

`prepare_restore` delegates to the existing private `prepare_snapshot` pipeline,
retains compiled topology, and creates one complete candidate engine. Dropping the
token is a no-op on host state.

Existing APIs delegate to the token:

```rust
pub fn from_snapshot(snapshot: GameSnapshot) -> PersistenceResult<GameEngine> {
    Ok(Self::prepare_restore(snapshot)?.into_engine())
}

pub fn restore_snapshot(
    &mut self,
    snapshot: GameSnapshot,
) -> PersistenceResult<GameSnapshot> {
    let prepared = Self::prepare_restore(snapshot)?;
    let restored = prepared.snapshot().clone();
    *self = prepared.into_engine();
    Ok(restored)
}
```

Host restoration has a wider transaction boundary than core restoration because host
success also depends on host-specific encoding. Each bridge encodes the token's
borrowed snapshot before calling `into_engine`.

## 5. Shared Decode Contract

Both Rust hosts use the same logical two-phase decoder:

1. Probe `schemaVersion` without requiring remaining fields.
2. Delegate version comparison to the core schema helper.
3. When the probe is missing, wrong-typed, or unreadable, use `actual = 0` and return
   `UnsupportedSchema`.
4. Only after the schema matches, deserialize complete `GameSnapshot`.
5. Full-deserialization failure is `serialization/snapshotDecode`.
6. Pass the typed snapshot to pure validation or prepared restoration.

`actual = 0` is a reserved unreadable-schema sentinel, not a real schema version.
A literal numeric zero is intentionally indistinguishable and receives the same error.

The decoder performs one shallow and one complete Serde pass over an already
materialized JS/JSON value. It does not parse JSON text twice.

| Candidate failure | Public category |
| --- | --- |
| Missing/unreadable `schemaVersion` | `validation/candidate/unsupportedSchema(actual: 0)` |
| Explicit old/future schema | `validation/candidate/unsupportedSchema` |
| Matching schema with wrong/missing required body field | `serialization/snapshotDecode` |
| Typed snapshot violates semantic invariants | `validation/candidate/PersistenceError` |

## 6. Host Bridge Error Contract

Both bridges emit the same tagged shapes. Every variant carries `operation`.

Candidate validation example:

```json
{
  "kind": "validation",
  "operation": "restoreSnapshot",
  "source": "candidate",
  "error": {
    "code": "invalidModeSettings",
    "context": {
      "field": "paused",
      "reason": { "kind": "persistenceRequiresPaused" }
    }
  }
}
```

Active-engine save failure uses `operation: "snapshotForSave"` and
`source: "activeEngine"`.

The bridges directly emit:

- `validation/activeEngine` for save preparation failure;
- `validation/candidate` for schema or semantic candidate failure;
- `serialization/snapshotDecode` for complete candidate deserialization failure;
- `serialization/snapshotEncode` for success-value encoding failure; and
- Tauri `host/stateUnavailable` for poisoned managed state.

The TypeScript normalizer synthesizes:

- `host/invokeFailed` for runtime/transport rejection outside the recognized bridge;
- `host/malformedSuccess` for an unrecognized resolved value; and
- `host/malformedError` for an unrecognized plain-object rejection.

If encoding a structured `PersistenceOperationError` itself fails, the host produces
an opaque fallback rejection. The adapter maps it to `host/invokeFailed`; it is never
reclassified as validation or treated as success.

## 7. WASM Bridge

### 7.1 Persistence serializer

Add one focused helper using
`serde_wasm_bindgen::Serializer::json_compatible()`. It is used only for persistence
successes and structured bridge errors. Ordinary gameplay methods retain
`serde_wasm_bindgen::to_value`.

The persistence serializer must keep `serialize_large_number_types_as_bigints(false)`.
Tests recursively reject `bigint`, `undefined`, JavaScript `Map`, and typed-array-only
values in persistence snapshots.

### 7.2 Operations

```rust
pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue>;
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;
pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue>;
```

`snapshot_for_save`:

1. call `self.inner.snapshot_for_save()`;
2. map failure to `validation/activeEngine` with operation;
3. JSON-compatibly encode the snapshot;
4. map encode failure to `snapshotEncode`; and
5. never mutate `self.inner`.

`validate_snapshot`:

1. decode the untrusted value;
2. call core `validate_snapshot`;
3. map schema/semantic errors to `validation/candidate` with operation;
4. return unit; and
5. never read or assign `self.inner`.

The unused receiver exists for `GameBackend` capability symmetry. Do not add a dummy
state read to satisfy a hypothetical future lint; use a narrowly scoped lint allowance.

`restore_snapshot`:

1. decode the untrusted value;
2. call `GameEngine::prepare_restore`;
3. JSON-compatibly encode `prepared.snapshot()`;
4. only after encoding succeeds, assign `self.inner = prepared.into_engine()`; and
5. return the already-encoded value.

### 7.3 Remove direct construction

Remove wasm-bindgen-exported `WasmGameEngine::from_snapshot`. Core
`GameEngine::from_snapshot` remains available internally and in core tests.
The TypeScript adapter keeps one stable wrapper instance and never reassigns its
`engine` variable during restore.

### 7.4 Serializer-failure testing

Do not add a runtime-injectable serializer, trait object, mutable global hook, or
production configuration branch. Use a private generic helper monomorphized with the
real serializer in production and a failing closure in Rust tests, or a `#[cfg(test)]`
wrapper around the same result-mapping path.

## 8. Tauri Bridge

Replace `game_load_snapshot` with:

```rust
#[tauri::command]
fn game_snapshot_for_save(
    state: State<'_, EngineState>,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError>;

#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), EncodedPersistenceBridgeError>;

#[tauri::command]
fn game_restore_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError>;
```

Command bodies first return the typed private `PersistenceBridgeError`. A private
generic pre-return encoder converts that error into a `serde_json::Value`; the command
error wrapper carries either that already-encoded value or an opaque string fallback
when structured error encoding fails. Tauri therefore asks the framework to serialize
only a JSON value or string, and the TypeScript adapter maps the opaque fallback to
`host/invokeFailed`. Tests inject a failing error encoder through the private generic
seam and prove that the fallback is produced while managed engine state remains
unchanged.

### 8.1 Save lock boundary

`game_snapshot_for_save` follows this exact order:

1. acquire the mutex;
2. call `engine.capture_snapshot_for_save()` and retain only the opaque capture;
3. release the mutex;
4. call `capture.prepare()` outside the lock;
5. map failure to `validation/activeEngine` with operation;
6. encode the prepared snapshot; and
7. return the encoded value.

The path does not clone `GameEngine` or `RoadTopology`. The private capture field proves
the snapshot came from committed engine state and prevents force-pausing arbitrary
untrusted input.

### 8.2 Pure validation

`game_validate_snapshot` takes no `State`, performs two-phase decode, calls core
validation, and returns unit. It cannot acquire or mutate live engine state.

### 8.3 Restore lock boundary

`game_restore_snapshot`:

1. decodes untrusted `serde_json::Value`;
2. calls `GameEngine::prepare_restore` outside the mutex;
3. encodes `prepared.snapshot()` outside the mutex;
4. acquires the mutex;
5. replaces `*engine` with `prepared.into_engine()`; and
6. returns the already-encoded value.

Every fallible validation, topology, and response-encoding step completes before
replacement. Returning `serde_json::Value` makes pre-commit response encoding explicit
instead of framework-owned after mutation.

Structured error-response encoding is also explicit before returning from the command.
It runs only after an operation has failed; every restore failure path reaches it before
candidate consumption, so even failure of that encoder cannot commit managed state.

## 9. Raw Wire Types and Adapter Normalization

### 9.1 Raw Rust snapshot graph

`RustGameSnapshot` must stop reusing normalized domain types for shapes whose ordinary
WASM representation may contain `undefined`. Add explicit raw mirrors in
`src/runtime/backend/types.ts`:

```ts
export interface RustRouteLegPath
  extends Omit<
    RouteLegPath,
    | "currentPath"
    | "lastValidPath"
    | "estimatedSeconds"
    | "failureReason"
  > {
  currentPath: TransitPath | null | undefined;
  lastValidPath: TransitPath | null | undefined;
  estimatedSeconds: number | null | undefined;
  failureReason?: LegFailureReason;
}

export interface RustRoute
  extends Omit<Route, "legs"> {
  legs: RustRouteLegPath[];
}

export interface RustMetroLine
  extends Omit<MetroLine, "legs"> {
  legs: RustRouteLegPath[];
}

export interface RustVehicle
  extends Omit<Vehicle, "parkedPosition"> {
  parkedPosition: TripPosition | null | undefined;
}

export interface RustTransitNetwork
  extends Omit<TransitNetwork, "routes" | "metroLines" | "vehicles"> {
  routes: RustRoute[];
  metroLines: RustMetroLine[];
  vehicles: RustVehicle[];
}

export interface RustRoutePlanLeg
  extends Omit<
    RouteLeg,
    "serviceDirection" | "boardItineraryIndex" | "alightItineraryIndex"
  > {
  serviceDirection: ServiceDirection | null | undefined;
  boardItineraryIndex: number | null | undefined;
  alightItineraryIndex: number | null | undefined;
}

export interface RustRoutePlan
  extends Omit<RoutePlan, "legs"> {
  legs: RustRoutePlanLeg[];
}

export interface RustActiveTrip
  extends Omit<ActiveTrip, "routePlan"> {
  routePlan: RustRoutePlan | null | undefined;
}

export interface RustMetrics {
  // Existing counters and outcome fields remain unchanged.
  lossReason: string | null | undefined;
}

export interface RustGameSnapshot {
  // Existing shell, rules, map, buildings, sims, and counters remain unchanged.
  transit: RustTransitNetwork;
  activeTrips: RustActiveTrip[];
  metrics: RustMetrics;
  scenario: RustScenarioConfig;
}
```

The implementation uses complete definitions rather than comments in the actual source.
Skipped optionals such as `lineId`, sim `shiftTemplate`, and sim `workplace` remain
optional and are not widened to required `null` values.

### 9.2 Snapshot operation success check

`runPersistenceSnapshotOperation` performs transport recognition only. Success must:

- be a plain non-array object;
- own a `schemaVersion` property; and
- satisfy `schemaVersion === SNAPSHOT_SCHEMA_VERSION`.

The same raw object is returned as `RustGameSnapshot`. No defaults are added, no nested
objects are rebuilt, and `normalizeRustSnapshot` is never called inside either adapter.
A wrong-version resolved value is `host/malformedSuccess`, preventing a later untyped
throw from `normalizeRustSnapshot`.

### 9.3 Failure normalization

Both adapters use the same helper. Known bridge rejections become `{ ok: false }`
unchanged. Normal `Error`, string, primitive, and transport rejection becomes
`invokeFailed`; unrecognized plain-object rejection becomes `malformedError`.

## 10. Operation Data Flows

### 10.1 Save

```text
frontend
  -> GameBackend.snapshotForSave()
  -> host captures committed state through engine-minted SaveSnapshotCapture
  -> capture.prepare()
  -> complete core validation
  -> validation/activeEngine on invariant failure
  -> JSON-compatible host encoding
  -> exact schema-version transport check
  -> { ok: true, snapshot }
```

A running engine may return `snapshot.paused === true`, while an ordinary subsequent
`backend.snapshot()` still reports the live pause state.

### 10.2 Validate

```text
frontend unknown value
  -> GameBackend.validateSnapshot({ snapshot })
  -> schema probe
  -> full Rust deserialization
  -> core validate_snapshot
  -> validation/candidate on failure
  -> raw undefined (WASM) or null (Tauri)
  -> { ok: true }
```

### 10.3 Restore

```text
frontend unknown value
  -> GameBackend.restoreSnapshot({ snapshot })
  -> schema probe
  -> full Rust deserialization
  -> GameEngine::prepare_restore
  -> topology compiled into PreparedEngineRestore
  -> prepared snapshot encoded
  -> prepared candidate consumed into host state
  -> exact schema-version transport check
  -> { ok: true, snapshot }
```

HPA-342 consumes the success result, normalizes it, resets transient UI state, and
publishes the runtime view.

## 11. Serialization and Runtime-View Parity

### 11.1 Persistence JSON parity

For equal Rust state, WASM and Tauri produce deeply equal parsed persistence JSON:

- non-skipped `Option::None` fields serialize as `null`;
- skipped `None` fields are omitted;
- maps serialize as plain objects;
- bytes serialize as JSON arrays; and
- no `Map`, `BigInt`, `undefined`, or typed-array-only value appears.

### 11.2 Complete schema-v4 optional inventory

Non-skipped options that create the ordinary-WASM `undefined` versus persistence/Tauri
`null` difference:

- `scenario.objectives`;
- route/metro-leg `currentPath`, `lastValidPath`, and `estimatedSeconds`;
- vehicle `parkedPosition`;
- active-trip `routePlan`;
- route-plan-leg `serviceDirection`, `boardItineraryIndex`, and
  `alightItineraryIndex`; and
- `metrics.lossReason`.

Options that skip `None` and are omitted by both hosts:

- road-port `direction`;
- tile `area`, `oneWay`, and `roadStructureId`;
- building `transitNodeId`;
- route/metro-leg `failureReason`;
- stop `roadAccess`;
- stop-road-access `preferredHeading`;
- sim `shiftTemplate` and `workplace`; and
- route-plan-leg `lineId`.

### 11.3 View normalization

`normalizeRustSnapshot` recursively converts every non-skipped field above from
`undefined | null` into the explicit nullable `GameState` representation. It also
continues converting omitted `failureReason` to explicit `null` because normalized
`RouteLegPath` requires it.

Genuinely optional fields such as `lineId`, `shiftTemplate`, `workplace`, tile/building
optionals, stop access, and road-port direction remain optional. TypeScript never
invents gameplay values.

A parity test constructs ordinary-WASM-shaped and JSON-compatible-shaped inputs for
every non-skipped field plus skipped `failureReason`, normalizes both, and asserts
deeply equal `GameState`.

### 11.4 JSON text round-trip proof

A real-WASM test must prove the reason for JSON-compatible persistence serialization:

1. obtain `snapshotForSave()` from the built artifact;
2. recursively assert there is no `undefined`, `bigint`, `Map`, or typed-array-only
   value;
3. run `JSON.stringify(snapshot)` without error;
4. parse the resulting string;
5. restore the parsed value through a fresh backend;
6. assert restoration succeeds; and
7. assert the returned parsed persistence snapshot is deeply equal to the saved value.

The fixture includes `None` for presence-required optional fields such as
`scenario.objectives` and route-plan service/index fields, proving `null` survives JSON
text while ordinary key-present `undefined` would not.

## 12. Atomicity and Reachable-State Savability

### 12.1 Failure atomicity

Save never mutates the active engine. Validation has no mutable host dependency.
Restore leaves snapshot and topology unchanged on:

- schema rejection;
- full decode failure;
- semantic validation or topology failure;
- success-snapshot encoding failure;
- structured-error encoding fallback;
- managed-state lock failure; or
- unexpected host invocation failure.

### 12.2 Successful restore

A successful restore commits the complete prepared engine, returns the already-encoded
raw snapshot, makes subsequent `snapshot()` observe restored state, and makes subsequent
dispatch/tick use recompiled topology. HPA-341 does not publish into
`createGameRuntime`; HPA-342 does.

### 12.3 Reachable states remain savable

Add a core invariant test using only public gameplay operations. It drives the
nontrivial production fixture through its construction sequence and continuation
sequence, calling `snapshot_for_save()` after **every** accepted dispatch and applied
tick, including running states.

The test must cover zoning, building placement, pause/resume, multiple ticks, speed
changes, road mutation, generated sims/trips, route invalidation, and final pause. It
fails immediately with the operation label and exact `PersistenceError` if any
reachable state is not savable.

Corruption tests remain necessary, but they do not substitute for this positive
invariant. Save being unavailable in a publicly reachable engine state is a core bug.

## 13. Fixture Corpus

Create shared fixtures under `tests/fixtures/persistence/`:

- `valid-paused.json`;
- `unsupported-schema.json`;
- `unpaused.json`;
- `malformed-current-schema.json`;
- `late-derived-corruption.json`; and
- `persistence-errors.json`.

Rust tests use this exact root constant:

```rust
const PERSISTENCE_FIXTURES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/persistence",
);
```

They join fixture names through `std::path::Path` rather than duplicating relative
paths.

`unsupported-schema.json` remains deliberately legacy-shaped: it declares schema 3
and omits at least one required schema-v4 field. This proves schema probing occurs
before full deserialization. `malformed-current-schema.json` separately proves body
decode failure for the current schema.

A Rust generator/test helper creates the valid baseline. Fixtures do not become a
second source of sandbox content.

## 14. Test Strategy

### 14.1 Core preparation and savability

Test:

- `SaveSnapshotCapture` can be minted only by `GameEngine` public APIs;
- capture preparation changes only `paused`;
- engine `snapshot_for_save` delegates consistently;
- corrupted active state returns the exact error;
- reachable production states save after every accepted dispatch/applied tick;
- `PreparedEngineRestore` is `must_use` and dropping it is a no-op;
- token snapshot equals input and `into_engine` retains compiled topology;
- `from_snapshot` and `restore_snapshot` delegate and retain atomicity.

### 14.2 Wire catalogue

Rust loads `persistence-errors.json`, deserializes every validation payload, and
reserializes it exactly. Explicit exhaustive lists cover 14 top-level codes, 83
`SnapshotField` values, 9 entity kinds, every nested reason kind, and the embedded
`Point`, `Heading`, `EntityRef`, and `MapSize` shapes.

TypeScript accepts every catalogue entry and rejects unknown codes, fields, kinds,
headings, keys, missing details, inappropriate details, malformed points/entity
references/map sizes, and `entity: null`.

### 14.3 WASM wrapper and real artifact

Test:

- save changes only returned pause and does not pause the engine;
- active-engine failure is distinct;
- validation success is raw `undefined`;
- validation does not read the receiver;
- schema, semantic, malformed, early, and late failures preserve state;
- restore success commits prepared candidate and subsequent dispatch uses restored
  rules/topology;
- serializer failure is compile-time-injected and proves encode-before-assignment;
- structured-error encoding fallback maps to an opaque host failure;
- persistence success is raw and never view-normalized;
- JSON-compatible output contains no unsupported JavaScript value;
- JSON stringify/parse/restore round-trip is equal; and
- exact schema-version success check rejects a wrong-version resolved object.

### 14.4 Tauri commands

Using the same fixtures, test:

- save captures only `SaveSnapshotCapture` under the lock;
- no complete engine/topology clone occurs;
- preparation/validation and encoding happen after lock release;
- validation success serializes as `null` and has no managed-state dependency;
- early, late, encode, error-encode, and lock failures preserve state;
- restore encoding precedes final swap;
- poisoned mutex maps to `stateUnavailable`; and
- `game_load_snapshot` is no longer registered.

### 14.5 TypeScript contract and raw wire tests

Test:

- validation accepts only `undefined` and `null`;
- every other resolved value is `malformedSuccess`;
- every error variant preserves `operation`;
- known bridge errors remain unchanged;
- transport/runtime failures become `invokeFailed`;
- malformed rejected objects become `malformedError`;
- snapshot success requires exact current `schemaVersion`;
- adapters return raw snapshots and never call `normalizeRustSnapshot`;
- raw Rust mirror types permit ordinary-WASM `undefined` where required; and
- complete optional-field inventory normalizes to equal `GameState`.

### 14.6 Compatibility-path removal

Delete the stale adapter comments claiming `loadSnapshot` keeps
`stop_access::normalize_snapshot_stops` covered. That normalization is used by the live
network-mutation commit path, not strict `from_snapshot`/prepared restore. Do not retain
`loadSnapshot` for a phantom migration responsibility.

Targeted searches prove no production occurrence of:

```text
GameBackend.loadSnapshot
loadSnapshot(
game_load_snapshot
WasmGameEngine.from_snapshot
pub fn from_snapshot   # scoped only to crates/caelum-wasm/src/lib.rs
```

Core `GameEngine::from_snapshot`, `prepare_restore`, and persistence tests remain
expected.

### 14.7 Regression suite

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

## 15. Benchmark Methodology and Autosave Handoff

Update the existing ignored native persistence benchmark rather than leaving two
conflicting methodologies. For both validation and prepared restore, native and real
WASM use the same method:

1. record one cold invocation separately;
2. run exactly two unmeasured warm-ups;
3. run 25 measured iterations;
4. report median and p95; and
5. compare same-machine medians against:

```text
real-WASM median <= max(100 ms, 10 × same-machine native median)
```

The current native benchmark's five warm-ups, 25 samples, and median-only output are
updated to this contract. The review budget is evidence, not a shared-CI assertion.

The 100 ms ceiling is not a frame budget and must not be inherited as an autosave UX
promise. HPA-342 must use measured real-WASM p95, serialize save operations with gameplay
mutations, avoid invoking save work inside animation-frame-critical code, and revisit a
worker or other host-execution boundary if autosave produces observable main-thread
jank. That follow-up must not weaken core validation.

## 16. File Map

### Create

- `src/runtime/backend/persistenceContract.ts` — closed vocabulary and generic result
  types.
- `src/runtime/backend/persistence.ts` — guards and shared normalization.
- `tests/runtime/persistenceContract.test.ts`.
- shared persistence fixtures under `tests/fixtures/persistence/`.
- a fixture generator or test helper, not a production binary.
- a real-WASM ignored/manual benchmark entrypoint or test command.

### Modify

- `crates/caelum-core/src/engine.rs` — `SaveSnapshotCapture`,
  `PreparedEngineRestore`, and delegated APIs.
- `crates/caelum-core/src/lib.rs` — deliberate exports for both opaque tokens.
- core persistence snapshot, atomicity, determinism, reachable-savability, wire, and
  benchmark tests.
- `crates/caelum-wasm/Cargo.toml` — direct Serde dependency.
- `crates/caelum-wasm/src/lib.rs` — decoder, JSON-compatible operations, bridge errors,
  token consumption, and removal of exported direct construction.
- `src-tauri/src/lib.rs` — three commands, snapshot-only capture, outside-lock work,
  bridge errors, registration, and tests.
- `src/runtime/backend/types.ts` — concrete result alias, raw Rust snapshot graph, and
  required `GameBackend` methods.
- `src/runtime/backend/wasmBackend.ts` and `tauriBackend.ts` — raw operation forwarding
  and removal of stale migration comments.
- `src/runtime/backend/index.ts` — public exports.
- `src/runtime/snapshotView.ts` — complete model-derived view normalization.
- backend, adapter, real-WASM, snapshot-view, fixture, and contract tests.
- `crates/caelum-core/tests/persistence_error_wire.rs` — shared catalogue coverage.
- `docs/architecture.md` and relevant persistence documentation.

### Delete or retire

- optional `GameBackend.loadSnapshot`;
- WASM adapter replacement through a static constructor;
- wasm-bindgen-exported `WasmGameEngine::from_snapshot`;
- Tauri `game_load_snapshot`;
- stale load-path normalization comments; and
- tests asserting the rejected-promise compatibility contract.

## 17. Review Gates

### Gate 1: Contract and raw wire

The fixed file split, operation-bearing error unions, exact validation success,
strict guards, raw Rust mirrors, shared catalogue, fixture path, and failing backend
signature tests are reviewable before host implementation.

### Gate 2: Core preparation and savability

The engine-minted save capture, prepared restore token, delegated APIs, atomicity,
reachable-savability invariant, and updated native benchmark are complete.

### Gate 3: WASM

Raw operations, JSON-compatible persistence serialization, JSON round-trip,
encode-before-commit, initialization coverage, exact schema transport check, and
removal of direct construction are complete.

### Gate 4: Tauri

Three commands, snapshot-only capture, outside-lock work, pre-commit encoding,
state-unavailable handling, and atomicity tests are complete.

### Gate 5: Adapter and view parity

Both adapters use the same normalizer, preserve raw values, implement required methods,
pass shared fixture expectations, and ordinary/persistence raw values normalize to
equal runtime views.

### Gate 6: Regression and evidence

Documentation, targeted bypass search, complete checks, catalogue evidence, JSON
round-trip evidence, and same-machine native/real-WASM cold/median/p95 measurements are
present before implementation is marked ready.

## 18. Acceptance-Criteria Mapping

### Both hosts return the same persistence snapshot shape for equal engine state

Covered by JSON-compatible persistence serialization, parsed fixture equality, exact
current-schema transport checks, and JSON text round-trip restoration.

### Both hosts map every core validation error to the same typed frontend contract

Covered by generic wrapping, the Rust catalogue, strict TypeScript mirror, embedded
shape checklist, operation attribution, and representative host failures.

### Failed restoration leaves managed host state unchanged

Covered by prepared restoration, host encoding before token consumption, and
early/late/encode/error-encode/lock failure tests.

### Successful restoration returns the validated canonical snapshot

HPA-341 commits the prepared candidate inside the host and returns the exact encoded raw
snapshot. HPA-342 normalizes and publishes it.

### No TypeScript path can directly replace gameplay state

Covered by removing `loadSnapshot`, exported WASM construction, and
`game_load_snapshot`, plus targeted searches.

### Existing gameplay dispatch/tick behavior remains unchanged

Covered by limiting JSON-compatible serialization to persistence operations, changing
only read-only raw typing/view normalization, and running the complete regression suite.

## 19. Downstream Contract for HPA-342

HPA-342 may assume:

- manual save calls `snapshotForSave` and stores only an `ok: true` raw snapshot;
- `validation/activeEngine` means the current city cannot safely be saved and is not an
  import-file error;
- import/recovery can call `validateSnapshot` before storage or active-city mutation;
- load calls `restoreSnapshot` and receives the exact committed raw snapshot;
- every operation failure after backend initialization is typed and includes operation;
- a successful raw snapshot always has the current schema version;
- validation and failed restore never change active engine state; and
- storage code never branches on WASM versus Tauri.

HPA-342 must:

- own `SaveEnvelope`, `SaveStore`, active-city identity, dirty tracking, and mutation/
  save/load coordination;
- call `normalizeRustSnapshot(result.snapshot)` before runtime publication;
- clear drafts, gestures, selections, previews, and transient errors after success;
- notify runtime subscribers;
- use measured p95 rather than the 100 ms review ceiling as its autosave UX input; and
- revisit browser host execution if synchronous WASM save work causes UI jank.

It must never publish the raw persistence snapshot directly.

## 20. Explicit Non-expansion

Implementation must not absorb HPA-342 storage/coordinator work merely because the new
methods initially have no production UI caller. Backend, view-normalization, and host
tests are sufficient to land HPA-341 safely.

Do not add:

- a temporary save envelope;
- browser or desktop storage;
- a manual save button;
- a city-library model;
- import/export dialogs;
- runtime dirty tracking;
- autosave scheduling;
- migration or repair;
- a separate pre-initialization validator;
- Rust-to-TypeScript code generation;
- a publicly constructible save-preparation helper for arbitrary snapshots;
- dynamic serializer injection;
- a flaky shared-CI timing assertion;
- an unmeasured worker expansion; or
- TypeScript gameplay validation beyond strict recognition of Rust error, transport,
  raw wire, and read-only runtime-view shapes.
