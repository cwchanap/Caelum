import { describe, expect, it, vi } from "vitest";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import type { RuntimeSnapshot } from "../../src/runtime/types";

describe("Game Runtime", () => {
  it("manages game and UI state with shell-friendly selectors", () => {
    const runtime = createGameRuntime();

    // Set a tool and unpause
    runtime.setTool("busStop");
    runtime.togglePause();
    runtime.tick(1);

    const snapshot = runtime.getSnapshot();

    // Verify internal state is correctly managed
    expect(snapshot.ui.activeTool).toBe("busStop");
    expect(snapshot.state.paused).toBe(false);

    // Verify shell-friendly selectors
    expect(snapshot.shell.topbar.budget).toBe("$120,000");
    expect(snapshot.shell.brief.title).toBe("Growing Suburb");
  });

  it("publishes state changes to subscribers", () => {
    const runtime = createGameRuntime();
    const snapshots: RuntimeSnapshot[] = [];

    const unsubscribe = runtime.subscribe((snapshot) => {
      snapshots.push(snapshot);
    });

    runtime.setTool("busStop");
    runtime.togglePause();

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1].ui.activeTool).toBe("busStop");

    unsubscribe();
  });

  it("resets to initial state", () => {
    const runtime = createGameRuntime();

    runtime.setTool("busRoute");
    runtime.togglePause();
    runtime.setSpeed(2);

    runtime.reset();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.state.paused).toBe(true);
    expect(snapshot.state.speed).toBe(1);
  });

  it("resets transient UI state without changing simulation state", () => {
    const runtime = createGameRuntime();

    runtime.togglePause();
    runtime.setSpeed(4);
    runtime.tick(1);
    runtime.setOverlay("growth");
    runtime.handleTileClick({ x: 5, y: 5 });
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    runtime.setHudCategory("manage");

    const beforeReset = runtime.getSnapshot();
    expect(beforeReset.state.paused).toBe(false);
    expect(beforeReset.state.speed).toBe(4);
    expect(beforeReset.state.time).toBeGreaterThan(0);
    expect(beforeReset.ui.activeTool).toBe("busRoute");
    expect(beforeReset.ui.activeOverlay).toBe("growth");
    expect(beforeReset.ui.selectedId).toBe("5,5");
    expect(beforeReset.ui.draftStopIds).toEqual(["stop-001", "stop-002"]);
    expect(beforeReset.ui.draftStopPaths).toHaveLength(1);
    expect(beforeReset.ui.activeHudCategory).toBe("manage");

    runtime.resetUi();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.state.paused).toBe(false);
    expect(snapshot.state.speed).toBe(4);
    expect(snapshot.state.time).toBe(beforeReset.state.time);
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.ui.activeOverlay).toBe(null);
    expect(snapshot.ui.selectedId).toBe(null);
    expect(snapshot.ui.draftStopIds).toEqual([]);
    expect(snapshot.ui.draftStationIds).toEqual([]);
    expect(snapshot.ui.draftStopPaths).toEqual([]);
    expect(snapshot.ui.draftStationPaths).toEqual([]);
    expect(snapshot.ui.activeHudCategory).toBe("brief");
  });

  it("manages simulation lifecycle", () => {
    const runtime = createGameRuntime();

    runtime.start();
    expect(runtime.isRunning()).toBe(true);

    runtime.stop();
    expect(runtime.isRunning()).toBe(false);
  });

  it("does not schedule animation frames while paused", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const runtime = createGameRuntime();

    runtime.start();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    runtime.togglePause();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    runtime.stop();
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("does not fast-forward after resuming from a paused gap", () => {
    const callbacks: Array<(timestamp: number) => void> = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: (timestamp: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const runtime = createGameRuntime();
    runtime.start();
    runtime.togglePause();

    callbacks.shift()?.(1_000);
    expect(runtime.getSnapshot().state.time).toBe(0);

    runtime.togglePause();
    runtime.togglePause();

    callbacks.shift()?.(5_000);
    expect(runtime.getSnapshot().state.time).toBe(0);

    vi.unstubAllGlobals();
  });

  it("handles tool changes", () => {
    const runtime = createGameRuntime();

    runtime.setTool("metroStation");
    expect(runtime.getSnapshot().ui.activeTool).toBe("metroStation");

    runtime.setTool("inspect");
    expect(runtime.getSnapshot().ui.activeTool).toBe("inspect");
  });

  it("selects buildings separately from route tools and rotates them", () => {
    const runtime = createGameRuntime();

    runtime.setBuilding("busTerminal");
    runtime.rotateBuilding();
    runtime.rotateBuilding();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.activeTool).toBe("inspect");
    expect(snapshot.ui.selectedBuilding).toBe("busTerminal");
    expect(snapshot.ui.buildingRotation).toBe(180);
    expect(snapshot.shell.brief.activeTool).toBe("BUS TERMINAL 180");
  });

  it.each(["busRoute", "remove", "inspect"] as const)(
    "clears building selection when switching to %s",
    (tool) => {
      const runtime = createGameRuntime();

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

  it("handles overlay changes", () => {
    const runtime = createGameRuntime();

    runtime.setOverlay("coverage");
    expect(runtime.getSnapshot().ui.activeOverlay).toBe("coverage");

    runtime.setOverlay(null);
    expect(runtime.getSnapshot().ui.activeOverlay).toBe(null);
  });

  it("handles speed changes", () => {
    const runtime = createGameRuntime();

    runtime.setSpeed(2);
    expect(runtime.getSnapshot().state.speed).toBe(2);

    runtime.setSpeed(4);
    expect(runtime.getSnapshot().state.speed).toBe(4);
  });

  it("advances simulation time when ticking and unpaused", () => {
    const runtime = createGameRuntime();

    const beforeTime = runtime.getSnapshot().state.time;
    runtime.togglePause(); // unpause
    runtime.tick(1);
    const afterTime = runtime.getSnapshot().state.time;

    expect(afterTime).toBeGreaterThan(beforeTime);
  });

  it("does not advance time when paused", () => {
    const runtime = createGameRuntime();

    const beforeTime = runtime.getSnapshot().state.time;
    // starts paused by default
    runtime.tick(1);
    const afterTime = runtime.getSnapshot().state.time;

    expect(afterTime).toBe(beforeTime);
  });

  it("handles tile clicks", () => {
    const runtime = createGameRuntime();

    runtime.setTool("inspect");
    runtime.handleTileClick({ x: 5, y: 5 });

    expect(runtime.getSnapshot().ui.selectedId).toBe("5,5");
  });

  it("sets HUD category to data", () => {
    const runtime = createGameRuntime();

    const before = runtime.getSnapshot().ui.activeHudCategory;
    runtime.setHudCategory("data");
    const after = runtime.getSnapshot().ui.activeHudCategory;

    expect(before).toBe("brief");
    expect(after).toBe("data");
  });

  it("collapses the drawer when setHudCategory(null) is dispatched", () => {
    const runtime = createGameRuntime();
    runtime.setHudCategory("build");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");
    runtime.setHudCategory(null);
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });

  it("auto-opens the inspect drawer when a node is clicked, and collapses it on empty tiles", () => {
    const runtime = createGameRuntime();

    // Place a bus stop at a known tile, then inspect it through the real runtime.
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 7, y: 8 });

    runtime.setTool("inspect");
    const onNode = runtime.handleTileClick({ x: 7, y: 8 });

    expect(onNode.ui.activeHudCategory).toBe("inspect");
    expect(onNode.shell.inspector).not.toBeNull();
    expect(onNode.ui.selectedId).toBe("7,8");

    // Clicking an empty tile while the inspect drawer is open collapses it.
    const onEmpty = runtime.handleTileClick({ x: 20, y: 20 });
    expect(onEmpty.ui.activeHudCategory).toBeNull();
  });
});

