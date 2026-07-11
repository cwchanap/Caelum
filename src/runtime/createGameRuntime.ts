import type {
  AreaKind,
  BuildingType,
  GameplayRejection,
  Point,
  Tool,
} from "../domain/types";
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
import { canvasToTile, renderGame, syncCanvasSize } from "../render/canvas";
import {
  cancelDraftRoute,
  applyUiTileClick,
  draftHandleIndexAtPoint,
} from "../ui/actions";
import {
  canSaveRouteDraft,
  createDraft,
  editDraft,
  moveWaypoint,
  removeWaypoint,
  reverseRoute,
  selectWaypoint,
  setPattern,
  type RouteDraft,
  type RouteDraftInteractionError,
} from "../ui/routeDraft";
import { axisLockedLine } from "../ui/roadDrag";
import { createUiState, type UiState } from "../ui/uiState";
import type { GameBackend, GameIntent, RoadMutation } from "./backend";
import { createPreviewCoordinator } from "./previewCoordinator";
import { selectShellState } from "./runtimeSelectors";
import { normalizeRustSnapshot } from "./snapshotView";
import type {
  RuntimeController,
  RuntimeListener,
  RuntimeSnapshot,
} from "./types";

function samePoint(left: Point | null, right: Point | null): boolean {
  return left?.x === right?.x && left?.y === right?.y;
}

const DRAG_TOOLS = new Set<Tool>(["road", "track", "remove", "area"]);

const rotations = [0, 90, 180, 270] as const;

interface CreateGameRuntimeOptions {
  backend: GameBackend;
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
    routePreviewError:
      activeTool === "busRoute" || activeTool === "metroLine"
        ? current.routePreviewError
        : null,
    roadMutationPreview: null,
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
    routePreviewError: null,
    roadMutationPreview: null,
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
    routePreviewError: null,
    roadMutationPreview: null,
    selectedRouteId: null,
    routeFailureFocus: null,
    roadPreset: current.roadPreset,
    drag: null,
    activeHudCategory: null,
  };
}

