import "./styles.css";
import type { Overlay, Tool } from "./domain/types";
import { canvasToTile, renderGame } from "./render/canvas";
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
    <aside class="panel" data-testid="side-panel"></aside>
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
let lastPanelRenderKey: string | null = null;

function panelRenderKey(): string {
  const nextWave = state.scenario.growthWaves.find((wave) => !wave.applied);

  return JSON.stringify({
    budget: state.budget,
    timeBucket: Math.floor(state.time),
    population: state.citizens.length,
    late: state.metrics.lateTrips,
    unserved: state.metrics.unservedTrips,
    avgWait: Math.floor(state.metrics.averageWaitSeconds),
    paused: state.paused,
    speed: state.speed,
    metricsState: state.metrics.state,
    lossReason: state.metrics.lossReason,
    nextWaveId: nextWave?.id ?? null,
    nextWaveMessage: nextWave?.message ?? null,
    activeTool: ui.activeTool,
    activeOverlay: ui.activeOverlay,
    draftStopCount: ui.draftStopIds.length,
    draftStationCount: ui.draftStationIds.length,
    selectedId: ui.selectedId
  });
}

function frame(now: number): void {
  const deltaSeconds = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  state = tickSimulation(state, deltaSeconds);
  renderGame(gameContext, state, ui);

  const nextPanelRenderKey = panelRenderKey();
  if (nextPanelRenderKey !== lastPanelRenderKey) {
    renderPanels(root, state, ui);
    lastPanelRenderKey = nextPanelRenderKey;
  }

  requestAnimationFrame(frame);
}

gameCanvas.addEventListener("mousemove", (event) => {
  ui = { ...ui, hoverTile: canvasToTile(gameCanvas, event.clientX, event.clientY, state.map) };
});

gameCanvas.addEventListener("click", (event) => {
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

  const tool = target.dataset.tool as Tool | undefined;
  const overlay = target.dataset.overlay as Overlay | undefined;
  const speed = target.dataset.speed;

  if (tool !== undefined) {
    ui = { ...ui, activeTool: tool, draftStopIds: [], draftStationIds: [] };
  }

  if (overlay !== undefined) {
    ui = { ...ui, activeOverlay: ui.activeOverlay === overlay ? null : overlay };
  }

  if (target.dataset.action === "pause") {
    state = { ...state, paused: !state.paused };
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
