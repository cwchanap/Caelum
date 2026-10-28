import type { Overlay } from "../domain/types";
import { colors } from "../render/colors";

type OverlayDescriptor = {
  label: string;
  legendText: string;
  swatches: readonly string[];
};

export const OVERLAY_IDS = [
  "coverage",
  "crowding",
  "demand",
  "traffic",
] as const satisfies readonly Overlay[];

export const OVERLAY_CATALOG = {
  coverage: {
    label: "Coverage",
    legendText: "Transit stop and station reach",
    swatches: [colors.coverage],
  },
  crowding: {
    label: "Crowding",
    legendText:
      "Orange marks platforms above half capacity; darker means full or over capacity",
    swatches: [
      `color-mix(in srgb, ${colors.crowding} 30%, transparent)`,
      `color-mix(in srgb, ${colors.crowding} 55%, transparent)`,
    ],
  },
  demand: {
    label: "Demand",
    legendText: "Destination demand, increasing with activity",
    swatches: [
      `color-mix(in srgb, ${colors.demand} 24%, transparent)`,
      `color-mix(in srgb, ${colors.demand} 42.24%, transparent)`,
      `color-mix(in srgb, ${colors.demand} 56.1024%, transparent)`,
      `color-mix(in srgb, ${colors.demand} 66.637824%, transparent)`,
    ],
  },
  traffic: {
    label: "Traffic",
    legendText: "Road traffic, increasing with flow",
    swatches: [
      `color-mix(in srgb, ${colors.traffic} 25%, transparent)`,
      `color-mix(in srgb, ${colors.traffic} 50%, transparent)`,
      `color-mix(in srgb, ${colors.traffic} 75%, transparent)`,
      colors.traffic,
    ],
  },
} as const satisfies Record<Overlay, OverlayDescriptor>;
