import { describe, expect, it, vi } from "vitest";
import {
  samePoint,
  type GameMap,
  type GameplayRejection,
  type MetroLine,
  type Point,
  type RoadDirection,
  type Route,
  type RouteLegPath,
  type Stop,
} from "../../src/domain/types";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RoadMutationPreviewResponse,
  RoutePreviewResponse,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../src/runtime/types";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";
import { createTestGameState } from "../helpers/gameState";

const TEST_REJECTION: GameplayRejection = {
  code: "blockedTile",
  context: { affectedRouteIds: [] },
};

type BackendSpy = GameBackend & {
  intents: GameIntent[];
  rejectNextDispatch(): void;
  noopNextDispatch(): void;
  setSnapshot(next: RustGameSnapshot): void;
};

type DeferredDispatchBackend = BackendSpy & {
  rejectNextDispatchWith(rejection: GameplayRejection): void;
  failNextDispatch(error: Error): void;
  resolveNext(): Promise<void>;
};

function fullRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  const initial = createTestGameState();
  return createRustSnapshot({
    map: initial.map,
    budget: initial.budget,
    ...overrides,
  });
}

function updateTile(
  map: GameMap,
  point: Point,
  update: (tile: GameMap["tiles"][number]) => GameMap["tiles"][number],
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? update(tile) : tile,
    ),
  };
}

function roadDirectionForPreset(
  preset: "twoWay" | "oneWay" | "dualBidirectional",
): RoadDirection | undefined {
  return preset === "twoWay" ? undefined : "east";
}

function createStop(id: string, position: Point): Stop {
  return {
    id,
    kind: "busStop",
    status: "present",
    position,
    platforms: [
      {
        id: `${id}-p1`,
        label: "A",
        capacity: 30,
        routeIds: [],
      },
    ],
  };
}

function previewLeg(
  fromWaypointId: string,
  toWaypointId: string,
  status: "connected" | "networkDisconnected" = "connected",
) {
  return {
    fromWaypointId,
    toWaypointId,
    direction: "loop" as const,
    kind: "service" as const,
    status,
    currentPath: null,
    lastValidPath: null,
    estimatedSeconds: status === "connected" ? 1 : null,
    failureReason: null,
  };
}

function routePreview(
  generation: number,
  waypointIds: string[],
  status: "connected" | "networkDisconnected" = "connected",
): RoutePreviewResponse {
  return {
    generation,
    legs:
      waypointIds.length < 2
        ? []
        : waypointIds.map((id, index) =>
            previewLeg(
              id,
              waypointIds[(index + 1) % waypointIds.length],
              status,
            ),
          ),
    totalTravelSeconds: status === "connected" ? waypointIds.length : 0,
    initialVehicleCost: 8_000,
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
    rejection:
      status === "connected"
        ? null
        : {
            code: "disconnectedLeg",
            context: { affectedRouteIds: [] },
          },
  };
}

function routeLegProjection(leg: RouteLegPath) {
  return {
    legKey: {
      fromWaypointId: leg.fromWaypointId,
      toWaypointId: leg.toWaypointId,
      direction: leg.direction,
      kind: leg.kind,
    },
    status: leg.status,
    failureReason: leg.failureReason,
    pathSteps: leg.currentPath?.steps ?? null,
    travelSeconds: leg.estimatedSeconds,
  };
}

function roadPreview(
  generation: number,
  point: Point,
): RoadMutationPreviewResponse {
  return {
    generation,
    changedTiles: [point],
    authoredTiles: [
      {
        point,
        oneWay: null,
        roadConnections: [],
        roadStructureId: null,
      },
    ],
    generatedStructures: [],
    cost: 100,
    skippedTiles: [],
    routeImpacts: [],
    warnings: [],
    rejection: null,
  };
}

function roundaboutPreview(
  generation: number,
  origin: Point,
  size: "compact2x2" | "standard3x3" = "compact2x2",
): RoadMutationPreviewResponse {
  const width = size === "compact2x2" ? 2 : 3;
  const footprint = Array.from({ length: width * width }, (_, index) => ({
    x: origin.x + (index % width),
    y: origin.y + Math.floor(index / width),
  }));
  return {
    generation,
    changedTiles: footprint,
    authoredTiles: [],
    generatedStructures: [
      {
        kind: "roundabout",
        id: "roundabout-preview",
        origin,
        size,
        footprint,
        ports: [],
      },
    ],
    cost: size === "compact2x2" ? 1_000 : 2_000,
    skippedTiles: [],
    routeImpacts: [],
    warnings: [],
    rejection: null,
  };
}

function reassignRouteToPlatform<
  T extends { id: string; platforms: Stop["platforms"] },
>(nodes: T[], nodeId: string, routeId: string, platformId: string): T[] {
  return nodes.map((node) => {
    if (node.id !== nodeId) {
      return node;
    }
    return {
      ...node,
      platforms: node.platforms.map((platform) => ({
        ...platform,
        routeIds:
          platform.id === platformId
            ? [...platform.routeIds, routeId]
            : platform.routeIds.filter((id) => id !== routeId),
      })),
    };
  });
}

