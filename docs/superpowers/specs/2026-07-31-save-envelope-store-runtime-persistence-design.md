# Save Envelope, SaveStore, and Runtime Persistence Design

**Issue:** HPA-342  
**Implementation children:** HPA-498, HPA-499  
**Status:** Draft / in review

## 1. Purpose

Caelum needs one frontend persistence model that behaves identically in browser and Tauri builds while preserving Rust as the only authority over gameplay restoration.

This design defines two implementation boundaries:

1. **HPA-498** defines the versioned save envelope, compatibility inspection, host-neutral `SaveStore` contract, typed storage failures, in-memory adapter, and reusable adapter contract suite.
2. **HPA-499** integrates capture and restoration with `createGameRuntime`, tracks active-city lifecycle and revision-based dirty state, and guarantees that persistence operations share the existing gameplay ordering boundary.

HPA-342 is a coordination parent. It is complete only when both children are complete and their contracts remain consistent.

## 2. Existing foundation

HPA-340 and HPA-341 already implement the authoritative persistence behavior in `caelum-core`, the WASM wrapper, the Tauri host, and `GameBackend`:

- `snapshotForSave()` captures committed Rust state, normalizes only `paused = true`, validates it, and returns a JSON-compatible raw Rust snapshot;
- `validateSnapshot({ snapshot })` performs pure candidate validation without replacing host state;
- `restoreSnapshot({ snapshot })` validates and prepares a complete engine before host state is replaced;
- failed restoration leaves backend state unchanged;
- successful restoration returns the canonical raw Rust snapshot after topology recompilation; and
- browser and Tauri expose the same typed persistence result contract.

HPA-342 consumes those implemented operations rather than introducing TypeScript snapshot serialization, repair, migration, or direct state replacement.

`createGameRuntime` already owns the serialized queue used by gameplay dispatch and simulation tick operations. Save capture and restoration join that ordering boundary. A second independent backend queue would permit save and load operations to race authoritative gameplay mutations.

## 3. Invariants

The implementation preserves these invariants:

1. Rust gameplay state is authoritative. Host metadata never participates in simulation equality or deterministic continuation.
2. Every gameplay-bearing write produced from the active runtime—working save, checkpoint, or autosave—obtains its payload from `backend.snapshotForSave()`.
3. A load never publishes candidate gameplay state before `backend.restoreSnapshot()` succeeds.
4. Failed read, envelope inspection, or restoration leaves the current runtime state and active-city identity unchanged.
5. Browser and Tauri consumers use one `SaveStore` interface and never branch by host.
6. Gameplay dispatch, tick, sandbox creation, reset, save capture, and restoration have one total order.
7. Normal working-save, checkpoint, and autosave storage I/O leaves the gameplay queue after canonical capture. **Foreground initial-city creation is the sole exception:** it may reserve gameplay admission across the initial write and rollback so an uncommitted candidate city can never become playable.
8. Late asynchronous completions cannot update a newer runtime session.
9. Only a successful working-save write advances the working persistence baseline and `lastSavedAt`. Checkpoint and autosave writes never clear dirty state.
10. Loading a working save is clean. Loading a checkpoint or autosave is dirty because the working save was not replaced.
11. List compatibility is not semantic gameplay validation. Only Rust validation/restoration establishes that a candidate gameplay snapshot is valid.
12. Raw `RustGameSnapshot` values are normalized only while committing a runtime view; normalized `GameState` is never reused as a persistence payload.
13. Storage adapters do not mint IDs, timestamps, or generation numbers and do not silently repair malformed records.
14. Internal session, request, and revision tokens never leak into persisted data or public presentation state.

## 4. Save envelope

### 4.1 Domain-backed version 1 shape

The envelope reuses the shared TypeScript domain types rather than repeating their literal unions:

```ts
import type {
  EconomyPreset,
  GameMode,
  SandboxTemplateId,
} from "../domain/types";

export const CAELUM_SAVE_FORMAT = "caelum-save" as const;
export const SAVE_ENVELOPE_VERSION = 1 as const;

export interface SaveEnvelopeSummary {
  gameMode: GameMode;
  economyPreset: EconomyPreset;
  sandboxTemplateId: SandboxTemplateId;
}

export interface SaveEnvelope<TSnapshot = unknown> {
  format: typeof CAELUM_SAVE_FORMAT;
  envelopeVersion: typeof SAVE_ENVELOPE_VERSION;
  city: {
    id: string;
    name: string;
  };
  cityCreatedAt: string;
  savedAt: string;
  appVersion: string;
  snapshotSchemaVersion: number;
  summary: SaveEnvelopeSummary;
  snapshot: TSnapshot;
}

export type WritableSaveEnvelope = SaveEnvelope<RustGameSnapshot>;
export type InspectedSaveEnvelope = SaveEnvelope<unknown>;
export type UntrustedSaveValue = unknown;
```

Current Rust snapshots always carry `rules.sandbox.templateId`, including campaign snapshots, so `sandboxTemplateId` is not nullable in envelope version 1. If a future gameplay schema removes that invariant, the envelope summary contract changes deliberately rather than preserving an unreachable null arm.

`UntrustedSaveValue` is the raw value returned by a storage adapter and is not assumed to have envelope shape. `InspectedSaveEnvelope` is returned only after exception-safe envelope inspection succeeds. Its `snapshot` remains untrusted gameplay until Rust validation/restoration succeeds.

The fixed `format` discriminator prevents arbitrary JSON objects from being confused with Caelum saves. `envelopeVersion` versions host metadata and record structure independently from the Rust snapshot schema.

`appVersion` is informational in envelope version 1. An application-version difference alone does not reject a save. Snapshot compatibility is controlled by the envelope and Rust snapshot schema versions.

Application version and wall clock are injected into envelope-building workflow services. Persistence modules and adapters do not import package metadata, call `Date.now()`, or mint random IDs internally.

### 4.2 Metadata authority

The following are host metadata and are excluded from authoritative gameplay equality:

- city ID and display name;
- city creation and save timestamps;
- application version;
- envelope version;
- duplicated summary fields; and
- checkpoint/autosave record metadata.

The summary is derived from the canonical Rust snapshot when a new gameplay-bearing envelope is created. It supports listing without restoring every record. It is advisory and must not override values inside `snapshot`.

Rename changes only `city.name`; it preserves `cityCreatedAt`, `savedAt`, `appVersion`, `snapshotSchemaVersion`, summary, and snapshot.

Duplicate assigns a new city ID, display name, city creation time, save time, and current application version while preserving the gameplay snapshot and the envelope-version-1 summary. `SaveStore` does not reinterpret untrusted gameplay to regenerate summary metadata during duplicate. If summary derivation changes incompatibly, the envelope version changes or a higher-level validated migration owns the change.

### 4.3 Record roles remain outside the envelope

The envelope does not identify itself as a working save, checkpoint, or autosave. These are storage roles assigned by `SaveStore`.

This separation allows the same envelope shape to be used by working saves, generations, and future portable export without embedding host layout or rotation policy into the file format.

## 5. Compatibility inspection and envelope errors

### 5.1 Mirrored schema-version source

The repository currently has two intentionally mirrored authoritative constants:

- TypeScript: `src/domain/types.ts::SNAPSHOT_SCHEMA_VERSION`;
- Rust: `crates/caelum-core/src/model.rs::SNAPSHOT_SCHEMA_VERSION`.

They must move together in one reviewed schema change. The TypeScript inspector derives its supported set from the TypeScript constant:

```ts
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = new Set<number>([
  SNAPSHOT_SCHEMA_VERSION,
]);
```

The Tauri/Rust boundary derives from the Rust constant. Implementations must not copy additional private numeric literals into adapters.

A parity test uses the Rust-generated persistence fixture and host contract to assert that:

1. the fixture schema equals the Rust constant;
2. the same fixture schema equals the TypeScript constant; and
3. memory, IndexedDB, WASM-facing, and Tauri-facing compatibility paths classify the fixture identically.

With the current repository contract, both constants and the supported set equal schema `4`.

### 5.2 Inspection order

A read candidate is untrusted. The inspector performs these checks before runtime restoration:

