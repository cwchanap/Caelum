import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

function createRuntimeStub() {
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
  mount(App, {
    target: app,
    props: {
      runtime: createRuntimeStub()
    }
  });
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : "Bootstrap failed";
  mount(App, {
    target: app,
    props: {
      runtime: createRuntimeStub(),
      error: errorMessage
    }
  });
}
