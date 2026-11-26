import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import type {
  GameMap,
  GameState,
  RoadPathStep,
  RouteLegPath,
  TransitPath,
  Vehicle,
} from "../../src/domain/types";
import {
  createGameHost,
  createGameHostWithRenderer,
  type GameHost,
  type GameHostContext,
} from "../../src/runtime/createGameHost";
import {
  SPRITE_INSTANCE_FLOATS,
  VEHICLE_INSTANCE_FLOATS,
  type GameplayRenderer,
  type RenderFrame,
} from "../../src/render/gameplayRenderer";
import {
  VEHICLE_HALF_LENGTH,
  VEHICLE_HALF_WIDTH,
} from "../../src/render/webgpu/vehicleInstances";
import {
  canvasToWorld,
  getBoardTransform,
  HUD_INSET,
  tileSize,
  type Camera,
} from "../../src/render/boardTransform";
import { buildMapBatch } from "../../src/render/webgpu/mapBatch";
import { parseColor } from "../../src/render/webgpu/primitives";
import {
  createSpriteAtlasTexture,
  loadSpriteImages,
} from "../../src/render/webgpu/spriteAtlas";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createTestGameState } from "../helpers/gameState";
import { createFakeDevice, type FakeHarness } from "../helpers/fakeWebGpu";

vi.mock("../../src/render/webgpu/mapBatch", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/render/webgpu/mapBatch")>();
  return { ...mod, buildMapBatch: vi.fn(mod.buildMapBatch) };
});

// jsdom ships no image decode; the real production host factory loads the
// sprite images and uploads the atlas before creating the renderer, so stub
// both out here and assert the texture is destroyed with the renderer's
// resources. The rest of the module (typed table, layer math) stays real
// for mapBatch.
vi.mock("../../src/render/webgpu/spriteAtlas", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("../../src/render/webgpu/spriteAtlas")
    >();
  return {
    ...mod,
    loadSpriteImages: vi.fn(async () => []),
    createSpriteAtlasTexture: vi.fn(() => ({
      createView: () => ({}),
      destroy: vi.fn(),
    })),
  };
});

// jsdom ships no PointerEvent and no Pointer Capture API. The WebGPU host
// guards those, but to exercise the real DOM event -> callback wiring we stub
// them so genuine events flow through mount's listeners.

class FakePointerEvent extends Event {
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
  constructor(
    type: string,
    init: {
      button?: number;
      buttons?: number;
      clientX?: number;
      clientY?: number;
      pointerId?: number;
      pointerType?: string;
      bubbles?: boolean;
    } = {},
  ) {
    super(type, { bubbles: init.bubbles ?? true });
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
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
  kind: "webgpu" | "canvas2d";
  lost: Promise<{ reason?: string; message: string }>;
  resolveLost(info: { reason?: string; message: string }): void;
  configure: Mock;
  unconfigure: Mock;
  resize: Mock;
  render: Mock;
  captureFrame: Mock;
  destroy: Mock;
  frames: RenderFrame[];
}

function createFakeRenderer(
  kind: "webgpu" | "canvas2d" = "webgpu",
): FakeRenderer {
  let resolveLost: (info: {
    reason?: string;
    message: string;
  }) => void = () => {};
  const lost = new Promise<{ reason?: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });
  const frames: RenderFrame[] = [];
  return {
    kind,
    lost,
    resolveLost,
    configure: vi.fn(),
    unconfigure: vi.fn(),
    resize: vi.fn(),
    render: vi.fn((frame: RenderFrame) => {
      frames.push(frame);
      return {
        solidBatches: 0,
        solidVertices: 0,
        spriteInstances: 0,
        spriteDraws: 0,
        vehicleInstances: 0,
        vehicleDraws: 0,
      };
    }),
    captureFrame: vi.fn(async () => ({
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(16),
    })),
    destroy: vi.fn(),
    frames,
  };
}

interface Fixture {
  host: ReturnType<typeof createGameHostWithRenderer>;
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
    onCameraChange: Mock;
  };
  fireFrame: (timestamp: number) => void;
  rafCount: () => number;
  getState: () => GameState;
  setState: (state: GameState) => void;
  getUi: () => UiState;
  setUi: (patch: Partial<UiState>) => void;
  setSceneRevision: (revision: number) => void;
}

/** Mount a WebGPU host against a board whose safe viewport maps 1:1 onto
 *  tiles (clientX = tileX * tileSize + half, clientY = tileY * tileSize +
 *  half + HUD_INSET.top), so canvasToTile returns predictable tile
 *  coordinates. DPR is pinned to 1, so the board transform is the identity
 *  plus the top HUD band and world pixels map to canvas pixels directly. */
function createFixture(options?: {
  state?: GameState;
  ui?: Partial<UiState>;
  camera?: Camera;
  onDragStartResult?: boolean;
  rendererKind?: "webgpu" | "canvas2d";
}): Fixture {
  let state = options?.state ?? createTestGameState();
  let ui = { ...createUiState(), ...options?.ui };
  let sceneRevision = 1;
  let camera: Camera | null = options?.camera ?? null;

  const callbacks = {
    onTick: vi.fn(() => Promise.resolve()),
    onTileClick: vi.fn(),
    onHoverTile: vi.fn(),
    onRouteDraftContextMenu: vi.fn(() => false),
    onDragStart: vi.fn(() => options?.onDragStartResult ?? true),
    onDragCurrent: vi.fn(),
    onDragCommit: vi.fn(() => {
      ui.drag = null;
    }),
    onDragCancel: vi.fn(() => {
      ui.drag = null;
    }),
    onFatalError: vi.fn(),
    onCameraChange: vi.fn((next: Camera | null) => {
      camera = next;
    }),
  };

  const renderer = createFakeRenderer(options?.rendererKind);

  const ctx: GameHostContext = {
    getState: () => state,
    getUi: () => ui,
    getCamera: () => camera,
    getSceneRevision: () => sceneRevision,
    ...callbacks,
  };

  const host = createGameHostWithRenderer(
    ctx,
    renderer as unknown as GameplayRenderer,
  );

  const boardWidth = state.map.width * tileSize;
  const boardHeight =
    state.map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom;
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
  clientY: tile.y * tileSize + tileSize / 2 + HUD_INSET.top,
});

const centerForCamera = (
  tile: { x: number; y: number },
  map: GameMap,
  camera: Camera,
): { clientX: number; clientY: number } => {
  const transform = getBoardTransform(
    {
      width: map.width * tileSize,
      height: map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom,
    },
    map,
    camera,
  );
  return {
    clientX: transform.offsetX + (tile.x + 0.5) * tileSize * transform.scale,
    clientY: transform.offsetY + (tile.y + 0.5) * tileSize * transform.scale,
  };
};

