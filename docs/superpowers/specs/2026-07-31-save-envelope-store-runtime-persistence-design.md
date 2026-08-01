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

`createGameRuntime` already owns the serialized queue used by gameplay dispatch and simulation tick operations. Save capture and restoration join that queue. A second backend-operation queue would permit save and load operations to race authoritative gameplay mutations.

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
9. Loading a working save is clean. Loading a checkpoint or autosave is dirty because the working save was not replaced.
10. List compatibility is not semantic gameplay validation. Only Rust validation/restoration establishes that a candidate gameplay snapshot is valid.
11. Raw `RustGameSnapshot` values are normalized only while committing a runtime view; normalized `GameState` is never reused as a persistence payload.
12. Storage adapters do not mint IDs, timestamps, or generation numbers and do not silently repair malformed records.

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
export type InspectedSaveEnvelope = SaveEnvelope<unknown>;
export type UntrustedSaveValue = unknown;
```

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

### 5.1 Supported-version source

The inspector imports `SNAPSHOT_SCHEMA_VERSION` from the shared domain contract. Envelope version 1 initially supports exactly:

```ts
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = new Set<number>([
  SNAPSHOT_SCHEMA_VERSION,
]);
```

With the current repository contract, this set is `{4}`. Implementations must not copy a private numeric literal into adapters. Future support for additional snapshot schemas changes the shared set and its tests deliberately.

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
  summary: SaveEnvelope["summary"] | null;
  compatibility: SaveCompatibility;
}

export interface CitySummary extends SaveHeaderSummary {
  cityId: string;
  name: string | null;
  cityCreatedAt: string | null;
  savedAt: string | null;
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

  readWorkingSave(cityId: string): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
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

  listAutosaves(cityId: string): Promise<SaveStoreResult<AutosaveSummary[]>>;
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
| `writeAutosave` | generation is reused or not greater than the city's greatest committed generation | fail with `conflict` |
| `duplicateCity` | target city ID already exists | fail with `conflict` |

Working saves are keyed solely by `envelope.city.id`. An adapter must not maintain a second caller-supplied city key that can diverge from the envelope.

For checkpoint and autosave writes:

- `input.cityId` must exactly equal `input.envelope.city.id`, otherwise the operation fails with `corruptRecord` before any write;
- record `createdAt` is atomically derived from `input.envelope.savedAt`; and
- a storage key or persisted record timestamp that disagrees with its envelope is classified as listable corruption and is never silently repaired.

### 7.4 Duplicate inspection ownership

`duplicateCity(sourceCityId, identity)` reads the source internally, so the `SaveStore` implementation owns header inspection for this operation. It must:

1. read the source working record;
2. run the HPA-498 envelope-header contract;
3. return `incompatibleRecord` for unsupported envelope/snapshot versions;
4. return `corruptRecord` for corrupt headers or declared/embedded schema mismatch;
5. fail with `conflict` if the target city ID already exists; and
6. create the independent target record without modifying the source.

This is header compatibility only; `SaveStore` does not invoke Rust semantic validation.

In-memory and IndexedDB implementations call the shared TypeScript `inspectSaveEnvelope`. The Tauri managed command enforces the same closed taxonomy and fixture corpus at its Rust boundary; it must not use a divergent permissive parser merely because it cannot import the TypeScript module. The reusable adapter suite verifies equivalent behavior across hosts.

### 7.5 Operation semantics

- Working-save replacement is atomic from the consumer's perspective. A failed write preserves the previous committed value.
- Duplicate copies only the working save. It does not copy checkpoints, autosaves, or generation high-water metadata.
- Delete city removes the working save and all checkpoints/autosaves atomically from the consumer's perspective.
- Rename changes only display-name metadata and preserves save time and snapshot data.
- Checkpoint creation never replaces the working save.
- Loading a checkpoint or autosave does not mutate any stored record.
- Autosave rotation and retention policy are not encoded in `SaveStore`; HPA-352 composes create-only `writeAutosave` and `deleteAutosave` operations using its serialized policy.

The runtime persistence coordinator owns active-city working writes and active-city rename so both use one per-city storage queue. City-library operations on inactive cities may call `SaveStore` directly because inactive cities have no gameplay save producer.

`SaveStore.deleteCity` remains host-neutral and does not know runtime activity. The runtime/city-library layer rejects deleting the currently active city until an explicit lifecycle transition loads another city, activates a new city, or detaches the current city and advances the session token.

## 8. In-memory adapter and reusable adapter contract

HPA-498 supplies an in-memory adapter that models committed records independently from caller-owned objects. Values are detached on write and read so tests cannot mutate storage through retained references.

The reusable adapter contract covers:

- deterministic listing and stable tie-breakers;
- working-save replacement and previous-value preservation after injected failure;
- reopen/persistence behavior where applicable;
- rename without snapshot, summary, or save-time change;
- duplicate header inspection, target conflict, identity, timestamp, application-version, and generation isolation;
- city deletion cascading to generations;
- checkpoint independence from the working save;
- generation summaries exposing common nullable header fields;
- checkpoint/autosave create-only conflicts;
- autosave ID and monotonic-generation conflicts;
- envelope/storage-key and createdAt/savedAt consistency failures;
- autosave generation ordering;
- unsupported/corrupt listing and deletion;
- typed not-found, conflict, quota/permission/unavailable, transaction, serialization, and I/O failures; and
- no host-specific exception or environment branch in consumers.

IndexedDB and Tauri adapters run the same suite, with host-specific tests added only for transaction, filesystem, reopen, and crash behavior.

## 9. Runtime persistence state and lifecycle

### 9.1 Published view and internal tokens

The public runtime snapshot exposes only values needed by presentation and policy consumers:

```ts
export interface ActiveCityIdentity {
  id: string;
  name: string;
  cityCreatedAt: string;
}

