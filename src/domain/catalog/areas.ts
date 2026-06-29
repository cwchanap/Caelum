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
