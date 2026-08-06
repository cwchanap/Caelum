import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createBackend, type GameBackend } from "./runtime/backend";
import { createGameRuntime } from "./runtime/createGameRuntime";
import type { RuntimeController } from "./runtime/types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

const target = app;

interface DevE2eHooks {
  deferRoutePreviews?: boolean;
  releaseRoutePreviews?: () => void;
}

interface DevWindow extends Window {
  __caelumE2E?: DevE2eHooks;
}

function installDeferredRoutePreviewHarness(backend: GameBackend): GameBackend {
  const hooks = (globalThis.window as DevWindow).__caelumE2E;
  if (hooks?.deferRoutePreviews !== true) return backend;

  const previewRoute = backend.previewRoute.bind(backend);
  const pending: Array<{
    request: Parameters<GameBackend["previewRoute"]>[0];
    resolve: (
      response: Awaited<ReturnType<GameBackend["previewRoute"]>>,
    ) => void;
    reject: (error: unknown) => void;
  }> = [];

  hooks.releaseRoutePreviews = () => {
    hooks.deferRoutePreviews = false;
    const queued = pending.splice(0);
    for (const entry of queued) {
      void previewRoute(entry.request).then(entry.resolve, entry.reject);
    }
  };

  return {
    ...backend,
    previewRoute(request) {
      if (hooks.deferRoutePreviews !== true) {
        return previewRoute(request);
      }
      return new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject });
      });
    },
  };
}

async function mountApp(): Promise<void> {
  let backend = await createBackend();
  if (import.meta.env.DEV) {
    backend = installDeferredRoutePreviewHarness(backend);
  }
  const runtime: RuntimeController = await createGameRuntime({ backend });
  // Expose the runtime on `window` in dev only, so Playwright e2e can inspect
  // the live Rust-derived snapshot (e.g. assert a vehicle was assigned after
  // finishing a route). The branch is dead-code-eliminated from production
  // builds by Vite, so this never ships.
  if (import.meta.env.DEV) {
    (
      globalThis.window as unknown as { __caelumRuntime?: unknown }
    ).__caelumRuntime = runtime;
  }
  mount(App, {
    target,
    props: {
      runtime,
      error: null,
    },
  });
}

mountApp().catch((err: unknown) => {
  target.innerHTML = "";
  mount(App, {
    target,
    props: {
      runtime: null,
      error: err instanceof Error ? err.message : "Bootstrap failed",
    },
  });
});
