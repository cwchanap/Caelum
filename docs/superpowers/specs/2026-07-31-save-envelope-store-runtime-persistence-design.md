# Save Envelope, SaveStore, and Runtime Persistence Design

**Issue:** HPA-342  
**Implementation children:** HPA-498, HPA-499  
**Status:** Approved design, pending written-spec review

## 1. Purpose

Caelum needs one frontend persistence model that works identically in browser and Tauri builds while preserving Rust as the only authority over gameplay restoration.

This design defines two implementation boundaries:

1. **HPA-498** defines the versioned save envelope, compatibility inspection, the host-neutral `SaveStore` contract, typed storage failures, an in-memory adapter, and a reusable adapter contract suite.
2. **HPA-499** integrates save and load operations with `createGameRuntime`, tracks the active city and revision-based dirty state, and guarantees that persistence operations share the existing gameplay ordering boundary.

HPA-342 is a coordination parent. It is complete only when both children are complete and their contracts remain consistent.

## 2. Existing foundation

HPA-340 and HPA-341 already establish the authoritative backend behavior:

- `snapshotForSave()` captures committed Rust state, normalizes only `paused = true`, validates it, and returns a JSON-compatible raw Rust snapshot.
- `restoreSnapshot({ snapshot })` validates and prepares a complete engine before host state is replaced.
- failed restoration leaves backend state unchanged;
- successful restoration returns the canonical raw Rust snapshot after topology recompilation; and
- browser and Tauri expose the same typed persistence result contract.

HPA-342 must consume these operations rather than introducing TypeScript snapshot serialization, repair, migration, or direct state replacement.

`createGameRuntime` already owns the serialized queue used by gameplay dispatch and simulation tick operations. Save capture and restoration must join that queue. A second backend-operation queue would permit save and load operations to race authoritative gameplay mutations.

## 3. Invariants

The implementation must preserve these invariants:

1. Rust gameplay state is authoritative. Host metadata never participates in simulation equality or deterministic continuation.
2. A manual save always uses `backend.snapshotForSave()`.
3. A load never publishes candidate gameplay state before `backend.restoreSnapshot()` succeeds.
4. Failed read, envelope inspection, or restoration leaves the current runtime state and active-city identity unchanged.
5. Browser and Tauri consumers use one `SaveStore` interface and never branch by host.
6. Saving and loading are ordered with gameplay dispatch and tick operations.
7. Storage I/O does not hold the gameplay queue after an authoritative snapshot has been captured.
8. Late asynchronous completions cannot update a newer runtime session.
9. Loading a working save is clean. Loading a checkpoint or autosave is dirty because the working save was not replaced.
10. List compatibility is not semantic gameplay validation. Only Rust restoration establishes that a candidate can run.

## 4. Save envelope

### 4.1 Version 1 shape

```ts
export const CAELUM_SAVE_FORMAT = "caelum-save" as const;
export const SAVE_ENVELOPE_VERSION = 1 as const;

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
  summary: {
    gameMode: "sandbox" | "campaign";
    economyPreset: string;
    sandboxTemplateId: string | null;
  };
  snapshot: TSnapshot;
}

export type WritableSaveEnvelope = SaveEnvelope<RustGameSnapshot>;
export type ReadSaveEnvelope = SaveEnvelope<unknown>;
```

The fixed `format` discriminator prevents arbitrary JSON objects from being confused with Caelum saves. `envelopeVersion` versions host metadata and record structure independently from the Rust snapshot schema.

`appVersion` is informational in version 1. An application-version difference alone does not reject a save. Snapshot compatibility is controlled by the envelope and Rust snapshot schema versions.

The application version is injected into the envelope builder. Persistence modules do not import package metadata directly, which keeps tests deterministic and permits browser and Tauri packaging to supply their resolved version consistently.

### 4.2 Metadata authority

The following are host metadata and are excluded from authoritative gameplay equality:

- city ID and display name;
- city creation and save timestamps;
- application version;
- envelope version;
- duplicated summary fields; and
- checkpoint/autosave record metadata.

The summary is derived from the canonical Rust snapshot at write time. It supports city-library listing without requiring every list operation to restore gameplay. It is advisory and must not override values inside `snapshot`.

Rename changes host metadata only. Duplicate assigns a new city ID, name, and city creation timestamp while preserving the gameplay snapshot exactly.

### 4.3 Record roles remain outside the envelope

The envelope does not identify itself as a working save, checkpoint, or autosave. These are storage roles assigned by `SaveStore`.

This separation allows the same envelope bytes to be used by working saves, generations, and future portable export without embedding host layout or rotation policy into the file format.

