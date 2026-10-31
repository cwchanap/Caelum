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
  staleHeldRoadPreview,
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
      /** Spoken form of `text`: decorative glyphs (⦿, ⊘, …) are dropped or
       *  spelled out so the mirrored readout announces words, not symbols. */
      a11yText: string;
      tone?: "warning";
    }
  | { kind: "routeWaypoint"; anchor: TripPosition; text: string }
  | { kind: "routeFailure"; anchor: TripPosition; text: string };

type CursorBadge = Omit<
  Extract<MapTextOverlayItem, { kind: "cursorBadge" }>,
  "kind" | "anchor"
>;

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

/** The badge's spoken label: the decorative ⦿ marker is visual-only. */
function a11yLabel(label: string): string {
  return label.replace(/^⦿\s*/, "");
}

/** Local placement check rendered as a badge: ⊘ visually, "cannot place"
 *  when spoken. */
function placementBadge(label: string, ok: boolean): CursorBadge {
  return {
    text: `${label}${ok ? "" : " ⊘"}`,
    a11yText: `${a11yLabel(label)}${ok ? "" : ", cannot place"}`,
  };
}

/** Neutral badge while Rust's answer is still in flight: no verdict yet. */
function pendingBadge(label: string): CursorBadge {
  return {
    text: `${label} …`,
    a11yText: `${a11yLabel(label)}, preview pending`,
  };
}

function previewBadge(
  label: string,
  state: GameState,
  preview: RoadMutationPreviewView,
): CursorBadge {
  const name = a11yLabel(label);
  if (preview.rejection !== null) {
    const message = rejectionMessage(preview.rejection);
    return {
      text: `${label} · ${message} ⊘`,
      a11yText: `${name}, ${message} Cannot place.`,
      tone: "warning",
    };
  }
  if (!hasUsefulPreview(preview)) {
    return { text: label, a11yText: name };
  }
  const impacts = summarizeRouteImpacts(preview.routeImpacts);
  const spokenImpacts = describeRouteImpacts(preview.routeImpacts);
  const cost =
    preview.cost === 0 || state.rules.economyPreset === "creative"
      ? "Free"
      : preview.costLabel;
  return {
    text: `${label} · ${cost}${impacts.length === 0 ? "" : ` · ${impacts}`}`,
    a11yText: `${name}, ${cost}${spokenImpacts.length === 0 ? "" : `, ${spokenImpacts}`}`,
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
  // A held preview belongs to the request that produced it. During a drag
  // that request still describes the in-progress stroke, so a held accepted
  // answer stays — but idle hover has moved to a different tile entirely,
  // and a held rejection may blame a tile the stroke no longer reaches.
  // Both present as a neutral pending badge until the replacement lands.
  const staleHeldPreview = staleHeldRoadPreview(state, ui);
  if (ui.selectedBuilding !== null) {
    const def = BUILDING_CATALOG[ui.selectedBuilding];
    const ok =
      isBuildingAffordableForPresentation(state, ui.selectedBuilding) &&
      canPlaceBuilding(state, ui.selectedBuilding, cursor, ui.buildingRotation);
    return placementBadge(`⦿ ${def.label} ${ui.buildingRotation}°`, ok);
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
      if (staleHeldPreview) {
        return pendingBadge(label);
      }
      if (preview !== null) {
        return previewBadge(label, state, preview);
      }
      const tile = getTile(state.map, cursor);
      // Bare roads can be cycled; structure-owned roads (junctions/roundabouts)
      // reject cycleRoadDirection, so exclude them from the existing-road fallback.
      const ok =
        isValidRoadPlacement(state, cursor) ||
        (tile?.kind === "road" && tile.roadStructureId === undefined);
      return placementBadge(label, ok);
    }
    case "track":
      return placementBadge("⦿ Track", isValidTrackPlacement(state, cursor));
    case "roundabout": {
      const sizeLabel = ui.roundaboutSize === "compact2x2" ? "2×2" : "3×3";
      const label = `⦿ Roundabout ${sizeLabel}`;
      if (preview === null || staleHeldPreview) {
        return pendingBadge(label);
      }
      return previewBadge(label, state, preview);
    }
    case "area": {
      if (ui.selectedArea === null) {
        return null;
      }
      return placementBadge(
        `⦿ Area ${AREA_LABELS[ui.selectedArea]}`,
        isAreaPaintable(state, cursor),
      );
    }
    case "remove": {
      const label = "⦿ Demolish";
      // Idle hover suppresses demolish rejections; during a remove drag the
      // verdict is what the stroke will do, so it stays visible. A drag under
      // the remove tool is always a remove drag (tool switches clear the
      // gesture), so `drag === null` is the whole idle check.
      if (staleHeldPreview) {
        return pendingBadge(label);
      }
      if (
        preview === null ||
        (preview.rejection !== null && ui.drag === null)
      ) {
        return { text: label, a11yText: a11yLabel(label) };
      }
      return previewBadge(label, state, preview);
    }
    default:
      return null;
  }
}

const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

/** Player-authored route names are unbounded; cap on grapheme boundaries so
 *  the nowrap badge cannot overflow the clipped overlay *and* the cap never
 *  splits a surrogate pair or emoji sequence mid-glyph. */
function truncateGraphemes(text: string, max: number): string {
  const graphemes = Array.from(
    graphemeSegmenter.segment(text),
    (entry) => entry.segment,
  );
  return graphemes.length > max
    ? `${graphemes.slice(0, max - 1).join("")}…`
    : text;
}

/** Single impacts get the full cap; each name in a multi-impact row shares
 *  the badge, so it gets less room. */
const MAX_IMPACT_ROUTE_NAME = 24;
const MAX_MULTI_IMPACT_ROUTE_NAME = 16;
const MAX_NAMED_IMPACTS = 2;

function brokenFirst(
  impacts: RoadMutationPreviewView["routeImpacts"],
): RoadMutationPreviewView["routeImpacts"] {
  return [...impacts].sort(
    (a, b) => (a.kind === "broken" ? 0 : 1) - (b.kind === "broken" ? 0 : 1),
  );
}

/** Names the routes a stroke touches so the player can see which lines break
 *  before committing: a lone impact always fits its name; several name the
 *  first few (broken first) and count the rest to stay bounded. */
function summarizeRouteImpacts(
  impacts: RoadMutationPreviewView["routeImpacts"],
): string {
  if (impacts.length === 1) {
    const only = impacts[0]!;
    return `${truncateGraphemes(only.routeName, MAX_IMPACT_ROUTE_NAME)} ${only.kind}`;
  }
  const sorted = brokenFirst(impacts);
  const named = sorted
    .slice(0, MAX_NAMED_IMPACTS)
    .map(
      (impact) =>
        `${truncateGraphemes(impact.routeName, MAX_MULTI_IMPACT_ROUTE_NAME)} ${impact.kind}`,
    )
    .join(" · ");
  const rest = sorted.length - MAX_NAMED_IMPACTS;
  return rest > 0 ? `${named} · +${rest} more` : named;
}

/** Spoken impact list: names every affected route in plain words. The
 *  readout has no width bound, and counts alone would not say which lines
 *  break. */
function describeRouteImpacts(
  impacts: RoadMutationPreviewView["routeImpacts"],
): string {
  return brokenFirst(impacts)
    .map(
      (impact) =>
        `${impact.routeName} will ${impact.kind === "broken" ? "break" : "reroute"}`,
    )
    .join(", ");
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
