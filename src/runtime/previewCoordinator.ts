import type {
  GameBackend,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoutePreviewRequest,
  RoutePreviewResponse,
} from "./backend/types";

export interface PreviewCoordinator {
  requestRoute(
    request: RoutePreviewRequest,
  ): Promise<RoutePreviewResponse | null>;
  requestRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse | null>;
  invalidateRoute(): void;
  invalidateRoadMutation(): void;
}

export function createPreviewCoordinator(
  backend: GameBackend,
): PreviewCoordinator {
  let routeEpoch = 0;
  let roadEpoch = 0;
  let latestRouteGeneration: number | null = null;
  let latestRoadGeneration: number | null = null;

  return {
    async requestRoute(request) {
      const epoch = routeEpoch;
      latestRouteGeneration = request.generation;
      const response = await backend.previewRoute(request);
      return epoch === routeEpoch &&
        response.generation === latestRouteGeneration
        ? response
        : null;
    },
    async requestRoadMutation(request) {
      const epoch = roadEpoch;
      latestRoadGeneration = request.generation;
      const response = await backend.previewRoadMutation(request);
      return epoch === roadEpoch && response.generation === latestRoadGeneration
        ? response
        : null;
    },
    invalidateRoute() {
      routeEpoch += 1;
      latestRouteGeneration = null;
    },
    invalidateRoadMutation() {
      roadEpoch += 1;
      latestRoadGeneration = null;
    },
  };
}
