import type {
  GameState,
  Point,
  RouteLegPath,
  TransitPath,
  TripPosition,
} from "../domain/types";
import { AREA_LABELS } from "../domain/catalog/areas";
import { BUILDING_CATALOG } from "../domain/catalog/buildings";
import {
  buildRoadMutationPreview,
  selectRouteEditorView,
  selectRouteFailures,
} from "../runtime/runtimeSelectors";
import { rejectionMessage } from "../runtime/rejectionMessages";
import type { RoadMutationPreviewView } from "../runtime/types";
import type { UiState } from "../ui/uiState";
import { pointAndTangentAt } from "./pathGeometry";
import {
  canPlaceBuilding,
  getTile,
  isAreaPaintable,
  isBuildingAffordableForPresentation,
  isValidRoadPlacement,
  isValidTrackPlacement,
} from "./placementValidation";

/**
 * Renderer-neutral derivation of the map-local text overlay: every label the
 * Canvas transition draws (and the later DOM text overlay renders) with its
 * map-space anchor. No drawing primitives live here.
 */
export type MapTextOverlayItem =
  | {
      kind: "cursorBadge";
      anchor: Point;
      text: string;
      tone?: "warning";
    }
  | { kind: "routeWaypoint"; anchor: TripPosition; text: string }
  | { kind: "routeFailure"; anchor: TripPosition; text: string };

type CursorBadge = { text: string; tone?: "warning" };

/** The tile under the pointer: the drag's current tile while a gesture is
 *  active, otherwise the idle hover tile. */
function cursorTile(ui: UiState) {
  return ui.drag?.current ?? ui.hoverTile;
}

function hasUsefulPreview(preview: RoadMutationPreviewView): boolean {
  return (
    preview.cost > 0 ||
    preview.changedTiles.length > 0 ||
    preview.authoredTiles.length > 0 ||
    preview.generatedStructures.length > 0 ||
    preview.routeImpacts.length > 0
  );
}

function previewBadge(
  label: string,
  state: GameState,
  preview: RoadMutationPreviewView,
): CursorBadge {
  if (preview.rejection !== null) {
    return {
      text: `${label} · ${rejectionMessage(preview.rejection)} ⊘`,
      tone: "warning",
    };
  }
  if (!hasUsefulPreview(preview)) {
    return { text: label };
  }
  const impacts = [...preview.routeImpacts]
    .sort(compareRouteImpacts)
    .map((impact) => `${impact.routeName} ${impact.kind}`)
    .join(" · ");
  const cost =
    state.rules.economyPreset === "creative" ? "Free" : preview.costLabel;
  return {
    text: `${label} · ${cost}${impacts.length === 0 ? "" : ` · ${impacts}`}`,
  };
}

/** Tool/preset label shown on the cursor, or null when no badge applies. */
function cursorBadgeText(
  state: GameState,
  ui: UiState,
  preview: RoadMutationPreviewView | null,
): CursorBadge | null {
  const cursor = cursorTile(ui);
  if (cursor === null) {
    return null;
  }
  if (ui.selectedBuilding !== null) {
    const def = BUILDING_CATALOG[ui.selectedBuilding];
    const ok =
      isBuildingAffordableForPresentation(state, ui.selectedBuilding) &&
      canPlaceBuilding(state, ui.selectedBuilding, cursor, ui.buildingRotation);
    return { text: `⦿ ${def.label} ${ui.buildingRotation}°${ok ? "" : " ⊘"}` };
  }
  switch (ui.activeTool) {
    case "road": {
      const glyph =
        ui.roadPreset === "oneWay"
          ? " →"
          : ui.roadPreset === "dualBidirectional"
            ? " ⇄"
            : "";
      const label = `⦿ Road${glyph}`;
      if (preview !== null) {
        return previewBadge(label, state, preview);
      }
      const tile = getTile(state.map, cursor);
      // Bare roads can be cycled; structure-owned roads (junctions/roundabouts)
      // reject cycleRoadDirection, so exclude them from the existing-road fallback.
      const ok =
        isValidRoadPlacement(state, cursor) ||
        (tile?.kind === "road" && tile.roadStructureId === undefined);
      return { text: `${label}${ok ? "" : " ⊘"}` };
    }
    case "track":
      return {
        text: `⦿ Track${isValidTrackPlacement(state, cursor) ? "" : " ⊘"}`,
      };
    case "roundabout": {
      const sizeLabel = ui.roundaboutSize === "compact2x2" ? "2×2" : "3×3";
      const label = `⦿ Roundabout ${sizeLabel}`;
      if (preview === null) {
        return { text: `${label} …` };
      }
      return previewBadge(label, state, preview);
    }
    case "area": {
      if (ui.selectedArea === null) {
        return null;
      }
      const ok = isAreaPaintable(state, cursor);
      return {
        text: `⦿ Area ${AREA_LABELS[ui.selectedArea]}${ok ? "" : " ⊘"}`,
      };
    }
    case "remove": {
      const label = "⦿ Demolish";
      if (
        preview === null ||
        (preview.rejection !== null && ui.drag?.tool !== "remove")
      ) {
        return { text: label };
      }
      return previewBadge(label, state, preview);
    }
    default:
      return null;
  }
}

