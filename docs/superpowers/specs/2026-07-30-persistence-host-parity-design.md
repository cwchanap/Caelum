# HPA-341: Equivalent WASM and Tauri Persistence Backends

**Status:** Proposed

**This pull request:** Design documentation only; it does not implement HPA-341.

**Linear:** [HPA-341](https://linear.app/cwchanap/issue/HPA-341/expose-persistence-validation-and-restoration-through-equivalent-wasm)

**Prerequisite:** [HPA-340](https://linear.app/cwchanap/issue/HPA-340/implement-rust-persistence-snapshots-and-atomic-validated-engine), implemented in PR #17

## Outcome

The frontend can request a persistence-safe snapshot, validate untrusted gameplay
state without mutating the active engine, and restore a validated engine through one
host-neutral `GameBackend` contract.

Browser WASM and Tauri expose the same operation names, persistence success shapes,
error categories, core validation payloads, and replacement semantics. Rust remains
the only authority that can accept gameplay state. TypeScript never repairs,
normalizes as gameplay authority, or directly installs an imported snapshot.

## Current State

HPA-340 established the authoritative core persistence boundary:

- `GameEngine::snapshot_for_save` clones the committed state, sets only
  `paused = true`, validates the clone, and leaves the live engine unchanged;
- `validate_snapshot` performs pure, deterministic whole-snapshot validation;
- `GameEngine::from_snapshot` validates the complete snapshot and recompiles the
  non-serialized road topology before constructing an engine;
- `GameEngine::restore_snapshot` prepares the complete candidate before mutating
  the target engine; and
- `PersistenceError` is a closed Serde-tagged contract independent of ordinary
  gameplay rejection.

The host boundary has not yet adopted those APIs as its public contract:

- `GameBackend` still exposes optional `loadSnapshot`, returning a snapshot or
  rejecting a promise;
- the WASM adapter replaces its local wrapper through the exported static
  `WasmGameEngine::from_snapshot` constructor;
- Tauri exposes `game_load_snapshot`, which returns structured core errors but raw
  string deserialization and mutex failures;
- TypeScript does not have a closed persistence error model; and
- ordinary WASM snapshot serialization differs from Tauri JSON for Rust
  `Option::None` fields that are not skipped by Serde.

HPA-340 intentionally preserved that compatibility path only until HPA-341 could
replace it with explicit save, validate, and restore operations. HPA-341 removes the
compatibility API rather than layering a second persistence API beside it.

## Approved Decisions

1. HPA-341 is one cross-host parity slice and one pull request. WASM and Tauri do
   not land independently behind an optional frontend contract.
2. The public operations are `snapshotForSave`, `validateSnapshot`, and
   `restoreSnapshot`.
3. Imported snapshot input is `unknown` at the TypeScript boundary. It does not
   become a trusted `RustGameSnapshot` until Rust deserialization succeeds.
4. Expected persistence failures resolve as typed result unions. Consumers do not
   classify rejected promises or parse human-readable messages.
5. Core validation failures preserve the exact serialized `PersistenceError`
   payload inside a host-neutral wrapper.
6. Validation failures identify whether Rust rejected an untrusted `candidate` or
   discovered corruption in the `activeEngine` while producing a save snapshot.
7. Full snapshot deserialization and response serialization failures are separate
   from semantic validation failures.
8. `validateSnapshot` is pure and returns no gameplay snapshot on success.
9. Only Rust-backed `restoreSnapshot` may replace authoritative gameplay state.
10. Core exposes one prepared-restore token containing the validated candidate
    engine and its exact accepted snapshot. Both hosts encode that snapshot before
    consuming the token and committing the candidate.
11. A response-encoding failure cannot leave either host mutated while returning
    failure.
12. A successful restore preserves every serialized gameplay field exactly. Only
    the non-serialized road topology is recompiled.
13. Persistence operations use JSON-compatible WASM serialization so browser and
    Tauri expose the same persistable shape. Existing gameplay
    `snapshot`/`dispatch`/`tick` wire serialization is not changed by this issue.
14. The raw runtime and persistence wire shapes may differ in `undefined` versus
    `null`, but the shared runtime-view normalizer must produce equal `GameState`
    values for equal logical Rust state.
15. `loadSnapshot`, `game_load_snapshot`, and the wasm-bindgen-exported
    `WasmGameEngine::from_snapshot` constructor are removed.
16. The full Rust persistence-error vocabulary is mirrored by TypeScript and
    guarded through a shared cross-language fixture catalogue.
17. Runtime state publication, transient UI reset, save envelopes, and storage
    belong to HPA-342 and later persistence issues.
18. `validateSnapshot` remains a method on the initialized host capability. A
    separate pre-initialization validator is not introduced.
19. No worker boundary is introduced without measured WASM evidence that the
    synchronous core operation exceeds the interaction budget.
20. No dynamic production serializer injection or mutable test hook is introduced.

## Goals

- Expose a safe save snapshot from both hosts without changing the live pause
  state.
- Validate untrusted snapshots without acquiring or mutating managed engine state.
- Restore snapshots atomically in WASM and Tauri.
- Return equal persistable JSON values for equal engine state.
- Produce equal runtime `GameState` values from ordinary and persistence wire
  encodings of equal logical state.
- Give frontend consumers one closed result/error contract.
- Distinguish invalid candidate data from invariant-corrupt active engine state.
- Preserve every core validation error without variant-specific host mapping.
- Distinguish unsupported schema, semantic corruption, malformed current-schema
  payloads, response-encoding failures, invocation failures, malformed successes,
  malformed errors, and unavailable managed state.
- Remove every production TypeScript path that directly constructs or replaces an
  engine from imported state.
- Keep current dispatch, tick, preview, sandbox creation, and reset behavior
  unchanged.

## Non-goals

- Save-envelope IDs, names, timestamps, checksums, app versions, or metadata.
- UTF-8, JSON text, or portable `.caelum` file parsing.
- Browser IndexedDB or Tauri filesystem storage.
- Active-city tracking, dirty tracking, autosave scheduling, checkpoints, or
  recovery generations.
- Runtime UI reset or city-library presentation.
- Schema migration, compatibility aliases, repair, or normalization of imported
  gameplay state.
- Replacing the complete persistence error contract with generated TypeScript.
- A validator that works before the selected host runtime initializes.
- Moving the WASM engine to a Web Worker without performance evidence.
- Changing ordinary gameplay backend wire values or the runtime's existing
  dispatch/tick error behavior.

## 1. Terminology and Invariants

### 1.1 Runtime snapshot

`GameBackend.snapshot()` and gameplay dispatch/tick results return the host's
ordinary gameplay wire value. Browser WASM retains the default
`serde_wasm_bindgen` behavior, under which a non-skipped Rust `Option::None` may
arrive as `undefined`; Tauri JSON emits `null` for the same field.

HPA-341 does not change those ordinary host wire methods. The runtime must not expose
their serializer differences to UI consumers; Section 12 defines the shared view
normalization requirement.

### 1.2 Persistence snapshot

A persistence snapshot is the output of `snapshotForSave`. It is:

- produced by `GameEngine::snapshot_for_save`;
- paused in the returned clone;
- validated by the same complete core pipeline used for import;
- JSON-compatible on both hosts; and
- safe to place inside the future HPA-342 `SaveEnvelope`.

The operation does not pause or otherwise mutate the live engine.

### 1.3 Imported candidate

An imported candidate is an arbitrary JavaScript value supplied to
`validateSnapshot` or `restoreSnapshot`. TypeScript treats it as `unknown`. The
host bridge performs the schema probe, complete deserialization, and core
validation.

### 1.4 Canonical snapshot

For HPA-341, “canonical” means the canonical JSON-compatible host serialization of
the exact Rust-accepted snapshot.

It does **not** mean that Rust repairs or rewrites the candidate. A valid restore
preserves the supplied `GameSnapshot` exactly; only the internal, non-serialized
`RoadTopology` is rebuilt. Fields carrying
`skip_serializing_if = "Option::is_none"` remain omitted on both hosts. Other
`Option::None` fields serialize as `null` on the persistence path.

### 1.5 Parsed JSON equality

“Deeply equal persistence JSON” means equality of parsed JavaScript/JSON values. It
does not mean byte-for-byte JSON text equality. Object-key ordering, whitespace,
and floating-point text formatting are not persistence parity requirements.

### 1.6 State authority

TypeScript may store, forward, normalize for read-only view consumption, and display
snapshots. It may not:

- cast an imported value and install it as authoritative state;
- construct a replacement WASM engine from imported state;
- assign gameplay state directly inside `createGameRuntime`;
- repair rejected fields; or
- publish a candidate before Rust restoration succeeds.

## 2. Public TypeScript Contract

The file placement is fixed before implementation:

- `src/runtime/backend/persistenceContract.ts` owns the closed persistence error
  vocabulary and host-neutral generic request/result/error types. It imports only
  stable domain value types such as `Point` and `Heading`; it does not import
  `RustGameSnapshot`.
- `src/runtime/backend/types.ts` defines the concrete
  `PersistenceSnapshotResult = PersistenceSnapshotResultOf<RustGameSnapshot>` alias
  and extends `GameBackend`.
- `src/runtime/backend/persistence.ts` owns runtime guards, safe diagnostics, and
  shared WASM/Tauri operation normalization.

This avoids a type-only cycle between `types.ts` and the persistence vocabulary
while keeping the large closed union out of the already broad backend wire file.

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
      source: PersistenceValidationSource;
      error: PersistenceValidationError;
    }
  | {
      kind: "serialization";
      phase: PersistenceSerializationPhase;
      diagnostic: string;
    }
  | {
      kind: "host";
      code: PersistenceHostErrorCode;
      operation: PersistenceOperation;
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

`loadSnapshot` is removed rather than retained as deprecated or optional. Keeping
an alias would preserve the rejected-promise contract and make it possible for new
code to bypass the explicit result model.

### 2.1 Result semantics

- `ok: true` means the Rust operation completed and its success value was encoded.
- `ok: false, kind: "validation", source: "candidate"` means an untrusted candidate
  failed the schema probe or complete core persistence contract.
- `ok: false, kind: "validation", source: "activeEngine"` is emitted only by
  `snapshotForSave`; it means the engine failed to produce a snapshot that its own
  restoration contract would accept. Consumers must treat this as an internal
  invariant failure, not as a bad imported file.
- `ok: false, kind: "serialization"` means a current-schema candidate could not be
  decoded into `GameSnapshot`, or a successful Rust snapshot could not be encoded
  for the host response.
- `host/stateUnavailable` means Tauri managed state could not be acquired. WASM has
  no mutex and never emits this code.
- `host/invokeFailed` means the invocation failed outside the known bridge contract,
  such as a JavaScript `Error`, string, primitive, or transport failure.
- `host/malformedSuccess` means an invocation resolved with an unrecognized success
  value.
- `host/malformedError` means an invocation rejected with a plain-object value that
  is neither a recognized bridge error nor a normal host `Error`.

The `diagnostic` string is opaque, host-local troubleshooting information. It may be
logged or displayed, but no code may branch on its text.

### 2.2 Why validation remains on `GameBackend`

`GameBackend` represents an initialized host capability, not merely mutable city
state. Caelum currently always constructs a default Rust engine when the host starts;
there is no supported “host initialized but no engine exists” lifecycle.

Keeping `validateSnapshot` on `GameBackend` means import and recovery code does not
repeat WASM/Tauri detection or obtain a second host object. The underlying Tauri
command remains stateless, and the WASM method does not read its receiver.

A free-standing validator would not solve initialization failure: browser validation
still requires the WASM module to initialize, and no Rust-backed persistence contract
is available when that initialization fails. If a future bootstrap design supports a
host with no active engine, that work may extract a separate validator capability;
HPA-341 does not add one speculatively.

### 2.3 Backend initialization

`createWasmBackend()` must finish WASM initialization before constructing and
returning a backend. Initialization failure remains a backend-factory rejection,
because no `GameBackend` exists yet to return a persistence result.

Focused tests prove that failed initialization:

- rejects backend creation;
- does not construct a `WasmGameEngine`; and
- does not cache a false successful initialization state.

No new application-wide initialization-error API is introduced.

## 3. Closed Core Validation Error Mirror

`PersistenceValidationError` is a closed TypeScript mirror of the Rust
`PersistenceError` wire contract. TypeScript does not recreate validation logic; it
only recognizes the exact tagged payload emitted by Rust.

### 3.1 Shared context types

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
  | {
      kind: "duplicateGrowthWaveId";
      details: { waveId: string };
    }
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
  | {
      kind: "countMismatch";
      details: { expected: number; actual: number };
    }
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
  | {
      kind: "stopAccessMismatch";
      details: { node: PersistenceEntityRef };
    }
  | {
      kind: "routeLegMismatch";
      details: { route: PersistenceEntityRef };
    }
  | {
      kind: "routePathBrokenMismatch";
      details: { route: PersistenceEntityRef };
    }
  | {
      kind: "routeOracleNotIdempotent";
      details: { route: PersistenceEntityRef };
    }
  | {
      kind: "tripStateMismatch";
      details: { trip: PersistenceEntityRef };
    }
  | {
      kind: "tripPositionMismatch";
      details: { trip: PersistenceEntityRef };
    }
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

Implement `isPersistenceValidationError(value: unknown)` as a strict structural
guard:

- the outer value and every context/details value must be a plain object;
- arrays are accepted only for documented array fields and every element is checked
  recursively;
- `Point` is exactly `{ x: number, y: number }` with no unknown keys;
- `PersistenceMapSize` is exactly `{ width: number, height: number }`;
- `PersistenceEntityRef` is exactly `{ kind: PersistenceEntityKind, id: string }`;
- `Heading` is exactly one of `north`, `east`, `south`, or `west`;
- each `code`, `field`, entity `kind`, and reason `kind` belongs to the closed
  vocabulary above;
- required keys are present with the documented primitive or structured type;
- optional `entity` on `invalidNumericValue.context` is the only optional member in
  the top-level validation contexts, and omission is distinct from `entity: null`;
- unit reason variants must not contain `details`;
- structured reason variants contain exactly the documented `details` keys;
- unknown keys are rejected at every closed object level; and
- numeric members must be finite JavaScript numbers only where the Rust wire
  contract guarantees finiteness; semantic gameplay ranges remain Rust-owned.

The guard recognizes Rust output. It is not an alternate validator for imported
snapshots.

### 3.5 Cross-language drift boundary

The error catalogue is a bidirectional tripwire, not source generation:

- Rust tests prove the catalogue matches the Rust vocabulary and exact Serde shape;
- TypeScript tests prove the same catalogue matches the TypeScript unions and strict
  guards.

A Rust test cannot inspect TypeScript source, and a TypeScript test cannot exhaustively
reflect over Rust enums. A coordinated incorrect edit could therefore defeat both
sides. Code generation would be stronger, but adding a Rust-to-TypeScript generator
for this one contract is outside HPA-341. Every future Rust vocabulary change must
update the Rust exhaustive list, fixture catalogue, TypeScript union, and guard in one
reviewed change.

## 4. Host Bridge Error Contract

WASM and Tauri use the same tagged bridge-error wire shapes.

Candidate validation failure:

```json
{
  "kind": "validation",
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

Active-engine save failure:

```json
{
  "kind": "validation",
  "source": "activeEngine",
  "error": {
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
  }
}
```

Serialization failure:

```json
{
  "kind": "serialization",
  "phase": "snapshotDecode",
  "diagnostic": "opaque host diagnostic"
}
```

Tauri managed-state failure:

```json
{
  "kind": "host",
  "code": "stateUnavailable",
  "operation": "restoreSnapshot",
  "diagnostic": "opaque host diagnostic"
}
```

The Rust host bridges directly emit:

- `validation/activeEngine` for `snapshot_for_save` `PersistenceError`;
- `validation/candidate` for schema and semantic candidate `PersistenceError`;
- `serialization/snapshotDecode` for full `GameSnapshot` deserialization failure
  after the schema probe accepts the declared version;
- `serialization/snapshotEncode` for success-value encoding failure; and
- Tauri `host/stateUnavailable` for poisoned managed state.

WASM never emits `stateUnavailable`; it has no managed-state mutex.

The TypeScript shared normalizer synthesizes:

- `host/invokeFailed` for host/runtime/transport rejection outside the known bridge
  contract;
- `host/malformedSuccess` for an unrecognized resolved value; and
- `host/malformedError` for an unrecognized plain-object rejection.

No host branch translates individual core error variants. It wraps the complete
`PersistenceError` generically.

## 5. Shared Decode Contract

Both Rust hosts use the same logical two-phase decoder.

1. Probe `schemaVersion` without requiring the remaining snapshot fields.
2. Delegate the version comparison to the existing core schema-check helper.
3. When the probe is missing, has the wrong type, or cannot deserialize, use
   `actual = 0` and return `PersistenceError::UnsupportedSchema`.
4. Only after the schema matches, deserialize the complete `GameSnapshot`.
5. A complete-deserialization failure is
   `serialization/snapshotDecode`, not a core validation error.
6. Pass the typed snapshot to complete core validation or prepared restoration.

`actual = 0` is a reserved sentinel meaning “the schema version was unreadable.” It
does not assert that the payload belongs to a real schema version zero. A literal
numeric `schemaVersion: 0` is intentionally indistinguishable and receives the same
unsupported-schema payload.

The decoder performs two Serde deserialization passes over the same already
materialized JavaScript/JSON value: one shallow schema probe and one complete model
deserialization. It does not parse JSON text twice. The shallow probe is intentional
because it preserves typed schema rejection before required fields from a newer
schema are examined.

| Candidate failure | Public category |
| --- | --- |
| Missing or unreadable `schemaVersion` | `validation/candidate/unsupportedSchema(actual: 0)` |
| Explicit old or future schema | `validation/candidate/unsupportedSchema` |
| Matching schema with wrong field type or missing required field | `serialization/snapshotDecode` |
| Typed snapshot violates semantic invariants | `validation/candidate/PersistenceError` |

The two host implementations may use host-specific deserializers, but the decision
order and public category must be identical.

## 6. Core Prepared-Restore Boundary

HPA-341 adds a narrow core token so WASM and Tauri do not separately reconstruct the
relationship between a validated engine and the exact snapshot they must encode.

```rust
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
retains the compiled topology, and creates one complete candidate engine. The token
exposes a borrowed snapshot for host encoding and consumes itself when yielding the
candidate engine.

Existing APIs delegate to the same token:

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

This keeps `GameEngine::restore_snapshot` as the tested atomic in-place core API
rather than orphaning it. Host restoration has a wider transaction boundary than
core restoration because host success also depends on host-specific response
encoding. Core cannot enforce “encode before host commit” without depending on WASM
or `serde_json`; each bridge must still encode the token's borrowed snapshot before
calling `into_engine`. Host tests enforce that ordering.

## 7. WASM Bridge

### 7.1 JSON-compatible persistence serializer

Add one focused helper in `crates/caelum-wasm` using
`serde_wasm_bindgen::Serializer::json_compatible()`.

It is used only for HPA-341 persistence operation successes and structured bridge
errors. Ordinary gameplay methods retain `serde_wasm_bindgen::to_value`. No JSON
text round-trip is introduced.

### 7.2 Operations

Expose instance methods on `WasmGameEngine`:

```rust
pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue>;
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;
pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue>;
```

#### `snapshot_for_save`

1. Call `self.inner.snapshot_for_save()`.
2. Wrap any `PersistenceError` as `validation/activeEngine`.
3. Encode the snapshot with the JSON-compatible serializer.
4. Map encoding failure to `serialization/snapshotEncode`.
5. Never assign to `self.inner`.

An `activeEngine` result indicates an internal invariant failure. HPA-342 may surface
a “current city cannot be saved” error and must not present it as an invalid import.

#### `validate_snapshot`

1. Decode the untrusted `JsValue` through the shared two-phase decoder.
2. Call `caelum_core::validate_snapshot(&snapshot)`.
3. Wrap schema or semantic errors as `validation/candidate`.
4. Return unit on success.
5. Never read or assign `self.inner`.

The method remains on the wrapper for `GameBackend` capability symmetry. Its receiver
is deliberately unused.

#### `restore_snapshot`

1. Decode the untrusted `JsValue`.
2. Call `GameEngine::prepare_restore(snapshot)`.
3. Encode `prepared.snapshot()` with the JSON-compatible serializer.
4. Only after encoding succeeds, assign
   `self.inner = prepared.into_engine()`.
5. Return the already-encoded value.

The prepared token centralizes validation, topology compilation, and accepted
snapshot identity. The wrapper owns only host-specific encode-before-commit ordering.

### 7.3 Remove direct construction

Remove the wasm-bindgen-exported `WasmGameEngine::from_snapshot` function. Core
`GameEngine::from_snapshot` remains available for core callers and tests, but
TypeScript can no longer construct a replacement engine directly from imported
state.

The adapter keeps one stable `WasmGameEngine` wrapper instance. Restore mutates its
Rust-owned inner engine only through `restore_snapshot`.

### 7.4 Initialization

Keep the current single cached initialization promise, but test successful sharing
and failed initialization. A failed promise is not reset implicitly; retry policy is
an application-bootstrap concern.

### 7.5 Serializer-failure testing

Do not add a runtime-injectable serializer, trait object, mutable global hook, or
production configuration branch.

Use one of these compile-time-safe patterns:

- a private generic `prepare_encode_commit` helper monomorphized with the real
  serializer in production and a failing closure in Rust unit tests; or
- a `#[cfg(test)]` wrapper that invokes the same production encoder-result mapping
  with a synthetic failure.

The test must prove an encode error maps to `snapshotEncode` and assignment has not
occurred. The real-artifact tests continue exercising the actual
`Serializer::json_compatible()` implementation on success.

## 8. Tauri Bridge

Replace `game_load_snapshot` with three commands:

```rust
#[tauri::command]
fn game_snapshot_for_save(
    state: State<'_, EngineState>,
) -> Result<serde_json::Value, PersistenceBridgeError>;

#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), PersistenceBridgeError>;

#[tauri::command]
fn game_restore_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, PersistenceBridgeError>;
```

### 8.1 Save lock boundary

`game_snapshot_for_save` follows this order:

1. acquire the engine mutex;
2. clone the complete `GameEngine`;
3. release the mutex;
4. call `snapshot_for_save` on the clone;
5. wrap a core failure as `validation/activeEngine`;
6. encode the snapshot to `serde_json::Value`; and
7. return the encoded value.

Validation and topology checks do not hold the managed-state mutex. Poisoned state
returns `host/stateUnavailable` before a clone is obtained.

### 8.2 Pure validation

`game_validate_snapshot`:

1. performs the two-phase decode;
2. calls `caelum_core::validate_snapshot`;
3. wraps schema or semantic errors as `validation/candidate`; and
4. returns unit.

It takes no `State`, so the command cannot acquire or mutate the live engine.

### 8.3 Restore lock boundary

`game_restore_snapshot` follows this exact order:

1. decode the untrusted `serde_json::Value`;
2. call `GameEngine::prepare_restore` outside the mutex;
3. encode `prepared.snapshot()` to `serde_json::Value` outside the mutex;
4. acquire the managed engine mutex;
5. replace `*engine` with `prepared.into_engine()`; and
6. return the already-encoded value.

Every fallible validation, topology, and response-encoding step completes before
state replacement. Mutex poisoning occurs before the swap and leaves the old engine
unchanged.

Returning `serde_json::Value` rather than `GameSnapshot` is intentional: response
serialization is an explicit pre-commit step rather than a framework-owned step
after mutation.

### 8.4 Command errors

Replace raw persistence-path `serde_json::Value` errors with a dedicated serializable
bridge error. Existing sandbox and gameplay command contracts remain unchanged.

The bridge error serializes as the same tagged object used by WASM. Unit tests assert
exact JSON for candidate validation, active-engine validation, decode, encode, and
state-unavailable variants.

### 8.5 Serializer-failure testing

As in WASM, do not carry a dynamic injection seam in production. Prefer a private
generic helper whose production monomorphization receives `serde_json::to_value`, or
a `#[cfg(test)]` wrapper around the same result-mapping path. The test must prove the
candidate is not swapped when encoding fails.

## 9. TypeScript Adapter Normalization

Create one shared helper used by `wasmBackend.ts` and `tauriBackend.ts`.

```ts
export function isPersistenceValidationError(
  value: unknown,
): value is PersistenceValidationError;

export function isPersistenceOperationError(
  value: unknown,
): value is PersistenceOperationError;

export async function runPersistenceSnapshotOperation(
  operation: "snapshotForSave" | "restoreSnapshot",
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceSnapshotResult>;

export async function runPersistenceValidationOperation(
  invoke: () => Promise<unknown> | unknown,
): Promise<PersistenceValidationResult>;
```

The helper:

- accepts synchronous WASM methods and asynchronous Tauri invocations;
- converts known bridge rejections directly into `{ ok: false, error }`;
- verifies that snapshot success is a non-array object with a numeric
  `schemaVersion` before casting it to the raw `RustGameSnapshot` wire type;
- maps invalid resolved values to `host/malformedSuccess`;
- maps unrecognized plain-object rejections to `host/malformedError`;
- maps normal `Error`, string, primitive, and transport rejections to
  `host/invokeFailed`;
- creates an opaque diagnostic through safe stringification; and
- never parses or pattern-matches diagnostic text.

The minimal success check is transport validation, not gameplay validation. Deep
snapshot correctness remains exclusively Rust-owned.

### 9.1 WASM adapter

`createWasmBackend` initializes WASM, constructs one `WasmGameEngine`, forwards all
three instance persistence methods through the shared normalizer, and no longer
reassigns the TypeScript `engine` variable during restore.

### 9.2 Tauri adapter

`createTauriBackend` invokes:

- `game_snapshot_for_save` with no arguments;
- `game_validate_snapshot` with `{ snapshot: request.snapshot }`; and
- `game_restore_snapshot` with `{ snapshot: request.snapshot }`.

It uses the same normalizer and returns the same result unions as WASM.

### 9.3 Exports

`src/runtime/backend/index.ts` exports the persistence request, concrete result,
operation, validation-error, validation-source, and guard types needed by HPA-342.
It does not export raw host-specific bridge DTOs or Rust wrapper constructors.

## 10. Operation Data Flows

### 10.1 Save

```text
frontend
  -> GameBackend.snapshotForSave()
  -> host clones or borrows current Rust engine
  -> GameEngine::snapshot_for_save()
  -> complete core validation
  -> validation/activeEngine on invariant failure
  -> JSON-compatible host encoding
  -> { ok: true, snapshot }
```

A running engine may return `snapshot.paused === true`, while a subsequent ordinary
`backend.snapshot()` still reports the live engine's original pause state.

### 10.2 Validate

```text
frontend unknown value
  -> GameBackend.validateSnapshot({ snapshot })
  -> schema probe
  -> full Rust deserialization
  -> caelum_core::validate_snapshot
  -> validation/candidate on schema or semantic failure
  -> { ok: true }
```

No engine state is read, cloned, locked, constructed, or replaced after the
candidate becomes typed, except for topology compiled and discarded inside core
validation.

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
  -> { ok: true, snapshot }
```

The returned snapshot is the exact committed candidate. HPA-342 consumes that
success result to reset local UI state and publish a normalized runtime view.

## 11. Atomicity and Publication Boundaries

### 11.1 Failed save

A save failure never mutates the live engine. This includes an
`activeEngine` validation failure and success-response encoding failure.

### 11.2 Failed validation

Validation has no mutable host-state dependency and cannot change the active engine.

### 11.3 Failed restore

A restore is failed when any of these occurs:

- schema rejection;
- full snapshot decode failure;
- semantic validation failure;
- topology compilation failure;
- success snapshot encoding failure;
- managed-state lock failure; or
- unexpected host invocation failure.

For every failure, the active engine and topology remain unchanged.

### 11.4 Successful restore

A successful restore:

- commits the complete prepared engine;
- returns the already-encoded candidate snapshot;
- makes a subsequent ordinary `snapshot()` observe the restored state; and
- makes subsequent dispatch/tick operations use the recompiled topology.

HPA-341's guarantee ends at the backend boundary. It does **not** publish into
`createGameRuntime`, clear UI state, or notify runtime subscribers. HPA-342 owns
those operations.

## 12. Cross-host Serialization and Runtime-View Parity

### 12.1 Persistence JSON parity

For equal Rust state, WASM and Tauri produce deeply equal parsed persistence JSON:

- required non-skipped `Option::None` fields serialize as `null`;
- fields carrying `skip_serializing_if = "Option::is_none"` are omitted on both
  hosts;
- maps serialize as plain objects;
- bytes serialize as JSON arrays; and
- no `Map`, `BigInt`, `undefined`, or typed-array-only value appears.

Parity tests compare parsed values, not JSON strings or bytes.

### 12.2 Raw runtime wire difference

Ordinary WASM responses continue using the default serializer. Therefore equal
logical state may have two raw JavaScript representations:

- ordinary WASM response: non-skipped `None` may be `undefined`;
- persistence response and Tauri JSON: the same value is `null`.

This is an intentional wire-level non-goal, but it must not leak into runtime view
state.

### 12.3 Required view normalization

HPA-341 extends `normalizeRustSnapshot` so every nullable domain field that differs
across the serializers is normalized recursively before UI publication. At minimum,
cover:

- `scenario.objectives`;
- `metrics.lossReason`;
- route and metro leg `currentPath`, `lastValidPath`, `estimatedSeconds`, and
  `failureReason`;
- vehicle `parkedPosition`;
- active-trip `routePlan`; and
- each route-plan leg's `serviceDirection`, `boardItineraryIndex`, and
  `alightItineraryIndex`.

Raw backend wire types must accurately allow the `undefined` forms that WASM can
produce; normalized `GameState` types retain explicit `null` where the domain model
requires it.

A regression test constructs ordinary-WASM-shaped and JSON-compatible-shaped raw
snapshots for equal logical state, runs both through `normalizeRustSnapshot`, and
asserts deeply equal `GameState`. This prevents a `null`/`undefined` flicker after
restore and again after the next dispatch or snapshot.

HPA-342 must publish `normalizeRustSnapshot(result.snapshot)`, never the raw restore
value.

## 13. Fixture Corpus

Create checked-in fixtures under `tests/fixtures/persistence/` from real schema-v4
Rust snapshots:

- `valid-paused.json` — a nontrivial valid snapshot;
- `unsupported-schema.json` — older schema plus a removed current field;
- `unpaused.json` — only `paused = false`;
- `malformed-current-schema.json` — current schema with a wrong JSON type;
- `late-derived-corruption.json` — late semantic failure for atomicity; and
- `persistence-errors.json` — representative exact payloads covering every top-level
  code, snapshot field, entity kind, nested reason kind, and structured details
  shape.

A Rust test helper generates the valid baseline. A regeneration note records the
command used when the schema intentionally changes. Fixtures do not become a second
source of sandbox content.

## 14. Test Strategy

### 14.1 Core prepared-restore tests

Add tests proving:

- `prepare_restore` returns a candidate whose borrowed snapshot equals the supplied
  valid snapshot;
- consuming the token yields an engine with the compiled topology;
- failure produces no token and cannot mutate an existing engine;
- `from_snapshot` delegates to the token; and
- `restore_snapshot` remains atomic and returns the same accepted snapshot.

### 14.2 Core wire-catalogue tests

Load `persistence-errors.json`, deserialize each validation payload into
`PersistenceError`, reserialize it, and assert exact equality. Maintain an explicit
Rust-side exhaustive vocabulary list/match so adding a Rust variant requires a
fixture update. This test does not claim to inspect TypeScript source.

### 14.3 WASM Rust tests

Assert:

- save changes only the returned pause field and does not pause the engine;
- active-engine save validation failure has the distinct source;
- pure validation succeeds without mutation;
- schema and semantic candidate failures preserve exact errors;
- malformed current-schema input maps to `snapshotDecode`;
- early and late restore failures preserve the wrapper state;
- restore success commits the prepared candidate;
- subsequent dispatch uses restored rules/topology;
- JSON-compatible success contains no `undefined`; and
- compile-time-safe serializer-failure coverage proves encode-before-assignment.

### 14.4 Tauri command tests

Using the same fixtures, assert:

- save clones under the lock and validates after releasing it;
- save invariant failure is `validation/activeEngine`;
- validation has no managed-state dependency;
- schema, semantic, and malformed categories match WASM;
- early and late failures preserve managed state;
- prepared response encoding precedes replacement;
- poisoned mutex maps to `stateUnavailable`;
- compile-time-safe serializer-failure coverage proves no swap; and
- `game_load_snapshot` is no longer registered.

### 14.5 TypeScript contract tests

Cover:

- every error-catalogue entry passes the strict guard;
- unknown codes, fields, entity kinds, headings, reason kinds, missing keys,
  unexpected keys, malformed points/entity refs/map sizes, and inappropriate
  `details` are rejected;
- candidate and active-engine validation sources are distinct;
- known bridge errors become `{ ok: false }` unchanged;
- normal host/transport rejections become `invokeFailed`;
- malformed rejected objects become `malformedError`;
- malformed resolved values become `malformedSuccess`; and
- diagnostics are never inspected to select a category.

### 14.6 Adapter and backend contract tests

Update generated-wrapper mocks, exact Tauri command forwarding, backend stubs, and
compile-time signatures for the three required methods. Remove every `loadSnapshot`
assertion.

### 14.7 Real WASM artifact tests

Exercise the built release artifact with shared fixtures and actual
`Serializer::json_compatible()`. Record validation and restoration timing using a
checked-in ignored/manual benchmark command.

The implementation review target is:

- real-WASM median no greater than `max(100 ms, 10 × same-machine native median)`
  for the HPA-340 benchmark-class fixture.

This is a review budget, not a CI assertion. If exceeded, report the evidence and
open a host-execution follow-up rather than weakening validation or silently adding a
worker inside HPA-341.

### 14.8 Runtime-view parity tests

Prove ordinary-WASM-shaped and JSON-compatible-shaped raw snapshots normalize to
deeply equal `GameState`, including nested active-trip route plans and every nullable
field listed in Section 12.3.

### 14.9 Repository bypass search

Use targeted searches rather than a naive `from_snapshot` grep. Review evidence must
show no production occurrence of:

```text
GameBackend.loadSnapshot
loadSnapshot(
game_load_snapshot
WasmGameEngine.from_snapshot
pub fn from_snapshot   # scoped only to crates/caelum-wasm/src/lib.rs
```

Core `GameEngine::from_snapshot`, `GameEngine::prepare_restore`, and core persistence
tests remain expected. Search output must distinguish those allowed core uses from
the removed wasm-bindgen export.

### 14.10 Regression suite

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

## 15. Performance and Concurrency

- Build each ordered identity/reference index once and compile topology once through
  the existing core pipeline.
- The two-phase candidate decoder performs one shallow probe plus one full model
  deserialization; do not add another full decode in an adapter.
- Construct one `PreparedEngineRestore` and retain its compiled topology.
- Keep Tauri validation and encoding outside the managed-state mutex.
- Do not add a Web Worker or asynchronous Rust job boundary without measured need.
- Keep the ignored/manual benchmark command reproducible and report same-machine
  native and real-WASM medians in the implementation PR.
- Do not add a wall-clock assertion to shared CI until the project has a controlled
  performance runner.

The WASM wrapper remains single-owner mutable state. Tauri serializes replacement
through its mutex but holds it only for clone or final swap.

## 16. File Map

### Create

- `src/runtime/backend/persistenceContract.ts` — closed static vocabulary and generic
  persistence result/error types.
- `src/runtime/backend/persistence.ts` — strict guards and shared operation
  normalization.
- `tests/runtime/persistenceContract.test.ts`.
- shared snapshot and error-catalogue fixtures under
  `tests/fixtures/persistence/`.
- a focused fixture generator or documented test helper, not a production binary.
- an ignored/manual real-WASM benchmark entrypoint or test command.

### Modify

- `crates/caelum-core/src/engine.rs` — `PreparedEngineRestore` and delegation from
  construction/in-place restoration.
- `crates/caelum-core/src/lib.rs` — deliberate prepared-token export.
- focused core persistence construction/atomicity tests.
- `crates/caelum-wasm/Cargo.toml` — direct Serde dependency.
- `crates/caelum-wasm/src/lib.rs` — decoder, JSON-compatible operations, prepared
  restore, bridge errors, and removal of exported direct construction.
- `src-tauri/src/lib.rs` — three commands, prepared restore, lock discipline,
  bridge errors, registration, and command tests.
- `src/runtime/backend/types.ts` — concrete result alias, accurate raw nullable wire
  types, and required `GameBackend` methods.
- `src/runtime/backend/wasmBackend.ts` and `tauriBackend.ts` — operation forwarding.
- `src/runtime/backend/index.ts` — public exports.
- `src/runtime/snapshotView.ts` — complete nullable-field view normalization.
- backend, adapter, real-WASM, snapshot-view, and fixture tests.
- `crates/caelum-core/tests/persistence_error_wire.rs` — shared catalogue coverage.
- `docs/architecture.md` and relevant persistence documentation.

### Delete or retire

- optional `GameBackend.loadSnapshot`;
- WASM adapter engine replacement through a static constructor;
- wasm-bindgen-exported `WasmGameEngine::from_snapshot`;
- Tauri `game_load_snapshot`; and
- tests asserting the old rejected-promise compatibility contract.

## 17. Review Gates

### Gate 1: Contract

The fixed file split, TypeScript unions, validation-source distinction, strict guards,
shared error catalogue, and failing backend signature tests are reviewable before
host implementation.

### Gate 2: Core prepared restore

The token, delegated existing APIs, and core construction/atomicity tests establish
one candidate/snapshot preparation boundary.

### Gate 3: WASM

Raw operations, JSON-compatible persistence serialization, prepared
encode-before-commit restore, initialization coverage, and removal of direct
construction are complete.

### Gate 4: Tauri

Three commands, outside-lock preparation, pre-commit encoding, state-unavailable
handling, and atomicity tests are complete.

### Gate 5: Adapter and view parity

Both adapters use the same normalizer, implement required methods, pass the same
fixture expectations, and ordinary/persistence raw values normalize to equal runtime
views.

### Gate 6: Regression and evidence

Documentation, targeted bypass search, complete checks, error-catalogue evidence, and
same-machine native/real-WASM timing are present before implementation is marked ready.

## 18. Acceptance-Criteria Mapping

### Both hosts return the same persistence snapshot shape for equal engine state

Covered by JSON-compatible persistence serialization and equality of parsed fixture
values.

### Both hosts map every core validation error to the same typed frontend contract

Covered by generic error wrapping, the Rust catalogue, strict TypeScript mirror, and
representative end-to-end failures. The catalogue tripwire's non-codegen limitation
is explicit.

### Failed restoration leaves managed host state unchanged

Covered by core prepared restoration, host response encoding before token
consumption, and early/late/encode/lock failure tests.

### Successful restoration returns the validated canonical snapshot

HPA-341 commits the prepared candidate inside the host and returns the exact encoded
committed snapshot. HPA-342 owns runtime-view publication and transient UI reset.

### No TypeScript path can directly replace gameplay state

Covered by removing `loadSnapshot`, the exported WASM static constructor, and
`game_load_snapshot`, plus targeted bypass searches.

### Existing gameplay dispatch/tick behavior remains unchanged

Covered by limiting JSON-compatible serialization to persistence operations, changing
only read-only runtime view normalization, and running the complete regression suite.

## 19. Downstream Contract for HPA-342

HPA-342 may assume:

- manual save calls `snapshotForSave` and stores only an `ok: true` snapshot;
- `validation/activeEngine` means the running city cannot safely be saved and is not
  an import-file error;
- import/recovery can call `validateSnapshot` before store write or active-city
  mutation;
- load calls `restoreSnapshot` and receives the exact committed snapshot;
- all persistence failures are typed data;
- validation and failed restore never change the active engine; and
- storage code never branches on WASM versus Tauri.

HPA-342 must:

- own `SaveEnvelope`, `SaveStore`, active-city identity, dirty tracking, and
  mutation/save/load coordination;
- call `normalizeRustSnapshot` before committing a restored value to runtime view
  state;
- clear drafts, gestures, selections, previews, and transient errors after success;
  and
- notify runtime subscribers.

It must never publish the raw persistence `RustGameSnapshot` directly.

## 20. Explicit Non-expansion

Implementation must not absorb HPA-342 storage/coordinator work merely because the
new methods have no production UI caller yet. Backend, view-normalization, and host
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
- a separate pre-initialization validator capability;
- Rust-to-TypeScript code generation;
- dynamic serializer injection;
- a flaky shared-CI timing assertion;
- a worker boundary without measured need; or
- TypeScript gameplay validation beyond strict recognition of Rust error, transport,
  and read-only runtime-view shapes.
