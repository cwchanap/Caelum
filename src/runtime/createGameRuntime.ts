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
  CitySaveRecord,
  CitySaveStore,
  CitySaveStoreOperation,
  CitySaveStoreResult,
  CitySummary,
} from "../persistence/citySaveStore";
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
  noActiveCity,
  resolvePersistenceSessionCompletion,
  resolveWorkingSaveCompletion,
  runtimeUnavailable,
  type ActiveCityIdentity,
  type LoadCityValue,
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
} from "./persistenceCoordinator";
import type {
  RuntimeController,
  RuntimeListener,
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
  saveStore?: CitySaveStore;
  now?: () => string;
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
  // Acquire exclusive backend ownership BEFORE the initial snapshot. The
  // Tauri backend is process-global (one `Mutex<GameEngine>` shared by every
  // facade), and a replacement runtime that reads `backend.snapshot()` before
  // the old runtime's backend operations have settled can observe a stale or
  // mid-mutation snapshot. The persistence lease alone cannot prevent this
  // because a runtime may have no city save store, two stores may address one
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
  // Protect the entire post-acquisition construction phase with one cleanup
  // scope so construction failures release both capabilities.
  let lease: PersistenceLease | null = null;
  let state: ReturnType<typeof normalizeRustSnapshot>;
  try {
    // P1: Use `beginRuntime()` for the atomic epoch + initial snapshot. When
    // the backend does not expose `beginRuntime` (e.g. test mocks), fall back
    // to `snapshot()` with epoch 0 — no epoch verification occurs.
    const session = backend.beginRuntime
      ? await backend.beginRuntime()
      : { runtimeEpoch: 0, snapshot: await backend.snapshot() };
    state = normalizeRustSnapshot(session.snapshot);
    // Construct this runtime's persistence coordinator and acquire the
    // exclusive ownership lease. Each runtime owns its own coordinator —
    // coordination is per-runtime, not shared across stores or runtime
    // lifetimes — so the lease serializes this runtime's own persistence
    // workflows (foreground lifecycle operations and per-city FIFO writes).
    const coordinator = createSharedPersistenceCoordinator();
    lease = await coordinator.acquireLease();
    // Track the drain-and-release promise so both `failBackend` (fire-and-
    // forget) and `dispose()` (awaited) share one release. Idempotent: the
    // second caller awaits the same promise the first caller started.
    // The lease is marked closing before draining so no new foreground work
    // or FIFO enqueues can be admitted through this lease while disposal
    // waits for already-admitted work to settle.
    let drainAndReleasePromise: Promise<void> | null = null;
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
        .then(() => lease!.release())
        .then(() => backendOwnership.release())
        .catch(() => {
          lease!.release();
          backendOwnership.release();
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
    // Once the backend has failed fatally, no further dispatches or ticks are
    // attempted. `failBackend` sets this; `queueBackend` short-circuits on it so
    // user-initiated intents after a fatal error do not reach a dead backend.
    let dead = false;
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
    // persistence admission fenced: new city writes and renames
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
    // Fences live on this runtime's own coordinator (constructed per
    // `createGameRuntime` instance); they do not persist across runtime
    // lifetimes and are not keyed by storage identity. Because the lease is
    // exclusive, only this runtime can modify fences during its lifetime.
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
    // Per-city persistence FIFOs live on this runtime's own coordinator
    // (constructed per `createGameRuntime` instance) and are reached through
    // the lease's `enqueue`/`drain`. They do not persist across runtime
    // lifetimes and are not keyed by storage identity. Because the lease is
    // exclusive, only this runtime can enqueue work during its lifetime.
    // See `SharedPersistenceCoordinator` for the ownership model.
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
    // one-shot transition snapshot (backendError) has already been
    // pushed to listeners. The terminal transition must publish exactly once
    // so App's `setSnapshot` observes the terminal state and renders the shell
    // error screen — `publish()`'s `!dead` guard would otherwise suppress it.
    // Explicit `dispose()` must NOT publish: unmount teardown must not emit a
    // stale UI update, and a runtime that is already terminal via
    // `failBackend` has already delivered its terminal snapshot.
    let terminalPublished = false;
    // Set synchronously when `dispose()` begins. Distinguishes a fatal
    // transition on a LIVE runtime (subscriber notification is required so
    // App's `setSnapshot` renders the shell error) from a fatal state
    // discovered DURING teardown (no subscriber notification because disposal
    // is the lifecycle owner's channel). `failBackend`
    // does NOT set this: it is a fatal transition on a live runtime and must
    // publish exactly once (its own `publishTerminalSnapshot` call), after
    // which `terminalPublished` suppresses any later terminal publication.
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
    // from the terminal transition (`failBackend`) after all terminal state
    // (backendError, cleared UI, bumped tokens) has been installed and the
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
      // Fire-and-forget: drain this runtime's pending gameplay and persistence
      // work (in-flight backend operations, enqueued FIFO writes, and admitted
      // foreground lifecycle operations), then release its runtime-local
      // persistence lease and backend ownership. If an uncancellable store or
      // backend operation never settles, teardown remains pending.
      void startDrainAndRelease();
      // Install the cleared UI. When disposal has been explicitly requested,
      // a late backend failure must NOT publish a terminal snapshot: disposal
      // is the lifecycle owner's channel during teardown, not a stale UI
      // update. The runtime remains terminal (dead, backendError recorded),
      // ownership draining proceeds, but no render, animation sync, or
      // subscriber notification occurs. A LIVE runtime (no disposal
      // requested) still publishes exactly once so App's `setSnapshot` observes
      // `backendError` and renders the shell error screen.
      ui = clearedUi;
      return disposalRequested ? getSnapshot() : publishTerminalSnapshot();
    };

    const dispose = async (): Promise<void> => {
      disposalRequested = true;
      if (dead) {
        await startDrainAndRelease();
        return;
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
      city: CitySaveRecord["city"],
      savedAt: string,
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
        ...city,
      };
      sessionToken += 1;
      currentRevision = 0;
      persistedRevision = 0;
      saveStatus = { state: "idle" };
      loadStatus = { state: "idle" };
      lifecycleStatus = { state: "idle" };
      lastSavedAt = savedAt;
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
      operation: CitySaveStoreOperation,
    ): PersistenceOperationResult<T> => {
      const result: PersistenceOperationResult<T> = {
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation,
            code: "failed",
            diagnostic: "No CitySaveStore is configured",
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
        return Promise.resolve(unavailableStoreResult("updateCity"));
      }
      if (activeCity === null) {
        const result: PersistenceOperationResult<SaveWorkingValue> =
          noActiveCity("saveWorking");
        if (result.status === "failed") persistenceError = result.error;
        publish();
        return Promise.resolve(result);
      }
      if (options.now === undefined) {
        const result: PersistenceOperationResult<SaveWorkingValue> = {
          status: "failed",
          error: {
            kind: "store",
            error: {
              operation: "updateCity",
              code: "failed",
              cityId: activeCity.id,
              diagnostic: "Save clock is not configured",
            },
          },
        };
        persistenceError = result.error;
        saveStatus = { state: "idle" };
        publish();
        return Promise.resolve(result);
      }

      const now = options.now;
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
        try {
          savedAt = now();
        } catch (error: unknown) {
          const result: PersistenceOperationResult<SaveWorkingValue> = {
            status: "failed",
            error: {
              kind: "store",
              error: {
                operation: "updateCity",
                code: "failed",
                cityId: city.id,
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

        let stored: CitySaveStoreResult<CitySummary>;
        try {
          stored = await saveStore.updateCity(city.id, {
            savedAt,
            snapshot: capture.snapshot,
          });
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "updateCity",
              code: "failed",
              cityId: city.id,
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

        let stored: CitySaveStoreResult<CitySummary>;
        try {
          stored = await saveStore.renameCity(city.id, name);
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "renameCity",
              code: "failed",
              cityId: city.id,
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
        activeCity = { ...liveCity, name: stored.value.name };
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
      cityId: string,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      if (dead) return runtimeUnavailable("loadCity");
      if (saveStore === undefined) {
        return unavailableStoreResult("readCity");
      }

      const requestToken = ++loadRequestToken;
      if (loadSupersededByAdmission(requestToken)) {
        return { status: "superseded" };
      }
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
        priorCityId !== undefined && priorCityId !== cityId;
      if (switchingCities) {
        acquireCityFence(priorCityId);
      }
      publishLoadTransition(requestToken, { state: "reading", cityId }, null);

      // Serialize the read and restore with the target city's persistence FIFO
      // so a same-city load cannot overtake a delayed save. The save captures
      // revision B and enters the FIFO first; the load's read waits behind it
      // and reads revision B (not the older revision A). Without this ordering,
      // the load could read revision A, commit it clean, and the delayed save
      // would then write revision B and return superseded — leaving runtime at
      // revision A with dirty === false while storage holds revision B.
      try {
        return await cityQueues.enqueue(cityId, async () => {
          if (dead) return runtimeUnavailable("loadCity");
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
            if (dead) return runtimeUnavailable("loadCity");
            if (loadSupersededByAdmission(requestToken)) {
              return { status: "superseded" };
            }
          }

          let stored: CitySaveStoreResult<CitySaveRecord>;
          try {
            stored = await saveStore.readCity(cityId);
          } catch (error: unknown) {
            stored = {
              ok: false,
              error: {
                operation: "readCity",
                code: "failed",
                cityId,
                diagnostic:
                  error instanceof Error ? error.message : String(error),
              },
            };
          }

          if (dead) return runtimeUnavailable("loadCity");
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

          // Capture the narrowed successful record so the serialized restore
          // closure below reads a `const` `CitySaveRecord` instead of the
          // `let` `stored` (whose `ok` narrowing does not propagate into the
          // nested async closure).
          const record = stored.value;

          publishLoadTransition(
            requestToken,
            { state: "restoring", cityId },
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
                  snapshot: record.snapshot,
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
                  return runtimeUnavailable("loadCity");
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
                  return runtimeUnavailable("loadCity");
                }
                return { status: "superseded" };
              }
              const snapshot = commitLoadedSnapshot(
                restored.snapshot,
                record.city,
                record.savedAt,
              );
              return { status: "completed", value: { snapshot, cityId } };
            },
            whenDead: () => runtimeUnavailable("loadCity"),
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
        if (switchingCities) releaseCityFence(priorCityId);
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

    // Disposal-time late-success cleanup: an atomic city create succeeded
    // after disposal began. Restore the prior canonical backend state, make
    // one direct deleteCity attempt for the orphaned city record, and keep the
    // runtime terminal. Return a concise cleanup failure when cleanup fails;
    // otherwise return runtimeUnavailable.
    const cleanupLateSuccessNewCity = async (
      priorPaused: boolean,
      priorCanonicalSnapshot: RustGameSnapshot,
      identity: NewCityIdentity,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      const restored = await restoreCanonicalBackendState(
        priorCanonicalSnapshot,
        priorPaused,
      );

      let deleted: CitySaveStoreResult<void>;
      try {
        deleted = await saveStore!.deleteCity(identity.id);
      } catch (error: unknown) {
        deleted = {
          ok: false,
          error: {
            operation: "deleteCity",
            code: "failed",
            cityId: identity.id,
            diagnostic: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (!restored.ok) {
        return {
          status: "failed",
          error: {
            kind: "backend",
            error: {
              kind: "host",
              operation: "restoreSnapshot",
              code: "invokeFailed",
              diagnostic: String(restored.error),
            },
          },
        };
      }
      if (!deleted.ok) {
        return {
          status: "failed",
          error: { kind: "store", error: deleted.error },
        };
      }

      return runtimeUnavailable("activateNewCity");
    };

    const activateNewCity = async (
      requestedSandbox: SandboxCreationRequest,
      requestedIdentity: NewCityIdentity,
    ): Promise<PersistenceOperationResult<LoadCityValue>> => {
      if (dead) return runtimeUnavailable("activateNewCity");
      if (backendAdmissionReserved) return { status: "superseded" };
      if (lifecycleTransitionReserved) return { status: "superseded" };
      if (saveStore === undefined) {
        return unavailableStoreResult("createCity");
      }
      if (options.now === undefined) {
        const result: PersistenceOperationResult<LoadCityValue> = {
          status: "failed",
          error: {
            kind: "store",
            error: {
              operation: "createCity",
              code: "failed",
              cityId: requestedIdentity.id,
              diagnostic: "Save clock is not configured",
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
        try {
          savedAt = now();
        } catch (error: unknown) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "store",
            error: {
              operation: "createCity",
              cityId: identity.id,
              code: "failed",
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          });
        }

        // Dead check immediately before the store enqueue: if disposal
        // occurred while building the CitySaveRecord (synchronous, but defense
        // in depth), do not write. The candidate is installed, so rollback.
        if (dead) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "precondition",
            error: { code: "runtimeUnavailable", operation: "activateNewCity" },
          });
        }

        const record: CitySaveRecord = {
          city: {
            id: identity.id,
            name: identity.name,
            createdAt: identity.createdAt,
          },
          savedAt,
          snapshot: candidateCapture.snapshot,
        };
        let stored: CitySaveStoreResult<CitySummary>;
        try {
          stored = await cityQueues.enqueue(identity.id, () =>
            saveStore.createCity(record),
          );
        } catch (error: unknown) {
          stored = {
            ok: false,
            error: {
              operation: "createCity",
              code: "failed",
              cityId: identity.id,
              diagnostic:
                error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (!stored.ok) {
          return await rollbackNewCity(prior, priorCapture.snapshot, {
            kind: "store",
            error: stored.error,
          });
        }
        // A create that completes after disposal began must be rolled back and
        // deleted once. The runtime remains terminal and does not publish the
        // candidate.
        if (dead) {
          return await cleanupLateSuccessNewCity(
            prior.paused,
            priorCapture.snapshot,
            identity,
          );
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
        return {
          status: "completed",
          value: { snapshot, cityId: identity.id },
        };
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

    return api;
  } catch (error) {
    if (lease !== null) {
      try {
        lease.release();
      } catch {
        // Best-effort release — the construction error is the primary
        // diagnostic; a release failure must not mask it.
      }
    }
    backendOwnership.release();
    throw error;
  }
}
