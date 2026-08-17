import type { GameplayRejection } from "../domain/types";
import type { RouteLegKind } from "../domain/types";
import type { CitySaveStoreOperation } from "../persistence/citySaveStore";
import type { GameplayWarning } from "./backend/types";
import type { RouteFailureRow } from "./types";
import type { WorkingSaveError } from "./workingSaveRuntime";

const numberFormat = new Intl.NumberFormat("en-US");
const money = (value: number): string => numberFormat.format(value);

function assertNever(value: never, label: string): string {
  // In dev/test, surface unknown codes immediately so a Rust/TS enum drift is
  // caught loudly. In production, fall back to a generic message instead of
  // throwing — a rejection toast must never crash the UI over an unrecognized
  // code that Rust may have added before TS caught up.
  if (import.meta.env.DEV) {
    throw new Error(`Unhandled ${label}: ${String(value)}`);
  }
  return "This action could not be completed.";
}

export function rejectionMessage(rejection: GameplayRejection): string {
  const { code, context } = rejection;
  switch (code) {
    case "insufficientBudget":
      return (
        "Needs $" +
        money(context.requiredBudget ?? 0) +
        "; only $" +
        money(context.availableBudget ?? 0) +
        " is available."
      );
    case "routeChangedWhileEditing":
      return "This route changed while you were editing it. Reload the saved route.";
    case "routeRevisionExhausted":
      return `${context.routeId ?? "That route"} cannot be edited because its revision ${numberFormat.format(context.actualRevision ?? 0)} is exhausted.`;
    case "disconnectedLeg":
      return `No legal path connects ${
        context.fromWaypointId ?? "the selected node"
      } to ${context.toWaypointId ?? "the next node"}.`;
    case "unsafeRoundaboutPortMapping":
      return "The roads crossing this footprint cannot map safely to roundabout ports.";
    case "invalidSpeed":
      return "That simulation speed is not supported.";
    case "blockedTile":
      return "That tile is blocked.";
    case "outOfBounds":
      return "That location is outside the map.";
    case "roadRequired":
      return "Build a road here first.";
    case "noRoadAccess":
      return "That stop has no road access.";
    case "trackRequired":
      return "Build track here first.";
    case "invalidRoadStroke":
      return "That road stroke has no valid tiles.";
    case "invalidTrackStroke":
      return "That track stroke has no valid tiles.";
    case "invalidDirectionChange":
      return "Change the approach lane; structure directions are automatic.";
    case "nodeAlreadyExists":
      return "A compatible transit node already occupies that anchor.";
    case "ambiguousTransitNode":
      return "More than one missing node matches this anchor; edit the route first.";
    case "missingRouteNode":
      return `${context.nodeId ?? "A route node"} is missing.`;
    case "incompatibleRouteNode":
      return `${context.nodeId ?? "That node"} is not compatible with this route mode.`;
    case "tooFewRouteNodes":
      return "A route needs at least two distinct live nodes.";
    case "duplicateRouteNodes":
      return "Each route waypoint must be distinct.";
    case "routeNotFound":
      return `${context.routeId ?? "That route"} no longer exists.`;
    case "inactiveRoute":
      return `${context.routeId ?? "That route"} is inactive.`;
    case "structureNotFound":
      return `${context.structureId ?? "That road structure"} no longer exists.`;
    case "invalidPlatform":
      return "That platform cannot serve this route.";
    case "invalidBuildingPlacement":
      return "That building cannot be placed on this footprint.";
    case "blockedFootprint":
      return "The full footprint must contain only empty or replaceable road tiles.";
    case "invalidHeadway":
      return "Headway must be at least 1 minute.";
    case "headwayNotSet":
      return "Set a target headway before deploying buses.";
    case "fleetAlreadyAssigned":
      return "This route already has a bus fleet.";
    default:
      return assertNever(code, "rejection code");
  }
}

export function routeFailureGuidance(
  reason: RouteFailureRow["reason"],
  context: { isLoopClosing: boolean; legKind: RouteLegKind },
): string {
  if (reason === "noLegalTurnaround") {
    return "No legal U-turn here; add a junction or roundabout.";
  }
  if (reason === "networkDisconnected" && context.isLoopClosing) {
    return "Loop can't close here; remove a stop or switch to Shuttle.";
  }
  if (
    reason === "networkDisconnected" &&
    context.legKind === "terminalReversal"
  ) {
    return "No turnaround path here; add a junction or roundabout nearby.";
  }
  if (reason === "noRoadAccess") {
    return "Stop has no adjacent road.";
  }
  if (reason === "noLegalEntryHeading" || reason === "noLegalExitHeading") {
    return "Road direction doesn't allow serving this stop here.";
  }
  if (reason === "missingNode") {
    return "Restore the missing node at its former location.";
  }
  return "Roads not connected between these stops.";
}

export function warningMessage(warning: GameplayWarning): string {
  const { code, context } = warning;
  switch (code) {
    case "existingBrokenLeg":
      return "This leg was already disconnected in the saved route.";
    case "skippedTiles":
      return "Some tiles were skipped.";
    case "routeWillReroute":
      return "This will reroute the saved path.";
    case "routeWillBreak":
      return "This will break the saved route.";
    default:
      return assertNever(code, "warning code");
  }
}

function cityStoreOperationMessage(operation: CitySaveStoreOperation): string {
  switch (operation) {
    case "listCities":
      return "Could not load the city list.";
    case "readCity":
      return "Could not load that city.";
    case "createCity":
      return "Could not save the new city.";
    case "updateCity":
      return "Could not save the city.";
    case "renameCity":
      return "Could not rename the city.";
    case "deleteCity":
      return "Could not delete the city.";
    default:
      return assertNever(operation, "city save operation");
  }
}

export function workingSaveErrorMessage(error: WorkingSaveError): string {
  switch (error.kind) {
    case "busy":
      return "Another city action is already in progress.";
    case "unavailable":
      return "City storage is unavailable.";
    case "noActiveCity":
      return "No city is active.";
    case "unsavedChanges":
      return "Pause and Save before switching cities.";
    case "sandbox":
      return "Could not create that city setup.";
    case "backend":
      return "Could not apply the city state.";
    case "store":
      return cityStoreOperationMessage(error.error.operation);
    default:
      return assertNever(error, "working-save error");
  }
}
