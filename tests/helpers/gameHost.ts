import { vi, type Mock } from "vitest";
import type {
  CreateGameHost,
  GameHost,
  WebGpuHostContext,
} from "../../src/runtime/createWebGpuHost";

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
  };
  created.push(host);
  return host;
};

/** The most recently created fake host, or undefined before any construction. */
export function lastFakeHost(): FakeGameHost | undefined {
  return created.at(-1);
}
