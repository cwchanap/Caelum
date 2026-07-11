import type { GameplayRejection } from "../domain/types";

const numberFormat = new Intl.NumberFormat("en-US");
const money = (value: number): string => numberFormat.format(value);

function assertNever(value: never): never {
  throw new Error("Unhandled rejection code: " + String(value));
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
    case "structureNotFound":
      return `${context.structureId ?? "That road structure"} no longer exists.`;
    case "invalidPlatform":
      return "That platform cannot serve this route.";
    case "invalidBuildingPlacement":
      return "That building cannot be placed on this footprint.";
    case "blockedFootprint":
      return "The full footprint must contain only empty or replaceable road tiles.";
    default:
      return assertNever(code);
  }
}
