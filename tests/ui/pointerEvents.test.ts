import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { samePoint, type GameMap, type Point } from "../../src/domain/types";
import type {
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import type { RuntimeController } from "../../src/runtime/types";
import { tileSize } from "../../src/render/canvas";
import { createTestGameState } from "../helpers/gameState";
import {
  createPresentationUpdate,
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

// jsdom ships no PointerEvent and no Pointer Capture API, and canvas.getContext
// returns null. The runtime guards all of those, but to exercise the real
// pointer -> commit wiring we stub them here so a genuine PointerEvent flows
// through mountCanvas's listeners.

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
}

let stubs: Stubbed;
let restore: (() => void) | null = null;
// Tracked so afterEach can tear down the mounted canvas even when a test's
// assertion throws before reaching inline cleanup.
let currentDetach: (() => void) | null = null;

beforeEach(() => {
  stubs = {
    getContext: HTMLCanvasElement.prototype.getContext,
    getBoundingClientRect: Element.prototype.getBoundingClientRect,
    setPointerCapture: Element.prototype.setPointerCapture,
    releasePointerCapture: Element.prototype.releasePointerCapture,
    hasPointerCapture: Element.prototype.hasPointerCapture,
    pointerEvent: globalThis.PointerEvent,
    devicePixelRatio: globalThis.devicePixelRatio,
  };

  const fakeCtx = {
    canvas: null as unknown as HTMLCanvasElement,
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
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

  const setCapture = vi.fn();
  const releaseCapture = vi.fn();
  Element.prototype.setPointerCapture = setCapture as never;
  Element.prototype.releasePointerCapture = releaseCapture as never;
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
  // Runs even when a test assertion threw, so a failing test cannot leak a
  // mounted runtime (event listeners/canvas) or DOM into the next one.
  currentDetach?.();
  currentDetach = null;
  restore?.();
  restore = null;
  document.body.innerHTML = "";
});

function updateTile(
  map: GameMap,
  point: Point,
  update: (tile: GameMap["tiles"][number]) => GameMap["tiles"][number],
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? update(tile) : tile,
    ),
  };
}

function applyIntent(
  snapshot: RustGameSnapshot,
  intent: GameIntent,
): RustGameSnapshot {
  if (intent.type !== "layRoadLine") {
    return snapshot;
  }
  return {
    ...snapshot,
    map: intent.points.reduce(
      (map, point) =>
        updateTile(map, point, (tile) => ({
          ...tile,
          kind: "road",
        })),
      snapshot.map,
    ),
  };
}

function backendSpy(): GameBackend {
  const initial = createTestGameState();
  let snapshot = createRustSnapshot({
    map: initial.map,
    budget: initial.budget,
  });

  return {
    ...previewBackendStubs(),
    async dispatch(intent) {
      snapshot = applyIntent(snapshot, intent);
      return {
        update: createPresentationUpdate(snapshot),
        applied: true,
        rejection: null,
      };
    },
    async tick() {
      return {
        update: createPresentationUpdate(snapshot, false),
        applied: false,
        rejection: null,
      };
    },
    async reset() {
      snapshot = createRustSnapshot({
        map: initial.map,
        budget: initial.budget,
      });
      return { ok: true, update: createPresentationUpdate(snapshot) };
    },
  };
}

