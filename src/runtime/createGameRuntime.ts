import type { AreaKind, BuildingType, Point, Tool } from "../domain/types";
import { canvasToTile, renderGame, syncCanvasSize } from "../render/canvas";
import {
  cancelDraftRoute,
  applyUiTileClick,
  removeDraftNode as applyRemoveDraftNode,
} from "../ui/actions";
import { axisLockedLine } from "../ui/roadDrag";
import { createUiState, type UiState } from "../ui/uiState";
import type { GameBackend, GameIntent } from "./backend";
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
    buildingRotation: 0 as const,
    draftStopIds: activeTool === "busRoute" ? current.draftStopIds : [],
    draftStationIds: activeTool === "metroLine" ? current.draftStationIds : [],
    draftStopPaths: activeTool === "busRoute" ? current.draftStopPaths : [],
    draftStationPaths:
      activeTool === "metroLine" ? current.draftStationPaths : [],
    selectedRouteId: null,
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
    buildingRotation: 0 as const,
    draftStopIds: [],
    draftStationIds: [],
    draftStopPaths: [],
    draftStationPaths: [],
    selectedRouteId: null,
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
    buildingRotation: 0 as const,
    draftStopIds: [],
    draftStationIds: [],
    draftStopPaths: [],
    draftStationPaths: [],
    selectedRouteId: null,
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
  let rejection: string | null = null;
  let gameplayQueue: Promise<void> = Promise.resolve();
  let running = false;
  let animationFrameId: number | null = null;
  let lastFrameTime: number | null = null;
  let canvasHost: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui),
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
    stop();
    return publish();
  };

  const queueBackend = (
    operation: () => Promise<RuntimeSnapshot>,
  ): Promise<RuntimeSnapshot> => {
    const run = gameplayQueue.then(operation);
    gameplayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch(failBackend);
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
    if (ui.activeTool === "road") {
      const tile = state.map.tiles.find(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      return tile?.kind === "road"
        ? { type: "cycleRoadDirection", point }
        : { type: "layRoad", point };
    }
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
      return commit(state, createUiState());
    },
    setTool(tool) {
      return commit(state, nextToolUiState(tool, ui));
    },
    setBuilding(building) {
      return commit(state, nextBuildingUiState(building, ui));
    },
    setArea(area) {
      return commit(state, nextAreaUiState(area, ui));
    },
    setRoadPreset(preset) {
      return commit(
        state,
        ui.roadPreset === preset ? ui : { ...ui, roadPreset: preset },
      );
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
      return commit(state, {
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
      return commit(state, {
        ...ui,
        drag: { ...ui.drag, current: point },
      });
    },
    cancelDrag() {
      return commit(state, ui.drag === null ? ui : { ...ui, drag: null });
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
      commit(state, { ...ui, drag: null });
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
      return commit(
        state,
        category === ui.activeHudCategory
          ? ui
          : { ...ui, activeHudCategory: category },
      );
    },
    handleTileClick(point) {
      if (
        (ui.activeTool === "inspect" && ui.selectedBuilding === null) ||
        ui.activeTool === "busRoute" ||
        ui.activeTool === "metroLine"
      ) {
        const result = applyUiTileClick(state, ui, point);
        return commit(state, result.ui);
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
    removeDraftStop(index) {
      return commit(state, applyRemoveDraftNode(state, ui, index));
    },
    finishRoute() {
      // Finishing a draft is a two-step backend transaction: create the line,
      // then assign a vehicle to it. The old TS `finishDraftRoute` performed
      // both atomically; the Rust core exposes them as separate intents
      // (`addBusRoute`/`addMetroLine` then `assignVehicle`), so chain them
      // inside one queued operation. Without the `assignVehicle` step the new
      // line has `vehicleIds: []` forever and no transit trip can ever board —
      // the survival win-gate becomes unwinnable except by walking.
      const isBus = ui.activeTool === "busRoute";
      const isMetro = ui.activeTool === "metroLine";
      if (!isBus && !isMetro) {
        return commit(state, ui);
      }

      const mode: "bus" | "metro" = isBus ? "bus" : "metro";
      const createIntent: GameIntent = isBus
        ? { type: "addBusRoute", stopIds: ui.draftStopIds }
        : { type: "addMetroLine", stationIds: ui.draftStationIds };
      const submittedDraftIds = isBus ? ui.draftStopIds : ui.draftStationIds;
      const submittedDraftPaths = isBus
        ? ui.draftStopPaths
        : ui.draftStationPaths;

      return queueBackend(async () => {
        // Re-read the draft at closure entry: a prior queued finish (e.g. a
        // double-click that enqueued twice synchronously) will have cleared
        // the draft after its successful dispatch, so this closure must bail
        // rather than re-dispatch the same addBusRoute/addMetroLine intent
        // (which would duplicate the route, double-charge, and mint a second
        // vehicle). Mirrors commitDrag's synchronous clear-before-dispatch.
        const currentDraftIds = isBus ? ui.draftStopIds : ui.draftStationIds;
        if (currentDraftIds.length === 0) {
          return commit(state, ui);
        }

        const beforeIds = new Set(
          (isBus ? state.transit.routes : state.transit.metroLines).map(
            (entry) => entry.id,
          ),
        );
        const createResult = await backend.dispatch(createIntent);
        backendError = null;
        rejection = createResult.rejection;
        const afterCreate = normalizeRustSnapshot(createResult.snapshot);

        // Clear the submitted draft only when the backend accepted the line
        // and the draft has not been mutated while the dispatch was in flight
        // (parity with the previous single-dispatch `applied` gate). Read `ui`
        // after the dispatch resolves so a newer draft survives a slow finish.
        const draftUnchanged = isBus
          ? ui.draftStopIds === submittedDraftIds &&
            ui.draftStopPaths === submittedDraftPaths
          : ui.draftStationIds === submittedDraftIds &&
            ui.draftStationPaths === submittedDraftPaths;
        const nextUi =
          createResult.applied && draftUnchanged
            ? isBus
              ? { ...ui, draftStopIds: [], draftStopPaths: [] }
              : {
                  ...ui,
                  draftStationIds: [],
                  draftStationPaths: [],
                }
            : ui;

        if (!createResult.applied) {
          return commit(afterCreate, nextUi);
        }

        // Identify the freshly created line by diffing ids, then assign a
        // vehicle. If the line cannot be resolved (e.g. the backend accepted
        // but did not surface a new id), keep the accepted snapshot rather
        // than silently dropping the route.
        const afterRoutes = isBus
          ? afterCreate.transit.routes
          : afterCreate.transit.metroLines;
        const newLine = afterRoutes.find((entry) => !beforeIds.has(entry.id));
        if (newLine === undefined) {
          return commit(afterCreate, nextUi);
        }

        const vehicleResult = await backend.dispatch({
          type: "assignVehicle",
          mode,
          lineId: newLine.id,
        });
        if (!vehicleResult.applied) {
          // The line was created but no vehicle could be assigned to it. The
          // route is left in place (the player can delete it); surface the
          // rejection as a recoverable status (not a fatal backendError) so
          // the player understands why the line has no service without the
          // runtime halting.
          rejection = vehicleResult.rejection ?? "assignVehicle rejected";
          return commit(normalizeRustSnapshot(vehicleResult.snapshot), nextUi);
        }
        rejection = null;
        return commit(normalizeRustSnapshot(vehicleResult.snapshot), nextUi);
      });
    },
    cancelRoute() {
      return commit(state, cancelDraftRoute(ui));
    },
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
      // survive (parity with `finishRoute`'s `applied` gate).
      return enqueueDispatch(
        { type: "deleteRoute", routeId },
        (applied, currentUi) =>
          applied && currentUi.selectedRouteId === routeId
            ? { ...currentUi, selectedRouteId: null }
            : currentUi,
      );
    },
    selectRoute(routeId) {
      const nextId = ui.selectedRouteId === routeId ? null : routeId;
      return commit(
        state,
        nextId === ui.selectedRouteId ? ui : { ...ui, selectedRouteId: nextId },
      );
    },
    setHoverTile(point) {
      return commit(
        state,
        samePoint(point, ui.hoverTile) ? ui : { ...ui, hoverTile: point },
      );
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
