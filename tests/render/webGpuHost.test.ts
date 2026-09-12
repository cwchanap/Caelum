import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type {
  GameState,
  RoadPathStep,
  RouteLegPath,
  TransitPath,
  Vehicle,
} from "../../src/domain/types";
import {
  createWebGpuHostWithRenderer,
  type WebGpuHostContext,
} from "../../src/runtime/createWebGpuHost";
import {
  VEHICLE_INSTANCE_FLOATS,
  type WebGpuRenderFrame,
  type WebGpuRenderer,
} from "../../src/render/webgpu/renderer";
import { tileSize } from "../../src/render/boardTransform";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createTestGameState } from "../helpers/gameState";

// jsdom ships no PointerEvent and no Pointer Capture API. The WebGPU host
// guards those, but to exercise the real DOM event -> callback wiring we stub
// them so genuine events flow through mount's listeners.

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
  getBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
  setPointerCapture: typeof Element.prototype.setPointerCapture;
  releasePointerCapture: typeof Element.prototype.releasePointerCapture;
  hasPointerCapture: typeof Element.prototype.hasPointerCapture;
  pointerEvent: typeof PointerEvent;
  devicePixelRatio: number | undefined;
}

let stubs: Stubbed;
let restore: (() => void) | null = null;
let rafCallbacks: Array<(timestamp: number) => void>;

beforeEach(() => {
  stubs = {
    getBoundingClientRect: Element.prototype.getBoundingClientRect,
    setPointerCapture: Element.prototype.setPointerCapture,
    releasePointerCapture: Element.prototype.releasePointerCapture,
    hasPointerCapture: Element.prototype.hasPointerCapture,
    pointerEvent: globalThis.PointerEvent,
    devicePixelRatio: globalThis.devicePixelRatio,
  };

  rafCallbacks = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: (timestamp: number) => void) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("PointerEvent", FakePointerEvent);
  vi.stubGlobal("devicePixelRatio", 1);

  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => true) as never;

  restore = () => {
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

interface FakeRenderer {
  lost: Promise<{ reason?: string; message: string }>;
  resolveLost(info: { reason?: string; message: string }): void;
  configure: Mock;
  resize: Mock;
  render: Mock;
  destroy: Mock;
  frames: WebGpuRenderFrame[];
}

function createFakeRenderer(): FakeRenderer {
  let resolveLost: (info: {
    reason?: string;
    message: string;
  }) => void = () => {};
  const lost = new Promise<{ reason?: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });
  const frames: WebGpuRenderFrame[] = [];
  return {
    lost,
    resolveLost,
    configure: vi.fn(),
    resize: vi.fn(),
    render: vi.fn((frame: WebGpuRenderFrame) => {
      frames.push(frame);
      return { solidBatches: 0, solidVertices: 0, vehicleInstances: 0 };
    }),
    destroy: vi.fn(),
    frames,
  };
}

interface Fixture {
  host: ReturnType<typeof createWebGpuHostWithRenderer>;
  renderer: FakeRenderer;
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  cleanup: () => void;
  callbacks: {
    onTick: Mock;
    onTileClick: Mock;
    onHoverTile: Mock;
    onRouteDraftContextMenu: Mock;
    onDragStart: Mock;
    onDragCurrent: Mock;
    onDragCommit: Mock;
    onDragCancel: Mock;
    onFatalError: Mock;
  };
  fireFrame: (timestamp: number) => void;
  rafCount: () => number;
  getState: () => GameState;
  setState: (state: GameState) => void;
  getUi: () => UiState;
  setUi: (patch: Partial<UiState>) => void;
  setSceneRevision: (revision: number) => void;
}

/** Mount a WebGPU host against a board whose client rect maps 1:1 onto tiles
 *  (clientX = tileX * tileSize + half), so canvasToTile returns predictable
 *  tile coordinates. DPR is pinned to 1, so the board transform is identity
 *  and world pixels map to canvas pixels directly. */
