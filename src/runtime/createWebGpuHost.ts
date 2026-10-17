import type { GameMap, GameState, Point, Tool } from "../domain/types";
import type { UiState } from "../ui/uiState";
import {
  applyCameraAction,
  applyCanvasPixelSize,
  canvasToTile,
  getBoardTransform,
  panCamera,
  syncCanvasSize,
  visibleWorldRect,
  zoomCameraAt,
  type Camera,
  type CameraAction,
} from "../render/boardTransform";
import { SOLID_VERTEX_FLOATS } from "../render/webgpu/primitives";
import { buildMapBatch } from "../render/webgpu/mapBatch";
import {
  buildTransitBatch,
  routeStyleKeyFor,
} from "../render/webgpu/transitBatch";
import { buildOverlayRanges } from "../render/webgpu/overlayBatch";
import {
  encodeVehicleInstances,
  interpolationAlpha,
} from "../render/webgpu/vehicleInstances";
import {
  createWebGpuRenderer,
  VEHICLE_INSTANCE_FLOATS,
  type WebGpuCapturedFrame,
  type WebGpuRenderFrame,
  type WebGpuRenderer,
} from "../render/webgpu/renderer";

/** Tools that drive placement via a press-drag gesture rather than a click. */
const DRAG_TOOLS = new Set<Tool>(["road", "track", "remove", "area"]);

/** Wall time that must accumulate before one host tick is admitted (10 Hz). */
const TICK_INTERVAL_MS = 100;
/** Per-frame wall-delta clamp; also the upper bound on any single submitted
 *  tick delta, so a throttled-background spike cannot jump the sim. */
const MAX_FRAME_DELTA_MS = 250;
/** Pointer travel (CSS px) before a click-tool press becomes a map pan, so an
 *  ordinary click still selects or places. */
const PAN_THRESHOLD_PX = 4;
/** Wheel zoom sensitivity per wheel delta pixel; pinch (ctrlKey) deltas are
 *  smaller, so they get a stronger factor. */
const WHEEL_ZOOM_PER_PX = 0.0015;
const PINCH_ZOOM_PER_PX = 0.01;

/**
 * Callbacks the WebGPU host uses to read runtime state and forward DOM events
 * back into the controller. `onTick` may return the tick's promise so the
 * host can keep its one-in-flight admission gate; a void return is treated as
 * resolving immediately.
 */
export interface WebGpuHostContext {
  getState: () => GameState;
  getUi: () => UiState;
  /** Runtime-owned map view; `null` fits the whole map. */
  getCamera: () => Camera | null;
  /** Report a new clamped camera from wheel/pan input or `adjustCamera`. */
  onCameraChange: (camera: Camera | null) => void;
  /** Runtime-owned scene revision (bumped by `acceptPresentationUpdate`). */
  getSceneRevision: () => number;
  onTick: (deltaSeconds: number) => unknown;
  onTileClick: (point: Point) => void;
  onHoverTile: (point: Point | null) => void;
  /** Handle a route-draft context menu. Return true to consume the browser menu. */
  onRouteDraftContextMenu: () => boolean;
  /** Begin a drag gesture at `point`. Returns `true` when a drag is now active
   *  (so the host can capture the pointer for a clean release at the edge). */
  onDragStart: (point: Point) => boolean;
  onDragCurrent: (point: Point | null) => void;
  onDragCommit: () => void;
  onDragCancel: () => void;
  /** Fatal, terminal host failure (e.g. unexpected device loss). */
  onFatalError: (error: unknown) => void;
}

export interface GameHost {
  mount(host: HTMLElement): () => void;
  render(): void;
  start(): void;
  stop(): void;
  syncAnimationLoop(): void;
  isRunning(): boolean;
  /** Apply a button/key camera action against the current board size. */
  adjustCamera(action: CameraAction): void;
  /** Rebuilds the current frame and reads its pixels back from an offscreen
   *  render target. Deterministic under software Vulkan, where canvas
   *  presentation never reaches the compositor; e2e pixel oracles use this
   *  instead of canvas-side readbacks. Returns null while no canvas is
   *  mounted. */
  captureFrame(): Promise<WebGpuCapturedFrame | null>;
}

