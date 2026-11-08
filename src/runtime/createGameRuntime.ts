import {
  samePoint,
  type AreaKind,
  type BuildingType,
  type GameState,
  type GameplayRejection,
  type Point,
  type RoundaboutSize,
  type Tool,
} from "../domain/types";
import type { BuildGroup } from "../domain/catalog/buildGroups";
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
import {
  dragMutationPoints,
  roadClickIntent,
  roadMutationForUi,
} from "./roadMutations";
import {
  clearRoadMutationPreview,
  createUiState,
  type CommandDestination,
  type RouteDraftCheckpoint,
  type RouteDraftHistory,
  type UiState,
} from "../ui/uiState";
import type {
  GameBackend,
  GameIntent,
  GameplayUpdateResult,
  PresentationUpdate,
  RoadMutation,
  SandboxResetError,
} from "./backend";
import type { CitySaveStore, CitySummary } from "../persistence/citySaveStore";
import {
  createWebGpuHost,
  type CreateGameHost,
  type WebGpuHostContext,
} from "./createWebGpuHost";
import type { Camera } from "../render/boardTransform";
import { createPreviewCoordinator } from "./previewCoordinator";
import { selectShellState } from "./runtimeSelectors";
import { createSerializedQueue } from "./serializedQueue";
import { applyPresentationUpdate } from "./presentationView";
import { createWorkingSaveRuntime } from "./workingSaveRuntime";
import type {
  RuntimeController,
  RuntimeListener,
  RuntimeSnapshot,
  RuntimeTestSeam,
} from "./types";

const rotations = [0, 90, 180, 270] as const;
const ROUTE_DRAFT_HISTORY_LIMIT = 100;
// These intents only move frame fields (clock, speed, budget); the scene
// they carry cannot change what a route preview reads, so they must not
// churn an open draft's preview request.
const ROUTE_PREVIEW_NEUTRAL_INTENTS = new Set<GameIntent["type"]>([
  "setPaused",
  "setSpeed",
  "setBudget",
]);
const ROAD_MUTATION_INTENT_TYPES = new Set<GameIntent["type"]>([
  "layRoad",
  "layRoadLine",
  "cycleRoadDirection",
  "placeRoundabout",
  "layTrack",
  "layTrackLine",
  "removeAtTile",
  "removeAtTiles",
]);

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

/** Resolves a physically present stop/station by id, so focused navigation
 *  can never select a tombstone footprint. */
function presentNodeAt(
  state: GameState,
  nodeId: string,
): { position: Point; kind: "stop" | "station" } | null {
  const stop = state.transit.stops.find((candidate) => candidate.id === nodeId);
  if (stop !== undefined && stop.status === "present") {
    return { position: stop.position, kind: "stop" };
  }
  const station = state.transit.stations.find(
    (candidate) => candidate.id === nodeId,
  );
  if (station !== undefined && station.status === "present") {
    return { position: station.position, kind: "station" };
  }
  return null;
}

export interface CreateGameRuntimeOptions {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity?: CitySummary | null;
  now?: () => string;
  createCityId?: () => string;
  /** Trailing debounce delay for hover-triggered road mutation previews, in
   *  milliseconds. Defaults to 50ms to coalesce rapid pointermove events on
   *  Tauri (IPC round-trip per event). Set to 0 to disable debouncing. */
  hoverPreviewDebounceMs?: number;
  /** Async display-host factory. Production defaults to `createWebGpuHost`;
   *  Node/jsdom tests inject a fake host so no WebGPU device is required. */
  createHost?: CreateGameHost;
}

function nextToolUiState(activeTool: Tool, current = createUiState()): UiState {
  return {
    ...current,
    activeTool,
    selectedId: activeTool === "inspect" ? current.selectedId : null,
    selectedNodeKind:
      activeTool === "inspect" ? current.selectedNodeKind : null,
    selectedVehicleId:
      activeTool === "inspect" ? current.selectedVehicleId : null,
    selectedBuilding: null,
    selectedArea: null,
    activeBuildGroup: null,
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
    roadMutationPreviewPending: false,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeCommandDestination: null,
  };
}

function nextAreaUiState(area: AreaKind, current = createUiState()): UiState {
  return {
    ...current,
    activeTool: "area" as const,
    selectedId: null,
    selectedNodeKind: null,
    selectedVehicleId: null,
    selectedBuilding: null,
    selectedArea: area,
    activeBuildGroup: null,
    buildingRotation: 0 as const,
    routeDraft: null,
    routeDraftHistory: emptyRouteDraftHistory(),
    routeDraftNotice: null,
    routePreviewError: null,
    routePreviewHostError: null,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    roadMutationPreviewPending: false,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeCommandDestination: null,
  };
}

function nextBuildingUiState(
  selectedBuilding: BuildingType,
  current = createUiState(),
): UiState {
  return {
    ...current,
    activeTool: "inspect" as const,
    selectedId: null,
    selectedNodeKind: null,
    selectedVehicleId: null,
    selectedBuilding,
    selectedArea: null,
    activeBuildGroup: null,
    buildingRotation: 0 as const,
    routeDraft: null,
    routeDraftHistory: emptyRouteDraftHistory(),
    routeDraftNotice: null,
    routePreviewError: null,
    routePreviewHostError: null,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    roadMutationPreviewPending: false,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeCommandDestination: null,
  };
}

