import type { GameState, Overlay, Tool } from "../domain/types";
import type { UiState } from "./uiState";

const tools: Array<{ id: Tool; label: string }> = [
  { id: "inspect", label: "Inspect" },
  { id: "busStop", label: "Bus Stop" },
  { id: "busRoute", label: "Bus Route" },
  { id: "metroStation", label: "Metro Station" },
  { id: "metroLine", label: "Metro Line" },
  { id: "civicAnchor", label: "Civic" },
  { id: "remove", label: "Remove" }
];

const overlays: Array<{ id: Overlay; label: string }> = [
  { id: "coverage", label: "Coverage" },
  { id: "crowding", label: "Crowding" },
  { id: "demand", label: "Demand" },
  { id: "lateness", label: "Lateness" },
  { id: "growth", label: "Growth" }
];

function formatBudget(budget: number): string {
  return `$${budget.toLocaleString()}`;
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds)}s`;
}

function button(attributes: string, label: string, active = false): string {
  return `<button type="button" ${attributes} class="${active ? "active" : ""}">${label}</button>`;
}

export function renderPanels(root: HTMLElement, state: GameState, ui: UiState): void {
  const topbar = root.querySelector<HTMLElement>("[data-testid='topbar']");
  const sidePanel = root.querySelector<HTMLElement>("[data-testid='side-panel']");

  if (topbar === null || sidePanel === null) {
    return;
  }

  topbar.innerHTML = `
    <strong>Caelum</strong>
    <span>Budget ${formatBudget(state.budget)}</span>
    <span>Time ${formatTime(state.time)}</span>
    <span>Population ${state.citizens.length}</span>
    <span>Late ${state.metrics.lateTrips}</span>
    <span>Unserved ${state.metrics.unservedTrips}</span>
    <span>Avg Wait ${Math.floor(state.metrics.averageWaitSeconds)}s</span>
    ${button('data-action="pause"', state.paused ? "Resume" : "Pause")}
    ${button('data-speed="1"', "1x", state.speed === 1 && !state.paused)}
    ${button('data-speed="2"', "2x", state.speed === 2 && !state.paused)}
    ${button('data-speed="4"', "4x", state.speed === 4 && !state.paused)}
  `;

  sidePanel.innerHTML = `
    <section class="toolbar" aria-label="Tools">
      ${tools.map((tool) => button(`data-tool="${tool.id}"`, tool.label, ui.activeTool === tool.id)).join("")}
    </section>
    <section class="overlays" aria-label="Overlays">
      ${overlays.map((overlay) => button(`data-overlay="${overlay.id}"`, overlay.label, ui.activeOverlay === overlay.id)).join("")}
    </section>
    <section class="details">
      <h2>Growing Suburb</h2>
      <p>Status: ${state.metrics.state}</p>
      <p>Objective: Keep late trips under ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved under ${Math.round(
        state.scenario.objectives.maxUnservedRatio * 100
      )}%, and average wait below ${state.scenario.objectives.maxAverageWait}s.</p>
      <p>${state.metrics.lossReason ?? "Keep late and unserved trips below limits."}</p>
      <p>Next growth: ${state.scenario.growthWaves.find((wave) => !wave.applied)?.message ?? "No more waves"}</p>
      <p>Tool: ${ui.activeTool}</p>
      <p>Selected: ${ui.selectedId ?? "None"}</p>
    </section>
  `;
}