function createFixture(options?: {
  state?: GameState;
  ui?: Partial<UiState>;
  onDragStartResult?: boolean;
}): Fixture {
  let state = options?.state ?? createTestGameState();
  let ui = { ...createUiState(), ...options?.ui };
  let sceneRevision = 1;

  const callbacks = {
    onTick: vi.fn(() => Promise.resolve()),
    onTileClick: vi.fn(),
    onHoverTile: vi.fn(),
    onRouteDraftContextMenu: vi.fn(() => false),
    onDragStart: vi.fn(() => options?.onDragStartResult ?? true),
    onDragCurrent: vi.fn(),
    onDragCommit: vi.fn(),
    onDragCancel: vi.fn(),
    onFatalError: vi.fn(),
  };

  const renderer = createFakeRenderer();

  const ctx: WebGpuHostContext = {
    getState: () => state,
    getUi: () => ui,
    getSceneRevision: () => sceneRevision,
    ...callbacks,
  };

  const host = createWebGpuHostWithRenderer(
    ctx,
    renderer as unknown as WebGpuRenderer,
  );

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
    renderer,
    canvas,
    container,
    cleanup,
    callbacks,
    fireFrame: (timestamp: number) => {
      const pending = [...rafCallbacks];
      rafCallbacks.length = 0;
      for (const callback of pending) callback(timestamp);
    },
    rafCount: () => rafCallbacks.length,
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    getUi: () => ui,
    setUi: (patch) => {
      ui = { ...ui, ...patch };
    },
    setSceneRevision: (revision) => {
      sceneRevision = revision;
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

/** Unpaused, speed-1 state so the host's rAF loop runs. */
function runningState(overrides: Partial<GameState> = {}): GameState {
  return { ...createTestGameState(), paused: false, ...overrides };
}

/** Same state with the simulation running (keeps object identity of the rest). */
function unpaused(state: GameState): GameState {
  return { ...state, paused: false };
}

/** Frame timestamp iterator at 60Hz. */
function ticker() {
  let now = 0;
  return (stepMs = 1000 / 60) => (now += stepMs);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createWebGpuHost lifecycle", () => {
  it("mount creates a canvas, configures the renderer, and cleans up", () => {
    const { canvas, container, cleanup, renderer } = createFixture();

    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.dataset.runtimeCanvas).toBe("true");
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(renderer.configure).toHaveBeenCalledWith(canvas);
    // The initial mount draw fills the backing store from the board box.
    expect(renderer.resize).toHaveBeenCalledWith(
      createTestGameState().map.width * tileSize,
      createTestGameState().map.height * tileSize,
    );
    expect(renderer.render).toHaveBeenCalled();

    cleanup();

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.innerHTML).toBe("");
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

  it("suppresses the browser context menu when route draft undo handles it", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "busRoute" },
    });
    callbacks.onRouteDraftContextMenu.mockReturnValue(true);

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(event);

    expect(callbacks.onRouteDraftContextMenu).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("preserves the browser context menu when the draft declines", () => {
    const { canvas, callbacks } = createFixture();
    callbacks.onRouteDraftContextMenu.mockReturnValue(false);

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("pointermove during drag calls onDragCurrent; idle moves update hover", () => {
    const { canvas, callbacks } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
      },
    });

    dispatchPointer(canvas, "pointermove", center({ x: 3, y: 0 }));

    expect(callbacks.onDragCurrent).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();

    dispatchPointer(canvas, "pointerleave", center({ x: 5, y: 0 }));
    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoverTile).toHaveBeenCalledWith(null);
  });

  it("pointerdown captures and pointerup commits a drag gesture", () => {
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { canvas, callbacks } = createFixture({
      ui: {
        activeTool: "road",
        drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 2, y: 0 } },
      },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 7,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 1, y: 0 });
    expect(setCapture.mock.calls).toContainEqual([7]);

    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 7,
    });
    expect(callbacks.onDragCurrent).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
    expect(releaseCapture.mock.calls).toContainEqual([7]);
  });

  it("cleanup removes listeners and clears interaction state", () => {
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

    expect(callbacks.onTileClick).not.toHaveBeenCalled();
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();
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

    host.stop();
  });

  it("window resize updates the backing store when no ResizeObserver exists", () => {
    const { container, canvas, renderer } = createFixture();

    // jsdom ships no ResizeObserver, so mount seeds the size from the board
    // box and listens for window resize. The fallback must read the board
    // host's content box (the canvas's box is pinned to pixels after the
    // first paint), so stub the host's rect for the new size.
    container.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 400,
          height: 300,
          left: 0,
          top: 0,
          right: 400,
          bottom: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    globalThis.window?.dispatchEvent(new Event("resize"));

    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(renderer.resize).toHaveBeenCalledWith(400, 300);
  });
});

