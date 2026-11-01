/**
 * What a map click resolved to. The display host computes candidates from the
 * last drawn frame; the UI action layer decides whether and how to use them.
 */
export interface MapPick {
  vehicleId: string | null;
  lineId: string | null;
}