## 5. Compatibility inspection

### 5.1 Inspection order

A read candidate is untrusted. The runtime performs these checks before calling Rust restoration:

1. safely inspect the outer value as a plain object;
2. verify the fixed format discriminator;
3. verify a supported envelope version;
4. read the declared snapshot schema version;
5. safely probe `snapshot.schemaVersion` without deeply interpreting the snapshot;
6. reject a declared/embedded schema mismatch; and
7. pass the original snapshot candidate to `backend.restoreSnapshot()`.

Envelope inspection is exception-safe for hostile values, including throwing getters and proxies. It is not an alternate gameplay validator.

### 5.2 Compatibility states

```ts
export type SaveCompatibility =
  | { status: "candidate" }
  | { status: "unsupportedEnvelope"; version: number }
  | { status: "unsupportedSnapshot"; version: number }
  | { status: "corruptHeader" }
  | {
      status: "snapshotVersionMismatch";
      declaredVersion: number;
      embeddedVersion: number | null;
    };
```

`candidate` means only that the safely readable header is compatible with the current frontend contract. It does not mean semantic validation or restoration has succeeded.

Unsupported or corrupt records remain listable when the adapter has a stable storage identity or enough safe metadata to form a summary. Delete operates by storage identity and remains available without loading gameplay.

## 6. Save summaries and generation metadata

```ts
export interface CitySummary {
  cityId: string;
  name: string | null;
  cityCreatedAt: string | null;
  updatedAt: string | null;
  appVersion: string | null;
  snapshotSchemaVersion: number | null;
  summary: SaveEnvelope["summary"] | null;
  compatibility: SaveCompatibility;
}

export interface CheckpointSummary {
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
  compatibility: SaveCompatibility;
}

export interface AutosaveSummary {
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
  compatibility: SaveCompatibility;
}
```

Ordering is contractual:

- cities: `updatedAt` descending, then `cityId` ascending;
- checkpoints: `createdAt` descending, then `checkpointId` ascending;
- autosaves: `generation` descending, then `autosaveId` ascending.

Missing or unreadable timestamps sort after valid timestamps. Autosave generation is monotonic per city and is independent of filenames, IndexedDB keys, or array order.

## 7. SaveStore contract

### 7.1 Result and error model

Expected storage failures use typed results rather than host-specific thrown errors.

```ts
export type SaveStoreOperation =
  | "listCities"
  | "readWorkingSave"
  | "writeWorkingSave"
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
  listCities(): Promise<SaveStoreResult<CitySummary[]>>;

  readWorkingSave(cityId: string): Promise<SaveStoreResult<unknown>>;
  writeWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  renameCity(cityId: string, name: string): Promise<SaveStoreResult<CitySummary>>;
  duplicateCity(
    sourceCityId: string,
    identity: { cityId: string; name: string; cityCreatedAt: string },
  ): Promise<SaveStoreResult<CitySummary>>;
  deleteCity(cityId: string): Promise<SaveStoreResult<void>>;

  listCheckpoints(cityId: string): Promise<SaveStoreResult<CheckpointSummary[]>>;
  readCheckpoint(
    cityId: string,
    checkpointId: string,
  ): Promise<SaveStoreResult<unknown>>;
  writeCheckpoint(input: {
    checkpointId: string;
    cityId: string;
    name: string;
    note: string | null;
    createdAt: string;
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

  listAutosaves(cityId: string): Promise<SaveStoreResult<AutosaveSummary[]>>;
  readAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<unknown>>;
  writeAutosave(input: {
    autosaveId: string;
    cityId: string;
    generation: number;
    createdAt: string;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<AutosaveSummary>>;
  deleteAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<void>>;
}
```

Read methods return `unknown` because adapters provide storage transport, not trust. The runtime envelope inspector establishes the header contract, and Rust restoration establishes gameplay validity.

### 7.3 Operation semantics

- Working-save replacement is atomic from the consumer's perspective. A failed write preserves the previous committed value.
- Duplicate copies only the working save. It does not copy checkpoints or autosaves.
- Duplicate requires a safely compatible record because it must replace envelope city metadata without modifying gameplay.
- Delete city removes the working save and all checkpoints/autosaves atomically from the consumer's perspective.
- Rename changes envelope metadata only and preserves the snapshot value.
- Checkpoint creation never replaces the working save.
- Loading a checkpoint or autosave does not mutate any stored record.
- Autosave rotation and retention policy are not encoded in `SaveStore`; HPA-352 composes `writeAutosave` and `deleteAutosave` using its serialized policy.