function applyIntent(
  snapshot: RustGameSnapshot,
  intent: GameIntent,
): RustGameSnapshot {
  if (intent.type === "setPaused") {
    return { ...snapshot, paused: intent.paused };
  }
  if (intent.type === "setSpeed") {
    return { ...snapshot, speed: intent.speed };
  }
  if (intent.type === "layRoad") {
    return {
      ...snapshot,
      map: updateTile(snapshot.map, intent.point, (tile) => ({
        ...tile,
        kind: "road",
      })),
    };
  }
  if (intent.type === "cycleRoadDirection") {
    return {
      ...snapshot,
      map: updateTile(snapshot.map, intent.point, (tile) => ({
        ...tile,
        oneWay: tile.oneWay === undefined ? "north" : undefined,
      })),
    };
  }
  if (intent.type === "layRoadLine") {
    const oneWay = roadDirectionForPreset(intent.preset);
    return {
      ...snapshot,
      map: intent.points.reduce(
        (map, point) =>
          updateTile(map, point, (tile) => ({
            ...tile,
            kind: "road",
            oneWay,
          })),
        snapshot.map,
      ),
    };
  }
  if (intent.type === "layTrackLine") {
    return {
      ...snapshot,
      map: intent.points.reduce(
        (map, point) =>
          updateTile(map, point, (tile) => ({
            ...tile,
            hasTrack: true,
          })),
        snapshot.map,
      ),
    };
  }
  if (intent.type === "removeAtTiles") {
    return {
      ...snapshot,
      map: intent.points.reduce(
        (map, point) =>
          updateTile(map, point, (tile) => {
            const { oneWay: _oneWay, ...rest } = tile;
            return { ...rest, kind: "empty", hasTrack: false };
          }),
        snapshot.map,
      ),
    };
  }
  if (intent.type === "paintAreaRectangle") {
    const minX = Math.min(intent.start.x, intent.end.x);
    const maxX = Math.max(intent.start.x, intent.end.x);
    const minY = Math.min(intent.start.y, intent.end.y);
    const maxY = Math.max(intent.start.y, intent.end.y);
    return {
      ...snapshot,
      map: {
        ...snapshot.map,
        tiles: snapshot.map.tiles.map((tile) =>
          tile.x >= minX && tile.x <= maxX && tile.y >= minY && tile.y <= maxY
            ? { ...tile, area: intent.area }
            : tile,
        ),
      },
    };
  }
  if (intent.type === "addBusStop") {
    const id = `stop-${(snapshot.transit.stops.length + 1)
      .toString()
      .padStart(3, "0")}`;
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        stops: [...snapshot.transit.stops, createStop(id, intent.point)],
      },
    };
  }
  if (intent.type === "placeBuilding") {
    return {
      ...snapshot,
      buildings: [
        ...snapshot.buildings,
        {
          id: `building-${(snapshot.buildings.length + 1)
            .toString()
            .padStart(3, "0")}`,
          type: intent.buildingType,
          origin: intent.origin,
          rotation: intent.rotation,
          occupiedTiles: [intent.origin],
        },
      ],
    };
  }
  if (intent.type === "createRoute" && intent.mode === "bus") {
    const id = `route-${(snapshot.transit.routes.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const vehicleId = `vehicle-${(snapshot.transit.vehicles.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const route: Route = {
      id,
      name: `Bus ${snapshot.transit.routes.length + 1}`,
      color: "#2563eb",
      stopIds: intent.waypointIds,
      vehicleIds: [vehicleId],
      active: true,
      pattern: intent.pattern,
      revision: 0,
      legs: [],
      pathBroken: false,
    };
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: [...snapshot.transit.routes, route],
        vehicles: [
          ...snapshot.transit.vehicles,
          {
            id: vehicleId,
            mode: "bus",
            lineId: id,
            capacity: 18,
            passengerIds: [],
            itineraryIndex: 0,
            pathStepIndex: 0,
            stepProgress: 0,
            parkedPosition: null,
          },
        ],
      },
    };
  }
  if (intent.type === "updateRoute") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: snapshot.transit.routes.map((route) =>
          route.id === intent.routeId
            ? {
                ...route,
                stopIds: intent.waypointIds,
                pattern: intent.pattern,
                revision: route.revision + 1,
              }
            : route,
        ),
        metroLines: snapshot.transit.metroLines.map((line) =>
          line.id === intent.routeId
            ? {
                ...line,
                stationIds: intent.waypointIds,
                pattern: intent.pattern,
                revision: line.revision + 1,
              }
            : line,
        ),
      },
    };
  }
  if (intent.type === "renameRoute") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: snapshot.transit.routes.map((route) =>
          route.id === intent.routeId ? { ...route, name: intent.name } : route,
        ),
      },
    };
  }
  if (intent.type === "recolorRoute") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: snapshot.transit.routes.map((route) =>
          route.id === intent.routeId
            ? { ...route, color: intent.color }
            : route,
        ),
      },
    };
  }
  if (intent.type === "setRouteActive") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: snapshot.transit.routes.map((route) =>
          route.id === intent.routeId
            ? { ...route, active: intent.active }
            : route,
        ),
      },
    };
  }
  if (intent.type === "deleteRoute") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: snapshot.transit.routes.filter(
          (route) => route.id !== intent.routeId,
        ),
      },
    };
  }
  if (intent.type === "layTrack") {
    return {
      ...snapshot,
      map: updateTile(snapshot.map, intent.point, (tile) => ({
        ...tile,
        hasTrack: true,
      })),
    };
  }
  if (intent.type === "removeAtTile") {
    return {
      ...snapshot,
      map: updateTile(snapshot.map, intent.point, (tile) => {
        const { oneWay: _oneWay, ...rest } = tile;
        return { ...rest, kind: "empty", hasTrack: false };
      }),
    };
  }
  if (intent.type === "addMetroStation") {
    const id = `station-${(snapshot.transit.stations.length + 1)
      .toString()
      .padStart(3, "0")}`;
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        stations: [
          ...snapshot.transit.stations,
          {
            id,
            status: "present",
            position: intent.point,
            platforms: [
              { id: `${id}-p0`, label: "A", capacity: 300, routeIds: [] },
              { id: `${id}-p1`, label: "B", capacity: 300, routeIds: [] },
            ],
          },
        ],
      },
    };
  }
  if (intent.type === "createRoute" && intent.mode === "metro") {
    const id = `metro-${(snapshot.transit.metroLines.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const vehicleId = `vehicle-${(snapshot.transit.vehicles.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const line: MetroLine = {
      id,
      name: `Metro ${snapshot.transit.metroLines.length + 1}`,
      color: "#2867b2",
      stationIds: intent.waypointIds,
      vehicleIds: [vehicleId],
      active: true,
      pattern: intent.pattern,
      revision: 0,
      legs: [],
      pathBroken: false,
    };
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        metroLines: [...snapshot.transit.metroLines, line],
        vehicles: [
          ...snapshot.transit.vehicles,
          {
            id: vehicleId,
            mode: "metro",
            lineId: id,
            capacity: 90,
            passengerIds: [],
            itineraryIndex: 0,
            pathStepIndex: 0,
            stepProgress: 0,
            parkedPosition: null,
          },
        ],
      },
    };
  }
  if (intent.type === "assignVehicle") {
    // Mirrors `caelum-core::transit::assign_vehicle`: append a vehicle and
    // link it back onto the matching route/metroLine `vehicleIds`.
    const id = `vehicle-${(snapshot.transit.vehicles.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const vehicle = {
      id,
      mode: intent.mode,
      lineId: intent.lineId,
      capacity: intent.mode === "bus" ? 30 : 120,
      passengerIds: [],
      itineraryIndex: 0,
      pathStepIndex: 0,
      stepProgress: 0,
      parkedPosition: null,
    };
    const transit =
      intent.mode === "bus"
        ? {
            ...snapshot.transit,
            vehicles: [...snapshot.transit.vehicles, vehicle],
            routes: snapshot.transit.routes.map((route) =>
              route.id === intent.lineId
                ? { ...route, vehicleIds: [...route.vehicleIds, id] }
                : route,
            ),
          }
        : {
            ...snapshot.transit,
            vehicles: [...snapshot.transit.vehicles, vehicle],
            metroLines: snapshot.transit.metroLines.map((line) =>
              line.id === intent.lineId
                ? { ...line, vehicleIds: [...line.vehicleIds, id] }
                : line,
            ),
          };
    return { ...snapshot, transit };
  }
  if (intent.type === "assignRouteToPlatform") {
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        stops: reassignRouteToPlatform(
          snapshot.transit.stops,
          intent.nodeId,
          intent.routeId,
          intent.platformId,
        ),
        stations: reassignRouteToPlatform(
          snapshot.transit.stations,
          intent.nodeId,
          intent.routeId,
          intent.platformId,
        ),
      },
    };
  }
  if (intent.type === "placeRoundabout") {
    const span = intent.size === "compact2x2" ? 2 : 3;
    const footprint = Array.from({ length: span * span }, (_, index) => ({
      x: intent.origin.x + (index % span),
      y: intent.origin.y + Math.floor(index / span),
    }));
    const structureId = `roundabout-${snapshot.map.roadStructures.length + 1}`;
    const inFootprint = new Set(footprint.map((p) => `${p.x},${p.y}`));
    return {
      ...snapshot,
      map: {
        ...snapshot.map,
        tiles: snapshot.map.tiles.map((tile) =>
          inFootprint.has(`${tile.x},${tile.y}`)
            ? { ...tile, kind: "road" as const, roadStructureId: structureId }
            : tile,
        ),
        roadStructures: [
          ...snapshot.map.roadStructures,
          {
            kind: "roundabout" as const,
            id: structureId,
            origin: intent.origin,
            size: intent.size,
            footprint,
            ports: [],
          },
        ],
      },
    };
  }
  if (intent.type === "setBudget") {
    return { ...snapshot, budget: intent.budget };
  }
  throw new Error(
    `fake backend applyIntent: unhandled intent type "${intent.type}" — add a handler or the dispatch silently no-ops`,
  );
}

function deferredDispatchBackend(
  initial: RustGameSnapshot = fullRustSnapshot(),
): DeferredDispatchBackend {
  const intents: GameIntent[] = [];
  const pending: Array<() => void> = [];
  let snapshot = initial;
  let nextRejection: GameplayRejection | null = null;
  let nextError: Error | null = null;

  return {
    ...previewBackendStubs(),
    intents,
    rejectNextDispatch() {
      nextRejection = TEST_REJECTION;
    },
    noopNextDispatch() {
      // Deferred backend doesn't simulate no-op dispatches; provided for
      // BackendSpy interface conformance.
    },
    rejectNextDispatchWith(rejection) {
      nextRejection = rejection;
    },
    failNextDispatch(error) {
      nextError = error;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    async snapshot() {
      return snapshot;
    },
    async previewRoute(request) {
      return routePreview(request.generation, request.waypointIds);
    },
    async dispatch(intent): Promise<DispatchResult> {
      intents.push(intent);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      if (nextError !== null) {
        const error = nextError;
        nextError = null;
        throw error;
      }
      if (nextRejection !== null) {
        const rejection = nextRejection;
        nextRejection = null;
        return {
          snapshot,
          applied: false,
          rejection,
          context: {
            changedTiles: [],
            skippedTiles: [],
            affectedRouteIds: [],
            cost: 0,
          },
        };
      }
      snapshot = applyIntent(snapshot, intent);
      return {
        snapshot,
        applied: true,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    },
    async tick(deltaSeconds): Promise<DispatchResult> {
      const before = snapshot;
      snapshot =
        snapshot.paused || snapshot.speed === 0
          ? snapshot
          : {
              ...snapshot,
              time: snapshot.time + deltaSeconds * snapshot.speed,
            };
      return {
        snapshot,
        applied: snapshot !== before,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    },
    async reset() {
      snapshot = fullRustSnapshot();
      return snapshot;
    },
    async resolveNext() {
      const resolve = pending.shift();
      if (resolve === undefined) {
        throw new Error("No pending dispatch");
      }
      resolve();
      await Promise.resolve();
    },
  };
}

function backendSpy(
  initial: RustGameSnapshot = fullRustSnapshot(),
): BackendSpy {
  const intents: GameIntent[] = [];
  let snapshot = initial;
  let rejectNext = false;
  let noopNext = false;

  return {
    ...previewBackendStubs(),
    intents,
    rejectNextDispatch() {
      rejectNext = true;
    },
    noopNextDispatch() {
      noopNext = true;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    async snapshot() {
      return snapshot;
    },
    async previewRoute(request) {
      return routePreview(request.generation, request.waypointIds);
    },
    async dispatch(intent): Promise<DispatchResult> {
      intents.push(intent);
      if (rejectNext) {
        rejectNext = false;
        return {
          snapshot,
          applied: false,
          rejection: TEST_REJECTION,
          context: {
            changedTiles: [],
            skippedTiles: [],
            affectedRouteIds: [],
            cost: 0,
          },
        };
      }
      if (noopNext) {
        noopNext = false;
        return {
          snapshot,
          applied: false,
          rejection: null,
          context: {
            changedTiles: [],
            skippedTiles: [],
            affectedRouteIds: [],
            cost: 0,
          },
        };
      }
      snapshot = applyIntent(snapshot, intent);
      return {
        snapshot,
        applied: true,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    },
    async tick(deltaSeconds): Promise<DispatchResult> {
      const before = snapshot;
      snapshot =
        snapshot.paused || snapshot.speed === 0
          ? snapshot
          : {
              ...snapshot,
              time: snapshot.time + deltaSeconds * snapshot.speed,
            };
      return {
        snapshot,
        applied: snapshot !== before,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    },
    async reset() {
      snapshot = fullRustSnapshot();
      return snapshot;
    },
  };
}

function deferredPreviewBackend(initial: RustGameSnapshot) {
  const base = backendSpy(initial);
  const routeResolvers = new Map<
    number,
    Array<{
      resolve: (response: RoutePreviewResponse) => void;
      reject: (error: Error) => void;
    }>
  >();
  const roadResolvers = new Map<
    number,
    {
      resolve: (response: RoadMutationPreviewResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  const roadRequestGenerations: number[] = [];
  const backend: BackendSpy = {
    ...base,
    previewRoute(request) {
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        routeResolvers.set(request.generation, [
          ...(routeResolvers.get(request.generation) ?? []),
          entry,
        ]);
      });
    },
    previewRoadMutation(request) {
      roadRequestGenerations.push(request.generation);
      return new Promise((resolve, reject) => {
        roadResolvers.set(request.generation, { resolve, reject });
      });
    },
  };
  return {
    backend,
    roadRequestGenerations,
    resolveRoute(
      generation: number,
      response: RoutePreviewResponse,
      requestIndex = 0,
    ) {
      const entry = routeResolvers.get(generation)?.[requestIndex];
      if (entry === undefined)
        throw new Error(`No route generation ${generation}`);
      entry.resolve(response);
    },
    rejectRoute(generation: number, error: Error, requestIndex = 0) {
      const entry = routeResolvers.get(generation)?.[requestIndex];
      if (entry === undefined)
        throw new Error(`No route generation ${generation}`);
      entry.reject(error);
    },
    resolveRoad(generation: number, response: RoadMutationPreviewResponse) {
      const deferred = roadResolvers.get(generation);
      if (deferred === undefined)
        throw new Error(`No road generation ${generation}`);
      deferred.resolve(response);
    },
    rejectRoad(generation: number, error: Error) {
      const deferred = roadResolvers.get(generation);
      if (deferred === undefined)
        throw new Error(`No road generation ${generation}`);
      deferred.reject(error);
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Game Runtime", () => {
  it("ignores an older route preview that resolves after the current generation", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [
          createStop("stop-0001", { x: 1, y: 1 }),
          createStop("stop-0002", { x: 2, y: 1 }),
          createStop("stop-0003", { x: 3, y: 1 }),
        ],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const routePreviews = deferredPreviewBackend(initial);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: routePreviews.backend,
    });

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    runtime.handleTileClick({ x: 2, y: 1 });
    runtime.handleTileClick({ x: 3, y: 1 });

    routePreviews.resolveRoute(
      3,
      routePreview(3, ["stop-0001", "stop-0002", "stop-0003"]),
    );
    routePreviews.resolveRoute(
      2,
      routePreview(2, ["stop-0001", "stop-0002"], "networkDisconnected"),
    );
    await flushPromises();

    expect(runtime.getSnapshot().ui.routeDraft?.generation).toBe(3);
    expect(runtime.getSnapshot().ui.routeDraft?.preview?.generation).toBe(3);
    expect(runtime.getSnapshot().shell.routeDraft?.canSave).toBe(true);
  });

  it("suppresses a response from an older draft instance with the same generation", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [createStop("stop-0001", { x: 1, y: 1 })],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const previews = deferredPreviewBackend(initial);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    const firstInstance = runtime.getSnapshot().ui.routeDraft?.instanceId;
    runtime.cancelRouteDraft();
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    const secondInstance = runtime.getSnapshot().ui.routeDraft?.instanceId;
    expect(secondInstance).not.toBe(firstInstance);

    // Both requests use generation 1. The response for the cancelled draft
    // must not be allowed to populate the fresh draft.
    previews.resolveRoute(1, routePreview(1, ["stop-0001"]), 0);
    await flushPromises();
    expect(runtime.getSnapshot().ui.routeDraft?.instanceId).toBe(
      secondInstance,
    );
    expect(runtime.getSnapshot().ui.routeDraft?.preview).toBeNull();
  });

  it("ignores a pending route preview after the runtime stops", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [createStop("stop-0001", { x: 1, y: 1 })],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const previews = deferredPreviewBackend(initial);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });
    const listener = vi.fn();
    runtime.subscribe(listener);

    runtime.start();
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    runtime.stop();
    listener.mockClear();
    previews.resolveRoute(1, routePreview(1, ["stop-0001"]));
    await flushPromises();

    expect(runtime.getSnapshot().ui.routeDraft?.preview).toBeNull();
    // The invalidated response is ignored (no preview applied), but
    // previewPending is cleared so the draft is not stranded in
    // "Checking route…" after stop().
    expect(runtime.getSnapshot().ui.routeDraft?.previewPending).toBe(false);
  });

  it("runs route previews outside the gameplay dispatch queue", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [createStop("stop-0001", { x: 1, y: 1 })],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const base = backendSpy(initial);
    const dispatch = vi.fn(base.dispatch.bind(base));
    const previewRoute = vi.fn(
      () => new Promise<RoutePreviewResponse>(() => undefined),
    );
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, dispatch, previewRoute },
    });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });

    await expect(runtime.togglePause()).resolves.toMatchObject({
      state: { paused: false },
    });
    expect(previewRoute).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "setPaused", paused: false });
  });

  it("ignores road generation 1 after generation 2 is current", async () => {
    const previews = deferredPreviewBackend(fullRustSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.previewRoadMutation({ type: "layRoad", point: { x: 5, y: 5 } });
    runtime.previewRoadMutation({ type: "layRoad", point: { x: 6, y: 5 } });
    previews.resolveRoad(2, roadPreview(2, { x: 6, y: 5 }));
    previews.resolveRoad(1, roadPreview(1, { x: 5, y: 5 }));
    await flushPromises();

    expect(runtime.getSnapshot().ui.roadMutationPreview?.generation).toBe(2);
    expect(runtime.getSnapshot().ui.roadMutationPreview?.changedTiles).toEqual([
      { x: 6, y: 5 },
    ]);
  });

  it("keeps route and road preview counters independent when resolves interleave out of order", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [
          createStop("stop-0001", { x: 1, y: 1 }),
          createStop("stop-0002", { x: 2, y: 1 }),
          createStop("stop-0003", { x: 3, y: 1 }),
        ],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const previews = deferredPreviewBackend(initial);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    runtime.handleTileClick({ x: 2, y: 1 });
    // route gen 2 pending (two appends)
    runtime.previewRoadMutation({ type: "layRoad", point: { x: 5, y: 5 } });
    // road gen 1 pending
    runtime.handleTileClick({ x: 3, y: 1 });
    // route gen 3 pending
    runtime.previewRoadMutation({ type: "layRoad", point: { x: 6, y: 5 } });
    // road gen 2 pending

    expect(runtime.getSnapshot().ui.routeDraft?.generation).toBe(3);
    expect(runtime.getSnapshot().ui.roadPreviewGeneration).toBe(2);

    // Resolve in reverse/mixed order: older route, older road, then current of each.
    previews.resolveRoute(
      2,
      routePreview(2, ["stop-0001", "stop-0002"], "networkDisconnected"),
    );
    previews.resolveRoad(1, roadPreview(1, { x: 5, y: 5 }));
    previews.resolveRoute(
      3,
      routePreview(3, ["stop-0001", "stop-0002", "stop-0003"]),
    );
    previews.resolveRoad(2, roadPreview(2, { x: 6, y: 5 }));
    await flushPromises();

    expect(runtime.getSnapshot().ui.routeDraft?.generation).toBe(3);
    expect(runtime.getSnapshot().ui.routeDraft?.preview?.generation).toBe(3);
    expect(runtime.getSnapshot().ui.routeDraft?.preview?.legs).toHaveLength(3);
    expect(runtime.getSnapshot().ui.roadMutationPreview?.generation).toBe(2);
    expect(runtime.getSnapshot().ui.roadMutationPreview?.changedTiles).toEqual([
      { x: 6, y: 5 },
    ]);
    expect(runtime.getSnapshot().shell.routeDraft?.canSave).toBe(true);
  });

  it("clears and invalidates the road hover preview on click so a stale response cannot repopulate it", async () => {
    const previews = deferredPreviewBackend(fullRustSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    // Resolve a road hover preview so the overlay is showing stale changed
    // tiles / cost / route impacts at the moment of the click.
    runtime.setTool("road");
    runtime.setHoverTile({ x: 5, y: 5 });
    previews.resolveRoad(1, roadPreview(1, { x: 5, y: 5 }));
    await flushPromises();
    expect(runtime.getSnapshot().ui.roadMutationPreview?.generation).toBe(1);

    // The click dispatches a road mutation that changes the map. The resolved
    // hover preview is now stale and must be cleared synchronously, before the
    // dispatch enqueues, so renderOverlays does not draw the old overlay over
    // the new map.
    runtime.handleTileClick({ x: 5, y: 5 });
    const afterClick = runtime.getSnapshot();
    expect(afterClick.ui.roadMutationPreview).toBeNull();
    expect(afterClick.ui.roadMutationPreviewError).toBeNull();

    // An in-flight preview response for the invalidated request must not
    // repopulate the stale preview. Hover a new tile to start gen 2, click to
    // invalidate it, then resolve gen 2 — the preview must stay null.
    runtime.setHoverTile({ x: 6, y: 5 });
    expect(previews.roadRequestGenerations).toContain(2);
    runtime.handleTileClick({ x: 6, y: 5 });
    expect(runtime.getSnapshot().ui.roadMutationPreview).toBeNull();
    previews.resolveRoad(2, roadPreview(2, { x: 6, y: 5 }));
    await flushPromises();
    expect(runtime.getSnapshot().ui.roadMutationPreview).toBeNull();
  });

  it("arms a click tool and never starts a drag gesture", async () => {
    const base = backendSpy();
    const previewRoadMutation = vi.fn(base.previewRoadMutation.bind(base));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, previewRoadMutation },
    });
    runtime.armRoundabout("compact2x2");
    runtime.startDrag({ x: 10, y: 8 });
    runtime.setHoverTile({ x: 12, y: 10 });

    expect(runtime.getSnapshot().ui.activeTool).toBe("roundabout");
    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(previewRoadMutation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mutation: {
          type: "placeRoundabout",
          origin: { x: 12, y: 10 },
          size: "compact2x2",
        },
      }),
    );
  });

  it("previews the selected stamp when armed over an existing hover tile", async () => {
    const base = backendSpy();
    const previewRoadMutation = vi.fn(base.previewRoadMutation.bind(base));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, previewRoadMutation },
    });

    runtime.setHoverTile({ x: 4, y: 3 });
    runtime.armRoundabout("standard3x3");

    expect(previewRoadMutation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mutation: {
          type: "placeRoundabout",
          origin: { x: 4, y: 3 },
          size: "standard3x3",
        },
      }),
    );
  });

  it("click dispatches the exact intent but Rust revalidates it", async () => {
    const base = backendSpy();
    const dispatch = vi.fn(base.dispatch.bind(base));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, dispatch },
    });
    runtime.armRoundabout("standard3x3");
    await runtime.handleTileClick({ x: 7, y: 6 });
    expect(dispatch).toHaveBeenCalledWith({
      type: "placeRoundabout",
      origin: { x: 7, y: 6 },
      size: "standard3x3",
    });
  });

  it("keeps only the latest roundabout hover preview", async () => {
    const previews = deferredPreviewBackend(fullRustSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.armRoundabout("compact2x2");
    runtime.setHoverTile({ x: 5, y: 5 });
    runtime.setHoverTile({ x: 8, y: 7 });
    previews.resolveRoad(2, roundaboutPreview(2, { x: 8, y: 7 }));
    previews.resolveRoad(1, roundaboutPreview(1, { x: 5, y: 5 }));
    await flushPromises();

    expect(runtime.getSnapshot().ui.roadMutationPreview).toMatchObject({
      generation: 2,
      changedTiles: expect.arrayContaining([
        { x: 8, y: 7 },
        { x: 9, y: 8 },
      ]),
      generatedStructures: [
        expect.objectContaining({
          kind: "roundabout",
          origin: { x: 8, y: 7 },
          size: "compact2x2",
        }),
      ],
    });
  });

  it("ignores a stale road preview failure after a newer hover wins", async () => {
    const previews = deferredPreviewBackend(fullRustSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.armRoundabout("compact2x2");
    runtime.setHoverTile({ x: 5, y: 5 });
    runtime.setHoverTile({ x: 8, y: 7 });
    previews.rejectRoad(1, new Error("stale preview failed"));
    previews.resolveRoad(2, roundaboutPreview(2, { x: 8, y: 7 }));
    await flushPromises();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.backendError).toBeNull();
    expect(snapshot.ui.roadMutationPreviewError).toBeNull();
    expect(snapshot.ui.activeTool).toBe("roundabout");
    expect(snapshot.ui.roadMutationPreview?.generation).toBe(2);
  });

  it("surfaces a current road preview host failure nonfatally and recovers", async () => {
    const previews = deferredPreviewBackend(fullRustSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.armRoundabout("standard3x3");
    runtime.setHoverTile({ x: 5, y: 5 });
    previews.rejectRoad(1, new Error("preview host offline"));
    await flushPromises();

    let snapshot = runtime.getSnapshot();
    expect(snapshot.backendError).toBeNull();
    expect(snapshot.ui.roadMutationPreviewError).toBe("preview host offline");
    expect(snapshot.ui.activeTool).toBe("roundabout");

    runtime.setHoverTile({ x: 8, y: 7 });
    expect(previews.roadRequestGenerations).toEqual([1, 2]);
    previews.resolveRoad(
      2,
      roundaboutPreview(2, { x: 8, y: 7 }, "standard3x3"),
    );
    await flushPromises();

    snapshot = runtime.getSnapshot();
    expect(snapshot.ui.roadMutationPreviewError).toBeNull();
    expect(snapshot.ui.roadMutationPreview?.generation).toBe(2);
    await runtime.setSpeed(2);
    expect(previews.backend.intents).toContainEqual({
      type: "setSpeed",
      speed: 2,
    });
  });

  describe("hover preview debounce", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("coalesces rapid hover moves into a single preview request", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      runtime.setTool("road");
      runtime.setHoverTile({ x: 5, y: 5 });
      runtime.setHoverTile({ x: 6, y: 5 });
      runtime.setHoverTile({ x: 7, y: 5 });

      expect(previews.roadRequestGenerations).toHaveLength(0);

      vi.advanceTimersByTime(50);
      await flushPromises();

      expect(previews.roadRequestGenerations).toHaveLength(1);
    });

    it("fires preview request after debounce delay", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      runtime.setTool("road");
      runtime.setHoverTile({ x: 5, y: 5 });

      expect(previews.roadRequestGenerations).toHaveLength(0);

      vi.advanceTimersByTime(50);
      await flushPromises();

      expect(previews.roadRequestGenerations).toHaveLength(1);
    });

    it("cancels pending timer when hover clears to null", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      runtime.setTool("road");
      runtime.setHoverTile({ x: 5, y: 5 });
      runtime.setHoverTile(null);

      vi.advanceTimersByTime(50);
      await flushPromises();

      expect(previews.roadRequestGenerations).toHaveLength(0);
    });

    it("clears a resolved preview when hover moves to a tile with no mutation", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      // Explicit preview while the default inspect tool has no hover mutation.
      runtime.previewRoadMutation({ type: "layRoad", point: { x: 5, y: 5 } });
      previews.resolveRoad(1, roadPreview(1, { x: 5, y: 5 }));
      await flushPromises();
      expect(runtime.getSnapshot().ui.roadMutationPreview?.generation).toBe(1);

      runtime.setHoverTile({ x: 6, y: 6 });

      expect(runtime.getSnapshot().ui.roadMutationPreview).toBeNull();
      expect(runtime.getSnapshot().ui.roadPreviewGeneration).toBe(2);
      vi.advanceTimersByTime(50);
      await flushPromises();
      // No new road-tool request: inspect hover has no mutation.
      expect(previews.roadRequestGenerations).toEqual([1]);
    });

    it("cancels pending timer on reset", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      runtime.setTool("road");
      runtime.setHoverTile({ x: 5, y: 5 });
      runtime.reset();
      await flushPromises();

      vi.advanceTimersByTime(50);
      await flushPromises();

      expect(previews.roadRequestGenerations).toHaveLength(0);
    });

    it("cancels pending timer on resetUi", async () => {
      const previews = deferredPreviewBackend(fullRustSnapshot());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 50,
        backend: previews.backend,
      });

      runtime.setTool("road");
      runtime.setHoverTile({ x: 5, y: 5 });
      runtime.resetUi();

      vi.advanceTimersByTime(50);
      await flushPromises();

      expect(previews.roadRequestGenerations).toHaveLength(0);
    });
  });

  it("surfaces a current route preview host failure nonfatally and recovers", async () => {
    const initial = fullRustSnapshot({
      transit: {
        stops: [
          createStop("stop-0001", { x: 1, y: 1 }),
          createStop("stop-0002", { x: 2, y: 1 }),
        ],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
    const previews = deferredPreviewBackend(initial);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 1, y: 1 });
    runtime.handleTileClick({ x: 2, y: 1 });
    previews.rejectRoute(2, new Error("preview host offline"));
    await flushPromises();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.backendError).toBeNull();
    expect(snapshot.ui.routePreviewHostError).toBe("preview host offline");
    expect(snapshot.ui.routeDraft).not.toBeNull();
    expect(snapshot.ui.routeDraft?.previewPending).toBe(false);
    // The runtime stays alive — a speed change still dispatches.
    await runtime.setSpeed(2);
    expect(previews.backend.intents).toContainEqual({
      type: "setSpeed",
      speed: 2,
    });

    // Editing the draft clears the host error and re-requests a preview.
    runtime.handleTileClick({ x: 1, y: 1 });
    expect(runtime.getSnapshot().ui.routePreviewHostError).toBeNull();
    runtime.setRoutePattern("shuttle");
    previews.resolveRoute(3, routePreview(3, ["stop-0001", "stop-0002"]));
    await flushPromises();

    expect(runtime.getSnapshot().ui.routePreviewHostError).toBeNull();
    expect(runtime.getSnapshot().ui.routeDraft?.preview?.generation).toBe(3);
  });

  it("manages game and UI state with shell-friendly selectors", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.setTool("busStop");
    await runtime.togglePause();
    await runtime.tick(1);

    const snapshot = runtime.getSnapshot();

    expect(snapshot.ui.activeTool).toBe("busStop");
    expect(snapshot.state.paused).toBe(false);
    expect(snapshot.shell.topbar.budget).toBe("$120,000");
    expect(snapshot.shell.brief.title).toBe("Growing Suburb");
  });

  it("publishes state changes to subscribers", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    const snapshots: RuntimeSnapshot[] = [];

    const unsubscribe = runtime.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    runtime.setTool("busStop");
    await runtime.togglePause();

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1].ui.activeTool).toBe("busStop");

    unsubscribe();
  });

  it("skips subscriber publish when commit receives identical state and ui references", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    // dismissRejection with no rejection calls commit(state, ui) with the same
    // references; the nextState !== state / nextUi !== ui guard must skip publish.
    runtime.dismissRejection();
    expect(listener).not.toHaveBeenCalled();

    runtime.setTool("busStop");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resets through the backend and resets UI state", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("busRoute");
    await runtime.togglePause();
    await runtime.setSpeed(2);

    await runtime.reset();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.state.paused).toBe(true);
    expect(snapshot.state.speed).toBe(1);
  });

  it("resets transient UI state without changing simulation state", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    await runtime.togglePause();
    await runtime.setSpeed(4);
    await runtime.tick(1);
    runtime.setOverlay("growth");
    runtime.handleTileClick({ x: 5, y: 5 });
    runtime.setTool("busRoute");
    runtime.setHudCategory("manage");

    const beforeReset = runtime.getSnapshot();
    expect(beforeReset.state.paused).toBe(false);
    expect(beforeReset.state.speed).toBe(4);
    expect(beforeReset.state.time).toBeGreaterThan(0);
    expect(beforeReset.ui.activeTool).toBe("busRoute");
    expect(beforeReset.ui.activeOverlay).toBe("growth");
    expect(beforeReset.ui.selectedId).toBe("5,5");
    expect(beforeReset.ui.activeHudCategory).toBe("manage");

    runtime.resetUi();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.state.paused).toBe(false);
    expect(snapshot.state.speed).toBe(4);
    expect(snapshot.state.time).toBe(beforeReset.state.time);
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.ui.activeOverlay).toBe(null);
    expect(snapshot.ui.selectedId).toBe(null);
    expect(snapshot.ui.activeHudCategory).toBe("brief");
  });

  it("manages simulation lifecycle", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.start();
    expect(runtime.isRunning()).toBe(true);

    runtime.stop();
    expect(runtime.isRunning()).toBe(false);
  });

  it("does not schedule animation frames while paused", async () => {
    const requestAnimationFrame = vi.fn(() => 1);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.start();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    await runtime.togglePause();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    runtime.stop();
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("does not fast-forward after resuming from a paused gap", async () => {
    const callbacks: Array<(timestamp: number) => void> = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.start();
    await runtime.togglePause();

    callbacks.shift()?.(1_000);
    await Promise.resolve();
    expect(runtime.getSnapshot().state.time).toBe(0);

    await runtime.togglePause();
    await runtime.togglePause();

    callbacks.shift()?.(5_000);
    await Promise.resolve();
    expect(runtime.getSnapshot().state.time).toBe(0);

    vi.unstubAllGlobals();
  });

  it("handles tool changes", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.setTool("metroStation");
    expect(runtime.getSnapshot().ui.activeTool).toBe("metroStation");

    runtime.setTool("inspect");
    expect(runtime.getSnapshot().ui.activeTool).toBe("inspect");
  });

  it("selects buildings separately from route tools and rotates them", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.setBuilding("busTerminal");
    runtime.rotateBuilding();
    runtime.rotateBuilding();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.ui.selectedBuilding).toBe("busTerminal");
    expect(snapshot.ui.buildingRotation).toBe(180);
    expect(snapshot.shell.brief.activeTool).toBe("BUS TERMINAL 180");
  });

  it("dispatches selected building placement through the backend on tile click", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setBuilding("smallHouse");
    runtime.rotateBuilding();
    const snapshot = await runtime.handleTileClick({ x: 2, y: 3 });

    expect(backend.intents).toContainEqual({
      type: "placeBuilding",
      buildingType: "smallHouse",
      origin: { x: 2, y: 3 },
      rotation: 90,
    });
    expect(snapshot.state.buildings[0]).toMatchObject({
      type: "smallHouse",
      origin: { x: 2, y: 3 },
      rotation: 90,
    });
  });

  it.each(["busRoute", "remove", "inspect"] as const)(
    "clears building selection when switching to %s",
    async (tool) => {
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend: backendSpy(),
      });

      runtime.setBuilding("largeHouse");
      runtime.rotateBuilding();
      runtime.setTool(tool);

      expect(runtime.getSnapshot().ui).toMatchObject({
        activeTool: tool,
        selectedBuilding: null,
        buildingRotation: 0,
      });
    },
  );

  it("handles overlay changes", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.setOverlay("coverage");
    expect(runtime.getSnapshot().ui.activeOverlay).toBe("coverage");

    runtime.setOverlay(null);
    expect(runtime.getSnapshot().ui.activeOverlay).toBe(null);
  });

  it("dispatches pause and speed through the Rust backend", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    await runtime.togglePause();
    await runtime.setSpeed(4);

    expect(backend.intents).toContainEqual({
      type: "setPaused",
      paused: false,
    });
    expect(backend.intents).toContainEqual({ type: "setSpeed", speed: 4 });
    expect(runtime.getSnapshot().state.paused).toBe(false);
    expect(runtime.getSnapshot().state.speed).toBe(4);
  });

  it("derives rapid pause toggles from the latest queued state", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    const first = runtime.togglePause();
    const second = runtime.togglePause();
    await Promise.all([first, second]);

    expect(
      backend.intents.filter((intent) => intent.type === "setPaused"),
    ).toEqual([
      { type: "setPaused", paused: false },
      { type: "setPaused", paused: true },
    ]);
    expect(runtime.getSnapshot().state.paused).toBe(true);
  });

  it("advances simulation time when ticking and unpaused", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    const beforeTime = runtime.getSnapshot().state.time;
    await runtime.togglePause();
    await runtime.tick(1);
    const afterTime = runtime.getSnapshot().state.time;

    expect(afterTime).toBeGreaterThan(beforeTime);
  });

  it("does not advance time when paused", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    const beforeTime = runtime.getSnapshot().state.time;
    await runtime.tick(1);
    const afterTime = runtime.getSnapshot().state.time;

    expect(afterTime).toBe(beforeTime);
  });

  it("captures backend errors and stops the runtime", async () => {
    const backend = backendSpy();
    backend.tick = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.start();
    const snapshot = await runtime.tick(1);

    expect(snapshot.backendError).toBe("backend unavailable");
    expect(runtime.isRunning()).toBe(false);
  });

  it("short-circuits dispatches after a fatal backend error", async () => {
    const backend = backendSpy();
    let tickCalls = 0;
    let dispatchCalls = 0;
    backend.tick = vi.fn(async () => {
      tickCalls += 1;
      if (tickCalls === 1) {
        throw new Error("backend unavailable");
      }
      return {
        snapshot: await backend.snapshot(),
        applied: true,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    });
    const baseDispatch = backend.dispatch;
    backend.dispatch = vi.fn(async (intent) => {
      dispatchCalls += 1;
      return baseDispatch(intent);
    });
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.start();
    await runtime.tick(1);
    expect(runtime.getSnapshot().backendError).toBe("backend unavailable");

    // Subsequent dispatches and ticks must NOT reach the dead backend.
    runtime.setTool("busStop");
    const dispatchSnapshot = await runtime.handleTileClick({ x: 5, y: 5 });
    const tickSnapshot = await runtime.tick(1);

    expect(dispatchCalls).toBe(0);
    expect(tickCalls).toBe(1);
    // The short-circuit returns the last published snapshot.
    expect(dispatchSnapshot.backendError).toBe("backend unavailable");
    expect(tickSnapshot.backendError).toBe("backend unavailable");
  });

  it("short-circuits a queued dispatch at execution time when a prior queued op fails fatally", async () => {
    // The enqueue-time `dead` guard is not enough: a dispatch enqueued behind
    // a pending one may reach its closure after the first dispatch fails
    // fatally. The execution-time re-check inside the queued closure must bail
    // so the second dispatch never reaches the dead backend.
    const backend = deferredDispatchBackend();
    let dispatchCalls = 0;
    const realDispatch = backend.dispatch.bind(backend);
    let firstDispatch = true;
    backend.dispatch = vi.fn(async (intent) => {
      dispatchCalls += 1;
      const result = await realDispatch(intent);
      if (firstDispatch) {
        firstDispatch = false;
        throw new Error("backend unavailable");
      }
      return result;
    });
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    // Enqueue dispatch A (will suspend, then throw when resolved).
    runtime.setTool("busStop");
    const dispatchA = runtime.handleTileClick({ x: 5, y: 5 });
    // Enqueue dispatch B behind A (should be short-circuited at execution time).
    const dispatchB = runtime.handleTileClick({ x: 6, y: 6 });
    await Promise.resolve(); // let dispatch A start and suspend

    // Resolve dispatch A — it throws, failBackend sets dead = true.
    await backend.resolveNext();
    await dispatchA;
    expect(runtime.getSnapshot().backendError).toBe("backend unavailable");

    // Dispatch B's closure runs but bails at the execution-time dead check.
    await dispatchB;
    expect(dispatchCalls).toBe(1); // only dispatch A reached the backend
    expect(runtime.getSnapshot().backendError).toBe("backend unavailable");
  });

  it("handles inspect tile clicks without backend dispatch", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("inspect");
    const snapshot = await runtime.handleTileClick({ x: 5, y: 5 });

    expect(snapshot.ui.selectedId).toBe("5,5");
    expect(backend.intents).toEqual([]);
  });

  it("sets HUD category to data", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    const before = runtime.getSnapshot().ui.activeHudCategory;
    runtime.setHudCategory("data");
    const after = runtime.getSnapshot().ui.activeHudCategory;

    expect(before).toBe("brief");
    expect(after).toBe("data");
  });

  it("collapses the drawer when setHudCategory(null) is dispatched", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setHudCategory("build");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");
    runtime.setHudCategory(null);
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });

  it("auto-opens the inspect drawer when a node is clicked, and collapses it on empty tiles", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(
        fullRustSnapshot({
          transit: {
            stops: [createStop("stop-001", { x: 7, y: 8 })],
            stations: [],
            routes: [],
            metroLines: [],
            vehicles: [],
          },
        }),
      ),
    });

    runtime.setTool("inspect");
    const onNode = await runtime.handleTileClick({ x: 7, y: 8 });

    expect(onNode.ui.activeHudCategory).toBe("inspect");
    expect(onNode.shell.inspector).not.toBeNull();
    expect(onNode.ui.selectedId).toBe("7,8");

    const onEmpty = await runtime.handleTileClick({ x: 20, y: 20 });
    expect(onEmpty.ui.activeHudCategory).toBeNull();
  });
});

describe("runtime assignRouteToPlatform", () => {
  it("dispatches route platform reassignment through the backend", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    await runtime.assignRouteToPlatform("stop-001", "route-001", "stop-001-p1");

    expect(backend.intents).toContainEqual({
      type: "assignRouteToPlatform",
      nodeId: "stop-001",
      routeId: "route-001",
      platformId: "stop-001-p1",
    });
  });
});

describe("runtime road preset", () => {
  it("sets the road preset and preserves it across tool switches", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setTool("track");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
  });
});

describe("build category navigation", () => {
  it("setBuildCategory changes buildCategory without closing the drawer", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setHudCategory("build");
    const snap = runtime.setBuildCategory("bus");
    expect(snap.ui.buildCategory).toBe("bus");
    expect(snap.ui.activeHudCategory).toBe("build");
  });

  it("setBuildCategory(null) returns to the category root", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setBuildCategory("bus");
    expect(runtime.setBuildCategory(null).ui.buildCategory).toBeNull();
  });

  it("selecting a tool/area/building resets buildCategory to null", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setBuildCategory("residential");
    expect(runtime.setBuilding("smallHouse").ui.buildCategory).toBeNull();
    runtime.setBuildCategory("road");
    expect(runtime.setTool("track").ui.buildCategory).toBeNull();
    runtime.setBuildCategory("residential");
    expect(runtime.setArea("residential").ui.buildCategory).toBeNull();
  });

  it("leaving the Build category via setHudCategory resets buildCategory to null", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setHudCategory("build");
    runtime.setBuildCategory("bus");
    expect(runtime.setHudCategory("area").ui.buildCategory).toBeNull();
    // Returning to Build reopens at the root, not the Bus detail.
    const snap = runtime.setHudCategory("build");
    expect(snap.ui.buildCategory).toBeNull();
    expect(snap.ui.activeHudCategory).toBe("build");
  });

  it("armRoad selects the road tool with the given preset and closes the drawer", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setHudCategory("build");
    const snap = runtime.armRoad("dualBidirectional");
    expect(snap.ui.activeTool).toBe("road");
    expect(snap.ui.roadPreset).toBe("dualBidirectional");
    expect(snap.ui.selectedBuilding).toBeNull();
    expect(snap.ui.activeHudCategory).toBeNull();
    expect(snap.ui.buildCategory).toBeNull();
  });
});

describe("route creation and management", () => {
  function routeMap(): GameMap {
    return [
      { x: 14, y: 7 },
      { x: 14, y: 8 },
      { x: 14, y: 9 },
    ].reduce(
      (map, point) =>
        updateTile(map, point, (tile) => ({
          ...tile,
          kind: "road",
        })),
      fullRustSnapshot().map,
    );
  }

  function routeSnapshot(): RustGameSnapshot {
    return fullRustSnapshot({
      map: routeMap(),
      transit: {
        stops: [
          createStop("stop-001", { x: 14, y: 7 }),
          createStop("stop-002", { x: 14, y: 8 }),
          createStop("stop-003", { x: 14, y: 9 }),
        ],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    });
  }

  function routeSnapshotWithRoute(active = true): RustGameSnapshot {
    return fullRustSnapshot({
      map: routeMap(),
      transit: {
        stops: [
          createStop("stop-001", { x: 14, y: 7 }),
          createStop("stop-002", { x: 14, y: 8 }),
          createStop("stop-003", { x: 14, y: 9 }),
        ],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#2563eb",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: [],
            active,
            pattern: "loop",
            revision: 0,
            legs: [],
            pathBroken: false,
          },
        ],
        metroLines: [],
        vehicles: [],
      },
    });
  }

  async function withTwoStops(backend = backendSpy(routeSnapshot())) {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("busRoute");
    await runtime.handleTileClick({ x: 14, y: 7 });
    await runtime.handleTileClick({ x: 14, y: 8 });
    return { runtime, backend };
  }

  function connectedRouteBackend(
    initial = routeSnapshotWithRoute(),
  ): BackendSpy {
    const base = backendSpy(initial);
    return {
      ...base,
      async previewRoute(request) {
        return routePreview(
          request.generation,
          request.waypointIds,
          "connected",
        );
      },
    };
  }

  function countedPreviewBackend(initial: RustGameSnapshot = routeSnapshot()): {
    backend: BackendSpy;
    previewRoute: ReturnType<typeof vi.fn>;
  } {
    const base = backendSpy(initial);
    const previewRoute = vi.fn(base.previewRoute.bind(base));
    return { backend: { ...base, previewRoute }, previewRoute };
  }

  describe("route draft history", () => {
    it("records one checkpoint for each meaningful draft mutation", async () => {
      const { backend, previewRoute } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(1);
      runtime.handleTileClick({ x: 14, y: 8 });
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(2);
      runtime.handleTileClick({ x: 14, y: 9 });
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(3);

      runtime.selectRouteWaypoint(2, "replace");
      runtime.removeRouteWaypoint();
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(4);

      runtime.selectRouteWaypoint(1, "replace");
      runtime.moveRouteWaypoint(-1);
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(5);

      runtime.reverseRouteDraft();
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(6);

      runtime.setRoutePattern("shuttle");
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(7);
      expect(previewRoute).toHaveBeenCalledTimes(7);
    });

    it("does not record selection-only changes or duplicate no-ops", async () => {
      const { backend, previewRoute } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      runtime.handleTileClick({ x: 14, y: 8 });
      const beforeSelection = runtime.getSnapshot();
      const beforeHistory = beforeSelection.ui.routeDraftHistory;
      const previewCalls = previewRoute.mock.calls.length;

      runtime.selectRouteWaypoint(0, "replace");
      expect(runtime.getSnapshot().ui.routeDraftHistory).toBe(beforeHistory);
      expect(previewRoute).toHaveBeenCalledTimes(previewCalls);

      runtime.selectRouteWaypoint(null, "append");
      const beforeDuplicate = runtime.getSnapshot();
      const duplicate = await runtime.handleTileClick({ x: 14, y: 8 });
      expect(duplicate.ui).toBe(beforeDuplicate.ui);
      expect(runtime.getSnapshot().ui.routeDraft).toBe(
        beforeDuplicate.ui.routeDraft,
      );
      expect(runtime.getSnapshot().ui.routeDraftHistory).toBe(beforeHistory);
      expect(previewRoute).toHaveBeenCalledTimes(previewCalls);
    });

    it("does not preview repeated clicks on the same stop", async () => {
      const { backend, previewRoute } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      runtime.handleTileClick({ x: 14, y: 8 });
      runtime.selectRouteWaypoint(null, "append");

      const before = runtime.getSnapshot();
      const beforeDraft = before.ui.routeDraft!;
      const beforeWaypointIds = [...beforeDraft.waypointIds];
      const beforeGeneration = beforeDraft.generation;
      const beforeHistory = before.ui.routeDraftHistory;
      const beforePreviewCalls = previewRoute.mock.calls.length;

      runtime.handleTileClick({ x: 14, y: 8 });
      runtime.handleTileClick({ x: 14, y: 8 });
      runtime.handleTileClick({ x: 14, y: 8 });

      const after = runtime.getSnapshot();
      expect(after.ui.routeDraft?.waypointIds).toEqual(beforeWaypointIds);
      expect(after.ui.routeDraft?.generation).toBe(beforeGeneration);
      expect(after.ui.routeDraftHistory).toBe(beforeHistory);
      expect(after.ui.routeDraftHistory.past).toHaveLength(
        beforeHistory.past.length,
      );
      expect(previewRoute).toHaveBeenCalledTimes(beforePreviewCalls);
    });

    it("undoes and redoes a draft while preserving its instance and refreshing preview", async () => {
      const { backend, previewRoute } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      runtime.handleTileClick({ x: 14, y: 8 });
      const instanceId = runtime.getSnapshot().ui.routeDraft!.instanceId;
      expect(previewRoute).toHaveBeenCalledTimes(2);

      const undone = runtime.undoRouteDraft();
      expect(undone.ui.routeDraft).toMatchObject({
        instanceId,
        waypointIds: ["stop-001"],
        generation: 3,
        previewPending: true,
        preview: null,
      });
      expect(undone.ui.routeDraftHistory.past).toHaveLength(1);
      expect(undone.ui.routeDraftHistory.future).toHaveLength(1);
      expect(previewRoute).toHaveBeenCalledTimes(3);

      const redone = runtime.redoRouteDraft();
      expect(redone.ui.routeDraft).toMatchObject({
        instanceId,
        waypointIds: ["stop-001", "stop-002"],
        generation: 4,
        previewPending: true,
        preview: null,
      });
      expect(redone.ui.routeDraftHistory.past).toHaveLength(2);
      expect(redone.ui.routeDraftHistory.future).toHaveLength(0);
      expect(previewRoute).toHaveBeenCalledTimes(4);

      const noOpRedo = runtime.redoRouteDraft();
      expect(noOpRedo.ui).toBe(redone.ui);
      expect(previewRoute).toHaveBeenCalledTimes(4);
    });

    it("caps past checkpoints at one hundred entries", async () => {
      const { backend } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      for (let index = 0; index < 101; index += 1) {
        runtime.setRoutePattern(index % 2 === 0 ? "shuttle" : "loop");
      }

      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(100);
      expect(runtime.getSnapshot().ui.routeDraftHistory.future).toHaveLength(0);
    });

    it("clears history when a draft is cancelled", async () => {
      const { backend } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      runtime.cancelRouteDraft();

      expect(runtime.getSnapshot().ui.routeDraft).toBeNull();
      expect(runtime.getSnapshot().ui.routeDraftHistory).toEqual({
        past: [],
        future: [],
      });
      expect(runtime.getSnapshot().ui.routeDraftNotice).toBeNull();
    });

    it("clears history after a successful save", async () => {
      const { backend } = countedPreviewBackend();
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.setTool("busRoute");
      runtime.handleTileClick({ x: 14, y: 7 });
      runtime.handleTileClick({ x: 14, y: 8 });
      await flushPromises();
      await runtime.saveRouteDraft();

      expect(runtime.getSnapshot().ui.routeDraft).toBeNull();
      expect(runtime.getSnapshot().ui.routeDraftHistory).toEqual({
        past: [],
        future: [],
      });
    });

    it("clears history when editing starts over or the route mode switches", async () => {
      const { backend } = countedPreviewBackend(routeSnapshotWithRoute());
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });

      runtime.startRouteEdit("route-001");
      runtime.selectRouteWaypoint(1, "replace");
      runtime.handleTileClick({ x: 14, y: 9 });
      expect(runtime.getSnapshot().ui.routeDraftHistory.past).toHaveLength(1);

      runtime.startRouteEdit("route-001");
      expect(runtime.getSnapshot().ui.routeDraftHistory).toEqual({
        past: [],
        future: [],
      });

      runtime.handleTileClick({ x: 14, y: 9 });
      runtime.setTool("metroLine");
      expect(runtime.getSnapshot().ui.routeDraft?.mode).toBe("metro");
      expect(runtime.getSnapshot().ui.routeDraftHistory).toEqual({
        past: [],
        future: [],
      });
    });
  });

  it("editing leaves committed service unchanged until Save succeeds", async () => {
    const backend = connectedRouteBackend();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    const committed = runtime.getSnapshot().state.transit.routes[0];

    runtime.startRouteEdit(committed.id);
    await flushPromises();
    runtime.selectRouteWaypoint(1, "replace");
    runtime.handleTileClick({ x: 14, y: 9 });

    expect(runtime.getSnapshot().state.transit.routes[0]).toEqual(committed);
    await flushPromises();
    await runtime.saveRouteDraft();
    expect(runtime.getSnapshot().state.transit.routes[0].stopIds).toEqual([
      "stop-001",
      "stop-003",
    ]);
    expect(backend.intents).toContainEqual({
      type: "updateRoute",
      routeId: "route-001",
      expectedRevision: 0,
      pattern: "loop",
      waypointIds: ["stop-001", "stop-003"],
    });
  });

  it("selects a retained missing draft handle without changing or previewing the draft", async () => {
    const initial = routeSnapshotWithRoute();
    const missing = {
      ...initial,
      transit: {
        ...initial.transit,
        stops: initial.transit.stops.map((node) =>
          node.id === "stop-002"
            ? { ...node, status: "missing" as const }
            : node,
        ),
      },
    };
    const base = backendSpy(missing);
    const previewRoute = vi.fn(async (request) =>
      routePreview(request.generation, request.waypointIds),
    );
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, previewRoute },
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const before = runtime.getSnapshot().ui.routeDraft;

    runtime.handleTileClick({ x: 14, y: 8 });

    expect(runtime.getSnapshot().ui.routeDraft).toMatchObject({
      waypointIds: before?.waypointIds,
      generation: before?.generation,
      selectedIndex: 1,
    });
    expect(previewRoute).toHaveBeenCalledTimes(1);
  });

  it("selects a route handle from any occupied terminal footprint tile", async () => {
    const initial = routeSnapshotWithRoute();
    const terminalSnapshot: RustGameSnapshot = {
      ...initial,
      buildings: [
        {
          id: "building-terminal",
          type: "busTerminal",
          origin: { x: 14, y: 7 },
          rotation: 0,
          occupiedTiles: [
            { x: 14, y: 7 },
            { x: 15, y: 7 },
            { x: 16, y: 7 },
            { x: 14, y: 8 },
            { x: 15, y: 8 },
            { x: 16, y: 8 },
          ],
          transitNodeId: "stop-001",
        },
      ],
      transit: {
        ...initial.transit,
        stops: initial.transit.stops.map((stop) =>
          stop.id === "stop-001"
            ? { ...stop, kind: "busTerminal" as const }
            : stop,
        ),
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: connectedRouteBackend(terminalSnapshot),
    });

    runtime.startRouteEdit("route-001");
    await flushPromises();
    const before = runtime.getSnapshot().ui.routeDraft;

    runtime.handleTileClick({ x: 15, y: 8 });

    expect(runtime.getSnapshot().ui.routeDraft).toMatchObject({
      waypointIds: before?.waypointIds,
      generation: before?.generation,
      selectedIndex: 0,
    });
  });

  it("applies editor transforms immediately and re-requests Rust previews", async () => {
    const base = backendSpy(routeSnapshotWithRoute());
    const previewRoute = vi.fn(async (request) =>
      routePreview(request.generation, request.waypointIds),
    );
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, previewRoute },
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();

    runtime.selectRouteWaypoint(1, "replace");
    runtime.moveRouteWaypoint(-1);
    runtime.reverseRouteDraft();
    runtime.setRoutePattern("shuttle");
    runtime.selectRouteWaypoint(1, "replace");
    runtime.removeRouteWaypoint();

    expect(runtime.getSnapshot().ui.routeDraft).toMatchObject({
      pattern: "shuttle",
      waypointIds: ["stop-002"],
      selectedIndex: 0,
      generation: 4,
      previewPending: true,
      preview: null,
    });
    // 5 calls: startRouteEdit (1) + move/reverse/setPattern/remove (4).
    // The two selectRouteWaypoint calls are selection-only (no generation
    // bump) and correctly skip the redundant no-op preview IPC.
    expect(previewRoute).toHaveBeenCalledTimes(5);
  });

  it("surfaces and clears a typed invalid waypoint selection error", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: connectedRouteBackend(),
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const draft = runtime.getSnapshot().ui.routeDraft;

    const invalid = runtime.selectRouteWaypoint(99, "replace");

    expect(invalid.ui.routeDraft).toBe(draft);
    expect(invalid.ui.routePreviewError).toEqual({
      code: "invalidRouteDraftInteraction",
      context: { operation: "selectWaypoint", waypointIndex: 99 },
    });

    const valid = runtime.selectRouteWaypoint(1, "replace");
    expect(valid.ui.routePreviewError).toBeNull();
  });

  it("keeps a local interaction error when an older preview resolves", async () => {
    const previews = deferredPreviewBackend(routeSnapshotWithRoute());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: previews.backend,
    });
    runtime.startRouteEdit("route-001");
    runtime.selectRouteWaypoint(99, "replace");

    previews.resolveRoute(0, routePreview(0, ["stop-001", "stop-002"]));
    await flushPromises();

    expect(runtime.getSnapshot().ui.routePreviewError).toEqual({
      code: "invalidRouteDraftInteraction",
      context: { operation: "selectWaypoint", waypointIndex: 99 },
    });
  });

  it("surfaces typed errors for invalid remove and move operations", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: connectedRouteBackend(),
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();

    expect(runtime.removeRouteWaypoint().ui.routePreviewError).toEqual({
      code: "invalidRouteDraftInteraction",
      context: { operation: "removeWaypoint", waypointIndex: null },
    });

    runtime.selectRouteWaypoint(0, "replace");
    expect(runtime.moveRouteWaypoint(-1).ui.routePreviewError).toEqual({
      code: "invalidRouteDraftInteraction",
      context: {
        operation: "moveWaypoint",
        waypointIndex: 0,
        delta: -1,
      },
    });

    const valid = runtime.moveRouteWaypoint(1);
    expect(valid.ui.routePreviewError).toBeNull();
  });

  it("keeps the draft after typed rejection or host failure", async () => {
    for (const outcome of [
      { kind: "rejection" as const, code: "disconnectedLeg" as const },
      {
        kind: "rejection" as const,
        code: "routeChangedWhileEditing" as const,
      },
      { kind: "failure" as const },
    ]) {
      const base = connectedRouteBackend();
      const backend: GameBackend = {
        ...base,
        async dispatch(_intent) {
          if (outcome.kind === "failure") {
            throw new Error("host unavailable");
          }
          return {
            snapshot: await base.snapshot(),
            applied: false,
            rejection: {
              code: outcome.code,
              context: { affectedRouteIds: ["route-001"] },
            },
            context: {
              changedTiles: [],
              skippedTiles: [],
              affectedRouteIds: [],
              cost: 0,
            },
          };
        },
      };
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend,
      });
      runtime.startRouteEdit("route-001");
      await flushPromises();
      const before = runtime.getSnapshot().ui.routeDraft;

      await runtime.saveRouteDraft();

      expect(runtime.getSnapshot().ui.routeDraft).toMatchObject({
        source: before?.source,
        waypointIds: before?.waypointIds,
      });
    }
  });

  it("does not clear a newer draft when an older Save resolves", async () => {
    const saves = deferredDispatchBackend(routeSnapshotWithRoute());
    const backend: GameBackend = {
      ...saves,
      async previewRoute(request) {
        return routePreview(request.generation, request.waypointIds);
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const save = runtime.saveRouteDraft();
    await Promise.resolve();
    runtime.selectRouteWaypoint(0, "replace");
    runtime.handleTileClick({ x: 14, y: 9 });

    await saves.resolveNext();
    await save;

    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds[0]).toBe(
      "stop-003",
    );
  });

  it("does not clear a replacement draft with the same source and generation", async () => {
    const saves = deferredDispatchBackend(routeSnapshotWithRoute());
    const backend: GameBackend = {
      ...saves,
      async previewRoute(request) {
        return routePreview(request.generation, request.waypointIds);
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const oldInstance = runtime.getSnapshot().ui.routeDraft!.instanceId;
    const save = runtime.saveRouteDraft();
    await Promise.resolve();
    runtime.cancelRouteDraft();
    runtime.startRouteEdit("route-001");
    const replacement = runtime.getSnapshot().ui.routeDraft!;
    expect(replacement.generation).toBe(0);
    expect(replacement.instanceId).not.toBe(oldInstance);

    await saves.resolveNext();
    await save;

    expect(runtime.getSnapshot().ui.routeDraft?.instanceId).toBe(
      replacement.instanceId,
    );
  });

  it("does not attach an old Save rejection to a replacement draft", async () => {
    const saves = deferredDispatchBackend(routeSnapshotWithRoute());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: saves,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const save = runtime.saveRouteDraft();
    await Promise.resolve();
    runtime.cancelRouteDraft();
    runtime.startRouteEdit("route-001");
    saves.rejectNextDispatchWith({
      code: "routeChangedWhileEditing",
      context: { routeId: "route-001", affectedRouteIds: ["route-001"] },
    });

    await saves.resolveNext();
    await save;

    const snapshot = runtime.getSnapshot();
    expect(snapshot.rejection).toBeNull();
    expect(snapshot.backendError).toBeNull();
    expect(snapshot.shell.routeDraft?.canReload).toBe(false);
  });

  it("does not attach an old Save host error to a replacement draft", async () => {
    const saves = deferredDispatchBackend(routeSnapshotWithRoute());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: saves,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const save = runtime.saveRouteDraft();
    await Promise.resolve();
    runtime.cancelRouteDraft();
    runtime.startRouteEdit("route-001");
    saves.failNextDispatch(new Error("old save unavailable"));

    await saves.resolveNext();
    await save;

    const snapshot = runtime.getSnapshot();
    expect(snapshot.rejection).toBeNull();
    expect(snapshot.backendError).toBeNull();
    expect(snapshot.shell.routeDraft?.canReload).toBe(false);
  });

  it("Cancel and Escape discard only the draft", async () => {
    for (const cancel of [
      (runtime: RuntimeController) => runtime.cancelRouteDraft(),
      (runtime: RuntimeController) => runtime.handleEscape(),
    ]) {
      const runtime = await createGameRuntime({
        hoverPreviewDebounceMs: 0,
        backend: connectedRouteBackend(),
      });
      const committed = structuredClone(
        runtime.getSnapshot().state.transit.routes,
      );
      runtime.startRouteEdit("route-001");

      cancel(runtime);

      expect(runtime.getSnapshot().ui.routeDraft).toBeNull();
      expect(runtime.getSnapshot().state.transit.routes).toEqual(committed);
    }
  });

  it("Reload captures the latest saved revision after a stale rejection", async () => {
    const initial = routeSnapshotWithRoute();
    const latest = {
      ...initial,
      transit: {
        ...initial.transit,
        routes: initial.transit.routes.map((route) => ({
          ...route,
          revision: 9,
        })),
      },
    };
    const base = connectedRouteBackend(initial);
    const backend: GameBackend = {
      ...base,
      async dispatch() {
        return {
          snapshot: latest,
          applied: false,
          rejection: {
            code: "routeChangedWhileEditing",
            context: {
              routeId: "route-001",
              expectedRevision: 0,
              actualRevision: 9,
              affectedRouteIds: ["route-001"],
            },
          },
          context: {
            changedTiles: [],
            skippedTiles: [],
            affectedRouteIds: [],
            cost: 0,
          },
        };
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    await runtime.saveRouteDraft();

    runtime.reloadRouteDraft();

    expect(runtime.getSnapshot().ui.routeDraft?.source).toEqual({
      kind: "edit",
      routeId: "route-001",
      expectedRevision: 9,
    });
  });

  it("Reload is a no-op without a matching stale edit rejection", async () => {
    const base = connectedRouteBackend();
    const previewRoute = vi.fn(base.previewRoute.bind(base));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: { ...base, previewRoute },
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const before = runtime.getSnapshot().ui.routeDraft;

    const snapshot = runtime.reloadRouteDraft();

    expect(snapshot.ui.routeDraft).toBe(before);
    expect(snapshot.rejection).toBeNull();
    expect(previewRoute).toHaveBeenCalledTimes(1);
  });

  it("does not carry a stale rejection into a fresh edit of the same route", async () => {
    const initial = routeSnapshotWithRoute();
    const latest = {
      ...initial,
      transit: {
        ...initial.transit,
        routes: initial.transit.routes.map((route) => ({
          ...route,
          revision: 9,
        })),
      },
    };
    const base = connectedRouteBackend(initial);
    const backend: GameBackend = {
      ...base,
      async dispatch() {
        return {
          snapshot: latest,
          applied: false,
          rejection: {
            code: "routeChangedWhileEditing",
            context: {
              routeId: "route-001",
              expectedRevision: 0,
              actualRevision: 9,
              affectedRouteIds: ["route-001"],
            },
          },
          context: {
            changedTiles: [],
            skippedTiles: [],
            affectedRouteIds: [],
            cost: 0,
          },
        };
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.startRouteEdit("route-001");
    await flushPromises();
    await runtime.saveRouteDraft();
    runtime.cancelRouteDraft();

    runtime.startRouteEdit("route-001");
    const fresh = runtime.getSnapshot();

    expect(fresh.ui.routeDraft?.source).toEqual({
      kind: "edit",
      routeId: "route-001",
      expectedRevision: 9,
    });
    expect(fresh.rejection).toBeNull();
    expect(fresh.shell.routeDraft?.canReload).toBe(false);

    const afterReload = runtime.reloadRouteDraft();
    expect(afterReload.ui.routeDraft).toBe(fresh.ui.routeDraft);
  });

  it("successful creation save dispatches one atomic intent", async () => {
    const base = backendSpy(routeSnapshot());
    const dispatch = vi.fn(base.dispatch.bind(base));
    const backend: BackendSpy = {
      ...base,
      dispatch,
      async previewRoute(request) {
        return routePreview(request.generation, request.waypointIds);
      },
    };
    const { runtime } = await withTwoStops(backend);
    await flushPromises();

    await runtime.saveRouteDraft();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "createRoute" }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assignVehicle" }),
    );
  });

  it("matches independently computed real-core preview and committed route legs", async () => {
    const backend = await createWasmBackend();
    const roadPoints = Array.from({ length: 9 }, (_, index) => ({
      x: index + 3,
      y: 4,
    }));
    const road = await backend.dispatch({
      type: "layRoadLine",
      points: roadPoints,
      preset: "twoWay",
    });
    expect(road.applied).toBe(true);

    const firstStop = await backend.dispatch({
      type: "addBusStop",
      point: { x: 3, y: 3 },
    });
    expect(firstStop.applied).toBe(true);
    const secondStop = await backend.dispatch({
      type: "addBusStop",
      point: { x: 11, y: 3 },
    });
    expect(secondStop.applied).toBe(true);
    const waypointIds = secondStop.snapshot.transit.stops.map(
      (stop) => stop.id,
    );
    expect(waypointIds).toHaveLength(2);

    const runtime = await createGameRuntime({ backend });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 3, y: 3 });
    runtime.handleTileClick({ x: 11, y: 3 });
    await flushPromises();

    const preview = runtime.getSnapshot().ui.routeDraft?.preview;
    if (preview === null || preview === undefined) {
      throw new Error("real core route preview did not settle");
    }
    expect(preview.legs).toHaveLength(2);
    expect(preview.legs.every((leg) => leg.status === "connected")).toBe(true);

    await runtime.saveRouteDraft();

    const committed = runtime.getSnapshot().state.transit.routes.at(-1);
    if (committed === undefined) {
      throw new Error("real core route save did not commit");
    }
    expect(committed.legs).toHaveLength(preview.legs.length);
    expect(committed.legs).not.toBe(preview.legs);
    expect(committed.legs.map(routeLegProjection)).toEqual(
      preview.legs.map(routeLegProjection),
    );
  });

  it("routes Save through the selected service pattern", async () => {
    const backend = connectedRouteBackend(routeSnapshot());
    const { runtime } = await withTwoStops(backend);
    await flushPromises();
    runtime.setRoutePattern("shuttle");
    await flushPromises();

    await runtime.saveRouteDraft();

    expect(backend.intents).toContainEqual({
      type: "createRoute",
      mode: "bus",
      pattern: "shuttle",
      waypointIds: ["stop-001", "stop-002"],
    });
  });

  it("dispatches route save and clears the draft only after Rust accepts it", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);
    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    backend.rejectNextDispatch();
    await runtime.saveRouteDraft();
    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    await runtime.saveRouteDraft();

    expect(backend.intents).toContainEqual({
      type: "createRoute",
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001", "stop-002"],
    });
    expect(runtime.getSnapshot().ui.routeDraft).toBeNull();
  });

  it("Save sends one atomic createRoute intent", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    await runtime.saveRouteDraft();

    expect(backend.intents).toEqual([
      {
        type: "createRoute",
        mode: "bus",
        pattern: "loop",
        waypointIds: ["stop-001", "stop-002"],
      },
    ]);
    expect(backend.intents).not.toContainEqual({
      type: "assignVehicle",
      mode: "bus",
      lineId: "route-001",
    });
  });

  it("does not dispatch assignVehicle when the backend rejects the route", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    backend.rejectNextDispatch();
    await runtime.saveRouteDraft();

    expect(backend.intents.some((i) => i.type === "assignVehicle")).toBe(false);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(0);
  });

  it("surfaces a current Save rejection into the route draft panel", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);
    await flushPromises();
    expect(runtime.getSnapshot().shell.routeDraft?.previewStatus).toBe(
      "connected",
    );

    backend.rejectNextDispatch();
    await runtime.saveRouteDraft();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.routeDraft).not.toBeNull();
    expect(snapshot.rejection).toEqual(TEST_REJECTION);
    expect(snapshot.ui.routePreviewError).toEqual(TEST_REJECTION);
    expect(snapshot.shell.routeDraft?.previewStatus).not.toBe("connected");
  });

  it("does not let a slow route finish clear a newer draft", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    const firstFinish = runtime.saveRouteDraft();
    await Promise.resolve();

    runtime.cancelRouteDraft();
    runtime.setTool("busRoute");
    await runtime.handleTileClick({ x: 14, y: 7 });
    await runtime.handleTileClick({ x: 14, y: 8 });
    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    await backend.resolveNext();
    await firstFinish;

    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
  });

  it("clears a stale rejection when a superseded save succeeds", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    // First attempt on the current draft: rejected, sets a stale rejection.
    backend.rejectNextDispatchWith(TEST_REJECTION);
    const firstAttempt = runtime.saveRouteDraft();
    await flushPromises();
    await backend.resolveNext();
    await firstAttempt;
    expect(runtime.getSnapshot().rejection).toEqual(TEST_REJECTION);

    // Second attempt on the same draft: deferred, will succeed later.
    const secondAttempt = runtime.saveRouteDraft();
    await flushPromises();

    // The draft moves on (new instance) before the second attempt resolves,
    // so its token is no longer current when the success arrives.
    runtime.cancelRouteDraft();
    runtime.setTool("busRoute");
    await runtime.handleTileClick({ x: 14, y: 7 });
    await runtime.handleTileClick({ x: 14, y: 8 });
    expect(runtime.getSnapshot().rejection).toEqual(TEST_REJECTION);

    await backend.resolveNext();
    await secondAttempt;

    // A successful save clears the stale rejection even though the
    // succeeding token is no longer the current draft, and the newer draft
    // is preserved.
    expect(runtime.getSnapshot().rejection).toBeNull();
    expect(runtime.getSnapshot().ui.routeDraft?.waypointIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
  });

  it("invalidates and re-requests the current draft preview when a superseded save bumps the revision", async () => {
    // A save is in flight on the original edit draft; before it resolves the
    // user re-opens the same route, so the replacement draft's preview is
    // computed against the pre-save revision. When the superseded save
    // succeeds and bumps the route revision, the replacement draft's preview
    // must be invalidated and re-requested — otherwise Save stays enabled on
    // the stale expectedRevision and the next save is rejected with
    // `routeChangedWhileEditing` without any UI signal.
    const initial = routeSnapshotWithRoute();
    let routeRevision = 0;
    const saves = deferredDispatchBackend(initial);
    const backend: GameBackend = {
      ...saves,
      async previewRoute(request) {
        if (
          request.routeId === "route-001" &&
          request.expectedRevision !== null &&
          request.expectedRevision !== routeRevision
        ) {
          return {
            ...routePreview(request.generation, request.waypointIds),
            rejection: {
              code: "routeChangedWhileEditing" as const,
              context: {
                routeId: "route-001",
                expectedRevision: request.expectedRevision,
                actualRevision: routeRevision,
                affectedRouteIds: ["route-001"],
              },
            },
          };
        }
        return routePreview(request.generation, request.waypointIds);
      },
    };
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.startRouteEdit("route-001");
    await flushPromises();
    expect(runtime.getSnapshot().shell.routeDraft?.canSave).toBe(true);

    const firstSave = runtime.saveRouteDraft();
    await Promise.resolve();

    // Re-open the same route before the save resolves. The route revision is
    // still 0, so the replacement draft carries expectedRevision 0 and its
    // preview resolves connected.
    runtime.cancelRouteDraft();
    runtime.startRouteEdit("route-001");
    await flushPromises();
    const replacement = runtime.getSnapshot().ui.routeDraft!;
    expect(replacement.source).toEqual({
      kind: "edit",
      routeId: "route-001",
      expectedRevision: 0,
    });
    expect(runtime.getSnapshot().shell.routeDraft?.canSave).toBe(true);

    // The superseded save succeeds and bumps the route revision to 1.
    routeRevision = 1;
    await saves.resolveNext();
    await firstSave;
    await flushPromises();

    // The replacement draft is preserved, but its preview is re-requested
    // against the post-save snapshot. The stale expectedRevision (0) now
    // mismatches the actual revision (1), so the fresh preview surfaces
    // `routeChangedWhileEditing`, disabling Save and enabling Reload.
    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.routeDraft?.instanceId).toBe(replacement.instanceId);
    expect(snapshot.ui.routePreviewError?.code).toBe(
      "routeChangedWhileEditing",
    );
    expect(snapshot.shell.routeDraft?.canSave).toBe(false);
    expect(snapshot.shell.routeDraft?.canReload).toBe(true);
  });

  it("leaves queued finish validation to Rust after state changes", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 20, y: 20 });
    await Promise.resolve();

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    await flushPromises();
    const finishPromise = runtime.saveRouteDraft();

    // The queued state changes after preview. Runtime must still dispatch the
    // submitted intent so Rust recomputes and accepts/rejects authoritatively.
    backend.setSnapshot({ ...routeSnapshot(), budget: 0 });
    await backend.resolveNext();
    await flushPromises();
    await backend.resolveNext();
    await finishPromise;

    expect(
      backend.intents.some((intent) => intent.type === "createRoute"),
    ).toBe(true);
  });

  it("keeps an accepted atomic snapshot even when the backend surfaces no new id", async () => {
    const base = backendSpy(routeSnapshot());
    const backend: BackendSpy = {
      ...base,
      async dispatch(intent) {
        if (intent.type === "createRoute") {
          return {
            snapshot: await base.snapshot(),
            applied: true,
            rejection: null,
            context: {
              changedTiles: [],
              skippedTiles: [],
              affectedRouteIds: [],
              cost: 0,
            },
          };
        }
        return base.dispatch(intent);
      },
    };
    const { runtime } = await withTwoStops(backend);

    await runtime.saveRouteDraft();

    expect(
      backend.intents.some((intent) => intent.type === "assignVehicle"),
    ).toBe(false);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(0);
  });

  it("does not duplicate a route on concurrent Saves", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    // Two synchronous calls (double-click) both enqueue before either
    // resolves. The second closure must bail when it sees the draft was
    // cleared by the first — no duplicate route, no double-charge, no second
    // vehicle.
    const first = runtime.saveRouteDraft();
    const second = runtime.saveRouteDraft();
    await Promise.all([first, second]);

    const createRouteCount = backend.intents.filter(
      (intent) => intent.type === "createRoute",
    ).length;
    expect(createRouteCount).toBe(1);
    expect(runtime.getSnapshot().state.transit.routes).toHaveLength(1);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(1);
  });

  it("deduplicates deferred Saves for the same draft", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const { runtime } = await withTwoStops(backend);
    await flushPromises();

    const save = runtime.saveRouteDraft();
    const finish = runtime.saveRouteDraft();
    await Promise.resolve();

    expect(
      backend.intents.filter((intent) => intent.type === "createRoute"),
    ).toHaveLength(1);
    await backend.resolveNext();
    await Promise.all([save, finish]);
    expect(runtime.getSnapshot().state.transit.routes).toHaveLength(1);
  });

  it("removes a draft stop and cancels a draft", async () => {
    const { runtime } = await withTwoStops();
    runtime.selectRouteWaypoint(0, "replace");
    const afterRemove = runtime.removeRouteWaypoint();
    expect(afterRemove.ui.routeDraft?.waypointIds).toEqual(["stop-002"]);
    expect(afterRemove.ui.routeDraft?.preview).toBeNull();

    const afterCancel = runtime.cancelRouteDraft();
    expect(afterCancel.ui.routeDraft).toBeNull();
  });

  it("renames, recolors, toggles, selects, and deletes a route", async () => {
    const { runtime } = await withTwoStops();
    await runtime.saveRouteDraft();

    expect(
      (await runtime.renameRoute("route-001", "Loop")).state.transit.routes[0]
        .name,
    ).toBe("Loop");
    expect(
      (await runtime.recolorRoute("route-001", "#abcdef")).state.transit
        .routes[0].color,
    ).toBe("#abcdef");
    expect(
      (await runtime.toggleRouteActive("route-001")).state.transit.routes[0]
        .active,
    ).toBe(false);
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe(
      "route-001",
    );
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe(null);
    expect(
      (await runtime.deleteRoute("route-001")).state.transit.routes,
    ).toEqual([]);
  });

  it("derives rapid route active toggles from the latest queued state", async () => {
    const backend = backendSpy(routeSnapshotWithRoute(true));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    const first = runtime.toggleRouteActive("route-001");
    const second = runtime.toggleRouteActive("route-001");
    await Promise.all([first, second]);

    expect(
      backend.intents.filter((intent) => intent.type === "setRouteActive"),
    ).toEqual([
      { type: "setRouteActive", routeId: "route-001", active: false },
      { type: "setRouteActive", routeId: "route-001", active: true },
    ]);
    expect(runtime.getSnapshot().state.transit.routes[0].active).toBe(true);
  });

  it("clears the selected route when switching tools", async () => {
    const { runtime } = await withTwoStops();
    await runtime.saveRouteDraft();
    runtime.selectRoute("route-001");
    expect(runtime.setTool("inspect").ui.selectedRouteId).toBe(null);
  });

  it("focuses a route failure without toggling route selection", async () => {
    const backend = backendSpy(routeSnapshotWithRoute(true));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    const snapshot = runtime.focusRouteFailure("route-001", 2);

    expect(snapshot.ui.selectedRouteId).toBe("route-001");
    expect(snapshot.ui.routeFailureFocus).toEqual({
      routeId: "route-001",
      legIndex: 2,
    });
  });

  it("clears the selected route when it is deleted", async () => {
    const { runtime } = await withTwoStops();
    await runtime.saveRouteDraft();
    runtime.selectRoute("route-001");
    const snapshot = await runtime.deleteRoute("route-001");
    expect(snapshot.ui.selectedRouteId).toBe(null);
    expect(snapshot.state.transit.routes).toEqual([]);
  });

  it("keeps the selected route when the backend rejects the delete", async () => {
    const backend = backendSpy(routeSnapshotWithRoute(true));
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.selectRoute("route-001");
    expect(runtime.getSnapshot().ui.selectedRouteId).toBe("route-001");

    backend.rejectNextDispatch();
    const snapshot = await runtime.deleteRoute("route-001");

    // The route still exists after a rejected delete, so its selection must
    // survive (the clear is gated on `applied`).
    expect(snapshot.ui.selectedRouteId).toBe("route-001");
    expect(snapshot.state.transit.routes).toHaveLength(1);
  });

  it("surfaces gameplay rejections from regular dispatches on the snapshot", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    backend.rejectNextDispatch();
    const snapshot = await runtime.setSpeed(2);

    expect(snapshot.rejection).toEqual(TEST_REJECTION);
    expect(snapshot.backendError).toBeNull();

    // A subsequent successful dispatch auto-clears the rejection.
    const next = await runtime.setSpeed(4);
    expect(next.rejection).toBeNull();
  });

  it("preserves a placement rejection across a tick (not cleared ~16ms later)", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    await runtime.togglePause();

    // Surface a rejection via a rejected dispatch.
    backend.rejectNextDispatch();
    const rejected = await runtime.setSpeed(2);
    expect(rejected.rejection).toEqual(TEST_REJECTION);

    // A tick must NOT overwrite the rejection — the Rust engine never returns
    // a rejection from tick(), so the banner should persist until dismissed.
    await runtime.tick(1);
    expect(runtime.getSnapshot().rejection).toEqual(TEST_REJECTION);

    // Dismissing still works after a tick.
    runtime.dismissRejection();
    expect(runtime.getSnapshot().rejection).toBeNull();
  });

  it("preserves a placement rejection across a no-op dispatch (not cleared by unchanged intent)", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    // Surface a rejection via a rejected dispatch.
    backend.rejectNextDispatch();
    const rejected = await runtime.setSpeed(2);
    expect(rejected.rejection).toEqual(TEST_REJECTION);

    // A no-op dispatch (applied === false, rejection === null — e.g. setting
    // pause to the value it already holds) must NOT clear the prior rejection.
    backend.noopNextDispatch();
    const noop = await runtime.setSpeed(4);
    expect(noop.rejection).toEqual(TEST_REJECTION);

    // A subsequent successful dispatch still clears the rejection.
    const next = await runtime.setSpeed(1);
    expect(next.rejection).toBeNull();
  });
});

describe("runtime road drag", () => {
  function tileKind(runtime: RuntimeController, x: number, y: number) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((t) => t.x === x && t.y === y)?.kind;
  }

  it("commits road drag as one Rust layRoadLine intent", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("road");
    runtime.setRoadPreset("oneWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    await runtime.commitDrag();

    expect(backend.intents).toContainEqual({
      type: "layRoadLine",
      points: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
      preset: "oneWay",
    });
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("does not let a slow drag completion clear a newer drag", async () => {
    const backend = deferredDispatchBackend();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    const firstCommit = runtime.commitDrag();

    runtime.startDrag({ x: 5, y: 0 });
    runtime.setDragCurrent({ x: 7, y: 0 });

    await Promise.resolve();
    await backend.resolveNext();
    await firstCommit;

    expect(runtime.getSnapshot().ui.drag).toEqual({
      tool: "road",
      start: { x: 5, y: 0 },
      current: { x: 7, y: 0 },
    });
  });

  it("clears the drag synchronously when committing, before the backend resolves", async () => {
    const backend = deferredDispatchBackend();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    runtime.commitDrag();
    await Promise.resolve();

    // The gesture is gone immediately — no lingering stale drag during the
    // dispatch window that a stray pointermove could resurrect by identity
    // mismatch with a deferred clear.
    expect(runtime.getSnapshot().ui.drag).toBeNull();

    await backend.resolveNext();
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("builds a road line from startDrag -> move -> commitDrag", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    const snap = await runtime.commitDrag();
    for (const x of [1, 2, 3, 4]) {
      expect(tileKind(runtime, x, 0)).toBe("road");
    }
    expect(snap.ui.drag).toBeNull();
  });

  it("treats a zero-length drag as a tap (cycles an existing road's direction)", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 2, y: 0 });
    await runtime.commitDrag();

    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 1, y: 0 });
    await runtime.commitDrag();
    expect(
      runtime.getSnapshot().state.map.tiles.find((t) => t.x === 1 && t.y === 0)
        ?.oneWay,
    ).toBe("north");
  });

  it("defers a road click's lay-vs-cycle decision until queued road updates drain", async () => {
    // A road click enqueued behind a pending road drag must re-read the tile
    // kind at execution time. Without the deferral the click would capture
    // `layRoad` at enqueue time (tile still empty) and lay a road on a tile
    // the draining drag had just turned into a road, instead of cycling that
    // road's direction.
    const backend = deferredDispatchBackend();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    const dragCommit = runtime.commitDrag(); // enqueues layRoadLine, suspends

    // Enqueue a road click on a tile the drag is about to turn into a road.
    const clickPromise = runtime.handleTileClick({ x: 2, y: 0 });
    await Promise.resolve(); // let the drag dispatch start and suspend

    // Resolve the drag: tiles (1,0)-(3,0) become road.
    await backend.resolveNext();
    await dragCommit;

    // The click's computed intent now runs against the drained state, sees
    // (2,0) is a road, and dispatches cycleRoadDirection (not layRoad).
    await backend.resolveNext();
    await clickPromise;

    expect(backend.intents).toContainEqual({
      type: "cycleRoadDirection",
      point: { x: 2, y: 0 },
    });
    expect(
      backend.intents.some(
        (intent) =>
          intent.type === "layRoad" &&
          intent.point.x === 2 &&
          intent.point.y === 0,
      ),
    ).toBe(false);
  });

  it("bulldozes a line with the remove tool drag", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    await runtime.commitDrag();
    runtime.setTool("remove");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    await runtime.commitDrag();
    for (const x of [1, 2, 3]) {
      expect(tileKind(runtime, x, 0)).toBe("empty");
    }
  });

  it("cancelDrag clears the drag without building", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    runtime.cancelDrag();
    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(tileKind(runtime, 4, 0)).toBe("empty");
  });

  it("startDrag captures the tool and ignores a non-drag tool", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("inspect");
    runtime.startDrag({ x: 1, y: 0 });
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("startDrag on the area tool without a selected area is a no-op", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("area");

    const before = runtime.getSnapshot();
    const after = runtime.startDrag({ x: 1, y: 1 });

    expect(after.ui.drag).toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });

  it("setDragCurrent ignores an off-map (null) move so the preview holds", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    runtime.setDragCurrent(null);
    const gesture = runtime.getSnapshot().ui.drag;
    expect(gesture).not.toBeNull();
    expect(gesture?.current).toEqual({ x: 4, y: 0 });
  });
});

describe("runtime area drag", () => {
  function areaAt(runtime: RuntimeController, x: number, y: number) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((tile) => tile.x === x && tile.y === y)?.area;
  }

  it("selects an area independently from buildings and tools", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });

    runtime.setArea("residential");

    expect(runtime.getSnapshot().ui).toMatchObject({
      activeTool: "area",
      selectedArea: "residential",
      selectedBuilding: null,
      drag: null,
    });
    expect(runtime.getSnapshot().shell.hud.activeToolChip).toBe(
      "AREA RESIDENTIAL",
    );
  });

  it("paints an area rectangle from startDrag -> move -> commitDrag", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setArea("commercial");
    runtime.startDrag({ x: 1, y: 1 });
    runtime.setDragCurrent({ x: 2, y: 2 });

    const snap = await runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("commercial");
    expect(areaAt(runtime, 2, 1)).toBe("commercial");
    expect(areaAt(runtime, 1, 2)).toBe("commercial");
    expect(areaAt(runtime, 2, 2)).toBe("commercial");
    expect(areaAt(runtime, 3, 2)).toBeUndefined();
    expect(snap.ui.drag).toBeNull();
  });

  it("paints a single tile area drag", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setArea("office");
    runtime.startDrag({ x: 1, y: 1 });

    await runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("office");
  });

  it("clears area selection when a building is selected", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setArea("residential");
    runtime.setBuilding("smallHouse");

    expect(runtime.getSnapshot().ui.selectedArea).toBeNull();
  });
});

describe("build drawer auto-hide", () => {
  it("closes the drawer when a tool, building, or area is selected, but not on preset change", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setHudCategory("build");
    runtime.setTool("road");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();

    runtime.setHudCategory("build");
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");

    runtime.setHudCategory("build");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();

    runtime.setHudCategory("build");
    runtime.setArea("commercial");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });
});

describe("fake backend applyIntent coverage", () => {
  function tileAt(snapshot: RustGameSnapshot, x: number, y: number) {
    return snapshot.map.tiles.find((tile) => tile.x === x && tile.y === y);
  }

  // Guards against regressions where a GameIntent silently falls through the
  // reducer and no-ops while the spy still reports `applied: true`.
  it("applies layTrack and removeAtTile to the map", async () => {
    const backend = backendSpy();

    const laid = await backend.dispatch({
      type: "layTrack",
      point: { x: 2, y: 3 },
    });
    expect(laid.applied).toBe(true);
    expect(tileAt(laid.snapshot, 2, 3)?.hasTrack).toBe(true);

    const removed = await backend.dispatch({
      type: "removeAtTile",
      point: { x: 2, y: 3 },
    });
    expect(removed.applied).toBe(true);
    expect(tileAt(removed.snapshot, 2, 3)?.kind).toBe("empty");
    expect(tileAt(removed.snapshot, 2, 3)?.hasTrack).toBe(false);
  });

  it("applies addMetroStation and atomic createRoute to transit", async () => {
    const backend = backendSpy();

    const station = await backend.dispatch({
      type: "addMetroStation",
      point: { x: 4, y: 5 },
    });
    expect(station.snapshot.transit.stations).toHaveLength(1);
    expect(station.snapshot.transit.stations[0].platforms).toHaveLength(2);

    const line = await backend.dispatch({
      type: "createRoute",
      mode: "metro",
      pattern: "loop",
      waypointIds: ["station-001"],
    });
    expect(line.snapshot.transit.metroLines).toHaveLength(1);
    expect(line.snapshot.transit.metroLines[0].stationIds).toEqual([
      "station-001",
    ]);
  });

  it("applies assignRouteToPlatform to the targeted platform", async () => {
    const backend = backendSpy();
    await backend.dispatch({ type: "addBusStop", point: { x: 1, y: 1 } });
    await backend.dispatch({
      type: "createRoute",
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001"],
    });

    const reassigned = await backend.dispatch({
      type: "assignRouteToPlatform",
      nodeId: "stop-001",
      routeId: "route-001",
      platformId: "stop-001-p1",
    });
    const platform = reassigned.snapshot.transit.stops[0].platforms.find(
      (candidate) => candidate.id === "stop-001-p1",
    );
    expect(platform?.routeIds).toContain("route-001");
  });

  it("dispatches addBusStop through handleTileClick with the busStop tool", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("busStop");
    await runtime.handleTileClick({ x: 5, y: 5 });
    expect(backend.intents).toContainEqual({
      type: "addBusStop",
      point: { x: 5, y: 5 },
    });
  });

  it("dispatches addMetroStation through handleTileClick with the metroStation tool", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("metroStation");
    await runtime.handleTileClick({ x: 4, y: 4 });
    expect(backend.intents).toContainEqual({
      type: "addMetroStation",
      point: { x: 4, y: 4 },
    });
  });

  it("dispatches layTrack through handleTileClick with the track tool", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("track");
    await runtime.handleTileClick({ x: 2, y: 3 });
    expect(backend.intents).toContainEqual({
      type: "layTrack",
      point: { x: 2, y: 3 },
    });
  });

  it("dispatches removeAtTile through handleTileClick with the remove tool", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("remove");
    await runtime.handleTileClick({ x: 2, y: 3 });
    expect(backend.intents).toContainEqual({
      type: "removeAtTile",
      point: { x: 2, y: 3 },
    });
  });

  it("commitDrag is a no-op when no drag gesture is active", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    const before = runtime.getSnapshot();
    await runtime.commitDrag();
    const after = runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });

  it("commits a zero-length track drag as a single layTrack intent", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("track");
    runtime.startDrag({ x: 3, y: 3 });
    await runtime.commitDrag();
    expect(backend.intents).toContainEqual({
      type: "layTrack",
      point: { x: 3, y: 3 },
    });
  });

  it("commits a multi-tile track drag as a layTrackLine intent", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    runtime.setTool("track");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    await runtime.commitDrag();
    expect(backend.intents).toContainEqual({
      type: "layTrackLine",
      points: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
    });
  });

  it("saveRouteDraft is a no-op when the active tool is not a route tool", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    runtime.setTool("inspect");
    const before = runtime.getSnapshot();
    await runtime.saveRouteDraft();
    const after = runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });

  it("saveRouteDraft defers one-way closing validation to Rust", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });
    // Build a one-way road so the closing loop can't path back.
    runtime.setTool("road");
    runtime.setRoadPreset("oneWay");
    runtime.startDrag({ x: 7, y: 8 });
    runtime.setDragCurrent({ x: 15, y: 8 });
    await runtime.commitDrag();
    // Add two stops and draft a route.
    runtime.setTool("busStop");
    await runtime.handleTileClick({ x: 7, y: 8 });
    await runtime.handleTileClick({ x: 15, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
    await flushPromises();
    await runtime.saveRouteDraft();
    const after = runtime.getSnapshot();
    expect(backend.intents).toContainEqual({
      type: "createRoute",
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001", "stop-002"],
    });
    expect(after.ui.routeDraft).toBeNull();
  });

  it("toggleRouteActive is a no-op when the route does not exist at call time", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    const before = runtime.getSnapshot();
    await runtime.toggleRouteActive("route-999");
    const after = runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });

  it("toggleRouteActive bails when the route is deleted between enqueue and execution", async () => {
    // The route exists at call time (sync lookup passes), but a prior queued
    // deleteRoute resolves before the toggle's closure runs, so the closure
    // finds the route gone and returns null (no setRouteActive dispatched).
    const snapshotWithRoute = fullRustSnapshot({
      transit: {
        stops: [
          createStop("stop-001", { x: 14, y: 7 }),
          createStop("stop-002", { x: 14, y: 8 }),
        ],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#2563eb",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: [],
            active: true,
            pattern: "loop",
            revision: 0,
            legs: [],
            pathBroken: false,
          },
        ],
        metroLines: [],
        vehicles: [],
      },
    });
    const backend = deferredDispatchBackend(snapshotWithRoute);
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend,
    });

    // Queue a deleteRoute (deferred — won't resolve until resolveNext).
    const deletePromise = runtime.deleteRoute("route-001");
    // The sync lookup in toggleRouteActive still sees the route (delete hasn't
    // resolved yet), so it queues its closure behind the delete.
    const togglePromise = runtime.toggleRouteActive("route-001");

    // Yield so the deleteRoute's queued operation starts and pushes its
    // deferred dispatch to the pending queue.
    await Promise.resolve();
    // Resolve the delete dispatch — the route is removed from state.
    // The toggle's closure then runs automatically in the queue chain: it
    // re-reads state, finds the route gone, returns null (no backend.dispatch),
    // and commits without dispatching setRouteActive.
    await backend.resolveNext();
    await deletePromise;
    await togglePromise;

    expect(backend.intents.some((i) => i.type === "setRouteActive")).toBe(
      false,
    );
  });

  it("dismissRejection is a no-op when there is no active rejection", async () => {
    const runtime = await createGameRuntime({
      hoverPreviewDebounceMs: 0,
      backend: backendSpy(),
    });
    const before = runtime.getSnapshot();
    runtime.dismissRejection();
    const after = runtime.getSnapshot();
    expect(after.rejection).toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });
});
