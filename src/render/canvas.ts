import type { GameState } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { buildRoadMutationPreview } from "../runtime/runtimeSelectors";
import type { RoadMutationPreviewView } from "../runtime/types";
import { renderBuildings } from "./buildingRenderer";
import { getBoardTransform } from "./boardTransform";
import { renderCursorBadge } from "./cursorBadge";
import { renderMap } from "./mapRenderer";
import {
  renderOverlays,
  renderRoadPreviewFeedbackBadge,
  renderRouteDraftHandleOverlay,
} from "./overlayRenderer";
import { renderTransit } from "./transitRenderer";

export function renderGame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const transform = getBoardTransform(ctx.canvas, state.map);
  // Compute the road-mutation preview once per frame for the overlay
  // renderer's changed/skipped tiles. The feedback badge derives its own
  // wording/anchor from the shared map text overlay selector.
  const roadPreview: RoadMutationPreviewView | null = buildRoadMutationPreview(
    state,
    ui,
  );

  ctx.save();
  ctx.translate(transform.offsetX, transform.offsetY);
  ctx.scale(transform.scale, transform.scale);
  renderMap(ctx, state);
  renderBuildings(ctx, state);
  renderOverlays(ctx, state, ui, roadPreview);
  renderTransit(ctx, state, ui);
  renderRouteDraftHandleOverlay(ctx, state, ui);
  ctx.restore();

  renderRoadPreviewFeedbackBadge(ctx, state, ui, transform);
  renderCursorBadge(ctx, state, ui, transform);
}
