import type { AreaKind, BuildingType, Point, Tool } from "../domain/types";
import { canvasToTile, renderGame, syncCanvasSize } from "../render/canvas";
import { paintAreaRectangle } from "../simulation/areas";
import { createInitialGameState } from "../simulation/gameState";
import { tickSimulation } from "../simulation/simulation";
import {
  assignRouteToPlatform as applyAssignRouteToPlatform,
  deleteRoute as applyDeleteRoute,
  renameRoute as applyRenameRoute,
  setRouteActive as applySetRouteActive,
  setRouteColor as applySetRouteColor,
} from "../simulation/transit";
import {
  cancelDraftRoute,
  finishDraftRoute,
  handleTileClick as applyTileClick,
  removeDraftNode as applyRemoveDraftNode,
} from "../ui/actions";
import { applyDragGesture, axisLockedLine } from "../ui/roadDrag";
import { createUiState } from "../ui/uiState";
import { selectShellState } from "./runtimeSelectors";
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

export function createGameRuntime(): RuntimeController {
  let state = createInitialGameState();
  let ui = createUiState();
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
      commit(tickSimulation(state, deltaSeconds), ui);
    } else {
      render();
    }

    syncAnimationLoop();
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
        return; // road/track/remove are driven by pointerdown/up below.
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
      return commit(tickSimulation(state, deltaSeconds), ui);
    },
    reset() {
      state = createInitialGameState();
      ui = createUiState();
      return publish();
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
      if (gesture.tool === "area") {
        return commit(
          paintAreaRectangle(
            state,
            gesture.area,
            gesture.start,
            gesture.current,
          ),
          { ...ui, drag: null },
        );
      }
      const line = axisLockedLine(gesture.start, gesture.current);
      // A tap (single tile) reuses the legacy click path so road cycling and
      // the full remove (buildings/nodes/routes + UI cleanup) are preserved.
      if (line.length <= 1) {
        const result = applyTileClick(state, ui, line[0]);
        return commit(result.state, { ...result.ui, drag: null });
      }
      // A remove drag deletes every tile via the same full per-tile removal.
      if (gesture.tool === "remove") {
        let nextState = state;
        let nextUi = ui;
        for (const point of line) {
          const result = applyTileClick(nextState, nextUi, point);
          nextState = result.state;
          nextUi = result.ui;
        }
        return commit(nextState, { ...nextUi, drag: null });
      }
      // A road/track build drag uses the preset-aware line painter.
      return commit(applyDragGesture(state, ui, line), {
        ...ui,
        drag: null,
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
      return commit({ ...state, paused: !state.paused }, ui);
    },
    setSpeed(speed) {
      return commit(speed === state.speed ? state : { ...state, speed }, ui);
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
      const result = applyTileClick(state, ui, point);
      return commit(result.state, result.ui);
    },
    assignRouteToPlatform(nodeId, routeId, platformId) {
      return commit(
        applyAssignRouteToPlatform(state, nodeId, routeId, platformId),
        ui,
      );
    },
    removeDraftStop(index) {
      return commit(state, applyRemoveDraftNode(state, ui, index));
    },
    finishRoute() {
      const result = finishDraftRoute(state, ui);
      return commit(result.state, result.ui);
    },
    cancelRoute() {
      return commit(state, cancelDraftRoute(ui));
    },
    renameRoute(routeId, name) {
      return commit(applyRenameRoute(state, routeId, name), ui);
    },
    recolorRoute(routeId, color) {
      return commit(applySetRouteColor(state, routeId, color), ui);
    },
    toggleRouteActive(routeId) {
      const route =
        state.transit.routes.find((r) => r.id === routeId) ??
        state.transit.metroLines.find((l) => l.id === routeId);
      if (route === undefined) {
        return commit(state, ui);
      }
      return commit(applySetRouteActive(state, routeId, !route.active), ui);
    },
    deleteRoute(routeId) {
      const nextUi =
        ui.selectedRouteId === routeId ? { ...ui, selectedRouteId: null } : ui;
      return commit(applyDeleteRoute(state, routeId), nextUi);
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
    mountCanvas,
  };

  return api;
}
