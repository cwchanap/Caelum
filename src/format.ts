/** Shared formatting helpers used by runtime selectors and HUD panels. */

/** Pad an integer to a fixed-width 2-digit string (e.g. 1 -> "01"). */
export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
