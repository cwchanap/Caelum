import type { GameState } from "../../src/domain/types";
import { renderGame } from "../../src/render/canvas";
import { createUiState } from "../../src/ui/uiState";
import { buildRenderScaleState } from "../helpers/renderScaleState";

const WARMUP_FRAMES = 30;

export interface RendererScaleResult {
  vehicleCount: number;
  frames: number;
  medianCpuMs: number;
  p95CpuMs: number;
}

declare global {
  interface Window {
    __caelumRendererScale: {
      run: (vehicleCount: 200 | 5000, frames?: number) => RendererScaleResult;
    };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>("#bench-canvas");
const ctx = canvas?.getContext("2d") ?? null;
if (canvas === null || ctx === null) {
  throw new Error("renderer scale benchmark canvas is unavailable");
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

let state: GameState | null = null;

window.__caelumRendererScale = {
  run(vehicleCount: 200 | 5000, frames = 120): RendererScaleResult {
    if (state?.transit.vehicles.length !== vehicleCount) {
      state = buildRenderScaleState(vehicleCount);
    }
    const ui = createUiState();
    for (let index = 0; index < WARMUP_FRAMES; index += 1) {
      renderGame(ctx, state, ui);
    }
    const samples: number[] = [];
    for (let index = 0; index < frames; index += 1) {
      const start = performance.now();
      renderGame(ctx, state, ui);
      samples.push(performance.now() - start);
    }
    return {
      vehicleCount,
      frames,
      medianCpuMs: median(samples),
      p95CpuMs: percentile(samples, 0.95),
    };
  },
};
