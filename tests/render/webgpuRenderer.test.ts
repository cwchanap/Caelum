import { describe, expect, it } from "vitest";
import { SOLID_VERTEX_FLOATS } from "../../src/render/webgpu/primitives";
import {
  createWebGpuRenderer,
  VEHICLE_INSTANCE_FLOATS,
  type WebGpuRenderFrame,
} from "../../src/render/webgpu/renderer";
import { buildMapBatch } from "../../src/render/webgpu/mapBatch";
import { buildTransitBatch } from "../../src/render/webgpu/transitBatch";
import { buildOverlayRanges } from "../../src/render/webgpu/overlayBatch";
import type { GameState } from "../../src/domain/types";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import {
  createTestGameState,
  addTestBusRoute,
  addTestBusStop,
} from "../helpers/gameState";
import { pointsOnRow, withRoads } from "../helpers/mapFixtures";

interface FakeBuffer {
  size: number;
  destroyed: boolean;
  destroy(): void;
}

interface FakePipeline {
  descriptor: GPURenderPipelineDescriptor;
}

type FakePassOp =
  | { kind: "setPipeline"; pipeline: FakePipeline }
  | { kind: "setVertexBuffer"; slot: number; buffer: FakeBuffer }
  | { kind: "draw"; vertexCount: number; instanceCount: number };

interface FakePass {
  ops: FakePassOp[];
}

interface FakeWrite {
  buffer: FakeBuffer;
  data: Float32Array;
}

interface FakeHarness {
  buffers: FakeBuffer[];
  pipelines: FakePipeline[];
  writes: FakeWrite[];
  passes: FakePass[];
  device: GPUDevice;
  resolveLost(info: { reason?: string; message: string }): void;
}

function createFakeDevice(): FakeHarness {
  const harness: FakeHarness = {
    buffers: [],
    pipelines: [],
    writes: [],
    passes: [],
    device: null as unknown as GPUDevice,
    resolveLost: () => {},
  };
  let resolveLost: (info: {
    reason?: string;
    message: string;
  }) => void = () => {};
  const lost = new Promise<{ reason?: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });
  const makeBuffer = (descriptor: GPUBufferDescriptor): FakeBuffer => {
    const buffer: FakeBuffer = {
      size: descriptor.size,
      destroyed: false,
      destroy() {
        buffer.destroyed = true;
      },
    };
    harness.buffers.push(buffer);
    return buffer;
  };
  const device = {
    lost,
    createBuffer: makeBuffer,
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
      const pipeline: FakePipeline = { descriptor };
      harness.pipelines.push(pipeline);
      return pipeline;
    },
    createShaderModule() {
      return {};
    },
    createCommandEncoder() {
      const encoderPasses: FakePass[] = [];
      return {
        beginRenderPass(): GPURenderPassEncoder {
          const pass: FakePass = { ops: [] };
          encoderPasses.push(pass);
          return {
            setPipeline(pipeline: FakePipeline) {
              pass.ops.push({ kind: "setPipeline", pipeline });
            },
            setVertexBuffer(slot: number, buffer: FakeBuffer) {
              pass.ops.push({ kind: "setVertexBuffer", slot, buffer });
            },
            draw(vertexCount: number, instanceCount = 1) {
              pass.ops.push({ kind: "draw", vertexCount, instanceCount });
            },
            end() {},
          } as unknown as GPURenderPassEncoder;
        },
        finish() {
          return { passes: encoderPasses };
        },
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer(buffer: FakeBuffer, _offset: number, data: Float32Array) {
        harness.writes.push({ buffer, data });
      },
      submit(commandBuffers: { passes: FakePass[] }[]) {
        for (const commandBuffer of commandBuffers) {
          harness.passes.push(...commandBuffer.passes);
        }
      },
    },
  };
  harness.device = device as unknown as GPUDevice;
  harness.resolveLost = resolveLost;
  return harness;
}

