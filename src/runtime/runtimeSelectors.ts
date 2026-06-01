import type { GameState } from "../domain/types";
import { BUILDING_CATALOG } from "../simulation/buildings";
import type { UiState } from "../ui/uiState";
import type { ShellState } from "./types";

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatBudget(budget: number): string {
  return `$${budget.toLocaleString()}`;
}

export function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;

  return `T+${pad2(mins)}:${pad2(secs)}`;
}

export function formatObjective(state: GameState): string {
  return `Hold late trips below ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
    state.scenario.objectives.maxUnservedRatio * 100,
  )}%, average wait under ${state.scenario.objectives.maxAverageWait}s.`;
}

export function formatActiveTool(ui: UiState): string {
  if (ui.selectedBuilding !== null) {
    return `${BUILDING_CATALOG[ui.selectedBuilding].label.toUpperCase()} ${ui.buildingRotation}`;
  }

  return ui.activeTool.toUpperCase();
}

export function selectShellState(state: GameState, ui: UiState): ShellState {
  return {
    topbar: {
      budget: formatBudget(state.budget),
      signalState: state.paused ? "Hold" : "Live",
      time: formatTime(state.time),
      population: `${state.citizens.length}`,
      late: `${state.metrics.lateTrips}`,
      unserved: `${state.metrics.unservedTrips}`,
      avgWait: `${Math.floor(state.metrics.averageWaitSeconds)}s`,
    },
    controlTower: {
      title: state.scenario.name,
      status: state.metrics.state.toUpperCase(),
      objective: formatObjective(state),
      lossNote: state.metrics.lossReason ?? "Within tolerances. Hold the line.",
      nextGrowth:
        state.scenario.growthWaves.find((wave) => !wave.applied)?.message ??
        "All growth waves resolved.",
      selectedId: ui.selectedId ?? "—",
      activeTool: formatActiveTool(ui),
      controlTowerOpen: ui.controlTowerOpen,
    },
  };
}
