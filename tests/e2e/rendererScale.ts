import type { GameState } from "../../src/domain/types";
import {
  createGameHostWithRenderer,
  type GameHost,
  type GameHostContext,
} from "../../src/runtime/createGameHost";
import { createCanvas2dRenderer } from "../../src/render/canvas2d/renderer";
import { createWebGpuRenderer } from "../../src/render/webgpu/renderer";
import {
  VEHICLE_INSTANCE_FLOATS,
  type GameplayRenderer,
  type RenderFrame,
  type RenderStats,
} from "../../src/render/gameplayRenderer";
import {
  createSpriteAtlasTexture,
  loadSpriteImages,
} from "../../src/render/webgpu/spriteAtlas";
import { createUiState } from "../../src/ui/uiState";
import {
  buildRenderScaleState,
  type RenderScaleMapSize,
} from "../helpers/renderScaleState";

const WARMUP_FRAMES = 30;

export type BenchRenderer = "webgpu" | "canvas2d";

export interface BenchRunConfig {
  renderer: BenchRenderer;
  mapSize: RenderScaleMapSize;
  vehicleCount: 200 | 5000;
}

export interface RendererScaleResult {
  renderer: BenchRenderer;
  mapSize: RenderScaleMapSize;
  vehicleCount: number;
  frames: number;
  presentedVehicles: number;
  encodedInstances: number;
  /** GPU bytes of the vehicle instance upload; always 0 for Canvas2D. */
  vehicleUploadBytes: number;
  solidDraws: number;
  spriteInstances: number;
  spriteDraws: number;
  vehicleDraws: number;
  medianCpuMs: number;
  p95CpuMs: number;
  /** The GPU queue finished all submitted benchmark frames without error;
   *  always false for Canvas2D — there is no GPU queue to wait on. */
  queueCompleted: boolean;
}

declare global {
  interface Window {
    __caelumRendererScale: {
      run: (
        config: BenchRunConfig,
        frames?: number,
      ) => Promise<RendererScaleResult>;
    };
  }
}

