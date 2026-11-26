import type {
  GameState,
  Point,
  RoadPathStep,
  Route,
  RouteLegPath,
  TransitPath,
  Vehicle,
} from "../../src/domain/types";
import { getBoardTransform } from "../../src/render/boardTransform";
import { createCanvas2dRenderer } from "../../src/render/canvas2d/renderer";
import {
  VEHICLE_INSTANCE_FLOATS,
  type CapturedFrame,
  type GameplayRenderer,
  type RenderFrame,
} from "../../src/render/gameplayRenderer";
import { createWebGpuRenderer } from "../../src/render/webgpu/renderer";
import {
  createSpriteAtlasTexture,
  loadSpriteImages,
} from "../../src/render/webgpu/spriteAtlas";
import {
  createGameHostWithRenderer,
  type GameHost,
  type GameHostContext,
} from "../../src/runtime/createGameHost";
import type { MapPick } from "../../src/ui/mapPick";
import { createUiState } from "../../src/ui/uiState";
import { createTestGameState } from "../helpers/gameState";

export type AlignmentRenderer = "webgpu" | "canvas2d";
export type AlignmentMotion = "paused" | "moving";

export interface AlignmentProbeRequest {
  renderer: AlignmentRenderer;
  motion: AlignmentMotion;
}

export interface AlignmentVehicleResult {
  id: string;
  expectedWorld: Point;
  angle: number;
  expectedDevice: Point;
  measuredDevice: Point | null;
  deltaDevicePx: number | null;
  rimPixels: number;
  pickedId: string | null;
}

export interface AlignmentProbeResult {
  renderer: AlignmentRenderer;
  motion: AlignmentMotion;
  vehicles: AlignmentVehicleResult[];
  routeOverChevronRgb: [number, number, number];
}

declare global {
  interface Window {
    __caelumVehicleAlignment: {
      probe: (request: AlignmentProbeRequest) => Promise<AlignmentProbeResult>;
    };
  }
}

const alignmentHostElement =
  document.querySelector<HTMLDivElement>("#alignment-host");
if (alignmentHostElement === null) {
  throw new Error("vehicle alignment host is unavailable");
}
const hostElement: HTMLDivElement = alignmentHostElement;

function lineStep(
  from: Point,
  to: Point,
  heading: "east" | "west",
): RoadPathStep {
  return {
    position: from,
    enteringHeading: heading,
    leavingHeading: heading,
    movement: "straight",
    geometry: { kind: "line", from, to },
    travelSeconds: 4,
  };
}

function turnStep(): RoadPathStep {
  return {
    position: { x: 22, y: 2 },
    enteringHeading: "east",
    leavingHeading: "south",
    movement: "rightTurn",
    geometry: {
      kind: "quadraticBezier",
      from: { x: 22, y: 2 },
      control: { x: 24, y: 2 },
      to: { x: 24, y: 4 },
    },
    travelSeconds: 4,
  };
}

function legWithSteps(steps: RoadPathStep[]): RouteLegPath[] {
  const totalTravelSeconds = steps.reduce(
    (total, step) => total + step.travelSeconds,
    0,
  );
  return [
    {
      fromWaypointId: "stop-a",
      toWaypointId: "stop-b",
      direction: "loop",
      kind: "service",
      status: "connected",
      currentPath: {
        kind: "road",
        steps,
        totalTravelSeconds,
      } as TransitPath,
      lastValidPath: null,
      estimatedSeconds: totalTravelSeconds,
      failureReason: null,
    },
  ];
}

function route(
  id: string,
  color: string,
  legs: RouteLegPath[],
  vehicleIds: string[],
): Route {
  return {
    id,
    name: id,
    color,
    stopIds: ["stop-a", "stop-b"],
    vehicleIds,
    active: true,
    pattern: "loop",
    revision: 1,
    legs,
    pathBroken: false,
    targetHeadwaySeconds: null,
    serviceMetrics: null,
  };
}

function bus(id: string, lineId: string, stepProgress: number): Vehicle {
  return {
    id,
    mode: "bus",
    lineId,
    capacity: 18,
    passengerCount: 0,
    itineraryIndex: 0,
    pathStepIndex: 0,
    stepProgress,
    parkedPosition: null,
  };
}

