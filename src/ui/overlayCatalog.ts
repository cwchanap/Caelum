import type { Overlay } from "../domain/types";
import { colors } from "../render/colors";
import {
  CROWDING_FULL_ALPHA,
  CROWDING_HALF_ALPHA,
  MAX_CONGESTION_MULTIPLIER,
  ROAD_FLOW_CAPACITY,
  demandAlpha,
  trafficAlpha,
} from "../render/overlayAlpha";

type OverlayDescriptor = {
  label: string;
  legendText: string;
  swatches: readonly string[];
  /** The map surface this overlay paints on; chips preview against it. */
  swatchBackground: string;
};

/** A legend chip at the same effective alpha the renderer's `withAlpha`
 *  produces for this base color. */
function overlaySwatch(base: string, alpha: number): string {
  return `color-mix(in srgb, ${base} ${alpha * 100}%, transparent)`;
}

const TRAFFIC_FULL_FLOW = ROAD_FLOW_CAPACITY * MAX_CONGESTION_MULTIPLIER;

export const OVERLAY_CATALOG = {
  coverage: {
    label: "Coverage",
    legendText:
      "Shaded tiles are near stops or stations; active service can support nearby growth.",
    swatches: [colors.coverage],
    swatchBackground: colors.empty,
  },
  crowding: {
    label: "Crowding",
    legendText:
      "Red marks platforms above half capacity; darker means full or over capacity.",
    swatches: [
      overlaySwatch(colors.crowding, CROWDING_HALF_ALPHA),
      overlaySwatch(colors.crowding, CROWDING_FULL_ALPHA),
    ],
    swatchBackground: colors.empty,
  },
  demand: {
    label: "Demand",
    legendText:
      "Darker yellow means more active travel demand at this location.",
    swatches: [1, 2, 3, 4].map((count) =>
      overlaySwatch(colors.demand, demandAlpha(count)),
    ),
    swatchBackground: colors.empty,
  },
  traffic: {
    label: "Traffic",
    legendText: "Darker red means more private-car traffic on this road.",
    swatches: [0.25, 0.5, 0.75, 1].map((fraction) =>
      overlaySwatch(colors.traffic, trafficAlpha(TRAFFIC_FULL_FLOW * fraction)),
    ),
    swatchBackground: colors.road,
  },
} as const satisfies Record<Overlay, OverlayDescriptor>;

/** Every catalog key, in display order — derived so it cannot drift out of
 *  sync when the `Overlay` union grows. */
export const OVERLAY_IDS = Object.keys(OVERLAY_CATALOG) as Overlay[];
