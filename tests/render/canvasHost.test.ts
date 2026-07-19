import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../../src/domain/types";
import { tileSize } from "../../src/render/canvas";
import { createCanvasHost } from "../../src/runtime/createCanvasHost";
import type {
  CanvasHost,
  CanvasHostContext,
} from "../../src/runtime/createCanvasHost";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createTestGameState } from "../helpers/gameState";

// jsdom ships no PointerEvent, no Pointer Capture API, and canvas.getContext
// returns null. createCanvasHost guards all of those, but to exercise the real
// DOM event -> callback wiring we stub them here so genuine events flow
// through mount's listeners.

class FakePointerEvent extends Event {
  button: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  constructor(
    type: string,
    init: {
      button?: number;
      clientX?: number;
      clientY?: number;
      pointerId?: number;
      bubbles?: boolean;
    } = {},
  ) {
    super(type, { bubbles: init.bubbles ?? true });
    this.button = init.button ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.pointerId = init.pointerId ?? 1;
  }
}

interface Stubbed {
  getContext: typeof HTMLCanvasElement.prototype.getContext;
  getBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
  setPointerCapture: typeof Element.prototype.setPointerCapture;
  releasePointerCapture: typeof Element.prototype.releasePointerCapture;
  hasPointerCapture: typeof Element.prototype.hasPointerCapture;
  pointerEvent: typeof PointerEvent;
  devicePixelRatio: number | undefined;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
}

let stubs: Stubbed;
let restore: (() => void) | null = null;

beforeEach(() => {
  stubs = {
    getContext: HTMLCanvasElement.prototype.getContext,
    getBoundingClientRect: Element.prototype.getBoundingClientRect,
    setPointerCapture: Element.prototype.setPointerCapture,
    releasePointerCapture: Element.prototype.releasePointerCapture,
    hasPointerCapture: Element.prototype.hasPointerCapture,
    pointerEvent: globalThis.PointerEvent,
    devicePixelRatio: globalThis.devicePixelRatio,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };

  const fakeCtx = {
    canvas: null as unknown as HTMLCanvasElement,
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    fakeCtx.canvas = this;
    return fakeCtx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  vi.stubGlobal("PointerEvent", FakePointerEvent);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => true) as never;

  restore = () => {
    HTMLCanvasElement.prototype.getContext = stubs.getContext;
    Element.prototype.getBoundingClientRect = stubs.getBoundingClientRect;
    Element.prototype.setPointerCapture = stubs.setPointerCapture as never;
    Element.prototype.releasePointerCapture =
      stubs.releasePointerCapture as never;
    Element.prototype.hasPointerCapture = stubs.hasPointerCapture as never;
    vi.unstubAllGlobals();
  };
});

afterEach(() => {
  restore?.();
  restore = null;
  document.body.innerHTML = "";
});

interface Fixture {
  host: CanvasHost;
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  cleanup: () => void;
  callbacks: {
    onTick: ReturnType<typeof vi.fn>;
    onTileClick: ReturnType<typeof vi.fn>;
    onHoverTile: ReturnType<typeof vi.fn>;
    onDragStart: ReturnType<typeof vi.fn>;
    onDragCurrent: ReturnType<typeof vi.fn>;
    onDragCommit: ReturnType<typeof vi.fn>;
    onDragCancel: ReturnType<typeof vi.fn>;
  };
  getState: () => GameState;
  setState: (state: GameState) => void;
  getUi: () => UiState;
  setUi: (patch: Partial<UiState>) => void;
}

/** Mount a canvas host against a board whose client rect maps 1:1 onto tiles
 *  (clientX = tileX * tileSize + half), so canvasToTile returns predictable
 *  tile coordinates. */
function createFixture(options?: {
  state?: GameState;
  ui?: Partial<UiState>;
  onDragStartResult?: boolean;
}): Fixture {
  let state = options?.state ?? createTestGameState();
  let ui = { ...createUiState(), ...options?.ui };

  const callbacks = {
    onTick: vi.fn(),
    onTileClick: vi.fn(),
    onHoverTile: vi.fn(),
    onDragStart: vi.fn(() => options?.onDragStartResult ?? true),
    onDragCurrent: vi.fn(),
    onDragCommit: vi.fn(),
    onDragCancel: vi.fn(),
  };

  const ctx: CanvasHostContext = {
    getState: () => state,
    getUi: () => ui,
    ...callbacks,
  };

  const host = createCanvasHost(ctx);

  const boardWidth = state.map.width * tileSize;
  const boardHeight = state.map.height * tileSize;
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width: boardWidth,
        height: boardHeight,
        left: 0,
        top: 0,
        right: boardWidth,
        bottom: boardHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );

  const container = document.createElement("div");
  container.style.width = `${boardWidth}px`;
  container.style.height = `${boardHeight}px`;
  document.body.appendChild(container);

  const cleanup = host.mount(container);
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;

  return {
    host,
    canvas,
    container,
    cleanup,
    callbacks,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    getUi: () => ui,
    setUi: (patch) => {
      ui = { ...ui, ...patch };
    },
  };
}