1. safely inspect the outer value as a plain object;
2. verify the fixed format discriminator;
3. verify a supported envelope version;
4. read the declared snapshot schema version;
5. reject a declared snapshot schema version not in `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`;
6. safely probe `snapshot.schemaVersion` without deeply interpreting the snapshot;
7. reject a declared/embedded schema mismatch; and
8. return the inspected envelope so the runtime can pass the original snapshot candidate to `backend.restoreSnapshot()`.

If `snapshot` is not an inspectable object or does not contain a finite integer `schemaVersion`, the inspector reports:

```ts
{
  code: "snapshotVersionMismatch",
  declaredVersion,
  embeddedVersion: null,
}
```

It does **not** pass that candidate to `restoreSnapshot`. A throwing proxy/getter encountered while inspecting the header is `corruptHeader`.

Envelope inspection is exception-safe and is not an alternate gameplay validator.

### 5.3 Closed load-error taxonomy

```ts
export type SaveEnvelopeError =
  | { code: "corruptHeader" }
  | { code: "unsupportedEnvelope"; version: number }
  | { code: "unsupportedSnapshot"; version: number }
  | {
      code: "snapshotVersionMismatch";
      declaredVersion: number;
      embeddedVersion: number | null;
    };
```

Load failure uses `SaveEnvelopeError`. Listing uses the same taxonomy with a `status` discriminant plus a successful candidate state:

```ts
export type SaveCompatibility =
  | { status: "candidate" }
  | { status: "corruptHeader" }
  | { status: "unsupportedEnvelope"; version: number }
  | { status: "unsupportedSnapshot"; version: number }
  | {
      status: "snapshotVersionMismatch";
      declaredVersion: number;
      embeddedVersion: number | null;
    };
```

The inspector provides one exhaustive mapping from every non-candidate `SaveCompatibility` variant to the corresponding `SaveEnvelopeError`. HPA-498 tests the catalogue so HPA-499 cannot invent a second mapping.

`candidate` means only that the safely readable header is compatible with the current frontend contract. It does not mean semantic validation or restoration succeeded.

Unsupported or corrupt records remain listable when the adapter has a stable storage identity or enough safe metadata to form a summary. Delete operates by storage identity and remains available without loading gameplay.

### 5.4 `validateSnapshot` handoff

HPA-498 and HPA-499 do not require a separate `validateSnapshot` call before ordinary load; `restoreSnapshot` already validates atomically and returns the canonical runtime payload. Pure validation remains available to future portable-import or preflight workflows that need validation without changing the active engine. It never becomes a second authority or a prerequisite for every load.

## 6. Save summaries and generation timestamps

All list summaries expose compatible header fields required by city-library and generation UI without loading gameplay:

```ts
export interface SaveHeaderSummary {
  appVersion: string | null;
  snapshotSchemaVersion: number | null;
  summary: SaveEnvelopeSummary | null;
  compatibility: SaveCompatibility;
}

export interface CitySummary extends SaveHeaderSummary {
  cityId: string;
  name: string | null;
  cityCreatedAt: string | null;
  savedAt: string | null;
  pending: boolean;
}

export interface CheckpointSummary extends SaveHeaderSummary {
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
}

export interface AutosaveSummary extends SaveHeaderSummary {
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
}

export interface AutosaveListing {
  items: AutosaveSummary[];
  generationHighWaterMark: number | null;
}
```

For checkpoints and autosaves, `createdAt` is not an independent caller-provided timestamp. The store derives and persists it from `envelope.savedAt` in the same atomic write. Therefore:

```ts
checkpointSummary.createdAt === checkpointEnvelope.savedAt;
autosaveSummary.createdAt === autosaveEnvelope.savedAt;
```

A persisted disagreement is a corrupt record and must not be silently normalized. Rename preserves both values.

Ordering is contractual:

- cities: `savedAt` descending, then `cityId` ascending;
- checkpoints: `createdAt` descending, then `checkpointId` ascending;
- autosaves: `generation` descending, then `autosaveId` ascending.

Missing or unreadable timestamps sort after valid timestamps. Autosave generation is a non-negative safe integer, monotonic per city, and independent of filenames, IndexedDB keys, or array order.

## 7. SaveStore contract

### 7.1 Result and error model

Expected storage failures use typed results rather than host-specific thrown errors.

```ts
export type SaveStoreOperation =
  | "listCities"
  | "readWorkingSave"
  | "writeWorkingSave"
  | "createWorkingSave"
  | "finalizeWorkingSave"
  | "inspectWorkingSaveState"
  | "renameCity"
  | "duplicateCity"
  | "deleteCity"
  | "listCheckpoints"
  | "readCheckpoint"
  | "writeCheckpoint"
  | "renameCheckpoint"
  | "deleteCheckpoint"
  | "listAutosaves"
  | "readAutosave"
  | "writeAutosave"
  | "deleteAutosave";

export type SaveStoreErrorCode =
  | "notFound"
  | "conflict"
  | "incompatibleRecord"
  | "corruptRecord"
  | "quotaExceeded"
  | "permissionDenied"
  | "unavailable"
  | "transactionAborted"
  | "serializationFailed"
  | "ioFailure";

export interface SaveStoreError {
  operation: SaveStoreOperation;
  code: SaveStoreErrorCode;
  cityId?: string;
  recordId?: string;
  retryable: boolean;
  diagnostic: string;
}

export type SaveStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SaveStoreError };
```

Diagnostics are opaque support information and never drive control flow. The Tauri adapter must not expose arbitrary filesystem paths.

### 7.2 Explicit interface

```ts
export interface SaveStore {
  readonly storageIdentity?: StorageIdentity;
  readonly singleRealm?: boolean;

  listCities(): Promise<SaveStoreResult<CitySummary[]>>;

  readWorkingSave(cityId: string): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  createWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  finalizeWorkingSave(
    cityId: string,
  ): Promise<SaveStoreResult<CitySummary>>;
  inspectWorkingSaveState(
    cityId: string,
  ): Promise<SaveStoreResult<WorkingSaveState>>;
  renameCity(cityId: string, name: string): Promise<SaveStoreResult<CitySummary>>;
  duplicateCity(
    sourceCityId: string,
    identity: {
      cityId: string;
      name: string;
      cityCreatedAt: string;
      savedAt: string;
      appVersion: string;
    },
  ): Promise<SaveStoreResult<CitySummary>>;
  deleteCity(cityId: string): Promise<SaveStoreResult<void>>;

  listCheckpoints(cityId: string): Promise<SaveStoreResult<CheckpointSummary[]>>;
  readCheckpoint(
    cityId: string,
    checkpointId: string,
  ): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeCheckpoint(input: {
    checkpointId: string;
    cityId: string;
    name: string;
    note: string | null;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<CheckpointSummary>>;
  renameCheckpoint(
    cityId: string,
    checkpointId: string,
    name: string,
  ): Promise<SaveStoreResult<CheckpointSummary>>;
  deleteCheckpoint(
    cityId: string,
    checkpointId: string,
  ): Promise<SaveStoreResult<void>>;

  listAutosaves(cityId: string): Promise<SaveStoreResult<AutosaveListing>>;
  readAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeAutosave(input: {
    autosaveId: string;
    cityId: string;
    generation: number;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<AutosaveSummary>>;
  deleteAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<void>>;
}
```

Read methods return `UntrustedSaveValue` because adapters provide storage transport, not trust. The envelope inspector establishes the header contract, and Rust validation/restoration establishes gameplay validity.

`storageIdentity` identifies the durable database addressed by an adapter. When
present, adapters targeting the same database MUST expose the same identity so
the runtime can coordinate leases across adapter objects. `singleRealm` is a
separate capability declaration:

- `singleRealm: true` means the adapter guarantees that the durable storage is
  accessed only through one in-memory coordinator registry. The runtime may
  use its exclusive lease to prove that a pending New City record is an orphan
  and may reconcile it by deletion.
- `singleRealm: false` or an omitted value means independent realms/processes
  may access the same storage. An in-memory lease proves nothing about those
  other realms, so bootstrap and ambiguous cleanup MUST preserve pending
  records rather than delete them.

Until durable transaction ownership lands in HPA-539, New City admission is
rejected before any storage mutation for adapters that do not declare
`singleRealm: true`. The typed precondition error is
`multiRealmNewCityUnsupported`; this temporary restriction prevents the
application from creating a pending record it cannot safely repair. A pending
record that already exists on such a store can still be a legacy, mixed-version,
or externally-created record and is not made actionable by Reload alone.