const SHARED_STEP = lineStep({ x: 1, y: 2 }, { x: 7, y: 2 }, "east");
const DUAL_EAST_STEP = lineStep({ x: 12, y: 8 }, { x: 20, y: 8 }, "east");
const DUAL_WEST_STEP = lineStep({ x: 20, y: 9 }, { x: 12, y: 9 }, "west");
const TURN_STEP = turnStep();

const VEHICLE_BASE_PROGRESS = new Map([
  ["vehicle-shared-a", 0.18],
  ["vehicle-shared-b", 0.68],
  ["vehicle-dual-east", 0.5],
  ["vehicle-dual-west", 0.5],
  ["vehicle-turn", 0.25],
]);

function alignmentState(paused: boolean, progressOffset: number): GameState {
  const base = createTestGameState();
  const sharedLegs = legWithSteps([SHARED_STEP]);
  const routes = [
    route("route-shared-a", "#e04f39", sharedLegs, ["vehicle-shared-a"]),
    route("route-shared-b", "#2f9e44", sharedLegs, ["vehicle-shared-b"]),
    route("route-dual-east", "#d98600", legWithSteps([DUAL_EAST_STEP]), [
      "vehicle-dual-east",
    ]),
    route("route-dual-west", "#7c55c8", legWithSteps([DUAL_WEST_STEP]), [
      "vehicle-dual-west",
    ]),
    route("route-turn", "#008ca8", legWithSteps([TURN_STEP]), ["vehicle-turn"]),
  ];
  const vehicles = routes.map((line) => {
    const id = line.vehicleIds[0]!;
    const progress = Math.min(
      0.92,
      (VEHICLE_BASE_PROGRESS.get(id) ?? 0.5) + progressOffset,
    );
    return bus(id, line.id, progress);
  });
  const roadKeys = new Map<string, "east" | "west" | undefined>();
  for (let x = 1; x <= 7; x += 1) roadKeys.set(`${x},2`, undefined);
  for (let x = 12; x <= 20; x += 1) roadKeys.set(`${x},8`, "east");
  for (let x = 12; x <= 20; x += 1) roadKeys.set(`${x},9`, "west");
  return {
    ...base,
    paused,
    speed: 1,
    map: {
      ...base.map,
      tiles: base.map.tiles.map((tile) => {
        const key = `${tile.x},${tile.y}`;
        return roadKeys.has(key)
          ? {
              ...tile,
              kind: "road" as const,
              roadConnections: [],
              oneWay: roadKeys.get(key),
            }
          : tile;
      }),
    },
    transit: {
      ...base.transit,
      stops: [
        {
          id: "stop-a",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 1, y: 1 },
          platforms: [],
        },
        {
          id: "stop-b",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 7, y: 1 },
          platforms: [],
        },
      ],
      routes,
      metroLines: [],
      vehicles,
    },
  };
}

interface Rig {
  gameHost: GameHost;
  renderer: GameplayRenderer;
  unmount: (() => void) | null;
  inputFrame: RenderFrame | null;
}

if (navigator.gpu === undefined) {
  throw new Error("WebGPU is unavailable in this browser");
}
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) {
  throw new Error("WebGPU adapter unavailable");
}
const device = await adapter.requestDevice();
const format = navigator.gpu.getPreferredCanvasFormat();
const spriteImages = await loadSpriteImages();
const spriteTexture = createSpriteAtlasTexture(device, spriteImages);

let state = alignmentState(true, 0);
let sceneRevision = 0;
const ui = createUiState();
let lastPick: MapPick | null | undefined = null;
const readLastPick = (): MapPick | null | undefined => lastPick;

const hostContext: GameHostContext = {
  getState: () => state,
  getUi: () => ui,
  getCamera: () => null,
  onCameraChange: () => {},
  getSceneRevision: () => sceneRevision,
  onTick: () => {},
  onTileClick: (_point, pick) => {
    lastPick = pick;
  },
  onHoverTile: () => {},
  onRouteDraftContextMenu: () => false,
  onDragStart: () => false,
  onDragCurrent: () => {},
  onDragCommit: () => {},
  onDragCancel: () => {},
  onFatalError: (error) => {
    throw error;
  },
};

