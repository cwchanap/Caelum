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

function button(attributes: string, label: string, active = false, pressed?: boolean): string {
  const ariaPressed = pressed === undefined ? "" : ` aria-pressed="${pressed}"`;
  return `<button type="button" ${attributes}${ariaPressed} class="${active ? "active" : ""}">${label}</button>`;
}

function setText(root: HTMLElement, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);

  if (element !== null && element.textContent !== value) {
    element.textContent = value;
  }
}

function setButtonState(buttonElement: HTMLButtonElement | null, active: boolean, pressed: boolean, label?: string): void {
  if (buttonElement === null) {
    return;
  }

  buttonElement.classList.toggle("active", active);
  buttonElement.setAttribute("aria-pressed", String(pressed));

  if (label !== undefined && buttonElement.textContent !== label) {
    buttonElement.textContent = label;
  }
}

function ensureTopbarMarkup(topbar: HTMLElement): void {
  if (topbar.dataset.structureKey === "topbar-v2") {
    return;
  }

  topbar.innerHTML = `
    <strong>Caelum</strong>
    <span data-panel-field="budget"></span>
    <span data-panel-field="time"></span>
    <span data-panel-field="population"></span>
    <span data-panel-field="late"></span>
    <span data-panel-field="unserved"></span>
    <span data-panel-field="avgWait"></span>
    ${button('data-action="pause"', "Resume", false, true)}
    ${button('data-speed="1"', "1x", false, false)}
    ${button('data-speed="2"', "2x", false, false)}
    ${button('data-speed="4"', "4x", false, false)}
  `;
  topbar.dataset.structureKey = "topbar-v2";
}

function ensureSidePanelMarkup(sidePanel: HTMLElement): void {
  const structureKey = `side-panel-v2:${tools.map((tool) => `${tool.id}:${tool.label}`).join("|")}:${overlays
    .map((overlay) => `${overlay.id}:${overlay.label}`)
    .join("|")}`;

  if (sidePanel.dataset.structureKey === structureKey) {
    return;
  }

  sidePanel.innerHTML = `
    <section class="toolbar" aria-label="Tools">
      ${tools.map((tool) => button(`data-tool="${tool.id}"`, tool.label, false, false)).join("")}
    </section>
    <section class="overlays" aria-label="Overlays">
      ${overlays.map((overlay) => button(`data-overlay="${overlay.id}"`, overlay.label, false, false)).join("")}
    </section>
    <section class="details">
      <h2 data-panel-field="scenarioName"></h2>
      <p data-panel-field="status"></p>
      <p data-panel-field="objective"></p>
      <p data-panel-field="loss"></p>
      <p data-panel-field="nextGrowth"></p>
      <p data-panel-field="tool"></p>
      <p data-panel-field="selected"></p>
    </section>
  `;
  sidePanel.dataset.structureKey = structureKey;
}

function updateTopbar(topbar: HTMLElement, state: GameState): void {
  setText(topbar, "[data-panel-field='budget']", `Budget ${formatBudget(state.budget)}`);
  setText(topbar, "[data-panel-field='time']", `Time ${formatTime(state.time)}`);
  setText(topbar, "[data-panel-field='population']", `Population ${state.citizens.length}`);
  setText(topbar, "[data-panel-field='late']", `Late ${state.metrics.lateTrips}`);
  setText(topbar, "[data-panel-field='unserved']", `Unserved ${state.metrics.unservedTrips}`);
  setText(topbar, "[data-panel-field='avgWait']", `Avg Wait ${Math.floor(state.metrics.averageWaitSeconds)}s`);
  setButtonState(topbar.querySelector<HTMLButtonElement>("[data-action='pause']"), false, state.paused, state.paused ? "Resume" : "Pause");

  for (const speed of [1, 2, 4] as const) {
    setButtonState(
      topbar.querySelector<HTMLButtonElement>(`[data-speed='${speed}']`),
      state.speed === speed && !state.paused,
      state.speed === speed
    );
  }
}

function updateSidePanel(sidePanel: HTMLElement, state: GameState, ui: UiState): void {
  for (const tool of tools) {
    setButtonState(
      sidePanel.querySelector<HTMLButtonElement>(`[data-tool='${tool.id}']`),
      ui.activeTool === tool.id,
      ui.activeTool === tool.id
    );
  }

  for (const overlay of overlays) {
    setButtonState(
      sidePanel.querySelector<HTMLButtonElement>(`[data-overlay='${overlay.id}']`),
      ui.activeOverlay === overlay.id,
      ui.activeOverlay === overlay.id
    );
  }

  setText(sidePanel, "[data-panel-field='scenarioName']", state.scenario.name);
  setText(sidePanel, "[data-panel-field='status']", `Status: ${state.metrics.state}`);
  setText(
    sidePanel,
    "[data-panel-field='objective']",
    `Objective: Keep late trips under ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved under ${Math.round(
      state.scenario.objectives.maxUnservedRatio * 100
    )}%, and average wait below ${state.scenario.objectives.maxAverageWait}s.`
  );
  setText(sidePanel, "[data-panel-field='loss']", state.metrics.lossReason ?? "Keep late and unserved trips below limits.");
  setText(sidePanel, "[data-panel-field='nextGrowth']", `Next growth: ${state.scenario.growthWaves.find((wave) => !wave.applied)?.message ?? "No more waves"}`);
  setText(sidePanel, "[data-panel-field='tool']", `Tool: ${ui.activeTool}`);
  setText(sidePanel, "[data-panel-field='selected']", `Selected: ${ui.selectedId ?? "None"}`);
}

export function renderPanels(root: HTMLElement, state: GameState, ui: UiState): void {
  const topbar = root.querySelector<HTMLElement>("[data-testid='topbar']");
  const sidePanel = root.querySelector<HTMLElement>("[data-testid='side-panel']");

  if (topbar === null || sidePanel === null) {
    return;
  }

  ensureTopbarMarkup(topbar);
  ensureSidePanelMarkup(sidePanel);
  updateTopbar(topbar, state);
  updateSidePanel(sidePanel, state, ui);
}