function createFakeCanvas(): {
  canvas: HTMLCanvasElement;
  unconfigured: () => boolean;
} {
  let unconfigureCount = 0;
  const context = {
    configure() {},
    unconfigure() {
      unconfigureCount += 1;
    },
    getCurrentTexture() {
      return { createView: () => ({}) };
    },
  };
  const canvas = {
    getContext(type: string) {
      return type === "webgpu" ? context : null;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, unconfigured: () => unconfigureCount > 0 };
}

function solidVertices(vertexCount: number): Float32Array<ArrayBuffer> {
  return new Float32Array(vertexCount * SOLID_VERTEX_FLOATS);
}

function vehicleInstances(count: number): Float32Array<ArrayBuffer> {
  return new Float32Array(count * VEHICLE_INSTANCE_FLOATS);
}

function draws(
  pass: FakePass,
): { vertexCount: number; instanceCount: number }[] {
  return pass.ops
    .filter(
      (op): op is Extract<FakePassOp, { kind: "draw" }> => op.kind === "draw",
    )
    .map(({ vertexCount, instanceCount }) => ({ vertexCount, instanceCount }));
}

describe("WebGpuRenderer", () => {
  it("rejects unparseable canvas contexts and unconfigured renders", () => {
    const { device } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const bareCanvas = {} as HTMLCanvasElement;

    expect(() => renderer.configure(bareCanvas)).toThrow();
    expect(() => renderer.render({ solids: [], vehicles: [] })).toThrow();
  });

  it("pins source-alpha blending on the solid pipeline", () => {
    const { device, pipelines } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");

    const solid = pipelines.find((pipeline) =>
      Array.from(pipeline.descriptor.fragment?.targets ?? []).some(
        (target) => target?.blend,
      ),
    );
    expect(solid).toBeDefined();
    expect(Array.from(solid!.descriptor.fragment!.targets)[0]!.blend).toEqual({
      color: {
        srcFactor: "src-alpha",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
      alpha: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
    });

    const instanced = pipelines.filter((pipeline) =>
      Array.from(pipeline.descriptor.vertex.buffers ?? []).some(
        (buffer) => buffer?.stepMode === "instance",
      ),
    );
    expect(pipelines).toHaveLength(2);
    expect(instanced).toHaveLength(1);
  });

  it("caches solid buffers by string scene key and reuses them grow-only", () => {
    const { device, buffers, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const frame = (vertices: Float32Array<ArrayBuffer>): WebGpuRenderFrame => ({
      solids: [{ key: "scene-a", vertices }],
      vehicles: [],
    });

    renderer.render(frame(solidVertices(2)));
    expect(buffers).toHaveLength(2); // static vehicle quad buffer + scene buffer
    const sceneBuffer = buffers[1];
    expect(sceneBuffer.size).toBe(2 * SOLID_VERTEX_FLOATS * 4);

    // Smaller frame: same buffer reused, no growth, no destroy.
    renderer.render(frame(solidVertices(1)));
    expect(buffers).toHaveLength(2);
    expect(sceneBuffer.destroyed).toBe(false);

    // Larger frame: grow-only means destroy old and create a bigger buffer.
    renderer.render(frame(solidVertices(4)));
    expect(buffers).toHaveLength(3);
    expect(sceneBuffer.destroyed).toBe(true);
    expect(buffers[2].size).toBe(4 * SOLID_VERTEX_FLOATS * 4);

    const sceneWrites = writes.filter((write) => write.buffer !== buffers[0]);
    expect(sceneWrites).toHaveLength(3);
    expect(sceneWrites[1].data).toHaveLength(SOLID_VERTEX_FLOATS);
  });

  it("gives distinct string keys distinct buffers", () => {
    const { device, buffers } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const frame: WebGpuRenderFrame = {
      solids: [
        { key: "roads", vertices: solidVertices(1) },
        { key: "buildings", vertices: solidVertices(1) },
      ],
      vehicles: [],
    };
    renderer.render(frame);
    renderer.render(frame);

    // Two scene buffers + one quad buffer, stable across frames.
    expect(buffers).toHaveLength(3);
    expect(buffers[0]).not.toBe(buffers[1]);
  });

  it("records solid draws in frame order as ordered vertex ranges", () => {
    const { device, passes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const stats = renderer.render({
      solids: [
        { key: "roads", vertices: solidVertices(12) },
        { key: "buildings", vertices: solidVertices(6) },
      ],
      vehicles: [],
    });

    expect(passes).toHaveLength(1);
    expect(draws(passes[0])).toEqual([
      { vertexCount: 12, instanceCount: 1 },
      { vertexCount: 6, instanceCount: 1 },
    ]);
    expect(stats).toEqual({
      solidBatches: 2,
      solidVertices: 18 * SOLID_VERTEX_FLOATS,
      vehicleInstances: 0,
    });
  });

  it("uploads vehicles once and draws them in one instanced call", () => {
    const { device, passes, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const routeA = vehicleInstances(2);
    const routeB = vehicleInstances(1);
    const stats = renderer.render({
      solids: [],
      vehicles: [
        { key: "route-a", instances: routeA },
        { key: "route-b", instances: routeB },
      ],
    });

    const vehicleDraws = draws(passes[0]).filter(
      (draw) => draw.instanceCount > 1,
    );
    expect(vehicleDraws).toEqual([{ vertexCount: 6, instanceCount: 3 }]);
    expect(stats.vehicleInstances).toBe(3);

    // Exactly one upload of the concatenated instance data.
    const instanceWrites = writes.filter(
      (write) => write.data.length % VEHICLE_INSTANCE_FLOATS === 0,
    );
    expect(instanceWrites).toHaveLength(1);
    expect(Array.from(instanceWrites[0].data)).toEqual([
      ...Array.from(routeA),
      ...Array.from(routeB),
    ]);
  });

  it("maps device loss onto the exposed lost promise", async () => {
    const { device, resolveLost } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    resolveLost({ reason: "destroyed", message: "device destroyed" });

    await expect(renderer.lost).resolves.toEqual({
      reason: "destroyed",
      message: "device destroyed",
    });
  });

  it("destroys cached buffers and unconfigures the canvas", () => {
    const { device, buffers } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas, unconfigured } = createFakeCanvas();
    renderer.configure(canvas);
    renderer.render({
      solids: [{ key: "scene-a", vertices: solidVertices(1) }],
      vehicles: [{ key: "route-a", instances: vehicleInstances(1) }],
    });

    renderer.destroy();

    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(unconfigured()).toBe(true);
  });

  describe("gameplay painter order and caching", () => {
    function gameplayState(): GameState {
      let state = createTestGameState();
      state = withRoads(state, pointsOnRow(8, 7, 15));
      state = addTestBusStop(state, { x: 7, y: 8 });
      state = addTestBusStop(state, { x: 15, y: 8 });
      return addTestBusRoute(state, ["stop-001", "stop-002"]);
    }

    function gameplayUi(
      state: GameState,
      overrides: Partial<UiState> = {},
    ): UiState {
      return {
        ...createUiState(),
        activeOverlay: "coverage",
        routeDraft: {
          ...createDraft("bus", 1),
          waypointIds: ["stop-001", "stop-002"],
          generation: 1,
          preview: {
            generation: 1,
            legs: state.transit.routes[0].legs,
            totalTravelSeconds: 1,
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
          },
        },
        ...overrides,
      };
    }

    function gameplayFrame(
      state: GameState,
      ui: UiState,
      sceneRevision: number,
      vehicleData: number[],
    ): {
      frame: WebGpuRenderFrame;
      route: ReturnType<typeof buildTransitBatch>;
      overlay: ReturnType<typeof buildOverlayRanges>;
      structural: Float32Array<ArrayBuffer>;
    } {
      const route = buildTransitBatch(state, ui, sceneRevision);
      const overlay = buildOverlayRanges(state, ui);
      const structural = buildMapBatch(state);
      const instances = new Float32Array(Array.from(vehicleData));
      return {
        structural,
        overlay,
        route,
        frame: {
          solids: [
            { key: `scene:${sceneRevision}`, vertices: structural },
            { key: "dynamic:underRoutes", vertices: overlay.underRoutes },
            { key: route.routeStyleKey, vertices: route.vertices },
            { key: "dynamic:routeDraft", vertices: overlay.routeDraft },
          ],
          vehicles: [{ key: "route-001", instances }],
          overVehicles: [
            { key: "dynamic:overVehicles", vertices: overlay.overVehicles },
          ],
        },
      };
    }

    function drawStages(
      pass: FakePass,
      writes: FakeWrite[],
      labeled: Array<[Float32Array, string]>,
      quadBuffer: FakeBuffer,
    ): string[] {
      const bufferLabel = new Map<FakeBuffer, string>();
      for (const [data, label] of labeled) {
        const write = writes.find((candidate) => candidate.data === data);
        if (write !== undefined) {
          bufferLabel.set(write.buffer, label);
        }
      }
      const slots = new Map<number, FakeBuffer>();
      const stages: string[] = [];
      for (const op of pass.ops) {
        if (op.kind === "setVertexBuffer") {
          slots.set(op.slot, op.buffer);
        }
        if (op.kind === "draw") {
          stages.push(
            slots.get(0) === quadBuffer && op.vertexCount === 6
              ? "vehicles"
              : (bufferLabel.get(slots.get(0)!) ?? "unknown"),
          );
        }
      }
      return stages;
    }

    function bufferFor(writes: FakeWrite[], data: Float32Array): FakeBuffer {
      const write = writes.find((candidate) => candidate.data === data);
      expect(write).toBeDefined();
      return write!.buffer;
    }

    it("draws the six gameplay stages in painter order", () => {
      const { device, buffers, passes, writes } = createFakeDevice();
      const renderer = createWebGpuRenderer(device, "bgra8unorm");
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const ui = gameplayUi(state);
      const { frame, route, overlay, structural } = gameplayFrame(
        state,
        ui,
        3,
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      );

      renderer.render(frame);

      expect(passes).toHaveLength(1);
      expect(
        drawStages(
          passes[0],
          writes,
          [
            [structural, "structural"],
            [overlay.underRoutes, "underRoutes"],
            [route.vertices, "routes"],
            [overlay.routeDraft, "routeDraft"],
            [overlay.overVehicles, "overVehicles"],
          ],
          buffers[0],
        ),
      ).toEqual([
        "structural",
        "underRoutes",
        "routes",
        "routeDraft",
        "vehicles",
        "overVehicles",
      ]);
    });

    it("reuses structural and route buffers across frame-only vehicle changes", () => {
      const { device, buffers, writes } = createFakeDevice();
      const renderer = createWebGpuRenderer(device, "bgra8unorm");
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const ui = gameplayUi(state);
      const first = gameplayFrame(state, ui, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const second = gameplayFrame(state, ui, 3, [9, 8, 7, 6, 5, 4, 3, 2, 1]);

      renderer.render(first.frame);
      const bufferCount = buffers.length;
      renderer.render(second.frame);

      // Same keys: no buffers created or destroyed.
      expect(buffers).toHaveLength(bufferCount);
      expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);
      // Structural and route geometry are re-uploaded into the same buffers.
      expect(bufferFor(writes, second.structural)).toBe(
        bufferFor(writes, first.structural),
      );
      expect(bufferFor(writes, second.route.vertices)).toBe(
        bufferFor(writes, first.route.vertices),
      );
      expect(first.route.routeStyleKey).toBe(second.route.routeStyleKey);
    });

    it("selection emphasis invalidates only the route geometry buffer", () => {
      const { device, buffers, writes } = createFakeDevice();
      const renderer = createWebGpuRenderer(device, "bgra8unorm");
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const unselected = gameplayFrame(
        state,
        gameplayUi(state),
        2,
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
      const selected = gameplayFrame(
        state,
        gameplayUi(state, { selectedRouteId: "route-001" }),
        2,
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      );

      renderer.render(unselected.frame);
      const bufferCount = buffers.length;
      renderer.render(selected.frame);

      expect(unselected.route.routeStyleKey).toBe("routes:2:-:-");
      expect(selected.route.routeStyleKey).toBe("routes:2:route-001:-");
      // New emphasis key: exactly one new buffer for the route stage.
      expect(buffers).toHaveLength(bufferCount + 1);
      // Structural geometry keeps its scene-key buffer.
      expect(bufferFor(writes, selected.structural)).toBe(
        bufferFor(writes, unselected.structural),
      );
      // Route geometry moved to a fresh buffer for the new key.
      expect(bufferFor(writes, selected.route.vertices)).not.toBe(
        bufferFor(writes, unselected.route.vertices),
      );
    });
  });
});