function recordingRenderer(renderer: GameplayRenderer): {
  renderer: GameplayRenderer;
  rigState: { inputFrame: RenderFrame | null };
} {
  const rigState: { inputFrame: RenderFrame | null } = { inputFrame: null };
  return {
    rigState,
    renderer: {
      ...renderer,
      captureFrame: (frame: RenderFrame) => {
        rigState.inputFrame = frame;
        return renderer.captureFrame(frame);
      },
    },
  };
}

const rigs = new Map<AlignmentRenderer, Rig>();
function rigFor(kind: AlignmentRenderer): Rig {
  const existing = rigs.get(kind);
  if (existing !== undefined) return existing;
  const backing =
    kind === "webgpu"
      ? createWebGpuRenderer(device, format, spriteTexture)
      : createCanvas2dRenderer(spriteImages);
  const recording = recordingRenderer(backing);
  const rig: Rig = {
    gameHost: createGameHostWithRenderer(
      hostContext,
      recording.renderer,
      kind === "webgpu" ? device : undefined,
    ),
    renderer: recording.renderer,
    unmount: null,
    inputFrame: null,
  };
  Object.defineProperty(rig, "inputFrame", {
    get: () => recording.rigState.inputFrame,
    set: (value: RenderFrame | null) => {
      recording.rigState.inputFrame = value;
    },
  });
  rigs.set(kind, rig);
  return rig;
}

let activeKind: AlignmentRenderer | null = null;
let activeRig: Rig | null = null;
function activate(kind: AlignmentRenderer): Rig {
  const rig = rigFor(kind);
  if (activeKind !== kind) {
    activeRig?.unmount?.();
    rig.unmount = rig.gameHost.mount(hostElement);
    activeKind = kind;
    activeRig = rig;
  }
  return rig;
}

const realRaf = window.requestAnimationFrame.bind(window);
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => realRaf(() => resolve()));

/** Deterministic host time for capture/pick agreement. Host repaints use the
 * rAF timestamp while captures use performance.now(), so both clocks are
 * frozen together for the duration of one probe. */
function installControlledClock(): {
  advance: (ms: number) => void;
  flushAnimationFrame: () => void;
  restore: () => void;
} {
  const originalNow = performance.now;
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  let now = originalNow.call(performance);
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => now,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback): number => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number): void => {
      callbacks.delete(id);
    },
  });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    flushAnimationFrame: () => {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of pending) callback(now);
    },
    restore: () => {
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: originalNow,
      });
      Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: originalRaf,
      });
      Object.defineProperty(window, "cancelAnimationFrame", {
        configurable: true,
        value: originalCancel,
      });
    },
  };
}

function vehicleRows(frame: RenderFrame): number[][] {
  const rows: number[][] = [];
  for (const batch of frame.vehicles) {
    for (
      let offset = 0;
      offset < batch.instances.length;
      offset += VEHICLE_INSTANCE_FLOATS
    ) {
      rows.push(
        Array.from(
          batch.instances.slice(offset, offset + VEHICLE_INSTANCE_FLOATS),
        ),
      );
    }
  }
  return rows;
}

