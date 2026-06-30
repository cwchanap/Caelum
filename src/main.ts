import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createBackend } from "./runtime/backend";
import { createGameRuntime } from "./runtime/createGameRuntime";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

const target = app;

async function mountApp(): Promise<void> {
  const backend = await createBackend();
  const runtime = await createGameRuntime({ backend });
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