const host = document.querySelector<HTMLDivElement>("#bench-host");
if (host === null) {
  throw new Error("renderer scale benchmark host is unavailable");
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(fraction * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Production render path: the real shared host (rAF frame drawing, batch
// caches, vehicle interpolation/encode) over the real renderer chosen per
// run, driven one render() per delivered frame. No runtime/backend
// orchestration — the benchmark measures render cost, not app boot. Both
// renderers get the real sprite atlas: the host's frames always carry scene
// sprites, so a two-argument renderer would throw on every frame. Each
// renderer is wrapped only to record the last frame's stats.
let state: GameState | null = null;
let stateMapSize: RenderScaleMapSize = "small";
let sceneRevision = 0;
const ui = createUiState();

// The WebGPU rows still require a working adapter/device; the Canvas2D row
// needs only the decoded sprite images.
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
const renderers: Record<BenchRenderer, GameplayRenderer> = {
  webgpu: createWebGpuRenderer(device, format, spriteTexture),
  canvas2d: createCanvas2dRenderer(spriteImages),
};
const benchDevices: Record<BenchRenderer, GPUDevice | null> = {
  webgpu: device,
  canvas2d: null,
};

let lastStats: RenderStats = {
  solidBatches: 0,
  solidVertices: 0,
  spriteInstances: 0,
  spriteDraws: 0,
  vehicleInstances: 0,
  vehicleDraws: 0,
};
const recordingOf = (renderer: GameplayRenderer): GameplayRenderer => ({
  ...renderer,
  render: (frame: RenderFrame) => {
    lastStats = renderer.render(frame);
    return lastStats;
  },
});

const benchContext: GameHostContext = {
  getState: () => {
    if (state === null) throw new Error("benchmark state is unavailable");
    return state;
  },
  getUi: () => ui,
  getCamera: () => null,
  onCameraChange: () => {},
  getSceneRevision: () => sceneRevision,
  onTick: () => {},
  onTileClick: () => {},
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

/** One mounted rig per renderer kind: mount() replaces the canvas inside the
 *  bench host element, so switching renderers swaps the whole surface. */
interface Rig {
  gameHost: GameHost;
  device: GPUDevice | null;
  unmount: (() => void) | null;
}
const rigs = new Map<BenchRenderer, Rig>();
function rigFor(rendererKind: BenchRenderer): Rig {
  let rig = rigs.get(rendererKind);
  if (rig === undefined) {
    rig = {
      gameHost: createGameHostWithRenderer(
        benchContext,
        recordingOf(renderers[rendererKind]),
        benchDevices[rendererKind] ?? undefined,
      ),
      device: benchDevices[rendererKind],
      unmount: null,
    };
    rigs.set(rendererKind, rig);
  }
  return rig;
}
let activeKind: BenchRenderer = "webgpu";
let activeRig = rigFor("webgpu");

// GameHost.render() coalesces by design — it schedules one rAF and returns,
// so back-to-back calls in one task time only the coalescing guard, never a
// frame. Wrap rAF to stamp each delivered host callback's CPU cost
// (drawFrame: batch build + encode + submit) and drive every sample through
// one real frame: render() then await the next delivered frame.
const realRequestAnimationFrame = window.requestAnimationFrame.bind(window);
let lastFrameCpuMs = 0;
window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
  realRequestAnimationFrame((timestamp) => {
    const start = performance.now();
    callback(timestamp);
    lastFrameCpuMs = performance.now() - start;
  });
const nextDeliveredFrame = (): Promise<void> =>
  new Promise((resolve) => {
    realRequestAnimationFrame(() => resolve());
  });

// Mount reads getState().map while sizing the canvas, so the fixture must
// exist before the first mount (and every renderer switch remount).
state = buildRenderScaleState(200);
sceneRevision = 1;
activeRig.unmount = activeRig.gameHost.mount(host);

window.__caelumRendererScale = {
  async run(
    config: BenchRunConfig,
    frames = 120,
  ): Promise<RendererScaleResult> {
    if (config.renderer !== activeKind) {
      activeRig.unmount?.();
      activeRig = rigFor(config.renderer);
      activeRig.unmount = activeRig.gameHost.mount(host);
      activeKind = config.renderer;
    }
    if (
      state === null ||
      stateMapSize !== config.mapSize ||
      state.transit.vehicles.length !== config.vehicleCount
    ) {
      state = buildRenderScaleState(config.vehicleCount, {
        mapSize: config.mapSize,
      });
      stateMapSize = config.mapSize;
      sceneRevision += 1;
    }
    for (let index = 0; index < WARMUP_FRAMES; index += 1) {
      activeRig.gameHost.render();
      await nextDeliveredFrame();
    }
    const samples: number[] = [];
    for (let index = 0; index < frames; index += 1) {
      activeRig.gameHost.render();
      await nextDeliveredFrame();
      samples.push(lastFrameCpuMs);
    }
    // GPU-only wait, guarded by device presence: Canvas2D has no queue and
    // never claims queue completion or GPU upload bytes.
    if (activeRig.device !== null) {
      await activeRig.device.queue.onSubmittedWorkDone();
    }
    return {
      renderer: config.renderer,
      mapSize: config.mapSize,
      vehicleCount: config.vehicleCount,
      frames,
      presentedVehicles: state.transit.vehicles.length,
      encodedInstances: lastStats.vehicleInstances,
      vehicleUploadBytes:
        activeRig.device !== null
          ? lastStats.vehicleInstances * VEHICLE_INSTANCE_FLOATS * 4
          : 0,
      solidDraws: lastStats.solidBatches,
      spriteInstances: lastStats.spriteInstances,
      spriteDraws: lastStats.spriteDraws,
      vehicleDraws: lastStats.vehicleDraws,
      medianCpuMs: median(samples),
      p95CpuMs: percentile(samples, 0.95),
      queueCompleted: activeRig.device !== null,
    };
  },
};
