import type { Stop } from "../types";

export const METRO_STATION_COVERAGE_RADIUS = 4;

export function stopCoverageRadius(stop: Pick<Stop, "kind">): number {
  return stop.kind === "busTerminal" ? 4 : 2;
}
