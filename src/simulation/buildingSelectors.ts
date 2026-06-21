import type {
  Citizen,
  CitizenStatus,
  GameState,
  Point,
  Vehicle,
} from "../domain/types";
import { BUILDING_CATALOG } from "./buildingCatalog";

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

export function destinationPoints(state: GameState): Point[] {
  return state.buildings
    .filter(
      (building) => BUILDING_CATALOG[building.type].effect === "destination",
    )
    .flatMap((building) => building.occupiedTiles.map(clonePoint));
}

// Terminal citizens have finished their one trip and never travel again, so
// retargeting them is a no-op. Mirrors `terminalStatuses` in citizens.ts.
const TERMINAL_STATUSES = new Set<CitizenStatus>([
  "arrived",
  "late",
  "unserved",
]);

/**
 * Re-resolve destinations for non-terminal citizens selected by
 * `shouldRetarget` after a destination-building change (place or bulldoze).
 *
 * Each selected citizen is assigned a fresh destination from the current
 * `destinationPoints(state)` (round-robin across the retargeted set, mirroring
 * the `index % destinations.length` distribution used at creation time), falls
 * back to `home` when no destinations remain, and has its route plan cleared
 * so `tickCitizen` replans from scratch on the next tick.
 *
 * Riding citizens are forcibly disembarked: their `routePlan` is nulled, which
 * would otherwise trap them on the vehicle (`disembarkVehicle` only drops
 * passengers whose current leg matches the reached stop). Their `position` is
 * left at the boarding stop (vehicles do not update passenger positions
 * mid-transit), which is a valid tile for `findRoutePlan` to replan from, and
 * they are removed from every vehicle's `passengerIds`.
 *
 * Returns the new citizens and vehicles arrays. Callers must spread both into
 * the post-change state. When no citizen is retargeted, both arrays are the
 * original references (reference-equality friendly for the runtime commit).
 */
export function retargetCitizens(
  state: GameState,
  shouldRetarget: (citizen: Citizen) => boolean,
): { citizens: Citizen[]; vehicles: Vehicle[] } {
  const destinations = destinationPoints(state);
  const retargetedIds = new Set<string>();
  let retargetIndex = 0;
  let anyChanged = false;

  const mapped = state.citizens.map((citizen) => {
    if (TERMINAL_STATUSES.has(citizen.status) || !shouldRetarget(citizen)) {
      return citizen;
    }
    anyChanged = true;
    retargetedIds.add(citizen.id);
    const destination =
      destinations.length === 0
        ? citizen.home
        : destinations[retargetIndex % destinations.length];
    retargetIndex += 1;

    return {
      ...citizen,
      home: clonePoint(citizen.home),
      destination: clonePoint(destination),
      position: clonePoint(citizen.position),
      status: "idle" as const,
      routePlan: null,
      currentLegIndex: 0,
    };
  });

  if (!anyChanged) {
    // Preserve reference equality for the runtime's `nextState !== state`
    // commit gate when no citizen was retargeted.
    return { citizens: state.citizens, vehicles: state.transit.vehicles };
  }

  const vehicles = state.transit.vehicles.map((vehicle) =>
    vehicle.passengerIds.some((id) => retargetedIds.has(id))
      ? {
          ...vehicle,
          passengerIds: vehicle.passengerIds.filter(
            (id) => !retargetedIds.has(id),
          ),
        }
      : vehicle,
  );

  return { citizens: mapped, vehicles };
}

/**
 * True when the citizen's destination equals its home — the documented
 * fallback used when no destination building exists at creation time. Since
 * housing and destination buildings cannot overlap (canPlaceBuilding rejects
 * overlapping footprints), destination === home reliably identifies the
 * fallback case, including after a retarget back to home.
 */
export function isHomeFallbackCitizen(citizen: Citizen): boolean {
  return samePoint(citizen.destination, citizen.home);
}

/**
 * True when the citizen's destination lies on one of the given tiles (e.g. the
 * occupied tiles of a bulldozed destination building).
 */
export function destinationIsOnTile(
  citizen: Citizen,
  tiles: readonly Point[],
): boolean {
  return tiles.some((tile) => samePoint(citizen.destination, tile));
}
