import type { Stop } from "../types";

export const COSTS = {
  busStop: 2_000,
  metroStation: 25_000,
  bus: 8_000,
  metro: 50_000,
  road: 100,
  track: 500,
} as const;

export function stopCoverageRadius(stop: Stop): number {
  return stop.kind === "busTerminal" ? 4 : 2;
}
