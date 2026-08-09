import {
  samePoint,
  type AreaKind,
  type BuildingType,
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
import { axisLockedLine } from "../ui/roadDrag";
import {
  createUiState,
  type CommandDestination,
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
  SandboxResetError,
} from "./backend";
import type { CitySaveStore, CitySummary } from "../persistence/citySaveStore";
import { createCanvasHost } from "./createCanvasHost";
import { createPreviewCoordinator } from "./previewCoordinator";
import { selectShellState } from "./runtimeSelectors";
import { createSerializedQueue } from "./serializedQueue";
import { normalizeRustSnapshot } from "./snapshotView";
import { createWorkingSaveRuntime } from "./workingSaveRuntime";
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
  initialCity?: CitySummary | null;
  now?: () => string;
  createCityId?: () => string;
  /** Trailing debounce delay for hover-triggered road mutation previews, in
   *  milliseconds. Defaults to 50ms to coalesce rapid pointermove events on
   *  Tauri (IPC round-trip per event). Set to 0 to disable debouncing. */
  hoverPreviewDebounceMs?: number;
}

function nextToolUiState(activeTool: Tool, current = createUiState()): UiState {
  return {
    ...current,
    activeTool,
    selectedId: activeTool === "inspect" ? current.selectedId : null,
    selectedNodeKind: null,
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
      workingSave.markDirty();
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
    stopRuntime();
  };

  const failBackend = (error: unknown): RuntimeSnapshot => {
    backendError = error instanceof Error ? error.message : String(error);
    dead = true;
    previewCoordinator.invalidateRoute();
    previewCoordinator.invalidateRoadMutation();
    activeRoadMutation = null;
    workingSave.dispose();
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
      roadMutationPreview: null,
      roadMutationPreviewError: null,
    });
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
            activeTool: "inspect",
            selectedId: null,
            selectedNodeKind: null,
            selectedBuilding: null,
            selectedArea: null,
            activeBuildGroup: null,
            activeCommandDestination: "lines",
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
            const canRequestPreview = !workingSave.isBusy();
            const refreshedDraft: RouteDraft = {
              ...current,
              preview: null,
              previewPending: canRequestPreview,
            };
            const supersededResult = commitDispatchResult(result, {
              ...ui,
              routeDraft: refreshedDraft,
            });
            if (canRequestPreview) requestRoutePreview(refreshedDraft);
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
    if (workingSave.isBusy()) return getSnapshot();
    const draft = ui.routeDraft;
    previewCoordinator.invalidateRoute();
    const cancelledUi = cancelDraftRoute(ui);
    const editorOwnsRejection =
      draft?.source.kind === "edit" &&
      rejection?.code === "routeChangedWhileEditing" &&
      rejection.context.routeId === draft.source.routeId;
    if (editorOwnsRejection) rejection = null;
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
    // openRouteEdit clears routePreviewError via commit.
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
      clearHoverPreviewTimer();
      invalidateRoadPreview();
      return commit(state, nextToolUiState("inspect", ui));
    }
    return commit(state, ui);
  };

  const sendRoadMutationPreviewRequest = (
    mutation: RoadMutation,
    generation: number,
  ): void => {
    if (dead || workingSave.isBusy()) return;
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
    if (dead || workingSave.isBusy()) return getSnapshot();
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
    if (workingSave.isBusy()) return getSnapshot();
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

  const installRestoredGameplay = (rawSnapshot: RustGameSnapshot): void => {
    clearHoverPreviewTimer();
    previewRuntimeEpoch += 1;
    previewCoordinator.invalidateRoute();
    invalidateRoadPreview();
    activeRouteSaveTokens.clear();
    nextRouteDraftInstanceId = 1;
    state = normalizeRustSnapshot(rawSnapshot);
    ui = createUiState();
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
    },
    isRuntimeDead: () => dead,
  });

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
      if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
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
        state = normalizeRustSnapshot(snapshot);
        ui = createUiState();
        workingSave.markDirty();
        return publish();
      });
    },
    resetUi() {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, createUiState());
    },
    setTool(tool) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
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
        next.activeCommandDestination = "lines";
      }
      return commitWithRoadPreview(next);
    },
    setBuilding(building) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      clearHoverPreviewTimer();
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextBuildingUiState(building, ui));
    },
    setArea(area) {
      if (dead) return getSnapshot();
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
      clearHoverPreviewTimer();
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
      if (ui.routeDraft !== null) return getSnapshot();
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
      if (workingSave.isBusy()) return getSnapshot();
      if (ui.routeDraft !== null) return getSnapshot();
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
      if (workingSave.isBusy()) return getSnapshot();
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
    handleTileClick(point) {
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
      if (workingSave.isBusy()) return getSnapshot();
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
          workingSave.isBusy() ||
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
    mountCanvas: canvasHost.mount,
  };

  return api;
}
