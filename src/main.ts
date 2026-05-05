import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createGameRuntime } from "./runtime/createGameRuntime";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

try {
  const runtime = createGameRuntime();

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
        runtime: createGameRuntime(),
        error: errorMessage
      }
    });
  } catch (_) {
    app.innerHTML = "";
    const container = document.createElement("div");
    container.style.cssText = "padding:2rem;color:#ef4444;font-family:system-ui";
    
    const heading = document.createElement("h1");
    heading.textContent = "Critical Error";
    
    const paragraph = document.createElement("p");
    paragraph.textContent = err instanceof Error ? err.message : "Bootstrap failed";
    
    container.appendChild(heading);
    container.appendChild(paragraph);
    app.appendChild(container);
  }
}
