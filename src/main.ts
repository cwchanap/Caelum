import "./styles.css";
import type { Overlay, Tool } from "./domain/types";
import { canvasToTile, renderGame, syncCanvasSize } from "./render/canvas";
import { createInitialGameState } from "./simulation/gameState";
import { tickSimulation } from "./simulation/simulation";
import { handleTileClick } from "./ui/actions";
import { renderPanels } from "./ui/panels";
import { createUiState } from "./ui/uiState";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

app.innerHTML = `
  <main class="shell" data-testid="game-shell">
    <section class="topbar" data-testid="topbar"></section>
    <canvas class="board" data-testid="game-canvas" width="1280" height="800"></canvas>
    <aside class="panel control-tower" data-testid="control-tower"></aside>
  </main>
`;

const canvas = app.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']");
const ctx = canvas?.getContext("2d");

if (canvas === null || ctx === null || ctx === undefined) {
  throw new Error("Canvas is unavailable");
}

const root = app;
const gameCanvas = canvas;
const gameContext = ctx;

let state = createInitialGameState();
let ui = createUiState();
let lastFrame = performance.now();

function frame(now: number): void {
  const deltaSeconds = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  syncCanvasSize(gameCanvas);
  state = tickSimulation(state, deltaSeconds);
  renderGame(gameContext, state, ui);
  renderPanels(root, state, ui);
  requestAnimationFrame(frame);
}

gameCanvas.addEventListener("mousemove", (event) => {
  syncCanvasSize(gameCanvas);
  ui = { ...ui, hoverTile: canvasToTile(gameCanvas, event.clientX, event.clientY, state.map) };
});

gameCanvas.addEventListener("click", (event) => {
  syncCanvasSize(gameCanvas);
  const point = canvasToTile(gameCanvas, event.clientX, event.clientY, state.map);

  if (point === null) {
    return;
  }

  const result = handleTileClick(state, ui, point);
  state = result.state;
  ui = result.ui;
});

root.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const toolElement = target.closest<HTMLElement>("[data-tool]");
  const overlayElement = target.closest<HTMLElement>("[data-overlay]");
  const speedElement = target.closest<HTMLElement>("[data-speed]");
  const actionElement = target.closest<HTMLElement>("[data-action]");
  const tool = toolElement?.dataset.tool as Tool | undefined;
  const overlay = overlayElement?.dataset.overlay as Overlay | undefined;
  const speed = speedElement?.dataset.speed;
  const action = actionElement?.dataset.action;

  if (tool !== undefined) {
    ui = { ...ui, activeTool: tool, draftStopIds: [], draftStationIds: [] };
  }

  if (overlay !== undefined) {
    ui = { ...ui, activeOverlay: ui.activeOverlay === overlay ? null : overlay };
  }

  if (action === "pause") {
    state = { ...state, paused: !state.paused };
  }

  if (action === "toggle-tower") {
    ui = { ...ui, controlTowerOpen: !ui.controlTowerOpen };
  }

  if (action === "close-tower") {
    ui = { ...ui, controlTowerOpen: false };
  }

  if (speed !== undefined) {
    state = { ...state, speed: Number(speed) as 1 | 2 | 4, paused: false };
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    ui = createUiState();
  }
});

requestAnimationFrame(frame);
