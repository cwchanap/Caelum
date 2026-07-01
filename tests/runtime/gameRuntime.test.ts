import { describe, expect, it, vi } from "vitest";
import type {
  GameMap,
  MetroLine,
  Point,
  RoadDirection,
  Route,
  Stop,
} from "../../src/domain/types";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../src/runtime/types";
import { createRustSnapshot } from "../fixtures/rustSnapshot";
import { createTestGameState } from "../helpers/gameState";

type BackendSpy = GameBackend & {
  intents: GameIntent[];
  rejectNextDispatch(): void;
  setSnapshot(next: RustGameSnapshot): void;
};

type DeferredDispatchBackend = BackendSpy & {
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

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
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
  if (intent.type === "addBusRoute") {
    const id = `route-${(snapshot.transit.routes.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const route: Route = {
      id,
      name: `Bus ${snapshot.transit.routes.length + 1}`,
      color: "#2563eb",
      stopIds: intent.stopIds,
      vehicleIds: [],
      active: true,
      segments: [],
      pathBroken: false,
    };
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        routes: [...snapshot.transit.routes, route],
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
  if (intent.type === "addMetroLine") {
    const id = `metro-${(snapshot.transit.metroLines.length + 1)
      .toString()
      .padStart(3, "0")}`;
    const line: MetroLine = {
      id,
      name: `Metro ${snapshot.transit.metroLines.length + 1}`,
      color: "#2867b2",
      stationIds: intent.stationIds,
      vehicleIds: [],
      active: true,
      segments: [],
      pathBroken: false,
    };
    return {
      ...snapshot,
      transit: {
        ...snapshot.transit,
        metroLines: [...snapshot.transit.metroLines, line],
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
      segmentIndex: 0,
      progress: 0,
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
  return snapshot;
}

function deferredDispatchBackend(
  initial: RustGameSnapshot = fullRustSnapshot(),
): DeferredDispatchBackend {
  const intents: GameIntent[] = [];
  const pending: Array<() => void> = [];
  let snapshot = initial;
  let rejectNext = false;

  return {
    intents,
    rejectNextDispatch() {
      rejectNext = true;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    async snapshot() {
      return snapshot;
    },
    async dispatch(intent): Promise<DispatchResult> {
      intents.push(intent);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
      if (rejectNext) {
        rejectNext = false;
        return { snapshot, applied: false, rejection: "rejected by test" };
      }
      snapshot = applyIntent(snapshot, intent);
      return { snapshot, applied: true, rejection: null };
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
      return { snapshot, applied: snapshot !== before, rejection: null };
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

  return {
    intents,
    rejectNextDispatch() {
      rejectNext = true;
    },
    setSnapshot(next) {
      snapshot = next;
    },
    async snapshot() {
      return snapshot;
    },
    async dispatch(intent): Promise<DispatchResult> {
      intents.push(intent);
      if (rejectNext) {
        rejectNext = false;
        return { snapshot, applied: false, rejection: "rejected by test" };
      }
      snapshot = applyIntent(snapshot, intent);
      return { snapshot, applied: true, rejection: null };
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
      return { snapshot, applied: snapshot !== before, rejection: null };
    },
    async reset() {
      snapshot = fullRustSnapshot();
      return snapshot;
    },
  };
}

describe("Game Runtime", () => {
  it("manages game and UI state with shell-friendly selectors", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });
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

  it("resets through the backend and resets UI state", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });

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

    const runtime = await createGameRuntime({ backend: backendSpy() });

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

    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend: backendSpy() });

    runtime.setTool("metroStation");
    expect(runtime.getSnapshot().ui.activeTool).toBe("metroStation");

    runtime.setTool("inspect");
    expect(runtime.getSnapshot().ui.activeTool).toBe("inspect");
  });

  it("selects buildings separately from route tools and rotates them", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend });

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
      const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });

    runtime.setOverlay("coverage");
    expect(runtime.getSnapshot().ui.activeOverlay).toBe("coverage");

    runtime.setOverlay(null);
    expect(runtime.getSnapshot().ui.activeOverlay).toBe(null);
  });

  it("dispatches pause and speed through the Rust backend", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });

    const beforeTime = runtime.getSnapshot().state.time;
    await runtime.togglePause();
    await runtime.tick(1);
    const afterTime = runtime.getSnapshot().state.time;

    expect(afterTime).toBeGreaterThan(beforeTime);
  });

  it("does not advance time when paused", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend });

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
      };
    });
    const baseDispatch = backend.dispatch;
    backend.dispatch = vi.fn(async (intent) => {
      dispatchCalls += 1;
      return baseDispatch(intent);
    });
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

    runtime.setTool("inspect");
    const snapshot = await runtime.handleTileClick({ x: 5, y: 5 });

    expect(snapshot.ui.selectedId).toBe("5,5");
    expect(backend.intents).toEqual([]);
  });

  it("sets HUD category to data", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });

    const before = runtime.getSnapshot().ui.activeHudCategory;
    runtime.setHudCategory("data");
    const after = runtime.getSnapshot().ui.activeHudCategory;

    expect(before).toBe("brief");
    expect(after).toBe("data");
  });

  it("collapses the drawer when setHudCategory(null) is dispatched", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setHudCategory("build");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");
    runtime.setHudCategory(null);
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });

  it("auto-opens the inspect drawer when a node is clicked, and collapses it on empty tiles", async () => {
    const runtime = await createGameRuntime({
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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setTool("track");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
  });
});

describe("route creation and management", () => {
  function routeMap(): GameMap {
    return [
      { x: 14, y: 7 },
      { x: 14, y: 8 },
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
            segments: [],
            pathBroken: false,
          },
        ],
        metroLines: [],
        vehicles: [],
      },
    });
  }

  async function withTwoStops(backend = backendSpy(routeSnapshot())) {
    const runtime = await createGameRuntime({ backend });
    runtime.setTool("busRoute");
    await runtime.handleTileClick({ x: 14, y: 7 });
    await runtime.handleTileClick({ x: 14, y: 8 });
    return { runtime, backend };
  }

  it("dispatches route finish and clears the draft only after Rust accepts it", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    backend.rejectNextDispatch();
    await runtime.finishRoute();
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    await runtime.finishRoute();

    expect(backend.intents).toContainEqual({
      type: "addBusRoute",
      stopIds: ["stop-001", "stop-002"],
    });
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([]);
  });

  it("chains assignVehicle after route creation so the line gets a vehicle", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    await runtime.finishRoute();

    // The create intent is followed by an assignVehicle intent for the new
    // line id, in order — mirroring the old atomic TS finishDraftRoute.
    const createIndex = backend.intents.findIndex(
      (intent) => intent.type === "addBusRoute",
    );
    const assignIndex = backend.intents.findIndex(
      (intent) => intent.type === "assignVehicle",
    );
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(assignIndex).toBeGreaterThan(createIndex);
    expect(backend.intents[assignIndex]).toEqual({
      type: "assignVehicle",
      mode: "bus",
      lineId: "route-001",
    });

    const route = runtime.getSnapshot().state.transit.routes[0];
    expect(route.vehicleIds).toEqual(["vehicle-001"]);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(1);
    expect(runtime.getSnapshot().state.transit.vehicles[0].lineId).toBe(
      "route-001",
    );
  });

  it("does not dispatch assignVehicle when the backend rejects the route", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    backend.rejectNextDispatch();
    await runtime.finishRoute();

    expect(backend.intents.some((i) => i.type === "assignVehicle")).toBe(false);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(0);
  });

  it("surfaces assignVehicle rejection as a recoverable rejection, not a fatal backendError", async () => {
    const base = backendSpy(routeSnapshot());
    // Wrap the spy so assignVehicle is rejected but other intents succeed.
    const rejectAssignVehicle = "insufficient budget for vehicle";
    const backend: BackendSpy = {
      ...base,
      async dispatch(intent) {
        if (intent.type === "assignVehicle") {
          return {
            snapshot: await base.snapshot(),
            applied: false,
            rejection: rejectAssignVehicle,
          };
        }
        return base.dispatch(intent);
      },
    };
    const { runtime } = await withTwoStops(backend);
    runtime.start();

    await runtime.finishRoute();

    const snapshot = runtime.getSnapshot();
    // The rejection must surface as a recoverable rejection, not a fatal
    // backendError that halts the runtime.
    expect(snapshot.rejection).toBe(rejectAssignVehicle);
    expect(snapshot.backendError).toBeNull();
    expect(runtime.isRunning()).toBe(true);
    // The route was created (addBusRoute succeeded) even though the vehicle
    // assignment was rejected.
    expect(snapshot.state.transit.routes).toHaveLength(1);
    expect(snapshot.state.transit.vehicles).toHaveLength(0);

    // Dismissing clears the rejection.
    runtime.dismissRejection();
    expect(runtime.getSnapshot().rejection).toBeNull();
  });

  it("does not let a slow route finish clear a newer draft", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    const firstFinish = runtime.finishRoute();
    await Promise.resolve();

    runtime.cancelRoute();
    await runtime.handleTileClick({ x: 14, y: 7 });
    await runtime.handleTileClick({ x: 14, y: 8 });
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);

    await backend.resolveNext();
    // `finishRoute` chains `addBusRoute` → `assignVehicle`; resolve the
    // vehicle-assignment dispatch too so the queued operation completes.
    await backend.resolveNext();
    await firstFinish;

    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
  });

  it("revalidates finish conditions against current state and bails when a prior queued dispatch drops budget", async () => {
    const backend = deferredDispatchBackend(routeSnapshot());
    const runtime = await createGameRuntime({ backend });

    // Enqueue a slow prior dispatch (addBusStop) that will resolve before the
    // finish closure runs, simulating a slow Tauri remove/build dispatch still
    // in flight when the player drafts and clicks Finish.
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 20, y: 20 });
    // Let the prior dispatch start and suspend at its await.
    await Promise.resolve();

    // Draft two stops and enqueue finish behind the prior dispatch.
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
    const finishPromise = runtime.finishRoute();

    // Simulate the prior dispatch resolving with a budget below the bus
    // vehicle cost (8_000). The finish closure must revalidate against this
    // state and bail rather than dispatch addBusRoute with insufficient
    // budget — which would create an unusable line and clear the draft.
    backend.setSnapshot({ ...routeSnapshot(), budget: 0 });
    await backend.resolveNext();
    await finishPromise;

    expect(
      backend.intents.some((intent) => intent.type === "addBusRoute"),
    ).toBe(false);
    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
    expect(runtime.getSnapshot().rejection).toBe("Route no longer valid");
  });

  it("revalidates that submitted stops still exist before dispatching", async () => {
    // A prior queued dispatch removes one of the submitted stops between
    // enqueue and closure entry; the finish must bail with "Route no longer
    // valid" rather than dispatch addBusRoute with a dangling stop id.
    const backend = deferredDispatchBackend(routeSnapshot());
    const runtime = await createGameRuntime({ backend });

    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 20, y: 20 });
    await Promise.resolve();

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    const finishPromise = runtime.finishRoute();

    // Simulate the prior dispatch resolving with a snapshot where stop-001
    // was removed (e.g. a demolish that ran while the finish was pending).
    const removedStopSnapshot = {
      ...routeSnapshot(),
      transit: {
        ...routeSnapshot().transit,
        stops: routeSnapshot().transit.stops.filter(
          (stop) => stop.id !== "stop-001",
        ),
      },
    };
    backend.setSnapshot(removedStopSnapshot);
    await backend.resolveNext();
    await finishPromise;

    expect(
      backend.intents.some((intent) => intent.type === "addBusRoute"),
    ).toBe(false);
    expect(runtime.getSnapshot().rejection).toBe("Route no longer valid");
  });

  it("revalidates that the closing loop still closes before dispatching", async () => {
    // A prior queued dispatch removes the road tiles connecting the two stops,
    // breaking the closing loop. The finish must bail rather than create a
    // pathBroken line that rejects assignVehicle. Both road tiles must be
    // removed because adjacent stops always have a pathable 2-tile hop unless
    // both endpoints are non-traversable.
    const backend = deferredDispatchBackend(routeSnapshot());
    const runtime = await createGameRuntime({ backend });

    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 20, y: 20 });
    await Promise.resolve();

    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    const finishPromise = runtime.finishRoute();

    // Remove both road tiles so the closing loop 002->001 cannot path.
    let brokenMap = updateTile(
      routeSnapshot().map,
      { x: 14, y: 7 },
      (tile) => ({
        ...tile,
        kind: "empty" as const,
      }),
    );
    brokenMap = updateTile(brokenMap, { x: 14, y: 8 }, (tile) => ({
      ...tile,
      kind: "empty" as const,
    }));
    backend.setSnapshot({ ...routeSnapshot(), map: brokenMap });
    await backend.resolveNext();
    await finishPromise;

    expect(
      backend.intents.some((intent) => intent.type === "addBusRoute"),
    ).toBe(false);
    expect(runtime.getSnapshot().rejection).toBe("Route no longer valid");
  });

  it("keeps the accepted snapshot when the backend creates a route but surfaces no new id", async () => {
    // If the backend accepts addBusRoute but returns a snapshot with no new
    // route id (an edge case), finishRoute must keep the accepted snapshot
    // rather than crash trying to assign a vehicle to a missing line.
    const base = backendSpy(routeSnapshot());
    const backend: BackendSpy = {
      ...base,
      async dispatch(intent) {
        if (intent.type === "addBusRoute") {
          // Accept but return the unchanged snapshot (no new route id).
          return {
            snapshot: await base.snapshot(),
            applied: true,
            rejection: null,
          };
        }
        return base.dispatch(intent);
      },
    };
    const { runtime } = await withTwoStops(backend);

    await runtime.finishRoute();

    // No vehicle was assigned (no new line id to target).
    expect(
      backend.intents.some((intent) => intent.type === "assignVehicle"),
    ).toBe(false);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(0);
  });

  it("does not duplicate a route on a concurrent double-finishRoute", async () => {
    const backend = backendSpy(routeSnapshot());
    const { runtime } = await withTwoStops(backend);

    // Two synchronous calls (double-click) both enqueue before either
    // resolves. The second closure must bail when it sees the draft was
    // cleared by the first — no duplicate route, no double-charge, no second
    // vehicle.
    const first = runtime.finishRoute();
    const second = runtime.finishRoute();
    await Promise.all([first, second]);

    const addBusRouteCount = backend.intents.filter(
      (intent) => intent.type === "addBusRoute",
    ).length;
    expect(addBusRouteCount).toBe(1);
    expect(runtime.getSnapshot().state.transit.routes).toHaveLength(1);
    expect(runtime.getSnapshot().state.transit.vehicles).toHaveLength(1);
  });

  it("removes a draft stop and cancels a draft", async () => {
    const { runtime } = await withTwoStops();
    const afterRemove = runtime.removeDraftStop(0);
    expect(afterRemove.ui.draftStopIds).toEqual(["stop-002"]);
    expect(afterRemove.ui.draftStopPaths).toEqual([]);

    const afterCancel = runtime.cancelRoute();
    expect(afterCancel.ui.draftStopIds).toEqual([]);
    expect(afterCancel.ui.draftStopPaths).toEqual([]);
  });

  it("renames, recolors, toggles, selects, and deletes a route", async () => {
    const { runtime } = await withTwoStops();
    await runtime.finishRoute();

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
    const runtime = await createGameRuntime({ backend });

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
    await runtime.finishRoute();
    runtime.selectRoute("route-001");
    expect(runtime.setTool("inspect").ui.selectedRouteId).toBe(null);
  });

  it("clears the selected route when it is deleted", async () => {
    const { runtime } = await withTwoStops();
    await runtime.finishRoute();
    runtime.selectRoute("route-001");
    const snapshot = await runtime.deleteRoute("route-001");
    expect(snapshot.ui.selectedRouteId).toBe(null);
    expect(snapshot.state.transit.routes).toEqual([]);
  });

  it("keeps the selected route when the backend rejects the delete", async () => {
    const backend = backendSpy(routeSnapshotWithRoute(true));
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

    backend.rejectNextDispatch();
    const snapshot = await runtime.setSpeed(2);

    expect(snapshot.rejection).toBe("rejected by test");
    expect(snapshot.backendError).toBeNull();

    // A subsequent successful dispatch auto-clears the rejection.
    const next = await runtime.setSpeed(4);
    expect(next.rejection).toBeNull();
  });

  it("preserves a placement rejection across a tick (not cleared ~16ms later)", async () => {
    const backend = backendSpy();
    const runtime = await createGameRuntime({ backend });
    await runtime.togglePause();

    // Surface a rejection via a rejected dispatch.
    backend.rejectNextDispatch();
    const rejected = await runtime.setSpeed(2);
    expect(rejected.rejection).toBe("rejected by test");

    // A tick must NOT overwrite the rejection — the Rust engine never returns
    // a rejection from tick(), so the banner should persist until dismissed.
    await runtime.tick(1);
    expect(runtime.getSnapshot().rejection).toBe("rejected by test");

    // Dismissing still works after a tick.
    runtime.dismissRejection();
    expect(runtime.getSnapshot().rejection).toBeNull();
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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    runtime.cancelDrag();
    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(tileKind(runtime, 4, 0)).toBe("empty");
  });

  it("startDrag captures the tool and ignores a non-drag tool", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setTool("inspect");
    runtime.startDrag({ x: 1, y: 0 });
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("startDrag on the area tool without a selected area is a no-op", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setTool("area");

    const before = runtime.getSnapshot();
    const after = runtime.startDrag({ x: 1, y: 1 });

    expect(after.ui.drag).toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
  });

  it("setDragCurrent ignores an off-map (null) move so the preview holds", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend: backendSpy() });

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
    const runtime = await createGameRuntime({ backend: backendSpy() });
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
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setArea("office");
    runtime.startDrag({ x: 1, y: 1 });

    await runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("office");
  });

  it("clears area selection when a building is selected", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
    runtime.setArea("residential");
    runtime.setBuilding("smallHouse");

    expect(runtime.getSnapshot().ui.selectedArea).toBeNull();
  });
});

describe("build drawer auto-hide", () => {
  it("closes the drawer when a tool, building, or area is selected, but not on preset change", async () => {
    const runtime = await createGameRuntime({ backend: backendSpy() });
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

  it("applies addMetroStation and addMetroLine to transit", async () => {
    const backend = backendSpy();

    const station = await backend.dispatch({
      type: "addMetroStation",
      point: { x: 4, y: 5 },
    });
    expect(station.snapshot.transit.stations).toHaveLength(1);
    expect(station.snapshot.transit.stations[0].platforms).toHaveLength(2);

    const line = await backend.dispatch({
      type: "addMetroLine",
      stationIds: ["station-001"],
    });
    expect(line.snapshot.transit.metroLines).toHaveLength(1);
    expect(line.snapshot.transit.metroLines[0].stationIds).toEqual([
      "station-001",
    ]);
  });

  it("applies assignRouteToPlatform to the targeted platform", async () => {
    const backend = backendSpy();
    await backend.dispatch({ type: "addBusStop", point: { x: 1, y: 1 } });
    await backend.dispatch({ type: "addBusRoute", stopIds: ["stop-001"] });

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
});
