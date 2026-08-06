import {
  samePoint,
  type AreaKind,
  type BuildingType,
  type GameplayRejection,
  type Point,
  type RoundaboutSize,
  type Tool,
} from "../domain/types";
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
import {
  cancelDraftRoute,
  applyUiTileClick,
  draftHandleIndexAtPoint as draftHandleIndexAtExactPoint,
} from "../ui/actions";
import {
  canSaveRouteDraft,
  createDraft,
  editDraft,
  isTransientRouteClickError,
  moveWaypoint,
  removeWaypoint,
  reverseRoute,
  resolveStationAtTile,
  resolveStopAtTile,
  selectWaypoint,
  setPattern,
  type RouteDraft,
  type RouteDraftInteractionError,
} from "../ui/routeDraft";
import { axisLockedLine } from "../ui/roadDrag";
import {
  createUiState,
  type RouteDraftCheckpoint,
  type RouteDraftHistory,
  type UiState,
} from "../ui/uiState";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RoadMutation,
  RustGameSnapshot,
  SandboxCreationRequest,
  SandboxResetError,
} from "./backend";
import type {
  SaveStore,
  SaveStoreOperation,
  SaveStoreResult,
} from "../persistence/saveStore";
import {
  buildSaveEnvelope,
  type InspectedSaveEnvelope,
} from "../persistence/envelope";
import {
  compatibilityToEnvelopeError,
  inspectSaveEnvelope,
} from "../persistence/envelopeInspection";
import { createCanvasHost } from "./createCanvasHost";
import { createPreviewCoordinator } from "./previewCoordinator";
import {
  resolveBackendOwnershipCoordinator,
  type BackendOwnership,
} from "./backendOwnership";
import { selectShellState } from "./runtimeSelectors";
import { createSerializedQueue } from "./serializedQueue";
import { normalizeRustSnapshot } from "./snapshotView";
import {
  createSharedPersistenceCoordinator,
  multiRealmNewCityUnsupported,
  noActiveCity,
  readForLoadSource,
  resolvePersistenceCoordinator,
  resolvePersistenceSessionCompletion,
  resolveWorkingSaveCompletion,
  runtimeUnavailable,
  type ActiveCityIdentity,
  type GameplayWriteRequest,
  type GenerationWriteValue,
  type LoadCityValue,
  type LoadSource,
  type NewCityIdentity,
  type PersistenceCoordinatorError,
  type PersistenceLease,
  type PersistenceOperationResult,
  type RuntimeLifecycleStatus,
  type RuntimeLoadStatus,
  type RuntimePersistenceController,
  type RuntimePersistenceView,
  type RuntimeSaveStatus,
  type RenameActiveCityValue,
  type SaveWorkingValue,
  type SharedPersistenceCoordinator,
} from "./persistenceCoordinator";
import type {
  BootstrapRecoveryError,
  RuntimeController,
  RuntimeDisposeResult,
  RuntimeListener,
  RuntimeRecoveryState,
  RuntimeSnapshot,
  RuntimeTestSeam,
} from "./types";

const rotations = [0, 90, 180, 270] as const;
const ROUTE_DRAFT_HISTORY_LIMIT = 100;

function emptyRouteDraftHistory(): RouteDraftHistory {
  return { past: [], future: [] };
}

function checkpointRouteDraft(draft: RouteDraft): RouteDraftCheckpoint {
  return {
    waypointIds: [...draft.waypointIds],
    pattern: draft.pattern,
    selectedIndex: draft.selectedIndex,
    interaction: draft.interaction,
    mode: draft.mode,
    source:
      draft.source.kind === "create" ? { kind: "create" } : { ...draft.source },
  };
}

function restoreRouteDraftCheckpoint(
  draft: RouteDraft,
  checkpoint: RouteDraftCheckpoint,
): RouteDraft {
  return {
    ...draft,
    waypointIds: [...checkpoint.waypointIds],
    pattern: checkpoint.pattern,
    selectedIndex: checkpoint.selectedIndex,
    interaction: checkpoint.interaction,
    mode: checkpoint.mode,
    source:
      checkpoint.source.kind === "create"
        ? { kind: "create" }
        : { ...checkpoint.source },
    generation: draft.generation + 1,
    previewPending: true,
    preview: null,
  };
}

export interface CreateGameRuntimeOptions {
  backend: GameBackend;
  saveStore?: SaveStore;
  now?: () => string;
  appVersion?: string;
  initialCity?: ActiveCityIdentity | null;
  lastSavedAt?: string | null;
  /** Trailing debounce delay for hover-triggered road mutation previews, in
   *  milliseconds. Defaults to 50ms to coalesce rapid pointermove events on
   *  Tauri (IPC round-trip per event). Set to 0 to disable debouncing. */
  hoverPreviewDebounceMs?: number;
}

function nextToolUiState(activeTool: Tool, current = createUiState()) {
  return {
    ...current,
    activeTool,
    selectedNodeKind: null,
    selectedBuilding: null,
    selectedArea: null,
    buildCategory: null,
    buildingRotation: 0 as const,
    routeDraft:
      activeTool === "busRoute" || activeTool === "metroLine"
        ? current.routeDraft
        : null,
    routeDraftHistory: emptyRouteDraftHistory(),
    routeDraftNotice: null,
    routePreviewError:
      activeTool === "busRoute" || activeTool === "metroLine"
        ? current.routePreviewError
        : null,
    routePreviewHostError:
      activeTool === "busRoute" || activeTool === "metroLine"
        ? current.routePreviewHostError
        : null,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeHudCategory: null,
  };
}

function nextAreaUiState(area: AreaKind, current = createUiState()) {
  return {
    ...current,
    activeTool: "area" as const,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    selectedArea: area,
    buildCategory: null,
    buildingRotation: 0 as const,
    routeDraft: null,
    routeDraftHistory: emptyRouteDraftHistory(),
    routeDraftNotice: null,
    routePreviewError: null,
    routePreviewHostError: null,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeHudCategory: null,
  };
}

function nextBuildingUiState(
  selectedBuilding: BuildingType,
  current = createUiState(),
) {
  return {
    ...current,
    activeTool: "inspect" as const,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding,
    selectedArea: null,
    buildCategory: null,
    buildingRotation: 0 as const,
    routeDraft: null,
    routeDraftHistory: emptyRouteDraftHistory(),
    routeDraftNotice: null,
    routePreviewError: null,
    routePreviewHostError: null,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeHudCategory: null,
  };
}