describe("createWebGpuHost 10 Hz tick admission", () => {
  it("submits at most 10 host ticks across 1 second of 60Hz rAF", async () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    host.start();

    const nextTimestamp = ticker();
    for (let frame = 0; frame < 60; frame += 1) {
      fireFrame(nextTimestamp());
      await flushMicrotasks();
    }

    const deltas = callbacks.onTick.mock.calls.map((call) => call[0] as number);
    // The pin: never more than one admission per ~100ms window. Float dust at
    // exact 60Hz can push the tenth window one frame past the second.
    expect(deltas.length).toBeLessThanOrEqual(10);
    expect(deltas.length).toBeGreaterThanOrEqual(9);
    const total = deltas.reduce((sum, delta) => sum + delta, 0);
    expect(total).toBeGreaterThan(0.85);
    expect(total).toBeLessThanOrEqual(1.001);
    for (const delta of deltas) {
      expect(delta).toBeLessThanOrEqual(0.25);
    }

    host.stop();
  });

  it("does not admit a second tick while one is pending", async () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    let release: () => void = () => {};
    callbacks.onTick.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    host.start();

    const nextTimestamp = ticker();
    for (let frame = 0; frame < 12; frame += 1) {
      fireFrame(nextTimestamp());
    }
    // The first admission fired around frame 6; every later frame only
    // accumulates while the tick is in flight.
    expect(callbacks.onTick).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks(); // let the admission gate observe completion
    // The retained ~83ms plus the next frame crosses the 100ms gate (one
    // more frame absorbs float dust at exact 60Hz).
    fireFrame(nextTimestamp());
    fireFrame(nextTimestamp());
    expect(callbacks.onTick).toHaveBeenCalledTimes(2);
    const secondDelta = callbacks.onTick.mock.calls[1]![0] as number;
    expect(secondDelta).toBeLessThanOrEqual(0.25);

    host.stop();
  });

  it("clamps the submitted delta to 0.25s and retains the overflow", async () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    let release: () => void = () => {};
    callbacks.onTick.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    host.start();

    fireFrame(0); // first frame: zero delta, no tick
    fireFrame(100); // 100ms accumulated -> one 0.1s tick, now pending
    fireFrame(400); // +250ms (clamped from 300ms), retained while pending
    fireFrame(416); // +16ms retained
    expect(callbacks.onTick).toHaveBeenCalledTimes(1);
    expect(callbacks.onTick).toHaveBeenCalledWith(0.1);

    release();
    await flushMicrotasks();
    fireFrame(433); // +17ms -> accumulated ~283ms -> submit one 0.25s tick
    expect(callbacks.onTick).toHaveBeenCalledTimes(2);
    expect(callbacks.onTick).toHaveBeenLastCalledWith(0.25);

    host.stop();
  });

  it("does not catch up stale time across pause/stop", () => {
    const { host, callbacks, fireFrame, setState, getState } = createFixture({
      state: runningState(),
    });
    host.start();

    fireFrame(0);
    fireFrame(90); // 90ms accumulated, below the 100ms gate
    expect(callbacks.onTick).not.toHaveBeenCalled();

    // Pausing stops the loop; resuming must not dump the stale 90ms.
    setState({ ...getState(), paused: true });
    host.stop();
    setState({ ...getState(), paused: false });
    host.start();

    fireFrame(106);
    fireFrame(122);
    expect(callbacks.onTick).not.toHaveBeenCalled();

    host.stop();
  });
});