function dispatchPointer(
  canvas: HTMLCanvasElement,
  type: string,
  init: {
    button?: number;
    buttons?: number;
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: string;
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

describe("createGameHost lifecycle", () => {
  it("mount creates a canvas, configures the renderer, and cleans up", () => {
    const { canvas, container, cleanup, renderer, fireFrame } = createFixture();

    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.dataset.runtimeCanvas).toBe("true");
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(renderer.configure).toHaveBeenCalledWith(canvas);
    // The initial mount draw lands on the next frame and fills the backing
    // store from the board box.
    fireFrame(0);
    expect(renderer.resize).toHaveBeenCalledWith(
      createTestGameState().map.width * tileSize,
      createTestGameState().map.height * tileSize +
        HUD_INSET.top +
        HUD_INSET.bottom,
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

    expect(callbacks.onTileClick).toHaveBeenCalledWith({ x: 2, y: 3 }, null);
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

  it("wheel zooms around the cursor and reports the camera", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
    });
    const wheel = new WheelEvent("wheel", {
      ...center({ x: 2, y: 3 }),
      deltaY: -200,
      bubbles: true,
      cancelable: true,
    });

    canvas.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
    const camera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    expect(camera.zoom).toBeGreaterThan(1);
    // The tile under the cursor stays under the cursor.
    canvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );
    expect(callbacks.onTileClick).toHaveBeenCalledWith({ x: 2, y: 3 }, null);
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith({ x: 2, y: 3 });
  });

  it("a page-mode wheel notch zooms by a board height", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
    });

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...center({ x: 2, y: 3 }),
        deltaY: -1,
        deltaMode: 2,
        bubbles: true,
        cancelable: true,
      }),
    );

    const camera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    expect(camera.zoom).toBeGreaterThan(2);
  });

  it("a click-tool drag pans the map and swallows the click", () => {
    const zoomed: Camera = { zoom: 2, center: { x: 14, y: 9 } };
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
      camera: zoomed,
    });

    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointermove", {
      buttons: 1,
      clientX: 302,
      clientY: 300 + HUD_INSET.top,
    });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    dispatchPointer(canvas, "pointermove", {
      buttons: 1,
      clientX: 364,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointerup", {
      clientX: 364,
      clientY: 300 + HUD_INSET.top,
    });
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 364,
        clientY: 300 + HUD_INSET.top,
        bubbles: true,
      }),
    );

    // 64px of travel at 64px tiles moves the view one tile west.
    expect(callbacks.onCameraChange).toHaveBeenLastCalledWith({
      zoom: 2,
      center: { x: 13, y: 9 },
    });
    expect(callbacks.onTileClick).not.toHaveBeenCalled();
    // The grabbed tile stays under the cursor, and so does the hover preview.
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith({ x: 11, y: 9 });

    // A press that does not travel is still an ordinary click.
    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointerup", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 300,
        clientY: 300 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(callbacks.onTileClick).toHaveBeenCalledTimes(1);

    // A press that leaves the board drops the hover preview.
    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointerleave", {
      buttons: 1,
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith(null);
  });

  it("a pan the camera clamps keeps the hover on the tile under the cursor", () => {
    // At fit the map cannot move, so the cursor crosses tiles during the pan.
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
    });

    dispatchPointer(canvas, "pointermove", center({ x: 3, y: 3 }));
    dispatchPointer(canvas, "pointerdown", center({ x: 3, y: 3 }));
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 8, y: 3 }),
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", center({ x: 8, y: 3 }));

    expect(callbacks.onCameraChange).toHaveBeenLastCalledWith(null);
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith({ x: 8, y: 3 });
  });

  it("middle-button drag pans without starting a road stroke", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });

    dispatchPointer(canvas, "pointerdown", {
      button: 1,
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointermove", {
      buttons: 4,
      clientX: 300,
      clientY: 236 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointerup", {
      button: 1,
      clientX: 300,
      clientY: 236 + HUD_INSET.top,
    });

    expect(callbacks.onCameraChange).toHaveBeenLastCalledWith({
      zoom: 2,
      center: { x: 14, y: 10 },
    });
    expect(callbacks.onDragStart).not.toHaveBeenCalled();
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();
  });

  it("applies button and key camera actions against the board", () => {
    const { host, callbacks } = createFixture({
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });

    host.adjustCamera({ kind: "zoomIn" });
    // A pan key moves the view east by a fifth of the board.
    host.adjustCamera({ kind: "pan", x: 1, y: 0 });
    host.adjustCamera({ kind: "fit" });

    const [zoomed, panned, fitted] = callbacks.onCameraChange.mock.calls.map(
      ([camera]) => camera as Camera | null,
    );
    expect(zoomed).toEqual({ zoom: 2.5, center: { x: 14, y: 9 } });
    // At 80px tiles, 0.2 * 896px is 2.24 tiles.
    expect(panned?.zoom).toBe(2.5);
    expect(panned?.center.x).toBeCloseTo(16.24);
    expect(panned?.center.y).toBe(9);
    expect(fitted).toBeNull();
  });

  it("a key pan re-aims the hover at the tile under a still pointer", () => {
    const { host, canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });

    // At 64px tiles, (288, 320) is over tile (11, 9).
    dispatchPointer(canvas, "pointermove", {
      clientX: 288,
      clientY: 320 + HUD_INSET.top,
    });
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith({ x: 11, y: 9 });
    // The view moves 2.8 tiles east beneath the pointer.
    host.adjustCamera({ kind: "pan", x: 1, y: 0 });
    expect(callbacks.onHoverTile).toHaveBeenLastCalledWith({ x: 14, y: 9 });

    // Once the pointer leaves the board there is nothing to re-aim.
    dispatchPointer(canvas, "pointerleave", {
      clientX: 288,
      clientY: 320 + HUD_INSET.top,
    });
    callbacks.onHoverTile.mockClear();
    host.adjustCamera({ kind: "pan", x: -1, y: 0 });
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();
  });

  it("Space + drag pans under a drag tool, but not while typing", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });
    const space = (target: EventTarget, type: "keydown" | "keyup") => {
      const event = new KeyboardEvent(type, {
        key: " ",
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    };

    expect(space(document.body, "keydown").defaultPrevented).toBe(true);
    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointermove", {
      buttons: 1,
      clientX: 236,
      clientY: 300 + HUD_INSET.top,
    });
    dispatchPointer(canvas, "pointerup", {
      clientX: 236,
      clientY: 300 + HUD_INSET.top,
    });
    space(document.body, "keyup");

    expect(callbacks.onCameraChange).toHaveBeenLastCalledWith({
      zoom: 2,
      center: { x: 15, y: 9 },
    });
    expect(callbacks.onDragStart).not.toHaveBeenCalled();

    const field = document.createElement("input");
    document.body.appendChild(field);
    expect(space(field, "keydown").defaultPrevented).toBe(false);
    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledTimes(1);
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

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 0 }),
      buttons: 1,
    });

    expect(callbacks.onDragCurrent).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(callbacks.onHoverTile).not.toHaveBeenCalled();

    dispatchPointer(canvas, "pointerleave", {
      ...center({ x: 5, y: 0 }),
      buttons: 1,
    });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
    expect(callbacks.onHoverTile).toHaveBeenCalledWith(null);
  });

  it("a held gesture ignores moves from foreign pointers", () => {
    // A press/drag is driven by a pointer with a button down, so events that
    // report a different pointerId belong to another pointer source.
    // They must not steer, preview, or commit the gesture.
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
    });
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 2, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 2, y: 0 });

    // A foreign pointer moving at another tile does not steer the drag.
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 20, y: 12 }),
      pointerId: 2,
      buttons: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 2, y: 0 });

    // The real gesture resumes and commits on release.
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      button: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("a held mouse gesture ignores zero-button events that share the mouse pointerId", () => {
    // Headed browser automation can interleave the real OS cursor with the
    // synthetic mouse stream. Both are mouse pointerId 1, so pointerId alone
    // cannot keep that foreign zero-button stream from committing the stroke.
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
    });
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 2, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 2, y: 0 });

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 20, y: 12 }),
      pointerId: 1,
      buttons: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 2, y: 0 });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...center({ x: 20, y: 12 }),
        deltaY: -200,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();

    dispatchPointer(canvas, "pointerleave", {
      ...center({ x: 20, y: 12 }),
      pointerId: 1,
      buttons: 0,
    });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      button: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps the visible drag geometry when a scene update lands before the zoom redraw", () => {
    const { canvas, callbacks, setUi, fireFrame, setSceneRevision } =
      createFixture({
        ui: { activeTool: "remove" },
      });
    fireFrame(0);
    const startTile = { x: 14, y: 9 };
    const start = center(startTile);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith(startTile);
    setUi({
      drag: { tool: "remove", start: startTile, current: startTile },
    });

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...start,
        deltaY: -70,
        ctrlKey: true,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onCameraChange).toHaveBeenCalled();

    // City growth can advance the live scene before the zoomed camera has
    // painted. The still-visible pre-zoom frame remains the geometry the
    // release actuates.
    setSceneRevision(2);
    const releaseTile = { x: 16, y: 9 };
    dispatchPointer(canvas, "pointerup", {
      ...center(releaseTile),
      pointerId: 1,
      button: 0,
      buttons: 0,
    });

    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(releaseTile);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("pinch zoom during a held drag remaps the release after redraw", () => {
    const {
      canvas,
      callbacks,
      setUi,
      host,
      fireFrame,
      getState,
      setSceneRevision,
    } = createFixture({
      ui: { activeTool: "road" },
    });
    fireFrame(0);
    const startTile = { x: 14, y: 9 };
    const start = center(startTile);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith(startTile);
    setUi({
      drag: { tool: "road", start: startTile, current: startTile },
    });

    // Trackpad pinch arrives as ctrl+wheel with no mouse button bits. It is
    // deliberate camera input, not the foreign zero-button pointer stream.
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...start,
        deltaY: -70,
        ctrlKey: true,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onCameraChange).toHaveBeenCalled();

    // A structural city update can land in the same interval; the redraw then
    // carries both the new scene revision and the zoomed camera.
    setSceneRevision(2);

    // The runtime publishes the camera and repaints. Once the zoomed frame is
    // what the player sees, the rest of the stroke resolves in that frame.
    host.render();
    fireFrame(16);
    const camera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const releaseTile = { x: 16, y: 9 };
    const release = centerForCamera(releaseTile, getState().map, camera);

    dispatchPointer(canvas, "pointermove", {
      ...release,
      pointerId: 1,
      button: -1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...release,
      pointerId: 1,
      button: 0,
      buttons: 0,
    });

    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(releaseTile);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("remaps a drag again after a keyboard zoom paints", () => {
    const { canvas, callbacks, setUi, host, fireFrame, getState } =
      createFixture({
        ui: { activeTool: "remove" },
      });
    fireFrame(0);
    const startTile = { x: 14, y: 9 };
    const start = center(startTile);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "remove", start: startTile, current: startTile },
    });
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...start,
        deltaY: -70,
        ctrlKey: true,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    host.render();
    fireFrame(16);

    const pinchCamera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const board = canvas.getBoundingClientRect();
    const pinchTransform = getBoardTransform(
      board,
      getState().map,
      pinchCamera,
    );

    host.adjustCamera({ kind: "zoomIn" });
    host.render();
    fireFrame(32);

    const camera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const keyboardTransform = getBoardTransform(board, getState().map, camera);
    expect(keyboardTransform.scale).toBeGreaterThan(pinchTransform.scale);

    const releaseTile = { x: 19, y: 9 };
    const release = centerForCamera(releaseTile, getState().map, camera);
    expect(
      canvasToWorld(
        canvas,
        release.clientX,
        release.clientY,
        getState().map,
        pinchTransform,
      )?.tile,
    ).toEqual({ x: 20, y: 9 });
    expect(
      canvasToWorld(
        canvas,
        release.clientX,
        release.clientY,
        getState().map,
        keyboardTransform,
      )?.tile,
    ).toEqual(releaseTile);

    dispatchPointer(canvas, "pointermove", {
      ...release,
      pointerId: 1,
      button: -1,
      buttons: 1,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(releaseTile);

    const moveCallCount = callbacks.onDragCurrent.mock.calls.length;
    dispatchPointer(canvas, "pointerup", {
      ...release,
      pointerId: 1,
      button: 0,
      buttons: 0,
    });

    expect(callbacks.onDragCurrent.mock.calls.length).toBe(moveCallCount + 1);
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(releaseTile);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("commits a drag on the chorded primary release instead of arming the next click", () => {
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "remove" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 2, y: 2 }),
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 2, y: 2 });
    setUi({
      drag: { tool: "remove", start: { x: 2, y: 2 }, current: { x: 2, y: 2 } },
    });
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 3 }),
      pointerId: 1,
      buttons: 1,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 3 });

    // Chorded mouse buttons report their intermediate state changes as
    // pointermove: middle presses with button 1, then the primary release
    // reports button 0 while the middle bit remains in `buttons`.
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 3 }),
      pointerId: 1,
      button: 1,
      buttons: 5,
    });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();
    // The release carries newer coordinates than the last move; committing
    // must read this event's position rather than reuse the tracked endpoint.
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 4, y: 4 }),
      pointerId: 1,
      button: 0,
      buttons: 4,
    });

    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 4, y: 4 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
    expect(
      callbacks.onDragCurrent.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(callbacks.onDragCommit.mock.invocationCallOrder[0]!);
    expect(releaseCapture.mock.calls).toContainEqual([1]);

    // The trailing middle-button pointerup is not another release, and the
    // next ordinary press starts a fresh one-tile gesture rather than
    // extending the stale one.
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 4, y: 4 }),
      pointerId: 1,
      button: 1,
      buttons: 0,
    });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 8, y: 8 }),
      pointerId: 1,
      buttons: 0,
    });
    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 8, y: 8 }),
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledTimes(2);
    expect(callbacks.onDragStart).toHaveBeenLastCalledWith({ x: 8, y: 8 });
    setUi({
      drag: { tool: "remove", start: { x: 8, y: 8 }, current: { x: 8, y: 8 } },
    });
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 8, y: 8 }),
      pointerId: 1,
      button: 0,
      buttons: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 8, y: 8 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(2);
  });

  it("a second pointer down mid-drag cannot restart or steal the gesture", () => {
    // Two-finger contact: the first pointer owns the drag. A foreign
    // pointerdown must not re-open it, capture, steer, or commit — the
    // owning pointer still finishes the stroke it started.
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 1,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 9, y: 9 }),
      pointerId: 2,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onDragStart).toHaveBeenLastCalledWith({ x: 1, y: 0 });
    expect(setCapture.mock.calls).not.toContainEqual([2]);

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 9, y: 9 }),
      pointerId: 2,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 9, y: 9 }),
      pointerId: 2,
    });
    expect(callbacks.onDragCurrent).not.toHaveBeenCalledWith({ x: 9, y: 9 });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("a stroke keeps the geometry it started in across a mid-drag redraw", () => {
    // A dock toggle can land a resize + fresh drawn frame mid-gesture. The
    // stroke must resolve every event in the geometry it began in — a
    // release mapped under the new transform would stretch the stroke.
    const { canvas, callbacks, setUi, host, fireFrame } = createFixture({
      ui: { activeTool: "road" },
    });
    fireFrame(0); // drawn targets under the 1:1 board

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 1, y: 0 });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
    });

    // The board halves mid-gesture and the next frame draws under it.
    const { map } = createTestGameState();
    const halfWidth = (map.width * tileSize) / 2;
    const boardHeight =
      map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom;
    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: halfWidth,
          height: boardHeight,
          left: 0,
          top: 0,
          right: halfWidth,
          bottom: boardHeight,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    host.render();
    fireFrame(16);

    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      buttons: 1,
    });
    // Under the redrawn transform the same clientX maps to a different tile.
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 0 });

    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 1,
      button: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith({ x: 3, y: 0 });
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("wheel zoom and hover continue to work after context menu cancels drag", () => {
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 1, y: 0 } },
    });

    // Native context menu fires (e.g. macOS Ctrl+click): an involuntary
    // takeover, so the unfinished stroke is cancelled, never applied.
    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();

    // Wheel zoom works immediately without locking up
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...center({ x: 5, y: 5 }),
        deltaY: -200,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onCameraChange).toHaveBeenCalled();

    // Hover works immediately without locking up
    dispatchPointer(canvas, "pointermove", {
      ...center({ x: 4, y: 4 }),
      buttons: 0,
    });
    expect(callbacks.onHoverTile).toHaveBeenCalledWith({ x: 4, y: 4 });
  });

  it("window blur cancels an unfinished drag instead of committing it", () => {
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 4,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 3, y: 0 } },
    });

    // Alt-Tab / app switch mid-gesture is an interruption, not a deliberate
    // release: the previewed stroke (e.g. a demolish box) must not apply.
    window.dispatchEvent(new Event("blur"));

    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();
    expect(releaseCapture.mock.calls).toContainEqual([4]);

    // The owning pointer's late release cannot resurrect the commit.
    dispatchPointer(canvas, "pointerup", {
      ...center({ x: 3, y: 0 }),
      pointerId: 4,
    });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();
  });

  it("an armed press ignores zero-button moves before it becomes a pan", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });

    dispatchPointer(canvas, "pointerdown", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
      button: 0,
      buttons: 1,
    });
    // A zero-button move far past the pan threshold must not start a pan or
    // rewrite the hover tile — it is not the pressing pointer.
    dispatchPointer(canvas, "pointermove", {
      clientX: 500,
      clientY: 500 + HUD_INSET.top,
      buttons: 0,
    });
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    dispatchPointer(canvas, "pointerup", {
      clientX: 300,
      clientY: 300 + HUD_INSET.top,
      button: 0,
    });
    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 300,
        clientY: 300 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(callbacks.onTileClick).toHaveBeenCalledTimes(1);
  });

  it("pointercancel mid-drag commits a mouse stroke at the last tracked tile and aborts other pointers", () => {
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 7,
    });
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 3, y: 0 } },
    });
    // Chromium can send pointercancel with (0, 0) coordinates; the host must
    // commit at the last tracked tile rather than snapping the stroke to (0, 0).
    dispatchPointer(canvas, "pointercancel", {
      clientX: 0,
      clientY: 0,
      pointerId: 7,
      pointerType: "mouse",
    });
    expect(callbacks.onDragCurrent).not.toHaveBeenCalled();
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
    expect(callbacks.onDragCancel).not.toHaveBeenCalled();

    callbacks.onDragCommit.mockClear();
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 3, y: 0 } },
    });
    dispatchPointer(canvas, "pointercancel", {
      ...center({ x: 3, y: 0 }),
      pointerId: 8,
      pointerType: "touch",
    });
    expect(callbacks.onDragCommit).not.toHaveBeenCalled();
    expect(callbacks.onDragCancel).toHaveBeenCalledTimes(1);
  });

  it("pointerdown captures and pointerup commits a drag gesture", () => {
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { canvas, callbacks, setUi } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 7,
    });
    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 1, y: 0 });
    expect(setCapture.mock.calls).toContainEqual([7]);
    setUi({
      drag: { tool: "road", start: { x: 1, y: 0 }, current: { x: 2, y: 0 } },
    });

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
    expect(callbacks.onTileClick).toHaveBeenCalledWith({ x: 2, y: 3 }, null);

    host.stop();
  });

  it("window resize updates the backing store when no ResizeObserver exists", () => {
    const { container, canvas, renderer, fireFrame, callbacks } =
      createFixture();
    fireFrame(0);

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

    fireFrame(16);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(renderer.resize).toHaveBeenCalledWith(400, 300);

    // The fallback resize also rebases the camera so the map keeps its
    // rendered scale and offsets instead of snapping to the new Fit. The
    // preserved pixels land exactly on the new clamp boundary — the map
    // filled the old board edge-to-edge — so the result is an ordinary
    // camera, not a retained one.
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    const rebased = callbacks.onCameraChange.mock.calls[0]![0] as Camera;
    expect(rebased.retained).toBeFalsy();
    const map = createTestGameState().map;
    const previous = {
      width: map.width * tileSize,
      height: map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom,
    };
    const before = getBoardTransform(previous, map, null);
    const after = getBoardTransform({ width: 400, height: 300 }, map, rebased);
    expect(after.scale).toBeCloseTo(before.scale, 9);
    expect(after.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(after.offsetY).toBeCloseTo(before.offsetY, 6);

    // An equal-size resize is skipped.
    globalThis.window?.dispatchEvent(new Event("resize"));
    fireFrame(32);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
  });

  it("rejects a zero-size window-resize observation so later restoration rebases", () => {
    const domRect = (width: number, height: number) =>
      ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const { container, canvas, renderer, fireFrame, callbacks } =
      createFixture();
    fireFrame(0);

    // A positive fallback resize rebases and pins the backing store.
    container.getBoundingClientRect = vi.fn(() => domRect(400, 300));
    globalThis.window?.dispatchEvent(new Event("resize"));
    fireFrame(16);
    expect(canvas.width).toBe(400);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    const first = callbacks.onCameraChange.mock.calls[0]![0] as Camera;

    // A temporarily hidden host reports a 0×0 content box: the observation
    // must be rejected before it zeroes the size cache, rebases against an
    // empty board, or renders.
    container.getBoundingClientRect = vi.fn(() => domRect(0, 0));
    globalThis.window?.dispatchEvent(new Event("resize"));
    fireFrame(32);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(renderer.resize).toHaveBeenLastCalledWith(400, 300);

    // Restoration at a different size still rebases from the last positive
    // reference, so the map keeps its rendered pixels instead of jumping.
    container.getBoundingClientRect = vi.fn(() => domRect(600, 400));
    globalThis.window?.dispatchEvent(new Event("resize"));
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(2);
    const restored = callbacks.onCameraChange.mock.calls[1]![0] as Camera;
    const map = createTestGameState().map;
    const before = getBoardTransform({ width: 400, height: 300 }, map, first);
    const after = getBoardTransform({ width: 600, height: 400 }, map, restored);
    expect(after.scale).toBeCloseTo(before.scale, 9);
    expect(after.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(after.offsetY).toBeCloseTo(before.offsetY, 6);
    fireFrame(48);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
  });

  it("falls back to the layout box until the ResizeObserver entry arrives", () => {
    // With ResizeObserver present the mount render runs before the first
    // entry: syncSize must still size the backing store via the layout read.
    let roCallback: ((entries: unknown[]) => void) | null = null;
    const observe = vi.fn();
    class FakeResizeObserver {
      constructor(callback: (entries: unknown[]) => void) {
        roCallback = callback;
      }
      observe = observe;
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const { renderer, canvas, container, host, fireFrame } = createFixture();
    const state = createTestGameState();
    expect(observe).toHaveBeenCalledWith(container);
    fireFrame(0);
    expect(canvas.width).toBe(state.map.width * tileSize);
    expect(renderer.resize).toHaveBeenCalledWith(
      state.map.width * tileSize,
      state.map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom,
    );

    // An empty entry list is ignored without scheduling a repaint.
    const drawsBefore = renderer.render.mock.calls.length;
    roCallback!([]);
    fireFrame(16);
    expect(renderer.render.mock.calls.length).toBe(drawsBefore);

    // The first real entry seeds the observed size and repaints; afterwards
    // syncSize uses the cached box (no per-frame layout read).
    roCallback!([{ contentRect: { width: 400, height: 300 } }]);
    fireFrame(33);
    expect(renderer.resize).toHaveBeenLastCalledWith(400, 300);
    renderer.resize.mockClear();
    host.render();
    fireFrame(50);
    expect(renderer.resize).toHaveBeenCalledWith(400, 300);
  });

  it("remounting the same host element reuses the canvas and configuration", () => {
    const { host, canvas, container, renderer, fireFrame } = createFixture();
    const configureCalls = renderer.configure.mock.calls.length;
    fireFrame(0);
    const drawsBefore = renderer.render.mock.calls.length;

    const teardown = host.mount(container);

    expect(container.querySelector("canvas")).toBe(canvas);
    expect(renderer.configure.mock.calls.length).toBe(configureCalls);
    fireFrame(16);
    expect(renderer.render.mock.calls.length).toBe(drawsBefore + 1);
    expect(typeof teardown).toBe("function");
  });

  it("a repeated mount on the same host returns the live mount's detach", () => {
    const { host, canvas, container, callbacks } = createFixture({
      ui: { activeTool: "inspect" },
    });

    const teardown = host.mount(container);

    // The repeat mount early-returns before its own handlers exist, so the
    // cleanup it hands back must be the active mount's detach: calling it
    // detaches the live canvas and listeners rather than throwing.
    expect(() => teardown()).not.toThrow();
    expect(container.querySelector("canvas")).toBeNull();

    canvas.dispatchEvent(
      new MouseEvent("click", { ...center({ x: 2, y: 3 }), bubbles: true }),
    );
    expect(callbacks.onTileClick).not.toHaveBeenCalled();
  });

  it("ignores pointerdown outside the board", () => {
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", { clientX: -10, clientY: -10 });

    expect(callbacks.onDragStart).not.toHaveBeenCalled();
  });

  it("ignores a throwing setPointerCapture", () => {
    (Element.prototype.setPointerCapture as unknown as Mock).mockImplementation(
      () => {
        throw new Error("pointer already inactive");
      },
    );
    const { canvas, callbacks } = createFixture({
      ui: { activeTool: "road" },
    });

    dispatchPointer(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 9,
    });

    expect(callbacks.onDragStart).toHaveBeenCalledWith({ x: 1, y: 0 });
  });

  it("start is idempotent", () => {
    const { host, renderer, rafCount } = createFixture({
      state: runningState(),
    });

    host.start();
    const draws = renderer.render.mock.calls.length;
    const frames = rafCount();
    host.start();

    expect(renderer.render.mock.calls.length).toBe(draws);
    expect(rafCount()).toBe(frames);
    host.stop();
  });

  it("ignores a stale animation frame queued before stop", () => {
    const { host, renderer, fireFrame } = createFixture({
      state: runningState(),
    });
    host.start();
    // stop() cancels the pending rAF, but a callback already delivered to the
    // browser's queue can still fire: the host must ignore it.
    host.stop();
    const drawsBefore = renderer.render.mock.calls.length;

    fireFrame(1000);

    expect(renderer.render.mock.calls.length).toBe(drawsBefore);
  });

  it("a stale teardown from a prior mount cannot detach the current mount", () => {
    const { host, cleanup: staleCleanup, container } = createFixture();

    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    host.mount(secondHost);
    const secondCanvas = secondHost.querySelector("canvas");
    expect(secondCanvas).not.toBeNull();

    // The first mount's returned cleanup is stale: its detach must bail on
    // the surface-host mismatch instead of tearing down the live canvas.
    staleCleanup();

    expect(secondHost.querySelector("canvas")).toBe(secondCanvas);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("captureFrame returns null unmounted and delegates to the renderer mounted", async () => {
    const { host, renderer, cleanup } = createFixture();

    const shot = await host.captureFrame();
    expect(renderer.captureFrame).toHaveBeenCalledTimes(1);
    expect(shot).toEqual({
      width: 2,
      height: 2,
      pixels: expect.any(Uint8ClampedArray),
    });
    // Capture prep syncs size/transform exactly like drawFrame.
    expect(renderer.resize).toHaveBeenCalled();

    cleanup();
    renderer.captureFrame.mockClear();
    await expect(host.captureFrame()).resolves.toBeNull();
    expect(renderer.captureFrame).not.toHaveBeenCalled();
  });
});

describe("createGameHost passive resize camera", () => {
  /** jsdom ships no ResizeObserver; install a fake whose batch callback the
   *  test drives directly. */
  function withFakeResizeObserver() {
    let roCallback: ((entries: unknown[]) => void) | null = null;
    class FakeResizeObserver {
      constructor(callback: (entries: unknown[]) => void) {
        roCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    return {
      fire: (entries: unknown[]) => roCallback?.(entries),
    };
  }

  // A failing assertion must not leak the stubbed ResizeObserver into later
  // tests in the file.
  afterEach(() => vi.unstubAllGlobals());

  it("does not rebase on the first mount or an equal-size batch", () => {
    const fake = withFakeResizeObserver();
    const { container, callbacks, fireFrame } = createFixture();
    fireFrame(0);
    callbacks.onCameraChange.mockClear();

    // The first observer batch reports the size the mount already rendered;
    // an equal-size batch after draws is equally a no-op.
    const box = container.getBoundingClientRect();
    fake.fire([{ contentRect: { width: box.width, height: box.height } }]);
    fake.fire([{ contentRect: { width: box.width, height: box.height } }]);

    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
  });

  it("ignores sub-device-pixel size wobble between observer batches", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const fake = withFakeResizeObserver();
    const { container, callbacks, fireFrame, getState, renderer } =
      createFixture();
    fireFrame(0);
    const verticesBefore = new Float32Array(
      renderer.frames.at(-1)!.solids[0]!.vertices,
    );
    callbacks.onCameraChange.mockClear();

    // Fractional CSS sizes can oscillate by less than one device pixel
    // (e.g. at 110% browser zoom); that is not a resize the camera should
    // rebase for, nor may it alter the drawn transform or advance the
    // rebase reference.
    const box = container.getBoundingClientRect();
    const map = getState().map;
    const before = getBoardTransform(
      { width: box.width, height: box.height },
      map,
      null,
    );
    fake.fire([
      { contentRect: { width: box.width + 0.2, height: box.height } },
    ]);
    fireFrame(16);

    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
    expect(renderer.frames.at(-1)!.solids[0]!.vertices).toEqual(verticesBefore);

    // A later real resize rebases from the original usable size, not from the
    // ignored sub-pixel wobble.
    const realSize = { width: box.width + 1, height: box.height };
    fake.fire([{ contentRect: realSize }]);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    const rebased = callbacks.onCameraChange.mock.calls[0]![0] as Camera;
    const after = getBoardTransform(realSize, map, rebased);
    expect(after.scale).toBeCloseTo(before.scale, 9);
    expect(after.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(after.offsetY).toBeCloseTo(before.offsetY, 6);
  });

  it("wheel zoom and drag pan between a resize observation and the next draw use the rebased board size", () => {
    const fake = withFakeResizeObserver();
    const { canvas, container, callbacks, fireFrame, getState, renderer } =
      createFixture({ ui: { activeTool: "inspect" } });
    fireFrame(0);

    const box = container.getBoundingClientRect();
    const map = getState().map;
    const resized = {
      width: Math.round(box.width * 0.65),
      height: box.height,
    };
    // Observer rebases the camera synchronously while the canvas element still
    // keeps its pre-draw DOM bounding rect until the next rAF.
    fake.fire([{ contentRect: resized }]);
    const rebased = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    expect(rebased).not.toBeNull();

    const pointer = { clientX: 84, clientY: HUD_INSET.top + 48 };
    const beforeWheel = getBoardTransform(resized, map, rebased);
    const worldUnder = {
      x: (pointer.clientX - beforeWheel.offsetX) / beforeWheel.scale,
      y: (pointer.clientY - beforeWheel.offsetY) / beforeWheel.scale,
    };

    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        clientX: pointer.clientX,
        clientY: pointer.clientY,
        deltaY: -200,
        bubbles: true,
        cancelable: true,
      }),
    );
    const wheeled = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const afterWheel = getBoardTransform(resized, map, wheeled);
    expect(afterWheel.offsetX + worldUnder.x * afterWheel.scale).toBeCloseTo(
      pointer.clientX,
      6,
    );
    expect(afterWheel.offsetY + worldUnder.y * afterWheel.scale).toBeCloseTo(
      pointer.clientY,
      6,
    );

    // Drag-panning in the same pre-draw interval also uses the rebased board
    // size rather than the stale canvas DOM rect.
    dispatchPointer(canvas, "pointerdown", {
      button: 0,
      buttons: 1,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
    });
    dispatchPointer(canvas, "pointermove", {
      buttons: 1,
      clientX: pointer.clientX + 20,
      clientY: pointer.clientY + 12,
    });
    dispatchPointer(canvas, "pointerup", {
      button: 0,
      buttons: 0,
      clientX: pointer.clientX + 20,
      clientY: pointer.clientY + 12,
    });
    const panned = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    fireFrame(16);

    const afterDraw = getBoardTransform(resized, map, panned);
    expect(afterDraw.offsetX + worldUnder.x * afterDraw.scale).toBeCloseTo(
      pointer.clientX + 20,
      6,
    );
    expect(afterDraw.offsetY + worldUnder.y * afterDraw.scale).toBeCloseTo(
      pointer.clientY + 12,
      6,
    );

    // The submitted frame uses that same transform: the first scene vertex is
    // the map origin and the second is one tile over in the empty fixture map.
    const clipX = (worldX: number) =>
      (2 * (afterDraw.offsetX + worldX * afterDraw.scale)) / resized.width - 1;
    const clipY = (worldY: number) =>
      1 - (2 * (afterDraw.offsetY + worldY * afterDraw.scale)) / resized.height;
    const submittedVertices = renderer.frames.at(-1)!.solids[0]!.vertices;
    expect(submittedVertices[0]).toBeCloseTo(clipX(0), 6);
    expect(submittedVertices[1]).toBeCloseTo(clipY(0), 6);
    expect(submittedVertices[6]).toBeCloseTo(clipX(tileSize), 6);
    expect(submittedVertices[7]).toBeCloseTo(clipY(0), 6);
  });

  it("rebases each resize against the latest rendered size without double-rebasing", () => {
    const fake = withFakeResizeObserver();
    const { callbacks, fireFrame, getState } = createFixture();
    fireFrame(0);
    const map = getState().map;

    fake.fire([{ contentRect: { width: 400, height: 300 } }]);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    const first = callbacks.onCameraChange.mock.calls[0]![0] as Camera;
    // The fixture's board fits the map exactly at tile scale, so the
    // preserved pixels sit exactly on the new clamp boundary — an ordinary
    // camera, not a retained one.
    expect(first.retained).toBeFalsy();

    // A second batch before the next frame must rebase from the first size
    // (boardCss dimensions update synchronously), not from the stale mount
    // size, so the drawn pixels survive both resizes.
    fake.fire([{ contentRect: { width: 360, height: 280 } }]);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(2);
    const second = callbacks.onCameraChange.mock.calls[1]![0] as Camera;

    const t1 = getBoardTransform({ width: 400, height: 300 }, map, first);
    const t2 = getBoardTransform({ width: 360, height: 280 }, map, second);
    expect(t2.scale).toBeCloseTo(t1.scale, 9);
    expect(t2.offsetX).toBeCloseTo(t1.offsetX, 6);
    expect(t2.offsetY).toBeCloseTo(t1.offsetY, 6);
  });

  it("a fresh mount cannot rebase its camera against the previous city's size", () => {
    const fake = withFakeResizeObserver();
    const { host, callbacks, cleanup, fireFrame } = createFixture();
    fireFrame(0);
    fake.fire([{ contentRect: { width: 400, height: 300 } }]);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);

    // Detach resets the rendered-size cache along with the observed sizes,
    // so a newly mounted city starts from its own freshly measured board.
    cleanup();
    callbacks.onCameraChange(null);
    callbacks.onCameraChange.mockClear();

    const second = document.createElement("div");
    document.body.appendChild(second);
    host.mount(second);
    fireFrame(16);
    const box = second.getBoundingClientRect();
    fake.fire([{ contentRect: { width: box.width, height: box.height } }]);

    expect(callbacks.onCameraChange).not.toHaveBeenCalled();
  });

  it("does not re-pin a drag to a passive resize for a no-op camera action", () => {
    const fake = withFakeResizeObserver();
    const camera: Camera = { zoom: 3, center: { x: 14, y: 9 } };
    const { canvas, container, callbacks, setUi, host, fireFrame, getState } =
      createFixture({
        ui: { activeTool: "remove" },
        camera,
      });
    fireFrame(0);
    const map = getState().map;
    const oldBox = container.getBoundingClientRect();
    const startTile = { x: 14, y: 9 };
    const start = centerForCamera(startTile, map, camera);
    const before = getBoardTransform(oldBox, map, camera);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "remove", start: startTile, current: startTile },
    });

    // Dock close: a passive resize preserves the drawn transform while
    // exposing more canvas, but the live stroke stays on its original box.
    const nextWidth = Math.round(oldBox.width * 1.25);
    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: nextWidth,
          height: oldBox.height,
          left: 0,
          top: 0,
          right: nextWidth,
          bottom: oldBox.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    fake.fire([{ contentRect: { width: nextWidth, height: oldBox.height } }]);
    fireFrame(16);
    const rebased = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const afterResize = getBoardTransform(
      { width: nextWidth, height: oldBox.height },
      map,
      rebased,
    );
    expect(afterResize.scale).toBeCloseTo(before.scale, 9);
    expect(afterResize.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(afterResize.offsetY).toBeCloseTo(before.offsetY, 6);

    // Zoom In is already at the limit. It must not count as navigation that
    // widens the still-live stroke's reachable box.
    host.adjustCamera({ kind: "zoomIn" });
    host.render();
    fireFrame(32);
    const unchanged = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const afterNoop = getBoardTransform(
      { width: nextWidth, height: oldBox.height },
      map,
      unchanged,
    );
    expect(afterNoop.scale).toBeCloseTo(before.scale, 9);
    expect(afterNoop.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(afterNoop.offsetY).toBeCloseTo(before.offsetY, 6);

    const beyondOldBox = { clientX: oldBox.width + 20, clientY: start.clientY };
    dispatchPointer(canvas, "pointermove", {
      ...beyondOldBox,
      pointerId: 1,
      button: -1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...beyondOldBox,
      pointerId: 1,
      button: 0,
      buttons: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(null);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("does not re-pin a no-op camera action after a zero-fit recovery", () => {
    const fake = withFakeResizeObserver();
    const camera: Camera = { zoom: 3, center: { x: 14, y: 9 } };
    const { canvas, container, callbacks, setUi, host, fireFrame, getState } =
      createFixture({
        ui: { activeTool: "remove" },
        camera,
      });
    fireFrame(0);
    const map = getState().map;
    const initialBox = container.getBoundingClientRect();
    const startTile = { x: 14, y: 9 };
    const start = centerForCamera(startTile, map, camera);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "remove", start: startTile, current: startTile },
    });

    const widerWidth = Math.round(initialBox.width * 1.25);
    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: widerWidth,
          height: initialBox.height,
          left: 0,
          top: 0,
          right: widerWidth,
          bottom: initialBox.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    fake.fire([
      { contentRect: { width: widerWidth, height: initialBox.height } },
    ]);
    fireFrame(16);

    // Zoom In is already at the limit. Collapse and restore the viewport before
    // its requested repaint so the zero-fit frame cannot become the comparison
    // baseline that makes the unchanged visible transform look like navigation.
    host.adjustCamera({ kind: "zoomIn" });
    fake.fire([{ contentRect: { width: widerWidth, height: 150 } }]);
    fireFrame(32);
    fake.fire([
      { contentRect: { width: widerWidth, height: initialBox.height } },
    ]);
    fireFrame(48);

    const beyondOldBox = {
      clientX: initialBox.width + 20,
      clientY: start.clientY,
    };
    dispatchPointer(canvas, "pointermove", {
      ...beyondOldBox,
      pointerId: 1,
      button: -1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...beyondOldBox,
      pointerId: 1,
      button: 0,
      buttons: 0,
    });
    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(null);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps a camera drag repin pending across a zero-fit frame", () => {
    const fake = withFakeResizeObserver();
    const { canvas, container, callbacks, setUi, fireFrame, getState } =
      createFixture({
        ui: { activeTool: "remove" },
      });
    fireFrame(0);
    const initialBox = container.getBoundingClientRect();
    const startTile = { x: 14, y: 9 };
    const start = center(startTile);

    dispatchPointer(canvas, "pointerdown", {
      ...start,
      pointerId: 1,
      button: 0,
      buttons: 1,
    });
    setUi({
      drag: { tool: "remove", start: startTile, current: startTile },
    });
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        ...start,
        deltaY: -70,
        ctrlKey: true,
        buttons: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(callbacks.onCameraChange).toHaveBeenCalled();

    // Positive width and height can still have no safe viewport once the HUD
    // insets consume the height. That unusable paint must not consume the pin.
    fake.fire([{ contentRect: { width: initialBox.width, height: 150 } }]);
    fireFrame(16);

    const restored = { width: initialBox.width, height: 600 };
    fake.fire([{ contentRect: restored }]);
    fireFrame(32);

    const camera = callbacks.onCameraChange.mock.lastCall?.[0] as Camera;
    const transform = getBoardTransform(restored, getState().map, camera);
    expect(transform.scale).toBeGreaterThan(0);
    const releaseTile = { x: 16, y: 9 };
    const release = {
      clientX:
        transform.offsetX + (releaseTile.x + 0.5) * tileSize * transform.scale,
      clientY:
        transform.offsetY + (releaseTile.y + 0.5) * tileSize * transform.scale,
    };
    dispatchPointer(canvas, "pointermove", {
      ...release,
      pointerId: 1,
      button: -1,
      buttons: 1,
    });
    dispatchPointer(canvas, "pointerup", {
      ...release,
      pointerId: 1,
      button: 0,
      buttons: 0,
    });

    expect(callbacks.onDragCurrent).toHaveBeenLastCalledWith(releaseTile);
    expect(callbacks.onDragCommit).toHaveBeenCalledTimes(1);
  });

  it("preserves the last usable size reference across a zero-fit resize", () => {
    const fake = withFakeResizeObserver();
    const { container, callbacks, fireFrame, getState } = createFixture();
    fireFrame(0);
    const initialBox = container.getBoundingClientRect();
    const map = getState().map;
    const before = getBoardTransform(
      { width: initialBox.width, height: initialBox.height },
      map,
      null,
    );

    // Collapse height inside the HUD inset band (<= 160px): width and height
    // are both positive, yet fitScale is 0. Both rebaseForResize and syncSize
    // must keep the 1280/initial usable size untouched.
    fake.fire([{ contentRect: { width: initialBox.width, height: 150 } }]);
    fireFrame(16);
    expect(callbacks.onCameraChange).not.toHaveBeenCalled();

    // Restore to a positive-fit height: rebasing must use the original usable
    // size so the drawn scale and offsets match the pre-collapse frame.
    const restored = { width: initialBox.width, height: 600 };
    fake.fire([{ contentRect: restored }]);
    expect(callbacks.onCameraChange).toHaveBeenCalledTimes(1);
    const rebased = callbacks.onCameraChange.mock.calls[0]![0] as Camera;
    const after = getBoardTransform(restored, map, rebased);
    expect(after.scale).toBeCloseTo(before.scale, 9);
    expect(after.offsetX).toBeCloseTo(before.offsetX, 6);
    expect(after.offsetY).toBeCloseTo(before.offsetY, 6);
  });
});

