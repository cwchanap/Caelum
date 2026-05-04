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
  // Placeholder validation: Pre-mount call ensures getSnapshot is callable.
  // TODO(Task 2): Replace with real runtime factory/bootstrap path.
  runtime.getSnapshot();
  
  mount(App, {
    target: app,
    props: {
      runtime
    }
  });
} catch (err) {
  app.innerHTML = "";
  const errorMessage = err instanceof Error ? err.message : "Bootstrap failed";
  mount(App, {
    target: app,
    props: {
      runtime: createBootstrapRuntime(),
      error: errorMessage
    }
  });
}
