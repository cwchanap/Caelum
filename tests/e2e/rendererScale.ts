import type { GameState } from "../../src/domain/types";
import {
  createWebGpuHostWithRenderer,
  type WebGpuHostContext,
} from "../../src/runtime/createWebGpuHost";
import {
  createWebGpuRenderer,
  VEHICLE_INSTANCE_FLOATS,
  type WebGpuRenderFrame,
  type WebGpuRenderStats,
  type WebGpuRenderer,
} from "../../src/render/webgpu/renderer";
import { createUiState } from "../../src/ui/uiState";
import { buildRenderScaleState } from "../helpers/renderScaleState";

const WARMUP_FRAMES = 30;

export interface RendererScaleResult {
  vehicleCount: number;
  frames: number;
  presentedVehicles: number;
  encodedInstances: number;
  vehicleUploadBytes: number;
  solidDraws: number;
  vehicleDraws: number;
  medianCpuMs: number;
  p95CpuMs: number;
  /** The GPU queue finished all submitted benchmark frames without error. */
  queueCompleted: boolean;
}

declare global {
  interface Window {
    __caelumRendererScale: {
      run: (
        vehicleCount: 200 | 5000,
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

// Production render path: the real WebGPU host (rAF frame drawing, batch
// caches, vehicle interpolation/encode) over the real renderer, driven one
// synchronous render() per frame. No runtime/backend orchestration — the
// benchmark measures render cost, not app boot. The renderer is wrapped only
// to record the last frame's encode stats.
let state: GameState | null = null;
let sceneRevision = 0;
const ui = createUiState();

if (navigator.gpu === undefined) {
  throw new Error("WebGPU is unavailable in this browser");
}
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) {
  throw new Error("WebGPU adapter unavailable");
}
const device = await adapter.requestDevice();
const format = navigator.gpu.getPreferredCanvasFormat();
const renderer = createWebGpuRenderer(device, format);
let lastStats: WebGpuRenderStats = {
  solidBatches: 0,
  solidVertices: 0,
  vehicleInstances: 0,
};
const recordingRenderer: WebGpuRenderer = {
  ...renderer,
  render: (frame: WebGpuRenderFrame) => {
    lastStats = renderer.render(frame);
    return lastStats;
  },
};
const benchContext: WebGpuHostContext = {
  getState: () => {
    if (state === null) throw new Error("benchmark state is unavailable");
    return state;
  },
  getUi: () => ui,
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
const gameHost = createWebGpuHostWithRenderer(benchContext, recordingRenderer);
state = buildRenderScaleState(200);
sceneRevision = 1;
gameHost.mount(host);

window.__caelumRendererScale = {
  async run(
    vehicleCount: 200 | 5000,
    frames = 120,
  ): Promise<RendererScaleResult> {
    if (state === null || state.transit.vehicles.length !== vehicleCount) {
      state = buildRenderScaleState(vehicleCount);
      sceneRevision += 1;
    }
    for (let index = 0; index < WARMUP_FRAMES; index += 1) {
      gameHost.render();
    }
    const samples: number[] = [];
    for (let index = 0; index < frames; index += 1) {
      const start = performance.now();
      gameHost.render();
      samples.push(performance.now() - start);
    }
    await device.queue.onSubmittedWorkDone();
    return {
      vehicleCount,
      frames,
      presentedVehicles: state.transit.vehicles.length,
      encodedInstances: lastStats.vehicleInstances,
      vehicleUploadBytes:
        lastStats.vehicleInstances * VEHICLE_INSTANCE_FLOATS * 4,
      solidDraws: lastStats.solidBatches,
      vehicleDraws: lastStats.vehicleInstances > 0 ? 1 : 0,
      medianCpuMs: median(samples),
      p95CpuMs: percentile(samples, 0.95),
      queueCompleted: true,
    };
  },
};