describe("createGameHost 10 Hz tick admission", () => {
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

  it("drains retained backlog at no more than one admission per 100ms", async () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    let release: () => void = () => {};
    callbacks.onTick.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    host.start();

    fireFrame(0);
    fireFrame(100); // admits the held tick: 100ms accumulated, now in flight
    expect(callbacks.onTick).toHaveBeenCalledTimes(1);

    // The tick stays in flight while ~500ms of wall time accumulates.
    fireFrame(300);
    fireFrame(500);
    fireFrame(600);
    expect(callbacks.onTick).toHaveBeenCalledTimes(1);

    release();
    await flushMicrotasks(); // let the admission gate observe completion
    // Later ticks resolve immediately: only the wall-clock admission paces
    // the drain, never the in-flight gate.
    fireFrame(616); // backlog crosses both gates -> one 0.25s tick, ~266ms kept
    expect(callbacks.onTick).toHaveBeenCalledTimes(2);
    expect(callbacks.onTick).toHaveBeenLastCalledWith(0.25);
    await flushMicrotasks();

    // The retained backlog still exceeds 100ms on the very next frame, but
    // admissions may not run at rAF rate while draining.
    fireFrame(633);
    fireFrame(650);
    fireFrame(666);
    fireFrame(683);
    fireFrame(700);
    expect(callbacks.onTick).toHaveBeenCalledTimes(2);
    fireFrame(716); // 100ms since the second admission -> the third tick
    expect(callbacks.onTick).toHaveBeenCalledTimes(3);

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

  it("treats a synchronous onTick return as immediately resolved", () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    callbacks.onTick.mockReturnValue(undefined);
    host.start();

    const nextTimestamp = ticker();
    for (let frame = 0; frame < 20; frame += 1) {
      fireFrame(nextTimestamp());
    }

    // No promise gate: each ~100ms window admits the next tick. A stuck
    // in-flight flag would have admitted only the first.
    expect(callbacks.onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    host.stop();
  });

  it("clears the admission gate when onTick throws", () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    callbacks.onTick.mockImplementation(() => {
      throw new Error("tick blew up");
    });
    host.start();

    const nextTimestamp = ticker();
    for (let frame = 0; frame < 20; frame += 1) {
      fireFrame(nextTimestamp());
    }

    // The throw must not wedge tickInFlight: later windows still admit.
    expect(callbacks.onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    host.stop();
  });

  it("clears the admission gate when the tick promise rejects", async () => {
    const { host, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    callbacks.onTick.mockImplementation(() =>
      Promise.reject(new Error("tick failed")),
    );
    host.start();

    const nextTimestamp = ticker();
    for (let frame = 0; frame < 20; frame += 1) {
      fireFrame(nextTimestamp());
      await flushMicrotasks();
    }

    expect(callbacks.onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    host.stop();
  });
});

describe("createGameHost render coalescing", () => {
  it("does not draw twice around an accepted running tick", () => {
    const { host, renderer, callbacks, fireFrame } = createFixture({
      state: runningState(),
    });
    // mount and start() only schedule repaints; nothing draws until a frame.
    host.start();
    expect(renderer.render).not.toHaveBeenCalled();

    fireFrame(16);
    fireFrame(33);
    expect(callbacks.onTick).not.toHaveBeenCalled(); // below the gate
    // Exactly one draw per fired frame; the mount/start repaints coalesce.
    expect(renderer.render).toHaveBeenCalledTimes(2);

    const drawsBefore = renderer.render.mock.calls.length;
    host.render(); // rAF owns display: record only, no extra draw
    expect(renderer.render.mock.calls.length).toBe(drawsBefore);

    fireFrame(50); // next rAF draws the latest state exactly once
    expect(renderer.render.mock.calls.length).toBe(drawsBefore + 1);

    host.stop();
  });

  it("repaints on the next frame while paused with no loop scheduled", () => {
    const { host, renderer, fireFrame } = createFixture();

    host.start(); // paused: no tick loop, but a repaint is queued
    expect(renderer.render).not.toHaveBeenCalled();

    fireFrame(16);
    expect(renderer.render).toHaveBeenCalledTimes(1);

    host.render(); // another explicit repaint schedules another frame draw
    fireFrame(33);
    expect(renderer.render.mock.calls.length).toBe(2);
  });
});

describe("createGameHost observed vehicle history", () => {
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
      capacity: 18,
      passengerCount: 0,
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

    fx.host.start();
    fx.fireFrame(0); // observes the previous state at rAF-time 0

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
    fx.fireFrame(0); // paused: no loop — the queued repaint draws once

    const rows = lastVehicleInstances(fx);
    expect(rows.length).toBe(1);
    const worldX = clipToWorld(rows[0]![0]!, 28 * tileSize);
    const latestX = (2 + 3 * 0.5) * tileSize + tileSize / 2;
    expect(worldX).toBeCloseTo(latestX, 3);
    vi.unstubAllGlobals();
  });
});

describe("createGameHost map target picking", () => {
  it("picks the drawn vehicle under a zoomed click, and suppresses after a pan", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
      camera: { zoom: 2, center: { x: 7, y: 4.5 } },
    });
    fx.fireFrame(0);

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 160,
        clientY: 160 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenCalledWith(
      { x: 2, y: 2 },
      { vehicleId: "vehicle-001", lineId: "route-001" },
    );

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 700,
        clientY: 400 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 10, y: 6 },
      null,
    );

    fx.host.adjustCamera({ kind: "pan", x: 1, y: 0 });
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 160,
        clientY: 160 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 2, y: 2 },
      { vehicleId: "vehicle-001", lineId: "route-001" },
    );

    dispatchPointer(fx.canvas, "pointerdown", {
      clientX: 160,
      clientY: 160 + HUD_INSET.top,
    });
    dispatchPointer(fx.canvas, "pointermove", {
      buttons: 1,
      clientX: 200,
      clientY: 160 + HUD_INSET.top,
    });
    dispatchPointer(fx.canvas, "pointerup", {
      clientX: 200,
      clientY: 160 + HUD_INSET.top,
    });
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 200,
        clientY: 160 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenCalledTimes(3);
  });

  it("forwards a tile-gated line candidate, and null on a neighboring tile", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
    });
    fx.fireFrame(0);

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 170,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 5, y: 2 },
      { vehicleId: null, lineId: "route-001" },
    );

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 116,
        clientY: 96 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 3, y: 3 },
      null,
    );
  });

  it("still resolves a click the live camera maps off the drawn map", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
    });
    fx.fireFrame(0);

    Element.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 1400,
          height: 576,
          left: 0,
          top: 0,
          right: 1400,
          bottom: 576,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenCalledWith(
      { x: 2, y: 2 },
      { vehicleId: "vehicle-001", lineId: "route-001" },
    );
  });

  it("keeps the screen's pick targets across an offscreen capture", async () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
    });
    fx.fireFrame(0);

    fx.setState(createTestGameState());
    await fx.host.captureFrame();

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenCalledWith(
      { x: 2, y: 2 },
      { vehicleId: "vehicle-001", lineId: "route-001" },
    );
  });

  it("updates pick targets across a visible Canvas2D capture", async () => {
    const fx = createFixture({
      state: createTestGameState(),
      ui: { activeTool: "inspect" },
      rendererKind: "canvas2d",
    });
    fx.fireFrame(0);

    fx.setState(stateWithVehicleForFrame());
    await fx.host.captureFrame();

    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenCalledWith(
      { x: 2, y: 2 },
      { vehicleId: "vehicle-001", lineId: "route-001" },
    );
  });

  it("clears pick targets on detach so a remount starts empty", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
    });
    fx.fireFrame(0);

    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    fx.host.mount(secondHost);
    const canvas = secondHost.querySelector("canvas") as HTMLCanvasElement;

    canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 2, y: 2 },
      null,
    );
  });

  it("carries no stale picks or mapping into a replaced scene", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect" },
    });
    fx.fireFrame(0);

    // A city load swaps the world and bumps the scene revision before the
    // next frame draws. A click in that gap resolves against the live map —
    // the drawn targets belong to the previous scene and must not leak a
    // vehicle pick (ids repeat across cities) or its transform.
    fx.setState(createTestGameState());
    fx.setSceneRevision(2);
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 2, y: 2 },
      null,
    );

    // Once the new scene has drawn a frame, clicks actuate that frame again.
    fx.fireFrame(16);
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 2, y: 2 },
      null,
    );
  });

  it("carries no pick while a building placement is armed", () => {
    const fx = createFixture({
      state: stateWithVehicleForFrame(),
      ui: { activeTool: "inspect", selectedBuilding: "smallHouse" },
    });
    fx.fireFrame(0);

    // An armed placement is a build click, not a Select click: the drawn
    // vehicle under it must not reach handleTileClick as a candidate.
    fx.canvas.dispatchEvent(
      new MouseEvent("click", {
        clientX: 80,
        clientY: 80 + HUD_INSET.top,
        bubbles: true,
      }),
    );
    expect(fx.callbacks.onTileClick).toHaveBeenLastCalledWith(
      { x: 2, y: 2 },
      null,
    );
  });
});