/** Client coordinates for the center of `tile`. */
const center = (tile: {
  x: number;
  y: number;
}): {
  clientX: number;
  clientY: number;
} => ({
  clientX: tile.x * tileSize + tileSize / 2,
  clientY: tile.y * tileSize + tileSize / 2,
});

function dispatchPointer(
  canvas: HTMLCanvasElement,
  type: string,
  init: {
    button?: number;
    clientX?: number;
    clientY?: number;
    pointerId?: number;
  } = {},
) {
  canvas.dispatchEvent(new FakePointerEvent(type, init));
}

describe("createCanvasHost", () => {
  it("mount creates a canvas and returns a cleanup function", () => {
    const { canvas, container, cleanup } = createFixture();

    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.dataset.runtimeCanvas).toBe("true");
    expect(container.querySelector("canvas")).toBe(canvas);

    cleanup();

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("start sets running and renders", () => {
    const { host, canvas } = createFixture();

    // mount already calls render() once; clear the shared mock ctx recorder so
    // we can observe the render that start() triggers.
    const ctx = canvas.getContext("2d") as unknown as {
      clearRect: { mock: { calls: unknown[] } };
    };
    ctx.clearRect.mock.calls.length = 0;

    host.start();

    expect(host.isRunning()).toBe(true);
    expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(0);

    host.stop();
  });

  it("stop clears running", () => {
    const { host } = createFixture();

    host.start();
    expect(host.isRunning()).toBe(true);

    host.stop();
    expect(host.isRunning()).toBe(false);
  });

  it("click on non-drag tool calls onTileClick", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
    });

    canvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );

    expect(callbacks.onTileClick).toHaveBeenCalledWith({ x: 2, y: 3 });
  });

  it("click on drag tool does not call onTileClick", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
    });

    canvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );

    expect(callbacks.onTileClick).not.toHaveBeenCalled();
  });

  it("pointermove during drag calls onDragCurrent", () => {
    const { canvas, callbacks } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
      },
    });

    dispatchPointer(canvas, "pointermove", center({ x: 3, y: 0 }));

    expect(callbacks.onDragCurrent).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();
  });

  it("pointermove without drag calls onHoverTile", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect", drag: null },
    });

    dispatchPointer(canvas, "pointermove", center({ x: 4, y: 5 }));

    expect(callbacks.onHoverTile).toHaveBeenCalledWith({ x: 4, y: 5 });
    expect(callbacks.onDragCurrent).not.toHaveBeenCalled();
  });

  it("pointerdown on drag tool starts drag", () => {
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 7,
    });

    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 1, y: 0 });
    expect(setCapture.mock.calls).toContainEqual([7]);
  });

  it("pointerup commits drag", () => {
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { canvas, callbacks } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 2, y: 0 } },
      },
    });

    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 7,
    });

    // The release tile is snapped to current before committing.
    expect(callbacks.onDragCurrent).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
    expect(releaseCapture.mock.calls).toContainEqual([7]);
  });

  it("pointerleave cancels drag and clears hover", () => {
    const { canvas, callbacks } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 3, y: 0 } },
      },
    });

    dispatchPointer(canvas, "pointerleave", center({ x: 5, y: 0 }));

    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoverTile).toHaveBeenCalledWith(null);
  });

  it("cleanup removes event listeners and clears interaction state", () => {
    const { canvas, callbacks, cleanup } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 2, y: 0 } },
        hoverTile: { x: 2, y: 0 },
      },
    });

    cleanup();

    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoverTile).toHaveBeenCalledWith(null);

    callbacks.onTileClick.mockClear();
    callbacks.onHoverTile.mockClear();
    callbacks.onDragCancel.mockClear();

    canvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );
    dispatchPointer(canvas, "pointermove", center({ x: 4, y: 5 }));
    dispatchPointer(canvas, "pointerleave", center({ x: 0, y: 0 }));

    expect(callbacks.onTileClick).not.toHaveBeenCalled();
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();
    expect(callbacks.onDragCancel).not.toHaveBeenCalled();
  });

  it("remounting onto a different host tears down the prior mount", () => {
    const {
      host,
      canvas: firstCanvas,
      container: firstHost,
      callbacks,
    } = createFixture({ ui: { activeTool: "inspect" } });

    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    host.mount(secondHost);

    expect(firstHost.querySelector("canvas")).toBeNull();
    const secondCanvas = secondHost.querySelector("canvas");
    expect(secondCanvas).not.toBeNull();
    expect(secondCanvas).not.toBe(firstCanvas);

    callbacks.onTileClick.mockClear();
    firstCanvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );
    expect(callbacks.onTileClick).not.toHaveBeenCalled();

    secondCanvas!.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );
    expect(callbacks.onTileClick).toHaveBeenCalledWith({ x: 2, y: 3 });
  });

  it("remounting a running unpaused host reschedules the animation loop", () => {
    const raf = globalThis.requestAnimationFrame as unknown as {
      mock: { calls: unknown[][] };
    };
    const cancel = globalThis.cancelAnimationFrame as unknown as {
      mock: { calls: number[][] };
    };
    const fixture = createFixture({
      state: { ...createTestGameState(), paused: false, speed: 1 },
    });

    fixture.host.start();
    const rafAfterStart = raf.mock.calls.length;
    expect(rafAfterStart).toBeGreaterThanOrEqual(1);

    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    fixture.host.mount(secondHost);

    // Teardown cancels the prior frame; mount must request a fresh one while
    // running stays true so ticks/renders continue without a later commit.
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fixture.host.isRunning()).toBe(true);
    expect(raf.mock.calls.length).toBeGreaterThan(rafAfterStart);

    fixture.host.stop();
  });

  it("syncAnimationLoop starts rAF when animatable", () => {
    const raf = globalThis.requestAnimationFrame as unknown as {
      mock: { calls: unknown[][] };
    };
    // Default createTestGameState has paused=true, so start() will not start
    // the loop. We then flip paused=false and call syncAnimationLoop directly.
    const fixture = createFixture();

    fixture.host.start();
    expect(raf.mock.calls).toHaveLength(0);

    fixture.setState({
      ...fixture.getState(),
      paused: false,
      speed: 1,
    });
    fixture.host.syncAnimationLoop();

    expect(raf.mock.calls.length).toBeGreaterThanOrEqual(1);

    fixture.host.stop();
  });

  it("syncAnimationLoop cancels rAF when not animatable", () => {
    const raf = globalThis.requestAnimationFrame as unknown as {
      mock: { calls: unknown[][] };
    };
    const cancel = globalThis.cancelAnimationFrame as unknown as {
      mock: { calls: number[][] };
    };
    const fixture = createFixture({
      state: { ...createTestGameState(), paused: false, speed: 1 },
    });

    fixture.host.start();
    expect(raf.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Flip to paused -> not animatable; syncAnimationLoop must cancel.
    fixture.setState({ ...fixture.getState(), paused: true });
    fixture.host.syncAnimationLoop();

    expect(cancel.mock.calls).toContainEqual([1]);

    fixture.host.stop();
  });

  it("observes the board host so a host resize updates the canvas backing store", () => {
    // jsdom ships no ResizeObserver; stub one that records observe targets
    // and lets the test fire the callback manually.
    const observed: Element[] = [];
    let observerCallback:
      | ((
          entries: { contentRect: { width: number; height: number } }[],
        ) => void)
      | null = null;
    class FakeResizeObserver {
      constructor(
        cb: (
          entries: { contentRect: { width: number; height: number } }[],
        ) => void,
      ) {
        observerCallback = cb;
      }
      observe(target: Element): void {
        observed.push(target);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const fixture = createFixture();
    const { container, canvas } = fixture;

    // The observer must watch the board host, not the canvas. The canvas's
    // fixed pixel style (set by applyCanvasPixelSize) would stop firing on a
    // window/board resize if the observer watched the canvas itself.
    expect(observed).toContain(container);
    expect(observed).not.toContain(canvas);

    // Simulate a host resize: the backing store must follow the new size.
    const dpr = globalThis.devicePixelRatio ?? 1;
    observerCallback!([{ contentRect: { width: 400, height: 300 } }]);
    expect(canvas.width).toBe(Math.max(1, Math.round(400 * dpr)));
    expect(canvas.height).toBe(Math.max(1, Math.round(300 * dpr)));
  });
});
