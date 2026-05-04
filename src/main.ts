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

mount(App, {
  target: app,
  props: {
    runtime: createRuntimeStub()
  }
});
