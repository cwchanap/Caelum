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

/** Shared epoch and generation validation for stale-response and stale-error
 *  suppression. Both `requestRoute` and `requestRoadMutation` use the same
 *  pattern: capture the epoch, set the latest generation, await the backend,
 *  and discard the result if the epoch or generation has advanced.
 *
 *  Implemented with `.then()` rather than `async/await` to avoid an extra
 *  microtask hop — the coordinator methods return this promise directly so
 *  callers observe the same resolution timing as an inlined `await`. */
function withEpochGuard<T extends { generation: number }>(
  epoch: number,
  currentEpoch: () => number,
  requestGeneration: number,
  latestGeneration: () => number | null,
  backendRequest: () => Promise<T>,
): Promise<T | null> {
  return backendRequest().then(
    (response) =>
      epoch === currentEpoch() && response.generation === latestGeneration()
        ? response
        : null,
    (error: unknown) => {
      if (
        epoch !== currentEpoch() ||
        requestGeneration !== latestGeneration()
      ) {
        return null;
      }
      throw error;
    },
  );
}

export function createPreviewCoordinator(
  backend: GameBackend,
): PreviewCoordinator {
  let routeEpoch = 0;
  let roadEpoch = 0;
  let latestRouteGeneration: number | null = null;
  let latestRoadGeneration: number | null = null;

  return {
    requestRoute(request) {
      const epoch = routeEpoch;
      latestRouteGeneration = request.generation;
      return withEpochGuard(
        epoch,
        () => routeEpoch,
        request.generation,
        () => latestRouteGeneration,
        () => backend.previewRoute(request),
      );
    },
    requestRoadMutation(request) {
      const epoch = roadEpoch;
      latestRoadGeneration = request.generation;
      return withEpochGuard(
        epoch,
        () => roadEpoch,
        request.generation,
        () => latestRoadGeneration,
        () => backend.previewRoadMutation(request),
      );
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
