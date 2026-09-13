import { vi, type Mock } from "vitest";
import type {
  CreateGameHost,
  GameHost,
  WebGpuHostContext,
} from "../../src/runtime/createWebGpuHost";
import { createWebGpuHostWithRenderer } from "../../src/runtime/createWebGpuHost";
import type { WebGpuRenderer } from "../../src/render/webgpu/renderer";

/**
 * Async fake host injected through `CreateGameRuntimeOptions.createHost` so
 * Node/jsdom runtime tests never construct WebGPU devices. Each runtime
 * construction records its host; tests reach it via `lastFakeHost()`.
 */
export interface FakeGameHost extends GameHost {
  context: WebGpuHostContext;
  mount: Mock;
  render: Mock;
  start: Mock;
  stop: Mock;
  syncAnimationLoop: Mock;
  isRunning: Mock;
  captureFrame: Mock;
}

const created: FakeGameHost[] = [];

export const createFakeGameHost: CreateGameHost = async (context) => {
  let running = false;
  const host: FakeGameHost = {
    context,
    mount: vi.fn(() => () => {}),
    render: vi.fn(),
    start: vi.fn(() => {
      running = true;
    }),
    stop: vi.fn(() => {
      running = false;
    }),
    syncAnimationLoop: vi.fn(),
    isRunning: vi.fn(() => running),
    captureFrame: vi.fn(async () => null),
  };
  created.push(host);
  return host;
};

/** The most recently created fake host, or undefined before any construction. */
export function lastFakeHost(): FakeGameHost | undefined {
  return created.at(-1);
}

/** No-op renderer so the real WebGPU host logic runs in Node/jsdom without
 *  navigator.gpu: `configure` never touches the canvas, nothing reaches GPU. */
export function createNoopWebGpuRenderer(): WebGpuRenderer {
  return {
    lost: new Promise(() => {}),
    configure: () => {},
    resize: () => {},
    render: () => ({ solidBatches: 0, solidVertices: 0, vehicleInstances: 0 }),
    captureFrame: async () => null,
    destroy: () => {},
  };
}

/** Real host factory (rAF cadence, 10 Hz tick admission, pointer wiring) over
 *  a no-op renderer. The `createHost` seam for tests that exercise the
 *  production host behavior in Node/jsdom; never touches navigator.gpu. */
export const createJsdomGameHost: CreateGameHost = async (context) =>
  createWebGpuHostWithRenderer(context, createNoopWebGpuRenderer());