The New City storage lifecycle is intentionally two-phase. `createWorkingSave`
is an atomic create-only operation that commits a pending record. The runtime
calls `finalizeWorkingSave` only after the candidate backend and public runtime
state are ready to publish. `finalizeWorkingSave` atomically changes the record
to active and is idempotent when the record is already active.

```ts
export type WorkingSaveState = "notFound" | "pending" | "active";
```

`inspectWorkingSaveState(cityId)` returns this state from one coherent storage
observation. It is the owner-only reconciliation primitive for ambiguous
`createWorkingSave` and `finalizeWorkingSave` outcomes; it is called directly
by the admitted foreground workflow even after the general persistence lease
starts closing. It does not provide a public repair or ownership mechanism.

### 7.3 ID, key, timestamp, and conflict semantics

IDs are opaque non-empty strings. Workflow services mint them through injected dependencies; `SaveStore` and its adapters never call `crypto.randomUUID()`, read wall-clock time, or auto-allocate gameplay-facing IDs or generations.

Ownership is explicit:

- HPA-345/HPA-346 own city identity generation for new and duplicated cities;
- HPA-351 owns checkpoint identity generation; and
- HPA-352 owns autosave identity and monotonic per-city generation allocation.

Write behavior is fixed:

| Operation | Existing target | Contract |
| --- | --- | --- |
| `writeWorkingSave` | same city ID | atomically replace the committed working save |
| `writeCheckpoint` | same checkpoint ID in that city | fail with `conflict`; checkpoint writes are create-only |
| `writeAutosave` | same autosave ID | fail with `conflict`; autosave writes are create-only |
| `writeAutosave` | generation is reused or not greater than the city's persisted high-water mark | fail with `conflict` |
| `duplicateCity` | target city ID already exists | fail with `conflict` |

Working saves are keyed solely by `envelope.city.id`. An adapter must not maintain a second caller-supplied city key that can diverge from the envelope.

For checkpoint and autosave writes:

- `input.cityId` must exactly equal `input.envelope.city.id`, otherwise the operation fails with `corruptRecord` before any write;
- record `createdAt` is atomically derived from `input.envelope.savedAt`; and
- a storage key or persisted record timestamp that disagrees with its envelope is classified as listable corruption and is never silently repaired.

### 7.4 Persistent autosave generation high-water state

The greatest generation is **not** derived from currently retained autosave records. `SaveStore` persists a separate non-negative safe-integer high-water mark per city.

- A successful `writeAutosave` atomically commits both the new record and the new high-water mark.
- The requested generation must be strictly greater than the persisted high-water mark, or the write fails with `conflict` and changes neither records nor high-water state.
- `deleteAutosave` never lowers or removes the high-water mark.
- Rotation/pruning therefore cannot make a deleted generation reusable.
- `listAutosaves` returns both retained items and the high-water mark through `AutosaveListing`.
- HPA-352 allocates a candidate greater than the returned high-water mark; `writeAutosave` remains the concurrency guard if another producer wins first.
- `deleteCity` removes the city's high-water state with the rest of the city records.
- `duplicateCity` does not copy autosaves or high-water state; the target begins with `generationHighWaterMark: null`.

A failed or interrupted autosave write must not advance the high-water mark without the corresponding committed record.

### 7.5 Rename and duplicate inspection ownership

Both `renameCity(cityId, name)` and `duplicateCity(sourceCityId, identity)` read and rewrite a working envelope internally, so the `SaveStore` implementation owns header inspection for both operations.

For either operation, the store must:

1. read the source working record;
2. run the HPA-498 envelope-header contract;
3. return `incompatibleRecord` for unsupported envelope/snapshot versions;
4. return `corruptRecord` for corrupt headers or declared/embedded schema mismatch; and
5. leave the source unchanged on failure.

`duplicateCity` additionally fails with `conflict` if the target city ID exists and creates an independent target without generations or high-water state. `renameCity` modifies only `city.name` and preserves all other envelope fields.

This is header compatibility only; `SaveStore` does not invoke Rust semantic validation.

In-memory and IndexedDB implementations call the shared TypeScript `inspectSaveEnvelope`. The Tauri managed command enforces the same closed taxonomy and fixture corpus at its Rust boundary; it must not use a divergent permissive parser merely because it cannot import the TypeScript module. The reusable adapter suite verifies equivalent behavior across hosts.

Delete remains different: it operates by storage identity and remains permitted for unsupported or corrupt records.

### 7.6 Operation semantics

- Working-save replacement is atomic from the consumer's perspective. A failed write preserves the previous committed value.
- Duplicate copies only the working save. It does not copy checkpoints, autosaves, or generation high-water metadata.
- Delete city removes the working save, checkpoints, autosaves, and high-water state atomically from the consumer's perspective.
- Rename changes only display-name metadata and preserves save time and snapshot data.
- Checkpoint creation never replaces the working save.
- Loading a checkpoint or autosave does not mutate any stored record.
- Autosave rotation and retention policy are not encoded in `SaveStore`; HPA-352 composes create-only `writeAutosave` and `deleteAutosave` operations using its serialized policy.

`SaveStore.deleteCity` remains host-neutral and does not know runtime activity. The runtime/city-library layer rejects deleting the currently active city until an explicit lifecycle transition loads another city, activates a new city, or detaches the current city and advances the session token.

## 8. In-memory adapter and reusable adapter contract

HPA-498 supplies an in-memory adapter that models committed records independently from caller-owned objects. Values are detached on write and read so tests cannot mutate storage through retained references.

The reusable adapter contract covers:

- deterministic listing and stable tie-breakers;
- working-save replacement and previous-value preservation after injected failure;
- reopen/persistence behavior where applicable;
- rename/duplicate header inspection and equivalent incompatible/corrupt outcomes;
- rename without snapshot, summary, or save-time change;
- duplicate target conflict, identity, timestamp, application-version, and generation isolation;
- city deletion cascading to generations and high-water state;
- checkpoint independence from the working save;
- generation summaries exposing common nullable header fields;
- checkpoint/autosave create-only conflicts;
- autosave ID, generation, and persisted high-water conflicts;
- autosave deletion without high-water rollback;
- envelope/storage-key and createdAt/savedAt consistency failures;
- autosave generation ordering;
- unsupported/corrupt listing and deletion;
- typed not-found, conflict, quota/permission/unavailable, transaction, serialization, and I/O failures; and
- no host-specific exception or environment branch in consumers.

IndexedDB and Tauri adapters run the same suite, with host-specific tests added only for transaction, filesystem, reopen, and crash behavior.

## 9. Coordinator operation contract

### 9.1 Closed operation and result types

Callers await a closed result union; supersession is an outcome, not a persistent error:

```ts
export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave"
  | "loadWorking"
  | "loadCheckpoint"
  | "loadAutosave"
  | "activateNewCity"
  | "detachActiveCity";

export type PersistenceOperationResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: PersistenceCoordinatorError }
  | { status: "superseded" };

export interface SaveWorkingValue {
  summary: CitySummary;
  savedAt: string;
}

export interface RenameActiveCityValue {
  summary: CitySummary;
}

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  source: LoadSource;
}

export interface GenerationWriteValue<TSummary> {
  summary: TSummary;
}
```

The implementation-facing coordinator surface is conceptually:

```ts
export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(
    name: string,
  ): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(
    source: LoadSource,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
}
```

HPA-351 and HPA-352 use a narrower internal gameplay-write capability rather than receiving raw session/revision tokens:

```ts
export type GenerationWriteKind = "checkpoint" | "autosave";
export type GameplayWriteKind = "working" | GenerationWriteKind;

interface GameplayWriteRequest<TSummary> {
  kind: GenerationWriteKind;
  write(
    capture: {
      city: ActiveCityIdentity;
      envelope: WritableSaveEnvelope;
    },
  ): Promise<SaveStoreResult<TSummary>>;
}

interface RuntimeGameplayWriteCoordinator {
  runGameplayWrite<TSummary>(
    request: GameplayWriteRequest<TSummary>,
  ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>>;
}
```

`runGameplayWrite` owns active-city precondition checks, per-city FIFO ordering, canonical capture, session supersession, and public activity state. The callback receives no mutable runtime state and no token it can use to alter dirty bookkeeping.

A `status: "superseded"` result means the request became stale because a newer load/request or runtime lineage won. It never changes the current session's published `error`.