describe("runtime assignRouteToPlatform", () => {
  it("returns unchanged state when the node does not exist", () => {
    const runtime = createGameRuntime();
    const before = runtime.getSnapshot();
    const after = runtime.assignRouteToPlatform(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
    expect(after.state).toBe(before.state); // no such node -> same state reference
  });
});

describe("runtime road preset", () => {
  it("sets the road preset and preserves it across tool switches", () => {
    const runtime = createGameRuntime();
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setTool("track");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.roadPreset).toBe("oneWay");
  });
});

describe("route creation and management", () => {
  function withTwoStops() {
    const runtime = createGameRuntime();
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 14, y: 7 });
    runtime.handleTileClick({ x: 14, y: 8 });
    return runtime;
  }

  it("finishes a drafted route and clears the draft", () => {
    const runtime = withTwoStops();
    expect(runtime.getSnapshot().ui.draftStopIds).toHaveLength(2);

    const snapshot = runtime.finishRoute();

    expect(snapshot.state.transit.routes).toHaveLength(1);
    expect(snapshot.ui.draftStopIds).toEqual([]);
  });

  it("removes a draft stop and cancels a draft", () => {
    const runtime = withTwoStops();
    const afterRemove = runtime.removeDraftStop(0);
    expect(afterRemove.ui.draftStopIds).toEqual(["stop-002"]);
    expect(afterRemove.ui.draftStopPaths).toEqual([]);

    const afterCancel = runtime.cancelRoute();
    expect(afterCancel.ui.draftStopIds).toEqual([]);
    expect(afterCancel.ui.draftStopPaths).toEqual([]);
  });

  it("renames, recolors, toggles, selects, and deletes a route", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();

    expect(
      runtime.renameRoute("route-001", "Loop").state.transit.routes[0].name,
    ).toBe("Loop");
    expect(
      runtime.recolorRoute("route-001", "#abcdef").state.transit.routes[0]
        .color,
    ).toBe("#abcdef");
    expect(
      runtime.toggleRouteActive("route-001").state.transit.routes[0].active,
    ).toBe(false);
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe(
      "route-001",
    );
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe(null);
    expect(runtime.deleteRoute("route-001").state.transit.routes).toEqual([]);
  });

  it("clears the selected route when switching tools", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();
    runtime.selectRoute("route-001");
    expect(runtime.setTool("inspect").ui.selectedRouteId).toBe(null);
  });

  it("clears the selected route when it is deleted", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();
    runtime.selectRoute("route-001");
    const snapshot = runtime.deleteRoute("route-001");
    expect(snapshot.ui.selectedRouteId).toBe(null);
    expect(snapshot.state.transit.routes).toEqual([]);
  });
});

