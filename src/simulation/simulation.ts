import type { GameState } from "../domain/types";
import { tickCitizens } from "./citizens";
import { applyDueGrowthWaves } from "./map";
import { evaluateObjectives } from "./objectives";
import { tickVehicles } from "./transit";

export function tickSimulation(
  state: GameState,
  deltaSeconds: number,
): GameState {
  if (state.paused || state.metrics.state !== "running" || state.speed === 0) {
    return state;
  }

  const scaledDelta = deltaSeconds * state.speed;
  const advancedState = {
    ...state,
    time: state.time + scaledDelta,
  };
  const grownState = applyDueGrowthWaves(advancedState);
  const vehicleState = tickVehicles(grownState, scaledDelta);
  const citizenState = tickCitizens(vehicleState, scaledDelta);

  return evaluateObjectives(citizenState);
}