### 9.2 Error taxonomy and preconditions

```ts
export type PersistenceCoordinatorPreconditionError =
  | {
      code: "noActiveCity";
      operation:
        | "saveWorking"
        | "renameActiveCity"
        | "createCheckpoint"
        | "createAutosave";
    }
  | {
      code: "activeCityDeleteRequiresTransition";
      cityId: string;
    }
  | {
      code: "runtimeUnavailable";
      operation: PersistenceCoordinatorOperation;
    };

export type PersistenceCoordinatorBackendError =
  | PersistenceOperationError
  | {
      kind: "host";
      operation: "createSandbox";
      code: "invokeFailed";
      diagnostic: string;
    };

export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceCoordinatorBackendError }
  | { kind: "sandbox"; error: SandboxCreationError }
  | { kind: "precondition"; error: PersistenceCoordinatorPreconditionError };
```

Expected read, compatibility, validation, precondition, and write errors are non-fatal runtime persistence errors. They do not stop the canvas/runtime loop.

A superseded operation is an internal result outcome, not a `PersistenceCoordinatorError`. The original caller can branch on `status` without polluting the current runtime error view.

The typed operation surface is normative; concrete method names may be split by source or workflow, but every async coordinator caller receives exactly this result shape.

## 10. Runtime persistence view and internal state

### 10.1 Public view

The public runtime snapshot exposes only values needed by presentation and policy consumers:

```ts
export interface ActiveCityIdentity {
  id: string;
  name: string;
  cityCreatedAt: string;
}

export type RuntimeSaveStatus =
  | { state: "idle" }
  | {
      state: "queued" | "capturing" | "writing";
      kind: GameplayWriteKind;
      cityId: string;
    };

export type RuntimeLoadStatus =
  | { state: "idle" }
  | { state: "reading" | "restoring"; source: LoadSource };

export type RuntimeLifecycleStatus =
  | { state: "idle" }
  | { state: "creatingCity" | "rollingBack" };

export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lifecycleStatus: RuntimeLifecycleStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}
```

The coordinator keeps session tokens, load/save request tokens, `currentRevision`, and `persistedRevision` internal. HPA-352 consumes narrow dirty/capture capabilities rather than coupling UI to those counters.

Statuses are scoped to the current runtime session. When load, reset, new-city activation, or detach advances the session token, the new session publishes idle status. An old write may still settle internally, but it cannot keep the new city busy or update new-session metadata. Its original operation promise resolves as superseded.

### 10.2 Dirty derivation and monotonic revisions

Internally:

```ts
const dirty = currentRevision !== persistedRevision;
```

Revisions are session-local ordering tokens. They are not gameplay hashes, are not written into Rust snapshots, and do not compare states across sessions.

Increment `currentRevision` only after:

- any normal gameplay dispatch returns `applied: true`, including the bespoke route-draft save path;
- a tick returns `applied: true`; or
- reset successfully replaces authoritative engine state.

Do not increment it for UI changes, previews, gestures, rejected/no-op dispatches, metadata rename, save capture, checkpoint/autosave persistence, successful persistence of an unchanged working revision, or persistence status/error changes.

Backend snapshot installation is factored through shared helpers used by ordinary dispatch, tick, route-draft save, reset, successful load, and future `createSandbox` activation. A successful load/new-city activation resets revision baselines rather than incrementing the previous lineage.

A same-session working-save completion may only move `persistedRevision` forward:

```ts
if (sameCity && sameSession) {
  persistedRevision = Math.max(persistedRevision, capturedRevision);
}
```

Checkpoint and autosave completion never changes `persistedRevision` or `lastSavedAt`, because neither replaces the working save.

New sessions reset both revision values before any old completion can observe them.

### 10.3 Bootstrap and detached runtime

The existing application currently initializes a playable backend snapshot before a city library exists. HPA-499 preserves that startup path:

- runtime may start with `activeCity === null`;
- internal session/revision counters begin at zero;
- applied dispatches/ticks still increment `currentRevision`, so an edited detached session becomes dirty;
- working-save, active-rename, checkpoint, and autosave requests fail with typed `noActiveCity`; and
- no implicit city ID or save target is invented.

HPA-345 later replaces this compatibility startup with the New City/library flow where appropriate. HPA-499 does not forbid a detached runtime from being exercised in existing tests or development builds.

## 11. Existing queue refactor and dead-runtime behavior

The current `queueBackend` is intentionally specialized to `Promise<RuntimeSnapshot>` and resolves `getSnapshot()` when the runtime is dead. HPA-499 must not pass persistence operations through that function as if it were generic.

Instead, factor the serial-chain mechanic into an internal generic primitive with explicit dead and thrown-error branches:

```ts
function enqueueSerialized<T>(options: {
  operation: () => Promise<T>;
  whenDead: () => T;
  onThrown: (error: unknown) => T;
}): Promise<T>;
```

Required behavior:

1. preserve the existing single `gameplayQueue` chain and execution order;
2. check `dead` both before enqueue and again when the operation reaches the head;
3. never invoke the backend after `dead` becomes true;
4. resolve through the caller-supplied `whenDead` result rather than returning a value of the wrong type; and
5. keep the queue chain draining after either fulfilled or rejected operations.

The existing `queueBackend` delegates to `enqueueSerialized` with `whenDead: getSnapshot` and its existing `failBackend` behavior, preserving current gameplay semantics.

Persistence capture/restore/lifecycle operations delegate with:

```ts
whenDead: () => ({
  status: "failed",
  error: {
    kind: "precondition",
    error: { code: "runtimeUnavailable", operation },
  },
})
```

Unexpected thrown backend invocation failures map to the existing typed HPA-341 host failure for the relevant persistence operation; unexpected store failures map to `SaveStoreError`. They never silently resolve a `RuntimeSnapshot` where a persistence result was promised. HPA-499 does not revive an already-dead runtime.

## 12. Per-city persistence queue and gameplay-bearing writes

All active-city storage mutations share one FIFO queue per city:

- working saves;
- checkpoint writes;
- autosave writes; and
- active-city rename.

Exactly one request from this set is active for a city at a time. Requests enter the queue in call order. For gameplay-bearing writes, canonical capture occurs only when the request reaches the head, followed by storage I/O. This makes the recorded timestamp and gameplay snapshot correspond to the actual committed queue position rather than an earlier click while another persistence mutation was still in flight.

The queue is independent from `gameplayQueue`: it serializes persistence requests, while each head operation briefly enters `gameplayQueue` for canonical capture and then releases it during normal storage I/O.

`RuntimeSaveStatus` includes the active gameplay-write kind, so UI and policy consumers never confuse a working save with a checkpoint or autosave. Rename shares FIFO ordering but does not masquerade as a gameplay save status; its operation result remains awaitable by its caller.

HPA-352 may coalesce autosave triggers before they enter this queue. Once admitted, it does not bypass FIFO ordering.

## 13. Working, checkpoint, autosave, and rename flows

### 13.1 Explicit working save

An explicit **Save Now** request writes even when the current and persisted revisions match. This refreshes `savedAt` and provides deterministic user feedback. Autosave policy may skip clean sessions before calling the coordinator.

When the request reaches the per-city queue head:

1. verify the captured city/session is still current;
2. enter `gameplayQueue` through the typed serialized persistence path;
3. call `backend.snapshotForSave()`;
4. capture the canonical snapshot with city identity, internal session token, and current revision;
5. leave `gameplayQueue`;
6. derive summary metadata and build the envelope using injected clock/application-version dependencies;
7. call `SaveStore.writeWorkingSave()`;
8. on success, return `status: "completed"` with the `CitySummary`; and
9. update current-session `lastSavedAt` and `persistedRevision = Math.max(...)` only when city ID and session still match.

A write completion from an earlier city/session returns `status: "superseded"` and cannot update active identity, dirty state, saved timestamp, public status, or error state.

### 13.2 Checkpoint and autosave writes

HPA-351 and HPA-352 call `runGameplayWrite` with kind `checkpoint` or `autosave`. The coordinator performs the same active-city check, FIFO admission, and canonical `snapshotForSave` capture before invoking the workflow-owned store callback.

On successful checkpoint/autosave persistence:

- the operation returns `status: "completed"` with its summary;
- `persistedRevision` does not change;
- `lastSavedAt` does not change;
- dirty state remains exactly as it was before the generation write; and
- a later explicit working save is required to make generation-derived gameplay the working copy.

