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
import { selectShellState } from "./runtimeSelectors";
import { createSerializedQueue } from "./serializedQueue";
import { normalizeRustSnapshot } from "./snapshotView";
import {
  createCityPersistenceQueues,
  noActiveCity,
  readForLoadSource,
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
): Promise<RuntimeController> {
  const { backend, hoverPreviewDebounceMs = 50, saveStore } = options;
  let state = normalizeRustSnapshot(await backend.snapshot());
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
  const fencedCities = new Map<string, number>();
  const acquireCityFence = (cityId: string): void => {
    fencedCities.set(cityId, (fencedCities.get(cityId) ?? 0) + 1);
  };
  const releaseCityFence = (cityId: string): void => {
    const next = (fencedCities.get(cityId) ?? 0) - 1;
    if (next <= 0) fencedCities.delete(cityId);
    else fencedCities.set(cityId, next);
  };
  const isCityFenced = (cityId: string): boolean => fencedCities.has(cityId);
  // Component teardown is a one-shot lifecycle request, so unlike transient UI
  // intents it cannot be dropped while New City owns admission. The canvas is
  // halted immediately; full preview cleanup is completed once the transaction
  // leaves its protected backend window.
  let stopRequestedDuringReservation = false;
  const gameplayQueue = createSerializedQueue(() => dead);
  // Per-city persistence FIFOs are owned by THIS runtime instance, not a
  // module-global map. See `createCityPersistenceQueues` for the
  // single-runtime-per-store invariant that keeps these instance-local.
  const cityQueues = createCityPersistenceQueues();
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

  const publish = (): RuntimeSnapshot => {
    const snapshot = getSnapshot();
    canvasHost.render();
    canvasHost.syncAnimationLoop();

    for (const listener of listeners) {
      listener(snapshot);
    }

    return snapshot;
  };

  const commit = (nextState = state, nextUi = ui): RuntimeSnapshot => {
    const changed = nextState !== state || nextUi !== ui;
    state = nextState;
    ui = nextUi;

    if (!changed) {
      canvasHost.render();
      canvasHost.syncAnimationLoop();
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
    return commit(state, clearedUi);
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
    const routeId = draft.source.kind === "edit" ? draft.source.routeId : null;
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
        past: [...ui.routeDraftHistory.past, checkpointRouteDraft(draft)].slice(
          -ROUTE_DRAFT_HISTORY_LIMIT,
        ),
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
      cityCreatedAt: envelope.cityCreatedAt,
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
        publishWorkingSaveFailure(city.id, capturedSessionToken, capture.error);
        return capture;
      }

      let savedAt: string;
      let envelope: ReturnType<typeof buildSaveEnvelope>;
      try {
        savedAt = now();
        envelope = buildSaveEnvelope({
          city: { id: city.id, name: city.name },
          cityCreatedAt: city.cityCreatedAt,
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
        publishWorkingSaveFailure(city.id, capturedSessionToken, result.error);
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
            diagnostic: error instanceof Error ? error.message : String(error),
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
        publishWorkingSaveFailure(city.id, capturedSessionToken, result.error);
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
    if (dead) return Promise.resolve(runtimeUnavailable(coordinatorOperation));
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
      const result: PersistenceOperationResult<GenerationWriteValue<TSummary>> =
        noActiveCity(coordinatorOperation);
      if (result.status === "failed") persistenceError = result.error;
      publish();
      return Promise.resolve(result);
    }
    if (options.now === undefined || options.appVersion === undefined) {
      const result: PersistenceOperationResult<GenerationWriteValue<TSummary>> =
        {
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

      const capture = await gameplayQueue.enqueue<GenerationWriteCaptureResult>(
        {
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
        },
      );

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
          cityCreatedAt: city.cityCreatedAt,
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
        saveStatus = { state: "writing", kind: request.kind, cityId: city.id };
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
            diagnostic: error instanceof Error ? error.message : String(error),
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
            diagnostic: error instanceof Error ? error.message : String(error),
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
    if (detachReserving && requestToken > detachAdmissionLoadToken) return true;
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
          // form a lock cycle: the persistence FIFOs are owned by THIS runtime
          // instance (see `cityQueues` / `createCityPersistenceQueues`), so no
          // other runtime can hold the former city's FIFO while we await it.
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

        return gameplayQueue.enqueue<PersistenceOperationResult<LoadCityValue>>(
          {
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
          },
        );
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
    if (
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
    lifecycleStatus = { state: "rollingBack" };
    publish();

    let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
    try {
      restored = await backend.restoreSnapshot({
        snapshot: priorCanonicalSnapshot,
      });
    } catch (error: unknown) {
      failRollbackCoherence(error);
      return runtimeUnavailable("activateNewCity");
    }
    if (!restored.ok) {
      failRollbackCoherence(restored.error);
      return runtimeUnavailable("activateNewCity");
    }

    try {
      const pause = await backend.dispatch({
        type: "setPaused",
        paused: prior.paused,
      });
      if (pause.snapshot.paused !== prior.paused) {
        throw new Error("Rollback pause restoration did not take effect");
      }
    } catch (error: unknown) {
      failRollbackCoherence(error);
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

  const activateNewCity = async (
    requestedSandbox: SandboxCreationRequest,
    requestedIdentity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>> => {
    if (dead) return runtimeUnavailable("activateNewCity");
    if (backendAdmissionReserved) return { status: "superseded" };
    if (lifecycleTransitionReserved) return { status: "superseded" };
    if (saveStore === undefined) {
      return unavailableStoreResult("writeWorkingSave");
    }
    if (options.now === undefined || options.appVersion === undefined) {
      const result: PersistenceOperationResult<LoadCityValue> = {
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "writeWorkingSave",
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

    try {
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
        const failure = persistenceHostFailure("snapshotForSave", error);
        restoreNewCityPriorRuntime(prior);
        publish();
        resumeNewCityPriorPreviews(prior);
        return { status: "failed", error: failure };
      }
      if (!priorCapture.ok) {
        const failure: PersistenceCoordinatorError = {
          kind: "backend",
          error: priorCapture.error,
        };
        restoreNewCityPriorRuntime(prior);
        publish();
        resumeNewCityPriorPreviews(prior);
        return { status: "failed", error: failure };
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
            diagnostic: error instanceof Error ? error.message : String(error),
          },
        });
      }
      if (!created.ok) {
        restoreNewCityPriorRuntime(prior);
        publish();
        resumeNewCityPriorPreviews(prior);
        return {
          status: "failed",
          error: { kind: "sandbox", error: created.error },
        };
      }

      let candidateCapture: Awaited<ReturnType<GameBackend["snapshotForSave"]>>;
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

      let savedAt: string;
      let envelope: ReturnType<typeof buildSaveEnvelope>;
      try {
        savedAt = now();
        envelope = buildSaveEnvelope({
          city: { id: identity.id, name: identity.name },
          cityCreatedAt: identity.cityCreatedAt,
          savedAt,
          appVersion,
          snapshot: candidateCapture.snapshot,
        });
      } catch (error: unknown) {
        return await rollbackNewCity(prior, priorCapture.snapshot, {
          kind: "store",
          error: {
            operation: "writeWorkingSave",
            code: "serializationFailed",
            cityId: identity.id,
            retryable: false,
            diagnostic: error instanceof Error ? error.message : String(error),
          },
        });
      }

      let stored: Awaited<ReturnType<SaveStore["writeWorkingSave"]>>;
      try {
        stored = await cityQueues.enqueue(identity.id, () =>
          saveStore.writeWorkingSave(envelope),
        );
      } catch (error: unknown) {
        stored = {
          ok: false,
          error: {
            operation: "writeWorkingSave",
            code: "ioFailure",
            cityId: identity.id,
            retryable: true,
            diagnostic: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (!stored.ok) {
        return await rollbackNewCity(prior, priorCapture.snapshot, {
          kind: "store",
          error: stored.error,
        });
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
    detachReserving = true;
    lifecycleTransitionReserved = true;
    detachAdmissionLoadToken = loadRequestToken;
    if (priorCityId !== undefined) {
      acquireCityFence(priorCityId);
    }
    try {
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

  const api: RuntimeController = {
    persistence,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    start: canvasHost.start,
    stop,
    isRunning: canvasHost.isRunning,
    tick(deltaSeconds) {
      return enqueueTick(deltaSeconds);
    },
    reset() {
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
      if (backendAdmissionReserved) return getSnapshot();
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, createUiState());
    },
    setTool(tool) {
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
      if (backendAdmissionReserved) return getSnapshot();
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextBuildingUiState(building, ui));
    },
    setArea(area) {
      if (backendAdmissionReserved) return getSnapshot();
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextAreaUiState(area, ui));
    },
    setRoadPreset(preset) {
      return commitWithRoadPreview(
        ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
      );
    },
    // Pure UI mutation; callers (Build panel drill-down) only invoke this while
    // the Build drawer is open. No guard here, so a direct controller call could
    // leave a non-null buildCategory with Build inactive — unreachable from UI.
    setBuildCategory(category: BuildCategoryId | null) {
      return commit(
        state,
        ui.buildCategory === category ? ui : { ...ui, buildCategory: category },
      );
    },
    armRoad(preset) {
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
      if (backendAdmissionReserved) return getSnapshot();
      const currentIndex = rotations.indexOf(ui.buildingRotation);

      return commit(state, {
        ...ui,
        buildingRotation: rotations[(currentIndex + 1) % rotations.length],
      });
    },
    setOverlay(overlay) {
      return commit(
        state,
        overlay === ui.activeOverlay ? ui : { ...ui, activeOverlay: overlay },
      );
    },
    togglePause() {
      return enqueueComputedDispatch(() => ({
        type: "setPaused",
        paused: !state.paused,
      }));
    },
    setSpeed(speed) {
      return enqueueDispatch({ type: "setSpeed", speed });
    },
    setHudCategory(category) {
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
      return enqueueDispatch({
        type: "assignRouteToPlatform",
        nodeId,
        routeId,
        platformId,
      });
    },
    startRouteEdit,
    selectRouteWaypoint(index, interaction) {
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
      return ui.routeDraft === null
        ? commit(state, ui)
        : commitRouteDraft(reverseRoute(ui.routeDraft));
    },
    setRoutePattern(pattern) {
      return ui.routeDraft === null
        ? commit(state, ui)
        : commitRouteDraft(setPattern(ui.routeDraft, pattern));
    },
    undoRouteDraft,
    redoRouteDraft,
    saveRouteDraft,
    cancelRouteDraft,
    reloadRouteDraft,
    handleEscape,
    renameRoute(routeId, name) {
      return enqueueDispatch({ type: "renameRoute", routeId, name });
    },
    recolorRoute(routeId, color) {
      return enqueueDispatch({ type: "recolorRoute", routeId, color });
    },
    toggleRouteActive(routeId) {
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
      const nextId = ui.selectedRouteId === routeId ? null : routeId;
      return commit(
        state,
        nextId === ui.selectedRouteId
          ? ui
          : { ...ui, selectedRouteId: nextId, routeFailureFocus: null },
      );
    },
    focusRouteFailure(routeId, legIndex) {
      return commit(state, {
        ...ui,
        selectedRouteId: routeId,
        routeFailureFocus: { routeId, legIndex },
      });
    },
    setHoverTile(point) {
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
      return requestRoadMutationPreview(mutation);
    },
    dismissRejection() {
      if (rejection === null) {
        return commit(state, ui);
      }
      rejection = null;
      return publish();
    },
    debugSetBudget(budget) {
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
}
