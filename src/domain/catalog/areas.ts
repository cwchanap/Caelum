import type { AreaKind } from "../types";

export const AREA_KINDS = [
  "residential",
  "commercial",
  "industrial",
  "office",
  "civic",
  "park",
] as const satisfies AreaKind[];

export const AREA_LABELS: Record<AreaKind, string> = {
  residential: "Residential",
  commercial: "Commercial",
  industrial: "Industrial",
  office: "Office",
  civic: "Civic",
  park: "Park",
};

/** Zones buildings can grow into — mirrors caelum-core's growth HOMES and
 *  WORKPLACES tables; civic and park land never develops. */
export const GROWTH_AREA_KINDS: ReadonlySet<AreaKind> = new Set([
  "residential",
  "commercial",
  "industrial",
  "office",
]);