export type RuntimeSaveStatus =
  | { state: "idle" }
  | { state: "capturing" | "writing"; cityId: string };

export type RuntimeLoadStatus =
  | { state: "idle" }
  | { state: "reading" | "restoring"; source: LoadSource };

export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}
```

The coordinator keeps `sessionToken`, load-request tokens, save-request tokens, `currentRevision`, and `persistedRevision` internal. HPA-352 consumes narrow dirty/capture capabilities rather than coupling UI to those counters.

Statuses are scoped to the current runtime session. When load, reset, new-city activation, or detach advances the session token, the new session publishes idle status. An old write may still settle internally, but it cannot keep the new city busy or update new-session metadata. Its original operation promise resolves as superseded.

### 9.2 Dirty derivation and monotonic revisions

Internally:

```ts
const dirty = currentRevision !== persistedRevision;
```

Revisions are session-local ordering tokens. They are not gameplay hashes, are not written into Rust snapshots, and do not compare states across sessions.

Increment `currentRevision` only after:

- any gameplay dispatch returns `applied: true`, including the bespoke route-draft save path;
- a tick returns `applied: true`; or
- reset successfully replaces authoritative engine state.

Do not increment it for UI changes, previews, gestures, rejected/no-op dispatches, metadata rename, save capture, successful persistence of an unchanged revision, or persistence status/error changes.

Backend snapshot installation is factored through shared helpers used by ordinary dispatch, tick, route-draft save, reset, successful load, and future `createSandbox` activation. A successful load/new-city activation resets revision baselines rather than incrementing the previous lineage.

A same-session save completion may only move `persistedRevision` forward:

```ts
if (sameCity && sameSession) {
  persistedRevision = Math.max(persistedRevision, capturedRevision);
}
```

It never decreases `persistedRevision`. New sessions reset both revision values before any old completion can observe them.

### 9.3 Bootstrap and detached runtime

The existing application currently initializes a playable backend snapshot before a city library exists. HPA-499 preserves that startup path:

- runtime may start with `activeCity === null`;
- internal session/revision counters begin at zero;
- applied dispatches/ticks still increment `currentRevision`, so an edited detached session becomes dirty;
- working-save and active-rename requests fail with typed `noActiveCity`; and
- no implicit city ID or save target is invented.

HPA-345 later replaces this compatibility startup with the New City/library flow where appropriate. HPA-499 does not forbid a detached runtime from being exercised in existing tests or development builds.

### 9.4 New-city activation and the foreground exception

A newly created city becomes active only after its initial working envelope commits successfully. On success the runtime advances its session token, publishes the created canonical snapshot and clean UI once, binds the new identity, and resets the revision baseline cleanly.

The current `GameBackend.createSandbox` operation replaces backend engine state before returning. HPA-345 therefore performs creation through a coordinator-managed foreground transaction:

1. enter a modal foreground transition that suspends new gameplay dispatch/tick admission and drains already queued work;
2. capture the prior canonical persistence snapshot plus the prior raw pause/running flag and runtime identity;
3. invoke `createSandbox` inside the gameplay ordering boundary;
4. obtain the new canonical persistence payload through `snapshotForSave`;
5. write the initial working envelope;
6. on write success, publish and bind the new clean city once; and
7. on write failure, restore the prior canonical snapshot, restore its prior pause/running flag, and leave the prior runtime/identity visible before gameplay admission resumes.

This foreground transaction is the sole case where storage I/O may reserve gameplay admission. The player is already in a modal creation flow, and no tick/dispatch backlog is allowed to accumulate while admission is suspended.

The contract intentionally does **not** use a generic `Promise.race` timeout. `SaveStore` writes are not currently cancellable; rolling back after a frontend-only timeout while the original write later succeeds could create an orphan city. Adapters must settle known quota, permission, transaction-abort, serialization, and I/O failures as typed results. If profiling or field evidence reveals genuinely hung host writes, the follow-up must add cancellable/abortable storage semantics and late-success cleanup as one reviewed protocol rather than layering an unsafe timeout over an uncancellable write.

### 9.5 Reset and active-city deletion

A successful `reset()` keeps the same active city identity but starts a new runtime lineage:

- advance the internal session token;
- reset transient UI through the authoritative-replacement helper;
- set a dirty revision baseline; and
- leave the working save unchanged.

The same revision behavior applies in a detached runtime.

Deleting the active city's storage is rejected until the caller first successfully loads another city, creates/activates another city, or calls `detachActiveCity()`. Detachment advances the session token, clears active identity and current-session persistence status, and leaves no working-save target. HPA-346 navigates away from the board before deleting the former city record. A stale write from the prior token is inert.

## 10. Queue, normalization, and coordinator boundaries

The persistence coordinator is a focused module but does not own an independent backend queue. `createGameRuntime` gives it a narrow capability to schedule authoritative backend operations through the existing gameplay queue.

Conceptually:

```ts
interface RuntimePersistenceHost {
  runSerialized<T>(operation: () => Promise<T>): Promise<T>;
  captureForSave(): Promise<PersistenceSnapshotResult>;
  restoreCandidate(snapshot: unknown): Promise<PersistenceSnapshotResult>;
  commitRestoredSnapshot(
    snapshot: RustGameSnapshot,
    identity: ActiveCityIdentity,
    source: LoadSource,
  ): RuntimeSnapshot;
  readRevisionToken(): RuntimeRevisionToken;
}
```

The concrete API may differ, but ownership rules are fixed:

- backend dispatch, tick, save capture, sandbox creation, reset, and restoration have one total order;
- normal storage reads/writes happen outside that queue after capture;
- only `createGameRuntime` commits authoritative runtime state;
- `commitRestoredSnapshot` calls `normalizeRustSnapshot(snapshot)` internally before assigning `state`;
- the coordinator never publishes or stores a raw snapshot as `GameState`; and
- any later save starts again at `backend.snapshotForSave()` rather than serializing the normalized runtime view.

## 11. Working-save, capture, and rename flows

### 11.1 Explicit manual save

An explicit **Save Now** request writes even when the current and persisted revisions match. This refreshes `savedAt` and provides deterministic user feedback. Autosave policy may skip clean sessions before calling the coordinator.

Each save request:

1. verifies an active city exists;
2. enters the gameplay queue;
3. calls `backend.snapshotForSave()`;
4. captures the canonical snapshot with city ID, internal session token, current revision, and a monotonic save-request token;
5. leaves the gameplay queue;
6. derives summary metadata and builds the envelope using injected clock/application-version dependencies and active-city identity;
7. enqueues the write by capture order in the city's FIFO storage queue;
8. calls `SaveStore.writeWorkingSave()` when that request reaches the head; and
9. on success, updates current-session `lastSavedAt` and advances `persistedRevision` with `Math.max` only when city ID and session token still match.

Captures are ordered by the gameplay queue. Writes are ordered by capture token. Exactly one `SaveStore.writeWorkingSave` call is active per city; additional manual requests wait rather than conflict or overwrite out of order. HPA-352 may coalesce autosave triggers before invoking the coordinator, but it does not weaken this queue.

Storage I/O does not freeze ordinary simulation progression. A capture at revision N is coherent even when gameplay advances to N+1 during the write. Completion advances persistence only through N, so the runtime remains dirty.

A write completion from an earlier city/session cannot update the new active city, dirty state, saved timestamp, public status, or error state. The old request promise still settles for its original caller.

### 11.2 Shared gameplay-bearing capture

HPA-499 exposes the same canonical capture primitive for HPA-351 checkpoints and HPA-352 autosaves. Those workflows add their own record metadata and IDs, but never serialize `RuntimeSnapshot.state` or call `normalizeRustSnapshot` as a persistence source.

### 11.3 Active-city rename

Active-city rename enters the same per-city storage queue as working writes. On successful store rename, it updates the active display name only if city ID and the internal session token still match.

The metadata commit must apply to the **live** runtime state and UI present when the rename completes. It must not replay a `RuntimeSnapshot`, `state`, or `ui` reference captured when rename started, because a concurrent tick or gameplay dispatch may have committed newer gameplay while storage I/O was in flight. Rename changes only the persistence identity slice, does not alter gameplay revisions or `lastSavedAt`, and publishes a coherent snapshot using the current state/UI.

## 12. Load flow

### 12.1 Common source-aware request

```ts
export type LoadSource =
  | { kind: "working"; cityId: string }
  | { kind: "checkpoint"; cityId: string; checkpointId: string }
  | { kind: "autosave"; cityId: string; autosaveId: string };
