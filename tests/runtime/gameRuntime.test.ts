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
    expect(snapshot.shell.controlTower.title).toBe("Growing Suburb");
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
    runtime.toggleControlTower();
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 7, y: 8 });

    const beforeReset = runtime.getSnapshot();
    expect(beforeReset.state.paused).toBe(false);
    expect(beforeReset.state.speed).toBe(4);
    expect(beforeReset.state.time).toBeGreaterThan(0);
    expect(beforeReset.ui.activeTool).toBe("busRoute");
    expect(beforeReset.ui.activeOverlay).toBe("growth");
    expect(beforeReset.ui.selectedId).toBe("5,5");
    expect(beforeReset.ui.draftStopIds).toEqual(["stop-001"]);
    expect(beforeReset.ui.controlTowerOpen).toBe(false);

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
    expect(snapshot.ui.controlTowerOpen).toBe(true);
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
    expect(snapshot.shell.controlTower.activeTool).toBe("BUS TERMINAL 180");
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

  it("toggles control tower", () => {
    const runtime = createGameRuntime();

    const before = runtime.getSnapshot().ui.controlTowerOpen;
    runtime.toggleControlTower();
    const after = runtime.getSnapshot().ui.controlTowerOpen;

    expect(after).toBe(!before);
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

describe("route creation and management", () => {
  function withTwoStops() {
    const runtime = createGameRuntime();
    runtime.setTool("busStop");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
    runtime.setTool("busRoute");
    runtime.handleTileClick({ x: 7, y: 8 });
    runtime.handleTileClick({ x: 15, y: 8 });
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
    expect(runtime.removeDraftStop(0).ui.draftStopIds).toEqual(["stop-002"]);
    expect(runtime.cancelRoute().ui.draftStopIds).toEqual([]);
  });

  it("renames, recolors, toggles, selects, and deletes a route", () => {
    const runtime = withTwoStops();
    runtime.finishRoute();

    expect(runtime.renameRoute("route-001", "Loop").state.transit.routes[0].name).toBe("Loop");
    expect(runtime.recolorRoute("route-001", "#abcdef").state.transit.routes[0].color).toBe("#abcdef");
    expect(runtime.toggleRouteActive("route-001").state.transit.routes[0].active).toBe(false);
    expect(runtime.selectRoute("route-001").ui.selectedRouteId).toBe("route-001");
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