export async function createGameRuntime(
  options: CreateGameRuntimeOptions,
): Promise<RuntimeController & RuntimeTestSeam> {
  const { backend, hoverPreviewDebounceMs = 50, saveStore } = options;
  // P2: Capture adapter metadata exactly once BEFORE acquiring any capability.
  // A throwing `storageIdentity` or `singleRealm` getter after backend
  // ownership or the persistence lease is acquired would leak both
  // capabilities — the construction error propagates without releasing them,
  // and a replacement runtime's `acquire()` / `acquireLease()` hangs forever.
  // Capturing here ensures the getters are invoked at most once, before any
  // lock is held; a throwing getter fails fast before any cleanup is needed.
  const storageIdentity = saveStore?.storageIdentity;
  const singleRealm = saveStore?.singleRealm === true;
  // Acquire exclusive backend ownership BEFORE the initial snapshot. The
  // Tauri backend is process-global (one `Mutex<GameEngine>` shared by every
  // facade), and a replacement runtime that reads `backend.snapshot()` before
  // the old runtime's backend operations have settled can observe a stale or
  // mid-mutation snapshot. The persistence lease alone cannot prevent this
  // because a runtime may have no `SaveStore`, two stores may address one
  // engine, and separate facades share one engine. Backend ownership
  // serializes runtime lifetimes by engine identity, guaranteeing that by the
  // time a replacement runtime can read the backend, the old runtime's
  // gameplay operations have drained.
  //
  // Lock acquisition order is deterministic: backend ownership is acquired
  // BEFORE the persistence lease, and released AFTER the persistence lease.
  // This prevents lock cycles because no other runtime can hold backend
  // ownership while the old runtime holds it.
  //
  // P1: The Tauri backend's `beginRuntime()` atomically increments the Rust
  // host's runtime epoch and returns the authoritative snapshot from the
  // same critical section. The epoch is the cross-reload ownership authority:
  // a webview reload destroys this JavaScript registry but leaves the Rust
  // process and `OwnedEngine` alive. A stale command from the previous realm
  // carries an outdated epoch and is rejected by the Rust host before it can
  // mutate the engine. The JavaScript coordinator remains as the efficient
  // same-realm lifecycle/draining mechanism; the Rust epoch is the
  // cross-reload/process-host correctness boundary.
  const backendOwnershipCoordinator =
    resolveBackendOwnershipCoordinator(backend);
  const backendOwnership: BackendOwnership =
    await backendOwnershipCoordinator.acquire();
  // P2: Protect the entire post-acquisition construction phase with one
  // cleanup scope. An ordinary exception (metadata, configuration, or
  // constructor failure) releases both backend ownership and the persistence
  // lease so a replacement runtime can initialize. An intentional
  // `BootstrapRecoveryError` (leaseStuck) sets `pinRecovery = true` before
  // throwing so the generic catch skips release — the lease is permanently
  // pinned and `startDrainAndRelease` handles the drain.
  let lease: PersistenceLease | null = null;
  let pinRecovery = false;
  let state: ReturnType<typeof normalizeRustSnapshot>;
  try {
    // P1: Use `beginRuntime()` for the atomic epoch + initial snapshot. When
    // the backend does not expose `beginRuntime` (e.g. test mocks), fall back
    // to `snapshot()` with epoch 0 — no epoch verification occurs.
    const session = backend.beginRuntime
      ? await backend.beginRuntime()
      : { runtimeEpoch: 0, snapshot: await backend.snapshot() };
    state = normalizeRustSnapshot(session.snapshot);
    // Resolve the shared persistence coordinator for this store and acquire
    // the exclusive ownership lease. If another runtime still holds the lease
    // for the same storage identity, this waits for its pending writes to
    // drain and the lease to be released. This prevents a replacement runtime
    // from racing an old runtime's pending storage mutations. When no
    // saveStore is configured, a local (unregistered) coordinator is used —
    // persistence operations are all no-ops, so no cross-runtime coordination
    // is needed, but the lease is still acquired for uniform lifecycle code.
    //
    // P2: The pre-captured `storageIdentity` is passed to
    // `resolvePersistenceCoordinator` so the store's getter is NOT re-read
    // here — a stateful or throwing getter after acquisition would leak both
    // capabilities. The resolver's second argument is required, so the
    // captured `undefined` (no identity exposed) is distinguishable from an
    // omitted argument and uses object identity without re-reading.
    const coordinator: SharedPersistenceCoordinator = saveStore
      ? resolvePersistenceCoordinator(saveStore, storageIdentity)
      : createSharedPersistenceCoordinator();
    lease = await coordinator.acquireLease();
    // Durable bootstrap reconciliation (pending-then-finalize): after acquiring
    // the exclusive lease, delete any leftover pending city records from New
    // City transactions that committed their initial `createWorkingSave` write
    // but crashed, were disposed, or failed before `finalizeWorkingSave`. A
    // pending record is a durable marker that survives process restarts; the
    // in-memory lease pin alone does not. Without this reconciliation, a
    // crashed New City would leave an orphan pending record that blocks future
    // creates for the same city ID (createWorkingSave returns `conflict`).
    // Deletion here is safe because a pending record was never finalized — it
    // is not a real city the user can load. If deletion fails for any pending
    // record, the lease is pinned so a replacement runtime cannot proceed
    // while inconsistent storage remains.
    //
    // Cross-realm safety: the in-memory coordinator lease only proves
    // ownership within a single process/registry. A multi-realm adapter
    // (multiple browser tabs, Tauri windows, workers, or processes sharing one
    // durable database) has independent registries, so a pending record
    // observed here may belong to a LIVE New City transaction in another
    // realm. Deleting it would destroy that realm's transaction. Auto-deletion
    // is therefore gated behind `singleRealm` (captured once before
    // acquisition): only adapters that guarantee single-realm access may
    // auto-delete. Multi-realm adapters (singleRealm false/absent) MUST NOT
    // auto-delete — instead, any leftover pending record enters the terminal
    // bootstrap-recovery state so the user reconciles out of band (close or
    // coordinate the other realm, then use owner-authorized or manual
    // durable-storage repair). Reload alone only retries the same ownership
    // check. Durable cross-process ownership (transaction IDs, heartbeat
    // leases, OS-level locks) is the long-term fix tracked separately; until
    // then, multi-realm adapters must not auto-delete.
    let leaseStuck = false;
    let leaseStuckCityId: string | null = null;
    if (saveStore !== undefined) {
      try {
        const listed = await saveStore.listCities();
        if (!listed.ok) {
          if (listed.error.code !== "notFound") {
            // listCities failed — cannot determine if pending orphans exist.
            // Pin the lease so a replacement runtime cannot proceed while
            // potentially inconsistent storage remains unreconciled.
            leaseStuck = true;
          }
        } else {
          const pendingOrphans = listed.value.filter((c) => c.pending);
          if (pendingOrphans.length > 0 && !singleRealm) {
            // Multi-realm adapter: a pending record may belong to a live New
            // City transaction in another realm. The in-memory lease does not
            // prove otherwise. Do NOT delete — enter the terminal
            // bootstrap-recovery state so the user reconciles out of band.
            // Report the first pending city id (if any) for diagnostics.
            leaseStuck = true;
            leaseStuckCityId = pendingOrphans[0].cityId;
          } else if (singleRealm) {
            // Single-realm adapter: the in-memory lease proves no other realm
            // can hold a live transaction, so leftover pending records are
            // orphans from crashed New City transactions. Delete them.
            for (const city of pendingOrphans) {
              try {
                const deleted = await saveStore.deleteCity(city.cityId);
                if (!deleted.ok && deleted.error.code !== "notFound") {
                  leaseStuck = true;
                  leaseStuckCityId = city.cityId;
                }
              } catch {
                leaseStuck = true;
                leaseStuckCityId = city.cityId;
              }
            }
          }
        }
      } catch {
        // listCities threw — cannot determine if pending orphans exist.
        leaseStuck = true;
      }
    }
    // Track the drain-and-release promise so both `failBackend` (fire-and-
    // forget) and `dispose()` (awaited) share one release. Idempotent: the
    // second caller awaits the same promise the first caller started.
    // The lease is marked closing before draining so no new foreground work
    // or FIFO enqueues can be admitted through this lease while disposal
    // waits for already-admitted work to settle.
    let drainAndReleasePromise: Promise<void> | null = null;
    // Fatal persistence-recovery flag: when late-success cleanup of an orphan
    // New City write cannot settle (backend rollback or storage delete fails),
    // OR when bootstrap reconciliation cannot delete a pending orphan, the
    // lease must NOT be released. A replacement runtime against the same
    // storage identity would otherwise acquire the lease and observe or further
    // mutate inconsistent storage. Setting this before `drainAll` resolves
    // makes `startDrainAndRelease` skip `lease.release()`, so the replacement
    // runtime's `createGameRuntime` (which awaits `acquireLease`) never
    // resolves — matching the defined behavior for uncancellable writes that
    // never settle. Safe rebootstrap cannot proceed until the orphan is
    // reconciled out of band.
    //
    // Backend ownership is released AFTER the persistence lease. When
    // `leaseStuck` is true, backend ownership is also pinned — a replacement
    // runtime's `createGameRuntime` awaits `backendOwnershipCoordinator
    // .acquire()` before the initial snapshot, so pinning prevents it from
    // reading a stale or inconsistent backend state.
    //
    // `gameplayQueue.drain()` is awaited BEFORE `lease.drainAll()`. This
    // ordering cannot deadlock admitted New City/load workflows:
    // - `dead = true` is set before `startDrainAndRelease` is called, so no
    //   new gameplay operations can be enqueued (the serialized queue's
    //   `isDead` gate returns `whenDead` immediately).
    // - `lease.beginClosing()` rejects new FIFO enqueues and foreground
    //   admissions, so no new persistence work can start.
    // - Already-running gameplay operations (dispatch, tick, restoreSnapshot)
    //   drain via `gameplayQueue.drain()`.
    // - Already-admitted foreground operations and already-enqueued FIFO work
    //   drain via `lease.drainAll()`. A foreground operation that needs
    //   `gameplayQueue` after `dead = true` gets `whenDead` and short-circuits
    //   — it does not wait for the gameplay queue, so there is no circular
    //   dependency.
    const startDrainAndRelease = (): Promise<void> => {
      if (drainAndReleasePromise !== null) return drainAndReleasePromise;
      // `lease` is non-null by construction — `startDrainAndRelease` is only
      // reachable after the lease is acquired. The non-null assertion is safe
      // because `lease` is assigned exactly once and never reassigned.
      lease!.beginClosing();
      drainAndReleasePromise = gameplayQueue
        .drain()
        .then(() => lease!.drainAll())
        .then(() => {
          if (!leaseStuck) lease!.release();
        })
        .then(() => {
          if (!leaseStuck) backendOwnership.release();
        })
        .catch(() => {
          if (!leaseStuck) {
            lease!.release();
            backendOwnership.release();
          }
        });
      return drainAndReleasePromise;
    };
    let ui = createUiState();
    let backendError: string | null = null;
    let rejection: GameplayRejection | null = null;
    let sandboxResetError: SandboxResetError | null = null;
    const previewCoordinator = createPreviewCoordinator(backend);
    let nextRouteDraftInstanceId = 1;
    const activeRouteSaveTokens = new Set<string>();
    let activeRoadMutation: RoadMutation | null = null;
    let hoverPreviewTimer: ReturnType<typeof setTimeout> | null = null;
    // Preview requests run outside the gameplay queue, so they need their own
    // runtime epoch when a foreground transaction temporarily replaces the
    // backend snapshot. Responses from an older epoch cannot publish into a
    // restored or newly activated runtime.
    let previewRuntimeEpoch = 0;
    // New City reserves public preview-UI admission synchronously, but existing
    // preview work may still settle while already-admitted gameplay and
    // persistence work drain. This flag starts only when that drain is complete
    // and the rollback baseline is captured, keeping both boundaries identical.
    let previewAdmissionSuspended = false;
    let activeCity = options.initialCity ?? null;
    let sessionToken = 0;
    let currentRevision = 0;
    let persistedRevision = 0;
    let saveStatus: RuntimeSaveStatus = { state: "idle" };
    let loadStatus: RuntimeLoadStatus = { state: "idle" };
    let lifecycleStatus: RuntimeLifecycleStatus = { state: "idle" };
    let lastSavedAt = options.lastSavedAt ?? null;
    let loadRequestToken = 0;
    let persistenceError: PersistenceCoordinatorError | null = null;
    // Terminal persistence-recovery state, surfaced through `RuntimeSnapshot.recovery`
    // so the application can detect a dead runtime without calling `dispose()`.
    // Set when bootstrap reconciliation fails (runtime is born terminal) or when
    // a live runtime's late-success cleanup / ambiguous-failure reconciliation
    // enters the fatal persistence-recovery state.
    let recovery: RuntimeRecoveryState = leaseStuck
      ? {
          state: "recoveryRequired",
          reason: "bootstrapReconciliationFailed",
          cityId: leaseStuckCityId,
        }
      : { state: "ok" };
    // Once the backend has failed fatally, no further dispatches or ticks are
    // attempted. `failBackend` sets this; `queueBackend` short-circuits on it so
    // user-initiated intents after a fatal error do not reach a dead backend.
    // Also set when bootstrap reconciliation fails (leaseStuck from pending
    // orphan deletion) — the runtime is immediately terminal and `dispose()`
    // reports `recoveryRequired`.
    let dead = leaseStuck;
    // Foreground New City creation temporarily owns backend admission while its
    // candidate exists only inside the backend. Calls made after the reservation
    // are dropped/superseded instead of joining the serialized queue and
    // observing or mutating that uncommitted candidate.
    let backendAdmissionReserved = false;
    // Detach owns city-scoped persistence admission for the departing city. It
    // does NOT set `backendAdmissionReserved`, so gameplay ticks/dispatches keep
    // running (New City remains the sole foreground admission owner). Detach
    // fences the departing city's persistence admission (new saves for it resolve
    // superseded) and supersedes every load admitted after detach starts, giving
    // detach deterministic precedence over cross-city loads regardless of read
    // latency. `detachAdmissionLoadToken` captures `loadRequestToken` at detach
    // admission; a load whose token is strictly greater was admitted after detach
    // and is superseded. Loads already in flight (token <= the captured value)
    // are allowed to settle and detach orders after them through the gameplay
    // queue.
    let detachReserving = false;
    let detachAdmissionLoadToken = 0;
    // Detach and New City are mutually exclusive lifecycle transitions: both
    // rewrite the active-city identity and the persistence lineage, so letting
    // them run concurrently lets one undo the other's completed result (e.g. a
    // New City rollback restoring a city that detach already cleared). A separate
    // admission guard — distinct from `backendAdmissionReserved` — serializes
    // them: whichever transition acquires it first runs; the other resolves
    // `superseded` at admission. Detach does NOT set `backendAdmissionReserved`
    // (gameplay keeps running during its storage drain), so this guard is the
    // sole mutual-exclusion point between the two lifecycle transitions. A second
    // detach is likewise rejected by this guard.
    let lifecycleTransitionReserved = false;
    // A city undergoing a storage-safe handoff (cross-city load or detach) has its
    // persistence admission fenced: new working/checkpoint/autosave/rename writes
    // for it resolve superseded at admission, while already-admitted writes drain
    // to completion. This prevents a delayed write for a departed city from
    // recreating its storage record after the caller deletes it.
    //
    // Fence ownership is reference-counted so overlapping transitions fencing the
    // same city (e.g. two cross-city loads from city A, or a cross-city load and a
    // detach both fencing A) cannot remove each other's fence. Each transition
    // acquires exactly one lease for its prior city and releases exactly that one
    // lease in its finally; the fence persists until the last lease is released.
    //
    // Fences are owned by the shared coordinator (keyed by storage identity) so
    // they persist across runtime lifetimes. Because the lease is exclusive,
    // only this runtime can modify fences during its lifetime.
    const acquireCityFence = (cityId: string): void => {
      lease!.acquireCityFence(cityId);
    };
    const releaseCityFence = (cityId: string): void => {
      lease!.releaseCityFence(cityId);
    };
    const isCityFenced = (cityId: string): boolean =>
      lease!.isCityFenced(cityId);
    // Component teardown is a one-shot lifecycle request, so unlike transient UI
    // intents it cannot be dropped while New City owns admission. The canvas is
    // halted immediately; full preview cleanup is completed once the transaction
    // leaves its protected backend window.
    let stopRequestedDuringReservation = false;
    const gameplayQueue = createSerializedQueue(() => dead);
    // Per-city persistence FIFOs are owned by the shared coordinator (keyed by
    // storage identity) so they persist across runtime lifetimes. Because the
    // lease is exclusive, only this runtime can enqueue work during its
    // lifetime. See `SharedPersistenceCoordinator` for the ownership model.
    const cityQueues = lease;
    const listeners = new Set<RuntimeListener>();

    const getPersistenceView = (): RuntimePersistenceView => {
      return {
        activeCity,
        dirty: currentRevision !== persistedRevision,
        saveStatus,
        loadStatus,
        lifecycleStatus,
        lastSavedAt,
        error: persistenceError,
      };
    };

    const getSnapshot = (): RuntimeSnapshot => ({
      state,
      ui,
      shell: selectShellState(state, ui, rejection),
      persistence: getPersistenceView(),
      backendError,
      rejection,
      sandboxResetError,
      recovery,
    });

    // The canvas surface, 2D context, and requestAnimationFrame loop live in a
    // dedicated host module. The host reads runtime state through these getters
    // and forwards DOM pointer events back into the controller via callbacks —
    // it never mutates game/UI state directly. `api` is referenced lazily inside
    // the callbacks (the host only invokes them after `mount`/`start`, by which
    // point `api` is initialized), mirroring the prior `frame` -> `api.tick`
    // forward reference.
    const canvasHost = createCanvasHost({
      getState: () => state,
      getUi: () => ui,
      onTick: (deltaSeconds) => {
        void api.tick(deltaSeconds);
      },
      onTileClick: (point) => {
        api.handleTileClick(point);
      },
      onRouteDraftContextMenu: () => {
        if (ui.routeDraft === null) {
          return false;
        }
        api.undoRouteDraft();
        return true;
      },
      onHoverTile: (point) => {
        api.setHoverTile(point);
      },
      onDragStart: (point) => api.startDrag(point).ui.drag !== null,
      onDragCurrent: (point) => {
        api.setDragCurrent(point);
      },
      onDragCommit: () => {
        api.commitDrag();
      },
      onDragCancel: () => {
        api.cancelDrag();
      },
    });

    // Whether the single terminal snapshot has already been delivered to
    // subscribers. `dead` gates all further backend/store mutations and
    // publication of normal snapshots; `terminalPublished` records that the
    // one-shot transition snapshot (recovery/backendError) has already been
    // pushed to listeners. The terminal transition must publish exactly once
    // so App's `setSnapshot` observes the terminal state and renders the shell
    // error screen — `publish()`'s `!dead` guard would otherwise suppress it.
    // Explicit `dispose()` must NOT publish: unmount teardown must not emit a
    // stale UI update, and a runtime that is already terminal (via
    // `failBackend`/`enterLateSuccessCleanupFailure`) has already delivered its
    // terminal snapshot.
    let terminalPublished = false;
    // Set synchronously when `dispose()` begins. Distinguishes a fatal
    // transition on a LIVE runtime (subscriber notification is required so
    // App's `setSnapshot` renders the recovery screen) from a recovery state
    // discovered DURING teardown (no subscriber notification — the typed
    // `RuntimeDisposeResult` is the lifecycle owner's channel). `failBackend`
    // does NOT set this: it is a fatal transition on a live runtime and must
    // publish exactly once (its own `publishTerminalSnapshot` call), after
    // which `terminalPublished` suppresses any later recovery publication.
    let disposalRequested = false;

    const publish = (): RuntimeSnapshot => {
      const snapshot = getSnapshot();
      if (!dead) {
        canvasHost.render();
        canvasHost.syncAnimationLoop();
        for (const listener of listeners) {
          listener(snapshot);
        }
      }

      return snapshot;
    };

    // Deliver the terminal snapshot to subscribers exactly once. Called only
    // from the terminal transitions (`failBackend`,
    // `enterLateSuccessCleanupFailure`) after all terminal state (recovery,
    // backendError, cleared UI, bumped tokens) has been installed and the
    // canvas/preview cleanup has run. Renders one final frame so the cleared
    // preview overlay is drawn, stops the animation loop, notifies every
    // listener with the terminal snapshot, and latches `terminalPublished` so a
    // second transition (or any later `publish()` via a late preview response)
    // cannot re-notify. Idempotent: a runtime that is already terminal-and-
    // published just returns the current snapshot without re-notifying.
    const publishTerminalSnapshot = (): RuntimeSnapshot => {
      if (terminalPublished) return getSnapshot();
      const snapshot = getSnapshot();
      canvasHost.render();
      canvasHost.stop();
      for (const listener of listeners) {
        listener(snapshot);
      }
      terminalPublished = true;
      return snapshot;
    };

    const commit = (nextState = state, nextUi = ui): RuntimeSnapshot => {
      const changed = nextState !== state || nextUi !== ui;
      state = nextState;
      ui = nextUi;

      if (!changed) {
        if (!dead) {
          canvasHost.render();
          canvasHost.syncAnimationLoop();
        }
        return getSnapshot();
      }

      return publish();
    };

    const commitDispatchResult = (
      result: DispatchResult,
      nextUi: UiState,
      preserveStateOnNoop = false,
    ): RuntimeSnapshot => {
      if (result.applied) {
        currentRevision += 1;
      }
      return commit(
        preserveStateOnNoop && !result.applied
          ? state
          : normalizeRustSnapshot(result.snapshot),
        nextUi,
      );
    };

    const clearHoverPreviewTimer = (): void => {
      if (hoverPreviewTimer !== null) {
        clearTimeout(hoverPreviewTimer);
        hoverPreviewTimer = null;
      }
    };

    const stopRuntime = (): void => {
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      activeRoadMutation = null;
      if (canvasHost.isRunning()) canvasHost.stop();
    };

    const stop = (): void => {
      if (backendAdmissionReserved) {
        if (!stopRequestedDuringReservation) {
          stopRequestedDuringReservation = true;
          // Prevent a queued RAF callback or transaction publication from
          // producing more ticks before full preview cleanup is safe.
          canvasHost.stop();
        }
        return;
      }
      stopRuntime();
    };

    const failBackend = (error: unknown): RuntimeSnapshot => {
      backendError = error instanceof Error ? error.message : String(error);
      dead = true;
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      activeRoadMutation = null;
      // Centralize fatal persistence cleanup: invalidate load/session ownership
      // and reset all activity statuses to idle so the terminal snapshot does
      // not report operations that are no longer running. A delayed read or
      // write that later settles sees the bumped tokens and resolves as
      // runtimeUnavailable without publishing a stale status.
      sessionToken += 1;
      loadRequestToken += 1;
      saveStatus = { state: "idle" };
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "idle" };
      persistenceError = null;
      // Fatal shutdown performs the complete cleanup immediately; transaction
      // finalization must not repeat an earlier latched public stop.
      stopRequestedDuringReservation = false;
      stopRuntime();
      // Clear stale preview UI so a fatal error doesn't leave the road preview
      // overlay visible or the route draft stuck at previewPending forever.
      const clearedUi: UiState = {
        ...ui,
        roadMutationPreview: null,
        roadMutationPreviewError: null,
        routeDraft:
          ui.routeDraft === null
            ? ui.routeDraft
            : { ...ui.routeDraft, previewPending: false },
      };
      // Fire-and-forget: close the lease, drain all pending gameplay and
      // persistence work (in-flight backend operations, enqueued FIFO writes,
      // and admitted foreground lifecycle operations), then release the lease
      // and backend ownership so a replacement runtime against the same
      // storage identity and backend engine can acquire them. Neither is
      // released until every in-flight operation has settled, preventing a
      // late write, backend mutation, or foreground result from mutating
      // storage or the backend after a replacement runtime takes over. If an
      // uncancellable store or backend operation never settles, neither is
      // released and a replacement runtime's `createGameRuntime` never
      // resolves — safe rebootstrap cannot proceed.
      void startDrainAndRelease();
      // Install the cleared UI. When disposal has been explicitly requested,
      // a late backend failure must NOT publish a terminal snapshot: the
      // typed `RuntimeDisposeResult` is the lifecycle owner's channel during
      // teardown, not a stale UI update. The runtime remains terminal (dead,
      // backendError recorded), ownership draining proceeds, but no render,
      // animation sync, or subscriber notification occurs. A LIVE runtime
      // (no disposal requested) still publishes exactly once so App's
      // `setSnapshot` observes `backendError` and renders the shell error
      // screen.
      ui = clearedUi;
      return disposalRequested ? getSnapshot() : publishTerminalSnapshot();
    };

    // Map the current `recovery` state to a `RuntimeDisposeResult`. Called
    // after `startDrainAndRelease` settles in both the already-dead and
    // normal disposal paths. When `leaseStuck` is set, `recovery` is always
    // `recoveryRequired` with a typed reason; this maps it directly so new
    // recovery reasons (e.g. `multiRealmAmbiguousCleanup`) are surfaced
    // without needing a parallel branch here.
    const disposeResultFromRecovery = (): RuntimeDisposeResult => {
      if (!leaseStuck || recovery.state !== "recoveryRequired") {
        return { status: "released" };
      }
      const { state: _state, ...details } = recovery;
      return { status: "recoveryRequired", ...details };
    };

    const dispose = async (): Promise<RuntimeDisposeResult> => {
      // Mark disposal synchronously in both branches so any recovery state
      // discovered during the awaited drain (an admitted New City workflow
      // settling ambiguously, or cleanup failing) suppresses subscriber
      // notification — the typed `RuntimeDisposeResult` is the lifecycle
      // owner's channel during teardown, not a late terminal snapshot.
      disposalRequested = true;
      if (dead) {
        // Already fatal: `failBackend` started the drain-and-release, OR
        // bootstrap reconciliation failed and the runtime was born terminal.
        // Await it so the caller knows the lease and backend ownership have
        // been released before creating a replacement runtime.
        await startDrainAndRelease();
        return disposeResultFromRecovery();
      }
      dead = true;
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      activeRoadMutation = null;
      clearHoverPreviewTimer();
      sessionToken += 1;
      loadRequestToken += 1;
      saveStatus = { state: "idle" };
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "idle" };
      persistenceError = null;
      stopRequestedDuringReservation = false;
      stopRuntime();
      // Close the lease, drain all pending gameplay and persistence work
      // (in-flight backend operations, enqueued FIFO writes, and admitted
      // foreground lifecycle operations), then release the lease and backend
      // ownership so a replacement runtime against the same storage identity
      // and backend engine can acquire them. Unlike `failBackend`
      // (fire-and-forget), `dispose` awaits the drain so the caller knows
      // both have been released.
      await startDrainAndRelease();
      return disposeResultFromRecovery();
    };

    const queueBackend = (
      operation: () => Promise<RuntimeSnapshot>,
      onError: (error: unknown) => RuntimeSnapshot = failBackend,
    ): Promise<RuntimeSnapshot> => {
      if (backendAdmissionReserved) return Promise.resolve(getSnapshot());
      const run = gameplayQueue.enqueue({
        operation,
        // The backend is fatally failed; do not attempt further operations.
        // Return the last published snapshot so callers still resolve.
        whenDead: getSnapshot,
        onThrown: onError,
      });
      // Preserve the prior `run.catch(onError)` caller-continuation timing: the
      // queue's tail continuation was registered first, so a following gameplay
      // operation can begin before callers resume from the completed one.
      return run.then((snapshot) => snapshot);
    };

    const enqueueDispatch = (
      intent: GameIntent,
      nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
    ): Promise<RuntimeSnapshot> =>
      queueBackend(async () => {
        const result = await backend.dispatch(intent);
        backendError = null;
        // Preserve a prior rejection on no-op dispatches (applied === false,
        // rejection === null) — otherwise a no-op intent like re-toggling pause
        // would clear a placement rejection the player hasn't dismissed yet.
        // Update only on success (clears) or when a new rejection is present.
        if (result.applied || result.rejection !== null) {
          rejection = result.rejection;
        }
        const resolvedUi =
          typeof nextUi === "function"
            ? nextUi(result.applied, ui)
            : (nextUi ?? ui);
        return commitDispatchResult(result, resolvedUi);
      });

    const enqueueComputedDispatch = (
      getIntent: () => GameIntent | null,
      nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
    ): Promise<RuntimeSnapshot> =>
      queueBackend(async () => {
        const intent = getIntent();
        if (intent === null) {
          return commit(state, ui);
        }
        const result = await backend.dispatch(intent);
        backendError = null;
        if (result.applied || result.rejection !== null) {
          rejection = result.rejection;
        }
        const resolvedUi =
          typeof nextUi === "function"
            ? nextUi(result.applied, ui)
            : (nextUi ?? ui);
        return commitDispatchResult(result, resolvedUi);
      });

    const enqueueTick = (deltaSeconds: number): Promise<RuntimeSnapshot> =>
      queueBackend(async () => {
        const result = await backend.tick(deltaSeconds);
        backendError = null;
        // Ticks never produce gameplay rejections (the Rust engine only rejects
        // dispatch intents, not ticks), so overwriting `rejection` here would
        // clear a placement rejection ~16ms after it was surfaced. Leave
        // `rejection` untouched — it persists until the player dismisses it or a
        // subsequent dispatch sets a new one.
        if (!result.applied) {
          // The engine returned the same snapshot (paused, speed 0, zero-delta).
          // Skip normalizeRustSnapshot so commit's reference-equality check
          // short-circuits — otherwise the fresh spread object forces a publish
          // to every subscriber on every animation frame even when nothing moved.
          return commit(state, ui);
        }
        return commitDispatchResult(result, ui, true);
      });

    const requestRoutePreview = (
      draft: RouteDraft,
      allowWhileSuspended = false,
    ): void => {
      if (dead || (previewAdmissionSuspended && !allowWhileSuspended)) return;
      const { instanceId, generation } = draft;
      const requestRuntimeEpoch = previewRuntimeEpoch;
      const routeId =
        draft.source.kind === "edit" ? draft.source.routeId : null;
      const expectedRevision =
        draft.source.kind === "edit" ? draft.source.expectedRevision : null;
      void previewCoordinator
        .requestRoute({
          mode: draft.mode,
          pattern: draft.pattern,
          waypointIds: draft.waypointIds,
          routeId,
          expectedRevision,
          generation,
        })
        .then((response) => {
          if (requestRuntimeEpoch !== previewRuntimeEpoch) return;
          const current = ui.routeDraft;
          if (
            current === null ||
            current.instanceId !== instanceId ||
            current.generation !== generation
          ) {
            return;
          }
          // A null response means the coordinator invalidated the request
          // (e.g. stop() advanced the epoch). The draft still matches, so clear
          // previewPending to avoid stranding the UI in "Checking route…".
          if (response === null) {
            commit(state, {
              ...ui,
              routeDraft: { ...current, previewPending: false },
            });
            return;
          }
          commit(state, {
            ...ui,
            routeDraft: {
              ...current,
              previewPending: false,
              preview: response,
            },
            // Transient click errors (incompatible/missing node, interaction
            // hint) describe the most recent click, not persistent preview
            // state. Preserve them across preview resolution so the user still
            // sees the click feedback after a pending preview finishes; a
            // subsequent successful generation-stable click clears them.
            // A preview rejection (e.g. `routeChangedWhileEditing`) is
            // persistent and authoritative — it must override the transient
            // error, otherwise a later valid click would clear the transient
            // error and permanently hide the stale-revision rejection (Save
            // disabled, Reload unavailable, "Add at least two waypoints").
            routePreviewError:
              isTransientRouteClickError(ui.routePreviewError) &&
              response.rejection === null
                ? ui.routePreviewError
                : response.rejection,
            routePreviewHostError: null,
          });
        })
        .catch((error: unknown) => {
          if (requestRuntimeEpoch !== previewRuntimeEpoch) return;
          const current = ui.routeDraft;
          if (
            dead ||
            current === null ||
            current.instanceId !== instanceId ||
            current.generation !== generation
          ) {
            return;
          }
          commit(state, {
            ...ui,
            routeDraft: {
              ...current,
              previewPending: false,
            },
            routePreviewHostError:
              error instanceof Error ? error.message : String(error),
          });
        });
    };

    /** Whether a draft transition should trigger a new route preview request.
     *  Preview-relevant changes (waypoint add/remove, pattern flip) bump the
     *  `generation`; selection-only updates keep it. Shared by
     *  `commitRouteDraft` and `handleTileClick` so the preview-request decision
     *  lives in one place rather than two divergent heuristics. */
    const hasPreviewRelevantChange = (
      previous: RouteDraft | null,
      next: RouteDraft | null,
    ): boolean =>
      next !== null &&
      next !== previous &&
      (previous === null || next.generation !== previous.generation);

    const commitRouteDraft = (routeDraft: RouteDraft): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      if (routeDraft === ui.routeDraft) {
        return commit(state, ui);
      }
      const previewRelevantChanged = hasPreviewRelevantChange(
        ui.routeDraft,
        routeDraft,
      );
      const shouldRecordHistory =
        ui.routeDraft !== null && previewRelevantChanged;
      const routeDraftHistory = shouldRecordHistory
        ? {
            past: [
              ...ui.routeDraftHistory.past,
              checkpointRouteDraft(ui.routeDraft!),
            ].slice(-ROUTE_DRAFT_HISTORY_LIMIT),
            future: [],
          }
        : ui.routeDraftHistory;
      // Generation-stable updates preserve host/preview rejections; only clear
      // local transient click errors that a successful selection resolves.
      const routePreviewError = previewRelevantChanged
        ? null
        : isTransientRouteClickError(ui.routePreviewError)
          ? null
          : ui.routePreviewError;
      const routePreviewHostError = previewRelevantChanged
        ? null
        : ui.routePreviewHostError;
      const result = commit(state, {
        ...ui,
        routeDraft,
        routeDraftHistory,
        routeDraftNotice: null,
        routePreviewError,
        routePreviewHostError,
      });
      if (previewRelevantChanged) {
        requestRoutePreview(routeDraft);
      }
      return result;
    };

    const rejectRouteDraftInteraction = (
      error: RouteDraftInteractionError,
    ): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      return commit(state, {
        ...ui,
        routePreviewError: error,
        routePreviewHostError: null,
      });
    };

    const startRouteEdit = (routeId: string): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      const route = state.transit.routes.find(
        (candidate) => candidate.id === routeId,
      );
      const line = state.transit.metroLines.find(
        (candidate) => candidate.id === routeId,
      );
      if (route === undefined && line === undefined) {
        return commit(state, ui);
      }
      if (
        rejection?.code === "routeChangedWhileEditing" &&
        rejection.context.routeId === routeId
      ) {
        rejection = null;
      }
      const routeDraft = editDraft(
        route !== undefined
          ? {
              routeId: route.id,
              expectedRevision: route.revision,
              mode: "bus",
              pattern: route.pattern,
              waypointIds: route.stopIds,
            }
          : {
              routeId: line!.id,
              expectedRevision: line!.revision,
              mode: "metro",
              pattern: line!.pattern,
              waypointIds: line!.stationIds,
            },
        nextRouteDraftInstanceId,
      );
      nextRouteDraftInstanceId += 1;
      // Clear any in-flight road/roundabout preview before entering route
      // editing. Without this, a stale road cost/impact/rejection badge remains
      // visible globally and a late preview response can repopulate it while the
      // route draft is being edited — `invalidateRoadPreview` bumps the
      // coordinator epoch so in-flight responses resolve null and are dropped,
      // and the cleared fields remove the stale overlay.
      invalidateRoadPreview();
      const result = commit(state, {
        ...ui,
        activeTool: route === undefined ? "metroLine" : "busRoute",
        selectedNodeKind: null,
        selectedBuilding: null,
        selectedArea: null,
        buildCategory: null,
        routeDraft,
        routeDraftHistory: emptyRouteDraftHistory(),
        routeDraftNotice: null,
        routePreviewError: null,
        routePreviewHostError: null,
        selectedRouteId: routeId,
        routeFailureFocus: null,
        drag: null,
        roadMutationPreview: null,
        roadMutationPreviewError: null,
      });
      requestRoutePreview(routeDraft);
      return result;
    };

    const saveRouteDraft = async (): Promise<RuntimeSnapshot> => {
      if (backendAdmissionReserved) return getSnapshot();
      const draft = ui.routeDraft;
      if (!draft || !canSaveRouteDraft(draft)) {
        return getSnapshot();
      }
      const token = {
        instanceId: draft.instanceId,
        generation: draft.generation,
        source:
          draft.source.kind === "create"
            ? "create"
            : `edit:${draft.source.routeId}:${draft.source.expectedRevision}`,
      };
      const tokenKey = `${token.instanceId}:${token.generation}:${token.source}`;
      if (activeRouteSaveTokens.has(tokenKey)) {
        return getSnapshot();
      }
      activeRouteSaveTokens.add(tokenKey);
      const intent: GameIntent =
        draft.source.kind === "create"
          ? {
              type: "createRoute",
              mode: draft.mode,
              pattern: draft.pattern,
              waypointIds: draft.waypointIds,
            }
          : {
              type: "updateRoute",
              routeId: draft.source.routeId,
              expectedRevision: draft.source.expectedRevision,
              pattern: draft.pattern,
              waypointIds: draft.waypointIds,
            };
      const isCurrent = (current: RouteDraft | null): boolean => {
        const source =
          current?.source.kind === "create"
            ? "create"
            : current
              ? `edit:${current.source.routeId}:${current.source.expectedRevision}`
              : "none";
        return (
          current !== null &&
          current.instanceId === token.instanceId &&
          current.generation === token.generation &&
          source === token.source
        );
      };
      return queueBackend(
        async () => {
          const result = await backend.dispatch(intent);
          const current = ui.routeDraft;
          const tokenIsCurrent = isCurrent(current);
          if (tokenIsCurrent) {
            backendError = null;
            rejection = result.rejection;
          } else if (result.applied) {
            // A superseded save still succeeded in the backend; clear any prior
            // rejection so a stale failure does not outlive the successful save.
            backendError = null;
            rejection = null;
          }
          if (result.applied && tokenIsCurrent) {
            previewCoordinator.invalidateRoute();
            return commitDispatchResult(result, {
              ...ui,
              routeDraft: null,
              routeDraftHistory: emptyRouteDraftHistory(),
              routeDraftNotice: null,
              routePreviewError: null,
              routePreviewHostError: null,
            });
          }
          // Non-fatal rejection with a current token: surface into the draft
          // panel so the editor does not keep showing a stale "Connected"
          // preview while only the global banner carries the failure.
          if (
            !result.applied &&
            tokenIsCurrent &&
            result.rejection !== null &&
            current !== null
          ) {
            return commitDispatchResult(result, {
              ...ui,
              routePreviewError: result.rejection,
              routePreviewHostError: null,
            });
          }
          // A superseded save changed the snapshot. The current draft's preview
          // was computed against the pre-save snapshot and may carry a stale
          // expected revision (e.g. an edit draft opened before the save bumped
          // the route's revision). Invalidate and re-request so the fresh
          // preview surfaces `routeChangedWhileEditing` instead of leaving Save
          // enabled on a stale revision that the next save would reject.
          if (result.applied && !tokenIsCurrent) {
            previewCoordinator.invalidateRoute();
            if (current !== null) {
              const refreshedDraft: RouteDraft = {
                ...current,
                preview: null,
                previewPending: true,
              };
              const supersededResult = commitDispatchResult(result, {
                ...ui,
                routeDraft: refreshedDraft,
              });
              requestRoutePreview(refreshedDraft);
              return supersededResult;
            }
            return commitDispatchResult(result, ui);
          }
          return commitDispatchResult(result, ui);
        },
        // Superseded-save host errors must not kill the runtime: the user may
        // already be on a replacement draft. A truly dead backend is still
        // caught by the next tick/dispatch failBackend path.
        (error) => {
          if (isCurrent(ui.routeDraft)) {
            return failBackend(error);
          }
          return getSnapshot();
        },
      ).finally(() => {
        activeRouteSaveTokens.delete(tokenKey);
      });
    };

    const cancelRouteDraft = (): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      previewCoordinator.invalidateRoute();
      const cancelledUi = cancelDraftRoute(ui);
      if (
        cancelledUi === ui &&
        ui.routeDraftHistory.past.length === 0 &&
        ui.routeDraftHistory.future.length === 0 &&
        ui.routeDraftNotice === null
      ) {
        return commit(state, ui);
      }
      return commit(state, {
        ...cancelledUi,
        routeDraftHistory: emptyRouteDraftHistory(),
        routeDraftNotice: null,
      });
    };

    const undoRouteDraft = (): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      const draft = ui.routeDraft;
      const checkpoint = ui.routeDraftHistory.past.at(-1);
      if (draft === null || checkpoint === undefined) {
        return commit(state, ui);
      }
      const restored = restoreRouteDraftCheckpoint(draft, checkpoint);
      const nextUi: UiState = {
        ...ui,
        routeDraft: restored,
        routeDraftHistory: {
          past: ui.routeDraftHistory.past.slice(0, -1),
          future: [...ui.routeDraftHistory.future, checkpointRouteDraft(draft)],
        },
        routeDraftNotice: null,
        routePreviewError: null,
        routePreviewHostError: null,
      };
      const snapshot = commit(state, nextUi);
      requestRoutePreview(restored);
      return snapshot;
    };

    const redoRouteDraft = (): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      const draft = ui.routeDraft;
      const checkpoint = ui.routeDraftHistory.future.at(-1);
      if (draft === null || checkpoint === undefined) {
        return commit(state, ui);
      }
      const restored = restoreRouteDraftCheckpoint(draft, checkpoint);
      const nextUi: UiState = {
        ...ui,
        routeDraft: restored,
        routeDraftHistory: {
          past: [
            ...ui.routeDraftHistory.past,
            checkpointRouteDraft(draft),
          ].slice(-ROUTE_DRAFT_HISTORY_LIMIT),
          future: ui.routeDraftHistory.future.slice(0, -1),
        },
        routeDraftNotice: null,
        routePreviewError: null,
        routePreviewHostError: null,
      };
      const snapshot = commit(state, nextUi);
      requestRoutePreview(restored);
      return snapshot;
    };

    const reloadRouteDraft = (): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      const draft = ui.routeDraft;
      if (draft?.source.kind !== "edit") {
        return commit(state, ui);
      }
      const routeId = draft.source.routeId;
      const globalStale =
        rejection?.code === "routeChangedWhileEditing" &&
        rejection.context.routeId === routeId;
      const localStale =
        ui.routePreviewError?.code === "routeChangedWhileEditing" &&
        ui.routePreviewError.context.routeId === routeId;
      if (!globalStale && !localStale) {
        return commit(state, ui);
      }
      if (globalStale) rejection = null;
      // startRouteEdit clears routePreviewError via commit.
      return startRouteEdit(routeId);
    };

    const handleEscape = (): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      return ui.routeDraft === null ? api.resetUi() : cancelRouteDraft();
    };

    const sendRoadMutationPreviewRequest = (
      mutation: RoadMutation,
      generation: number,
      allowWhileSuspended = false,
    ): void => {
      if (dead || (previewAdmissionSuspended && !allowWhileSuspended)) return;
      const requestRuntimeEpoch = previewRuntimeEpoch;
      activeRoadMutation = mutation;
      void previewCoordinator
        .requestRoadMutation({ mutation, generation })
        .then((response) => {
          if (
            requestRuntimeEpoch !== previewRuntimeEpoch ||
            response === null ||
            activeRoadMutation === null ||
            ui.roadPreviewGeneration !== generation
          ) {
            return;
          }
          commit(state, {
            ...ui,
            roadMutationPreview: response,
            roadMutationPreviewError: null,
          });
        })
        .catch((error: unknown) => {
          if (
            dead ||
            requestRuntimeEpoch !== previewRuntimeEpoch ||
            activeRoadMutation === null ||
            ui.roadPreviewGeneration !== generation
          ) {
            return;
          }
          commit(state, {
            ...ui,
            roadMutationPreview: null,
            roadMutationPreviewError:
              error instanceof Error ? error.message : String(error),
          });
        });
    };

    const requestRoadMutationPreview = (
      mutation: RoadMutation,
    ): RuntimeSnapshot => {
      if (dead || backendAdmissionReserved) return getSnapshot();
      const generation = ui.roadPreviewGeneration + 1;
      const pending = commit(state, {
        ...ui,
        roadPreviewGeneration: generation,
        roadMutationPreview: null,
        roadMutationPreviewError: null,
      });
      sendRoadMutationPreviewRequest(mutation, generation);
      return pending;
    };

    /** Commit a UI transition and, if the resulting state implies a road mutation,
     *  fold the preview-generation bump and preview-clear into the SAME commit so
     *  only one `publish` fires. Replaces the prior pattern of committing the UI,
     *  then calling `requestRoadMutationPreview` (which committed a second time).
     *  Used by tool/preset/arm/drag transitions that may trigger a road preview. */
    const commitWithRoadPreview = (nextUi: UiState): RuntimeSnapshot => {
      if (backendAdmissionReserved) return getSnapshot();
      const mutation = dead ? null : roadMutationForUi(nextUi);
      if (mutation === null) {
        return commit(state, nextUi);
      }
      const generation = nextUi.roadPreviewGeneration + 1;
      const snapshot = commit(state, {
        ...nextUi,
        roadPreviewGeneration: generation,
        roadMutationPreview: null,
        roadMutationPreviewError: null,
      });
      sendRoadMutationPreviewRequest(mutation, generation);
      return snapshot;
    };

    const invalidateRoadPreview = (): void => {
      previewCoordinator.invalidateRoadMutation();
      activeRoadMutation = null;
    };

    const commitLoadedSnapshot = (
      rawSnapshot: RustGameSnapshot,
      envelope: InspectedSaveEnvelope,
      source: LoadSource,
    ): RuntimeSnapshot => {
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();

      // This is the sole load installation boundary. The raw canonical backend
      // result remains opaque until the runtime view is committed, so a
      // normalized GameState can never flow back into persistence restoration.
      state = normalizeRustSnapshot(rawSnapshot);
      ui = createUiState();
      backendError = null;
      rejection = null;
      sandboxResetError = null;
      activeCity = {
        id: envelope.city.id,
        name: envelope.city.name,
        createdAt: envelope.createdAt,
      };
      sessionToken += 1;
      currentRevision = source.kind === "working" ? 0 : 1;
      persistedRevision = 0;
      saveStatus = { state: "idle" };
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "idle" };
      lastSavedAt = source.kind === "working" ? envelope.savedAt : null;
      persistenceError = null;
      return publish();
    };

    // Road clicks defer the lay-vs-cycle decision to execution time. An earlier
    // queued dispatch (e.g. a road drag still draining, or a prior click) may
    // have turned the clicked tile into a road by the time this closure runs, so
    // re-read `state.map` inside the queued handler rather than capturing the
    // tile kind up front. The point is captured from the click; only the kind
    // lookup is deferred, so a tile that has become road routes to
    // cycleRoadDirection instead of layRoad.
    const roadClickIntent = (point: Point): GameIntent => {
      const tile = state.map.tiles.find(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      return tile?.kind === "road"
        ? { type: "cycleRoadDirection", point }
        : { type: "layRoad", point };
    };

    const roadClickMutation = (point: Point): RoadMutation => {
      const intent = roadClickIntent(point);
      return intent.type === "cycleRoadDirection"
        ? intent
        : { type: "layRoad", point };
    };

    const roadMutationForUi = (candidate: UiState): RoadMutation | null => {
      const gesture = candidate.drag;
      if (
        gesture !== null &&
        (gesture.tool === "road" || gesture.tool === "remove")
      ) {
        const points = axisLockedLine(gesture.start, gesture.current);
        if (gesture.tool === "remove") {
          return points.length === 1
            ? { type: "removeAtTile", point: points[0] }
            : { type: "removeAtTiles", points };
        }
        return points.length === 1
          ? roadClickMutation(points[0])
          : { type: "layRoadLine", points, preset: candidate.roadPreset };
      }
      if (candidate.hoverTile === null) return null;
      if (candidate.activeTool === "road") {
        return roadClickMutation(candidate.hoverTile);
      }
      if (candidate.activeTool === "roundabout") {
        return {
          type: "placeRoundabout",
          origin: candidate.hoverTile,
          size: candidate.roundaboutSize,
        };
      }
      if (candidate.activeTool === "remove") {
        return { type: "removeAtTile", point: candidate.hoverTile };
      }
      return null;
    };

    const intentForToolClick = (point: Point): GameIntent | null => {
      if (ui.selectedBuilding !== null) {
        return {
          type: "placeBuilding",
          buildingType: ui.selectedBuilding,
          origin: point,
          rotation: ui.buildingRotation,
        };
      }
      if (ui.activeTool === "busStop") {
        return { type: "addBusStop", point };
      }
      if (ui.activeTool === "metroStation") {
        return { type: "addMetroStation", point };
      }
      if (ui.activeTool === "track") {
        return { type: "layTrack", point };
      }
      if (ui.activeTool === "remove") {
        return { type: "removeAtTile", point };
      }
      // Road is handled by `roadClickIntent` via `enqueueComputedDispatch` at the
      // call sites, so it is intentionally absent from this synchronous lookup.
      return null;
    };

    const routeHandleIndexAtPoint = (
      draft: RouteDraft,
      point: Point,
    ): number | null => {
      const node =
        draft.mode === "bus"
          ? resolveStopAtTile(state, point)
          : resolveStationAtTile(state, point);
      if (node !== undefined) {
        const index = draft.waypointIds.indexOf(node.id);
        return index >= 0 ? index : null;
      }
      // Missing route nodes have no physical footprint. Preserve their exact
      // tombstone handle so editing a broken route remains possible.
      return draftHandleIndexAtExactPoint(draft, state, point);
    };

    const unavailableStoreResult = <T>(
      operation: SaveStoreOperation,
    ): PersistenceOperationResult<T> => {
      const result: PersistenceOperationResult<T> = {
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation,
            code: "unavailable",
            retryable: true,
            diagnostic: "No SaveStore is configured",
          },
        },
      };
      persistenceError = result.error;
      publish();
      return result;
    };

    const isCurrentPersistenceSession = (
      cityId: string,
      capturedSessionToken: number,
    ): boolean =>
      activeCity?.id === cityId && sessionToken === capturedSessionToken;

    const publishWorkingSaveFailure = (
      cityId: string,
      capturedSessionToken: number,
      error: PersistenceCoordinatorError,
    ): void => {
      if (!isCurrentPersistenceSession(cityId, capturedSessionToken)) return;
      saveStatus = { state: "idle" };
      persistenceError = error;
      publish();
    };

    type WorkingSaveCaptureResult =
      | { status: "failed"; error: PersistenceCoordinatorError }
      | { status: "superseded" }
      | {
          status: "captured";
          snapshot: RustGameSnapshot;
          revision: number;
        };

    type GenerationWriteCaptureResult =
      | { status: "failed"; error: PersistenceCoordinatorError }
      | { status: "superseded" }
      | { status: "captured"; snapshot: RustGameSnapshot };

    const saveWorking = (): Promise<
      PersistenceOperationResult<SaveWorkingValue>
    > => {
      if (dead) return Promise.resolve(runtimeUnavailable("saveWorking"));
      if (backendAdmissionReserved) {
        return Promise.resolve({ status: "superseded" });
      }
      if (activeCity !== null && isCityFenced(activeCity.id)) {
        return Promise.resolve({ status: "superseded" });
      }
      if (saveStore === undefined) {
        return Promise.resolve(unavailableStoreResult("writeWorkingSave"));
      }
      if (activeCity === null) {
        const result: PersistenceOperationResult<SaveWorkingValue> =
          noActiveCity("saveWorking");
        if (result.status === "failed") persistenceError = result.error;
        publish();
        return Promise.resolve(result);
      }
      if (options.now === undefined || options.appVersion === undefined) {
        const result: PersistenceOperationResult<SaveWorkingValue> = {
          status: "failed",
          error: {
            kind: "store",
            error: {
              operation: "writeWorkingSave",
              code: "serializationFailed",
              cityId: activeCity.id,
              retryable: false,
              diagnostic: "Working-save dependencies are not configured",
            },
          },
        };
        persistenceError = result.error;
        saveStatus = { state: "idle" };
        publish();
        return Promise.resolve(result);
      }

      const now = options.now;
      const appVersion = options.appVersion;
      const cityId = activeCity.id;
      const capturedSessionToken = sessionToken;

      return cityQueues.enqueue(cityId, async () => {
        if (dead) return runtimeUnavailable("saveWorking");
        if (backendAdmissionReserved) return { status: "superseded" };
        if (!isCurrentPersistenceSession(cityId, capturedSessionToken)) {
          return { status: "superseded" };
        }
        const liveCity = activeCity;
        if (liveCity === null) return { status: "superseded" };
        const city = { ...liveCity };
        saveStatus = { state: "queued", kind: "working", cityId };
        persistenceError = null;
        publish();

        const capture = await gameplayQueue.enqueue<WorkingSaveCaptureResult>({
          operation: async () => {
            if (!isCurrentPersistenceSession(city.id, capturedSessionToken)) {
              return { status: "superseded" };
            }
            saveStatus = {
              state: "capturing",
              kind: "working",
              cityId: city.id,
            };
            publish();
            const result = await backend.snapshotForSave();
            if (!result.ok) {
              return {
                status: "failed",
                error: { kind: "backend", error: result.error },
              };
            }
            return {
              status: "captured",
              snapshot: result.snapshot,
              revision: currentRevision,
            };
          },
          whenDead: () => ({
            status: "failed",
            error: {
              kind: "precondition",
              error: { code: "runtimeUnavailable", operation: "saveWorking" },
            },
          }),
          onThrown: (error: unknown) => ({
            status: "failed",
            error: {
              kind: "backend",
              error: {
                kind: "host",
                operation: "snapshotForSave",
                code: "invokeFailed",
                diagnostic:
                  error instanceof Error ? error.message : String(error),
              },
            },
          }),
        });

        if (dead) return runtimeUnavailable("saveWorking");
        if (capture.status === "superseded") return capture;
        if (capture.status === "failed") {
          publishWorkingSaveFailure(
            city.id,
            capturedSessionToken,
            capture.error,
          );
          return capture;
        }

        let savedAt: string;
        let envelope: ReturnType<typeof buildSaveEnvelope>;
        try {
          savedAt = now();
          envelope = buildSaveEnvelope({
            city: { id: city.id, name: city.name },
            createdAt: city.createdAt,
            savedAt,
            appVersion,
            snapshot: capture.snapshot,
          });
        } catch (error: unknown) {
          const result: PersistenceOperationResult<SaveWorkingValue> = {
            status: "failed",
            error: {
              kind: "store",
              error: {
                operation: "writeWorkingSave",
                code: "serializationFailed",
                cityId: city.id,
                retryable: false,
                diagnostic:
                  error instanceof Error ? error.message : String(error),
              },
            },
          };
          publishWorkingSaveFailure(
            city.id,
            capturedSessionToken,
            result.error,
          );
          return result;
        }
        if (isCurrentPersistenceSession(city.id, capturedSessionToken)) {
          saveStatus = { state: "writing", kind: "working", cityId: city.id };
          publish();
        }

        let stored: Awaited<ReturnType<SaveStore["writeWorkingSave"]>>;
        try {
          stored = await saveStore.writeWorkingSave(envelope);
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "writeWorkingSave",
              code: "ioFailure",
              cityId: city.id,
              retryable: true,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }

        if (dead) return runtimeUnavailable("saveWorking");

        const completion = resolveWorkingSaveCompletion({
          currentCityId: activeCity?.id ?? null,
          currentSessionToken: sessionToken,
          persistedRevision,
          capturedCityId: city.id,
          capturedSessionToken,
          capturedRevision: capture.revision,
        });
        if (completion.status === "superseded") return completion;

        if (!stored.ok) {
          const result: PersistenceOperationResult<SaveWorkingValue> = {
            status: "failed",
            error: { kind: "store", error: stored.error },
          };
          publishWorkingSaveFailure(
            city.id,
            capturedSessionToken,
            result.error,
          );
          return result;
        }

        persistedRevision = completion.persistedRevision;
        lastSavedAt = savedAt;
        saveStatus = { state: "idle" };
        persistenceError = null;
        publish();
        return {
          status: "completed",
          value: { summary: stored.value, savedAt },
        };
      });
    };

    const runGameplayWrite = <TSummary>(
      request: GameplayWriteRequest<TSummary>,
    ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>> => {
      const coordinatorOperation =
        request.kind === "checkpoint" ? "createCheckpoint" : "createAutosave";
      const storeOperation =
        request.kind === "checkpoint" ? "writeCheckpoint" : "writeAutosave";
      if (dead)
        return Promise.resolve(runtimeUnavailable(coordinatorOperation));
      if (backendAdmissionReserved) {
        return Promise.resolve({ status: "superseded" });
      }
      if (activeCity !== null && isCityFenced(activeCity.id)) {
        return Promise.resolve({ status: "superseded" });
      }
      if (saveStore === undefined) {
        return Promise.resolve(unavailableStoreResult(storeOperation));
      }
      if (activeCity === null) {
        const result: PersistenceOperationResult<
          GenerationWriteValue<TSummary>
        > = noActiveCity(coordinatorOperation);
        if (result.status === "failed") persistenceError = result.error;
        publish();
        return Promise.resolve(result);
      }
      if (options.now === undefined || options.appVersion === undefined) {
        const result: PersistenceOperationResult<
          GenerationWriteValue<TSummary>
        > = {
          status: "failed",
          error: {
            kind: "store",
            error: {
              operation: storeOperation,
              code: "serializationFailed",
              cityId: activeCity.id,
              retryable: false,
              diagnostic: "Gameplay-write dependencies are not configured",
            },
          },
        };
        persistenceError = result.error;
        saveStatus = { state: "idle" };
        publish();
        return Promise.resolve(result);
      }

      const now = options.now;
      const appVersion = options.appVersion;
      const cityId = activeCity.id;
      const capturedSessionToken = sessionToken;

      return cityQueues.enqueue(cityId, async () => {
        if (dead) return runtimeUnavailable(coordinatorOperation);
        if (backendAdmissionReserved) return { status: "superseded" };
        if (!isCurrentPersistenceSession(cityId, capturedSessionToken)) {
          return { status: "superseded" };
        }
        const liveCity = activeCity;
        if (liveCity === null) return { status: "superseded" };
        const city = { ...liveCity };
        saveStatus = { state: "queued", kind: request.kind, cityId };
        persistenceError = null;
        publish();

        const capture =
          await gameplayQueue.enqueue<GenerationWriteCaptureResult>({
            operation: async () => {
              if (!isCurrentPersistenceSession(city.id, capturedSessionToken)) {
                return { status: "superseded" };
              }
              saveStatus = {
                state: "capturing",
                kind: request.kind,
                cityId: city.id,
              };
              publish();
              const result = await backend.snapshotForSave();
              if (!result.ok) {
                return {
                  status: "failed",
                  error: { kind: "backend", error: result.error },
                };
              }
              return { status: "captured", snapshot: result.snapshot };
            },
            whenDead: () => ({
              status: "failed",
              error: {
                kind: "precondition",
                error: {
                  code: "runtimeUnavailable",
                  operation: coordinatorOperation,
                },
              },
            }),
            onThrown: (error: unknown) => ({
              status: "failed",
              error: {
                kind: "backend",
                error: {
                  kind: "host",
                  operation: "snapshotForSave",
                  code: "invokeFailed",
                  diagnostic:
                    error instanceof Error ? error.message : String(error),
                },
              },
            }),
          });

        if (dead) return runtimeUnavailable(coordinatorOperation);
        if (capture.status === "superseded") return capture;
        if (capture.status === "failed") {
          if (isCurrentPersistenceSession(city.id, capturedSessionToken)) {
            saveStatus = { state: "idle" };
            persistenceError = capture.error;
            publish();
          }
          return capture;
        }

        let envelope: ReturnType<typeof buildSaveEnvelope>;
        try {
          envelope = buildSaveEnvelope({
            city: { id: city.id, name: city.name },
            createdAt: city.createdAt,
            savedAt: now(),
            appVersion,
            snapshot: capture.snapshot,
          });
        } catch (error: unknown) {
          const result: PersistenceOperationResult<
            GenerationWriteValue<TSummary>
          > = {
            status: "failed",
            error: {
              kind: "store",
              error: {
                operation: storeOperation,
                code: "serializationFailed",
                cityId: city.id,
                retryable: false,
                diagnostic:
                  error instanceof Error ? error.message : String(error),
              },
            },
          };
          if (isCurrentPersistenceSession(city.id, capturedSessionToken)) {
            saveStatus = { state: "idle" };
            persistenceError = result.error;
            publish();
          }
          return result;
        }
        if (isCurrentPersistenceSession(city.id, capturedSessionToken)) {
          saveStatus = {
            state: "writing",
            kind: request.kind,
            cityId: city.id,
          };
          publish();
        }

        let stored: SaveStoreResult<TSummary>;
        try {
          stored = await request.write({ city, envelope });
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: storeOperation,
              code: "ioFailure",
              cityId: city.id,
              retryable: true,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }

        if (dead) return runtimeUnavailable(coordinatorOperation);
        const completion = resolvePersistenceSessionCompletion({
          currentCityId: activeCity?.id ?? null,
          currentSessionToken: sessionToken,
          capturedCityId: city.id,
          capturedSessionToken,
        });
        if (completion.status === "superseded") return completion;

        if (!stored.ok) {
          const result: PersistenceOperationResult<
            GenerationWriteValue<TSummary>
          > = {
            status: "failed",
            error: { kind: "store", error: stored.error },
          };
          saveStatus = { state: "idle" };
          persistenceError = result.error;
          publish();
          return result;
        }

        saveStatus = { state: "idle" };
        persistenceError = null;
        publish();
        return { status: "completed", value: { summary: stored.value } };
      });
    };

    const renameActiveCity = (
      name: string,
    ): Promise<PersistenceOperationResult<RenameActiveCityValue>> => {
      if (dead) return Promise.resolve(runtimeUnavailable("renameActiveCity"));
      if (backendAdmissionReserved) {
        return Promise.resolve({ status: "superseded" });
      }
      if (activeCity !== null && isCityFenced(activeCity.id)) {
        return Promise.resolve({ status: "superseded" });
      }
      if (saveStore === undefined) {
        return Promise.resolve(unavailableStoreResult("renameCity"));
      }
      if (activeCity === null) {
        const result: PersistenceOperationResult<RenameActiveCityValue> =
          noActiveCity("renameActiveCity");
        if (result.status === "failed") persistenceError = result.error;
        publish();
        return Promise.resolve(result);
      }

      const city = { ...activeCity };
      const capturedSessionToken = sessionToken;
      return cityQueues.enqueue(city.id, async () => {
        if (dead) return runtimeUnavailable("renameActiveCity");
        if (backendAdmissionReserved) return { status: "superseded" };
        if (!isCurrentPersistenceSession(city.id, capturedSessionToken)) {
          return { status: "superseded" };
        }

        let stored: Awaited<ReturnType<SaveStore["renameCity"]>>;
        try {
          stored = await saveStore.renameCity(city.id, name);
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "renameCity",
              code: "ioFailure",
              cityId: city.id,
              retryable: true,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }

        if (dead) return runtimeUnavailable("renameActiveCity");
        const completion = resolvePersistenceSessionCompletion({
          currentCityId: activeCity?.id ?? null,
          currentSessionToken: sessionToken,
          capturedCityId: city.id,
          capturedSessionToken,
        });
        if (completion.status === "superseded") return completion;

        if (!stored.ok) {
          const result: PersistenceOperationResult<RenameActiveCityValue> = {
            status: "failed",
            error: { kind: "store", error: stored.error },
          };
          persistenceError = result.error;
          publish();
          return result;
        }

        const liveCity = activeCity;
        if (liveCity === null) return { status: "superseded" };
        activeCity = { ...liveCity, name };
        persistenceError = null;
        publish();
        return { status: "completed", value: { summary: stored.value } };
      });
    };

    const publishLoadTransition = (
      requestToken: number,
      status: RuntimeLoadStatus,
      error: PersistenceCoordinatorError | null,
    ): boolean => {
      if (dead || requestToken !== loadRequestToken) return false;
      loadStatus = status;
      persistenceError = error;
      publish();
      return true;
    };

    const publishLoadFailure = (
      requestToken: number,
      error: PersistenceCoordinatorError,
    ): PersistenceOperationResult<LoadCityValue> => {
      publishLoadTransition(requestToken, { state: "idle" }, error);
      return { status: "failed", error };
    };

    const persistenceHostFailure = (
      operation: "snapshotForSave" | "restoreSnapshot",
      error: unknown,
    ): PersistenceCoordinatorError => ({
      kind: "backend",
      error: {
        kind: "host",
        operation,
        code: "invokeFailed",
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    });

    const fatalRollbackError = (error: unknown): Error => {
      if (error instanceof Error) return error;
      if (
        typeof error === "object" &&
        error !== null &&
        "diagnostic" in error &&
        typeof error.diagnostic === "string"
      ) {
        return new Error(error.diagnostic);
      }
      return new Error(String(error));
    };

    const failRollbackCoherence = (error: unknown): RuntimeSnapshot => {
      // Clear active-city identity and revision baselines before the centralized
      // fatal cleanup in failBackend invalidates tokens and resets statuses.
      activeCity = null;
      currentRevision = 0;
      persistedRevision = 0;
      lastSavedAt = null;
      return failBackend(fatalRollbackError(error));
    };

    const restoreCanonicalBackendState = async (
      canonicalSnapshot: RustGameSnapshot,
      paused: boolean,
    ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
      try {
        restored = await backend.restoreSnapshot({
          snapshot: canonicalSnapshot,
        });
      } catch (error: unknown) {
        return { ok: false, error };
      }
      if (!restored.ok) return { ok: false, error: restored.error };

      try {
        const pause = await backend.dispatch({
          type: "setPaused",
          paused,
        });
        if (pause.snapshot.paused !== paused) {
          throw new Error("Rollback pause restoration did not take effect");
        }
      } catch (error: unknown) {
        return { ok: false, error };
      }
      return { ok: true };
    };

    // New City admission supersedes all loads (it is the sole foreground
    // transaction that reserves gameplay admission). Detach supersedes every
    // load admitted AFTER detach starts — identified by a load token strictly
    // greater than the token captured at detach admission — so detach has
    // deterministic precedence over cross-city loads regardless of read
    // latency. Loads already in flight (token <= the captured value) are not
    // superseded here; detach orders after them through the gameplay queue and
    // invalidates them via the load-token bump in its clearing work.
    const loadSupersededByAdmission = (requestToken: number): boolean => {
      if (backendAdmissionReserved) return true;
      if (detachReserving && requestToken > detachAdmissionLoadToken)
        return true;
      return false;
    };

    const loadCity = async (
      requestedSource: LoadSource,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      if (dead) {
        return runtimeUnavailable(
          readForLoadSource(requestedSource).coordinatorOperation,
        );
      }
      if (saveStore === undefined) {
        return unavailableStoreResult(
          readForLoadSource(requestedSource).storeOperation,
        );
      }

      const source: LoadSource = { ...requestedSource };
      const requestToken = ++loadRequestToken;
      if (loadSupersededByAdmission(requestToken)) {
        return { status: "superseded" };
      }
      const read = readForLoadSource(source);
      // When loading a different city than the one currently active, establish a
      // storage-safe handoff for the former city: fence its persistence admission
      // (new writes for it resolve superseded) and drain its FIFO before the new
      // city becomes active. Without this, a delayed save for the former city can
      // complete (and recreate its storage record) after the caller deletes it,
      // even though the save later resolves superseded. The fence is set
      // synchronously before any await so a save admitted after this point sees
      // it; it is cleared in the finally below once the transition settles.
      const priorCityId = activeCity?.id;
      const switchingCities =
        priorCityId !== undefined && priorCityId !== source.cityId;
      if (switchingCities) {
        acquireCityFence(priorCityId);
      }
      publishLoadTransition(requestToken, { state: "reading", source }, null);

      // Serialize the read and restore with the target city's persistence FIFO
      // so a same-city load cannot overtake a delayed save. The save captures
      // revision B and enters the FIFO first; the load's read waits behind it
      // and reads revision B (not the older revision A). Without this ordering,
      // the load could read revision A, commit it clean, and the delayed save
      // would then write revision B and return superseded — leaving runtime at
      // revision A with dirty === false while storage holds revision B.
      try {
        return await cityQueues.enqueue(source.cityId, async () => {
          if (dead) return runtimeUnavailable(read.coordinatorOperation);
          if (loadSupersededByAdmission(requestToken)) {
            return { status: "superseded" };
          }
          if (switchingCities) {
            // Drain the former city's persistence tail before reading the target
            // so any already-admitted write for it completes (or settles) before
            // the new city becomes active. The drain runs inside the target
            // city's FIFO so a same-target load serializes behind it. This cannot
            // form a lock cycle: the coordinator lease is exclusive, so no other
            // runtime can hold the former city's FIFO while we await it (see
            // `SharedPersistenceCoordinator` for the ownership model).
            await cityQueues.drain(priorCityId);
            if (dead) return runtimeUnavailable(read.coordinatorOperation);
            if (loadSupersededByAdmission(requestToken)) {
              return { status: "superseded" };
            }
          }

          let stored: Awaited<ReturnType<typeof read.read>>;
          try {
            stored = await read.read(saveStore);
          } catch (error: unknown) {
            stored = {
              ok: false,
              error: {
                operation: read.storeOperation,
                code: "ioFailure",
                cityId: source.cityId,
                ...(source.kind === "checkpoint"
                  ? { recordId: source.checkpointId }
                  : source.kind === "autosave"
                    ? { recordId: source.autosaveId }
                    : {}),
                retryable: true,
                diagnostic:
                  error instanceof Error ? error.message : String(error),
              },
            };
          }

          if (dead) return runtimeUnavailable(read.coordinatorOperation);
          if (loadSupersededByAdmission(requestToken)) {
            // A New City reservation or detach started while this load was
            // reading. The load owns the active load status (it published
            // "reading" above and no newer load has bumped the token), so clear
            // it back to idle before yielding admission. The token is left
            // untouched so a concurrent newer load is still detected by its own
            // requestToken mismatch below.
            publishLoadTransition(requestToken, { state: "idle" }, null);
            return { status: "superseded" };
          }
          if (requestToken !== loadRequestToken) {
            return { status: "superseded" };
          }

          if (!stored.ok) {
            return publishLoadFailure(requestToken, {
              kind: "store",
              error: stored.error,
            });
          }

          const inspected = inspectSaveEnvelope(stored.value);
          if (!inspected.ok) {
            return publishLoadFailure(requestToken, {
              kind: "envelope",
              error: compatibilityToEnvelopeError(inspected.compatibility),
            });
          }

          if (inspected.envelope.city.id !== source.cityId) {
            const recordId =
              source.kind === "checkpoint"
                ? source.checkpointId
                : source.kind === "autosave"
                  ? source.autosaveId
                  : undefined;
            return publishLoadFailure(requestToken, {
              kind: "store",
              error: {
                operation: read.storeOperation,
                code: "corruptRecord",
                cityId: source.cityId,
                ...(recordId === undefined ? {} : { recordId }),
                retryable: false,
                diagnostic: `Requested city ${source.cityId} does not match envelope city ${inspected.envelope.city.id}`,
              },
            });
          }

          publishLoadTransition(
            requestToken,
            { state: "restoring", source },
            null,
          );

          return gameplayQueue.enqueue<
            PersistenceOperationResult<LoadCityValue>
          >({
            operation: async () => {
              if (requestToken !== loadRequestToken) {
                return { status: "superseded" };
              }

              // A load read may be superseded while its backend restore is in
              // flight. Capture the authoritative pre-load backend state inside
              // the same serialized boundary so a stale successful restore can be
              // undone before the next queued load begins.
              const priorPaused = state.paused;
              let priorCapture: Awaited<
                ReturnType<GameBackend["snapshotForSave"]>
              >;
              try {
                priorCapture = await backend.snapshotForSave();
              } catch (error: unknown) {
                if (requestToken !== loadRequestToken) {
                  return { status: "superseded" };
                }
                return publishLoadFailure(
                  requestToken,
                  persistenceHostFailure("snapshotForSave", error),
                );
              }
              if (!priorCapture.ok) {
                if (requestToken !== loadRequestToken) {
                  return { status: "superseded" };
                }
                return publishLoadFailure(requestToken, {
                  kind: "backend",
                  error: priorCapture.error,
                });
              }
              if (requestToken !== loadRequestToken) {
                return { status: "superseded" };
              }

              let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
              try {
                restored = await backend.restoreSnapshot({
                  snapshot: inspected.envelope.snapshot,
                });
              } catch (error: unknown) {
                // A host exception cannot prove whether restoration mutated the
                // backend, so restore the captured canonical state before
                // reporting either failure or supersession.
                const rollback = await restoreCanonicalBackendState(
                  priorCapture.snapshot,
                  priorPaused,
                );
                if (!rollback.ok) {
                  failRollbackCoherence(rollback.error);
                  return runtimeUnavailable(read.coordinatorOperation);
                }
                if (requestToken !== loadRequestToken) {
                  return { status: "superseded" };
                }
                return publishLoadFailure(
                  requestToken,
                  persistenceHostFailure("restoreSnapshot", error),
                );
              }
              if (!restored.ok) {
                if (requestToken !== loadRequestToken) {
                  return { status: "superseded" };
                }
                return publishLoadFailure(requestToken, {
                  kind: "backend",
                  error: restored.error,
                });
              }
              if (requestToken !== loadRequestToken) {
                const rollback = await restoreCanonicalBackendState(
                  priorCapture.snapshot,
                  priorPaused,
                );
                if (!rollback.ok) {
                  failRollbackCoherence(rollback.error);
                  return runtimeUnavailable(read.coordinatorOperation);
                }
                return { status: "superseded" };
              }
              const snapshot = commitLoadedSnapshot(
                restored.snapshot,
                inspected.envelope,
                source,
              );
              return { status: "completed", value: { snapshot, source } };
            },
            whenDead: () => runtimeUnavailable(read.coordinatorOperation),
            onThrown: (error: unknown) =>
              publishLoadFailure(requestToken, {
                kind: "backend",
                error: {
                  kind: "host",
                  operation: "restoreSnapshot",
                  code: "invokeFailed",
                  diagnostic:
                    error instanceof Error ? error.message : String(error),
                },
              }),
          });
        });
      } finally {
        if (switchingCities) {
          releaseCityFence(priorCityId);
        }
      }
    };

    type NewCityPriorRuntime = {
      state: typeof state;
      ui: typeof ui;
      backendError: string | null;
      rejection: GameplayRejection | null;
      sandboxResetError: SandboxResetError | null;
      activeCity: ActiveCityIdentity | null;
      sessionToken: number;
      currentRevision: number;
      persistedRevision: number;
      saveStatus: RuntimeSaveStatus;
      loadStatus: RuntimeLoadStatus;
      lifecycleStatus: RuntimeLifecycleStatus;
      lastSavedAt: string | null;
      loadRequestToken: number;
      persistenceError: PersistenceCoordinatorError | null;
      nextRouteDraftInstanceId: number;
      activeRouteSaveTokens: Set<string>;
      activeRoadMutation: RoadMutation | null;
      hadHoverPreviewTimer: boolean;
      running: boolean;
      paused: boolean;
    };

    const captureNewCityPriorRuntime = (
      hadHoverPreviewTimer: boolean,
      priorLifecycleStatus: RuntimeLifecycleStatus,
    ): NewCityPriorRuntime => ({
      state,
      ui,
      backendError,
      rejection,
      sandboxResetError,
      activeCity,
      sessionToken,
      currentRevision,
      persistedRevision,
      saveStatus,
      loadStatus,
      lifecycleStatus: priorLifecycleStatus,
      lastSavedAt,
      loadRequestToken,
      persistenceError,
      nextRouteDraftInstanceId,
      activeRouteSaveTokens: new Set(activeRouteSaveTokens),
      activeRoadMutation,
      hadHoverPreviewTimer,
      running: canvasHost.isRunning(),
      paused: state.paused,
    });

    const restoreNewCityPriorRuntime = (prior: NewCityPriorRuntime): void => {
      state = prior.state;
      ui = prior.ui;
      backendError = prior.backendError;
      rejection = prior.rejection;
      sandboxResetError = prior.sandboxResetError;
      activeCity = prior.activeCity;
      sessionToken = prior.sessionToken;
      currentRevision = prior.currentRevision;
      persistedRevision = prior.persistedRevision;
      saveStatus = prior.saveStatus;
      loadStatus = prior.loadStatus;
      lifecycleStatus = prior.lifecycleStatus;
      lastSavedAt = prior.lastSavedAt;
      loadRequestToken = prior.loadRequestToken;
      persistenceError = prior.persistenceError;
      nextRouteDraftInstanceId = prior.nextRouteDraftInstanceId;
      activeRouteSaveTokens.clear();
      for (const token of prior.activeRouteSaveTokens) {
        activeRouteSaveTokens.add(token);
      }
      activeRoadMutation = prior.activeRoadMutation;
      // Defense in depth: a disposed runtime must never restart its canvas.
      // The dead-check paths in `activateNewCity`/`rollbackNewCity` already
      // skip calling this when `dead`, but guard the restart itself so a
      // future caller cannot resurrect a disposed runtime's animation loop.
      if (
        !dead &&
        prior.running &&
        !stopRequestedDuringReservation &&
        !canvasHost.isRunning()
      )
        canvasHost.start();
      if (!prior.running && canvasHost.isRunning()) canvasHost.stop();
    };

    const suspendNewCityPreviews = (): boolean => {
      const hadHoverPreviewTimer = hoverPreviewTimer !== null;
      previewAdmissionSuspended = true;
      previewRuntimeEpoch += 1;
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      // Keep activeRoadMutation intact for the rollback baseline. The request is
      // invalidated here and, if still pending, is reissued only after the prior
      // canonical backend snapshot has been restored.
      previewCoordinator.invalidateRoadMutation();
      return hadHoverPreviewTimer;
    };

    const resumeNewCityPriorPreviews = (prior: NewCityPriorRuntime): void => {
      const routeDraft = prior.ui.routeDraft;
      if (routeDraft?.previewPending === true) {
        requestRoutePreview(routeDraft, true);
      }

      if (
        prior.ui.roadMutationPreview !== null ||
        prior.ui.roadMutationPreviewError !== null
      ) {
        return;
      }
      const mutation =
        prior.activeRoadMutation ??
        (prior.hadHoverPreviewTimer ? roadMutationForUi(prior.ui) : null);
      if (mutation !== null) {
        sendRoadMutationPreviewRequest(
          mutation,
          prior.ui.roadPreviewGeneration,
          true,
        );
      }
    };

    const rollbackNewCity = async (
      prior: NewCityPriorRuntime,
      priorCanonicalSnapshot: RustGameSnapshot,
      failure: PersistenceCoordinatorError,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      // A disposed runtime must remain terminal even though its private
      // backend must be rolled back for coherence. Separate the backend
      // rollback (always needed so the disposed backend is not left in the
      // candidate state) from the public runtime restoration (canvas
      // restart, status/error restoration, snapshot publication, preview
      // resumption) — the latter must NOT run once disposal has begun,
      // otherwise it resurrects the runtime's public presentation: restarts
      // the canvas, restores pre-disposal statuses, and publishes snapshots
      // after disposal. Capture `terminal` at entry; re-check `dead` after
      // the backend rollback because disposal may begin while rollback
      // itself is awaiting the backend.
      const terminal = dead;
      if (!terminal) {
        lifecycleStatus = { state: "rollingBack" };
        publish();
      }

      const restored = await restoreCanonicalBackendState(
        priorCanonicalSnapshot,
        prior.paused,
      );
      if (!restored.ok) {
        failRollbackCoherence(restored.error);
        return runtimeUnavailable("activateNewCity");
      }

      // Disposal may have begun while rollback was awaiting the backend. A
      // disposed runtime must not be resurrected: do not restore the prior
      // public runtime, restart the canvas, resume previews, or publish.
      if (dead) {
        return runtimeUnavailable("activateNewCity");
      }

      previewRuntimeEpoch += 1;
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      restoreNewCityPriorRuntime(prior);
      publish();
      resumeNewCityPriorPreviews(prior);
      return { status: "failed", error: failure };
    };

    // Centralized "restore the prior public runtime only while live" for the
    // pre-candidate failure branches that do NOT route through `rollbackNewCity`
    // (no candidate is installed, so no backend rollback is needed). Disposal
    // may begin while the awaited backend call is pending; a disposed runtime
    // must remain terminal — do not restore pre-disposal statuses/tokens,
    // restart the canvas, publish, or resume previews after disposal. This
    // mirrors `rollbackNewCity`'s terminal discipline for the branches that
    // bypass it.
    const restorePriorRuntimeAfterNewCityFailure = (
      prior: NewCityPriorRuntime,
      failure: PersistenceCoordinatorError,
    ): PersistenceOperationResult<LoadCityValue> => {
      if (dead) {
        return runtimeUnavailable("activateNewCity");
      }
      restoreNewCityPriorRuntime(prior);
      publish();
      resumeNewCityPriorPreviews(prior);
      return { status: "failed", error: failure };
    };

    // Enter the fatal persistence-recovery state: late-success cleanup could
    // not undo the orphan storage mutation (or the backend rollback failed),
    // OR reconciliation could not determine the committed state (readFailed) or
    // observed an impossible state (active after an atomic create-only). This
    // is a complete terminal transition — not merely pinning the lease. The
    // runtime becomes immediately dead: no further gameplay, saves, or
    // controller calls reach the backend or store. The lease is pinned
    // (`leaseStuck`) so a replacement runtime against the same storage
    // identity cannot acquire it — safe rebootstrap cannot proceed until the
    // orphan is reconciled out of band. The candidate backend may remain
    // installed but `dead = true` prevents any gameplay from reaching it. The
    // active-city identity is cleared so the candidate is never presented as a
    // coherent active city. The `cityId` is captured so `dispose()` can report
    // which city's cleanup failed via the typed disposal outcome.
    //
    // This mirrors `failBackend`'s terminal discipline (invalidate tokens,
    // reset statuses, stop canvas/preview, start drain-and-release) but pins
    // the lease instead of releasing it, and does not set `backendError`
    // (this is a persistence-recovery condition, not a backend failure).
    // Terminal persistence-recovery state for a live runtime's late-success
    // cleanup or ambiguous-failure reconciliation. `reason` distinguishes:
    // - `"lateSuccessCleanupFailed"` — cleanup was attempted but the store
    //   delete or backend rollback failed (typed error or thrown exception).
    // - `"multiRealmAmbiguousCleanup"` — the adapter does not declare
    //   `singleRealm: true`, so the pending/active record may belong to a live
    //   New City transaction in another realm. The record is preserved and the
    //   runtime becomes terminal rather than risk deleting another realm's
    //   transaction.
    const enterPersistenceRecovery = (
      cityId: string,
      reason: "lateSuccessCleanupFailed" | "multiRealmAmbiguousCleanup",
    ): void => {
      leaseStuck = true;
      leaseStuckCityId = cityId;
      recovery = {
        state: "recoveryRequired",
        reason,
        cityId,
      };
      dead = true;
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      activeRoadMutation = null;
      clearHoverPreviewTimer();
      sessionToken += 1;
      loadRequestToken += 1;
      saveStatus = { state: "idle" };
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "idle" };
      persistenceError = null;
      stopRequestedDuringReservation = false;
      stopRuntime();
      // Clear the active-city identity and revision baselines so the
      // candidate backend is never presented as a coherent active city.
      activeCity = null;
      currentRevision = 0;
      persistedRevision = 0;
      lastSavedAt = null;
      // Clear stale preview UI so the terminal snapshot does not show a
      // road preview overlay or a route draft stuck at previewPending.
      ui = {
        ...ui,
        roadMutationPreview: null,
        roadMutationPreviewError: null,
        routeDraft:
          ui.routeDraft === null
            ? ui.routeDraft
            : { ...ui.routeDraft, previewPending: false },
      };
      // Fire-and-forget: close the lease so no new work can be admitted, and
      // drain already-admitted work. The lease is never released because
      // `leaseStuck` is set. The current foreground operation's `finally`
      // block will `releaseForeground`, allowing `drainAll` to resolve, but
      // `startDrainAndRelease` skips `lease.release()` when `leaseStuck`.
      void startDrainAndRelease();
      // Deliver the terminal snapshot to subscribers exactly once so App's
      // `setSnapshot` observes `recovery.state === "recoveryRequired"` and
      // renders the shell error screen. Without this, the runtime is dead and
      // the lease is pinned but the UI retains its previous healthy-looking
      // snapshot. The activation returns a `PersistenceOperationResult` (not a
      // `RuntimeSnapshot`), so the terminal state is only observable through
      // the subscriber channel.
      //
      // Suppressed when disposal has begun: an explicit `dispose()` is
      // tearing the runtime down, and the recovery reason is delivered through
      // the typed `RuntimeDisposeResult` (the lifecycle owner's channel during
      // teardown). Publishing a terminal snapshot after the unmount began
      // would emit a stale UI update. A LIVE runtime that enters recovery
      // (not disposed) still publishes so App renders the recovery screen.
      // `failBackend` is unaffected: it is a live fatal transition that
      // publishes through its own `publishTerminalSnapshot` call, and the
      // `terminalPublished` latch suppresses any later recovery publication.
      if (!disposalRequested) {
        publishTerminalSnapshot();
      }
    };

    // Convenience wrapper for the common case: cleanup was attempted but
    // failed (store delete or backend rollback returned a typed error or
    // threw).
    const enterLateSuccessCleanupFailure = (cityId: string): void =>
      enterPersistenceRecovery(cityId, "lateSuccessCleanupFailed");

    // Late-success cleanup: the initial `createWorkingSave` succeeded AFTER
    // disposal began, so the candidate city record is committed in storage
    // even though New City never completed or published success. Roll back the
    // backend to the prior canonical state (coherence) and undo the orphan
    // storage mutation.
    //
    // This function is called from two distinct contexts that require
    // different public-runtime handling:
    //
    // 1. Disposal-time cleanup (the `if (dead)` branch in `activateNewCity`):
    //    the runtime is already disposed. Roll back the backend and delete the
    //    orphan for coherence, but do NOT restore the prior public runtime,
    //    restart the canvas, publish, or resume previews. Return
    //    `runtimeUnavailable`.
    //
    // 2. Live-runtime reconciliation (`reconcileAmbiguousCreateFailure` /
    //    `reconcileAmbiguousFinalizeFailure` → `case "pending"`): the runtime
    //    is alive. The create committed a pending record but the operation
    //    failed (thrown or typed). Roll back the backend, delete the orphan,
    //    restore the prior public runtime, publish, resume previews, and
    //    return the ORIGINAL typed failure (not `runtimeUnavailable`). The
    //    runtime remains usable.
    //
    // Disposal may begin during the async cleanup operations (backend rollback
    // or storage delete). After cleanup succeeds, a `dead` check gates the
    // public-runtime restoration: if disposal began during cleanup, remain
    // terminal and return `runtimeUnavailable` — mirroring `rollbackNewCity`'s
    // terminal discipline.
    //
    // Serialization: this runs inside the admitted foreground operation, so
    // `drainAll` waits for it before the lease can be released. The cleanup
    // store call is issued DIRECTLY (not through `lease.enqueue`, which rejects
    // on the now-closing lease) — this is safe because the lease is still
    // exclusively held and the successful city FIFO write has already settled.
    //
    // Identity safety: `createWorkingSave` is an atomic create-only operation
    // that returns `conflict` when ANY storage already exists for the city ID.
    // A successful create PROVES no prior storage existed, so cleanup can
    // safely `deleteCity` the newly created city without restoring a prior
    // record. There is no ID-collision overwrite path — the create would have
    // been rejected with `conflict` before committing.
    //
    // Cleanup-failure policy: if the backend rollback or the storage delete
    // fails (typed error OR a thrown adapter exception), enter the fatal
    // persistence-recovery state (`enterLateSuccessCleanupFailure`) — the
    // runtime becomes terminal and the lease is never released. Silently
    // releasing the lease while an orphan remains is not acceptable. A thrown
    // adapter exception is caught and normalized into the terminal state so
    // the activation resolves with a typed `runtimeUnavailable` rather than
    // rejecting with the untyped adapter exception.
    //
    // Multi-realm safety: if the adapter does not declare `singleRealm: true`,
    // the pending/active record may belong to a live New City transaction in
    // another realm (the in-memory coordinator lease only proves ownership
    // within a single process/registry). In that case, do NOT delete — enter
    // the terminal `multiRealmAmbiguousCleanup` recovery state and preserve
    // the record for manual/durable reconciliation. The backend rollback is
    // still safe (it is an in-memory operation that does not affect durable
    // storage). Durable cross-process ownership (transaction IDs, heartbeat
    // leases) is the long-term fix tracked separately; until then, multi-realm
    // adapters must not auto-delete after ambiguous reconciliation.
    const cleanupLateSuccessNewCity = async (
      prior: NewCityPriorRuntime,
      priorCanonicalSnapshot: RustGameSnapshot,
      identity: NewCityIdentity,
      failure: PersistenceCoordinatorError,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      const restored = await restoreCanonicalBackendState(
        priorCanonicalSnapshot,
        prior.paused,
      );
      if (!restored.ok) {
        enterLateSuccessCleanupFailure(identity.id);
        return runtimeUnavailable("activateNewCity");
      }

      // Multi-realm safety: do not delete a record that may belong to another
      // realm's live transaction. The backend rollback above is safe
      // (in-memory only). The durable record is preserved.
      //
      // P2: Uses the `singleRealm` value captured once before acquisition
      // instead of re-reading the getter — a stateful or throwing getter
      // after acquisition would leak the lease.
      if (!singleRealm) {
        enterPersistenceRecovery(identity.id, "multiRealmAmbiguousCleanup");
        return runtimeUnavailable("activateNewCity");
      }

      try {
        const deleted = await saveStore!.deleteCity(identity.id);
        // `notFound` means the orphan is already absent — acceptable.
        if (!deleted.ok && deleted.error.code !== "notFound") {
          enterLateSuccessCleanupFailure(identity.id);
          return runtimeUnavailable("activateNewCity");
        }
      } catch {
        // A thrown adapter exception must not reject the activation or bypass
        // the terminal recovery state. Normalize it: enter the fatal state so
        // the runtime is terminal and the lease is pinned.
        enterLateSuccessCleanupFailure(identity.id);
        return runtimeUnavailable("activateNewCity");
      }

      // Cleanup succeeded. If the runtime is already disposed (or disposal
      // began during the async cleanup operations), remain terminal — do not
      // restore the prior public runtime, restart the canvas, publish, or
      // resume previews. This mirrors `rollbackNewCity`'s terminal discipline.
      if (dead) {
        return runtimeUnavailable("activateNewCity");
      }

      // Live runtime: the pending orphan is deleted and the backend is rolled
      // back, so the runtime is coherent again. Restore the prior public
      // runtime, publish the restored view, resume previews, and return the
      // ORIGINAL typed failure — not `runtimeUnavailable`. The runtime remains
      // usable for subsequent operations.
      previewRuntimeEpoch += 1;
      previewCoordinator.invalidateRoute();
      previewCoordinator.invalidateRoadMutation();
      restoreNewCityPriorRuntime(prior);
      publish();
      resumeNewCityPriorPreviews(prior);
      return { status: "failed", error: failure };
    };

    // Read a city's committed state to reconcile an ambiguous store operation.
    // After a thrown or non-conflict typed failure from `createWorkingSave` or
    // `finalizeWorkingSave`, the caller cannot know whether the operation
    // committed before the failure. This reads the city and classifies its
    // state so the caller can reconcile:
    //
    // - `notFound`: no record exists — the operation did not commit.
    // - `pending`: a pending record exists (created by `createWorkingSave` but
    //   not yet finalized) — the create committed but finalize did not.
    // - `active`: a finalized record exists — finalize committed.
    // - `readFailed`: the read itself failed or threw — committed state is
    //   unknowable; the caller must enter the recovery-required state.
    type CityPendingState =
      | { status: "notFound" }
      | { status: "pending" }
      | { status: "active" }
      | { status: "readFailed" };

    // This calls `saveStore.inspectWorkingSaveState` DIRECTLY (not through
    // `lease.enqueue`, which rejects once the lease begins closing during
    // disposal). This is safe because:
    // - The candidate city's create/finalize FIFO operation has already settled
    //   (the ambiguous failure happened after the FIFO operation completed).
    // - New City still owns the foreground reservation (counted by `drainAll`),
    //   so disposal waits for the entire workflow including this read.
    // - Replacement runtime acquisition remains blocked until
    //   `releaseForeground()` is called in the finally block.
    // - No normal candidate-city operation can be admitted through this runtime
    //   (the lease is closing).
    // This mirrors the existing direct `deleteCity` call in
    // `cleanupLateSuccessNewCity`. Using a single `inspectWorkingSaveState`
    // call instead of `readWorkingSave` + `listCities` provides one coherent
    // storage observation with no inter-call race window.
    const readCityPendingState = async (
      cityId: string,
    ): Promise<CityPendingState> => {
      try {
        const result = await saveStore!.inspectWorkingSaveState(cityId);
        if (!result.ok) return { status: "readFailed" };
        return { status: result.value };
      } catch {
        return { status: "readFailed" };
      }
    };

    // Reconcile an ambiguous `createWorkingSave` failure (a thrown exception or
    // a non-conflict typed failure). The create may have committed a pending
    // record before the failure. Read the city to determine committed state:
    // - notFound: uncommitted — rollback normally with the original error.
    // - pending: our orphan — cleanup (delete pending + rollback backend).
    // - active: a pre-existing finalized city — unexpected with atomic
    //   create-only; enter recovery-required.
    // - readFailed: can't determine — enter recovery-required.
    const reconcileAmbiguousCreateFailure = async (
      prior: NewCityPriorRuntime,
      priorCanonicalSnapshot: RustGameSnapshot,
      identity: NewCityIdentity,
      failure: PersistenceCoordinatorError,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      const state = await readCityPendingState(identity.id);
      switch (state.status) {
        case "notFound":
          // Uncommitted failure — rollback normally.
          return await rollbackNewCity(prior, priorCanonicalSnapshot, failure);
        case "pending":
          // The create committed a pending record — treat as late-success
          // orphan. Delete it and roll back the backend. Pass the original
          // failure so the live-runtime path returns it (not runtimeUnavailable).
          return await cleanupLateSuccessNewCity(
            prior,
            priorCanonicalSnapshot,
            identity,
            failure,
          );
        case "active":
        case "readFailed":
          // An active record should not exist (createWorkingSave returns
          // conflict if any storage exists), or we can't determine the state.
          // Enter recovery-required.
          enterLateSuccessCleanupFailure(identity.id);
          return runtimeUnavailable("activateNewCity");
      }
    };

    // Reconcile an ambiguous `finalizeWorkingSave` failure. The finalize may
    // have committed (flipping pending → active) before the failure. Read the
    // city to determine committed state:
    // - notFound: the city doesn't exist — unexpected; rollback.
    // - pending: finalize did not commit — cleanup (delete pending + rollback).
    //   Pass the original finalize failure so the live-runtime cleanup path
    //   returns it (not runtimeUnavailable).
    // - active: finalize committed — the city is durably active. If dead, do
    //   NOT delete it (it's a real city); return runtimeUnavailable. If alive,
    //   return null to signal the caller to proceed to the normal success path.
    // - readFailed: can't determine — enter recovery-required.
    // Returns null when the caller should proceed to publish success (the city
    // is active and the runtime is alive).
    const reconcileAmbiguousFinalizeFailure = async (
      prior: NewCityPriorRuntime,
      priorCanonicalSnapshot: RustGameSnapshot,
      identity: NewCityIdentity,
      failure: PersistenceCoordinatorError,
    ): Promise<PersistenceOperationResult<LoadCityValue> | null> => {
      const state = await readCityPendingState(identity.id);
      switch (state.status) {
        case "notFound":
          // The city doesn't exist — unexpected after a successful create, but
          // the finalize did not commit a durable record. Roll back the backend
          // and restore the prior public runtime. The runtime remains usable,
          // so return the ORIGINAL finalize store failure (not
          // `runtimeUnavailable`): a vanished record is a store-level failure
          // the caller can surface, not a terminal runtime condition. Returning
          // `runtimeUnavailable` here would contradict the live, usable state
          // the rollback just restored.
          return await rollbackNewCity(prior, priorCanonicalSnapshot, failure);
        case "pending":
          // Finalize did not commit — delete the pending orphan and rollback.
          // Pass the original finalize failure so the live-runtime cleanup
          // path returns it (not runtimeUnavailable).
          return await cleanupLateSuccessNewCity(
            prior,
            priorCanonicalSnapshot,
            identity,
            failure,
          );
        case "active":
          // Finalize committed — the city is durably active. If dead, do NOT
          // delete it; just return runtimeUnavailable. The city can be loaded
          // on restart. If alive, signal the caller to proceed to publish.
          if (dead) return runtimeUnavailable("activateNewCity");
          return null;
        case "readFailed":
          enterLateSuccessCleanupFailure(identity.id);
          return runtimeUnavailable("activateNewCity");
      }
    };

    const activateNewCity = async (
      requestedSandbox: SandboxCreationRequest,
      requestedIdentity: NewCityIdentity,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      if (dead) return runtimeUnavailable("activateNewCity");
      if (backendAdmissionReserved) return { status: "superseded" };
      if (lifecycleTransitionReserved) return { status: "superseded" };
      if (saveStore === undefined) {
        return unavailableStoreResult("createWorkingSave");
      }
      // Multi-realm admission gate (HPA-539 temporary policy): a store that
      // does not declare `singleRealm: true` may be shared across independent
      // realms/processes, each with its own coordinator registry. An ambiguous
      // create/finalize failure on such a store leaves a pending record that
      // this process cannot safely delete or finalize — it may belong to a
      // live New City transaction in another realm, and bootstrap
      // reconciliation after a restart cannot prove otherwise without durable
      // cross-process ownership. Rather than create a durable state the
      // current application cannot repair, refuse admission BEFORE any storage
      // mutation. The runtime stays alive and usable; the typed precondition
      // error is surfaced through `persistenceError`. This check happens
      // before `backendAdmissionReserved`/`lifecycleTransitionReserved` are
      // set, so no rollback or foreground admission is involved.
      if (!singleRealm) {
        const result = multiRealmNewCityUnsupported(requestedIdentity.id);
        if (result.status === "failed") {
          persistenceError = result.error;
        }
        publish();
        return result;
      }
      if (options.now === undefined || options.appVersion === undefined) {
        const result: PersistenceOperationResult<LoadCityValue> = {
          status: "failed",
          error: {
            kind: "store",
            error: {
              operation: "createWorkingSave",
              code: "serializationFailed",
              cityId: requestedIdentity.id,
              retryable: false,
              diagnostic: "New-city dependencies are not configured",
            },
          },
        };
        persistenceError = result.error;
        publish();
        return result;
      }

      const request = { ...requestedSandbox };
      const identity = { ...requestedIdentity };
      const now = options.now;
      const appVersion = options.appVersion;
      const priorLifecycleStatus = lifecycleStatus;
      backendAdmissionReserved = true;
      lifecycleTransitionReserved = true;
      // Invalidate any in-flight load lineage immediately so a pending read
      // that settles during or after this transaction cannot continue
      // restoring. The bumped token is captured in `prior` below, so rollback
      // restores the bumped value (not the pre-admission value) and a late
      // settling load still sees a token mismatch.
      loadRequestToken += 1;
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "creatingCity" };
      publish();

      // Register as a foreground lifecycle operation so `drainAll` during
      // disposal waits for this entire workflow — not only its eventual store
      // enqueue. Without this, dispose() could drain zero outstanding FIFO
      // work while New City is blocked in createSandbox, release the lease,
      // and let a replacement runtime acquire it before this workflow
      // enqueues its write. If the lease is already closing (disposal
      // started), bail out without admitting.
      let foregroundAdmitted = false;
      try {
        foregroundAdmitted = lease!.admitForeground();
        if (!foregroundAdmitted) {
          return runtimeUnavailable("activateNewCity");
        }

        await gameplayQueue.drain();
        if (dead) return runtimeUnavailable("activateNewCity");
        const priorCityId = activeCity?.id;
        if (priorCityId !== undefined) {
          await cityQueues.drain(priorCityId);
        }
        if (dead) return runtimeUnavailable("activateNewCity");

        const hadHoverPreviewTimer = suspendNewCityPreviews();
        const prior = captureNewCityPriorRuntime(
          hadHoverPreviewTimer,
          priorLifecycleStatus,
        );

        let priorCapture: Awaited<ReturnType<GameBackend["snapshotForSave"]>>;
        try {
          priorCapture = await backend.snapshotForSave();
        } catch (error: unknown) {
          return restorePriorRuntimeAfterNewCityFailure(
            prior,
            persistenceHostFailure("snapshotForSave", error),
          );
        }
        if (!priorCapture.ok) {
          return restorePriorRuntimeAfterNewCityFailure(prior, {
            kind: "backend",
            error: priorCapture.error,
          });
        }
        // Dead check after prior capture: the backend still holds the prior
        // state (createSandbox has not run), so no backend rollback is
        // needed. A disposed runtime must remain terminal — do not restore
        // the prior public runtime, restart the canvas, or publish.
        if (dead) {
          return runtimeUnavailable("activateNewCity");
        }

        let created: Awaited<ReturnType<GameBackend["createSandbox"]>>;
        try {
          created = await backend.createSandbox(request);
        } catch (error: unknown) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "backend",
            error: {
              kind: "host",
              operation: "createSandbox",
              code: "invokeFailed",
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          });
        }
        if (!created.ok) {
          return restorePriorRuntimeAfterNewCityFailure(prior, {
            kind: "sandbox",
            error: created.error,
          });
        }
        // Dead check after createSandbox: the backend now holds the candidate
        // sandbox. Rollback to the prior canonical snapshot so the disposed
        // backend is not left in the candidate state, and no save is written.
        if (dead) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "precondition",
            error: { code: "runtimeUnavailable", operation: "activateNewCity" },
          });
        }

        let candidateCapture: Awaited<
          ReturnType<GameBackend["snapshotForSave"]>
        >;
        try {
          candidateCapture = await backend.snapshotForSave();
        } catch (error: unknown) {
          return await rollbackNewCity(
            prior,
            priorCapture.snapshot,
            persistenceHostFailure("snapshotForSave", error),
          );
        }
        if (!candidateCapture.ok) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "backend",
            error: candidateCapture.error,
          });
        }
        // Dead check after candidate capture: the candidate is installed.
        // Rollback and return — no save is written, no successful result is
        // published.
        if (dead) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "precondition",
            error: { code: "runtimeUnavailable", operation: "activateNewCity" },
          });
        }

        let savedAt: string;
        let envelope: ReturnType<typeof buildSaveEnvelope>;
        try {
          savedAt = now();
          envelope = buildSaveEnvelope({
            city: { id: identity.id, name: identity.name },
            createdAt: identity.createdAt,
            savedAt,
            appVersion,
            snapshot: candidateCapture.snapshot,
          });
        } catch (error: unknown) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "store",
            error: {
              operation: "createWorkingSave",
              code: "serializationFailed",
              cityId: identity.id,
              retryable: false,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          });
        }

        // Dead check immediately before the store enqueue: if disposal
        // occurred during envelope construction (synchronous, but defense in
        // depth), do not write. The candidate is installed, so rollback.
        if (dead) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "precondition",
            error: { code: "runtimeUnavailable", operation: "activateNewCity" },
          });
        }

        // Atomic create-only write: `createWorkingSave` stores the candidate
        // as a **pending** record — durably committed but not yet finalized as
        // an active city. It returns `conflict` when ANY storage already exists
        // for the city ID (working record, checkpoints, autosaves, generation
        // high-water, or a pending record from a prior unfinalized create). This
        // proves a successful write created the city's storage rather than
        // overwriting a pre-existing city. An ID collision rolls the candidate
        // backend back and returns a typed store conflict — no overwrite occurs.
        //
        // After a successful create, the runtime MUST call `finalizeWorkingSave`
        // to flip the record from pending to active before publishing success.
        // If the runtime crashes or is disposed before finalization, the pending
        // record remains as a durable marker; bootstrap reconciliation deletes
        // it on the next `createGameRuntime`.
        //
        // Ambiguous-failure reconciliation: if the create throws or returns a
        // non-conflict typed failure, the caller cannot know whether the
        // pending record committed before the failure. `conflict` is safe (the
        // atomic create-only contract guarantees no commit on conflict). For
        // all other failures, read the city to reconcile:
        // - notFound: uncommitted — rollback normally.
        // - pending: our orphan — cleanup (delete + rollback).
        // - active/readFailed: unexpected or unknowable — recovery-required.
        let stored: Awaited<ReturnType<SaveStore["createWorkingSave"]>>;
        try {
          stored = await cityQueues.enqueue(identity.id, () =>
            saveStore.createWorkingSave(envelope),
          );
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "createWorkingSave",
              code: "ioFailure",
              cityId: identity.id,
              retryable: true,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (!stored.ok) {
          if (stored.error.code === "conflict") {
            // Atomic create-only guarantees no commit on conflict.
            return await rollbackNewCity(prior, priorCapture.snapshot, {
              kind: "store",
              error: stored.error,
            });
          }
          // Ambiguous failure — reconcile by reading the city.
          return await reconcileAmbiguousCreateFailure(
            prior,
            priorCapture.snapshot,
            identity,
            { kind: "store", error: stored.error },
          );
        }
        // Late-success branch: the initial create SUCCEEDED after disposal
        // began. The candidate city record is now committed in storage as a
        // pending record, even though New City never completed or published
        // success. This is the orphan scenario the persistence design warns
        // about (§15.5) for uncancellable writes. Roll back the backend for
        // coherence AND undo the orphan storage mutation via `deleteCity`. The
        // runtime remains terminal — no success is published, no candidate is
        // installed. Cleanup runs inside this admitted foreground operation,
        // so `drainAll` waits for it and the lease is not released until
        // cleanup settles (or never, if cleanup fails — see the fatal recovery
        // state).
        if (dead) {
          return await cleanupLateSuccessNewCity(
            prior,
            priorCapture.snapshot,
            identity,
            {
              kind: "precondition",
              error: {
                code: "runtimeUnavailable",
                operation: "activateNewCity",
              },
            },
          );
        }

        // Finalize the pending record: flip it from pending to active. This
        // makes the city a durable, loadable city that survives process
        // restarts. If finalization fails ambiguously, reconcile by reading the
        // city: if it's already active, finalization committed despite the
        // failure and the runtime can proceed (or return runtimeUnavailable if
        // dead); if still pending, finalization did not commit and the orphan
        // must be cleaned up.
        let finalized: Awaited<ReturnType<SaveStore["finalizeWorkingSave"]>>;
        try {
          finalized = await cityQueues.enqueue(identity.id, () =>
            saveStore.finalizeWorkingSave(identity.id),
          );
        } catch (error: unknown) {
          finalized = {
            ok: false,
            error: {
              operation: "finalizeWorkingSave",
              code: "ioFailure",
              cityId: identity.id,
              retryable: true,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (!finalized.ok) {
          const reconciled = await reconcileAmbiguousFinalizeFailure(
            prior,
            priorCapture.snapshot,
            identity,
            { kind: "store", error: finalized.error },
          );
          if (reconciled !== null) return reconciled;
          // Finalization committed despite the failure — fall through to the
          // normal success path. The city is durably active.
        }
        // Dead check after finalization: if disposal began after the city was
        // finalized, the city is durably active. Do NOT delete it — it can be
        // loaded on restart. Just return runtimeUnavailable without publishing.
        if (dead) {
          return runtimeUnavailable("activateNewCity");
        }

        clearHoverPreviewTimer();
        previewRuntimeEpoch += 1;
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        activeRouteSaveTokens.clear();
        nextRouteDraftInstanceId = 1;
        state = normalizeRustSnapshot(candidateCapture.snapshot);
        ui = createUiState();
        backendError = null;
        rejection = null;
        sandboxResetError = null;
        activeCity = identity;
        sessionToken = prior.sessionToken + 1;
        loadRequestToken = prior.loadRequestToken + 1;
        currentRevision = 0;
        persistedRevision = 0;
        saveStatus = { state: "idle" };
        loadStatus = { state: "idle" };
        lifecycleStatus = { state: "idle" };
        lastSavedAt = savedAt;
        persistenceError = null;
        const snapshot = publish();
        const source: LoadSource = { kind: "working", cityId: identity.id };
        return { status: "completed", value: { snapshot, source } };
      } finally {
        if (foregroundAdmitted) lease!.releaseForeground();
        previewAdmissionSuspended = false;
        backendAdmissionReserved = false;
        lifecycleTransitionReserved = false;
        if (stopRequestedDuringReservation) {
          stopRequestedDuringReservation = false;
          stopRuntime();
        }
      }
    };

    const detachActiveCity = async (): Promise<
      PersistenceOperationResult<RuntimeSnapshot>
    > => {
      if (dead) return runtimeUnavailable("detachActiveCity");
      if (backendAdmissionReserved) {
        return { status: "superseded" };
      }
      if (lifecycleTransitionReserved) {
        return { status: "superseded" };
      }
      const priorCityId = activeCity?.id;
      // Detach owns city-scoped persistence admission for the departing city. It
      // does NOT set `backendAdmissionReserved`, so gameplay ticks/dispatches
      // keep running during the storage drain (New City remains the sole
      // foreground admission owner). It DOES acquire `lifecycleTransitionReserved`
      // so a concurrent New City request (or a second detach) is superseded at
      // admission rather than running alongside detach and undoing its completed
      // result via rollback. The departing city's persistence admission is fenced
      // (new saves for it resolve superseded) and its FIFO is drained before
      // detach clears identity, so a delayed write cannot recreate a deleted city
      // record. Loads admitted AFTER detach starts are superseded via
      // `detachAdmissionLoadToken`, giving detach deterministic precedence over
      // cross-city loads; loads already in flight are allowed to settle and
      // detach orders after them through the gameplay queue. The drain happens
      // OUTSIDE the gameplay queue so a queued save that needs the gameplay queue
      // for canonical capture is not deadlocked by detach holding it.
      //
      // Detach is registered as a foreground lifecycle operation so `drainAll`
      // during disposal waits for the entire detach workflow — not only its
      // (nonexistent) FIFO enqueue. Without this, dispose() could drain zero
      // outstanding FIFO work while detach holds a shared city fence and is
      // blocked in the gameplay queue, release the lease, and let a
      // replacement runtime acquire it while the old runtime can still
      // release the fence in its finally.
      detachReserving = true;
      lifecycleTransitionReserved = true;
      detachAdmissionLoadToken = loadRequestToken;
      let foregroundAdmitted = false;
      try {
        foregroundAdmitted = lease!.admitForeground();
        if (!foregroundAdmitted) {
          return runtimeUnavailable("detachActiveCity");
        }
        if (priorCityId !== undefined) {
          acquireCityFence(priorCityId);
        }
        if (priorCityId !== undefined) {
          await cityQueues.drain(priorCityId);
        }
        if (dead) return runtimeUnavailable("detachActiveCity");
        const result = await gameplayQueue.enqueue<
          PersistenceOperationResult<RuntimeSnapshot>
        >({
          operation: async () => {
            sessionToken += 1;
            loadRequestToken += 1;
            activeCity = null;
            currentRevision = 0;
            persistedRevision = 0;
            saveStatus = { state: "idle" };
            loadStatus = { state: "idle" };
            lifecycleStatus = { state: "idle" };
            lastSavedAt = null;
            persistenceError = null;
            const snapshot = publish();
            return { status: "completed", value: snapshot };
          },
          whenDead: () => runtimeUnavailable("detachActiveCity"),
          onThrown: () => runtimeUnavailable("detachActiveCity"),
        });
        return result;
      } finally {
        if (foregroundAdmitted) lease!.releaseForeground();
        detachReserving = false;
        lifecycleTransitionReserved = false;
        if (priorCityId !== undefined) {
          releaseCityFence(priorCityId);
        }
      }
    };

    const persistence: RuntimePersistenceController = {
      saveWorking,
      renameActiveCity,
      load: loadCity,
      detachActiveCity,
      activateNewCity,
      runGameplayWrite,
    };

    const api: RuntimeController & RuntimeTestSeam = {
      persistence,
      getSnapshot,
      subscribe(listener) {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      start() {
        if (dead) return;
        canvasHost.start();
      },
      stop,
      dispose,
      isRunning: () => (dead ? false : canvasHost.isRunning()),
      tick(deltaSeconds) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueTick(deltaSeconds);
      },
      reset() {
        if (dead) return Promise.resolve(getSnapshot());
        if (backendAdmissionReserved) return Promise.resolve(getSnapshot());
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return queueBackend(async () => {
          const result = await backend.reset();
          if (!result.ok) {
            sandboxResetError = result.error;
            return publish();
          }
          const snapshot = result.snapshot;
          sandboxResetError = null;
          backendError = null;
          rejection = null;
          sessionToken += 1;
          loadRequestToken += 1;
          currentRevision = 1;
          persistedRevision = 0;
          saveStatus = { state: "idle" };
          loadStatus = { state: "idle" };
          lifecycleStatus = { state: "idle" };
          persistenceError = null;
          state = normalizeRustSnapshot(snapshot);
          ui = createUiState();
          return publish();
        });
      },
      resetUi() {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return commit(state, createUiState());
      },
      setTool(tool) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        const next = nextToolUiState(tool, ui);
        if (tool === "busRoute" || tool === "metroLine") {
          next.routeDraft = createDraft(
            tool === "busRoute" ? "bus" : "metro",
            nextRouteDraftInstanceId,
          );
          nextRouteDraftInstanceId += 1;
          next.routePreviewError = null;
          next.routePreviewHostError = null;
        }
        return commitWithRoadPreview(next);
      },
      setBuilding(building) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return commit(state, nextBuildingUiState(building, ui));
      },
      setArea(area) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return commit(state, nextAreaUiState(area, ui));
      },
      setRoadPreset(preset) {
        if (dead) return getSnapshot();
        return commitWithRoadPreview(
          ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
        );
      },
      // Pure UI mutation; callers (Build panel drill-down) only invoke this while
      // the Build drawer is open. No guard here, so a direct controller call could
      // leave a non-null buildCategory with Build inactive — unreachable from UI.
      setBuildCategory(category: BuildCategoryId | null) {
        if (dead) return getSnapshot();
        return commit(
          state,
          ui.buildCategory === category
            ? ui
            : { ...ui, buildCategory: category },
        );
      },
      armRoad(preset) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        // Single commit: switch to the road tool (which clears building/area and
        // closes the drawer via nextToolUiState) and set the preset together, so
        // one click fully arms the tool with no intermediate render.
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return commitWithRoadPreview({
          ...nextToolUiState("road", ui),
          roadPreset: preset,
        });
      },
      armRoundabout(size: RoundaboutSize) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        // Roundabouts are fixed click stamps. Switching sizes is one UI commit
        // and invalidates any in-flight road preview so an older footprint can
        // never populate the newly armed stamp.
        clearHoverPreviewTimer();
        previewCoordinator.invalidateRoute();
        invalidateRoadPreview();
        return commitWithRoadPreview({
          ...nextToolUiState("roundabout", ui),
          roundaboutSize: size,
          drag: null,
        });
      },
      startDrag(point) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        // Only drag tools open a gesture; capture the tool so the gesture stays
        // self-describing even if activeTool later changes (a tool switch clears
        // `drag` via nextToolUiState, so the two never drift in practice).
        const tool = ui.activeTool;
        if (tool === "area") {
          if (ui.selectedArea === null) {
            return commit(state, ui);
          }
          return commit(state, {
            ...ui,
            drag: { tool, area: ui.selectedArea, start: point, current: point },
          });
        }
        if (tool !== "road" && tool !== "track" && tool !== "remove") {
          return commit(state, ui);
        }
        return commitWithRoadPreview({
          ...ui,
          drag: { tool, start: point, current: point },
        });
      },
      setDragCurrent(point) {
        if (dead) return getSnapshot();
        // A null (off-map) move is ignored so the preview holds its last tile;
        // the gesture always carries a concrete `current`.
        if (point === null || ui.drag === null) {
          return commit(state, ui);
        }
        if (samePoint(point, ui.drag.current)) {
          return commit(state, ui);
        }
        return commitWithRoadPreview({
          ...ui,
          drag: { ...ui.drag, current: point },
        });
      },
      cancelDrag() {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        invalidateRoadPreview();
        return commit(
          state,
          ui.drag === null
            ? ui
            : {
                ...ui,
                drag: null,
                roadMutationPreview: null,
                roadMutationPreviewError: null,
              },
        );
      },
      commitDrag() {
        if (dead) return Promise.resolve(getSnapshot());
        if (backendAdmissionReserved) return Promise.resolve(getSnapshot());
        const gesture = ui.drag;
        if (gesture === null) {
          return commit(state, ui);
        }
        // Clear the drag synchronously *before* the async backend dispatch. The
        // dispatch resolves later against the latest `ui`; if a new gesture has
        // started in the window it is preserved, and — critically — a stray
        // pointermove during the window finds `ui.drag === null` and updates the
        // hover instead of resurrecting a stale drag that the deferred clear
        // could no longer match by identity.
        const roadPreset = ui.roadPreset;
        invalidateRoadPreview();
        commit(state, {
          ...ui,
          drag: null,
          roadMutationPreview: null,
          roadMutationPreviewError: null,
        });
        if (gesture.tool === "area") {
          return enqueueDispatch({
            type: "paintAreaRectangle",
            area: gesture.area,
            start: gesture.start,
            end: gesture.current,
          });
        }
        const line = axisLockedLine(gesture.start, gesture.current);
        if (line.length <= 1) {
          if (gesture.tool === "road") {
            // A zero-length road drag is a tap: defer the lay-vs-cycle decision
            // to execution time so the tile kind reflects drained queued updates.
            return enqueueComputedDispatch(() => roadClickIntent(line[0]));
          }
          const intent = intentForToolClick(line[0]);
          return intent === null ? commit(state, ui) : enqueueDispatch(intent);
        }
        if (gesture.tool === "remove") {
          return enqueueDispatch({ type: "removeAtTiles", points: line });
        }
        if (gesture.tool === "track") {
          return enqueueDispatch({ type: "layTrackLine", points: line });
        }
        return enqueueDispatch({
          type: "layRoadLine",
          points: line,
          preset: roadPreset,
        });
      },
      rotateBuilding() {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        const currentIndex = rotations.indexOf(ui.buildingRotation);

        return commit(state, {
          ...ui,
          buildingRotation: rotations[(currentIndex + 1) % rotations.length],
        });
      },
      setOverlay(overlay) {
        if (dead) return getSnapshot();
        return commit(
          state,
          overlay === ui.activeOverlay ? ui : { ...ui, activeOverlay: overlay },
        );
      },
      togglePause() {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueComputedDispatch(() => ({
          type: "setPaused",
          paused: !state.paused,
        }));
      },
      setSpeed(speed) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueDispatch({ type: "setSpeed", speed });
      },
      setHudCategory(category) {
        if (dead) return getSnapshot();
        if (category === ui.activeHudCategory) {
          return commit(state, ui);
        }
        // Leaving the Build category resets the drill-down so the next time
        // Build opens it shows the root (spec line 75-76). `buildCategory` is
        // only meaningful while Build is the active category.
        const nextUi =
          category === "build"
            ? { ...ui, activeHudCategory: category }
            : { ...ui, activeHudCategory: category, buildCategory: null };
        return commit(state, nextUi);
      },
      handleTileClick(point) {
        if (dead) return Promise.resolve(getSnapshot());
        if (backendAdmissionReserved) return Promise.resolve(getSnapshot());
        if (ui.routeDraft?.source.kind === "edit") {
          const handleIndex = routeHandleIndexAtPoint(ui.routeDraft, point);
          if (handleIndex !== null) {
            const routeDraft = selectWaypoint(
              ui.routeDraft,
              handleIndex,
              ui.routeDraft.interaction,
            );
            return routeDraft === ui.routeDraft
              ? commit(state, ui)
              : commitRouteDraft(routeDraft);
          }
        }
        if (
          (ui.activeTool === "inspect" && ui.selectedBuilding === null) ||
          ui.activeTool === "busRoute" ||
          ui.activeTool === "metroLine"
        ) {
          const previousDraft = ui.routeDraft;
          const result = applyUiTileClick(state, ui, point);
          if (
            hasPreviewRelevantChange(previousDraft, result.ui.routeDraft) &&
            result.ui.routePreviewError === null
          ) {
            return commitRouteDraft(result.ui.routeDraft!);
          }
          return commit(state, result.ui);
        }

        if (ui.activeTool === "road") {
          // Defer the lay-vs-cycle decision to execution time so the tile kind is
          // re-read against the latest map state after earlier queued updates
          // drain (see `roadClickIntent`). Clear and invalidate any resolved
          // hover preview before enqueueing: the dispatch will change the map, so
          // the old changed-tiles/cost/route-impacts overlay is stale, and
          // invalidating `activeRoadMutation` prevents an in-flight preview
          // response from repopulating it after the click.
          clearHoverPreviewTimer();
          invalidateRoadPreview();
          commit(state, {
            ...ui,
            roadMutationPreview: null,
            roadMutationPreviewError: null,
          });
          return enqueueComputedDispatch(() => roadClickIntent(point));
        }

        if (ui.activeTool === "roundabout") {
          const size = ui.roundaboutSize;
          clearHoverPreviewTimer();
          invalidateRoadPreview();
          commit(state, {
            ...ui,
            roadMutationPreview: null,
            roadMutationPreviewError: null,
          });
          return enqueueDispatch({
            type: "placeRoundabout",
            origin: point,
            size,
          });
        }

        const intent = intentForToolClick(point);
        return intent === null ? commit(state, ui) : enqueueDispatch(intent);
      },
      assignRouteToPlatform(nodeId, routeId, platformId) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueDispatch({
          type: "assignRouteToPlatform",
          nodeId,
          routeId,
          platformId,
        });
      },
      startRouteEdit(routeId) {
        if (dead) return getSnapshot();
        return startRouteEdit(routeId);
      },
      selectRouteWaypoint(index, interaction) {
        if (dead) return getSnapshot();
        if (ui.routeDraft === null) return commit(state, ui);
        const routeDraft = selectWaypoint(ui.routeDraft, index, interaction);
        if (routeDraft !== ui.routeDraft) {
          return commitRouteDraft(routeDraft);
        }
        const invalidIndex =
          index !== null &&
          (index < 0 || index >= ui.routeDraft.waypointIds.length);
        return invalidIndex
          ? rejectRouteDraftInteraction({
              code: "invalidRouteDraftInteraction",
              context: { operation: "selectWaypoint", waypointIndex: index },
            })
          : commit(state, ui);
      },
      removeRouteWaypoint() {
        if (dead) return getSnapshot();
        if (ui.routeDraft === null) return commit(state, ui);
        const selectedIndex = ui.routeDraft.selectedIndex;
        const routeDraft = removeWaypoint(ui.routeDraft);
        return routeDraft === ui.routeDraft
          ? rejectRouteDraftInteraction({
              code: "invalidRouteDraftInteraction",
              context: {
                operation: "removeWaypoint",
                waypointIndex: selectedIndex,
              },
            })
          : commitRouteDraft(routeDraft);
      },
      moveRouteWaypoint(delta) {
        if (dead) return getSnapshot();
        if (ui.routeDraft === null) return commit(state, ui);
        const selectedIndex = ui.routeDraft.selectedIndex;
        const routeDraft = moveWaypoint(ui.routeDraft, delta);
        return routeDraft === ui.routeDraft
          ? rejectRouteDraftInteraction({
              code: "invalidRouteDraftInteraction",
              context: {
                operation: "moveWaypoint",
                waypointIndex: selectedIndex,
                delta,
              },
            })
          : commitRouteDraft(routeDraft);
      },
      reverseRouteDraft() {
        if (dead) return getSnapshot();
        return ui.routeDraft === null
          ? commit(state, ui)
          : commitRouteDraft(reverseRoute(ui.routeDraft));
      },
      setRoutePattern(pattern) {
        if (dead) return getSnapshot();
        return ui.routeDraft === null
          ? commit(state, ui)
          : commitRouteDraft(setPattern(ui.routeDraft, pattern));
      },
      undoRouteDraft() {
        if (dead) return getSnapshot();
        return undoRouteDraft();
      },
      redoRouteDraft() {
        if (dead) return getSnapshot();
        return redoRouteDraft();
      },
      saveRouteDraft() {
        if (dead) return Promise.resolve(getSnapshot());
        return saveRouteDraft();
      },
      cancelRouteDraft() {
        if (dead) return getSnapshot();
        return cancelRouteDraft();
      },
      reloadRouteDraft() {
        if (dead) return getSnapshot();
        return reloadRouteDraft();
      },
      handleEscape() {
        if (dead) return getSnapshot();
        return handleEscape();
      },
      renameRoute(routeId, name) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueDispatch({ type: "renameRoute", routeId, name });
      },
      recolorRoute(routeId, color) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueDispatch({ type: "recolorRoute", routeId, color });
      },
      toggleRouteActive(routeId) {
        if (dead) return Promise.resolve(getSnapshot());
        const route =
          state.transit.routes.find((r) => r.id === routeId) ??
          state.transit.metroLines.find((l) => l.id === routeId);
        if (route === undefined) {
          return commit(state, ui);
        }
        return enqueueComputedDispatch(() => {
          const queuedRoute =
            state.transit.routes.find((r) => r.id === routeId) ??
            state.transit.metroLines.find((l) => l.id === routeId);
          return queuedRoute === undefined
            ? null
            : {
                type: "setRouteActive",
                routeId,
                active: !queuedRoute.active,
              };
        });
      },
      deleteRoute(routeId) {
        if (dead) return Promise.resolve(getSnapshot());
        // Only clear the selection when the backend actually applied the delete;
        // a rejected delete leaves the route in place, so its selection must
        // survive (parity with route Save's `applied` gate).
        return enqueueDispatch(
          { type: "deleteRoute", routeId },
          (applied, currentUi) =>
            applied && currentUi.selectedRouteId === routeId
              ? {
                  ...currentUi,
                  selectedRouteId: null,
                  routeFailureFocus: null,
                }
              : currentUi,
        );
      },
      selectRoute(routeId) {
        if (dead) return getSnapshot();
        const nextId = ui.selectedRouteId === routeId ? null : routeId;
        return commit(
          state,
          nextId === ui.selectedRouteId
            ? ui
            : { ...ui, selectedRouteId: nextId, routeFailureFocus: null },
        );
      },
      focusRouteFailure(routeId, legIndex) {
        if (dead) return getSnapshot();
        return commit(state, {
          ...ui,
          selectedRouteId: routeId,
          routeFailureFocus: { routeId, legIndex },
        });
      },
      setHoverTile(point) {
        if (dead) return getSnapshot();
        if (backendAdmissionReserved) return getSnapshot();
        if (samePoint(point, ui.hoverTile)) {
          return commit(state, ui);
        }
        clearHoverPreviewTimer();
        invalidateRoadPreview();
        // Every hover change (including non-null moves) invalidates generation and
        // clears the cached overlay so a resolved preview cannot stick on a tile
        // with no mutation, and late responses cannot pass a stale generation.
        const generation = ui.roadPreviewGeneration + 1;
        const nextUi: UiState = {
          ...ui,
          hoverTile: point,
          roadPreviewGeneration: generation,
          roadMutationPreview: null,
          roadMutationPreviewError: null,
        };
        if (point === null || dead) {
          return commit(state, nextUi);
        }
        const mutation = roadMutationForUi(nextUi);
        if (mutation === null) {
          return commit(state, nextUi);
        }
        // Debounce the hover-triggered preview so rapid pointermove events
        // coalesce into a single IPC round-trip (important on Tauri). A delay
        // of 0 disables debouncing (used in tests).
        if (hoverPreviewDebounceMs <= 0) {
          const snapshot = commit(state, nextUi);
          sendRoadMutationPreviewRequest(mutation, generation);
          return snapshot;
        }
        // Debounced: commit the cleared hover state now; fire the request after
        // the delay using the generation already reserved for this hover.
        const snapshot = commit(state, nextUi);
        hoverPreviewTimer = setTimeout(() => {
          hoverPreviewTimer = null;
          if (
            dead ||
            previewAdmissionSuspended ||
            ui.roadPreviewGeneration !== generation
          )
            return;
          const currentMutation = roadMutationForUi(ui);
          if (currentMutation === null) return;
          sendRoadMutationPreviewRequest(currentMutation, generation);
        }, hoverPreviewDebounceMs);
        return snapshot;
      },
      previewRoadMutation(mutation) {
        if (dead) return getSnapshot();
        return requestRoadMutationPreview(mutation);
      },
      dismissRejection() {
        if (dead) return getSnapshot();
        if (rejection === null) {
          return commit(state, ui);
        }
        rejection = null;
        return publish();
      },
      debugSetBudget(budget) {
        if (dead) return Promise.resolve(getSnapshot());
        return enqueueDispatch({ type: "setBudget", budget });
      },
      // Test-only seam onto this runtime's per-city persistence FIFO. Lets a
      // harness inject an "older write" for a city that the runtime's own
      // candidate write must serialize behind, without exposing any module-global
      // queue (there is none). Production code never calls this.
      debugEnqueueCityPersistence<T>(
        cityId: string,
        work: () => Promise<T>,
      ): Promise<T> {
        return cityQueues.enqueue(cityId, work);
      },
      mountCanvas: canvasHost.mount,
    };

    // Bootstrap reconciliation failed: the runtime is born terminal (dead,
    // leaseStuck). Rather than returning a frozen runtime that the application
    // cannot distinguish from a healthy one without calling `dispose()`, reject
    // with a typed BootstrapRecoveryError so the application's catch block
    // renders a recovery/error screen immediately. The lease and backend
    // ownership are permanently pinned (startDrainAndRelease skips release
    // when leaseStuck), so a replacement createGameRuntime against the same
    // storage identity or backend engine hangs indefinitely — the user must
    // reconcile the durable storage out of band before retrying. Reload alone
    // only retries bootstrap and does not repair a retained multi-realm
    // pending record.
    if (leaseStuck) {
      void startDrainAndRelease();
      const error = new Error(
        leaseStuckCityId !== null
          ? `Bootstrap reconciliation failed for city ${leaseStuckCityId}`
          : "Bootstrap reconciliation failed",
      ) as Error & BootstrapRecoveryError;
      error.reason = "bootstrapReconciliationFailed";
      error.cityId = leaseStuckCityId;
      // P2: Mark this as an intentional recovery pin so the outer construction
      // catch skips release — the lease is permanently pinned and
      // startDrainAndRelease handled the drain above.
      pinRecovery = true;
      throw error;
    }

    return api;
  } catch (error) {
    // P2: Single cleanup scope for the entire post-acquisition construction
    // phase. An ordinary exception (metadata, configuration, beginRuntime,
    // lease acquisition, bootstrap reconciliation, or any other constructor
    // failure) releases both backend ownership and the persistence lease so
    // a replacement runtime can initialize. An intentional
    // `BootstrapRecoveryError` sets `pinRecovery = true` before throwing, so
    // the lease is permanently pinned and `startDrainAndRelease` (called
    // above in the leaseStuck branch) handles the drain — skip release here.
    if (!pinRecovery) {
      if (lease !== null) {
        try {
          lease.release();
        } catch {
          // Best-effort release — the construction error is the primary
          // diagnostic; a release failure must not mask it.
        }
      }
      backendOwnership.release();
    }
    throw error;
  }
}
