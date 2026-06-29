import { describe, expect, it, vi } from "vitest";
import type {
  GameMap,
  GameState,
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
    await firstFinish;

    expect(runtime.getSnapshot().ui.draftStopIds).toEqual([
      "stop-001",
      "stop-002",
    ]);
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