A stale session returns `status: "superseded"` and does not publish the old result into the new session.

### 13.3 Active-city rename

Active-city rename enters the same per-city persistence queue. The store performs the header inspection described in §7.5.

On successful store rename, the coordinator updates active display name only if city ID and the internal session token still match. The metadata commit applies to the **live** runtime state and UI present when rename completes. It must not replay a `RuntimeSnapshot`, `state`, or `ui` reference captured when rename started, because a concurrent tick or gameplay dispatch may have committed newer gameplay while storage I/O was in flight.

Rename changes only the persistence identity slice, does not alter gameplay revisions or `lastSavedAt`, and returns a typed completed/failed/superseded result.

## 14. Load flow

### 14.1 Common source-aware request

```ts
export type LoadSource =
  | { kind: "working"; cityId: string }
  | { kind: "checkpoint"; cityId: string; checkpointId: string }
  | { kind: "autosave"; cityId: string; autosaveId: string };
```

### 14.2 Steps and result

1. create an internal monotonic load-request token;
2. read the selected `UntrustedSaveValue` outside the gameplay queue;
3. inspect the envelope and reject incompatible headers;
4. enter the typed serialized gameplay queue path;
5. recheck the load token; a later request supersedes this request;
6. capture the canonical pre-load backend snapshot with `snapshotForSave()` plus the runtime's raw paused/running flag, then recheck the load token before mutating the backend;
7. call `backend.restoreSnapshot({ snapshot: envelope.snapshot })`;
8. if typed restoration fails, return `status: "failed"` and leave runtime state/identity unchanged;
9. if restoration throws, restore the captured canonical snapshot and raw paused/running flag before returning failed or superseded;
10. after successful restoration, recheck the request token before any runtime commit. If a newer request won while restoration was in flight, restore the captured canonical snapshot and raw paused/running flag inside the same serialized boundary, publish no stale gameplay/identity state, and return `status: "superseded"`;
11. if either canonical rollback cannot restore coherence, enter fatal/dead runtime state, clear active identity and persistence statuses, and return typed `runtimeUnavailable` to this and all queued operations; and
12. for the still-current successful request, atomically perform one runtime commit:
   - clear hover timers;
   - invalidate route and road preview coordinators;
   - clear active road mutations and pending gesture state;
   - normalize the canonical raw backend result inside the commit helper;
   - replace UI state with `createUiState()`;
   - clear drafts, draft history, selections, notices, previews, gameplay rejections, sandbox reset errors, transient backend persistence errors, and persistence errors;
   - update active-city identity;
   - advance the internal session token;
   - reset current-session save/load/lifecycle status; and
   - publish once.

The returned promise resolves with `status: "completed"` and the same coherent `RuntimeSnapshot`, or `status: "superseded"` if a later load won before or during restoration. A later request that fails during read, inspection, or atomic Rust restoration still supersedes an older in-flight restore; the rollback keeps both runtime and backend on the pre-load city rather than reviving the older candidate.

No intermediate publication may pair old city state with new identity or vice versa.

Every persisted gameplay envelope produced by this contract comes from `snapshotForSave`, which stores `paused = true`. Therefore successful working-save, checkpoint, and autosave loads all enter the board paused. Resuming simulation is an explicit later player action.

### 14.3 Dirty state after load

- Working save: reset the internal revision baseline cleanly.
- Checkpoint or autosave: initialize a dirty baseline because the working save remains unchanged.

The exact counter values are internal. The externally required property is clean working load versus dirty generation load.

## 15. New-city foreground transaction and rollback

### 15.1 Admission behavior

A newly created city becomes active only after its initial working envelope commits successfully.

New City requires a `SaveStore` that declares `singleRealm: true`. For a
multi-realm adapter (`singleRealm: false` or absent), admission is rejected
before `createSandbox`, `createWorkingSave`, or any foreground lease
reservation. The operation returns the typed precondition error
`multiRealmNewCityUnsupported` with the requested city ID; the runtime remains
usable and no durable pending record is created. This is the temporary HPA-539
policy until durable transaction ownership can distinguish the failed realm's
record from another realm's live transaction.

The current `GameBackend.createSandbox` operation replaces backend engine state before returning. HPA-345 therefore performs creation through a coordinator-managed foreground transaction:

1. enter a modal foreground transition;
2. suspend admission of new backend-mutating controller operations;
3. drain work already present in `gameplayQueue`;
4. capture the prior canonical persistence snapshot, prior raw pause/running flag, runtime identity, UI/runtime view, session token, current/persisted revisions, `lastSavedAt`, statuses, and current persistence error;
5. invoke `createSandbox` inside the ordering boundary;
6. obtain the new canonical persistence payload through `snapshotForSave`;
7. write the initial working envelope;
8. on write success, publish and bind the new clean, paused city once; and
9. on write failure, perform transaction-internal rollback before gameplay admission resumes.

While admission is suspended:

- new `tick()` calls are **dropped**, not buffered; each resolves immediately with the current unchanged `RuntimeSnapshot`;
- new controller calls that would dispatch a backend gameplay intent are rejected as no-ops and resolve with the current unchanged `RuntimeSnapshot`;
- local modal/navigation UI may update through the lifecycle status, but board-editing UI is disabled; and
- no tick/dispatch backlog accumulates.

### 15.2 New-city failure taxonomy

New City uses the same exported exhaustive coordinator error contract as every other persistence operation:

- a typed `createSandbox` rejection returns `{ kind: "sandbox", error: SandboxCreationError }` because the host rejected the sandbox request without installing a candidate;
- an unexpected thrown `createSandbox` invocation returns `{ kind: "backend", error: { kind: "host", operation: "createSandbox", code: "invokeFailed", ... } }`;
- typed or thrown `snapshotForSave` failures return `kind: "backend"` through the persistence-operation/host variants;
- clock or envelope construction failures return `kind: "store"` with `createWorkingSave/serializationFailed`; and
- initial working-save failures return `kind: "store"` with the adapter's typed `SaveStoreError`.

Failures after sandbox replacement use the rollback protocol below before their typed result is returned. A typed sandbox rejection does not require backend restoration because `createSandbox` did not install a candidate, but the captured runtime lifecycle view is still restored exactly.

### 15.3 Rollback bookkeeping

Rollback is transaction-internal and does not use ordinary dirty-accounting helpers:

1. call `backend.restoreSnapshot` with the captured prior canonical snapshot;
2. restore the prior raw pause/running flag without counting that internal dispatch as gameplay mutation;
3. restore the captured active identity, session token, revision baselines, `lastSavedAt`, statuses, persistence error, runtime state, and UI exactly; and
4. publish no candidate-city intermediate state.

A failed New City attempt therefore leaves a previously clean city clean and a previously dirty city with the same dirty state and save time it had before the attempt.

### 15.4 Rollback failure

The prior canonical snapshot is expected to restore. If backend restoration or pause-state restoration nevertheless fails, the runtime can no longer prove that backend engine state matches the visible city identity.

This is a fatal backend failure, not a retryable persistence error. The runtime must:

- call the fatal backend path and stop further ticks/dispatches;
- advance/invalidate the internal session token;
- clear active-city identity so no save target remains bound to an uncertain engine;
- reset public persistence activity to idle;
- publish the fatal/unavailable state without presenting the candidate as an active city; and
- require application/runtime rebootstrap before gameplay can continue.

HPA-499 does not attempt to revive this state. Tests inject rollback restore and pause-state failures and assert that no old or candidate city remains saveable through the dead runtime.

### 15.5 Timeout decision

This foreground transaction is the sole case where storage I/O may reserve gameplay admission. The player is already in a modal creation flow.

The contract intentionally does **not** use a generic `Promise.race` timeout. `SaveStore` writes are not currently cancellable; rolling back after a frontend-only timeout while the original write later succeeds could create an orphan city. Adapters must settle known quota, permission, transaction-abort, serialization, and I/O failures as typed results.

If profiling or field evidence reveals genuinely hung host writes, the follow-up must add cancellable/abortable storage semantics and late-success cleanup as one reviewed protocol rather than layering an unsafe timeout over an uncancellable write.

### 15.6 Disposal during New City