All active-city storage mutations are routed through the persistence service's per-city storage queue. Inactive cities have no concurrent gameplay save producer. This avoids adding a persisted compare-and-swap revision to envelope version 1 while still preventing stale metadata or snapshot writes.

## 8. In-memory adapter and adapter contract suite

HPA-498 supplies an in-memory adapter that models committed records independently from caller-owned objects. Values are detached on write and read so tests cannot mutate storage through retained references.

The reusable adapter contract covers:

- deterministic listing and stable tie-breakers;
- working-save replacement and previous-value preservation after injected failure;
- reopen/persistence behavior where applicable;
- rename without snapshot change;
- duplicate identity and generation isolation;
- city deletion cascading to generations;
- checkpoint independence from the working save;
- autosave generation ordering;
- unsupported/corrupt listing and deletion;
- typed not-found, conflict, quota/permission/unavailable, transaction, serialization, and I/O failures; and
- no host-specific exception or environment branch in consumers.

IndexedDB and Tauri adapters must run the same suite, with host-specific tests added only for transaction, filesystem, reopen, and crash behavior.

## 9. Runtime persistence state

HPA-499 adds persistence state to the runtime-facing snapshot:

```ts
export interface ActiveCityIdentity {
  id: string;
  name: string;
  cityCreatedAt: string;
  sessionToken: number;
}

export interface RuntimePersistenceState {
  activeCity: ActiveCityIdentity | null;
  currentRevision: number;
  persistedRevision: number;
  operation: "idle" | "capturing" | "saving" | "loading";
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}
```

Dirty state is derived:

```ts
const dirty = currentRevision !== persistedRevision;
```

Revisions are session-local ordering tokens. They are not gameplay hashes, are not written into Rust snapshots, and do not compare states across sessions.

### 9.1 Revision changes

Increment `currentRevision` only after:

- a dispatch returns `applied: true`;
- a tick returns `applied: true`; or
- reset/new-city creation successfully replaces authoritative engine state.

Do not increment it for:

- UI changes;
- previews or gestures;
- rejected or no-op dispatches;
- metadata rename;
- save capture or successful persistence of an unchanged revision; or
- persistence status/error changes.

Backend snapshot installation is factored through a shared helper so uncommon successful paths such as route-draft saves cannot omit dirty tracking.

### 9.2 Session token

Every successful authoritative state replacement through load or new-city activation advances the session token. Async work captures the token and becomes inert when it no longer matches.

A successful checkpoint or autosave load for the same city still advances the token because it replaces the state lineage and invalidates earlier save completions.

## 10. Queue and coordinator architecture

The persistence coordinator is a focused module, but it does not own an independent backend queue. `createGameRuntime` gives it a narrow capability to schedule authoritative backend operations through the existing gameplay queue.

Conceptually:

```ts
interface RuntimePersistenceHost {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  captureForSave(): Promise<PersistenceSnapshotResult>;
  restoreCandidate(snapshot: unknown): Promise<PersistenceSnapshotResult>;
  commitRestoredSnapshot(snapshot: RustGameSnapshot, identity: LoadIdentity): void;
  readRevisionToken(): RuntimeRevisionToken;
}
```

The concrete API may differ, but the ownership rule is fixed:

- backend dispatch, tick, save capture, and restoration have one total order;
- storage reads and writes happen outside that queue; and
- runtime state is committed only by `createGameRuntime`.

## 11. Working-save flow

1. Verify an active city exists.
2. Enter the gameplay queue.
3. Call `backend.snapshotForSave()`.
4. Capture the canonical snapshot together with city ID, session token, and current revision.
5. Leave the gameplay queue.
6. Derive summary metadata and build the envelope using injected clock, ID/version dependencies, and the active-city identity.
7. Enqueue the write in the active city's storage queue.
8. Call `SaveStore.writeWorkingSave()`.
9. On success, update `lastSavedAt` and advance `persistedRevision` through the captured revision only when city ID and session token still match.
10. If later gameplay has advanced, `currentRevision` remains higher and dirty stays true.

Storage I/O must not freeze simulation progression. A capture at revision N is a coherent save even when gameplay advances to N+1 during the write.

A write completion from an earlier city/session cannot update the new active city, dirty state, saved timestamp, or error state.

## 12. Load flow

### 12.1 Common source-aware request

The coordinator uses one load pipeline with a source discriminator:

```ts
type LoadSource =
  | { kind: "working"; cityId: string }
  | { kind: "checkpoint"; cityId: string; checkpointId: string }
  | { kind: "autosave"; cityId: string; autosaveId: string };
```

