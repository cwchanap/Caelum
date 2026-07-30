# HPA-341: Equivalent WASM and Tauri Persistence Backends

**Status:** Proposed

**This pull request:** Design documentation only; it does not implement HPA-341.

**Linear:** [HPA-341](https://linear.app/cwchanap/issue/HPA-341/expose-persistence-validation-and-restoration-through-equivalent-wasm)

**Prerequisite:** [HPA-340](https://linear.app/cwchanap/issue/HPA-340/implement-rust-persistence-snapshots-and-atomic-validated-engine), implemented in PR #17

## Outcome

The frontend can request a persistence-safe snapshot, validate untrusted imported
gameplay state without mutating the active engine, and restore a validated engine
through one host-neutral `GameBackend` contract.

Browser WASM and Tauri expose the same operation names, success shapes, error
categories, core validation payloads, and state-replacement semantics. Rust remains
the only authority that can accept gameplay state. TypeScript never repairs,
normalizes, or directly installs an imported snapshot.

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

- `GameBackend` still exposes optional `loadSnapshot` returning a snapshot or
  rejecting a promise;
- the WASM adapter replaces its local wrapper through the exported static
  `WasmGameEngine::from_snapshot` constructor;
- Tauri exposes `game_load_snapshot`, which returns structured core errors but raw
  string deserialization and mutex failures;
- TypeScript does not have a closed persistence error model; and
- ordinary WASM snapshot serialization still differs from Tauri JSON for some
  Rust `Option::None` values.

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
6. Full snapshot deserialization and response serialization failures are separate
   from semantic validation failures.
7. `validateSnapshot` is pure and returns no gameplay snapshot on success.
8. Only Rust-backed `restoreSnapshot` may replace authoritative gameplay state.
9. Both hosts construct a complete candidate engine and encode the successful
   response before committing the candidate. A response-encoding failure cannot
   leave the host mutated while returning failure.
10. A successful restore preserves every serialized gameplay field exactly. Only
    the non-serialized road topology is recompiled.
11. Persistence operations use JSON-compatible WASM serialization so the browser
    and Tauri expose the same persistable shape. Existing gameplay
    `snapshot`/`dispatch`/`tick` serialization is not changed by this issue.
12. `loadSnapshot`, `game_load_snapshot`, and the exported WASM
    `WasmGameEngine::from_snapshot` constructor are removed.
13. The full Rust persistence-error vocabulary is mirrored by TypeScript and
    guarded through a shared cross-language fixture catalogue.
14. Runtime state publication, transient UI reset, save envelopes, and storage
    belong to HPA-342 and later persistence issues.
15. No worker boundary is introduced without measured WASM evidence that the
    synchronous core operation exceeds the interaction budget.

## Goals

- Expose a safe save snapshot from both hosts without changing the live pause
  state.
- Validate untrusted snapshots without acquiring or mutating managed engine state.
- Restore snapshots atomically in WASM and Tauri.
- Return equal persistable snapshot shapes for equal engine state.
- Give frontend consumers one closed result/error contract.
- Preserve every core validation error without variant-specific host mapping.
- Distinguish unsupported schema, semantic corruption, malformed current-schema
  payloads, response-encoding failures, and host invocation/state failures.
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
- Moving the WASM engine to a Web Worker without performance evidence.
- Changing the ordinary gameplay snapshot shape or the runtime's existing
  dispatch/tick error behavior.

## 1. Terminology and Invariants

### 1.1 Runtime snapshot

`GameBackend.snapshot()` returns the host's current ordinary gameplay wire value.
It is used by the live runtime and retains the existing serializer behavior. HPA-341
does not redefine or normalize this path.

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

For HPA-341, “canonical” means the canonical host wire serialization of the exact
Rust-accepted snapshot.

It does **not** mean that Rust repairs or rewrites the candidate. A valid restore
preserves the supplied `GameSnapshot` exactly; only the internal, non-serialized
`RoadTopology` is rebuilt. JSON-compatible serialization makes Rust `None` values
match the Tauri JSON representation where the field is not explicitly skipped by
Serde.

### 1.5 State authority

TypeScript may store, forward, and display snapshots. It may not:

- cast an imported value and install it as authoritative state;
- construct a replacement WASM engine from imported state;
- assign gameplay state directly inside `createGameRuntime`;
- repair rejected fields; or
- publish a candidate before Rust restoration succeeds.

## 2. Public TypeScript Contract

Add the persistence contract under `src/runtime/backend/`. The exact file split may
place the static types in `types.ts` or a focused `persistenceContract.ts`; runtime
guards and shared normalization belong in `persistence.ts`.

```ts
export interface PersistenceSnapshotRequest {
  snapshot: unknown;
}

export type PersistenceOperation =
  | "snapshotForSave"
  | "validateSnapshot"
  | "restoreSnapshot";

export type PersistenceSerializationPhase =
  | "snapshotDecode"
  | "snapshotEncode";

export type PersistenceHostErrorCode =
  | "stateUnavailable"
  | "invokeFailed"
  | "unexpectedResponse";

export type PersistenceOperationError =
  | {
      kind: "validation";
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

export type PersistenceSnapshotResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: PersistenceOperationError };

export type PersistenceValidationResult =
  | { ok: true }
  | { ok: false; error: PersistenceOperationError };
```

Extend `GameBackend` with required methods:

```ts
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
- `ok: false, kind: "validation"` means the candidate deserialized into the typed
  Rust model and failed the core persistence contract, or the schema probe rejected
  it.
- `ok: false, kind: "serialization"` means a current-schema candidate could not be
  decoded into `GameSnapshot`, or a successful Rust snapshot could not be encoded
  for the host response.
- `ok: false, kind: "host"` means the managed host state was unavailable, the raw
  invocation failed outside the known bridge contract, or the adapter received an
  unrecognized response shape.

The `diagnostic` string is opaque, host-local troubleshooting information. It may be
logged or displayed, but no code may branch on its text.

### 2.2 Backend initialization

`createWasmBackend()` must finish WASM initialization before constructing and
returning a backend. Initialization failure remains a backend-factory rejection,
because no `GameBackend` exists yet to return a persistence operation result.

HPA-341 adds focused tests proving that failed initialization:

- rejects backend creation;
- does not construct a `WasmGameEngine`; and
- does not cache a false successful initialization state.

No new application-wide initialization-error API is introduced in this issue.

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
- arrays are accepted only for documented array fields;
- each `code`, `field`, entity `kind`, and reason `kind` must belong to the closed
  vocabulary above;
- required keys must be present with the documented primitive type;
- optional `entity` is the only optional top-level context member;
- unit reason variants must not contain `details`;
- structured reason variants must contain exactly the documented `details` keys;
- unknown keys are rejected at every closed object level; and
- numeric members must be JavaScript numbers, while semantic numeric validation
  remains Rust's responsibility.

The guard recognizes Rust output. It is not an alternate validator for imported
snapshots.

## 4. Host Bridge Error Contract

WASM and Tauri use the same tagged bridge-error wire shape:

```json
{
  "kind": "validation",
  "error": {
    "code": "invalidModeSettings",
    "context": {
      "field": "paused",
      "reason": { "kind": "persistenceRequiresPaused" }
    }
  }
}
```

```json
{
  "kind": "serialization",
  "phase": "snapshotDecode",
  "diagnostic": "opaque host diagnostic"
}
```

```json
{
  "kind": "host",
  "code": "stateUnavailable",
  "operation": "restoreSnapshot",
  "diagnostic": "opaque host diagnostic"
}
```

The Rust host bridges directly emit:

- `validation` for `PersistenceError`;
- `serialization/snapshotDecode` for full `GameSnapshot` deserialization failure
  after the schema probe accepts the declared version;
- `serialization/snapshotEncode` for success-value encoding failure; and
- Tauri `host/stateUnavailable` for poisoned managed state.

The TypeScript shared normalizer synthesizes:

- `host/invokeFailed` when the host invocation rejects outside the known bridge
  contract; and
- `host/unexpectedResponse` when a returned or rejected value has an unrecognized
  shape.

No host branch translates individual core error variants. It wraps the complete
`PersistenceError` generically, so adding a Rust variant fails the cross-language
catalogue tests rather than silently falling through to a string.

## 5. Shared Decode Contract

Both Rust hosts use the same logical two-phase decoder.

1. Probe `schemaVersion` without requiring the remaining snapshot fields.
2. Delegate the version comparison to the existing core schema-check helper.
3. When the probe is missing, has the wrong type, or cannot deserialize, use
   `actual = 0` and return `PersistenceError::UnsupportedSchema`.
4. Only after the schema matches, deserialize the complete `GameSnapshot`.
5. A complete-deserialization failure is
   `serialization/snapshotDecode`, not a core validation error.
6. Pass the typed snapshot to the complete core validation or construction path.

This preserves HPA-340's distinction:

| Candidate failure | Public category |
| --- | --- |
| Missing or unreadable `schemaVersion` | `validation / unsupportedSchema(actual: 0)` |
| Explicit old or future schema | `validation / unsupportedSchema` |
| Matching schema with wrong field type or missing required field | `serialization / snapshotDecode` |
| Typed snapshot violates semantic invariants | `validation / PersistenceError` |

The two host implementations may use host-specific deserializers, but the decision
order and public category must be identical.

## 6. WASM Bridge

### 6.1 Serialization helper

Add a focused JSON-compatible serializer helper in `crates/caelum-wasm` using
`serde_wasm_bindgen::Serializer::json_compatible()`.

It is used only for HPA-341 persistence operation successes and structured bridge
errors. Ordinary gameplay methods retain `serde_wasm_bindgen::to_value` so this
issue does not change runtime rendering or existing frontend normalization.

`crates/caelum-wasm/Cargo.toml` adds a direct Serde dependency needed by the
serializer helper. No JSON text round-trip is introduced.

### 6.2 Operations

Expose instance methods on `WasmGameEngine` with generated JavaScript names that
map to the TypeScript adapter:

```rust
pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue>;
pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue>;
pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue>;
```

#### `snapshot_for_save`

1. Call `self.inner.snapshot_for_save()`.
2. Wrap any `PersistenceError` as `validation`.
3. Encode the snapshot with the JSON-compatible serializer.
4. Map encoding failure to `serialization/snapshotEncode`.
5. Never assign to `self.inner`.

#### `validate_snapshot`

1. Decode the untrusted `JsValue` through the shared two-phase decoder.
2. Call `caelum_core::validate_snapshot(&snapshot)`.
3. Return unit on success.
4. Never assign to `self.inner`.

The method is an instance operation for `GameBackend` symmetry even though it does
not read the engine.

#### `restore_snapshot`

1. Decode the untrusted `JsValue`.
2. Construct a complete candidate with `GameEngine::from_snapshot(snapshot)`.
   This validates the snapshot and recompiles topology without touching the live
   wrapper.
3. Read the exact candidate snapshot.
4. Encode that snapshot with the JSON-compatible serializer.
5. Only after encoding succeeds, assign `self.inner = candidate`.
6. Return the already-encoded value.

This construct-encode-swap sequence is stronger than mutating through the in-place
core method and then encoding. It guarantees that a response-encoding failure does
not replace the active WASM engine.

### 6.3 Remove direct construction

Remove the wasm-bindgen-exported `WasmGameEngine::from_snapshot` function. Core
`GameEngine::from_snapshot` remains available internally to the wrapper, but
TypeScript can no longer construct a replacement engine directly from imported
state.

The TypeScript adapter keeps one stable `WasmGameEngine` wrapper instance. Restore
mutates its Rust-owned inner engine only through `restore_snapshot`.

### 6.4 Initialization

Keep the current single cached initialization promise, but test both outcomes:

- successful initialization is shared across backend instances; and
- failed initialization rejects each dependent backend construction without
  constructing an engine or producing a usable partial backend.

A failed promise is not reset implicitly in this issue. Retrying initialization is
an application bootstrap policy, not a persistence operation.

## 7. Tauri Bridge

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

All three are registered in the production invoke handler and in the focused
Tauri mock application used by command tests.

### 7.1 Save lock boundary

`game_snapshot_for_save` follows this order:

1. acquire the engine mutex;
2. clone the complete `GameEngine`;
3. release the mutex;
4. call `snapshot_for_save` on the clone;
5. encode the snapshot to `serde_json::Value`; and
6. return the encoded value.

Validation and topology checks therefore do not hold the managed-state mutex.
Poisoned state returns `host/stateUnavailable` before a clone is obtained.

### 7.2 Pure validation

`game_validate_snapshot`:

1. performs the two-phase decode;
2. calls `caelum_core::validate_snapshot`; and
3. returns unit.

It takes no `State`, so the command cannot accidentally acquire or mutate the live
engine.

### 7.3 Restore lock boundary

`game_restore_snapshot` follows this exact order:

1. decode the untrusted `serde_json::Value`;
2. construct `GameEngine::from_snapshot` outside the mutex;
3. read the candidate's exact snapshot;
4. encode the success snapshot to `serde_json::Value` outside the mutex;
5. acquire the managed engine mutex;
6. replace `*engine` with the complete candidate; and
7. return the already-encoded snapshot value.

Every fallible validation, topology, and response-encoding step completes before
state replacement. Mutex poisoning occurs before the swap and leaves the old engine
unchanged.

Returning `serde_json::Value` rather than `GameSnapshot` is intentional: it makes
response serialization an explicit pre-commit step rather than a framework-owned
step after the command has already mutated state.

### 7.4 Command errors

Replace the persistence path's raw `serde_json::Value` errors with a dedicated
serializable bridge error. Existing sandbox and gameplay command error contracts
remain unchanged.

The bridge error must serialize as the same tagged object used by WASM. Unit tests
assert exact JSON for validation, decode, encode, and state-unavailable variants.

## 8. TypeScript Adapter Normalization

Create one shared persistence helper used by `wasmBackend.ts` and
`tauriBackend.ts`.

Recommended public functions:

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

- accepts sync WASM methods and async Tauri invocations;
- converts known bridge rejections directly into `{ ok: false, error }`;
- verifies that snapshot success is a non-array object with a numeric
  `schemaVersion` before casting it to `RustGameSnapshot`;
- treats an invalid success value as `host/unexpectedResponse`;
- treats unknown rejection objects as `host/unexpectedResponse`;
- treats other unknown invocation rejection values as `host/invokeFailed`;
- creates an opaque diagnostic through safe stringification; and
- never parses or pattern-matches diagnostic text.

The minimal success check is transport validation, not gameplay validation. Deep
snapshot correctness remains exclusively Rust-owned.

### 8.1 WASM adapter

`createWasmBackend`:

- initializes WASM before engine construction;
- constructs one `WasmGameEngine`;
- calls `engine.snapshot_for_save`, `engine.validate_snapshot`, and
  `engine.restore_snapshot` through the shared normalization helper; and
- no longer reassigns the TypeScript `engine` variable during restore.

### 8.2 Tauri adapter

`createTauriBackend` invokes:

- `game_snapshot_for_save` with no arguments;
- `game_validate_snapshot` with `{ snapshot: request.snapshot }`; and
- `game_restore_snapshot` with `{ snapshot: request.snapshot }`.

It uses the same shared normalizer and returns the same result unions as WASM.

### 8.3 Exports

`src/runtime/backend/index.ts` exports the persistence request, result, operation,
validation-error, and guard types needed by HPA-342. It does not export raw
host-specific bridge DTOs or Rust wrapper constructors.

## 9. Operation Data Flows

### 9.1 Save

```text
frontend
  -> GameBackend.snapshotForSave()
  -> host clones or borrows current Rust engine
  -> GameEngine::snapshot_for_save()
  -> complete core validation
  -> JSON-compatible host encoding
  -> { ok: true, snapshot }
```

A running engine may return `snapshot.paused === true`, while a subsequent ordinary
`backend.snapshot()` still reports the live engine's original pause state.

### 9.2 Validate

```text
frontend unknown value
  -> GameBackend.validateSnapshot({ snapshot })
  -> schema probe
  -> full Rust deserialization
  -> caelum_core::validate_snapshot
  -> { ok: true }
```

No engine state is read, cloned, locked, constructed, or replaced after the
candidate becomes typed, except for the temporary topology compiled and discarded
inside core validation.

### 9.3 Restore

```text
frontend unknown value
  -> GameBackend.restoreSnapshot({ snapshot })
  -> schema probe
  -> full Rust deserialization
  -> GameEngine::from_snapshot candidate
  -> topology recompiled
  -> success snapshot encoded
  -> candidate engine swapped into host
  -> { ok: true, snapshot }
```

The returned snapshot is the exact committed candidate. HPA-342 will consume that
success result to reset local UI state and publish the restored runtime snapshot.

## 10. Atomicity and Publication Boundaries

### 10.1 Failed save

A save failure never mutates the live engine because `snapshot_for_save` operates on
a clone. This includes a validation failure in unexpectedly corrupted live state
and a success-response encoding failure.

### 10.2 Failed validation

Validation has no mutable host-state dependency and cannot change the active engine.

### 10.3 Failed restore

A restore is considered failed when any of these occurs:

- schema rejection;
- full snapshot decode failure;
- semantic validation failure;
- topology compilation failure;
- success snapshot encoding failure;
- managed-state lock failure; or
- unexpected host invocation failure.

For every failure, the active engine and its topology remain unchanged.

### 10.4 Successful restore

A successful restore:

- commits the complete candidate engine;
- returns the already-encoded candidate snapshot;
- makes a subsequent ordinary `snapshot()` observe the restored state; and
- makes subsequent dispatch/tick operations use the recompiled candidate topology.

HPA-341's publication guarantee ends at the backend boundary: the host commits and
returns the canonical snapshot. HPA-342 owns committing it to
`createGameRuntime`'s view state, clearing transient UI state, and notifying runtime
subscribers.

## 11. Cross-host Serialization Parity

Persistence operations use JSON-compatible values rather than the ordinary WASM
serializer defaults.

For equal Rust state, WASM and Tauri must produce deeply equal persistence JSON:

- required `Option::None` fields serialize as `null`;
- fields carrying `skip_serializing_if = "Option::is_none"` are omitted on both
  hosts;
- Rust maps, if introduced into the persisted model, serialize as plain objects;
- bytes, if introduced into the persisted model, serialize as JSON arrays; and
- no JavaScript `Map`, `BigInt`, `undefined`, or typed-array-only value appears in
  the persistence snapshot.

Parity is asserted against shared JSON fixtures. TypeScript does not post-process
successful snapshots to manufacture equality.

## 12. Fixture Corpus

Create checked-in fixtures under `tests/fixtures/persistence/`. Fixtures are JSON
values generated from real schema-v4 Rust snapshots and then deliberately mutated
where noted.

### 12.1 Snapshot fixtures

- `valid-paused.json` — a nontrivial persistence-valid snapshot containing authored
  roads, transit, and representative entities.
- `unsupported-schema.json` — the valid fixture with an older schema version and a
  required current-schema field removed.
- `unpaused.json` — the valid fixture with only `paused = false`.
- `malformed-current-schema.json` — the valid fixture with the current schema but a
  required field changed to the wrong JSON type.
- `late-derived-corruption.json` — a valid fixture mutated to fail at a late derived
  validation stage, proving state remains unchanged after substantial validation
  work.

The fixtures do not become a second source of authoritative sandbox content. A
Rust generator or test helper creates the baseline from the real engine, and a
regeneration note records the command used to update checked-in JSON when the
snapshot schema intentionally changes.

### 12.2 Error catalogue

Add `persistence-errors.json` containing representative exact payloads that cover:

- every top-level `PersistenceError.code`;
- every `PersistenceSnapshotField` value;
- every entity kind;
- every nested reason `kind`; and
- every structured `details` shape.

The catalogue is contract coverage, not a substitute for the HPA-340 corruption
matrix. Host bridges generically wrap the enum, so exhaustive wire vocabulary plus
representative end-to-end failures proves mapping without running every expensive
corruption fixture through both hosts.

## 13. Test Strategy

### 13.1 Core wire-catalogue test

Extend the core persistence wire tests to load `persistence-errors.json`,
deserialize each validation payload into `PersistenceError`, reserialize it, and
assert exact equality.

Also assert that the catalogue covers the complete current top-level and nested
vocabulary. The test must fail when Rust adds a new code, field, entity kind, or
reason kind without updating the fixture and TypeScript mirror.

### 13.2 WASM Rust tests

In `crates/caelum-wasm` or real-artifact integration coverage, assert:

- `snapshot_for_save` changes only the returned pause field and does not pause the
  live engine;
- the output equals `valid-paused.json` for the matching fixture engine;
- pure validation succeeds without mutation;
- unsupported schema maps to wrapped `validation`;
- unpaused semantic input maps to the exact wrapped `PersistenceError`;
- malformed current-schema input maps to `serialization/snapshotDecode`;
- late semantic failure preserves the wrapper's pre-restore snapshot;
- restore success returns and commits the exact candidate;
- subsequent dispatch uses the restored candidate's rules/topology;
- the JSON-compatible success shape contains no `undefined`; and
- response-encoding failure is exercised through a focused injectable/test-only
  serializer seam and preserves state.

### 13.3 Tauri command tests

Use Tauri's mock runtime and the same snapshot fixtures to assert:

- save clones under the lock but performs validation after releasing it;
- validation command has no managed state dependency;
- save output equals the shared valid fixture;
- schema, semantic, and malformed payload categories match WASM;
- early and late restore failures preserve managed snapshot and topology-observable
  behavior;
- restore success returns and commits the exact candidate;
- candidate response serialization happens before managed state replacement;
- poisoned mutex maps to `host/stateUnavailable` and preserves state; and
- the old `game_load_snapshot` command is no longer registered.

A focused serializer seam may be used in command-unit tests to force
`snapshotEncode` failure. Production code continues using ordinary
`serde_json::to_value`.

### 13.4 TypeScript contract tests

Add `tests/runtime/persistenceContract.test.ts` covering:

- every `persistence-errors.json` entry passes the strict guard;
- unknown top-level codes, fields, entity kinds, reason kinds, missing keys,
  unexpected keys, and inappropriate `details` are rejected;
- known bridge error objects map directly to `{ ok: false }`;
- string and primitive invocation failures become `host/invokeFailed`;
- malformed rejection objects become `host/unexpectedResponse`;
- malformed success values become `host/unexpectedResponse`; and
- diagnostics are not inspected to select a category.

### 13.5 WASM adapter tests

Update the generated-wrapper mock to expose instance persistence methods and remove
the static snapshot constructor. Assert exact forwarding and shared result
normalization for all three operations.

Retain separate initialization tests for Bun, Node/Vitest, browser, cached success,
and failed initialization.

### 13.6 Real WASM artifact tests

Exercise the built artifact with shared fixtures. These tests are the browser-host
proof that the Rust wrapper, wasm-bindgen generation, JSON-compatible serializer,
and TypeScript adapter compose correctly.

Record non-flaky timing evidence for validation and restoration of the existing
HPA-340 benchmark-class fixture. Do not assert a wall-clock threshold in CI.

### 13.7 Tauri adapter tests

Assert exact command names and argument shapes, then run the same operation-result
normalization cases used by the WASM adapter.

### 13.8 Backend contract tests

Update `backendContract.test.ts` so all complete backend stubs implement the three
required persistence methods. Add compile-time assertions for exact signatures and
remove every `loadSnapshot` assertion.

### 13.9 Repository bypass search

Implementation review records the output of searches proving there is no production
occurrence of:

- `loadSnapshot`;
- `game_load_snapshot`;
- `WasmGameEngine.from_snapshot`; or
- a TypeScript assignment that installs imported gameplay state.

Core `GameEngine::from_snapshot` remains expected and is used internally by the two
Rust host bridges and persistence tests.

### 13.10 Regression suite

The complete existing gameplay suite remains green. HPA-341 does not change intent,
tick, preview, sandbox factory/reset, rendering, or runtime scheduling semantics.

Verification commands:

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

## 14. Performance and Concurrency

HPA-340 measured the large native validation fixture well below the interaction
budget. HPA-341 records equivalent real-WASM validation and restore timing as PR
evidence.

Performance rules:

- do not weaken or partially run core validation;
- do not decode or validate the same candidate twice in one host operation;
- construct one candidate engine and retain its compiled topology for restore;
- keep expensive Tauri validation and encoding outside the managed-state mutex;
- do not add a Web Worker or asynchronous Rust job boundary without measured need;
- do not make timing a flaky CI assertion; and
- if measured WASM work is too slow, create a follow-up host-execution ticket rather
  than expanding HPA-341 during implementation.

The WASM wrapper remains single-owner mutable state. Tauri serializes replacement
through its mutex, but holds the mutex only for clone or final swap.

## 15. File Map

### Create

- `src/runtime/backend/persistence.ts` — strict validation/bridge guards and shared
  result normalization.
- `tests/runtime/persistenceContract.test.ts` — TypeScript vocabulary and
  normalization tests.
- `tests/fixtures/persistence/valid-paused.json`.
- `tests/fixtures/persistence/unsupported-schema.json`.
- `tests/fixtures/persistence/unpaused.json`.
- `tests/fixtures/persistence/malformed-current-schema.json`.
- `tests/fixtures/persistence/late-derived-corruption.json`.
- `tests/fixtures/persistence/persistence-errors.json`.
- a focused fixture-generation helper or documented test command in the existing
  core test support, without adding a production binary.

### Modify

- `crates/caelum-wasm/Cargo.toml` — direct Serde dependency.
- `crates/caelum-wasm/src/lib.rs` — JSON-compatible persistence operations,
  decoder, bridge errors, and removal of exported direct construction.
- `src-tauri/src/lib.rs` — three commands, bridge errors, lock discipline, command
  registration, and command tests.
- `src/runtime/backend/types.ts` — public persistence contract and required
  `GameBackend` methods.
- `src/runtime/backend/wasmBackend.ts` — instance-operation forwarding.
- `src/runtime/backend/tauriBackend.ts` — new command forwarding.
- `src/runtime/backend/index.ts` — public exports.
- `tests/runtime/backendContract.test.ts` — signatures and complete stubs.
- `tests/runtime/wasmBackend.test.ts` — wrapper mock and adapter behavior.
- `tests/runtime/wasmArtifact.smoke.test.ts` — real bridge behavior and fixtures.
- `tests/runtime/tauriBackend.test.ts` — command forwarding and result behavior.
- `tests/fixtures/rustSnapshot.ts` and other complete backend stubs — required
  persistence methods.
- `crates/caelum-core/tests/persistence_error_wire.rs` — shared catalogue
  round-trip and exhaustiveness coverage.
- `docs/architecture.md` and relevant persistence documentation — authoritative
  host boundary and ownership rules.

### Delete or retire

- optional `GameBackend.loadSnapshot`;
- WASM adapter engine-variable replacement through a static constructor;
- wasm-bindgen-exported `WasmGameEngine::from_snapshot`;
- Tauri `game_load_snapshot`; and
- tests that assert the old rejected-promise compatibility contract.

## 16. Review Gates

### Gate 1: Contract

The TypeScript union, strict guards, shared error catalogue, and failing backend
signature tests are reviewable before host implementation. The catalogue must match
the complete current Rust vocabulary.

### Gate 2: WASM

The raw wrapper operations, JSON-compatible persistence serializer, candidate
construct-encode-swap restore, initialization coverage, and removal of direct
construction are complete and independently tested.

### Gate 3: Tauri

The three managed commands, outside-lock preparation, pre-commit response encoding,
state-unavailable error, and atomicity tests are complete.

### Gate 4: Adapter parity

Both adapters use the same shared normalizer, implement the required `GameBackend`
methods, and pass the same fixture expectations. The old compatibility API is gone.

### Gate 5: Regression and evidence

Documentation, bypass search, complete Rust/frontend checks, and real-WASM timing
evidence are present before the eventual implementation PR is marked ready for review.

## 17. Acceptance-Criteria Mapping

### Both hosts return the same persistence snapshot shape for equal engine state

Covered by JSON-compatible persistence serialization and assertions against the
same checked-in valid fixture.

### Both hosts map every core validation error to the same typed frontend contract

Covered by generic `PersistenceError` wrapping, the exhaustive Rust error catalogue,
the strict TypeScript mirror, and representative end-to-end host failures.

### Failed restoration leaves managed host state unchanged

Covered by candidate construction and response encoding before assignment, plus
early and late failure tests in both hosts.

### Successful restoration returns and publishes the validated canonical snapshot

HPA-341 commits the candidate inside the host and returns the exact encoded committed
snapshot. HPA-342 consumes that result for runtime-view publication and transient UI
reset.

### No TypeScript path can directly replace gameplay state

Covered by removing `loadSnapshot`, removing the exported WASM static constructor,
keeping Tauri replacement inside a validating Rust command, and the repository
bypass search.

### Existing gameplay dispatch/tick behavior remains unchanged

Covered by limiting JSON-compatible serialization to persistence operations and
running the complete existing regression suite.

## 18. Downstream Contract for HPA-342

HPA-342 may assume:

- manual save calls `snapshotForSave` and stores only an `ok: true` snapshot;
- import/recovery can call `validateSnapshot` before any store write or active-city
  mutation;
- load calls `restoreSnapshot` and receives the exact committed snapshot;
- failures are data, not message-parsed promise rejections;
- validation never changes the active engine;
- failed restore never changes the active engine; and
- storage code never branches on WASM versus Tauri.

HPA-342 must still own:

- `SaveEnvelope` metadata and envelope/snapshot version agreement;
- `SaveStore` abstractions and host storage;
- active-city identity;
- dirty-state tracking;
- serialization of gameplay mutations with save/load coordination;
- committing the restored snapshot into runtime view state;
- clearing drafts, gestures, selections, previews, and transient errors; and
- notifying runtime subscribers.

## 19. Explicit Non-expansion

Implementation must not absorb HPA-342 storage/coordinator work merely because the
new methods have no production UI caller yet. Backend and host tests are sufficient
to land HPA-341 safely.

Do not add:

- a temporary save envelope;
- browser or desktop storage;
- a manual save button;
- a city-library model;
- import/export dialogs;
- runtime dirty tracking;
- autosave scheduling;
- migration or repair;
- a worker boundary without measured need; or
- TypeScript gameplay validation beyond strict recognition of Rust error and
  transport response shapes.
