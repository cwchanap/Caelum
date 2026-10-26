import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import type { RuntimeController } from "../../src/runtime/types";
import { createFakeGameHost } from "../helpers/gameHost";

describe("road direction feedback with the real core", () => {
  let runtime: RuntimeController;

  beforeEach(async () => {
    const backend = await createWasmBackend();
    const city = await backend.buildSandboxSnapshot({
      templateId: "blankGrid",
      mapSize: "small",
      economyPreset: "standard",
      startingCapital: 120_000,
      demandMultiplier: 1,
    });
    if (!city.ok) throw new Error("Could not build test city");
    expect((await backend.restoreSnapshot(city.snapshot)).ok).toBe(true);
    expect(
      (
        await backend.dispatch({
          type: "layRoadLine",
          points: Array.from({ length: 9 }, (_, index) => ({
            x: index + 3,
            y: 4,
          })),
          preset: "twoWay",
        })
      ).applied,
    ).toBe(true);
    for (const x of [3, 11]) {
      expect(
        (await backend.dispatch({ type: "addBusStop", point: { x, y: 3 } }))
          .applied,
      ).toBe(true);
    }
    const presentation = await backend.presentation();
    expect(
      (
        await backend.dispatch({
          type: "createRoute",
          mode: "bus",
          pattern: "shuttle",
          waypointIds: presentation.scene!.stops.map((stop) => stop.id),
        })
      ).applied,
    ).toBe(true);
    runtime = await createGameRuntime({
      backend,
      createHost: createFakeGameHost,
      hoverPreviewDebounceMs: 0,
    });
    runtime.setTool("road");
  });

  afterEach(() => runtime?.dispose());

  it.each(["click", "stationary drag"] as const)(
    "explains a direction change and its broken shuttle after a %s",
    async (gesture) => {
      const before = runtime.getSnapshot();
      const route = before.state.transit.routes[0];
      expect(route.legs.every((leg) => leg.status === "connected")).toBe(true);

      if (gesture === "click") {
        await runtime.handleTileClick({ x: 7, y: 4 });
      } else {
        runtime.startDrag({ x: 7, y: 4 });
        await runtime.commitDrag();
      }

      const changed = runtime.getSnapshot();
      expect(
        changed.state.map.tiles.find((tile) => tile.x === 7 && tile.y === 4)
          ?.oneWay,
      ).toBe("north");
      expect(changed.state.transit.routes[0].pathBroken).toBe(true);
      expect(changed.state.budget).toBe(before.state.budget);
      expect(changed.shell.actionFeedback).toMatchObject({
        source: "roadDirection",
        tone: "warning",
        message: "Road set to one-way North. Click again to cycle direction.",
        details: [`${route.name} became broken after this direction change.`],
        dismissible: true,
        announce: true,
      });

      runtime.setHoverTile({ x: 1, y: 1 });
      await runtime.tick(0.1);
      expect(runtime.getSnapshot().shell.actionFeedback).toEqual(
        changed.shell.actionFeedback,
      );
      expect(runtime.dismissRejection().shell.actionFeedback?.source).not.toBe(
        "roadDirection",
      );
    },
  );

  it("reports each committed heading through the return to two-way", async () => {
    for (const direction of ["North", "East", "South", "West", null]) {
      const snapshot = await runtime.handleTileClick({ x: 7, y: 4 });
      expect(snapshot.shell.actionFeedback).toMatchObject({
        source: "roadDirection",
        message:
          direction === null
            ? "Road set to two-way. Click again to cycle direction."
            : `Road set to one-way ${direction}. Click again to cycle direction.`,
      });
      if (direction !== "North") {
        expect(snapshot.shell.actionFeedback?.details).toEqual([]);
      }
    }
    const snapshot = runtime.getSnapshot();
    expect(snapshot.state.transit.routes[0].pathBroken).toBe(false);
    expect(snapshot.shell.actionFeedback?.tone).toBe("info");
    expect(snapshot.shell.actionFeedback?.details).toEqual([]);
  });

  it("clears the notice on a later gameplay action and reports failures instead", async () => {
    await runtime.handleTileClick({ x: 7, y: 4 });
    const failure = await runtime.handleTileClick({ x: -1, y: 4 });
    expect(failure.rejection?.code).toBe("outOfBounds");
    expect(failure.shell.actionFeedback?.source).toBe("rejection");
    expect(runtime.dismissRejection().shell.actionFeedback).toBeNull();

    await runtime.handleTileClick({ x: 7, y: 4 });
    const built = await runtime.handleTileClick({ x: 1, y: 1 });
    expect(built.shell.actionFeedback).toBeNull();
  });

  it("does not claim a direction change when a junction ignores the click", async () => {
    runtime.startDrag({ x: 7, y: 2 });
    runtime.setDragCurrent({ x: 7, y: 6 });
    await runtime.commitDrag();
    const junction = runtime
      .getSnapshot()
      .state.map.tiles.find((tile) => tile.x === 7 && tile.y === 4);
    expect(junction?.roadStructureId).toBeDefined();

    await runtime.handleTileClick({ x: 5, y: 4 });
    expect(runtime.getSnapshot().shell.actionFeedback?.source).toBe(
      "roadDirection",
    );
    const clicked = await runtime.handleTileClick({ x: 7, y: 4 });
    expect(clicked.shell.actionFeedback).toBeNull();
    expect(
      clicked.state.map.tiles.find((tile) => tile.x === 7 && tile.y === 4),
    ).toEqual(junction);
  });

  it("clears the notice when a route draft is saved", async () => {
    await runtime.handleTileClick({ x: 1, y: 1 });
    await runtime.handleTileClick({ x: 1, y: 1 });
    expect(runtime.getSnapshot().shell.actionFeedback?.source).toBe(
      "roadDirection",
    );

    runtime.setTool("busRoute");
    runtime.setRoutePattern("shuttle");
    await runtime.handleTileClick({ x: 3, y: 3 });
    await runtime.handleTileClick({ x: 11, y: 3 });
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().shell.routeDraft?.canSave).toBe(true),
    );
    const saved = await runtime.saveRouteDraft();
    expect(saved.state.transit.routes).toHaveLength(2);
    expect(saved.shell.actionFeedback).toBeNull();
  });
});
