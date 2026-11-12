import type { RoadPreset } from "../domain/types";
import type { BuildMenuGroup } from "../domain/catalog/buildGroups";

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

/** First nine visible leaf items in the order they render, keyed by item ID.
 *  Card badges and the window key handler share this table; while a Build
 *  leaf group is open its keys take priority over the global road presets. */
export function buildGroupShortcuts(
  group: BuildMenuGroup,
): Record<string, string> {
  return Object.fromEntries(
    group.sections
      .flatMap((section) => section.items)
      .slice(0, 9)
      .map((item, index) => [item.id, String(index + 1)]),
  );
}