### 12.2 Steps

1. Create a monotonic load-request token.
2. Read the selected record outside the gameplay queue.
3. Inspect the envelope and reject incompatible headers.
4. Enter the gameplay queue.
5. Recheck the load token; a later requested load supersedes this request.
6. Call `backend.restoreSnapshot({ snapshot: envelope.snapshot })`.
7. If restoration fails, leave runtime state and active-city identity unchanged.
8. On success, atomically perform one runtime commit:
   - clear hover timers;
   - invalidate route and road preview coordinators;
   - clear active road mutations and pending gesture state;
   - install the normalized canonical snapshot returned by the backend;
   - replace UI state with `createUiState()`;
   - clear drafts, draft history, selections, notices, previews, gameplay rejections, sandbox reset errors, backend errors attributable to transient persistence work, and persistence errors;
   - update active-city identity and advance the session token; and
   - publish once.

No intermediate publication may pair the old city state with the new identity or vice versa.

### 12.3 Dirty state after load

- Working save: reset `currentRevision = 0` and `persistedRevision = 0`.
- Checkpoint or autosave: reset `currentRevision = 1` and `persistedRevision = 0`.

The exact initial numbers are internal. The externally required property is clean working load versus dirty generation load.

## 13. Error ownership

```ts
export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceOperationError }
  | { kind: "superseded" };
```

Expected read, compatibility, validation, and write errors are non-fatal runtime persistence errors. They do not stop the canvas/runtime loop.

HPA-341 already maps backend bridge failures into typed persistence results. HPA-499 does not revive a runtime previously marked dead by an unrelated fatal backend failure.

A superseded operation is generally silent rather than presented as a user error. It exists as an internal typed result for deterministic testing and caller coordination.

## 14. Concurrency cases

Tests must explicitly cover:

1. **Mutation during save:** capture revision 4, apply revision 5 while writing, complete save, remain dirty.
2. **City switch during save:** capture city A, successfully load city B, complete A write, leave B metadata and dirty state untouched.
3. **Generation load during save:** capture working state, load an older checkpoint of the same city, complete old save, do not mark the checkpoint-derived session clean.
4. **Overlapping load requests:** request A, request B, A read finishes last; only B may restore.
5. **Queued mutation before load:** mutation drains before restore and is replaced by the selected save only after the user-requested load reaches the queue.
6. **Mutation requested after load entered queue:** restore commits before the later mutation executes against the restored engine.
7. **Write failure:** preserve dirty state, previous working record, active city, and retryable error.
8. **Restore failure:** preserve runtime snapshot, active identity, UI state, and dirty revision.

## 15. File boundaries

### HPA-498 creates or owns

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/persistence/saveStoreContract.ts`
- `tests/persistence/envelope.test.ts`
- `tests/persistence/memorySaveStore.test.ts`

Names may be adjusted to existing repository conventions, but envelope/store code must not be placed inside browser or Tauri adapters.

### HPA-499 creates or owns

- `src/runtime/persistenceCoordinator.ts`
- persistence additions to `src/runtime/types.ts`
- focused integration changes in `src/runtime/createGameRuntime.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- focused runtime integration cases in `tests/runtime/gameRuntime.test.ts`

The coordinator must not become a storage adapter or presentation-state store.

## 16. Non-goals

This design does not implement:

- IndexedDB or Tauri filesystem adapters;
- city-library, New City, checkpoint, autosave, recovery, or import/export UI;
- autosave debounce, periodic timing, day-boundary triggers, close handling, coalescing, retry scheduling, rotation, or pruning;
- recovery selection;
- schema migration or TypeScript gameplay repair;
- cloud synchronization;
- thumbnails; or
- worker execution.

HPA-352 owns autosave policy and must use measured persistence performance without weakening Rust validation.

## 17. Verification

HPA-498 runs:

```bash
bun run check
bun run format:check
bunx vitest run --project runtime tests/persistence
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

The final implementation reviews must search for direct serialization of normalized `GameState`, direct gameplay-state replacement outside the runtime/backend boundaries, and host branching in `SaveStore` consumers.

## 18. Dependency handoff

- HPA-343 and HPA-344 depend on HPA-498, not HPA-499.
- HPA-499 depends on HPA-498.
- HPA-345 and HPA-346 require both contracts and runtime coordination through parent HPA-342 or direct child dependencies.
- HPA-351 and HPA-352 consume the generation APIs defined by HPA-498 and the source-aware load/dirty primitives defined by HPA-499.
- HPA-349 remains the end-to-end integration gate.