export async function createGameRuntime(
  options: CreateGameRuntimeOptions,
): Promise<RuntimeController & RuntimeTestSeam> {
  const { backend, hoverPreviewDebounceMs = 50, saveStore } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const createCityId =
    options.createCityId ?? (() => globalThis.crypto.randomUUID());
  // Structural-scene revision: bumped only when an accepted update carries a
  // scene. All acceptance (initial, dispatch, restore, reset) funnels through
  // one helper so the display host sees exactly one increment per structural
  // change; frame-only ticks leave it untouched.
  let sceneRevision = 0;
  const acceptPresentationUpdate = (
    current: GameState | null,
    update: PresentationUpdate,
  ): GameState => {
    if (update.scene !== null) sceneRevision += 1;
    return applyPresentationUpdate(current, update);
  };
  let state = acceptPresentationUpdate(null, await backend.presentation());
  let ui = createUiState();
  let camera: Camera | null = null;
  let backendError: string | null = null;
  let rejection: GameplayRejection | null = null;
  let sandboxResetError: SandboxResetError | null = null;
  const previewCoordinator = createPreviewCoordinator(backend);
  let nextRouteDraftInstanceId = 1;
  const activeRouteSaveTokens = new Set<string>();
  let activeRoadMutation: RoadMutation | null = null;
  let hoverPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  // Set when a world-changing update wants the armed hover preview
  // re-issued. Instead of one IPC per applied tick, the mark collapses a
  // burst into one trailing request; any fresh request (or invalidation)
  // resolves it.
  let roadPreviewStale = false;
  // Preview requests run outside the gameplay queue, so they need their own
  // runtime epoch when a foreground transaction temporarily replaces the
  // backend snapshot. Responses from an older epoch cannot publish into a
  // restored or newly activated runtime.
  let previewRuntimeEpoch = 0;
  // Once the backend has failed fatally, no further dispatches or ticks are
  // attempted. `failBackend` sets this; `queueBackend` short-circuits on it so
  // user-initiated intents after a fatal error do not reach a dead backend.
  let dead = false;
  const gameplayQueue = createSerializedQueue(() => dead);
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui, rejection),
    persistence: workingSave.getView(),
    backendError,
    rejection,
    sandboxResetError,
    camera,
  });

  // The GPU display host, pointer input, and animation cadence live in a
  // dedicated host module. The host reads runtime state through these getters
  // and forwards DOM pointer events back into the controller via callbacks —
  // it never mutates game/UI state directly. `api` is referenced lazily inside
  // the callbacks (the host only invokes them after `mount`/`start`, by which
  // point `api` is initialized), mirroring the prior `frame` -> `api.tick`
  // forward reference. `onTick` returns the tick promise so the host can keep
  // its one-in-flight 10 Hz admission gate.
  const hostContext: WebGpuHostContext = {
    getState: () => state,
    getUi: () => ui,
    getCamera: () => camera,
    getSceneRevision: () => sceneRevision,
    onTick: (deltaSeconds) => api.tick(deltaSeconds),
    onTileClick: (point, pick) => {
      api.handleTileClick(point, pick);
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
    onCameraChange: (next) => {
      if (dead) return;
      camera = next;
      publish();
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
    onFatalError: (error) => {
      void failBackend(error);
    },
  };
  const gameHost = await (options.createHost ?? createWebGpuHost)(hostContext);

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
      // Sync the animation loop BEFORE rendering: on a running→paused (or
      // speed-0) transition the loop must cancel its pending rAF first, or
      // render() coalesces into that rAF and the sync then cancels it — the
      // final paused frame would never draw. While running, the sync is a
      // no-op and render() still coalesces (no double-draw).
      gameHost.syncAnimationLoop();
      gameHost.render();
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
    // Stop the loop first, then render once: the stopped host schedules a
    // one-shot frame draw instead of coalescing into a dead rAF loop.
    gameHost.stop();
    gameHost.render();
    for (const listener of listeners) {
      listener(snapshot);
    }
    terminalPublished = true;
    return snapshot;
  };

  const commit = (
    nextState = state,
    nextUi = ui,
    nextCamera?: Camera | null,
  ): RuntimeSnapshot => {
    if (
      nextUi.selectedVehicleId !== null &&
      !nextState.transit.vehicles.some(
        (candidate) => candidate.id === nextUi.selectedVehicleId,
      )
    ) {
      // The selected vehicle no longer exists in the incoming state — retired
      // by the simulation, or this is a different city's state where the same
      // id now names another vehicle (the core allocates ids as max+1). Keeping
      // the id would let Inspect present a different vehicle than the player
      // clicked.
      nextUi = {
        ...nextUi,
        selectedId: null,
        selectedNodeKind: null,
        selectedVehicleId: null,
      };
    }
    const cameraChanged = nextCamera !== undefined && nextCamera !== camera;
    const changed = nextState !== state || nextUi !== ui || cameraChanged;
    state = nextState;
    ui = nextUi;
    if (cameraChanged) {
      camera = nextCamera;
    }

    if (!changed) {
      if (!dead) {
        // Same sync-before-render order as publish(): a paused/stopped commit
        // must draw immediately, a running commit must only coalesce.
        gameHost.syncAnimationLoop();
        gameHost.render();
      }
      return getSnapshot();
    }

    return publish();
  };

  const commitDispatchResult = (
    result: GameplayUpdateResult,
    nextUi: UiState,
    intent?: GameIntent,
  ): RuntimeSnapshot => {
    if (result.applied) {
      workingSave.markDirty();
    }
    const nextState = acceptPresentationUpdate(state, result.update);
    if (intent !== undefined) {
      const notice =
        result.applied && intent.type === "cycleRoadDirection"
          ? {
              direction:
                nextState.map.tiles.find((tile) =>
                  samePoint(tile, intent.point),
                )?.oneWay ?? null,
              brokenRouteNames: nextState.transit.routes
                .filter(
                  (route) =>
                    route.pathBroken &&
                    state.transit.routes.find(
                      (previous) => previous.id === route.id,
                    )?.pathBroken === false,
                )
                .map((route) => route.name),
            }
          : // A later dispatch clears the notice — but only once the feedback
            // strip could show it. While a route draft keeps it hidden, the
            // recorded notice stays until it surfaces on close or is
            // explicitly dismissed; an unrelated speed/pause dispatch must not
            // silently discard it.
            ui.routeDraft !== null
            ? nextUi.roadDirectionNotice
            : null;
      if (nextUi.roadDirectionNotice !== notice) {
        nextUi = { ...nextUi, roadDirectionNotice: notice };
      }
    }
    // A dispatch carrying a scene can invalidate an open draft's preview: the
    // edited route's revision may have moved (e.g. a queued direction cycle
    // re-broke its legs) or the route may be gone entirely. Re-request inside
    // the same commit so stale state surfaces as `routeChangedWhileEditing` /
    // `routeNotFound` in the editor instead of leaving Save enabled on a dead
    // revision — and so a late road-direction notice is not the only record
    // of what changed. `selectShellState` keeps both off the screen while the
    // draft is open.
    const draftToRefresh =
      intent !== undefined &&
      result.update.scene !== null &&
      !ROUTE_PREVIEW_NEUTRAL_INTENTS.has(intent.type) &&
      !dead &&
      !workingSave.isBusy()
        ? nextUi.routeDraft
        : null;
    let refreshedRouteDraft: RouteDraft | null = null;
    if (draftToRefresh !== null) {
      previewCoordinator.invalidateRoute();
      refreshedRouteDraft = {
        ...draftToRefresh,
        // A world change is preview-relevant like any draft edit: bump the
        // generation so an invalidated in-flight request's null response
        // cannot match this draft and clear the replacement's pending state.
        generation: draftToRefresh.generation + 1,
        // The held preview was accepted against the pre-dispatch world; while
        // the refresh request is in flight it must not keep `canSave` armed or
        // feed failures/warnings — "Checking route…" means no usable preview.
        previewPending: true,
        preview: null,
      };
      nextUi = { ...nextUi, routeDraft: refreshedRouteDraft };
    }
    // An armed road preview was computed against the previous world. If this
    // update changed anything the preview reads — a scene update, or the
    // budget on a frame-only update — re-issue it inside the same commit so
    // the cursor badge cannot keep reporting a stale cost, rejection, or
    // route-impact list until the pointer happens to move again.
    const nextMutation =
      dead || workingSave.isBusy()
        ? null
        : roadMutationForUi(nextState, nextUi);
    const previewWorldChanged =
      result.update.scene !== null || nextState.budget !== state.budget;
    const missingPreviewRecovery =
      intent !== undefined &&
      ROAD_MUTATION_INTENT_TYPES.has(intent.type) &&
      result.rejection !== null &&
      nextUi.roadMutationPreview === null &&
      activeRoadMutation === null &&
      hoverPreviewTimer === null;
    if (nextMutation === null && previewWorldChanged) {
      // Only invalidate when a preview is actually armed: under Select and
      // other non-road tools a budget-changing tick must not churn the
      // coordinator or allocate a cleared UiState on every commit.
      if (
        nextUi.roadMutationPreview !== null ||
        nextUi.roadMutationPreviewError !== null ||
        nextUi.roadMutationPreviewPending ||
        activeRoadMutation !== null ||
        hoverPreviewTimer !== null
      ) {
        invalidateRoadPreview();
        nextUi = clearRoadMutationPreview(nextUi);
      }
    } else if (
      nextMutation !== null &&
      (previewWorldChanged || missingPreviewRecovery)
    ) {
      if (missingPreviewRecovery || hoverPreviewDebounceMs <= 0) {
        const generation = nextUi.roadPreviewGeneration + 1;
        const snapshot = commit(nextState, {
          ...nextUi,
          roadPreviewGeneration: generation,
          roadMutationPreviewPending: true,
        });
        sendRoadMutationPreviewRequest(nextMutation, generation);
        if (refreshedRouteDraft !== null)
          requestRoutePreview(refreshedRouteDraft);
        return snapshot;
      }
      // Throttle instead of sending per tick: mark the armed preview stale
      // and let one trailing timer re-derive the mutation after the debounce
      // window. The held preview stays on screen meanwhile, and a burst of
      // budget/scene-changing updates collapses into a single IPC.
      roadPreviewStale = true;
      if (hoverPreviewTimer === null) {
        hoverPreviewTimer = setTimeout(() => {
          hoverPreviewTimer = null;
          reissueRoadMutationPreview();
        }, hoverPreviewDebounceMs);
      }
    }
    const snapshot = commit(nextState, nextUi);
    if (refreshedRouteDraft !== null) requestRoutePreview(refreshedRouteDraft);
    return snapshot;
  };

  const clearHoverPreviewTimer = (): void => {
    if (hoverPreviewTimer !== null) {
      clearTimeout(hoverPreviewTimer);
      hoverPreviewTimer = null;
    }
  };

  const stopRuntime = (): void => {
    previewCoordinator.invalidateRoute();
    invalidateRoadPreview();
    if (ui.roadMutationPreviewPending) {
      ui = { ...ui, roadMutationPreviewPending: false };
    }
    if (gameHost.isRunning()) gameHost.stop();
  };

  const stop = (): void => {
    stopRuntime();
  };

  const failBackend = (error: unknown): RuntimeSnapshot => {
    backendError = error instanceof Error ? error.message : String(error);
    dead = true;
    workingSave.dispose();
    stopRuntime();
    // Clear stale preview UI so a fatal error doesn't leave the road preview
    // overlay visible or the route draft stuck at previewPending forever.
    const clearedUi: UiState = {
      ...clearRoadMutationPreview(ui),
      routeDraft:
        ui.routeDraft === null
          ? ui.routeDraft
          : { ...ui.routeDraft, previewPending: false },
    };
    // Install the cleared UI. When disposal has been explicitly requested,
    // a late backend failure must NOT publish a terminal snapshot: disposal
    // is the lifecycle owner's channel during teardown, not a stale UI
    // update. The runtime remains terminal (dead, backendError recorded), but
    // no render, animation sync, or subscriber notification occurs. A LIVE runtime (no disposal
    // requested) still publishes exactly once so App's `setSnapshot` observes
    // `backendError` and renders the shell error screen.
    ui = clearedUi;
    return disposalRequested ? getSnapshot() : publishTerminalSnapshot();
  };

  const dispose = (): void => {
    disposalRequested = true;
    if (dead) return;
    dead = true;
    workingSave.dispose();
    stopRuntime();
  };

  const queueBackend = (
    operation: () => Promise<RuntimeSnapshot>,
    onError: (error: unknown) => RuntimeSnapshot = failBackend,
  ): Promise<RuntimeSnapshot> => {
    if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
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

  const dispatchNow = async (
    intent: GameIntent,
    nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
  ): Promise<RuntimeSnapshot> => {
    const result = await backend.dispatch(intent);
    backendError = null;
    // Preserve a prior rejection on no-op dispatches (applied === false,
    // rejection === null) — otherwise a no-op intent like re-toggling pause
    // would clear a placement rejection the player hasn't dismissed yet.
    // Update only on success (clears) or when a new rejection is present.
    // While a route draft hides the strip, a rejection recorded there is
    // deferred, not stale: an unrelated successful dispatch (speed, pause)
    // must not discard it before it ever surfaces on close.
    if (
      result.rejection !== null ||
      (result.applied && ui.routeDraft === null)
    ) {
      rejection = result.rejection;
    }
    const resolvedUi =
      typeof nextUi === "function"
        ? nextUi(result.applied, ui)
        : (nextUi ?? ui);
    return commitDispatchResult(result, resolvedUi, intent);
  };

  const enqueueDispatch = (
    intent: GameIntent,
    nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
  ): Promise<RuntimeSnapshot> =>
    queueBackend(() => dispatchNow(intent, nextUi));

  const enqueueComputedDispatch = (
    getIntent: () => GameIntent | null,
    nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
  ): Promise<RuntimeSnapshot> =>
    queueBackend(async () => {
      const intent = getIntent();
      if (intent === null) {
        return commit(state, ui);
      }
      return dispatchNow(intent, nextUi);
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
        // The engine returned an unchanged frame (paused, speed 0, zero-delta).
        // Skip applyPresentationUpdate so commit's reference-equality check
        // short-circuits — otherwise the fresh object forces a publish to every
        // subscriber on every animation frame even when nothing moved.
        return commit(state, ui);
      }
      return commitDispatchResult(result, ui);
    });

  const requestRoutePreview = (draft: RouteDraft): void => {
    if (dead || workingSave.isBusy()) return;
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
    if (workingSave.isBusy()) return getSnapshot();
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

  /** Retires the gameplay feedback that may be on screen when a route draft
   *  opens or when the player dismisses it manually: the pending rejection
   *  and the road-direction notice go together. Feedback that lands while a
   *  draft is open is not cleared here — `selectShellState` keeps it hidden
   *  until the draft closes. */
  const clearGameplayFeedback = (nextUi: UiState): UiState => {
    rejection = null;
    return nextUi.roadDirectionNotice === null
      ? nextUi
      : { ...nextUi, roadDirectionNotice: null };
  };

  /** Whether the stored rejection is owned by the given open draft — a Save
   *  rejection mirrored into the draft panel, or the stale-revision marker
   *  for the route being edited. Editor-owned feedback retires with its
   *  editor; unrelated feedback hidden behind a draft is deferred and
   *  survives until it surfaces on close. */
  const isEditorOwnedRejection = (draft: RouteDraft | null): boolean =>
    rejection !== null &&
    (ui.routePreviewError === rejection ||
      (draft?.source.kind === "edit" &&
        rejection.code === "routeChangedWhileEditing" &&
        rejection.context.routeId === draft.source.routeId));

  const rejectRouteDraftInteraction = (
    error: RouteDraftInteractionError,
  ): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
    return commit(state, {
      ...ui,
      routePreviewError: error,
      routePreviewHostError: null,
    });
  };

  const openRouteEdit = (routeId: string): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
    const route = state.transit.routes.find(
      (candidate) => candidate.id === routeId,
    );
    const line = state.transit.metroLines.find(
      (candidate) => candidate.id === routeId,
    );
    if (route === undefined && line === undefined) {
      return commit(state, ui);
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
    const result = commit(
      state,
      clearRoadMutationPreview(
        clearGameplayFeedback({
          ...ui,
          activeTool: route === undefined ? "metroLine" : "busRoute",
          selectedNodeKind: null,
          selectedVehicleId: null,
          selectedBuilding: null,
          selectedArea: null,
          activeBuildGroup: null,
          activeCommandDestination: "lines",
          selectedId: null,
          routeDraft,
          routeDraftHistory: emptyRouteDraftHistory(),
          routeDraftNotice: null,
          routePreviewError: null,
          routePreviewHostError: null,
          selectedRouteId: routeId,
          routeFailureFocus: null,
          drag: null,
        }),
      ),
    );
    requestRoutePreview(routeDraft);
    return result;
  };

  const saveRouteDraft = async (): Promise<RuntimeSnapshot> => {
    if (workingSave.isBusy()) return getSnapshot();
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
    const isCreate = draft.source.kind === "create";
    const mode = draft.mode;
    const deploy = isCreate && draft.preview.initialFleetCost !== null;
    const tokenKey = `${token.instanceId}:${token.generation}:${token.source}`;
    if (activeRouteSaveTokens.has(tokenKey)) {
      return getSnapshot();
    }
    activeRouteSaveTokens.add(tokenKey);
    let nextDraftInstanceIdAtAcceptedCreate: number | null = null;
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
        const existingIds = new Set(
          isCreate
            ? mode === "bus"
              ? state.transit.routes.map((route) => route.id)
              : state.transit.metroLines.map((line) => line.id)
            : [],
        );
        const result = await backend.dispatch(intent);
        const deployCreatedLine = async (
          saved: RuntimeSnapshot,
        ): Promise<RuntimeSnapshot> => {
          if (
            !deploy ||
            !isCreate ||
            !result.applied ||
            result.update.scene === null
          ) {
            return saved;
          }
          const ids =
            mode === "bus"
              ? result.update.scene.routes.map((route) => route.id)
              : result.update.scene.metroLines.map((line) => line.id);
          const newIds = ids.filter((id) => !existingIds.has(id));
          if (newIds.length !== 1) {
            return saved;
          }
          const previousRejection = rejection;
          const deployed = await dispatchNow({
            type: "deployInitialFleet",
            lineId: newIds[0],
          });
          if (
            rejection !== previousRejection &&
            rejection === deployed.rejection &&
            rejection?.code === "insufficientBudget"
          ) {
            rejection = {
              ...rejection,
              context: {
                ...rejection.context,
                savedWithoutFleet: true,
              },
            };
            return publish();
          }
          return deployed;
        };
        const current = ui.routeDraft;
        const tokenIsCurrent = isCurrent(current);
        if (tokenIsCurrent) {
          backendError = null;
          // A Save rejection always replaces stored feedback (it mirrors
          // into the draft panel below). A successful Save clears only a
          // rejection this editor owned — an unrelated rejection hidden
          // behind the open draft stays deferred until the draft closes.
          if (result.rejection !== null || isEditorOwnedRejection(current)) {
            rejection = result.rejection;
          }
        } else if (result.applied) {
          // A superseded save still succeeded in the backend; clear any prior
          // rejection so a stale failure does not outlive the successful save
          // — unless it is still hidden behind the current draft.
          backendError = null;
          if (ui.routeDraft === null) {
            rejection = null;
          }
        }
        if (result.applied && tokenIsCurrent) {
          if (isCreate) {
            // The create closes this draft itself; a later instance is a real replacement.
            nextDraftInstanceIdAtAcceptedCreate = nextRouteDraftInstanceId;
          }
          previewCoordinator.invalidateRoute();
          const saved = commitDispatchResult(
            result,
            {
              ...ui,
              activeTool: "inspect",
              selectedId: null,
              selectedNodeKind: null,
              selectedVehicleId: null,
              selectedBuilding: null,
              selectedArea: null,
              activeBuildGroup: null,
              activeCommandDestination: "lines",
              routeDraft: null,
              routeDraftHistory: emptyRouteDraftHistory(),
              routeDraftNotice: null,
              routePreviewError: null,
              routePreviewHostError: null,
            },
            intent,
          );
          return deployCreatedLine(saved);
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
          return commitDispatchResult(
            result,
            {
              ...ui,
              routePreviewError: result.rejection,
              routePreviewHostError: null,
            },
            intent,
          );
        }
        // A superseded save changed the snapshot. The current draft's preview
        // was computed against the pre-save snapshot and may carry a stale
        // expected revision; commitDispatchResult's scene-triggered refresh
        // re-requests it so a fresh answer can surface
        // `routeChangedWhileEditing` instead of leaving Save enabled on a
        // stale revision. Invalidate anyway: a request still in flight must
        // not apply a pre-save answer once the save is no longer busy.
        if (result.applied && !tokenIsCurrent) {
          previewCoordinator.invalidateRoute();
          if (current !== null) {
            const refreshedDraft: RouteDraft = {
              ...current,
              preview: null,
              previewPending: false,
            };
            const supersededResult = commitDispatchResult(
              result,
              {
                ...ui,
                routeDraft: refreshedDraft,
              },
              intent,
            );
            return deployCreatedLine(supersededResult);
          }
          const supersededResult = commitDispatchResult(result, ui, intent);
          return deployCreatedLine(supersededResult);
        }
        return commitDispatchResult(result, ui, intent);
      },
      // Superseded-save host errors must not kill the runtime: the user may
      // already be on a replacement draft. A truly dead backend is still
      // caught by the next tick/dispatch failBackend path.
      (error) => {
        const createStillOwnsClosedDraft =
          nextDraftInstanceIdAtAcceptedCreate !== null &&
          ui.routeDraft === null &&
          nextRouteDraftInstanceId === nextDraftInstanceIdAtAcceptedCreate;
        if (isCurrent(ui.routeDraft) || createStillOwnsClosedDraft) {
          return failBackend(error);
        }
        return getSnapshot();
      },
    ).finally(() => {
      activeRouteSaveTokens.delete(tokenKey);
    });
  };

  const cancelRouteDraft = (): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
    const draft = ui.routeDraft;
    previewCoordinator.invalidateRoute();
    const cancelledUi = cancelDraftRoute(ui);
    if (isEditorOwnedRejection(draft)) rejection = null;
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
      activeTool: "inspect",
      selectedId: null,
      selectedNodeKind: null,
      selectedVehicleId: null,
      selectedBuilding: null,
      selectedArea: null,
      activeBuildGroup: null,
      activeCommandDestination: "lines",
      routeDraftHistory: emptyRouteDraftHistory(),
      routeDraftNotice: null,
    });
  };

  const undoRouteDraft = (): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
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
    if (workingSave.isBusy()) return getSnapshot();
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
    if (workingSave.isBusy()) return getSnapshot();
    const draft = ui.routeDraft;
    if (draft?.source.kind !== "edit") {
      return commit(state, ui);
    }
    const routeId = draft.source.routeId;
    // Reload is enabled by any of the three places a `routeChangedWhileEditing`
    // rejection can live (see `selectRouteEditorView`'s canReload); the action
    // must honour every source or the button stays enabled but does nothing.
    const globalStale =
      rejection?.code === "routeChangedWhileEditing" &&
      rejection.context.routeId === routeId;
    const localStale =
      ui.routePreviewError?.code === "routeChangedWhileEditing" &&
      ui.routePreviewError.context.routeId === routeId;
    const clearedDraft: RouteDraft =
      draft.preview?.rejection?.code === "routeChangedWhileEditing" &&
      draft.preview.rejection.context.routeId === routeId
        ? { ...draft, preview: { ...draft.preview, rejection: null } }
        : draft;
    if (!globalStale && !localStale && clearedDraft === draft) {
      return commit(state, ui);
    }
    // The edited route may be gone: openRouteEdit returns early on a failed
    // lookup without touching feedback, which would leave Reload enabled
    // forever. Retire this route's stale markers so the button disables;
    // unrelated feedback is preserved.
    const routeStillExists =
      draft.mode === "metro"
        ? state.transit.metroLines.some((line) => line.id === routeId)
        : state.transit.routes.some((route) => route.id === routeId);
    if (!routeStillExists) {
      if (globalStale) rejection = null;
      return commit(state, {
        ...ui,
        routePreviewError: localStale ? null : ui.routePreviewError,
        routeDraft: clearedDraft,
      });
    }
    return openRouteEdit(routeId);
  };

  const handleEscape = (): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
    if (ui.drag !== null) return api.cancelDrag();
    if (ui.routeDraft !== null) return cancelRouteDraft();
    if (ui.activeCommandDestination !== null) {
      return commit(state, {
        ...ui,
        activeCommandDestination: null,
        activeBuildGroup: null,
      });
    }
    if (
      ui.activeTool !== "inspect" ||
      ui.selectedBuilding !== null ||
      ui.selectedArea !== null
    ) {
      invalidateRoadPreview();
      return commit(state, nextToolUiState("inspect", ui));
    }
    return commit(state, ui);
  };

  const sendRoadMutationPreviewRequest = (
    mutation: RoadMutation,
    generation: number,
  ): void => {
    // A fresh request supersedes a debounced hover send still waiting to
    // fire: its captured generation can never match again, and leaving the
    // obsolete timer installed blocks both the stale-refresh trailing timer
    // and reissueRoadMutationPreview while it runs to a no-op.
    clearHoverPreviewTimer();
    if (dead || workingSave.isBusy()) return;
    // Any fresh request answers whatever world change marked the preview
    // stale, whether or not it was scheduled as a refresh.
    roadPreviewStale = false;
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
        activeRoadMutation = null;
        commit(state, {
          ...ui,
          roadMutationPreview: { ...response, mutation },
          roadMutationPreviewError: null,
          roadMutationPreviewPending: false,
        });
        // The world kept moving while this request was in flight — issue the
        // one trailing refresh those updates collapsed into.
        if (roadPreviewStale) reissueRoadMutationPreview();
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
        activeRoadMutation = null;
        commit(state, {
          ...ui,
          roadMutationPreview: null,
          roadMutationPreviewError:
            error instanceof Error ? error.message : String(error),
          roadMutationPreviewPending: false,
        });
        if (roadPreviewStale) reissueRoadMutationPreview();
      });
  };

  const requestRoadMutationPreview = (
    mutation: RoadMutation,
  ): RuntimeSnapshot => {
    if (dead || workingSave.isBusy()) return getSnapshot();
    // The generation bump alone marks the request in flight; the last
    // resolved preview stays on screen until the answer lands so the cursor
    // badge does not flash the one-tile fallback (and its wrong ⊘) between
    // tiles.
    const generation = ui.roadPreviewGeneration + 1;
    const pending = commit(state, {
      ...ui,
      roadPreviewGeneration: generation,
      roadMutationPreviewPending: true,
    });
    sendRoadMutationPreviewRequest(mutation, generation);
    return pending;
  };

  /** Re-derives the hover-implied mutation and sends one preview request when
   *  nothing is already armed or in flight. Covers the two ways the armed
   *  preview loses its request without one being re-issued: the save busy
   *  gate dropping re-requests while drained ticks invalidate it (the
   *  workingSave publish hook calls this when the gate releases), and a
   *  stale-marked refresh whose timer just fired. */
  const reissueRoadMutationPreview = (): void => {
    if (
      dead ||
      workingSave.isBusy() ||
      activeRoadMutation !== null ||
      hoverPreviewTimer !== null
    ) {
      return;
    }
    const mutation = roadMutationForUi(state, ui);
    if (mutation === null) return;
    const generation = ui.roadPreviewGeneration + 1;
    commit(state, {
      ...ui,
      roadPreviewGeneration: generation,
      roadMutationPreviewPending: true,
    });
    sendRoadMutationPreviewRequest(mutation, generation);
  };

  /** Commit a UI transition and, if the resulting state implies a road mutation,
   *  fold the preview-generation bump into the SAME commit so only one
   *  `publish` fires. Replaces the prior pattern of committing the UI, then
   *  calling `requestRoadMutationPreview` (which committed a second time).
   *  Used by tool/preset/arm/drag transitions that may trigger a road preview. */
  const commitWithRoadPreview = (nextUi: UiState): RuntimeSnapshot => {
    if (workingSave.isBusy()) return getSnapshot();
    const mutation = dead ? null : roadMutationForUi(state, nextUi);
    if (mutation === null) {
      invalidateRoadPreview();
      return commit(state, clearRoadMutationPreview(nextUi));
    }
    const generation = nextUi.roadPreviewGeneration + 1;
    const snapshot = commit(state, {
      ...nextUi,
      roadPreviewGeneration: generation,
      roadMutationPreviewPending: true,
    });
    sendRoadMutationPreviewRequest(mutation, generation);
    return snapshot;
  };

  const invalidateRoadPreview = (): void => {
    clearHoverPreviewTimer();
    roadPreviewStale = false;
    previewCoordinator.invalidateRoadMutation();
    activeRoadMutation = null;
  };

  const installRestoredGameplay = (update: PresentationUpdate): void => {
    previewRuntimeEpoch += 1;
    previewCoordinator.invalidateRoute();
    invalidateRoadPreview();
    activeRouteSaveTokens.clear();
    nextRouteDraftInstanceId = 1;
    state = acceptPresentationUpdate(null, update);
    ui = createUiState();
    camera = null;
    backendError = null;
    rejection = null;
    sandboxResetError = null;
  };

  const workingSave = createWorkingSaveRuntime({
    backend,
    saveStore,
    initialCity: options.initialCity ?? null,
    now,
    createCityId,
    awaitGameplayIdle: () => gameplayQueue.drain(),
    installRestoredGameplay,
    publish: () => {
      publish();
      // Ticks drained while saving invalidate the armed hover preview, but
      // the busy gate drops every re-request — so once the gate releases,
      // re-issue it or the badge keeps its cleared verdict until the pointer
      // moves again.
      reissueRoadMutationPreview();
    },
    isRuntimeDead: () => dead,
  });

  // Road clicks defer the lay-vs-cycle decision to execution time via
  // `enqueueComputedDispatch` below: an earlier queued dispatch (e.g. a road
  // drag still draining, or a prior click) may have turned the clicked tile
  // into a road by the time that closure runs, so `roadClickIntent` re-reads
  // `state.map` inside the queued handler rather than capturing the tile kind
  // up front.
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

  const api: RuntimeController & RuntimeTestSeam = {
    persistence: workingSave.controller,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (dead) return;
      gameHost.start();
    },
    stop,
    dispose,
    isRunning: () => (dead ? false : gameHost.isRunning()),
    tick(deltaSeconds) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueTick(deltaSeconds);
    },
    reset() {
      if (dead) return Promise.resolve(getSnapshot());
      if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      // The invalidation above drops any in-flight preview response, so its
      // UI markers must clear too — otherwise a failed reset publishes the
      // old ui with roadMutationPreviewPending still armed for a request
      // that no longer exists.
      commit(state, clearRoadMutationPreview(ui));
      return queueBackend(async () => {
        const result = await backend.reset();
        if (!result.ok) {
          sandboxResetError = result.error;
          return publish();
        }
        const update = result.update;
        sandboxResetError = null;
        backendError = null;
        rejection = null;
        state = acceptPresentationUpdate(null, update);
        ui = createUiState();
        workingSave.markDirty();
        return publish();
      });
    },
    resetUi() {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, createUiState());
    },
    setTool(tool) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
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
        next.activeCommandDestination = "lines";
        return commitWithRoadPreview(clearGameplayFeedback(next));
      }
      return commitWithRoadPreview(next);
    },
    setBuilding(building) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextBuildingUiState(building, ui));
    },
    setArea(area) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextAreaUiState(area, ui));
    },
    setRoadPreset(preset) {
      if (dead) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      return commitWithRoadPreview(
        ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
      );
    },
    setCommandDestination(destination: CommandDestination | null) {
      if (dead) return getSnapshot();
      if (
        ui.routeDraft !== null &&
        destination !== null &&
        destination !== "lines"
      ) {
        return getSnapshot();
      }
      const nextDestination =
        destination === ui.activeCommandDestination ? null : destination;
      const nextBuildGroup =
        nextDestination === "build" ? ui.activeBuildGroup : null;
      if (
        nextDestination === ui.activeCommandDestination &&
        nextBuildGroup === ui.activeBuildGroup
      ) {
        return commit(state, ui);
      }
      return commit(state, {
        ...ui,
        activeCommandDestination: nextDestination,
        activeBuildGroup: nextBuildGroup,
      });
    },
    setBuildGroup(group: BuildGroup | null) {
      if (dead) return getSnapshot();
      if (
        ui.routeDraft !== null ||
        ui.activeCommandDestination !== "build" ||
        (group !== null &&
          !["roads", "transit", "zones", "buildings"].includes(group))
      ) {
        return getSnapshot();
      }
      return group === ui.activeBuildGroup
        ? commit(state, ui)
        : commit(state, { ...ui, activeBuildGroup: group });
    },
    armRoad(preset) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      // Single commit: switch to the road tool (which clears building/area and
      // closes the drawer via nextToolUiState) and set the preset together, so
      // one click fully arms the tool with no intermediate render.
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commitWithRoadPreview({
        ...nextToolUiState("road", ui),
        roadPreset: preset,
      });
    },
    armRoundabout(size: RoundaboutSize) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      // Roundabouts are fixed click stamps. Switching sizes is one UI commit
      // and invalidates any in-flight road preview so an older footprint can
      // never populate the newly armed stamp.
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
      if (workingSave.isBusy()) return getSnapshot();
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
      // A new gesture is the boundary the held preview can describe: keep it
      // only when it provably answers this tile — the latest request already
      // resolved and the press lands on the tile it was for — so pressing at
      // the hovered tile never flashes the local fallback, while any older
      // or different-tile verdict cannot pose as this stroke's.
      const heldPreview =
        ui.roadMutationPreview !== null &&
        ui.roadMutationPreview.generation === ui.roadPreviewGeneration &&
        samePoint(ui.hoverTile, point)
          ? ui.roadMutationPreview
          : null;
      return commitWithRoadPreview({
        ...ui,
        drag: { tool, start: point, current: point },
        roadMutationPreview: heldPreview,
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
      if (workingSave.isBusy()) return getSnapshot();
      invalidateRoadPreview();
      const cleared = clearRoadMutationPreview(ui);
      return commit(
        state,
        ui.drag === null && cleared === ui ? ui : { ...cleared, drag: null },
      );
    },
    commitDrag() {
      if (dead) return Promise.resolve(getSnapshot());
      if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
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
      commit(state, { ...clearRoadMutationPreview(ui), drag: null });
      if (gesture.tool === "area") {
        return enqueueDispatch({
          type: "paintAreaRectangle",
          area: gesture.area,
          start: gesture.start,
          end: gesture.current,
        });
      }
      const points = dragMutationPoints(
        gesture.tool,
        gesture.start,
        gesture.current,
      );
      if (points.length <= 1) {
        if (gesture.tool === "road") {
          // A zero-length road drag is a tap: defer the lay-vs-cycle decision
          // to execution time so the tile kind reflects drained queued updates.
          return enqueueComputedDispatch(() =>
            roadClickIntent(state, points[0], roadPreset),
          );
        }
        const intent = intentForToolClick(points[0]);
        return intent === null ? commit(state, ui) : enqueueDispatch(intent);
      }
      if (gesture.tool === "remove") {
        return enqueueDispatch({ type: "removeAtTiles", points });
      }
      if (gesture.tool === "track") {
        return enqueueDispatch({ type: "layTrackLine", points });
      }
      return enqueueDispatch({
        type: "layRoadLine",
        points,
        preset: roadPreset,
      });
    },
    rotateBuilding() {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      const currentIndex = rotations.indexOf(ui.buildingRotation);

      return commit(state, {
        ...ui,
        buildingRotation: rotations[(currentIndex + 1) % rotations.length],
      });
    },
    setOverlay(overlay) {
      if (dead) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
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
    handleTileClick(point, pick) {
      if (dead) return Promise.resolve(getSnapshot());
      if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
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
      const isSelectClick =
        ui.activeTool === "inspect" && ui.selectedBuilding === null;
      if (
        isSelectClick ||
        ui.activeTool === "busRoute" ||
        ui.activeTool === "metroLine"
      ) {
        const previousDraft = ui.routeDraft;
        const result = applyUiTileClick(
          state,
          ui,
          point,
          isSelectClick ? pick : undefined,
        );
        if (result.lineIdToOpen !== null) {
          commit(state, result.ui);
          return api.openServiceControls(result.lineIdToOpen);
        }
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
        invalidateRoadPreview();
        const roadPreset = ui.roadPreset;
        commit(state, clearRoadMutationPreview(ui));
        return enqueueComputedDispatch(() =>
          roadClickIntent(state, point, roadPreset),
        );
      }

      if (ui.activeTool === "roundabout") {
        const size = ui.roundaboutSize;
        invalidateRoadPreview();
        commit(state, clearRoadMutationPreview(ui));
        return enqueueDispatch({
          type: "placeRoundabout",
          origin: point,
          size,
        });
      }

      const intent = intentForToolClick(point);
      return intent === null ? commit(state, ui) : enqueueDispatch(intent);
    },
    undoLastBuild() {
      if (dead) return Promise.resolve(getSnapshot());
      if (ui.routeDraft !== null) return getSnapshot();
      return enqueueDispatch({ type: "undoLastBuild" });
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
      if (ui.routeDraft !== null) return getSnapshot();
      return openRouteEdit(routeId);
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
    setServiceTargetHeadway(lineId, targetHeadwaySeconds) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueDispatch({
        type: "setServiceTargetHeadway",
        lineId,
        targetHeadwaySeconds,
      });
    },
    deployInitialFleet(lineId) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueDispatch({ type: "deployInitialFleet", lineId });
    },
    addServiceVehicle(lineId) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueDispatch({ type: "addServiceVehicle", lineId });
    },
    retireServiceVehicle(lineId) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueDispatch({ type: "retireServiceVehicle", lineId });
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
    focusWaitLocation(routeId, nodeId) {
      if (dead) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      const route =
        state.transit.routes.find((candidate) => candidate.id === routeId) ??
        state.transit.metroLines.find((candidate) => candidate.id === routeId);
      if (route === undefined) return commit(state, ui);
      const node = presentNodeAt(state, nodeId);
      if (node === null) return commit(state, ui);
      // Resolve the camera before committing so the move and the selection
      // land in one published snapshot — subscribers never see new camera
      // with old UI or old camera with new UI.
      const nextCamera = gameHost.cameraForAction({
        kind: "centerOn",
        point: node.position,
      });
      return commit(
        state,
        {
          ...ui,
          activeTool: "inspect",
          activeCommandDestination: null,
          selectedId: `${node.position.x},${node.position.y}`,
          selectedNodeKind: node.kind,
          selectedVehicleId: null,
          selectedRouteId: routeId,
          routeFailureFocus: null,
          selectedBuilding: null,
          selectedArea: null,
        },
        nextCamera,
      );
    },
    openServiceControls(routeId) {
      if (dead) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      const route =
        state.transit.routes.find((candidate) => candidate.id === routeId) ??
        state.transit.metroLines.find((candidate) => candidate.id === routeId);
      if (route === undefined) return commit(state, ui);
      return commit(state, {
        ...ui,
        selectedRouteId: routeId,
        activeCommandDestination: "lines",
        activeBuildGroup: null,
        routeFailureFocus: null,
      });
    },
    setHoverTile(point) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (samePoint(point, ui.hoverTile)) {
        return commit(state, ui);
      }
      invalidateRoadPreview();
      // Every hover change (including non-null moves) invalidates generation
      // so late responses cannot pass a stale generation. When the new hover
      // still implies a mutation, the last resolved preview stays on screen
      // until its replacement arrives — clearing it made the badge flash the
      // one-tile fallback (and its wrong ⊘) on every tile the drag crosses.
      // When no mutation applies, the stale overlay must clear.
      const generation = ui.roadPreviewGeneration + 1;
      const nextUi: UiState = {
        ...ui,
        hoverTile: point,
        roadPreviewGeneration: generation,
      };
      const mutation =
        point === null || dead ? null : roadMutationForUi(state, nextUi);
      if (mutation === null) {
        return commit(state, clearRoadMutationPreview(nextUi));
      }
      if (point === null || dead) {
        return commit(state, nextUi);
      }
      // Debounce the hover-triggered preview so rapid pointermove events
      // coalesce into a single IPC round-trip (important on Tauri). A delay
      // of 0 disables debouncing (used in tests).
      if (hoverPreviewDebounceMs <= 0) {
        const snapshot = commit(state, {
          ...nextUi,
          roadMutationPreviewPending: true,
        });
        sendRoadMutationPreviewRequest(mutation, generation);
        return snapshot;
      }
      // Debounced: commit the cleared hover state now; fire the request after
      // the delay using the generation already reserved for this hover.
      const snapshot = commit(state, {
        ...nextUi,
        roadMutationPreviewPending: true,
      });
      hoverPreviewTimer = setTimeout(() => {
        hoverPreviewTimer = null;
        if (dead || ui.roadPreviewGeneration !== generation) return;
        if (workingSave.isBusy()) {
          commit(state, { ...ui, roadMutationPreviewPending: false });
          return;
        }
        const currentMutation = roadMutationForUi(state, ui);
        if (currentMutation === null) {
          commit(state, { ...ui, roadMutationPreviewPending: false });
          return;
        }
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
      if (rejection === null && ui.roadDirectionNotice === null) {
        return commit(state, ui);
      }
      return commit(state, clearGameplayFeedback(ui));
    },
    debugSetBudget(budget) {
      if (dead) return Promise.resolve(getSnapshot());
      return enqueueDispatch({ type: "setBudget", budget });
    },
    adjustCamera(action) {
      if (dead) return getSnapshot();
      // The host owns the board size the camera is clamped against; it
      // reports the result through onCameraChange.
      gameHost.adjustCamera(action);
      return getSnapshot();
    },
    debugCaptureFrame() {
      return gameHost.captureFrame();
    },
    mountCanvas: (host: HTMLElement) => gameHost.mount(host),
  };

  return api;
}