describe("createWebGpuHost render coalescing", () => {
  it("does not draw twice around an accepted running tick", () => {
    const { host, renderer, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    // mount draws once; start() draws once more (no rAF scheduled yet).
    host.start();
    expect(renderer.render).toHaveBeenCalledTimes(2);

    fireFrame(16);
    fireFrame(33);
    expect(callbacks.onTick).not.toHaveBeenCalled(); // below the gate
    // mount + start + one draw per frame.
    expect(renderer.render).toHaveBeenCalledTimes(4);

    const drawsBefore = renderer.render.mock.calls.length;
    host.render(); // rAF owns display: record only, no synchronous draw
    expect(renderer.render.mock.calls.length).toBe(drawsBefore);

    fireFrame(50); // next rAF draws the latest state exactly once
    expect(renderer.render.mock.calls.length).toBe(drawsBefore + 1);

    host.stop();
  });

  it("repaints immediately while paused with no rAF scheduled", () => {
    const { host, renderer, rafCount } = createFixture();

    host.start(); // paused by default: no rAF, no ticks
    expect(rafCount()).toBe(0);
    expect(renderer.render).toHaveBeenCalled();

    const drawsBefore = renderer.render.mock.calls.length;
    host.render();
    expect(renderer.render.mock.calls.length).toBe(drawsBefore + 1);
  });
});

describe("createWebGpuHost observed vehicle history", () => {
  function straightLeg(
    from: { x: number; y: number },
    to: {
      x: number;
      y: number;
    },
  ): RouteLegPath[] {
    const step: RoadPathStep = {
      position: from,
      enteringHeading: "east",
      leavingHeading: "east",
      movement: "straight",
      geometry: { kind: "line", from, to },
      travelSeconds: 10,
    };
    const path = {
      kind: "road",
      steps: [step],
      totalTravelSeconds: 10,
    } as TransitPath;
    return [
      {
        fromWaypointId: "a",
        toWaypointId: "b",
        direction: "loop",
        kind: "service",
        status: "connected",
        currentPath: path,
        lastValidPath: null,
        estimatedSeconds: 10,
        failureReason: null,
      },
    ];
  }

  function busVehicle(stepProgress: number): Vehicle {
    return {
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      itineraryIndex: 0,
      pathStepIndex: 0,
      stepProgress,
      parkedPosition: null,
    };
  }

  function stateWithVehicle(
    stepProgress: number,
    overrides: Partial<GameState> = {},
  ): GameState {
    const base = createTestGameState();
    return {
      ...base,
      ...overrides,
      transit: {
        ...base.transit,
        stops: ["a", "b"].map((id, index) => ({
          id,
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: index, y: 0 },
          platforms: [],
        })),
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["a", "b"],
            vehicleIds: ["vehicle-001"],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: straightLeg({ x: 2, y: 2 }, { x: 5, y: 2 }),
            pathBroken: false,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
        metroLines: [],
        vehicles: [busVehicle(stepProgress)],
      },
    };
  }

  /** Vehicle instances of the latest frame in world pixels. */
  function lastVehicleInstances(fx: Fixture): number[][] {
    const frame = fx.renderer.frames.at(-1)!;
    const instances = frame.vehicles[0]!.instances;
    const rows: number[][] = [];
    for (
      let offset = 0;
      offset < instances.length;
      offset += VEHICLE_INSTANCE_FLOATS
    ) {
      rows.push(
        Array.from(instances.slice(offset, offset + VEHICLE_INSTANCE_FLOATS)),
      );
    }
    return rows;
  }

  /** Inverse of the identity-DPR board transform: clip -> world pixels. */
  function clipToWorld(value: number, extent: number): number {
    return ((value + 1) / 2) * extent;
  }

  it("interpolates across a 130ms observed interval with rAF alpha", () => {
    const previous = 0.2;
    const latest = 0.5;
    // Observation timestamps come from the host's immediate-draw clock;
    // pin it before the fixture mounts so the first observation lands at 0.
    let fakeNow = 0;
    vi.stubGlobal("performance", { now: () => fakeNow });
    const fx = createFixture({
      state: unpaused(stateWithVehicle(previous)),
    });

    fx.host.start(); // observes the previous state at fake-now 0

    fakeNow = 130;
    fx.setState(unpaused(stateWithVehicle(latest)));
    fx.fireFrame(130); // observes the latest state; interval = 130ms

    fakeNow = 230;
    fx.fireFrame(230); // alpha = (230 - 130) / 130 = 100/130

    const rows = lastVehicleInstances(fx);
    expect(rows.length).toBe(1);
    const worldX = clipToWorld(rows[0]![0]!, 28 * tileSize);
    const expectedProgress = previous + (latest - previous) * (100 / 130);
    const expectedX =
      (2 + (5 - 2) * expectedProgress) * tileSize + tileSize / 2;
    expect(worldX).toBeCloseTo(expectedX, 3);
    // Strictly between the observed cursors: interpolation, not snapping.
    expect(worldX).toBeGreaterThan(80 + 96 * previous + 0.5);
    expect(worldX).toBeLessThan(80 + 96 * latest - 0.5);

    fx.host.stop();
    vi.unstubAllGlobals();
  });

  it("snaps vehicles to the latest cursor after a scene change", () => {
    let fakeNow = 0;
    vi.stubGlobal("performance", { now: () => fakeNow });
    const fx = createFixture({ state: unpaused(stateWithVehicle(0.2)) });
    fx.host.start();

    // Scene change: new revision plus new state -> no interpolation base.
    fx.setSceneRevision(2);
    fx.setState(unpaused(stateWithVehicle(0.8)));
    fakeNow = 100;
    fx.fireFrame(100);
    // A second frame with no new state: previous stays cleared, so the
    // vehicle renders at its latest cursor instead of interpolating.
    fakeNow = 200;
    fx.fireFrame(200);

    const rows = lastVehicleInstances(fx);
    expect(rows.length).toBe(1);
    const worldX = clipToWorld(rows[0]![0]!, 28 * tileSize);
    const latestX = (2 + 3 * 0.8) * tileSize + tileSize / 2;
    expect(worldX).toBeCloseTo(latestX, 3);

    fx.host.stop();
    vi.unstubAllGlobals();
  });

  it("snaps vehicles while paused or at speed 0", () => {
    const fx = createFixture({ state: stateWithVehicle(0.5) });
    const fakeNow = 0;
    vi.stubGlobal("performance", { now: () => fakeNow });
    fx.host.start();
    expect(fx.rafCount()).toBe(0); // paused: no loop

    const rows = lastVehicleInstances(fx);
    expect(rows.length).toBe(1);
    const worldX = clipToWorld(rows[0]![0]!, 28 * tileSize);
    const latestX = (2 + 3 * 0.5) * tileSize + tileSize / 2;
    expect(worldX).toBeCloseTo(latestX, 3);
    vi.unstubAllGlobals();
  });
});