```

### 12.2 Steps

1. create an internal monotonic load-request token;
2. read the selected `UntrustedSaveValue` outside the gameplay queue;
3. inspect the envelope and reject incompatible headers;
4. enter the gameplay queue;
5. recheck the load token; a later requested load supersedes this request;
6. call `backend.restoreSnapshot({ snapshot: envelope.snapshot })`;
7. if restoration fails, leave runtime state and active-city identity unchanged; and
8. on success, atomically perform one runtime commit:
   - clear hover timers;
   - invalidate route and road preview coordinators;
   - clear active road mutations and pending gesture state;
   - normalize the canonical raw backend result inside the commit helper;
   - replace UI state with `createUiState()`;
   - clear drafts, draft history, selections, notices, previews, gameplay rejections, sandbox reset errors, transient backend persistence errors, and persistence errors;
   - update active-city identity;
   - advance the internal session token;
   - reset current-session save/load status; and
   - publish once.

No intermediate publication may pair old city state with new identity or vice versa.

Every persisted gameplay envelope produced by this contract comes from `snapshotForSave`, which stores `paused = true`. Therefore successful working-save, checkpoint, and autosave loads all enter the board paused. Resuming simulation is an explicit later player action.

### 12.3 Dirty state after load

- Working save: reset the internal revision baseline cleanly.
- Checkpoint or autosave: initialize a dirty baseline because the working save remains unchanged.

The exact counter values are internal. The externally required property is clean working load versus dirty generation load.

## 13. Error and operation-result ownership

```ts
export type PersistenceCoordinatorPreconditionError =
  | {
      code: "noActiveCity";
      operation: "saveWorking" | "renameActiveCity";
    }
  | {
      code: "activeCityDeleteRequiresTransition";
      cityId: string;
    };