async function flushRuntime(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Mount the runtime canvas against the real board size and return it. */
async function mount() {
  const runtime = await createGameRuntime({
    hoverPreviewDebounceMs: 0,
    backend: backendSpy(),
  });
  const map = runtime.getSnapshot().state.map;
  const boardWidth = map.width * tileSize;
  const boardHeight = map.height * tileSize;

  // Map client coords 1:1 onto tiles: clientX = tileX * tileSize + half.
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

  const host = document.createElement("div");
  host.style.width = `${boardWidth}px`;
  host.style.height = `${boardHeight}px`;
  document.body.appendChild(host);

  const detach = runtime.mountCanvas(host);
  currentDetach = detach;
  const canvas = host.querySelector("canvas") as HTMLCanvasElement;

  return { runtime, canvas, detach };
}

const center = (tile: { x: number; y: number }) => ({
  clientX: tile.x * tileSize + tileSize / 2,
  clientY: tile.y * tileSize + tileSize / 2,
});

function dispatch(canvas: HTMLCanvasElement, type: string, init: object) {
  canvas.dispatchEvent(new FakePointerEvent(type, init));
}

function tileKind(runtime: RuntimeController, x: number, y: number) {
  return runtime
    .getSnapshot()
    .state.map.tiles.find((t) => t.x === x && t.y === y)?.kind;
}

describe("runtime canvas pointer wiring", () => {
  it("builds a road line from a real pointerdown -> move -> pointerup", async () => {
    const { runtime, canvas } = await mount();
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");

    dispatch(canvas, "pointerdown", center({ x: 1, y: 0 }));
    dispatch(canvas, "pointermove", center({ x: 3, y: 0 }));
    dispatch(canvas, "pointerup", center({ x: 4, y: 0 }));
    await flushRuntime();

    // The release tile snaps the final hover, so the line covers 1..4 (not 1..3).
    for (const x of [1, 2, 3, 4]) {
      expect(tileKind(runtime, x, 0)).toBe("road");
    }
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("requests pointer capture on drag start so an edge release still commits", async () => {
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const { runtime, canvas } = await mount();
    runtime.setTool("road");

    dispatch(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 7,
    });

    expect(setCapture.mock.calls).toContainEqual([7]);
    // And is released on commit.
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    dispatch(canvas, "pointerup", { ...center({ x: 3, y: 0 }), pointerId: 7 });
    await flushRuntime();
    expect(releaseCapture.mock.calls).toContainEqual([7]);
  });

  it("does not capture the pointer when startDrag is a no-op", async () => {
    // Guards the conditional-capture branch in handlePointerDown: a regression
    // to unconditional setPointerCapture would capture a pointer with no drag
    // to commit, leaking capture state across tool switches. The trigger is
    // `setTool("area")` without `setArea`, which leaves selectedArea null so
    // startDrag returns the unchanged state (drag stays null).
    const setCapture = Element.prototype.setPointerCapture as unknown as {
      mock: { calls: number[][] };
    };
    const { runtime, canvas } = await mount();
    runtime.setTool("area");

    expect(runtime.getSnapshot().ui.selectedArea).toBeNull();

    dispatch(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 9,
    });

    expect(setCapture.mock.calls).not.toContainEqual([9]);
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("ignores a non-primary (right) button press so no drag starts", async () => {
    const { runtime, canvas } = await mount();
    runtime.setTool("road");

    dispatch(canvas, "pointerdown", { ...center({ x: 1, y: 0 }), button: 2 });
    dispatch(canvas, "pointerup", center({ x: 3, y: 0 }));

    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(tileKind(runtime, 1, 0)).toBe("empty");
    expect(tileKind(runtime, 3, 0)).toBe("empty");
  });

  it("does not commit on a non-primary button release mid-drag", async () => {
    const { runtime, canvas } = await mount();
    runtime.setTool("road");

    dispatch(canvas, "pointerdown", center({ x: 1, y: 0 }));
    dispatch(canvas, "pointermove", center({ x: 3, y: 0 }));
    // A stray right-button release must not place the road early.
    dispatch(canvas, "pointerup", { ...center({ x: 3, y: 0 }), button: 2 });

    expect(runtime.getSnapshot().ui.drag).not.toBeNull();
    expect(tileKind(runtime, 1, 0)).toBe("empty");

    // The primary release then commits normally.
    dispatch(canvas, "pointerup", center({ x: 3, y: 0 }));
    await flushRuntime();
    expect(tileKind(runtime, 1, 0)).toBe("road");
  });

  it("tears the drag down on pointercancel and releases capture", async () => {
    const releaseCapture = Element.prototype
      .releasePointerCapture as unknown as { mock: { calls: number[][] } };
    const { runtime, canvas } = await mount();
    runtime.setTool("road");

    dispatch(canvas, "pointerdown", {
      ...center({ x: 1, y: 0 }),
      pointerId: 5,
    });
    dispatch(canvas, "pointermove", center({ x: 3, y: 0 }));
    dispatch(canvas, "pointercancel", {
      ...center({ x: 3, y: 0 }),
      pointerId: 5,
    });

    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(tileKind(runtime, 1, 0)).toBe("empty");
    expect(releaseCapture.mock.calls).toContainEqual([5]);
  });

  it("cancels an in-flight drag and clears hover on pointerleave", async () => {
    const { runtime, canvas } = await mount();
    runtime.setTool("road");

    dispatch(canvas, "pointerdown", center({ x: 1, y: 0 }));
    dispatch(canvas, "pointermove", center({ x: 3, y: 0 }));

    expect(runtime.getSnapshot().ui.drag).not.toBeNull();

    dispatch(canvas, "pointerleave", center({ x: 5, y: 0 }));

    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(runtime.getSnapshot().ui.hoverTile).toBeNull();
    expect(tileKind(runtime, 1, 0)).toBe("empty");
  });

  it("clears the hover tile on pointerleave when no drag is active", async () => {
    const { runtime, canvas } = await mount();
    runtime.setTool("inspect");

    dispatch(canvas, "pointermove", center({ x: 5, y: 5 }));

    expect(runtime.getSnapshot().ui.hoverTile).toEqual({ x: 5, y: 5 });

    dispatch(canvas, "pointerleave", center({ x: 10, y: 10 }));

    expect(runtime.getSnapshot().ui.hoverTile).toBeNull();
  });
});
