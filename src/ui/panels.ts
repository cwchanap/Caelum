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

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatBudget(budget: number): string {
  return `$${budget.toLocaleString()}`;
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `T+${pad2(mins)}:${pad2(secs)}`;
}

function setText(root: HTMLElement, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);

  if (element !== null && element.textContent !== value) {
    element.textContent = value;
  }
}

function setClass(root: HTMLElement, selector: string, className: string, on: boolean): void {
  const element = root.querySelector<HTMLElement>(selector);

  if (element !== null) {
    element.classList.toggle(className, on);
  }
}

function setButtonState(buttonElement: HTMLButtonElement | null, active: boolean, pressed: boolean, label?: string): void {
  if (buttonElement === null) {
    return;
  }

  buttonElement.classList.toggle("active", active);
  buttonElement.setAttribute("aria-pressed", String(pressed));

  if (label !== undefined) {
    const labelTarget = buttonElement.querySelector<HTMLElement>("[data-button-label]") ?? buttonElement;

    if (labelTarget.textContent !== label) {
      labelTarget.textContent = label;
    }
  }
}

function readout(field: string, label: string, modifier = ""): string {
  return `
    <div class="readout${modifier}">
      <span class="readout-label">${label}</span>
      <span class="readout-value" data-panel-field="${field}">—</span>
    </div>
  `;
}

function ensureTopbarMarkup(topbar: HTMLElement): void {
  if (topbar.dataset.structureKey === "topbar-ops-v1") {
    return;
  }

  topbar.innerHTML = `
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">CAELUM</span>
      <span class="brand-tag">Transit Ops</span>
    </div>
    <div class="signal" aria-live="polite">
      <span class="signal-dot" aria-hidden="true"></span>
      <span class="signal-label" data-panel-field="signalState">Live</span>
    </div>
    <div class="readouts">
      ${readout("budget", "Budget")}
      ${readout("time", "Clock")}
      ${readout("population", "Population")}
      ${readout("late", "Late", " readout--warn")}
      ${readout("unserved", "Unserved", " readout--alert")}
      ${readout("avgWait", "Avg Wait")}
    </div>
    <div class="controls">
      <button type="button" class="ctrl-tower" data-action="toggle-tower" aria-pressed="true"><span data-button-label>Control Tower</span></button>
      <button type="button" class="ctrl-pause" data-action="pause" aria-pressed="true"><span data-button-label>Resume</span></button>
      <div class="speed-group" role="group" aria-label="Simulation speed">
        <button type="button" data-speed="1" aria-pressed="false">1x</button>
        <button type="button" data-speed="2" aria-pressed="false">2x</button>
        <button type="button" data-speed="4" aria-pressed="false">4x</button>
      </div>
    </div>
  `;
  topbar.dataset.structureKey = "topbar-ops-v1";
}

function toolButton(tool: { id: Tool; label: string }, index: number): string {
  const num = pad2(index + 1);
  return `
    <button type="button" data-tool="${tool.id}" aria-pressed="false" aria-label="${tool.label}">
      <span class="tool-num" aria-hidden="true">${num}</span>
      <span class="tool-label" aria-hidden="true">${tool.label}</span>
    </button>
  `;
}

function overlayButton(overlay: { id: Overlay; label: string }): string {
  return `
    <button type="button" data-overlay="${overlay.id}" aria-pressed="false">${overlay.label}</button>
  `;
}