export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceOperationError }
  | { kind: "precondition"; error: PersistenceCoordinatorPreconditionError };
```

Expected read, compatibility, validation, precondition, and write errors are non-fatal runtime persistence errors. They do not stop the canvas/runtime loop.

A superseded operation is an internal operation outcome, not a persistent runtime error. The original caller may observe that its request became stale, but the current session's `error` remains unchanged.

HPA-341 already maps backend bridge failures into typed persistence results. HPA-499 does not revive a runtime previously marked dead by an unrelated fatal backend failure.

## 14. Performance and animation-frame handoff

HPA-341's measured persistence benchmarks are evidence for scheduling, not a 100 ms frame-budget promise.

- `snapshotForSave` and restoration may run inside the gameplay queue and therefore delay queued ticks while they execute.
- HPA-499 must not invoke save capture directly from the canvas `requestAnimationFrame` callback or other frame-critical rendering code. UI commands and later policy schedule asynchronous save work outside the render call stack.
- HPA-352 consumes measured real-WASM p95 as an autosave scheduling input and verifies that its trigger policy does not create observable main-thread jank.
- If profiling shows unacceptable jank, a worker or host-execution boundary is an evidence-driven follow-up. It is not part of HPA-498/HPA-499 and must not weaken Rust validation.

## 15. Required concurrency and state-machine tests

Tests cover:

1. **Mutation during save:** capture revision 4, apply revision 5 while writing, complete save, remain dirty.
2. **Defensive monotonic helper:** directly exercise stale completion handling so an older captured revision can never move `persistedRevision` backward. Correct FIFO writes prevent this ordering in normal operation; the test is a regression tripwire for future alternate producers or refactors.
3. **Multiple manual saves:** captures and writes retain FIFO capture order with one active store write per city.
4. **Clean manual save:** a clean explicit save still writes and refreshes `savedAt`.
5. **City switch during save:** capture city A, successfully load city B, complete A write, leave B metadata, status, error, and dirty state untouched.
6. **Generation load during save:** capture working state, load an older checkpoint of the same city, complete old save, do not mark the checkpoint-derived session clean.
7. **Rename during save:** rename and working write serialize so neither completion reverts the other's metadata or clobbers newer live gameplay state.
8. **Overlapping load requests:** request A, request B, A read finishes last; only B may restore.
9. **Queued mutation before load:** mutation drains before restore and is replaced by the selected save only after the requested load reaches the queue.
10. **Mutation requested after load entered queue:** restore commits before the later mutation executes against the restored engine.
11. **Write failure:** preserve dirty state, previous working record, active city, and retryable error.
12. **Restore failure:** preserve runtime snapshot, active identity, UI state, and dirty revision.
13. **Detached bootstrap:** runtime is playable with no active city, becomes dirty after applied gameplay, and rejects working save without inventing an ID.
14. **Reset lineage:** reset preserves city identity, advances session token, invalidates old writes, and becomes dirty.
15. **Active delete gate:** delete is rejected until load/new activation/detach advances the session.
16. **New-city storage failure:** restore the prior backend/runtime state and create no partial visible city.
17. **Foreground transition admission:** no tick/dispatch backlog accumulates while initial storage/rollback owns the modal transition.
18. **Raw restore normalization:** runtime commits `normalizeRustSnapshot` output and later save recaptures from the backend.
19. **Session-scoped status:** old-session writes can settle after load without keeping the new session busy.
20. **Generation timestamp derivation:** checkpoint/autosave `createdAt` equals envelope `savedAt`, and persisted disagreement is listable corruption.
21. **Missing embedded schema:** non-object or missing `snapshot.schemaVersion` fails fast with `embeddedVersion: null` and never calls Rust restore.
22. **Duplicate inspection parity:** memory, IndexedDB, and Tauri return equivalent incompatible/corrupt outcomes from the same fixtures.
23. **Paused load:** every working/checkpoint/autosave restore publishes a paused runtime snapshot.

## 16. File boundaries

### HPA-498 creates or owns

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/runtime/persistence/saveStoreContract.ts`
- `tests/runtime/persistence/envelope.test.ts`
- `tests/runtime/persistence/memorySaveStore.test.ts`