describe("createWebGpuHost device loss", () => {
  it("reports unexpected device loss to onFatalError exactly once", async () => {
    const { renderer, callbacks } = createFixture();

    renderer.resolveLost({ reason: "internal", message: "driver reset" });
    await flushMicrotasks();

    expect(callbacks.onFatalError).toHaveBeenCalledTimes(1);
    const error = callbacks.onFatalError.mock.calls[0]![0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("WebGPU device lost: driver reset");
  });

  it("reports device loss without a message", async () => {
    const { renderer, callbacks } = createFixture();

    renderer.resolveLost({ reason: "unknown", message: "" });
    await flushMicrotasks();

    expect(callbacks.onFatalError).toHaveBeenCalledTimes(1);
    const error = callbacks.onFatalError.mock.calls[0]![0] as Error;
    expect(error.message).toBe("WebGPU device lost");
  });

  it("ignores the deliberate destroy() loss", async () => {
    const { renderer, callbacks } = createFixture();

    renderer.resolveLost({ reason: "destroyed", message: "destroyed" });
    await flushMicrotasks();

    expect(callbacks.onFatalError).not.toHaveBeenCalled();
  });
});

describe("createWebGpuHost frame contents", () => {
  it("draws solid ranges and vehicle instances in painter order", () => {
    const fx = createFixture({ state: stateWithVehicleForFrame() });
    fx.host.start();

    const frame = fx.renderer.frames.at(-1)!;
    // Painter order: scene, overlays, routes, draft | vehicles | handles.
    expect(frame.solids.length).toBe(4);
    expect(frame.solids[0]!.key).toBe("scene:1");
    expect(frame.solids[1]!.key).toBe("overlay-under-routes");
    expect(frame.solids[2]!.key).toBe("routes:1:-:-");
    expect(frame.solids[3]!.key).toBe("route-draft");
    expect(frame.vehicles.length).toBe(1);
    expect(frame.vehicles[0]!.key).toBe("vehicles");
    expect(frame.vehicles[0]!.instances.length).toBe(VEHICLE_INSTANCE_FLOATS);
    // No route editor open: the over-vehicles range emits an empty batch.
    expect(frame.overVehicles![0]!.key).toBe("route-handles");
    expect(frame.overVehicles![0]!.vertices.length).toBe(0);

    fx.host.stop();
  });

  it("keeps raw world angle and extents and appends clip factors to instances", () => {
    // Southbound bus: world tangent (0, 1) -> world angle +π/2, passed
    // through raw (the y-flip lives in the clip factors). Body extents stay
    // world px. The trailing clip factors come from the identity board at
    // DPR 1 (28x18 tiles -> 896x576 px): sx = 2/896, sy = -2/576.
    const fx = createFixture({
      state: unpaused(stateWithVehicleForFrame({ x: 2, y: 5 })),
    });
    fx.host.start();

    const instances = fx.renderer.frames.at(-1)!.vehicles[0]!.instances;
    expect(instances[2]).toBeCloseTo(Math.PI / 2, 5);
    expect(instances[3]).toBeCloseTo(7, 5);
    expect(instances[4]).toBeCloseTo(4, 5);
    expect(instances[5]).toBeCloseTo(2 / 896, 9);
    expect(instances[6]).toBeCloseTo(-2 / 576, 9);

    fx.host.stop();
  });

  it("keeps scene/route cache keys stable per revision and re-keys on change", () => {
    const fx = createFixture({
      state: unpaused(stateWithVehicleForFrame()),
    });
    fx.host.start();
    fx.fireFrame(16);
    fx.fireFrame(33);

    // Same revision and emphasis: the same string keys (and thus the same
    // buffer identities inside the renderer) repeat every frame.
    for (const frame of fx.renderer.frames) {
      expect(frame.solids[0]!.key).toBe("scene:1");
      expect(frame.solids[2]!.key).toBe("routes:1:-:-");
    }

    // Emphasis change re-keys the committed-route range without a scene bump.
    fx.setUi({ selectedRouteId: "route-001" });
    fx.fireFrame(50);
    expect(fx.renderer.frames.at(-1)!.solids[2]!.key).toBe(
      "routes:1:route-001:-",
    );
    expect(fx.renderer.frames.at(-1)!.solids[0]!.key).toBe("scene:1");

    // A structural update re-keys the scene range.
    fx.setSceneRevision(2);
    fx.setState({ ...fx.getState(), budget: 1 });
    fx.fireFrame(66);
    const last = fx.renderer.frames.at(-1)!;
    expect(last.solids[0]!.key).toBe("scene:2");
    expect(last.solids[2]!.key).toBe("routes:2:route-001:-");

    fx.host.stop();
  });
});

function stateWithVehicleForFrame(
  to: { x: number; y: number } = { x: 5, y: 2 },
): GameState {
  const base = createTestGameState();
  const vehicle: Vehicle = {
    id: "vehicle-001",
    mode: "bus",
    lineId: "route-001",
    itineraryIndex: 0,
    pathStepIndex: 0,
    stepProgress: 0,
    parkedPosition: null,
  };
  const step: RoadPathStep = {
    position: { x: 2, y: 2 },
    enteringHeading: "east",
    leavingHeading: "east",
    movement: "straight",
    geometry: { kind: "line", from: { x: 2, y: 2 }, to },
    travelSeconds: 10,
  };
  return {
    ...base,
    transit: {
      ...base.transit,
      stops: ["a", "b"].map((id, index) => ({
        id,
        kind: "busStop" as const,
        status: "present" as const,
        position: { x: index, y: 0 },
        platforms: [],
      })),
      stations: [],
      routes: [
        {
          id: "route-001",
          name: "Route 1",
          color: "#e04f39",
          stopIds: ["a", "b"],
          vehicleIds: [vehicle.id],
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs: [
            {
              fromWaypointId: "a",
              toWaypointId: "b",
              direction: "loop",
              kind: "service",
              status: "connected",
              currentPath: {
                kind: "road",
                steps: [step],
                totalTravelSeconds: 10,
              } as TransitPath,
              lastValidPath: null,
              estimatedSeconds: 10,
              failureReason: null,
            },
          ],
          pathBroken: false,
          targetHeadwaySeconds: null,
          serviceMetrics: null,
        },
      ],
      metroLines: [],
      vehicles: [vehicle],
    },
  };
}
