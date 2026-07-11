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
      try {
        const response = await backend.previewRoute(request);
        return epoch === routeEpoch &&
          response.generation === latestRouteGeneration
          ? response
          : null;
      } catch (error) {
        if (
          epoch !== routeEpoch ||
          request.generation !== latestRouteGeneration
        ) {
          return null;
        }
        throw error;
      }
    },
    async requestRoadMutation(request) {
      const epoch = roadEpoch;
      latestRoadGeneration = request.generation;
      try {
        const response = await backend.previewRoadMutation(request);
        return epoch === roadEpoch &&
          response.generation === latestRoadGeneration
          ? response
          : null;
      } catch (error) {
        if (
          epoch !== roadEpoch ||
          request.generation !== latestRoadGeneration
        ) {
          return null;
        }
        throw error;
      }
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