function compareRouteImpacts(
  left: RoadMutationPreviewView["routeImpacts"][number],
  right: RoadMutationPreviewView["routeImpacts"][number],
): number {
  if (left.kind !== right.kind) return left.kind === "broken" ? -1 : 1;
  if (left.routeName !== right.routeName) {
    return left.routeName < right.routeName ? -1 : 1;
  }
  return 0;
}

function transitNode(state: GameState, nodeId: string) {
  return (
    state.transit.stops.find((node) => node.id === nodeId) ??
    state.transit.stations.find((node) => node.id === nodeId)
  );
}

function pathMidpoint(path: TransitPath): TripPosition | null {
  if (path.steps.length === 0) {
    return null;
  }
  const target = path.totalTravelSeconds / 2;
  let elapsed = 0;
  // The midpoint always lands on some step; an inconsistent total clamps to
  // the last step's endpoint via the progress clamp below.
  let step = path.steps[path.steps.length - 1];
  let stepStart = 0;
  for (const candidate of path.steps) {
    step = candidate;
    stepStart = elapsed;
    elapsed += candidate.travelSeconds;
    if (target <= elapsed) {
      break;
    }
  }
  const progress =
    step.travelSeconds <= 0 ? 0.5 : (target - stepStart) / step.travelSeconds;
  return pointAndTangentAt(step.geometry, Math.max(0, Math.min(1, progress)))
    .point;
}

/** Marker anchor for a failed leg: the missing node when one side is missing,
 *  else the last-valid path midpoint, else the endpoint average. Shared with
 *  the Canvas marker pass so styling and text land on the same anchor. */
export function failedLegMarkerPoint(
  state: GameState,
  leg: RouteLegPath,
): TripPosition | null {
  const from = transitNode(state, leg.fromWaypointId);
  const to = transitNode(state, leg.toWaypointId);
  if (leg.status === "missingNode") {
    return (
      (from?.status === "missing" ? from.position : undefined) ??
      (to?.status === "missing" ? to.position : undefined) ??
      from?.position ??
      to?.position ??
      null
    );
  }
  if (leg.lastValidPath !== null) {
    return pathMidpoint(leg.lastValidPath);
  }
  return from !== undefined && to !== undefined
    ? {
        x: (from.position.x + to.position.x) / 2,
        y: (from.position.y + to.position.y) / 2,
      }
    : (from?.position ?? to?.position ?? null);
}

function routeFailureItems(
  state: GameState,
  ui: UiState,
): MapTextOverlayItem[] {
  if (ui.selectedRouteId === null) {
    return [];
  }
  const selected =
    state.transit.routes.find((route) => route.id === ui.selectedRouteId) ??
    state.transit.metroLines.find((line) => line.id === ui.selectedRouteId);
  if (selected === undefined) {
    return [];
  }
  const failureRows = selectRouteFailures(
    state,
    selected.pattern,
    "stopIds" in selected ? selected.stopIds : selected.stationIds,
    selected.legs,
  );
  const items: MapTextOverlayItem[] = [];
  selected.legs.forEach((leg, legIndex) => {
    if (leg.status === "connected") {
      return;
    }
    const failure = failureRows.find((row) => row.legIndex === legIndex);
    const marker = failedLegMarkerPoint(state, leg);
    if (failure === undefined || marker === null) {
      return;
    }
    items.push({
      kind: "routeFailure",
      anchor: marker,
      text: failure.guidance,
    });
  });
  return items;
}

function routeWaypointItems(
  state: GameState,
  ui: UiState,
): MapTextOverlayItem[] {
  const routeEditor = selectRouteEditorView(state, ui, null);
  if (routeEditor === null) {
    return [];
  }
  const nodePositions = new Map(
    [...state.transit.stops, ...state.transit.stations].map((node) => [
      node.id,
      node.position,
    ]),
  );
  const items: MapTextOverlayItem[] = [];
  for (const waypoint of routeEditor.waypoints) {
    const position = nodePositions.get(waypoint.id);
    if (!position) continue;
    items.push({
      kind: "routeWaypoint",
      anchor: position,
      text: String(waypoint.index + 1),
    });
  }
  return items;
}

export function selectMapTextOverlayItems(
  state: GameState,
  ui: UiState,
): MapTextOverlayItem[] {
  const items: MapTextOverlayItem[] = [];

  const cursor = cursorTile(ui);
  const preview = buildRoadMutationPreview(state, ui);
  const badge = cursorBadgeText(state, ui, preview);
  if (cursor !== null && badge !== null) {
    items.push({
      kind: "cursorBadge",
      anchor: cursor,
      ...badge,
    });
  }

  items.push(...routeWaypointItems(state, ui));

  items.push(...routeFailureItems(state, ui));

  return items;
}