describe("createGameHost device loss", () => {
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

  it("forwards render errors to onFatalError and stops the animation loop", () => {
    const fx = createFixture({ state: runningState() });
    const renderError = new Error("render pass failed");
    fx.renderer.render.mockImplementation(() => {
      throw renderError;
    });

    fx.host.start();
    fx.fireFrame(16);

    expect(fx.callbacks.onFatalError).toHaveBeenCalledTimes(1);
    expect(fx.callbacks.onFatalError).toHaveBeenCalledWith(renderError);
    expect(fx.host.isRunning()).toBe(false);
    expect(fx.rafCount()).toBe(0);
  });
});

describe("createGameHost frame contents", () => {
  it("independently caches structural and marker projections across style and camera changes", () => {
    const fx = createFixture({ state: unpaused(stateWithVehicleForFrame()) });
    fx.host.start();
    fx.fireFrame(16);
    fx.fireFrame(33);
    const [first, second] = fx.renderer.frames.slice(-2);
    expect(second!.sprites!.instances).toBe(first!.sprites!.instances);
    expect(second!.markerSprites!.instances.length).toBeGreaterThan(0);
    expect(second!.markerSprites!.instances).toBe(
      first!.markerSprites!.instances,
    );
    fx.setUi({ selectedRouteId: "route-001" });
    fx.fireFrame(50);
    const selected = fx.renderer.frames.at(-1)!;
    expect(selected.sprites!.instances).toBe(second!.sprites!.instances);
    expect(selected.markerSprites!.instances).not.toBe(
      second!.markerSprites!.instances,
    );
    fx.callbacks.onCameraChange({ zoom: 2, center: { x: 14, y: 9 } });
    fx.fireFrame(66);
    const moved = fx.renderer.frames.at(-1)!;
    expect(moved.sprites!.instances).not.toBe(selected.sprites!.instances);
    expect(moved.markerSprites!.instances).not.toBe(
      selected.markerSprites!.instances,
    );
    fx.host.stop();
  });

  it("draws solid ranges and vehicle instances in painter order", () => {
    const fx = createFixture({ state: stateWithVehicleForFrame() });
    fx.host.start();
    fx.fireFrame(16);

    const frame = fx.renderer.frames.at(-1)!;
    // Painter stages: scene solids, one sprite batch, route/draft overlays,
    // vehicles, then handles.
    expect(frame.solids.length).toBe(1);
    expect(frame.solids[0]!.role).toBe("structural");
    expect(frame.sprites).toBeDefined();
    expect(frame.sprites!.instances.length % SPRITE_INSTANCE_FLOATS).toBe(0);
    expect(frame.overSprites!.map((batch) => batch.role)).toEqual([
      "dynamic",
      "route",
    ]);
    expect(frame.markerSprites!.instances.length).toBe(
      4 * SPRITE_INSTANCE_FLOATS,
    );
    expect(frame.overMarkers!.map((batch) => batch.role)).toEqual(["dynamic"]);
    expect(frame.vehicles.length).toBe(1);
    expect(frame.vehicles[0]!.instances.length).toBe(VEHICLE_INSTANCE_FLOATS);
    // No route editor open: the over-vehicles range emits an empty batch.
    expect(frame.overVehicles![0]!.role).toBe("dynamic");
    expect(frame.overVehicles![0]!.vertices.length).toBe(0);

    fx.host.stop();
  });

  it("keeps raw world angle and extents and appends clip factors to instances", () => {
    // Southbound bus: world tangent (0, 1) -> world angle +π/2, passed
    // through raw (the y-flip lives in the clip factors). Body extents stay
    // world px. The trailing clip factors come from a board at DPR 1 that is
    // 896x736 px (28x18 tiles plus the HUD insets), where the 896x576 safe
    // rect fits the map exactly at scale 1: sx = 2/896, sy = -2/736.
    const fx = createFixture({
      state: unpaused(stateWithVehicleForFrame({ x: 2, y: 5 })),
    });
    fx.host.start();
    fx.fireFrame(16);

    const instances = fx.renderer.frames.at(-1)!.vehicles[0]!.instances;
    expect(instances[2]).toBeCloseTo(Math.PI / 2, 5);
    expect(instances[3]).toBeCloseTo(VEHICLE_HALF_LENGTH, 5);
    expect(instances[4]).toBeCloseTo(VEHICLE_HALF_WIDTH, 5);
    // Vehicle color stays at slots 5-8 and clip factors sit in trailing slots
    // 9-10, matching sprite rows. The route color is #e04f39 at full opacity.
    const routeColor = parseColor("#e04f39");
    expect(instances[5]).toBeCloseTo(routeColor[0]!, 7);
    expect(instances[6]).toBeCloseTo(routeColor[1]!, 7);
    expect(instances[7]).toBeCloseTo(routeColor[2]!, 7);
    expect(instances[8]).toBeCloseTo(1, 7);
    expect(instances[9]).toBeCloseTo(2 / 896, 9);
    expect(instances[10]).toBeCloseTo(-2 / 736, 9);

    // Sprite rows share the same one projection loop: the trailing clip
    // slots (offsets 12/13 of the 14-float stride) carry the same factors,
    // while the world origin slot stays in projected clip units.
    const sprites = fx.renderer.frames.at(-1)!.sprites!.instances;
    expect(sprites.length).toBeGreaterThan(0);
    for (
      let offset = 0;
      offset < sprites.length;
      offset += SPRITE_INSTANCE_FLOATS
    ) {
      expect(sprites[offset + 12]).toBeCloseTo(2 / 896, 9);
      expect(sprites[offset + 13]).toBeCloseTo(-2 / 736, 9);
      // Angle and extents pass through raw, like vehicle rows.
      expect(sprites[offset + 2]).toBeCloseTo(0, 9);
      expect(sprites[offset + 3]).toBeGreaterThan(0);
      expect(sprites[offset + 4]).toBeGreaterThan(0);
    }

    fx.host.stop();
  });

  it("re-tessellates scene/route ranges only when revision or emphasis changes", () => {
    const fx = createFixture({
      state: unpaused(stateWithVehicleForFrame()),
    });
    fx.host.start();
    fx.fireFrame(16);
    fx.fireFrame(33);

    // Frame-only tick: scene, sprite and route tessellation are cache hits —
    // the host caches per revision/emphasis, so content (and uploaded bytes)
    // stays identical while only vehicles move.
    const [first, second] = fx.renderer.frames.slice(-2);
    expect(second!.solids[0]!.vertices).toEqual(first!.solids[0]!.vertices);
    expect(second!.sprites!.instances).toEqual(first!.sprites!.instances);
    expect(second!.overSprites![1]!.vertices).toEqual(
      first!.overSprites![1]!.vertices,
    );

    // Emphasis change re-tessellates the committed-route range only.
    fx.setUi({ selectedRouteId: "route-001" });
    fx.fireFrame(50);
    const emphasized = fx.renderer.frames.at(-1)!;
    expect(emphasized.overSprites![1]!.vertices).not.toEqual(
      second!.overSprites![1]!.vertices,
    );
    expect(emphasized.solids[0]!.vertices).toEqual(second!.solids[0]!.vertices);
    expect(emphasized.sprites!.instances).toEqual(second!.sprites!.instances);

    // A structural update (map change + revision bump) re-tessellates the
    // scene range.
    fx.setSceneRevision(2);
    const previousState = fx.getState();
    fx.setState({
      ...previousState,
      map: {
        ...previousState.map,
        tiles: previousState.map.tiles.map((tile) =>
          tile.x === 0 && tile.y === 0
            ? { ...tile, kind: "road" as const }
            : tile,
        ),
      },
    });
    fx.fireFrame(66);
    const last = fx.renderer.frames.at(-1)!;
    expect(last.solids[0]!.vertices).not.toEqual(
      emphasized.solids[0]!.vertices,
    );

    fx.host.stop();
  });
});