export async function createGameRuntime({
  backend,
}: CreateGameRuntimeOptions): Promise<RuntimeController> {
  let state = normalizeRustSnapshot(await backend.snapshot());
  let ui = createUiState();
  let backendError: string | null = null;
  let rejection: GameplayRejection | null = null;
  let gameplayQueue: Promise<void> = Promise.resolve();
  const previewCoordinator = createPreviewCoordinator(backend);
  let nextRouteDraftInstanceId = 1;
  const activeRouteSaveTokens = new Set<string>();
  let activeRoadMutation: RoadMutation | null = null;
  let running = false;
  // Once the backend has failed fatally, no further dispatches or ticks are
  // attempted. `failBackend` sets this; `queueBackend` short-circuits on it so
  // user-initiated intents after a fatal error do not reach a dead backend.
  let dead = false;
  let animationFrameId: number | null = null;
  let lastFrameTime: number | null = null;
  let canvasHost: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui, rejection),
    backendError,
    rejection,
  });

  const canAnimate = (): boolean =>
    running &&
    !state.paused &&
    state.metrics.state === "running" &&
    state.speed !== 0;

  const syncAnimationLoop = (): void => {
    if (canAnimate()) {
      if (
        animationFrameId === null &&
        typeof requestAnimationFrame === "function"
      ) {
        animationFrameId = requestAnimationFrame(frame);
      }

      return;
    }

    if (
      animationFrameId !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    lastFrameTime = null;
  };

  const render = (): void => {
    if (canvas === null || context === null) {
      return;
    }

    syncCanvasSize(canvas);
    renderGame(context, state, ui);
  };

  const publish = (): RuntimeSnapshot => {
    const snapshot = getSnapshot();
    render();
    syncAnimationLoop();

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
      render();
      syncAnimationLoop();
      return getSnapshot();
    }

    return publish();
  };

  const stop = (): void => {
    previewCoordinator.invalidateRoute();
    previewCoordinator.invalidateRoadMutation();
    activeRoadMutation = null;
    running = false;
    lastFrameTime = null;
    syncAnimationLoop();
  };

  const frame = (timestamp: number): void => {
    animationFrameId = null;

    if (!running) {
      return;
    }

    const previousTimestamp = lastFrameTime ?? timestamp;
    lastFrameTime = timestamp;
    const deltaSeconds = Math.max(0, (timestamp - previousTimestamp) / 1_000);

    if (deltaSeconds > 0) {
      void api.tick(deltaSeconds);
    } else {
      render();
      syncAnimationLoop();
    }
  };

  const start = (): void => {
    if (running) {
      return;
    }

    running = true;
    lastFrameTime = null;
    render();
    syncAnimationLoop();
  };

  const mountCanvas = (host: HTMLElement): (() => void) => {
    if (canvasHost === host && canvas !== null) {
      render();
      return () => {
        if (canvasHost === host) {
          canvas = null;
          context = null;
          canvasHost = null;
          host.innerHTML = "";
        }
      };
    }

    canvasHost = host;
    host.innerHTML = "";
    canvas = document.createElement("canvas");
    canvas.dataset.runtimeCanvas = "true";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);
    context = canvas.getContext("2d");

    if (context === null) {
      throw new Error("Canvas 2D context unavailable");
    }

    const handleClick = (event: MouseEvent): void => {
      if (canvas === null) {
        return;
      }

      if (DRAG_TOOLS.has(ui.activeTool)) {
        return; // drag tools are driven by pointerdown/up below.
      }

      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        state.map,
      );

      if (point !== null) {
        api.handleTileClick(point);
      }
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (canvas === null) {
        return;
      }
      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        state.map,
      );
      // A live drag tracks its own `current`; only idle movement updates the
      // hover tile (badge / building preview / hover highlight).
      if (ui.drag !== null) {
        api.setDragCurrent(point);
      } else {
        api.setHoverTile(point);
      }
    };

    const capturePointer = (pointerId: number): void => {
      // Capture so a release a pixel past the board edge still commits instead
      // of firing pointerleave -> cancelDrag (which would discard the road).
      if (canvas !== null && typeof canvas.setPointerCapture === "function") {
        try {
          canvas.setPointerCapture(pointerId);
        } catch {
          // Some engines throw if the pointer is already inactive; a missed
          // capture only falls back to the pre-capture behavior, so ignore.
        }
      }
    };

    const releasePointer = (pointerId: number): void => {
      if (
        canvas !== null &&
        typeof canvas.hasPointerCapture === "function" &&
        typeof canvas.releasePointerCapture === "function" &&
        canvas.hasPointerCapture(pointerId)
      ) {
        canvas.releasePointerCapture(pointerId);
      }
    };

    const handlePointerDown = (event: PointerEvent): void => {
      // Only the primary (left) button initiates a drag. Right/middle clicks
      // would otherwise start a stale drag gesture.
      if (
        canvas === null ||
        event.button !== 0 ||
        !DRAG_TOOLS.has(ui.activeTool)
      ) {
        return;
      }
      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        state.map,
      );
      if (point === null) {
        return;
      }
      const snapshot = api.startDrag(point);
      if (snapshot.ui.drag !== null) {
        capturePointer(event.pointerId);
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      // Only the primary button commits; a stray right/middle release mid-drag
      // must not place the road early.
      if (canvas === null || ui.drag === null || event.button !== 0) {
        return;
      }
      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        state.map,
      );
      // Snap the gesture to the release tile before committing, so a release on
      // a different tile than the last move builds to where the user let go.
      api.setDragCurrent(point);
      api.commitDrag();
      releasePointer(event.pointerId);
    };

    const handlePointerLeave = (): void => {
      // With pointer capture active the browser suppresses leave mid-drag, so
      // reaching here means the cursor left the board outside a drag — or the
      // host engine lacks pointer capture, in which case an abandoned drag
      // should still be cancelled rather than left dangling.
      if (ui.drag !== null) {
        api.cancelDrag();
      }
      api.setHoverTile(null);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      // pointercancel is a genuine interruption (OS stealing the pointer, etc.)
      // and still fires under pointer capture: tear the drag down explicitly.
      if (ui.drag !== null) {
        api.cancelDrag();
      }
      api.setHoverTile(null);
      releasePointer(event.pointerId);
    };

    const handleResize = (): void => {
      render();
    };

    canvas.addEventListener("click", handleClick);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    globalThis.window?.addEventListener("resize", handleResize);
    render();

    return () => {
      if (canvasHost !== host || canvas === null) {
        return;
      }

      canvas.removeEventListener("click", handleClick);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      globalThis.window?.removeEventListener("resize", handleResize);
      host.innerHTML = "";
      canvas = null;
      context = null;
      canvasHost = null;
    };
  };

  const failBackend = (error: unknown): RuntimeSnapshot => {
    backendError = error instanceof Error ? error.message : String(error);
    dead = true;
    previewCoordinator.invalidateRoute();
    previewCoordinator.invalidateRoadMutation();
    activeRoadMutation = null;
    stop();
    return publish();
  };

  const queueBackend = (
    operation: () => Promise<RuntimeSnapshot>,
    onError: (error: unknown) => RuntimeSnapshot = failBackend,
  ): Promise<RuntimeSnapshot> => {
    if (dead) {
      // The backend is fatally failed; do not attempt further operations.
      // Return the last published snapshot so callers still resolve.
      return Promise.resolve(getSnapshot());
    }
    const run = gameplayQueue.then(() => {
      // Re-check `dead` at execution time: a prior queued operation may have
      // failed fatally between enqueue and run, setting `dead` after this call
      // passed its enqueue-time guard. Without this, the later operation would
      // still hit the backend and, on success, clear `backendError` even though
      // the runtime was stopped as fatal.
      if (dead) {
        return getSnapshot();
      }
      return operation();
    });
    gameplayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch(onError);
  };

  const enqueueDispatch = (
    intent: GameIntent,
    nextUi?: UiState | ((applied: boolean, currentUi: UiState) => UiState),
  ): Promise<RuntimeSnapshot> =>
    queueBackend(async () => {
      const result = await backend.dispatch(intent);
      backendError = null;
      rejection = result.rejection;
      const resolvedUi =
        typeof nextUi === "function"
          ? nextUi(result.applied, ui)
          : (nextUi ?? ui);
      return commit(normalizeRustSnapshot(result.snapshot), resolvedUi);
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
      rejection = result.rejection;
      const resolvedUi =
        typeof nextUi === "function"
          ? nextUi(result.applied, ui)
          : (nextUi ?? ui);
      return commit(normalizeRustSnapshot(result.snapshot), resolvedUi);
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
      return commit(normalizeRustSnapshot(result.snapshot), ui);
    });

  const requestRoutePreview = (draft: RouteDraft): void => {
    if (dead) return;
    const { instanceId, generation } = draft;
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
        const current = ui.routeDraft;
        if (
          response === null ||
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
            preview: response,
          },
          routePreviewError:
            ui.routePreviewError?.code === "invalidRouteDraftInteraction"
              ? ui.routePreviewError
              : response.rejection,
        });
      })
      .catch((error: unknown) => {
        failBackend(error);
      });
  };

  const commitRouteDraft = (routeDraft: RouteDraft): RuntimeSnapshot => {
    if (routeDraft === ui.routeDraft) {
      return commit(state, ui);
    }
    const result = commit(state, {
      ...ui,
      routeDraft,
      routePreviewError: null,
    });
    requestRoutePreview(routeDraft);
    return result;
  };

  const rejectRouteDraftInteraction = (
    error: RouteDraftInteractionError,
  ): RuntimeSnapshot =>
    commit(state, {
      ...ui,
      routePreviewError: error,
    });

  const startRouteEdit = (routeId: string): RuntimeSnapshot => {
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
    const result = commit(state, {
      ...ui,
      activeTool: route === undefined ? "metroLine" : "busRoute",
      selectedNodeKind: null,
      selectedBuilding: null,
      selectedArea: null,
      buildCategory: null,
      routeDraft,
      routePreviewError: null,
      selectedRouteId: routeId,
      routeFailureFocus: null,
      drag: null,
    });
    requestRoutePreview(routeDraft);
    return result;
  };

  const saveRouteDraft = async (): Promise<RuntimeSnapshot> => {
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
        }
        if (result.applied && tokenIsCurrent) {
          previewCoordinator.invalidateRoute();
          return commit(normalizeRustSnapshot(result.snapshot), {
            ...ui,
            routeDraft: null,
            routePreviewError: null,
          });
        }
        return commit(normalizeRustSnapshot(result.snapshot), ui);
      },
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
    previewCoordinator.invalidateRoute();
    return commit(state, cancelDraftRoute(ui));
  };

  const reloadRouteDraft = (): RuntimeSnapshot => {
    const draft = ui.routeDraft;
    if (
      draft?.source.kind !== "edit" ||
      rejection?.code !== "routeChangedWhileEditing" ||
      rejection.context.routeId !== draft.source.routeId
    ) {
      return commit(state, ui);
    }
    rejection = null;
    return startRouteEdit(draft.source.routeId);
  };

  const handleEscape = (): RuntimeSnapshot =>
    ui.routeDraft === null ? api.resetUi() : cancelRouteDraft();

  const requestRoadMutationPreview = (
    mutation: RoadMutation,
  ): RuntimeSnapshot => {
    if (dead) return getSnapshot();
    const generation = ui.roadPreviewGeneration + 1;
    activeRoadMutation = mutation;
    const pending = commit(state, {
      ...ui,
      roadPreviewGeneration: generation,
      roadMutationPreview: null,
    });
    void previewCoordinator
      .requestRoadMutation({ mutation, generation })
      .then((response) => {
        if (
          response === null ||
          activeRoadMutation === null ||
          ui.roadPreviewGeneration !== generation
        ) {
          return;
        }
        commit(state, { ...ui, roadMutationPreview: response });
      })
      .catch((error: unknown) => {
        failBackend(error);
      });
    return pending;
  };

  const invalidateRoadPreview = (): void => {
    previewCoordinator.invalidateRoadMutation();
    activeRoadMutation = null;
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

  const api: RuntimeController = {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    isRunning() {
      return running;
    },
    tick(deltaSeconds) {
      return enqueueTick(deltaSeconds);
    },
    reset() {
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return queueBackend(async () => {
        const snapshot = await backend.reset();
        backendError = null;
        rejection = null;
        state = normalizeRustSnapshot(snapshot);
        ui = createUiState();
        return publish();
      });
    },
    resetUi() {
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, createUiState());
    },
    setTool(tool) {
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
      }
      const snapshot = commit(state, next);
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
    },
    setBuilding(building) {
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextBuildingUiState(building, ui));
    },
    setArea(area) {
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      return commit(state, nextAreaUiState(area, ui));
    },
    setRoadPreset(preset) {
      const snapshot = commit(
        state,
        ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
      );
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
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
      // Single commit: switch to the road tool (which clears building/area and
      // closes the drawer via nextToolUiState) and set the preset together, so
      // one click fully arms the tool with no intermediate render.
      previewCoordinator.invalidateRoute();
      invalidateRoadPreview();
      const snapshot = commit(state, {
        ...nextToolUiState("road", ui),
        roadPreset: preset,
      });
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
    },
    startDrag(point) {
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
      const snapshot = commit(state, {
        ...ui,
        drag: { tool, start: point, current: point },
      });
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
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
      const snapshot = commit(state, {
        ...ui,
        drag: { ...ui.drag, current: point },
      });
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
    },
    cancelDrag() {
      invalidateRoadPreview();
      return commit(
        state,
        ui.drag === null
          ? ui
          : { ...ui, drag: null, roadMutationPreview: null },
      );
    },
    commitDrag() {
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
      commit(state, { ...ui, drag: null, roadMutationPreview: null });
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
      if (ui.routeDraft?.source.kind === "edit") {
        const handleIndex = draftHandleIndexAtPoint(
          ui.routeDraft,
          state,
          point,
        );
        if (handleIndex !== null) {
          const routeDraft = selectWaypoint(
            ui.routeDraft,
            handleIndex,
            ui.routeDraft.interaction,
          );
          return commit(
            state,
            routeDraft === ui.routeDraft
              ? ui
              : { ...ui, routeDraft, routePreviewError: null },
          );
        }
      }
      if (
        (ui.activeTool === "inspect" && ui.selectedBuilding === null) ||
        ui.activeTool === "busRoute" ||
        ui.activeTool === "metroLine"
      ) {
        const previousDraft = ui.routeDraft;
        const result = applyUiTileClick(state, ui, point);
        const snapshot = commit(state, result.ui);
        if (
          ui.routeDraft !== null &&
          ui.routeDraft !== previousDraft &&
          ui.routePreviewError === null
        ) {
          requestRoutePreview(ui.routeDraft);
        }
        return snapshot;
      }

      if (ui.activeTool === "road") {
        // Defer the lay-vs-cycle decision to execution time so the tile kind is
        // re-read against the latest map state after earlier queued updates
        // drain (see `roadClickIntent`).
        return enqueueComputedDispatch(() => roadClickIntent(point));
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
      return routeDraft === ui.routeDraft
        ? rejectRouteDraftInteraction({
            code: "invalidRouteDraftInteraction",
            context: { operation: "selectWaypoint", waypointIndex: index },
          })
        : commitRouteDraft(routeDraft);
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
      if (samePoint(point, ui.hoverTile)) {
        return commit(state, ui);
      }
      if (point === null) {
        invalidateRoadPreview();
      }
      const snapshot = commit(state, {
        ...ui,
        hoverTile: point,
        ...(point === null ? { roadMutationPreview: null } : {}),
      });
      const mutation = roadMutationForUi(ui);
      return mutation === null
        ? snapshot
        : requestRoadMutationPreview(mutation);
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
    mountCanvas,
  };

  return api;
}
