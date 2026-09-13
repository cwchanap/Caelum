import type { GameMap, GameState, Point, Tool } from "../domain/types";
import type { UiState } from "../ui/uiState";
import {
  applyCanvasPixelSize,
  canvasToTile,
  getBoardTransform,
  syncCanvasSize,
  tileSize,
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

/**
 * Callbacks the WebGPU host uses to read runtime state and forward DOM events
 * back into the controller. `onTick` may return the tick's promise so the
 * host can keep its one-in-flight admission gate; a void return is treated as
 * resolving immediately.
 */
export interface WebGpuHostContext {
  getState: () => GameState;
  getUi: () => UiState;
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
  let lastFrameTime: number | null = null;
  /** CSS box size from ResizeObserver (avoids getBoundingClientRect every frame). */
  let observedCssWidth = 0;
  let observedCssHeight = 0;
  let hasObservedSize = false;
  let resizeObserver: ResizeObserver | null = null;
  let activeDetach: (() => void) | null = null;

  // 10 Hz one-in-flight tick admission.
  let accumulatedMs = 0;
  let tickInFlight = false;

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

  const syncSize = (): void => {
    if (canvas === null) {
      return;
    }
    let cssWidth: number;
    let cssHeight: number;
    if (hasObservedSize) {
      cssWidth = observedCssWidth;
      cssHeight = observedCssHeight;
      applyCanvasPixelSize(canvas, cssWidth, cssHeight);
    } else {
      // Fallback when ResizeObserver is unavailable: one layout read per paint.
      const rect = canvas.getBoundingClientRect();
      cssWidth = rect.width;
      cssHeight = rect.height;
      syncCanvasSize(canvas);
    }
    const dpr = globalThis.devicePixelRatio ?? 1;
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    const board = getBoardTransform(
      { width: cssWidth, height: cssHeight },
      ctx.getState().map,
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
      viewport: {
        minX: 0,
        minY: 0,
        maxX: map.width * tileSize,
        maxY: map.height * tileSize,
      },
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
    syncSize();
    if (transform === null) {
      return;
    }
    renderer.render(buildFrame(nowMs));
  };

  const captureFrame = (): Promise<WebGpuCapturedFrame | null> => {
    if (canvas === null) {
      return Promise.resolve(null);
    }
    // Same sizing/transform prep as drawFrame so the capture is in the same
    // device-pixel space as the presented canvas.
    syncSize();
    if (transform === null) {
      return Promise.resolve(null);
    }
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
    lastFrameTime = null;
    // No stale catch-up across pause/stop/remount boundaries.
    accumulatedMs = 0;
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
    // drawing here too would double-render around every accepted tick.
    if (animationFrameId !== null) {
      return;
    }
    drawFrame(performance.now());
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

    if (accumulatedMs >= TICK_INTERVAL_MS && !tickInFlight) {
      const submittedMs = Math.min(accumulatedMs, MAX_FRAME_DELTA_MS);
      accumulatedMs -= submittedMs;
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
    render();
    syncAnimationLoop();
  };

  const stop = (): void => {
    running = false;
    lastFrameTime = null;
    syncAnimationLoop();
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

    const handleContextMenu = (event: MouseEvent): void => {
      if (ctx.onRouteDraftContextMenu()) {
        event.preventDefault();
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
    canvas.addEventListener("contextmenu", handleContextMenu);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    render();
    // Prior detach cancels any pending rAF while leaving `running` true.
    // Reschedule so a remount of an already-started host keeps ticking.
    syncAnimationLoop();

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