describe("createGameHost grid mode scene caching", () => {
  const callsForState = (state: GameState): number =>
    vi.mocked(buildMapBatch).mock.calls.filter(([arg]) => arg === state).length;
  const callsForMap = (map: GameMap): number =>
    vi.mocked(buildMapBatch).mock.calls.filter(([arg]) => arg.map === map)
      .length;

  it("retessellates on tool or revision changes but not on ticks or pans", () => {
    const fx = createFixture({
      state: unpaused(createTestGameState()),
      ui: { activeTool: "road" },
      camera: { zoom: 2, center: { x: 14, y: 9 } },
    });
    vi.mocked(buildMapBatch).mockClear();
    const map = fx.getState().map;
    fx.host.start();
    fx.fireFrame(16);
    expect(callsForMap(map)).toBe(1);

    fx.setState({ ...fx.getState(), time: 100 });
    fx.fireFrame(33);
    fx.fireFrame(50);
    expect(callsForMap(map)).toBe(1);

    const beforePan = fx.renderer.frames.at(-1)!.solids[0]!.vertices;
    fx.callbacks.onCameraChange({ zoom: 2, center: { x: 16, y: 10 } });
    fx.fireFrame(66);
    const afterPan = fx.renderer.frames.at(-1)!.solids[0]!.vertices;
    expect(afterPan).not.toEqual(beforePan);
    fx.fireFrame(83);
    expect(callsForMap(map)).toBe(1);

    fx.setSceneRevision(2);
    fx.fireFrame(100);
    expect(callsForMap(map)).toBe(2);

    fx.setUi({ activeTool: "inspect" });
    fx.fireFrame(116);
    expect(callsForMap(map)).toBe(3);

    fx.setUi({ activeTool: "road" });
    fx.fireFrame(133);
    expect(callsForMap(map)).toBe(4);

    fx.host.stop();
  });

  it("arms the grid for building placement in both size bands", () => {
    const fx = createFixture({
      state: unpaused(createTestGameState()),
      ui: { activeTool: "inspect" },
    });
    const spy = vi.mocked(buildMapBatch);
    spy.mockClear();
    const state = fx.getState();
    const lastMode = () => spy.mock.calls.at(-1)?.[1];
    fx.host.start();
    fx.fireFrame(16);
    expect(callsForState(state)).toBe(1);
    expect(lastMode()).toBe("hidden");

    fx.setUi({ selectedBuilding: "smallHouse" });
    fx.fireFrame(33);
    expect(callsForState(state)).toBe(2);
    expect(lastMode()).toBe("normal");

    fx.setUi({ selectedBuilding: null });
    fx.fireFrame(50);
    expect(callsForState(state)).toBe(3);
    expect(lastMode()).toBe("hidden");

    fx.container.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 400,
          height: 400,
          left: 0,
          top: 0,
          right: 400,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    globalThis.window?.dispatchEvent(new Event("resize"));
    fx.fireFrame(66);
    expect(callsForState(state)).toBe(3);

    // Passive resize preserves the drawn tile size, so the grid band stays
    // put; a retained sub-fit camera (smaller drawn tiles) crosses to faint.
    fx.callbacks.onCameraChange({
      zoom: 0.5,
      center: { x: 14, y: 9 },
      retained: true,
    });
    fx.setUi({ selectedBuilding: "smallHouse" });
    fx.fireFrame(83);
    expect(callsForState(state)).toBe(4);
    expect(lastMode()).toBe("faint");

    fx.setUi({ selectedBuilding: null });
    fx.fireFrame(100);
    expect(callsForState(state)).toBe(5);
    expect(lastMode()).toBe("hidden");

    fx.host.stop();
  });

  it("retessellates once per grid-band crossing, not per camera publish", () => {
    const fx = createFixture({
      state: unpaused(createTestGameState()),
      ui: { activeTool: "road" },
    });
    vi.mocked(buildMapBatch).mockClear();
    const state = fx.getState();
    fx.host.start();
    fx.fireFrame(16);
    expect(callsForState(state)).toBe(1);

    fx.container.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 400,
          height: 400,
          left: 0,
          top: 0,
          right: 400,
          bottom: 400,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    globalThis.window?.dispatchEvent(new Event("resize"));
    // The passive rebase preserves the drawn tile size, so the resize alone
    // crosses no band and retessellates nothing.
    fx.fireFrame(33);
    expect(callsForState(state)).toBe(1);

    // A camera change that crosses the faint band retessellates exactly once.
    fx.callbacks.onCameraChange({ zoom: 1.2, center: { x: 14, y: 9 } });
    fx.fireFrame(50);
    expect(callsForState(state)).toBe(2);

    fx.host.stop();
  });
});

