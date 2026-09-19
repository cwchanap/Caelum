/** Shared formatting helpers used by runtime selectors and HUD panels. */

/** Pad an integer to a fixed-width 2-digit string (e.g. 1 -> "01"). */
export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Format a wait duration in seconds as one-decimal minutes, or an em dash
 *  when there is no current wait. Shared by the Lines and Inspect panels. */
export function formatMinutes(seconds: number | null): string {
  return seconds === null ? "—" : `${(seconds / 60).toFixed(1)} min`;
}