function measureRimCenter(
  shot: CapturedFrame,
  center: Point,
  radius: number,
): { point: Point; count: number } | null {
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(shot.width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(shot.height - 1, Math.ceil(center.y + radius));
  let count = 0;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const index = (y * shot.width + x) * 4;
      const red = shot.pixels[index]!;
      const green = shot.pixels[index + 1]!;
      const blue = shot.pixels[index + 2]!;
      const alpha = shot.pixels[index + 3]!;
      if (red > 248 && green > 248 && blue > 248 && alpha > 240) {
        count += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (count < 4) return null;
  return {
    point: {
      x: (left + right + 1) / 2,
      y: (top + bottom + 1) / 2,
    },
    count,
  };
}

async function probe(
  request: AlignmentProbeRequest,
): Promise<AlignmentProbeResult> {
  const rig = activate(request.renderer);
  // Let the mount-time real rAF settle before replacing the page clock.
  await nextFrame();
  const clock = installControlledClock();
  let shot: CapturedFrame | null = null;
  try {
    sceneRevision += 1;
    const moving = request.motion === "moving";
    state = alignmentState(!moving, moving ? 0 : 0.1);
    rig.gameHost.render();
    clock.flushAnimationFrame();
    if (moving) {
      clock.advance(100);
      state = alignmentState(false, 0.1);
      rig.gameHost.render();
      clock.flushAnimationFrame();
      // Halfway through the observed interval: the host interpolates rather
      // than snapping, while the captured frame itself carries the exact
      // presented instance rows used below.
      clock.advance(50);
    }

    rig.inputFrame = null;
    shot = await rig.gameHost.captureFrame();
    // Repaint at the same frozen timestamp. WebGPU picks are recorded by the
    // repaint path, so this makes the click targets the exact frame just
    // captured; Canvas2D capture already records the same targets itself.
    rig.gameHost.render();
    clock.flushAnimationFrame();
  } finally {
    clock.restore();
  }
  const frame = rig.inputFrame;
  if (shot === null || frame === null) {
    throw new Error(`${request.renderer} capture produced no frame`);
  }
  if (request.renderer === "webgpu") {
    await device.queue.onSubmittedWorkDone();
  }

  const rect = hostElement.getBoundingClientRect();
  const board = getBoardTransform(
    { width: rect.width, height: rect.height },
    state.map,
    null,
  );
  const dpr = shot.width / rect.width;
  const pixelWidth = shot.width;
  const pixelHeight = shot.height;
  const clipOx = (2 * board.offsetX * dpr) / pixelWidth - 1;
  const clipOy = 1 - (2 * board.offsetY * dpr) / pixelHeight;
  // Tile (14,8) contains an eastbound road chevron and a route stroke;
  // the nearest vehicle is more than a tile away.
  const probeX = Math.floor((board.offsetX + 14.5 * 32 * board.scale) * dpr);
  const probeY = Math.floor((board.offsetY + 8.5 * 32 * board.scale) * dpr);
  const probeOffset = (probeY * shot.width + probeX) * 4;
  const routeOverChevronRgb: [number, number, number] = [
    shot.pixels[probeOffset]!,
    shot.pixels[probeOffset + 1]!,
    shot.pixels[probeOffset + 2]!,
  ];
  const rows = vehicleRows(frame);
  const vehicles = state.transit.vehicles;
  if (rows.length !== vehicles.length) {
    throw new Error(
      `expected ${vehicles.length} captured vehicles, got ${rows.length}`,
    );
  }

  const results: AlignmentVehicleResult[] = rows.map((row, index) => {
    const vehicle = vehicles[index]!;
    const clipX = row[0]!;
    const clipY = row[1]!;
    const clipSx = row[9]!;
    const clipSy = row[10]!;
    const world = {
      x: (clipX - clipOx) / clipSx,
      y: (clipY - clipOy) / clipSy,
    };
    const device = {
      x: (board.offsetX + world.x * board.scale) * dpr,
      y: (board.offsetY + world.y * board.scale) * dpr,
    };
    // Vehicle half-diagonal (~10.3 world px) plus raster slack, expressed in
    // capture pixels. The scenarios are spaced so no two rim boxes overlap.
    const radius = Math.ceil(13 * board.scale * dpr);
    const measured = measureRimCenter(shot, device, radius);
    const measuredPoint = measured?.point ?? null;
    return {
      id: vehicle.id,
      expectedWorld: world,
      angle: row[2]!,
      expectedDevice: device,
      measuredDevice: measuredPoint,
      deltaDevicePx:
        measuredPoint === null
          ? null
          : Math.hypot(measuredPoint.x - device.x, measuredPoint.y - device.y),
      rimPixels: measured?.count ?? 0,
      pickedId: null,
    };
  });

  const canvas = hostElement.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("alignment host canvas is unavailable");
  }
  const canvasRect = canvas.getBoundingClientRect();
  for (const result of results) {
    lastPick = null;
    const clientX =
      canvasRect.left + board.offsetX + result.expectedWorld.x * board.scale;
    const clientY =
      canvasRect.top + board.offsetY + result.expectedWorld.y * board.scale;
    canvas.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX,
        clientY,
        button: 0,
      }),
    );
    result.pickedId = readLastPick()?.vehicleId ?? null;
  }

  return {
    renderer: request.renderer,
    motion: request.motion,
    vehicles: results,
    routeOverChevronRgb,
  };
}

window.__caelumVehicleAlignment = { probe };