`dispose()` may begin at any point while the New City foreground workflow is in flight. The workflow is registered as a foreground lifecycle operation on the persistence lease, so `drainAll` during disposal waits for the entire workflow — not only its eventual store enqueue — before the lease can be released. A replacement runtime's `createGameRuntime` awaits `acquireLease` and therefore cannot proceed until the workflow has settled. The disposal protocol defines the point-of-no-return for each phase:

When disposal has begun, recovery state is still installed internally and the
lease remains pinned when required, but the recovery transition does not render
or notify subscribers. Explicit teardown is silent; the typed
`RuntimeDisposeResult` is the lifecycle owner's notification channel. A live
runtime that has not begun disposal still publishes exactly one terminal
recovery snapshot so the application can render the recovery screen.

- **Before the initial write is admitted.** If disposal occurs before the workflow enqueues its `createWorkingSave`, the workflow observes `dead` at the next check, rolls back any installed candidate backend for coherence, and returns `runtimeUnavailable("activateNewCity")`. No storage mutation is issued.
- **While the initial write is in flight.** The write was enqueued before the lease closed and `drainAll` waits for it. If the write *fails*, the workflow reconciles the ambiguous failure (see below) and returns `runtimeUnavailable`. No orphan is created if the write did not commit.
- **Ambiguous write failure reconciliation.** If `createWorkingSave` throws or returns a non-`conflict` typed failure, the caller cannot know whether the pending record committed before the failure. `conflict` is safe — the atomic create-only contract guarantees no commit on conflict. For all other failures, the workflow calls `inspectWorkingSaveState` to reconcile:
  - `notFound`: the write did not commit — rollback normally with the original error.
  - `pending`: the write committed a pending record — cleanup (delete pending + rollback backend). If the runtime is **alive** (not disposed), restore the prior public runtime, publish, resume previews, and return the **original typed failure** (not `runtimeUnavailable`). The runtime remains usable. If the runtime is **dead** (disposal began), remain terminal — return `runtimeUnavailable` without restoring the public runtime.
  - `active` or `readFailed`: unexpected or unknowable — enter the fatal persistence-recovery state (see below).
- **Late write success (the orphan case).** If the write *succeeds* after disposal began, the candidate city record is committed in storage as a **pending** record even though New City never completed or published success. This is the same late-success orphan condition §15.5 warns about for uncancellable writes, reached via disposal rather than a timeout. The workflow must undo the orphan storage mutation before the lease transfers:
  - roll back the backend to the prior canonical snapshot (coherence);
  - `deleteCity` removes the pending orphan (safe because `createWorkingSave` is atomic create-only — a successful create proves no prior storage existed, so there is no pre-existing record to restore); and
  - return `runtimeUnavailable("activateNewCity")` without publishing a successful result or installing the candidate as the active city.

  The cleanup store call is issued directly on the `SaveStore` (not through `lease.enqueue`, which rejects on the now-closing lease). This is safe because the lease is still exclusively held and the successful city FIFO write has already settled. Cleanup runs inside the admitted foreground operation, so `drainAll` waits for it and the lease is not released until cleanup settles.

- **Finalization.** After `createWorkingSave` succeeds and the runtime is still alive, the workflow calls `finalizeWorkingSave` to flip the pending record to an active city. If finalization fails ambiguously, the workflow calls `inspectWorkingSaveState` to reconcile:
  - `notFound`: unexpected — rollback the backend.
  - `pending`: finalize did not commit — cleanup (delete pending + rollback backend). If the runtime is **alive**, restore the prior public runtime and return the **original typed finalize failure** (not `runtimeUnavailable`). If **dead**, remain terminal.
  - `active`: finalize committed despite the failure — if dead, return `runtimeUnavailable` without deleting (the city is durably active and can be loaded on restart); if alive, proceed to publish success.
  - `readFailed`: enter the fatal persistence-recovery state (see below).
- **Fatal persistence-recovery state (complete terminal transition).** If the backend rollback or the storage delete fails, OR if reconciliation cannot determine the committed state (`readFailed`) or observes an impossible state (`active` after an atomic create-only), the runtime enters a **complete terminal persistence-recovery state** — not merely pinning the lease. The transition:
  - sets `dead = true` (no further gameplay, saves, or controller calls reach the backend or store);
  - stops canvas/preview activity;
  - invalidates session/load ownership (bumps tokens so delayed operations resolve as `runtimeUnavailable`);
  - resets all activity statuses to idle;
  - clears the active-city identity and revision baselines (the candidate backend is never presented as a coherent active city);
  - pins the lease (`leaseStuck`) so `startDrainAndRelease` skips `lease.release()` — a replacement runtime against the same storage identity cannot acquire the lease, so its `createGameRuntime` never resolves;
  - surfaces the recovery reason through `RuntimeSnapshot.recovery` so the application can detect the terminal state without calling `dispose()`;
  - starts drain-and-release (fire-and-forget) so already-admitted work drains and the lease is closed to new work.

  `dispose()` resolves with `recoveryRequired` / `lateSuccessCleanupFailed` and the `cityId`. Safe rebootstrap cannot proceed until the orphan is reconciled out of band. Silently releasing the lease while an orphan remains is not acceptable.

- **Pre-candidate typed failures during disposal.** Branches that fail before a candidate is installed (a thrown or typed-failure prior `snapshotForSave`, or a typed `createSandbox` rejection) do not need a backend rollback, but they must not restore the prior public runtime, restart the canvas, publish, or resume previews once disposal has begun. These branches check `dead` before any public restoration and return `runtimeUnavailable("activateNewCity")` when disposed, mirroring `rollbackNewCity`'s terminal discipline. A thrown `createSandbox` already routes through `rollbackNewCity`, which performs the backend rollback and the same terminal check.

### Pending-then-finalize and bootstrap reconciliation

`createWorkingSave` stores the candidate as a **pending** record — durably committed but not yet finalized as an active city. The runtime MUST call `finalizeWorkingSave` after the New City transaction succeeds (candidate installed, state ready to publish) to flip the record from pending to active. If the runtime crashes, is disposed, or fails before finalization, the pending record remains in storage as a durable marker.

**Ambiguous foreground reconciliation.** After a non-conflict create or finalize
failure, the runtime calls `inspectWorkingSaveState` directly on the admitted
store operation. The single coherent observation classifies `notFound`,
`pending`, and `active` without a `readWorkingSave` plus `listCities` race. A
`pending` result is cleaned up only when the adapter declares `singleRealm:
true`; on a multi-realm adapter the record is preserved and the runtime enters
`multiRealmAmbiguousCleanup` as a defensive terminal state. Current New City
admission prevents this path for new multi-realm transactions, but the state is
retained for legacy, mixed-version, or otherwise bypassed workflows.

**Bootstrap reconciliation.** On every `createGameRuntime`, after acquiring
the exclusive lease, the runtime lists cities and examines pending records.
For `singleRealm: true`, the lease proves that no other realm can own a live
New City transaction, so leftover pending records are deleted before the
replacement runtime proceeds. For `singleRealm: false` or an omitted
capability, bootstrap MUST NOT delete a pending record: the record may belong
to a live transaction in another realm. The runtime pins the lease and rejects
with a typed `BootstrapRecoveryError` whose reason is
`bootstrapReconciliationFailed` and whose `cityId` identifies the retained
record.

This conservative multi-realm state is not repaired by Reload alone. Reload
only creates another coordinator registry and repeats the same ownership
uncertainty, so it can reproduce `bootstrapReconciliationFailed` indefinitely.
The user must close or coordinate all other realms and use an owner-authorized
or manual durable-storage repair, or wait for HPA-539's transaction ownership
protocol. The current application does not expose a repair controller. A
pending record created by the current application cannot arise from New City
on a multi-realm adapter because admission is rejected up front; retained
records are therefore treated as legacy, mixed-version, or external state.

`CitySummary.pending` is a boolean flag indicating whether the city's working-save record is in the pending state. `listCities` includes pending records so the reconciliation pass can find them; production UI that lists loadable cities should filter them out.

## 16. Reset, detach, and active-city deletion

A successful `reset()` keeps the same active city identity but starts a new runtime lineage:

- advance the internal session token;
- reset transient UI through the authoritative-replacement helper;
- set a dirty revision baseline; and
- leave the working save unchanged.

The same revision behavior applies in a detached runtime.