describe("createGameHost teardown destruction", () => {
  it("mount teardown detaches only; host destroy() is the terminal teardown", () => {
    const { cleanup, renderer, host } = createFixture();
    host.start();
    expect(renderer.destroy).not.toHaveBeenCalled();

    // Canvas unmount (New City / library screens) unconfigures the canvas
    // context without destroying GPU resources: the runtime owns the host and
    // remounts it afterwards.
    cleanup();
    expect(renderer.unconfigure).toHaveBeenCalledTimes(1);
    expect(renderer.destroy).not.toHaveBeenCalled();

    host.destroy();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroy() stops a canvas-less rAF loop and ignores subsequent start/mount", () => {
    const renderer = createFakeRenderer();
    const state = unpaused(createTestGameState());
    const host = createGameHostWithRenderer(
      {
        getState: () => state,
        getUi: () => createUiState(),
        getCamera: () => null,
        onCameraChange: () => {},
        getSceneRevision: () => 1,
        onTick: () => {},
        onTileClick: () => {},
        onHoverTile: () => {},
        onRouteDraftContextMenu: () => false,
        onDragStart: () => true,
        onDragCurrent: () => {},
        onDragCommit: () => {},
        onDragCancel: () => {},
        onFatalError: () => {},
      },
      renderer as unknown as GameplayRenderer,
    );

    host.start();
    expect(host.isRunning()).toBe(true);
    expect(rafCallbacks).toHaveLength(1);

    host.destroy();
    expect(host.isRunning()).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();

    // Post-destroy start/mount are terminal no-ops.
    host.start();
    expect(host.isRunning()).toBe(false);
    const container = document.createElement("div");
    const detach = host.mount(container);
    expect(renderer.configure).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    detach();
  });

  it("reuses projected static sprite instances while scene and camera are unchanged", () => {
    const fx = createFixture({
      state: unpaused(stateWithVehicleForFrame()),
    });
    fx.host.start();
    fx.fireFrame(16);
    const firstSprites = fx.renderer.frames.at(-1)!.sprites!.instances;

    fx.fireFrame(32);
    const secondSprites = fx.renderer.frames.at(-1)!.sprites!.instances;
    expect(secondSprites).toBe(firstSprites);

    // Camera change invalidates the cached projection.
    fx.callbacks.onCameraChange({ zoom: 1.5, center: { x: 14, y: 9 } });
    fx.fireFrame(48);
    const zoomedSprites = fx.renderer.frames.at(-1)!.sprites!.instances;
    expect(zoomedSprites).not.toBe(firstSprites);

    fx.host.stop();
  });

  it("internal remount to a different host detaches without destroying; destroy() destroys once", () => {
    const { host, renderer, container, cleanup } = createFixture();

    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    host.mount(secondHost);
    // Internal re-mount only detaches: the renderer keeps its GPU resources.
    expect(renderer.destroy).not.toHaveBeenCalled();

    // Mounting back is another internal re-mount, and every unmount cleanup
    // only detaches; the terminal teardown is the host-level destroy().
    const backCleanup = host.mount(container);
    expect(renderer.destroy).not.toHaveBeenCalled();
    backCleanup();
    cleanup();
    expect(renderer.destroy).not.toHaveBeenCalled();

    host.destroy();
    host.destroy();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it("production host teardown destroys the renderer and the device it created", async () => {
    // Narrow fake at the navigator.gpu seam: createGameHost requests the
    // device itself, so teardown must destroy the renderer's buffers, unconfigure
    // the context, and then destroy the device that host created.
    const harness = createFakeDevice();
    vi.stubGlobal("navigator", {
      gpu: {
        requestAdapter: async () => ({
          requestDevice: async () => harness.device,
        }),
        getPreferredCanvasFormat: () => "bgra8unorm",
      },
    });
    const fakeContext = {
      configure: () => {},
      unconfigure: () => {},
      getCurrentTexture: () => ({ createView: () => ({}) }),
    };
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(((type: string) =>
        type === "webgpu" ? fakeContext : null) as never);
    try {
      const host = await createGameHost({
        getState: () => createTestGameState(),
        getUi: () => createUiState(),
        getCamera: () => null,
        onCameraChange: () => {},
        getSceneRevision: () => 1,
        onTick: () => {},
        onTileClick: () => {},
        onHoverTile: () => {},
        onRouteDraftContextMenu: () => false,
        onDragStart: () => true,
        onDragCurrent: () => {},
        onDragCommit: () => {},
        onDragCancel: () => {},
        onFatalError: () => {},
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const cleanup = host.mount(container);
      // configure() created the quad buffer through the owned device.
      expect(harness.buffers.length).toBeGreaterThan(0);
      expect(harness.deviceDestroyed).toBe(false);
      // The factory uploaded the atlas into the renderer, which owns and
      // destroys it with its other GPU resources at the terminal destroy().
      const atlas = vi
        .mocked(createSpriteAtlasTexture)
        .mock.results.at(-1)!.value;
      expect(atlas.destroy).not.toHaveBeenCalled();

      // Unmount keeps the device alive for a later remount.
      cleanup();
      expect(harness.deviceDestroyed).toBe(false);
      expect(atlas.destroy).not.toHaveBeenCalled();

      host.destroy();

      expect(atlas.destroy).toHaveBeenCalledTimes(1);

      expect(harness.deviceDestroyed).toBe(true);
      expect(harness.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    } finally {
      getContextSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("createGameHost startup capability selection", () => {
  const noopContext: GameHostContext = {
    getState: () => createTestGameState(),
    getUi: () => createUiState(),
    getCamera: () => null,
    onCameraChange: () => {},
    getSceneRevision: () => 1,
    onTick: () => {},
    onTileClick: () => {},
    onHoverTile: () => {},
    onRouteDraftContextMenu: () => false,
    onDragStart: () => true,
    onDragCurrent: () => {},
    onDragCommit: () => {},
    onDragCancel: () => {},
    onFatalError: () => {},
  };

  // The getContext spy must not outlive its test: vi.clearAllMocks() clears
  // recorded calls but keeps mockImplementation, so a leaked spy would fake
  // later capability failures and break individual isolation (jsdom's real
  // getContext("2d") returns null).
  let contextSpy: MockInstance | undefined;
  beforeEach(() => {
    // Calls accumulate per mock across the file; each selection test asserts
    // on its own factory run only.
    vi.clearAllMocks();
    contextSpy = undefined;
  });
  afterEach(() => {
    contextSpy?.mockRestore();
    contextSpy = undefined;
    vi.unstubAllGlobals();
  });

  /** Fake GPUCanvasContext recording configure/getCurrentTexture/unconfigure order,
   *  with throw injection for each probe-failure mode. */
  function createFakeGpuContext(options?: {
    configureThrows?: Error;
    getCurrentTextureThrows?: Error;
    unconfigureThrows?: Error;
  }): {
    calls: string[];
    configure: Mock;
    getCurrentTexture: Mock;
    unconfigure: Mock;
  } {
    const calls: string[] = [];
    return {
      calls,
      configure: vi.fn((descriptor: GPUCanvasConfiguration) => {
        calls.push(`configure ${descriptor.alphaMode}`);
        if (options?.configureThrows) throw options.configureThrows;
      }),
      getCurrentTexture: vi.fn(() => {
        calls.push("getCurrentTexture");
        if (options?.getCurrentTextureThrows) {
          throw options.getCurrentTextureThrows;
        }
        return { createView: () => ({}) };
      }),
      unconfigure: vi.fn(() => {
        calls.push("unconfigure");
        if (options?.unconfigureThrows) throw options.unconfigureThrows;
      }),
    };
  }

  /** Stubs HTMLCanvasElement.getContext: "webgpu" resolves to `gpuContext`
   *  (null = the context request itself fails), "2d" always yields a usable
   *  minimal context so the Canvas2D fallback renderer can configure its
   *  mounted canvas (these tests never draw: rAF callbacks never fire).
   *  Returns every call's canvas + type in order. */
  function stubCanvasGetContext(
    gpuContext: unknown,
  ): Array<{ canvas: HTMLCanvasElement; type: string }> {
    const calls: Array<{ canvas: HTMLCanvasElement; type: string }> = [];
    contextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(function (this: HTMLCanvasElement, type: string) {
        calls.push({ canvas: this, type });
        if (type === "webgpu") return gpuContext;
        if (type === "2d") return { canvas: this };
        return null;
      } as never);
    return calls;
  }

  /** Full navigator.gpu stub around a fake-device harness, with per-step
   *  capability-failure injection. */
  function stubNavigatorGpu(
    harness: FakeHarness,
    options?: {
      adapter?: null | Error;
      deviceThrows?: Error;
      formatThrows?: Error;
    },
  ): {
    requestAdapter: Mock;
    requestDevice: Mock;
    getPreferredCanvasFormat: Mock;
  } {
    const requestDevice = vi.fn(async () => {
      if (options?.deviceThrows) throw options.deviceThrows;
      return harness.device;
    });
    const requestAdapter = vi.fn(async () => {
      if (options?.adapter instanceof Error) throw options.adapter;
      return options?.adapter === null ? null : { requestDevice };
    });
    const getPreferredCanvasFormat = vi.fn(() => {
      if (options?.formatThrows) throw options.formatThrows;
      return "bgra8unorm";
    });
    vi.stubGlobal("navigator", {
      gpu: { requestAdapter, requestDevice, getPreferredCanvasFormat },
    });
    return { requestAdapter, requestDevice, getPreferredCanvasFormat };
  }

  /** Runs the production factory and mounts its host; returns the mounted
   *  gameplay canvas plus teardown. */
  async function mountProductionHost(): Promise<{
    host: GameHost;
    canvas: HTMLCanvasElement;
    detach: () => void;
  }> {
    const host = await createGameHost(noopContext);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const detach = host.mount(container);
    const canvas = container.querySelector("canvas");
    if (canvas === null) throw new Error("host mounted no canvas");
    return { host, canvas, detach };
  }

  it("selects WebGPU, probing a disposable 16×16 canvas before mount", async () => {
    const harness = createFakeDevice();
    const gpuContext = createFakeGpuContext();
    const nav = stubNavigatorGpu(harness);
    const contextCalls = stubCanvasGetContext(gpuContext);

    const host = await createGameHost(noopContext);

    // The probe configured the acquired device on a disposable 16×16 canvas,
    // then unconfigured it, before any gameplay canvas existed.
    const webgpuCalls = contextCalls.filter((c) => c.type === "webgpu");
    expect(webgpuCalls.length).toBe(1);
    const probeCanvas = webgpuCalls[0]!.canvas;
    expect(probeCanvas.width).toBe(16);
    expect(probeCanvas.height).toBe(16);
    expect(gpuContext.calls).toEqual([
      "configure opaque",
      "getCurrentTexture",
      "unconfigure",
    ]);
    expect(harness.passes).toHaveLength(1);
    expect(gpuContext.configure).toHaveBeenCalledWith({
      device: harness.device,
      format: "bgra8unorm",
      alphaMode: "opaque",
    });

    // Atlas upload runs outside the capability boundary on the acquired
    // device with the decoded sprite images; the device stays alive.
    expect(vi.mocked(createSpriteAtlasTexture)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSpriteAtlasTexture)).toHaveBeenCalledWith(
      harness.device,
      [],
    );
    expect(harness.deviceDestroyed).toBe(false);

    // The mounted gameplay canvas records the chosen renderer, distinct from
    // the probe canvas.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const detach = host.mount(container);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas!.dataset.renderer).toBe("webgpu");
    expect(canvas!.dataset.runtimeCanvas).toBe("true");
    expect(contextCalls.filter((c) => c.type === "webgpu").length).toBe(2);

    // A City Library round trip remounts fresh canvases without ever
    // re-running capability selection.
    detach();
    const remountContainer = document.createElement("div");
    document.body.appendChild(remountContainer);
    host.mount(remountContainer);
    expect(remountContainer.querySelector("canvas")!.dataset.renderer).toBe(
      "webgpu",
    );
    expect(nav.requestAdapter).toHaveBeenCalledTimes(1);
    expect(gpuContext.configure).toHaveBeenCalledTimes(3); // probe + 2 mounts

    host.destroy();
    expect(harness.deviceDestroyed).toBe(true);
  });

  /** Stubs one failure mode and returns its boundary mocks so each test can
   *  prove the injected failure was actually reached at the API boundary it
   *  names — a fallback that happens earlier must not pass silently. */
  type FailureStubs = {
    nav?: ReturnType<typeof stubNavigatorGpu>;
    contextCalls?: ReturnType<typeof stubCanvasGetContext>;
    gpu?: ReturnType<typeof createFakeGpuContext>;
  };

  /** Every startup capability failure the fallback must absorb: the factory
   *  resolves with a Canvas2D host and never touches the GPU asset path. */
  const capabilityFailureCases: Array<{
    name: string;
    /** Whether the probe acquired the fake device before failing. */
    deviceAcquired: boolean;
    stub: (harness: FakeHarness) => FailureStubs;
    /** Asserts the failure was reached at its intended API boundary. */
    reached: (stubs: FailureStubs) => void;
  }> = [
    {
      name: "navigator.gpu is absent",
      deviceAcquired: false,
      stub: (_harness) => {
        const contextCalls = stubCanvasGetContext(createFakeGpuContext());
        vi.stubGlobal("navigator", {});
        return { contextCalls };
      },
      reached: ({ contextCalls }) => {
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(0);
      },
    },
    {
      name: "the adapter request returns null",
      deviceAcquired: false,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness, { adapter: null });
        return {
          nav,
          contextCalls: stubCanvasGetContext(createFakeGpuContext()),
        };
      },
      reached: ({ nav, contextCalls }) => {
        expect(nav!.requestAdapter).toHaveBeenCalledTimes(1);
        expect(nav!.requestDevice).not.toHaveBeenCalled();
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the adapter request rejects",
      deviceAcquired: false,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness, {
          adapter: new Error("adapter refused"),
        });
        return {
          nav,
          contextCalls: stubCanvasGetContext(createFakeGpuContext()),
        };
      },
      reached: ({ nav, contextCalls }) => {
        expect(nav!.requestAdapter).toHaveBeenCalledTimes(1);
        expect(nav!.requestDevice).not.toHaveBeenCalled();
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the device request rejects",
      deviceAcquired: false,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness, {
          deviceThrows: new Error("device refused"),
        });
        return {
          nav,
          contextCalls: stubCanvasGetContext(createFakeGpuContext()),
        };
      },
      reached: ({ nav, contextCalls }) => {
        expect(nav!.requestAdapter).toHaveBeenCalledTimes(1);
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(nav!.getPreferredCanvasFormat).not.toHaveBeenCalled();
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the probe canvas has no webgpu context",
      deviceAcquired: false,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness);
        const contextCalls = stubCanvasGetContext(null);
        return { nav, contextCalls };
      },
      reached: ({ nav, contextCalls }) => {
        // The probe asked exactly once for a webgpu context and never got
        // as far as an adapter request.
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
        expect(nav!.requestAdapter).not.toHaveBeenCalled();
      },
    },
    {
      name: "the preferred canvas format is unavailable",
      deviceAcquired: true,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness, {
          formatThrows: new Error("no preferred format"),
        });
        const gpu = createFakeGpuContext();
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(nav!.getPreferredCanvasFormat).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual([]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the probe context cannot configure",
      deviceAcquired: true,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext({
          configureThrows: new Error("swapchain setup failed"),
        });
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual(["configure opaque"]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the acquired device is already lost",
      deviceAcquired: true,
      stub: (harness) => {
        harness.resolveLost({ reason: "unknown", message: "already lost" });
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext();
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual([]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the probe context getCurrentTexture throws",
      deviceAcquired: true,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext({
          getCurrentTextureThrows: new Error("surface unavailable"),
        });
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual(["configure opaque", "getCurrentTexture"]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the probe clear pass fails validation",
      deviceAcquired: true,
      stub: (harness) => {
        harness.nextValidationError = { message: "invalid surface texture" };
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext();
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual(["configure opaque", "getCurrentTexture"]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the device is lost during the probe clear pass",
      deviceAcquired: true,
      stub: (harness) => {
        harness.onPopErrorScope = () => {
          harness.resolveLost({
            reason: "unknown",
            message: "lost on clear pass",
          });
        };
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext();
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual(["configure opaque", "getCurrentTexture"]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
    {
      name: "the probe context cannot unconfigure",
      deviceAcquired: true,
      stub: (harness) => {
        const nav = stubNavigatorGpu(harness);
        const gpu = createFakeGpuContext({
          unconfigureThrows: new Error("unconfigure failed"),
        });
        return {
          nav,
          gpu,
          contextCalls: stubCanvasGetContext(gpu),
        };
      },
      reached: ({ nav, gpu, contextCalls }) => {
        expect(nav!.requestDevice).toHaveBeenCalledTimes(1);
        expect(gpu!.calls).toEqual([
          "configure opaque",
          "getCurrentTexture",
          "unconfigure",
        ]);
        expect(navWebGpuContextCalls(contextCalls!)).toHaveLength(1);
      },
    },
  ];

  /** The probe canvas's single "webgpu" getContext call (never the mounted
   *  "2d" one), so boundary assertions can't be confused by fallback reads. */
  function navWebGpuContextCalls(
    contextCalls: NonNullable<FailureStubs["contextCalls"]>,
  ): FailureStubs["contextCalls"] {
    return contextCalls.filter((call) => call.type === "webgpu");
  }

  it.each(capabilityFailureCases)(
    "falls back to Canvas2D when $name",
    async ({ stub, reached }) => {
      const harness = createFakeDevice();
      const failureStubs = stub(harness);

      // Capability failure is a renderer choice, never a factory rejection.
      const { canvas, detach } = await mountProductionHost();
      reached(failureStubs);
      expect(canvas.dataset.renderer).toBe("canvas2d");
      expect(canvas.dataset.runtimeCanvas).toBe("true");
      detach();

      // The capability boundary ends before any GPU asset upload runs.
      expect(vi.mocked(createSpriteAtlasTexture)).not.toHaveBeenCalled();
    },
  );

  it.each(
    capabilityFailureCases.filter(
      (capabilityCase) => capabilityCase.deviceAcquired,
    ),
  )("destroys the acquired device when $name", async ({ stub }) => {
    const harness = createFakeDevice();
    stub(harness);

    // The probe acquired the device, then failed setup: the factory owns
    // the doomed device and must release it itself before falling back.
    await mountProductionHost();
    expect(harness.deviceDestroyed).toBe(true);
  });

  it("rejects when sprite assets fail to load, before acquiring any device", async () => {
    const harness = createFakeDevice();
    stubNavigatorGpu(harness);
    stubCanvasGetContext(createFakeGpuContext());
    vi.mocked(loadSpriteImages).mockRejectedValueOnce(
      new Error("sprite decode failed"),
    );

    // Asset decoding precedes capability probing and the fallback catch: a
    // bad shipped sprite stays fatal instead of silently selecting Canvas2D.
    await expect(createGameHost(noopContext)).rejects.toThrow(
      "sprite decode failed",
    );
    expect(harness.deviceDestroyed).toBe(false);
    expect(vi.mocked(createSpriteAtlasTexture)).not.toHaveBeenCalled();
  });

  it("destroys the acquired device and stays fatal when atlas upload fails", async () => {
    const harness = createFakeDevice();
    stubNavigatorGpu(harness);
    stubCanvasGetContext(createFakeGpuContext());
    vi.mocked(createSpriteAtlasTexture).mockImplementationOnce(() => {
      throw new Error("atlas decode failed");
    });

    // The factory rejects without a host, so the caller can never destroy
    // the device — the factory must release it itself. (The uploader's own
    // partial-texture cleanup is asserted in spriteAtlas tests.)
    await expect(createGameHost(noopContext)).rejects.toThrow(
      "atlas decode failed",
    );
    expect(harness.deviceDestroyed).toBe(true);
  });

  it("destroys the atlas texture and device when GPU pipeline creation fails", async () => {
    const harness = createFakeDevice();
    stubNavigatorGpu(harness);
    stubCanvasGetContext(createFakeGpuContext());
    const atlasTexture = { createView: () => ({}), destroy: vi.fn() };
    vi.mocked(createSpriteAtlasTexture).mockImplementationOnce(
      () => atlasTexture as unknown as GPUTexture,
    );
    // The real renderer builds pipelines on the fake device at construction;
    // fail the first one after the texture was already handed over.
    (
      harness.device as unknown as { createRenderPipeline: () => never }
    ).createRenderPipeline = () => {
      throw new Error("pipeline creation failed");
    };

    // A shader/pipeline bug is terminal — never a capability fallback — and
    // the factory releases the texture and device it no longer hands out.
    await expect(createGameHost(noopContext)).rejects.toThrow(
      "pipeline creation failed",
    );
    expect(atlasTexture.destroy).toHaveBeenCalledTimes(1);
    expect(harness.deviceDestroyed).toBe(true);
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
    capacity: 18,
    passengerCount: 0,
    itineraryIndex: 0,
    pathStepIndex: 0,
    stepProgress: 0,
    parkedPosition: null,
  };
  const dx = Math.sign(to.x - 2);
  const dy = Math.sign(to.y - 2);
  const heading = dx !== 0 ? ("east" as const) : ("south" as const);
  const steps: RoadPathStep[] = [];
  for (
    let index = 0;
    index <= Math.abs(to.x - 2) + Math.abs(to.y - 2);
    index += 1
  ) {
    const position = { x: 2 + dx * index, y: 2 + dy * index };
    steps.push({
      position,
      enteringHeading: heading,
      leavingHeading: heading,
      movement: "straight",
      geometry: {
        kind: "line",
        from: position,
        to: { x: position.x + dx, y: position.y + dy },
      },
      travelSeconds: 10,
    });
  }
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
                steps,
                totalTravelSeconds: 10 * steps.length,
              } as TransitPath,
              lastValidPath: null,
              estimatedSeconds: 10 * steps.length,
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
