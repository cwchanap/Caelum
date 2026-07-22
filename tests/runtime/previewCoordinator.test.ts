import { describe, expect, it } from "vitest";
import type {
  GameBackend,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoutePreviewRequest,
  RoutePreviewResponse,
} from "../../src/runtime/backend/types";
import { createPreviewCoordinator } from "../../src/runtime/previewCoordinator";

interface PendingCall<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Backend whose `previewRoute` / `previewRoadMutation` promises are externally
 * resolvable so tests can interleave requests, invalidations, and settlements
 * in a deterministic order. The non-preview `GameBackend` members are unused by
 * the coordinator and throw if accidentally reached.
 */
function deferredBackend() {
  const routeCalls: PendingCall<RoutePreviewResponse>[] = [];
  const roadCalls: PendingCall<RoadMutationPreviewResponse>[] = [];

  const unused = (): never => {
    throw new Error("non-preview GameBackend member used by coordinator");
  };

  const backend = {
    snapshot: unused as unknown as GameBackend["snapshot"],
    dispatch: unused as unknown as GameBackend["dispatch"],
    tick: unused as unknown as GameBackend["tick"],
    reset: unused as unknown as GameBackend["reset"],
    previewRoute(_request: RoutePreviewRequest): Promise<RoutePreviewResponse> {
      return new Promise((resolve, reject) => {
        routeCalls.push({ resolve, reject });
      });
    },
    previewRoadMutation(
      _request: RoadMutationPreviewRequest,
    ): Promise<RoadMutationPreviewResponse> {
      return new Promise((resolve, reject) => {
        roadCalls.push({ resolve, reject });
      });
    },
  } satisfies GameBackend;

  return { backend, routeCalls, roadCalls };
}

function routeResponse(generation: number): RoutePreviewResponse {
  return {
    generation,
    legs: [],
    totalTravelSeconds: 0,
    initialVehicleCost: 0,
    affordable: true,
    turnSummary: {
      straight: 0,
      rightTurn: 0,
      leftTurn: 0,
      uTurn: 0,
      roundaboutEntry: 0,
    },
    missingWaypointIds: [],
    warnings: [],
    rejection: null,
  };
}

function roadResponse(generation: number): RoadMutationPreviewResponse {
  return {
    generation,
    changedTiles: [],
    authoredTiles: [],
    generatedStructures: [],
    cost: 0,
    skippedTiles: [],
    routeImpacts: [],
    warnings: [],
    rejection: null,
  };
}

function routeRequest(generation: number): RoutePreviewRequest {
  return {
    mode: "bus",
    pattern: "loop",
    waypointIds: ["stop-1", "stop-2"],
    routeId: null,
    expectedRevision: null,
    generation,
  };
}

function roadRequest(generation: number): RoadMutationPreviewRequest {
  return {
    mutation: { type: "layRoadLine", points: [], preset: "twoWay" },
    generation,
  };
}

