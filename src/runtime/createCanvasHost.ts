import type { GameState, Point, Tool } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { canvasToTile, renderGame, syncCanvasSize } from "../render/canvas";

/** Tools that drive placement via a press-drag gesture rather than a click. */
const DRAG_TOOLS = new Set<Tool>(["road", "track", "remove", "area"]);

/**
 * Callbacks the canvas host uses to read runtime state and forward DOM events
 * back into the controller. The host owns the `<canvas>` element, its 2D
 * context, and the requestAnimationFrame loop; it never mutates game/UI state
 * directly — every state transition goes through these callbacks.
 */
export interface CanvasHostContext {
  getState: () => GameState;
  getUi: () => UiState;
  onTick: (deltaSeconds: number) => void;
  onTileClick: (point: Point) => void;
  onHoverTile: (point: Point | null) => void;
  /** Begin a drag gesture at `point`. Returns `true` when a drag is now active
   *  (so the host can capture the pointer for a clean release at the edge). */
  onDragStart: (point: Point) => boolean;
  onDragCurrent: (point: Point | null) => void;
  onDragCommit: () => void;
  onDragCancel: () => void;
}

export interface CanvasHost {
  mount: (host: HTMLElement) => () => void;
  render: () => void;
  start: () => void;
  stop: () => void;
  syncAnimationLoop: () => void;
  isRunning: () => boolean;
}

/**
 * Owns the imperative canvas surface and its animation loop, decoupled from the
 * runtime controller. The host renders the current snapshot, wires DOM pointer
 * events into controller callbacks, and drives ticks from requestAnimationFrame
 * while the simulation is unpaused and running.
 */
export function createCanvasHost(ctx: CanvasHostContext): CanvasHost {
  let canvasHost: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let running = false;
  let animationFrameId: number | null = null;
  let lastFrameTime: number | null = null;

  const canAnimate = (): boolean => {
    const state = ctx.getState();
    return (
      running &&
      !state.paused &&
      state.metrics.state === "running" &&
      state.speed !== 0
    );
  };

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
    renderGame(context, ctx.getState(), ctx.getUi());
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
      ctx.onTick(deltaSeconds);
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

  const stop = (): void => {
    running = false;
    lastFrameTime = null;
    syncAnimationLoop();
  };

  const mount = (host: HTMLElement): (() => void) => {
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

      if (DRAG_TOOLS.has(ctx.getUi().activeTool)) {
        return; // drag tools are driven by pointerdown/up below.
      }

      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
      );

      if (point !== null) {
        ctx.onTileClick(point);
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
        ctx.getState().map,
      );
      // A live drag tracks its own `current`; only idle movement updates the
      // hover tile (badge / building preview / hover highlight).
      if (ctx.getUi().drag !== null) {
        ctx.onDragCurrent(point);
      } else {
        ctx.onHoverTile(point);
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
        !DRAG_TOOLS.has(ctx.getUi().activeTool)
      ) {
        return;
      }
      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
      );
      if (point === null) {
        return;
      }
      const dragStarted = ctx.onDragStart(point);
      if (dragStarted) {
        capturePointer(event.pointerId);
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      // Only the primary button commits; a stray right/middle release mid-drag
      // must not place the road early.
      if (canvas === null || ctx.getUi().drag === null || event.button !== 0) {
        return;
      }
      const point = canvasToTile(
        canvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
      );
      // Snap the gesture to the release tile before committing, so a release on
      // a different tile than the last move builds to where the user let go.
      ctx.onDragCurrent(point);
      ctx.onDragCommit();
      releasePointer(event.pointerId);
    };

    const handlePointerLeave = (): void => {
      // With pointer capture active the browser suppresses leave mid-drag, so
      // reaching here means the cursor left the board outside a drag — or the
      // host engine lacks pointer capture, in which case an abandoned drag
      // should still be cancelled rather than left dangling.
      if (ctx.getUi().drag !== null) {
        ctx.onDragCancel();
      }
      ctx.onHoverTile(null);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      // pointercancel is a genuine interruption (OS stealing the pointer, etc.)
      // and still fires under pointer capture: tear the drag down explicitly.
      if (ctx.getUi().drag !== null) {
        ctx.onDragCancel();
      }
      ctx.onHoverTile(null);
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

      // Clear interaction state so a remount does not inherit a live drag or
      // hover from the destroyed canvas.
      if (ctx.getUi().drag !== null) {
        ctx.onDragCancel();
      }
      ctx.onHoverTile(null);

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

  return {
    mount,
    render,
    start,
    stop,
    syncAnimationLoop,
    isRunning: () => running,
  };
}
