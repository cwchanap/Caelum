import { samePoint, type GameState, type Point } from "../domain/types";
import { axisLockedLine, rectanglePoints } from "../ui/roadDrag";
import type { UiState } from "../ui/uiState";
import type { GameIntent, RoadMutation } from "./backend/types";

/** Inclusive tile list a drag gesture mutates: an axis-locked line for road
 *  and track strokes, a row-major rectangle for remove. */
export function dragMutationPoints(
  tool: "road" | "track" | "remove",
  start: Point,
  current: Point,
): Point[] {
  return tool === "remove"
    ? rectanglePoints(start, current)
    : axisLockedLine(start, current);
}

/** A road click defers the lay-vs-cycle decision to whoever calls this: the
 *  tile kind is re-read against `state` at call time, so a tile that has
 *  become road routes to `cycleRoadDirection` instead of `layRoad`. */
export function roadClickIntent(state: GameState, point: Point): GameIntent {
  const tile = state.map.tiles.find(
    (candidate) => candidate.x === point.x && candidate.y === point.y,
  );
  return tile?.kind === "road"
    ? { type: "cycleRoadDirection", point }
    : { type: "layRoad", point };
}

export function roadClickMutation(
  state: GameState,
  point: Point,
): RoadMutation {
  const intent = roadClickIntent(state, point);
  return intent.type === "cycleRoadDirection"
    ? intent
    : { type: "layRoad", point };
}

/** The road mutation the given UI state implies right now — the in-progress
 *  drag stroke when one exists, otherwise the idle hover arm. This is the one
 *  derivation both the preview requester and the held-preview staleness check
 *  share, so "what would we ask for" can never drift between them. */
export function roadMutationForUi(
  state: GameState,
  candidate: UiState,
): RoadMutation | null {
  const gesture = candidate.drag;
  if (
    gesture !== null &&
    (gesture.tool === "road" || gesture.tool === "remove")
  ) {
    const points = dragMutationPoints(
      gesture.tool,
      gesture.start,
      gesture.current,
    );
    if (gesture.tool === "remove") {
      return points.length === 1
        ? { type: "removeAtTile", point: points[0] }
        : { type: "removeAtTiles", points };
    }
    return points.length === 1
      ? roadClickMutation(state, points[0])
      : { type: "layRoadLine", points, preset: candidate.roadPreset };
  }
  if (candidate.hoverTile === null) return null;
  if (candidate.activeTool === "road") {
    return roadClickMutation(state, candidate.hoverTile);
  }
  if (candidate.activeTool === "roundabout") {
    return {
      type: "placeRoundabout",
      origin: candidate.hoverTile,
      size: candidate.roundaboutSize,
    };
  }
  if (candidate.activeTool === "remove") {
    return { type: "removeAtTile", point: candidate.hoverTile };
  }
  return null;
}

/** Mutations that differ only in stroke extent share an identity; every other
 *  parameter (kind, preset, roundabout size) is part of it. A held answer only
 *  ever describes a mutation identical to or shorter-along-the-same-stroke
 *  than the current one. */
function mutationIdentity(mutation: RoadMutation): {
  key: string;
  points: Point[];
} {
  switch (mutation.type) {
    case "layRoad":
      return { key: "layRoad", points: [mutation.point] };
    case "layRoadLine":
      return {
        key: `layRoadLine:${mutation.preset}`,
        points: mutation.points,
      };
    case "cycleRoadDirection":
      return { key: "cycleRoadDirection", points: [mutation.point] };
    case "placeRoundabout":
      return {
        key: `placeRoundabout:${mutation.size}`,
        points: [mutation.origin],
      };
    case "removeAtTile":
      return { key: "removeAtTile", points: [mutation.point] };
    case "removeAtTiles":
      return { key: "removeAtTiles", points: mutation.points };
  }
}

/** Whether the mutation a held preview answered demonstrably describes a
 *  prefix of the mutation the pointer now implies: same identity (kind,
 *  preset, roundabout size) and the held point list is a leading slice of the
 *  current one. Extension keeps the earlier answer; retraction, axis
 *  switches, preset swaps, and kind changes all break it. Single-tile
 *  mutations only describe themselves. */
export function roadMutationIsPrefix(
  held: RoadMutation,
  current: RoadMutation,
): boolean {
  const heldIdentity = mutationIdentity(held);
  const currentIdentity = mutationIdentity(current);
  return (
    heldIdentity.key === currentIdentity.key &&
    heldIdentity.points.length <= currentIdentity.points.length &&
    heldIdentity.points.every((point, index) =>
      samePoint(point, currentIdentity.points[index]),
    )
  );
}