export type CreateGameHost = (context: WebGpuHostContext) => Promise<GameHost>;

/** World-space batch caches keyed by scene revision / route emphasis. */
interface BatchCache {
  key: string;
  map: GameMap | null;
  vertices: Float32Array<ArrayBuffer>;
}

/** World-pixels → clip-space affine, derived from the board fit and DPR. */
interface ClipTransform {
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

/**
 * Builds the host around an existing renderer. Tests inject a narrow fake
 * renderer here; production passes the real WebGPU renderer.
 */
export function createWebGpuHostWithRenderer(
  ctx: WebGpuHostContext,
  renderer: WebGpuRenderer,
  /** The GPU device the caller created for `renderer`. Teardown destroys it
   *  after the renderer; tests injecting a fake renderer omit it. */
  device?: GPUDevice,
): GameHost {
  let surfaceHost: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let running = false;
  let animationFrameId: number | null = null;
  // A one-shot repaint scheduled outside the animation loop; drawEpoch
  // invalidates a callback that outlived its cancellation.
  let pendingDrawId: number | null = null;
  let drawEpoch = 0;
  let lastFrameTime: number | null = null;
  /** CSS box size from ResizeObserver (avoids getBoundingClientRect every frame). */
  let observedCssWidth = 0;
  let observedCssHeight = 0;
  let hasObservedSize = false;
  /** CSS board size used by the latest draw; the camera is clamped against it. */
  let boardCssWidth = 0;
  let boardCssHeight = 0;
  let resizeObserver: ResizeObserver | null = null;
  let activeDetach: (() => void) | null = null;

  // 10 Hz one-in-flight tick admission.
  let accumulatedMs = 0;
  let tickInFlight = false;
  // Wall-clock time of the last admission. While a tick is in flight the
  // accumulator can build a multi-interval backlog; pacing admissions by the
  // last-admission timestamp drains it at one tick per interval instead of
  // one per rAF.
  let lastTickAdmittedAtMs: number | null = null;

  // Observed presentation history for vehicle interpolation.
  let latestState: GameState | null = null;
  let previousState: GameState | null = null;
  let latestSceneRevision = 0;
  let latestObservedAtMs = 0;
  let previousObservedAtMs = 0;

  // World-space tessellation caches (the expensive part); vertex transforms
  // to clip space are applied per draw.
  let sceneCache: BatchCache | null = null;
  let routeCache: BatchCache | null = null;

  let transform: ClipTransform | null = null;

  // Unexpected device loss is terminal: one loud fatal error, no recreation,
  // no Canvas fallback. A deliberate destroy() loss is ignored.
  void renderer.lost.then((info) => {
    if (info.reason === "destroyed") return;
    ctx.onFatalError(
      new Error(
        info.message
          ? `WebGPU device lost: ${info.message}`
          : "WebGPU device lost",
      ),
    );
  });

  const observeState = (
    nowMs: number,
  ): { latest: GameState; previous: GameState | null; alpha: number } => {
    const state = ctx.getState();
    if (state !== latestState) {
      const revision = ctx.getSceneRevision();
      if (latestState === null || revision !== latestSceneRevision) {
        // First observation or scene change: no interpolation base.
        previousState = null;
        previousObservedAtMs = 0;
      } else {
        previousState = latestState;
        previousObservedAtMs = latestObservedAtMs;
      }
      latestState = state;
      latestSceneRevision = revision;
      latestObservedAtMs = nowMs;
    }
    return {
      latest: latestState,
      previous: previousState,
      alpha:
        previousState === null
          ? 1
          : interpolationAlpha(previousObservedAtMs, latestObservedAtMs, nowMs),
    };
  };

  const sceneVertices = (
    state: GameState,
    revision: number,
  ): Float32Array<ArrayBuffer> => {
    if (
      sceneCache === null ||
      sceneCache.key !== `scene:${revision}` ||
      sceneCache.map !== state.map
    ) {
      sceneCache = {
        key: `scene:${revision}`,
        map: state.map,
        vertices: buildMapBatch(state),
      };
    }
    return sceneCache.vertices;
  };

  const routeVertices = (
    state: GameState,
    ui: UiState,
    revision: number,
  ): Float32Array<ArrayBuffer> => {
    const key = routeStyleKeyFor(ui, revision);
    if (routeCache === null || routeCache.key !== key) {
      routeCache = {
        key,
        map: null,
        vertices: buildTransitBatch(state, ui, revision).vertices,
      };
    }
    return routeCache.vertices;
  };

  const syncSize = (target: HTMLCanvasElement): void => {
    let cssWidth: number;
    let cssHeight: number;
    if (hasObservedSize) {
      cssWidth = observedCssWidth;
      cssHeight = observedCssHeight;
      applyCanvasPixelSize(target, cssWidth, cssHeight);
    } else {
      // Fallback when ResizeObserver is unavailable: one layout read per paint.
      const rect = target.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      syncCanvasSize(target);
    }
    const dpr = globalThis.devicePixelRatio ?? 1;
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    boardCssWidth = cssWidth;
    boardCssHeight = cssHeight;
    const board = getBoardTransform(
      { width: cssWidth, height: cssHeight },
      ctx.getState().map,
      ctx.getCamera(),
    );
    transform = {
      sx: (2 * board.scale * dpr) / pixelWidth,
      ox: (2 * board.offsetX * dpr) / pixelWidth - 1,
      sy: -(2 * board.scale * dpr) / pixelHeight,
      oy: 1 - (2 * board.offsetY * dpr) / pixelHeight,
    };
    renderer.resize(pixelWidth, pixelHeight);
  };

  const transformVertices = (
    vertices: Float32Array<ArrayBuffer>,
  ): Float32Array<ArrayBuffer> => {
    const t = transform;
    if (t === null || vertices.length === 0) {
      return vertices;
    }
    const out = new Float32Array(vertices.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < vertices.length; i += SOLID_VERTEX_FLOATS) {
      out[i] = vertices[i] * t.sx + t.ox;
      out[i + 1] = vertices[i + 1] * t.sy + t.oy;
      out[i + 2] = vertices[i + 2];
      out[i + 3] = vertices[i + 3];
      out[i + 4] = vertices[i + 4];
      out[i + 5] = vertices[i + 5];
    }
    return out;
  };

  const transformInstances = (
    instances: Float32Array<ArrayBuffer>,
  ): Float32Array<ArrayBuffer> => {
    const t = transform;
    if (t === null || instances.length === 0) {
      return instances;
    }
    const out = new Float32Array(instances.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < instances.length; i += VEHICLE_INSTANCE_FLOATS) {
      // Project only the origin; the shader rotates the world-px body and
      // scales it by the per-instance clip factors (sy carries the y-flip,
      // so angle and extents are passed through raw).
      out[i] = instances[i] * t.sx + t.ox;
      out[i + 1] = instances[i + 1] * t.sy + t.oy;
      out[i + 2] = instances[i + 2];
      out[i + 3] = instances[i + 3];
      out[i + 4] = instances[i + 4];
      out[i + 5] = t.sx;
      out[i + 6] = t.sy;
      out[i + 7] = instances[i + 5];
      out[i + 8] = instances[i + 6];
      out[i + 9] = instances[i + 7];
      out[i + 10] = instances[i + 8];
    }
    return out;
  };

  /** Assembles the frame's batches from the observed state — the exact input
   *  both drawFrame and captureFrame hand to the renderer. */
  const buildFrame = (nowMs: number): WebGpuRenderFrame => {
    const { latest, previous, alpha } = observeState(nowMs);
    const ui = ctx.getUi();
    const revision = ctx.getSceneRevision();
    const overlays = buildOverlayRanges(latest, ui);
    const map = latest.map;
    const instances = encodeVehicleInstances({
      previous,
      latest,
      ui,
      alpha,
      // Pause or speed 0: every vehicle snaps to its latest cursor.
      paused: latest.paused || latest.speed === 0,
      viewport: visibleWorldRect(
        { width: boardCssWidth, height: boardCssHeight },
        map,
        ctx.getCamera(),
      ),
    });
    return {
      solids: [
        {
          role: "structural",
          vertices: transformVertices(sceneVertices(latest, revision)),
        },
        {
          role: "dynamic",
          vertices: transformVertices(overlays.underRoutes),
        },
        {
          role: "route",
          vertices: transformVertices(routeVertices(latest, ui, revision)),
        },
        {
          role: "dynamic",
          vertices: transformVertices(overlays.routeDraft),
        },
      ],
      vehicles: [{ instances: transformInstances(instances) }],
      overVehicles: [
        {
          role: "dynamic",
          vertices: transformVertices(overlays.overVehicles),
        },
      ],
    };
  };

  const drawFrame = (nowMs: number): void => {
    if (canvas === null) {
      return;
    }
    syncSize(canvas);
    renderer.render(buildFrame(nowMs));
  };

  const captureFrame = (): Promise<WebGpuCapturedFrame | null> => {
    if (canvas === null) {
      return Promise.resolve(null);
    }
    // Same sizing/transform prep as drawFrame so the capture is in the same
    // device-pixel space as the presented canvas.
    syncSize(canvas);
    return renderer.captureFrame(buildFrame(performance.now()));
  };

  const cancelPendingFrame = (): void => {
    if (
      animationFrameId !== null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (pendingDrawId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingDrawId);
      pendingDrawId = null;
    }
    // A callback already delivered to the frame queue can still fire after
    // cancellation; the epoch check makes it a no-op.
    drawEpoch += 1;
    lastFrameTime = null;
    // No stale catch-up across pause/stop/remount boundaries.
    accumulatedMs = 0;
    lastTickAdmittedAtMs = null;
  };

  const canAnimate = (): boolean => {
    const state = ctx.getState();
    return (
      running &&
      !state.paused &&
      state.metrics.state === "running" &&
      state.speed !== 0
    );
  };

  const admitTick = (deltaSeconds: number): void => {
    tickInFlight = true;
    try {
      const result = ctx.onTick(deltaSeconds);
      if (result instanceof Promise) {
        void result
          .catch(() => {})
          .finally(() => {
            tickInFlight = false;
          });
      } else {
        tickInFlight = false;
      }
    } catch {
      tickInFlight = false;
    }
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

    cancelPendingFrame();
  };

  const render = (): void => {
    if (canvas === null) {
      return;
    }
    // While an active rAF owns display it draws the latest state next frame;
    // drawing here too would double-render around every accepted tick. The
    // same applies to explicit repaints: callers can fire many per frame
    // (a pointermove commit each), so they coalesce into one frame-scheduled
    // draw instead of blocking input handling on a full frame build+submit.
    if (animationFrameId !== null || pendingDrawId !== null) {
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      drawFrame(performance.now());
      return;
    }
    const epoch = drawEpoch;
    pendingDrawId = requestAnimationFrame((timestamp) => {
      pendingDrawId = null;
      if (epoch !== drawEpoch || canvas === null || animationFrameId !== null) {
        return;
      }
      drawFrame(timestamp);
    });
  };

  const frame = (timestamp: number): void => {
    animationFrameId = null;

    if (!running) {
      return;
    }

    const previousTimestamp = lastFrameTime ?? timestamp;
    lastFrameTime = timestamp;
    accumulatedMs += Math.min(
      Math.max(0, timestamp - previousTimestamp),
      MAX_FRAME_DELTA_MS,
    );

    if (
      accumulatedMs >= TICK_INTERVAL_MS &&
      !tickInFlight &&
      (lastTickAdmittedAtMs === null ||
        timestamp - lastTickAdmittedAtMs >= TICK_INTERVAL_MS)
    ) {
      const submittedMs = Math.min(accumulatedMs, MAX_FRAME_DELTA_MS);
      accumulatedMs -= submittedMs;
      lastTickAdmittedAtMs = timestamp;
      admitTick(submittedMs / 1000);
    }

    drawFrame(timestamp);
    syncAnimationLoop();
  };

  const start = (): void => {
    if (running) {
      return;
    }

    running = true;
    lastFrameTime = null;
    // Sync before render: on a paused start the sync pass must not cancel
    // the repaint render() schedules; while running, render() coalesces
    // into the loop's rAF.
    syncAnimationLoop();
    render();
  };

  const stop = (): void => {
    running = false;
    lastFrameTime = null;
    syncAnimationLoop();
  };

  const adjustCamera = (action: CameraAction): void => {
    if (!(boardCssWidth > 0 && boardCssHeight > 0)) {
      return;
    }
    ctx.onCameraChange(
      applyCameraAction(
        { width: boardCssWidth, height: boardCssHeight },
        ctx.getState().map,
        ctx.getCamera(),
        action,
      ),
    );
  };

  const mount = (host: HTMLElement): (() => void) => {
    // Same host with an existing canvas: just refresh, reuse the teardown.
    if (surfaceHost === host && canvas !== null) {
      render();
      return teardown;
    }

    // Different host (or first mount): detach any prior mount so its event
    // listeners, ResizeObserver, and window listener don't leak. GPU
    // resources survive the internal re-mount; only unmount destroys them.
    activeDetach?.();
    activeDetach = null;

    const nextCanvas = document.createElement("canvas");
    nextCanvas.dataset.runtimeCanvas = "true";
    nextCanvas.style.width = "100%";
    nextCanvas.style.height = "100%";
    nextCanvas.style.display = "block";
    // Configure before touching mount state so a context failure leaves the
    // prior mount intact and the error surfaces synchronously to the caller.
    renderer.configure(nextCanvas);

    surfaceHost = host;
    host.innerHTML = "";
    canvas = nextCanvas;
    host.appendChild(canvas);
    // Draws are frame-scheduled, but canvasToTile scales client coordinates
    // by the backing store: size it now so a pointer event landing before
    // the first frame still maps to the right tile.
    syncSize(nextCanvas);

    // Map panning: middle-button or Space + left drag pans immediately under
    // every tool; with a click tool a plain left drag pans once it travels
    // past PAN_THRESHOLD_PX, and the click that follows is swallowed.
    let pan: {
      pointerId: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      moved: boolean;
    } | null = null;
    let suppressClick = false;
    let spaceHeld = false;

    const boardRect = (): DOMRect => nextCanvas.getBoundingClientRect();

    const beginPan = (event: PointerEvent, moved: boolean): void => {
      pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved,
      };
      if (moved) {
        capturePointer(event.pointerId);
        nextCanvas.style.cursor = "grabbing";
      }
    };

    const endPan = (pointerId: number): void => {
      if (pan?.moved === true) {
        releasePointer(pointerId);
      }
      pan = null;
      nextCanvas.style.cursor = spaceHeld ? "grab" : "";
    };

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (event.deltaY === 0) {
        return;
      }
      const rect = boardRect();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(
        -pixels * (event.ctrlKey ? PINCH_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX),
      );
      ctx.onCameraChange(
        zoomCameraAt(rect, ctx.getState().map, ctx.getCamera(), factor, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    };

    const handleMouseDown = (event: MouseEvent): void => {
      // Stop middle-button autoscroll; the middle button pans the map.
      if (event.button === 1) {
        event.preventDefault();
      }
    };

    // Space belongs to whatever control has focus (it presses buttons and
    // types in fields); anywhere else it is the pan modifier.
    const isSpaceTarget = (target: EventTarget | null): boolean =>
      !(target instanceof Element) ||
      target.closest(
        "input, textarea, select, button, a[href], [contenteditable='true']",
      ) === null;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== " " || !isSpaceTarget(event.target)) {
        return;
      }
      // Hold Space to pan with the left button; keep it from scrolling.
      event.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        if (pan === null) nextCanvas.style.cursor = "grab";
      }
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key === " ") {
        spaceHeld = false;
        if (pan === null) nextCanvas.style.cursor = "";
      }
    };

    const handleWindowBlur = (): void => {
      spaceHeld = false;
      if (pan === null) nextCanvas.style.cursor = "";
    };

    const handleClick = (event: MouseEvent): void => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (DRAG_TOOLS.has(ctx.getUi().activeTool)) {
        return; // drag tools are driven by pointerdown/up below.
      }

      const point = canvasToTile(
        nextCanvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
        ctx.getCamera(),
      );

      if (point !== null) {
        ctx.onTileClick(point);
      }
    };

    const handleContextMenu = (event: MouseEvent): void => {
      if (ctx.onRouteDraftContextMenu()) {
        event.preventDefault();
      }
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (pan !== null && event.pointerId === pan.pointerId) {
        if (!pan.moved) {
          const travel = Math.hypot(
            event.clientX - pan.startX,
            event.clientY - pan.startY,
          );
          if (travel < PAN_THRESHOLD_PX) {
            return;
          }
          pan.moved = true;
          capturePointer(event.pointerId);
          nextCanvas.style.cursor = "grabbing";
        }
        const dx = event.clientX - pan.lastX;
        const dy = event.clientY - pan.lastY;
        pan.lastX = event.clientX;
        pan.lastY = event.clientY;
        ctx.onCameraChange(
          panCamera(boardRect(), ctx.getState().map, ctx.getCamera(), dx, dy),
        );
        return;
      }
      const point = canvasToTile(
        nextCanvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
        ctx.getCamera(),
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
      if (typeof nextCanvas.setPointerCapture === "function") {
        try {
          nextCanvas.setPointerCapture(pointerId);
        } catch {
          // Some engines throw if the pointer is already inactive; a missed
          // capture only falls back to the pre-capture behavior, so ignore.
        }
      }
    };

    const releasePointer = (pointerId: number): void => {
      if (
        typeof nextCanvas.hasPointerCapture === "function" &&
        typeof nextCanvas.releasePointerCapture === "function" &&
        nextCanvas.hasPointerCapture(pointerId)
      ) {
        nextCanvas.releasePointerCapture(pointerId);
      }
    };

    const handlePointerDown = (event: PointerEvent): void => {
      suppressClick = false;
      const dragTool = DRAG_TOOLS.has(ctx.getUi().activeTool);
      if (
        ctx.getUi().drag === null &&
        (event.button === 1 || (event.button === 0 && spaceHeld))
      ) {
        event.preventDefault();
        beginPan(event, true);
        return;
      }
      if (event.button === 0 && !dragTool && ctx.getUi().drag === null) {
        beginPan(event, false);
        return;
      }
      // Only the primary (left) button initiates a drag. Right/middle clicks
      // would otherwise start a stale drag gesture.
      if (event.button !== 0 || !dragTool) {
        return;
      }
      const point = canvasToTile(
        nextCanvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
        ctx.getCamera(),
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
      if (pan !== null && event.pointerId === pan.pointerId) {
        // A pan that moved swallows the click that follows this release; a
        // press that never moved is an ordinary click.
        suppressClick = pan.moved;
        endPan(event.pointerId);
        return;
      }
      // Only the primary button commits; a stray right/middle release mid-drag
      // must not place the road early.
      if (ctx.getUi().drag === null || event.button !== 0) {
        return;
      }
      const point = canvasToTile(
        nextCanvas,
        event.clientX,
        event.clientY,
        ctx.getState().map,
        ctx.getCamera(),
      );
      // Snap the gesture to the release tile before committing, so a release on
      // a different tile than the last move builds to where the user let go.
      ctx.onDragCurrent(point);
      ctx.onDragCommit();
      releasePointer(event.pointerId);
    };

    const handlePointerLeave = (): void => {
      if (pan !== null) {
        // A captured pan keeps tracking past the edge; an uncaptured press
        // that leaves never became a pan.
        if (!pan.moved) pan = null;
        ctx.onHoverTile(null);
        return;
      }
      // With pointer capture active the browser suppresses leave mid-drag, so
      // reaching here mid-drag means the engine lacks or lost capture. The
      // stroke was already previewed, so commit it at its last tracked tile
      // rather than discarding the gesture.
      if (ctx.getUi().drag !== null) {
        ctx.onDragCommit();
      }
      ctx.onHoverTile(null);
    };

    const handlePointerCancel = (event: PointerEvent): void => {
      if (pan !== null && event.pointerId === pan.pointerId) {
        endPan(event.pointerId);
        return;
      }
      // pointercancel means the browser interrupted the stream (window focus
      // loss, OS-level steal) — it still fires under pointer capture and is
      // not a deliberate abort. A mouse stroke was fully previewed, so commit
      // it; touch/pen cancels can be a genuine UA gesture takeover, so those
      // still abort the drag.
      if (ctx.getUi().drag !== null) {
        if (event.pointerType === "mouse") {
          ctx.onDragCommit();
        } else {
          ctx.onDragCancel();
        }
      }
      ctx.onHoverTile(null);
      releasePointer(event.pointerId);
    };

    const handleResize = (): void => {
      // Window resize is a fallback when ResizeObserver is missing; with an
      // observer the size cache updates from contentRect without layout
      // thrash. `applyCanvasPixelSize` pins the canvas to fixed pixel
      // dimensions after the first paint, so read the board host's content
      // box on every resize to keep the backing store, board transform, and
      // pointer mapping in sync.
      if (surfaceHost !== null) {
        const rect = surfaceHost.getBoundingClientRect();
        observedCssWidth = rect.width;
        observedCssHeight = rect.height;
        hasObservedSize = true;
      }
      render();
    };

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry === undefined) {
          return;
        }
        observedCssWidth = entry.contentRect.width;
        observedCssHeight = entry.contentRect.height;
        hasObservedSize = true;
        render();
      });
      // Observe the board host, not the canvas: `applyCanvasPixelSize`
      // converts the canvas's `100%` CSS size to fixed pixel dimensions on
      // the first render, so the canvas's own content box stops tracking the
      // host afterwards. The host's content box follows the layout.
      resizeObserver.observe(host);
    } else {
      // Seed once so the first paint still gets a correct backing store.
      const rect = canvas.getBoundingClientRect();
      observedCssWidth = rect.width;
      observedCssHeight = rect.height;
      hasObservedSize = true;
      globalThis.window?.addEventListener("resize", handleResize);
    }

    canvas.addEventListener("click", handleClick);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousedown", handleMouseDown);
    globalThis.window?.addEventListener("keydown", handleKeyDown);
    globalThis.window?.addEventListener("keyup", handleKeyUp);
    globalThis.window?.addEventListener("blur", handleWindowBlur);
    canvas.addEventListener("contextmenu", handleContextMenu);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    // Prior detach cancels any pending rAF while leaving `running` true.
    // Reschedule so a remount of an already-started host keeps ticking.
    // Sync before render so the repaint coalesces into a live loop's rAF.
    syncAnimationLoop();
    render();

    function detach(): void {
      if (surfaceHost !== host || canvas === null) {
        return;
      }

      // Cancel any pending frame so unmount cannot leave a dangling rAF that
      // touches a detached canvas (contract: teardown is self-contained even
      // when the controller remains marked running until an explicit stop()).
      cancelPendingFrame();

      // Clear interaction state so a remount does not inherit a live drag or
      // hover from the destroyed canvas.
      if (ctx.getUi().drag !== null) {
        ctx.onDragCancel();
      }
      ctx.onHoverTile(null);

      resizeObserver?.disconnect();
      resizeObserver = null;
      hasObservedSize = false;
      observedCssWidth = 0;
      observedCssHeight = 0;

      canvas.removeEventListener("click", handleClick);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousedown", handleMouseDown);
      globalThis.window?.removeEventListener("keydown", handleKeyDown);
      globalThis.window?.removeEventListener("keyup", handleKeyUp);
      globalThis.window?.removeEventListener("blur", handleWindowBlur);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      canvas.removeEventListener("pointercancel", handlePointerCancel);
      globalThis.window?.removeEventListener("resize", handleResize);
      host.innerHTML = "";
      canvas = null;
      surfaceHost = null;
      activeDetach = null;
    }

    function teardown(): void {
      detach();
      // Unmount is terminal: destroy the renderer's GPU resources and, when
      // the host owns the device, the device too. The resulting deliberate
      // "destroyed" loss is ignored by the lost handler.
      renderer.destroy();
      device?.destroy();
    }

    activeDetach = detach;
    return teardown;
  };

  return {
    mount,
    render,
    start,
    stop,
    syncAnimationLoop,
    isRunning: () => running,
    adjustCamera,
    captureFrame,
  };
}

/**
 * Production host factory: creates the GPU device before returning so the
 * runtime's public `mountCanvas(host): () => void` contract stays synchronous.
 */
export async function createWebGpuHost(
  ctx: WebGpuHostContext,
): Promise<GameHost> {
  if (navigator.gpu === undefined) {
    throw new Error("WebGPU is unavailable in this browser");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) {
    throw new Error("WebGPU adapter unavailable");
  }
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  return createWebGpuHostWithRenderer(
    ctx,
    createWebGpuRenderer(device, format),
    device,
  );
}
