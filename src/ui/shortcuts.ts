import type { RoadPreset } from "../domain/types";

export const BUILD_KEY = "b";
export const ROTATE_KEY = "r";
export const TRACK_KEY = "t";
export const DEMOLISH_KEY = "d";
export const SELECT_KEY = "v";

/** Keyboard shortcut for each road preset. The Record is exhaustive, so a
 *  new preset without a key fails to compile — and both the handler
 *  (key → preset) and the panel hint (preset → key) read this one table. */
export const ROAD_PRESET_KEYS: Record<RoadPreset, string> = {
  twoWay: "1",
  oneWay: "2",
  dualBidirectional: "3",
};