function ensureSidePanelMarkup(sidePanel: HTMLElement): void {
  const structureKey = `control-tower-bottom-v1:${tools.map((t) => `${t.id}:${t.label}`).join("|")}:${overlays
    .map((o) => `${o.id}:${o.label}`)
    .join("|")}`;

  if (sidePanel.dataset.structureKey === structureKey) {
    return;
  }

  sidePanel.innerHTML = `
    <header class="panel-head">
      <button type="button" class="panel-close" data-action="close-tower" aria-label="Close Control Tower">×</button>
      <span class="panel-head-mark" aria-hidden="true">⌬</span>
      <span class="panel-head-title">Control Tower</span>
      <span class="panel-head-id">CTRL · 07</span>
    </header>

    <section class="panel-section">
      <h3 class="section-head"><span class="num">01</span> Build</h3>
      <div class="toolbar" aria-label="Tools">
        ${tools.map((tool, index) => toolButton(tool, index)).join("")}
      </div>
    </section>

    <section class="panel-section">
      <h3 class="section-head"><span class="num">02</span> Overlay</h3>
      <div class="overlays" aria-label="Overlays">
        ${overlays.map(overlayButton).join("")}
      </div>
    </section>

    <section class="panel-section details">
      <h3 class="section-head"><span class="num">03</span> Brief</h3>
      <h2 data-panel-field="scenarioName">—</h2>
      <p class="brief-id" data-panel-field="briefId">Scenario · 001</p>

      <div class="dispatch-row">
        <span class="dispatch-key">Status</span>
        <span class="dispatch-val dispatch-val--mono" data-panel-field="status">—</span>
      </div>
      <div class="dispatch-row">
        <span class="dispatch-key">Goal</span>
        <span class="dispatch-val" data-panel-field="objective">—</span>
      </div>
      <div class="dispatch-row">
        <span class="dispatch-key">Note</span>
        <span class="dispatch-val dispatch-val--mono" data-panel-field="loss">—</span>
      </div>
      <div class="dispatch-row">
        <span class="dispatch-key">Wave</span>
        <span class="dispatch-val" data-panel-field="nextGrowth">—</span>
      </div>

      <div class="dispatch-divider" aria-hidden="true"></div>

      <div class="dispatch-row">
        <span class="dispatch-key">Tool</span>
        <span class="dispatch-val dispatch-val--ok" data-panel-field="tool">—</span>
      </div>
      <div class="dispatch-row">
        <span class="dispatch-key">Target</span>
        <span class="dispatch-val dispatch-val--mono" data-panel-field="selected">—</span>
      </div>
    </section>
  `;
  sidePanel.dataset.structureKey = structureKey;
}

function updateTopbar(topbar: HTMLElement, state: GameState, ui: UiState): void {
  setText(topbar, "[data-panel-field='budget']", formatBudget(state.budget));
  setText(topbar, "[data-panel-field='time']", formatTime(state.time));
  setText(topbar, "[data-panel-field='population']", `${state.citizens.length}`);
  setText(topbar, "[data-panel-field='late']", `${state.metrics.lateTrips}`);
  setText(topbar, "[data-panel-field='unserved']", `${state.metrics.unservedTrips}`);
  setText(topbar, "[data-panel-field='avgWait']", `${Math.floor(state.metrics.averageWaitSeconds)}s`);
  setText(topbar, "[data-panel-field='signalState']", state.paused ? "Hold" : "Live");
  setClass(topbar, ".signal", "signal--paused", state.paused);

  setButtonState(
    topbar.querySelector<HTMLButtonElement>("[data-action='toggle-tower']"),
    ui.controlTowerOpen,
    ui.controlTowerOpen
  );

  setButtonState(
    topbar.querySelector<HTMLButtonElement>("[data-action='pause']"),
    false,
    state.paused,
    state.paused ? "Resume" : "Pause"
  );

  for (const speed of [1, 2, 4] as const) {
    setButtonState(
      topbar.querySelector<HTMLButtonElement>(`[data-speed='${speed}']`),
      state.speed === speed && !state.paused,
      state.speed === speed
    );
  }
}

function updateSidePanel(sidePanel: HTMLElement, state: GameState, ui: UiState): void {
  sidePanel.classList.toggle("control-tower--closed", !ui.controlTowerOpen);
  sidePanel.setAttribute("aria-hidden", String(!ui.controlTowerOpen));

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
  setText(sidePanel, "[data-panel-field='status']", state.metrics.state.toUpperCase());
  setText(
    sidePanel,
    "[data-panel-field='objective']",
    `Hold late trips below ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
      state.scenario.objectives.maxUnservedRatio * 100
    )}%, average wait under ${state.scenario.objectives.maxAverageWait}s.`
  );
  setText(
    sidePanel,
    "[data-panel-field='loss']",
    state.metrics.lossReason ?? "Within tolerances. Hold the line."
  );
  setText(
    sidePanel,
    "[data-panel-field='nextGrowth']",
    state.scenario.growthWaves.find((wave) => !wave.applied)?.message ?? "All growth waves resolved."
  );
  setText(sidePanel, "[data-panel-field='tool']", ui.activeTool.toUpperCase());
  setText(sidePanel, "[data-panel-field='selected']", ui.selectedId ?? "—");
}

export function renderPanels(root: HTMLElement, state: GameState, ui: UiState): void {
  const topbar = root.querySelector<HTMLElement>("[data-testid='topbar']");
  const sidePanel = root.querySelector<HTMLElement>("[data-testid='control-tower']");

  if (topbar === null || sidePanel === null) {
    return;
  }

  root
    .querySelector<HTMLElement>("[data-testid='game-shell']")
    ?.setAttribute("data-tower-open", String(ui.controlTowerOpen));
  ensureTopbarMarkup(topbar);
  ensureSidePanelMarkup(sidePanel);
  updateTopbar(topbar, state, ui);
  updateSidePanel(sidePanel, state, ui);
}