describe("runtime road drag", () => {
  function tileKind(
    runtime: ReturnType<typeof createGameRuntime>,
    x: number,
    y: number,
  ) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((t) => t.x === x && t.y === y)?.kind;
  }

  it("builds a road line from startDrag -> move -> commitDrag", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    const snap = runtime.commitDrag();
    for (const x of [1, 2, 3, 4]) {
      expect(tileKind(runtime, x, 0)).toBe("road");
    }
    expect(snap.ui.drag).toBeNull();
  });

  it("treats a zero-length drag as a tap (cycles an existing road's direction)", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.startDrag({ x: 14, y: 8 }); // existing road tile
    runtime.setDragCurrent({ x: 14, y: 8 });
    runtime.commitDrag();
    expect(
      runtime.getSnapshot().state.map.tiles.find((t) => t.x === 14 && t.y === 8)
        ?.oneWay,
    ).toBe("north"); // first cycle: undefined -> north
  });

  it("bulldozes a line with the remove tool drag", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.setRoadPreset("twoWay");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    runtime.commitDrag();
    runtime.setTool("remove");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 3, y: 0 });
    runtime.commitDrag();
    for (const x of [1, 2, 3]) {
      expect(tileKind(runtime, x, 0)).toBe("empty");
    }
  });

  it("cancelDrag clears the drag without building", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    runtime.cancelDrag();
    expect(runtime.getSnapshot().ui.drag).toBeNull();
    expect(tileKind(runtime, 4, 0)).toBe("empty");
  });

  it("startDrag captures the tool and ignores a non-drag tool", () => {
    const runtime = createGameRuntime();
    runtime.setTool("inspect");
    // inspect is not a drag tool, so no gesture opens.
    runtime.startDrag({ x: 1, y: 0 });
    expect(runtime.getSnapshot().ui.drag).toBeNull();
  });

  it("setDragCurrent ignores an off-map (null) move so the preview holds", () => {
    const runtime = createGameRuntime();
    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 0 });
    runtime.setDragCurrent({ x: 4, y: 0 });
    runtime.setDragCurrent(null); // pointer wanders off-map mid-drag
    const gesture = runtime.getSnapshot().ui.drag;
    expect(gesture).not.toBeNull();
    expect(gesture?.current).toEqual({ x: 4, y: 0 }); // unchanged
  });
});

describe("runtime area drag", () => {
  function areaAt(
    runtime: ReturnType<typeof createGameRuntime>,
    x: number,
    y: number,
  ) {
    return runtime
      .getSnapshot()
      .state.map.tiles.find((tile) => tile.x === x && tile.y === y)?.area;
  }

  it("selects an area independently from buildings and tools", () => {
    const runtime = createGameRuntime();

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

  it("paints an area rectangle from startDrag -> move -> commitDrag", () => {
    const runtime = createGameRuntime();
    runtime.setArea("commercial");
    runtime.startDrag({ x: 1, y: 1 });
    runtime.setDragCurrent({ x: 2, y: 2 });

    const snap = runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("commercial");
    expect(areaAt(runtime, 2, 2)).toBe("commercial");
    expect(snap.ui.drag).toBeNull();
  });

  it("paints a single tile area drag", () => {
    const runtime = createGameRuntime();
    runtime.setArea("office");
    runtime.startDrag({ x: 1, y: 1 });

    runtime.commitDrag();

    expect(areaAt(runtime, 1, 1)).toBe("office");
  });

  it("clears area selection when a building is selected", () => {
    const runtime = createGameRuntime();
    runtime.setArea("residential");
    runtime.setBuilding("smallHouse");

    expect(runtime.getSnapshot().ui.selectedArea).toBeNull();
  });
});

describe("build drawer auto-hide", () => {
  it("closes the drawer when a tool or building is selected, but not on preset change", () => {
    const runtime = createGameRuntime();
    runtime.setHudCategory("build");
    runtime.setTool("road");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();

    runtime.setHudCategory("build");
    runtime.setRoadPreset("oneWay");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBe("build");

    runtime.setHudCategory("build");
    runtime.setBuilding("smallHouse");
    expect(runtime.getSnapshot().ui.activeHudCategory).toBeNull();
  });
});
