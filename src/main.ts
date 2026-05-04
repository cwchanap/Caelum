import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

function createBootstrapRuntime() {
  return {
    getSnapshot: () => ({
      shell: {
        topbar: { budget: "$0", signalState: "Initializing" },
        controlTower: { title: "City", controlTowerOpen: false }
      }
    }),
    subscribe: () => () => {},
    start: () => {},
    stop: () => {}
  };
}

try {
  const runtime = createBootstrapRuntime();
  // TODO(Task 2): Replace createBootstrapRuntime() with real runtime factory/bootstrap path.
  
  mount(App, {
    target: app,
    props: {
      runtime
    }
  });
} catch (err) {
  try {
    app.innerHTML = "";
    const errorMessage = err instanceof Error ? err.message : "Bootstrap failed";
    mount(App, {
      target: app,
      props: {
        runtime: createBootstrapRuntime(),
        error: errorMessage
      }
    });
  } catch (finalErr) {
    app.innerHTML = `<div style="padding:2rem;color:#ef4444;font-family:system-ui">
      <h1>Critical Error</h1>
      <p>${err instanceof Error ? err.message : "Bootstrap failed"}</p>
    </div>`;
  }
}
