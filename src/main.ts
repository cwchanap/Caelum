import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createGameRuntime } from "./runtime/createGameRuntime";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

const target = app;

function mountApp(error?: string): void {
  mount(App, {
    target,
    props: {
      runtime: createGameRuntime(),
      error
    }
  });
}

try {
  mountApp();
} catch (err) {
  target.innerHTML = "";
  mountApp(err instanceof Error ? err.message : "Bootstrap failed");
}