Deleting the active city's storage is rejected until the caller first successfully loads another city, creates/activates another city, or calls `detachActiveCity()`. Detachment is asynchronous and serialized through the gameplay queue: an already-running restore commits first, then detach advances the session token, clears active identity and current-session persistence status, and leaves no working-save target. HPA-346 navigates away from the board before deleting the former city record.

### 16.1 Storage-safe handoff and deletion ordering

A persistence write that completes *after* the caller deletes the former city's storage record recreates that record, even when the write later resolves `superseded` (supersession only suppresses stale state publication; it does not undo a storage mutation that already landed). The coordinator must therefore guarantee that no write for a departed city remains in flight once that city's record may be deleted. This is an explicit ordering requirement, not a consequence of `activeCity` or `sessionToken`:

- **City-switch load.** A `load()` that targets a different city than the one currently active establishes a storage-safe handoff for the former city before the new city becomes active. It fences the former city's persistence admission (new working/checkpoint/autosave/rename writes for it resolve `superseded` at admission) and drains that city's persistence FIFO before the target city's restore commits. Already-admitted writes are allowed to settle to completion; they are not superseded mid-flight.
- **Detach.** `detachActiveCity()` fences the departing city's persistence admission and drains its FIFO before clearing identity, so a delayed write cannot recreate a deleted record. Detach owns **city-scoped** persistence admission only: it does **not** reserve global gameplay admission, so ticks and backend dispatches keep running while detach waits on storage (New City remains the sole foreground transaction where storage I/O may reserve gameplay admission, per §15.5). Detach has deterministic precedence over cross-city loads: every load admitted *after* detach starts resolves `superseded`; loads already in flight are allowed to settle and detach orders after them through the gameplay queue, then invalidates them via the load-token bump in its clearing work. The final active city is therefore `null` regardless of read latency.
- **Caller contract.** HPA-346 may delete a former city's record only after the active identity has moved to another city (via load/new activation) or after `detachActiveCity()` has resolved. The coordinator's fence-and-drain guarantees that, by that point, no write for the former city remains in flight, so deletion is final.

### 16.2 Terminal-aware controller

Once `dispose()` or `failBackend()` sets `dead = true`, the runtime is permanently terminal. All public `RuntimeController` methods check `dead` and short-circuit:

- **`start()`** is a no-op after disposal — the canvas animation loop is not restarted.
- **`isRunning()`** returns `false` after disposal.
- **`tick()`** returns the last snapshot without dispatching to the dead backend.
- **All UI methods** (`setTool`, `resetUi`, `setBuildCategory`, `setRoadPreset`, `setOverlay`, `setHudCategory`, `rotateBuilding`, `setDragCurrent`, `cancelDrag`, `setHoverTile`, route-draft methods, etc.) return the last snapshot without committing, publishing, or notifying subscribers.
- **`commit()` and `publish()`** skip canvas rendering, animation sync, and subscriber notification when `dead` is true, so in-flight async operations that settle after disposal do not produce stale UI updates.
- **`failBackend()`** suppresses terminal snapshot publication when `disposalRequested` is true. A late backend failure from an already-running gameplay operation that settles after `dispose()` began records the error internally, keeps the runtime terminal, and completes ownership draining, but does not render, synchronize animation, or notify subscribers. The typed `RuntimeDisposeResult` is the lifecycle owner's channel during teardown. A live runtime (no disposal requested) still publishes exactly once.
- **Persistence operations** (`saveWorking`, `load`, `activateNewCity`, `detachActiveCity`) already check `dead` and return `runtimeUnavailable`.

`App.svelte`'s `onMount` teardown calls `runtime.dispose()` (not just `runtime.stop()`) so the persistence lease and backend ownership are released and pending gameplay/storage work drains before a replacement runtime can acquire either. A mere `stop()` leaves the runtime alive — the canvas loop can be restarted and pending writes can race a replacement runtime.

### 16.3 Runtime/backend ownership coordination

Runtime replacement coordinates two distinct ownership domains:

1. **Durable storage ownership** — the `SharedPersistenceCoordinator` lease, keyed by `SaveStore.storageIdentity`, serializes runtime lifetimes by durable database. This prevents a replacement runtime from racing an old runtime's pending storage mutations.

2. **Mutable backend-engine ownership** — the `BackendOwnershipCoordinator` lease, keyed by `GameBackend.runtimeIdentity`, serializes runtime lifetimes by backend engine. This prevents a replacement runtime from reading a stale or mid-mutation backend snapshot while the old runtime's backend operations are still in flight.

The Tauri backend is process-global: every `createTauriBackend()` facade invokes commands against one `Mutex<GameEngine>` in the Rust host. Two separate facade objects therefore share one mutable engine, and a persistence-store lease alone cannot serialize runtime lifetimes because:

- a runtime may have no `SaveStore` (no persistence lease at all);
- two stores may address one Tauri engine; and
- separate `createTauriBackend()` facade objects still address the same Rust engine.

The Tauri backend exposes one stable `runtimeIdentity` (`"tauri:process-engine"`) so all facades share one backend ownership coordinator. A WASM backend instance does not expose `runtimeIdentity` — each instance has its own `WasmGameEngine`, so object identity via `WeakMap` is sufficient and correct.

**Acquisition order.** `createGameRuntime` acquires backend ownership BEFORE the initial `backend.snapshot()` and BEFORE the persistence lease. This guarantees that by the time a replacement runtime can read the backend, the old runtime's gameplay operations have drained. Lock acquisition order is deterministic: backend ownership → persistence lease. This prevents lock cycles because no other runtime can hold backend ownership while the old runtime holds it.

**Release order.** `startDrainAndRelease` drains `gameplayQueue` (in-flight backend operations), then `lease.drainAll()` (in-flight persistence/foreground work), then releases the persistence lease, then releases backend ownership. Backend ownership is released LAST so a replacement runtime cannot read the backend until both gameplay and persistence work have settled. When `leaseStuck` is true (fatal persistence-recovery), both the lease and backend ownership are pinned — a replacement runtime's `createGameRuntime` hangs at `backendOwnershipCoordinator.acquire()` before it can read the backend.

**Construction failure.** If `backend.snapshot()` or `coordinator.acquireLease()` throws after backend ownership is acquired, ownership is released through a structured cleanup path so a later runtime can initialize against the same engine.

**Drain ordering safety.** `gameplayQueue.drain()` is awaited before `lease.drainAll()`. This cannot deadlock admitted New City/load workflows:

