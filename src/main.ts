import "./styles.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <main class="shell" data-testid="game-shell">
    <section class="topbar" data-testid="topbar">Caelum loading...</section>
    <canvas class="board" data-testid="game-canvas" width="1280" height="800"></canvas>
    <aside class="panel" data-testid="side-panel">Select a tool</aside>
  </main>
`;