`vite.config.ts` already collects `tests/runtime/**/*.test.ts`; this placement ensures HPA-498 tests run in the existing Node runtime project. `saveStoreContract.ts` is a reusable helper imported by concrete `*.test.ts` adapter suites.

Names may be adjusted to existing repository conventions, but envelope/store code must not be placed inside browser or Tauri adapters.

### HPA-499 creates or owns

- `src/runtime/persistenceCoordinator.ts`
- persistence additions to `src/runtime/types.ts`
- focused integration changes in `src/runtime/createGameRuntime.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- focused runtime integration cases in `tests/runtime/gameRuntime.test.ts`

The coordinator must not become a storage adapter, city-library UI state store, or ID allocator for workflows it does not own.

## 17. Injected dependencies

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
- HPA-352: `nextAutosaveId()` plus a serialized per-city generation allocator.

Adapters consume already-resolved IDs and envelope timestamps and never generate them. Tests supply deterministic sequences. Production composition may use platform clocks and UUIDs at the application boundary.

## 18. Non-goals

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

## 19. Verification

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
- missing dirty bumps on ordinary dispatch, tick, route-draft save, reset, or sandbox activation;
- raw `RustGameSnapshot` assignment into runtime `GameState`;
- host branching in `SaveStore` consumers;
- adapter-side ID/time generation;
- duplicate implementations that skip the shared compatibility taxonomy;
- independent generation timestamps that can diverge from envelope `savedAt`; and
- save calls originating in animation-frame-critical code.

## 20. Dependency handoff

- HPA-343 and HPA-344 depend on HPA-498, not HPA-499.
- HPA-499 depends on HPA-498.
- HPA-345 and HPA-346 require both contracts and runtime coordination through parent HPA-342 or direct child dependencies.
- HPA-351 consumes HPA-498 generation operations and HPA-499 canonical capture/source-aware load primitives.
- HPA-352 consumes HPA-498 generation operations, HPA-499 capture/dirty primitives, and measured HPA-341 performance evidence.
- HPA-349 remains the end-to-end integration gate.