- `dead = true` is set before `startDrainAndRelease` is called, so no new gameplay operations can be enqueued (the serialized queue's `isDead` gate returns `whenDead` immediately).
- `lease.beginClosing()` rejects new FIFO enqueues and foreground admissions, so no new persistence work can start.
- Already-running gameplay operations (dispatch, tick, restoreSnapshot) drain via `gameplayQueue.drain()`.
- Already-admitted foreground operations and already-enqueued FIFO work drain via `lease.drainAll()`. A foreground operation that needs `gameplayQueue` after `dead = true` gets `whenDead` and short-circuits — it does not wait for the gameplay queue, so there is no circular dependency.

## 17. Performance and animation-frame handoff

HPA-341's measured persistence benchmarks are evidence for scheduling, not a 100 ms frame-budget promise.

- `snapshotForSave` and restoration may run inside the gameplay queue and therefore delay queued ticks while they execute.
- HPA-499 must not invoke save capture directly from the canvas `requestAnimationFrame` callback or other frame-critical rendering code. UI commands and later policy schedule asynchronous save work outside the render call stack.
- HPA-352 consumes measured real-WASM p95 as an autosave scheduling input and verifies that its trigger policy does not create observable main-thread jank.
- If profiling shows unacceptable jank, a worker or host-execution boundary is an evidence-driven follow-up. It is not part of HPA-498/HPA-499 and must not weaken Rust validation.

## 18. Required contract and state-machine tests

Tests cover:

1. **Operation result catalogue:** completed, failed, and superseded outcomes for working save, rename, generation write, and load.
2. **Dead runtime:** persistence operations queued before or after `dead` return typed `runtimeUnavailable`; no backend call occurs and no wrong-shaped `RuntimeSnapshot` escapes.
3. **Mutation during working save:** capture revision 4, apply revision 5 while writing, complete save, remain dirty.
4. **Defensive monotonic helper:** directly exercise stale completion handling so an older captured revision can never move `persistedRevision` backward.
5. **Per-city FIFO:** working, checkpoint, autosave, and rename requests execute in call order with one active persistence mutation per city.
6. **Generation dirty isolation:** checkpoint/autosave success changes neither `persistedRevision` nor `lastSavedAt`.
7. **Clean manual save:** a clean explicit working save still writes and refreshes `savedAt`.
8. **City switch during write:** old-city completion leaves new identity, status, error, save time, and dirty state untouched and resolves superseded.
9. **Generation load during write:** old working write cannot mark a checkpoint-derived session clean.
10. **Rename live-state composition:** rename cannot clobber gameplay committed during storage I/O.
11. **Overlapping load requests:** block the first backend restore, admit a newer request, then release the first; a stale successful restore rolls back before the newer request runs, publishes no stale city, and resolves superseded. Cover newer success, newer failure before restore, newer typed failure during atomic restore, queued detach, and fatal typed unavailability when canonical rollback itself fails.
12. **Queued mutation before load:** the mutation drains before restore and is replaced only when the requested load reaches the queue.
13. **Mutation requested after load enters queue:** restore commits before the later mutation executes against the restored engine.
14. **Write failure:** preserve dirty state, previous working record, active city, and retryable error.
15. **Restore failure:** preserve runtime snapshot, active identity, UI state, and dirty revision.
16. **Detached bootstrap:** gameplay can run without active identity and all gameplay-bearing write operations reject with `noActiveCity`.
17. **Reset lineage:** reset preserves city identity, advances session token, invalidates old writes, and becomes dirty.
18. **Active delete gate:** delete is rejected until load/new activation/detach advances the session.
19. **New-city storage failure:** successful rollback restores prior backend state, pause/running flag, identity, revision baselines, dirty state, save time, statuses, error, and UI exactly.
20. **Rollback failure:** runtime becomes fatal/dead, clears active identity, and cannot save either old or candidate engine state.
21. **Foreground admission:** ticks and backend dispatches during New City are dropped/no-op, resolve current snapshot, and do not accumulate backlog.
22. **Raw restore normalization:** runtime commits `normalizeRustSnapshot` output and later save recaptures from the backend.
23. **Session-scoped status:** old-session writes can settle after load without keeping the new session busy.
24. **Generation timestamp derivation:** checkpoint/autosave `createdAt` equals envelope `savedAt`, and persisted disagreement is listable corruption.
25. **Missing embedded schema:** non-object or missing `snapshot.schemaVersion` fails fast with `embeddedVersion: null` and never calls Rust restore.
26. **Rename/duplicate inspection parity:** memory, IndexedDB, and Tauri return equivalent incompatible/corrupt outcomes from the same fixtures.
27. **Persistent high-water:** pruning autosave records never lowers high-water or permits generation reuse; failed writes do not advance it; delete city removes it; duplicate does not copy it.
28. **Mirrored schema parity:** Rust and TypeScript schema constants, Rust-generated fixture, and host compatibility paths agree.
29. **Paused load:** every working/checkpoint/autosave restore publishes a paused runtime snapshot.
30. **Domain summary types:** envelope summaries use shared domain types and reject unreachable null template IDs.
31. **Multi-realm New City policy:** adapters without `singleRealm: true` reject New City before any storage mutation with a typed capability/precondition error; bootstrap preserves any pre-existing pending record.
32. **Disposal publication:** live terminal recovery publishes once, while recovery discovered after explicit `dispose()` changes internal state and disposal outcome without rendering or notifying subscribers.
33. **Backend ownership — load during replacement:** runtime A blocks in restoration against a shared mutable backend; runtime B construction begins; B cannot take its initial snapshot until A's restoration settles and A is disposed; B's runtime state equals the final shared backend state.
34. **Backend ownership — dispatch during disposal:** runtime A starts a dispatch that blocks before mutating the shared backend; `dispose()` is called; runtime B construction begins; both disposal and B remain pending; the dispatch releases; B initializes from the post-dispatch backend state.
35. **Backend ownership — no-store replacement:** the load-during-replacement and dispatch-during-disposal scenarios repeat with no `SaveStore`; backend ownership alone serializes the runtimes.
36. **Backend ownership — construction failure:** runtime B's initial `backend.snapshot()` throws; backend ownership is released so a later runtime can initialize against the same engine.
37. **Post-disposal backend-failure publication:** a delayed backend dispatch/tick that rejects after `dispose()` began does not notify subscribers or render; disposal settles only after the backend operation settles; a comparable failure without disposal still publishes exactly once.

## 19. File boundaries

### HPA-498 creates or owns

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/runtime/persistence/saveStoreContract.ts`
- `tests/runtime/persistence/envelope.test.ts`
- `tests/runtime/persistence/memorySaveStore.test.ts`

`vite.config.ts` already collects `tests/runtime/**/*.test.ts`; this placement ensures HPA-498 tests run in the existing Node runtime project. `saveStoreContract.ts` is a reusable helper imported by concrete `*.test.ts` adapter suites.

### HPA-499 creates or owns

- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/backendOwnership.ts`
- persistence additions to `src/runtime/types.ts`
- focused integration changes in `src/runtime/createGameRuntime.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- focused runtime integration cases in `tests/runtime/gameRuntime.test.ts`

The coordinator must not become a storage adapter, city-library UI state store, or ID allocator for workflows it does not own.

## 20. Injected dependencies

Deterministic envelope construction receives:

```ts
export interface SaveEnvelopeDependencies {
  now(): string;
  appVersion: string;
}
```

Owning features inject additional factories:

- HPA-345/HPA-346: `nextCityId()`;
- HPA-351: `nextCheckpointId()`; and
- HPA-352: `nextAutosaveId()` plus allocation from `AutosaveListing.generationHighWaterMark`.

Adapters consume already-resolved IDs and envelope timestamps and never generate them. Tests supply deterministic sequences. Production composition may use platform clocks and UUIDs at the application boundary.

## 21. Non-goals

This design does not implement:

- IndexedDB or Tauri filesystem adapters;
- city-library, New City, checkpoint, autosave, recovery, or import/export presentation UI;
- autosave debounce, periodic timing, day-boundary triggers, close handling, coalescing, retry scheduling, rotation, or pruning;
- generic timeout/cancellation for uncancellable SaveStore operations;
- recovery selection;
- schema migration or TypeScript gameplay repair;
- cloud synchronization;
- thumbnails;
- checksum, HMAC, encryption, or tamper-proofing in envelope version 1; or
- worker execution.

HPA-352 owns autosave policy and must use measured persistence performance without weakening Rust validation.

## 22. Verification

HPA-498 runs:

```bash
bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

HPA-499 runs:

```bash
cargo test --workspace
bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

HPA-499 is TypeScript-focused, but `cargo test --workspace` remains a cross-boundary regression gate because the runtime consumes the Rust persistence contract and fixtures. It is not evidence that HPA-499 may change Rust authority semantics.

Final implementation reviews search for:

- direct serialization of normalized `GameState`;
- direct gameplay-state replacement outside runtime/backend boundaries;
- persistence operations incorrectly routed through the old RuntimeSnapshot-only `queueBackend` contract;
- missing dirty bumps on ordinary dispatch, tick, route-draft save, reset, or sandbox activation;
- generation writes incorrectly clearing working dirty state;
- raw `RustGameSnapshot` assignment into runtime `GameState`;
- host branching in `SaveStore` consumers;
- adapter-side ID/time generation;
- high-water values derived only from retained autosave records;
- rename/duplicate implementations that skip the shared compatibility taxonomy;
- independent generation timestamps that can diverge from envelope `savedAt`;
- rollback using normal dirty-accounting helpers;
- public exposure of internal session/request/revision tokens; and
- save calls originating in animation-frame-critical code.

## 23. Dependency handoff

- HPA-343 and HPA-344 depend on HPA-498, not HPA-499.
- HPA-499 depends on HPA-498.
- HPA-345 and HPA-346 require both contracts and runtime coordination through parent HPA-342 or direct child dependencies.
- HPA-351 consumes HPA-498 generation operations and HPA-499 `runGameplayWrite`/source-aware load primitives.
- HPA-352 consumes HPA-498 autosave listing/high-water operations, HPA-499 gameplay-write/dirty primitives, and measured HPA-341 performance evidence.
- HPA-349 remains the end-to-end integration gate.