describe("PreviewCoordinator", () => {
  describe("requestRoute — success branch", () => {
    it("returns the response when epoch and generation are still current", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoute(routeRequest(1));
      expect(routeCalls).toHaveLength(1);
      routeCalls[0].resolve(routeResponse(1));

      await expect(pending).resolves.toEqual(routeResponse(1));
    });

    it("suppresses a stale-generation response when a newer request supersedes it", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const first = coordinator.requestRoute(routeRequest(1));
      const second = coordinator.requestRoute(routeRequest(2));
      expect(routeCalls).toHaveLength(2);

      // Older request settles first; its generation no longer matches latest.
      routeCalls[0].resolve(routeResponse(1));
      await expect(first).resolves.toBeNull();

      routeCalls[1].resolve(routeResponse(2));
      await expect(second).resolves.toEqual(routeResponse(2));
    });

    it("suppresses a response whose backend-echoed generation differs from latest", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const first = coordinator.requestRoute(routeRequest(1));
      coordinator.requestRoute(routeRequest(2));

      // Backend echoes generation 1 for the first call, but latest is now 2.
      routeCalls[0].resolve(routeResponse(1));
      await expect(first).resolves.toBeNull();
    });

    it("suppresses a response after invalidateRoute bumps the epoch", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoute(routeRequest(1));
      coordinator.invalidateRoute();

      routeCalls[0].resolve(routeResponse(1));
      await expect(pending).resolves.toBeNull();
    });

    it("treats invalidateRoute as resetting latest generation to null", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoute(routeRequest(1));
      coordinator.invalidateRoute();
      // A post-invalidate response with generation 1 cannot match null latest.
      routeCalls[0].resolve(routeResponse(1));
      await expect(pending).resolves.toBeNull();
    });
  });

  describe("requestRoute — host-error branch (swallow vs fail)", () => {
    it("rethrows a host error when epoch and generation are still current", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoute(routeRequest(1));
      const hostError = new Error("backend down");
      routeCalls[0].reject(hostError);

      await expect(pending).rejects.toBe(hostError);
    });

    it("swallows a host error after invalidateRoute bumped the epoch", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoute(routeRequest(1));
      coordinator.invalidateRoute();
      routeCalls[0].reject(new Error("backend down"));

      await expect(pending).resolves.toBeNull();
    });

    it("swallows a host error when a newer request has superseded the generation", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const first = coordinator.requestRoute(routeRequest(1));
      coordinator.requestRoute(routeRequest(2));
      routeCalls[0].reject(new Error("backend down"));

      await expect(first).resolves.toBeNull();
    });

    it("does not let a stale error abort the current request's promise", async () => {
      const { backend, routeCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const first = coordinator.requestRoute(routeRequest(1));
      const second = coordinator.requestRoute(routeRequest(2));

      // Stale error on the superseded first call must not propagate to `second`.
      routeCalls[0].reject(new Error("stale backend down"));
      await expect(first).resolves.toBeNull();

      routeCalls[1].resolve(routeResponse(2));
      await expect(second).resolves.toEqual(routeResponse(2));
    });
  });

  describe("requestRoadMutation", () => {
    it("returns the response when epoch and generation are still current", async () => {
      const { backend, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoadMutation(roadRequest(5));
      roadCalls[0].resolve(roadResponse(5));

      await expect(pending).resolves.toEqual(roadResponse(5));
    });

    it("suppresses a stale-generation road response", async () => {
      const { backend, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const first = coordinator.requestRoadMutation(roadRequest(1));
      coordinator.requestRoadMutation(roadRequest(2));
      roadCalls[0].resolve(roadResponse(1));

      await expect(first).resolves.toBeNull();
    });

    it("rethrows a current road host error", async () => {
      const { backend, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoadMutation(roadRequest(1));
      const hostError = new Error("road backend down");
      roadCalls[0].reject(hostError);

      await expect(pending).rejects.toBe(hostError);
    });

    it("swallows a stale road host error after invalidateRoadMutation", async () => {
      const { backend, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const pending = coordinator.requestRoadMutation(roadRequest(1));
      coordinator.invalidateRoadMutation();
      roadCalls[0].reject(new Error("road backend down"));

      await expect(pending).resolves.toBeNull();
    });
  });

  describe("epoch independence", () => {
    it("invalidating route previews does not affect road previews", async () => {
      const { backend, routeCalls, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const routePending = coordinator.requestRoute(routeRequest(1));
      const roadPending = coordinator.requestRoadMutation(roadRequest(1));
      coordinator.invalidateRoute();

      // Route response is suppressed by the epoch bump...
      routeCalls[0].resolve(routeResponse(1));
      await expect(routePending).resolves.toBeNull();

      // ...but the road preview is unaffected and still resolves.
      roadCalls[0].resolve(roadResponse(1));
      await expect(roadPending).resolves.toEqual(roadResponse(1));
    });

    it("invalidating road previews does not affect route previews", async () => {
      const { backend, routeCalls, roadCalls } = deferredBackend();
      const coordinator = createPreviewCoordinator(backend);

      const routePending = coordinator.requestRoute(routeRequest(1));
      const roadPending = coordinator.requestRoadMutation(roadRequest(1));
      coordinator.invalidateRoadMutation();

      roadCalls[0].resolve(roadResponse(1));
      await expect(roadPending).resolves.toBeNull();

      routeCalls[0].resolve(routeResponse(1));
      await expect(routePending).resolves.toEqual(routeResponse(1));
    });
  });
});
