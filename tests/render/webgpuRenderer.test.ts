import { describe, expect, it } from "vitest";
import { SOLID_VERTEX_FLOATS } from "../../src/render/webgpu/primitives";
import { createWebGpuRenderer } from "../../src/render/webgpu/renderer";
import {
  SPRITE_INSTANCE_FLOATS,
  VEHICLE_INSTANCE_FLOATS,
  VEHICLE_LANE_OFFSET_PX,
  type RenderFrame,
} from "../../src/render/gameplayRenderer";
import {
  VEHICLE_HALF_LENGTH,
  VEHICLE_HALF_WIDTH,
} from "../../src/render/webgpu/vehicleInstances";
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
import {
  createFakeCanvas,
  createFakeDevice,
  type FakeBuffer,
  type FakePass,
  type FakePassOp,
  type FakePipeline,
  type FakeTexture,
  type FakeWrite,
} from "../helpers/fakeWebGpu";

function solidVertices(vertexCount: number): Float32Array<ArrayBuffer> {
  return new Float32Array(vertexCount * SOLID_VERTEX_FLOATS);
}

function vehicleInstances(count: number): Float32Array<ArrayBuffer> {
  return new Float32Array(count * VEHICLE_INSTANCE_FLOATS);
}

/** One arbitrary-but-distinct 11-float instance row for gameplay fixtures. */
function vehicleRow(seed: number): number[] {
  return Array.from({ length: VEHICLE_INSTANCE_FLOATS }, (_, i) => seed + i);
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

function spriteInstances(count: number): Float32Array<ArrayBuffer> {
  return new Float32Array(count * SPRITE_INSTANCE_FLOATS);
}

/** Descriptor shaped like the production atlas (spriteAtlas.ts); the fake
 *  only records it, but tsc still checks the GPUTextureDescriptor. */
function spriteAtlasTexture(device: GPUDevice): GPUTexture {
  return device.createTexture({
    size: [576, 384, 15],
    format: "rgba8unorm",
    usage: 0x04 | 0x02 | 0x10,
  });
}

/** Instance-strided pipelines: 44 = vehicles, 40 = sprites. Both draw the
 *  shared six-vertex unit quad, so stage classification cannot use
 *  vertexCount alone. */
function pipelineWithInstanceStride(
  pipelines: FakePipeline[],
  stride: number,
): FakePipeline {
  const pipeline = pipelines.find((candidate) =>
    Array.from(candidate.descriptor.vertex.buffers ?? []).some(
      (buffer) =>
        buffer?.stepMode === "instance" && buffer.arrayStride === stride,
    ),
  );
  expect(pipeline).toBeDefined();
  return pipeline!;
}

describe("createWebGpuRenderer", () => {
  it("rejects unparseable canvas contexts and unconfigured renders", () => {
    const { device } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const bareCanvas = {} as HTMLCanvasElement;

    expect(() => renderer.configure(bareCanvas)).toThrow();
    expect(() => renderer.render({ solids: [], vehicles: [] })).toThrow();
  });

  it("rejects a canvas that has no webgpu context", () => {
    const { device } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    // getContext exists but WebGPU is unavailable (old browser / disabled).
    const canvas = {
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    expect(() => renderer.configure(canvas)).toThrow(
      "canvas does not provide a webgpu context",
    );
  });

  it("pins source-alpha blending on the solid pipeline", () => {
    const { device, pipelines } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");

    const solid = pipelines.find((pipeline) =>
      Array.from(pipeline.descriptor.fragment?.targets ?? []).some(
        (target) => target?.blend?.color.srcFactor === "src-alpha",
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

    const sprite = pipelines.find((pipeline) =>
      Array.from(pipeline.descriptor.fragment?.targets ?? []).some(
        (target) => target?.blend?.color.srcFactor === "one",
      ),
    );
    expect(sprite).toBeDefined();
    // Premultiplied-alpha blending: color src=one, dst=one-minus-src-alpha.
    expect(Array.from(sprite!.descriptor.fragment!.targets)[0]!.blend).toEqual({
      color: {
        srcFactor: "one",
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
    // Solid, vehicle, and sprite pipelines; only vehicle+sprite instance.
    expect(pipelines).toHaveLength(3);
    expect(instanced).toHaveLength(2);
  });

  it("pins the sprite sampler to linear mag/min/mipmap filtering", () => {
    const { device, samplers } = createFakeDevice();
    const texture = spriteAtlasTexture(device);
    createWebGpuRenderer(device, "bgra8unorm", texture);

    expect(samplers).toHaveLength(1);
    expect(samplers[0]!.descriptor).toEqual({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
  });

  it("binds the sampler and the atlas array view in one sprite bind group", () => {
    const { device, bindGroups } = createFakeDevice();
    const texture = spriteAtlasTexture(device);
    createWebGpuRenderer(device, "bgra8unorm", texture);

    expect(bindGroups).toHaveLength(1);
    const entries = Array.from(bindGroups[0]!.descriptor.entries);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.binding).toBe(0);
    expect(entries[1]!.binding).toBe(1);
    // Binding 1 must reference a view of the texture the renderer owns.
    const view = entries[1]!.resource as { texture?: { destroyed?: boolean } };
    expect(view).toBeDefined();
  });

  it("pins the sprite instance layout consumed by the WGSL vertex shader", () => {
    const { device, pipelines } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");

    const instanceBuffer = Array.from(
      pipelineWithInstanceStride(pipelines, SPRITE_INSTANCE_FLOATS * 4)
        .descriptor.vertex.buffers ?? [],
    ).find((buffer) => buffer?.stepMode === "instance");
    expect(instanceBuffer).toBeDefined();
    // 10 floats: world origin(x,y) angle extents(x,y) uvScale(x,y) layer,
    // plus the two trailing clip-scale slots the host projection fills.
    expect(instanceBuffer!.arrayStride).toBe(40);
    expect(instanceBuffer!.arrayStride).toBe(SPRITE_INSTANCE_FLOATS * 4);
    expect(Array.from(instanceBuffer!.attributes!)).toEqual([
      { shaderLocation: 1, offset: 0, format: "float32x2" }, // world origin
      { shaderLocation: 2, offset: 8, format: "float32" }, // world angle
      { shaderLocation: 3, offset: 12, format: "float32x2" }, // world half-extents
      { shaderLocation: 4, offset: 20, format: "float32x2" }, // uv scale
      { shaderLocation: 5, offset: 28, format: "float32" }, // texture layer
      { shaderLocation: 6, offset: 32, format: "float32x2" }, // clip factors
    ]);
  });

  it("pins the vehicle instance layout consumed by the WGSL vertex shader", () => {
    const { device, pipelines } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");

    const instanceBuffer = Array.from(
      pipelineWithInstanceStride(pipelines, VEHICLE_INSTANCE_FLOATS * 4)
        .descriptor.vertex.buffers ?? [],
    ).find((buffer) => buffer?.stepMode === "instance");
    expect(instanceBuffer).toBeDefined();
    // 11 floats: origin(x,y) angle extents(l,w) rgba clipScale(x,y).
    expect(instanceBuffer!.arrayStride).toBe(44);
    expect(instanceBuffer!.arrayStride).toBe(VEHICLE_INSTANCE_FLOATS * 4);
    expect(Array.from(instanceBuffer!.attributes!)).toEqual([
      { shaderLocation: 1, offset: 0, format: "float32x2" }, // clip origin
      { shaderLocation: 2, offset: 8, format: "float32" }, // world angle
      { shaderLocation: 3, offset: 12, format: "float32x2" }, // world half-extents
      { shaderLocation: 4, offset: 20, format: "float32x4" }, // color
      { shaderLocation: 5, offset: 36, format: "float32x2" }, // trailing clip factors
    ]);
  });

  it("uploads vehicle instances whose clip factors keep quads tiny, not fullscreen", () => {
    // Regression guard for the WKWebView orange-canvas bug: instances must
    // carry world-px half-extents plus small world→clip factors. Feeding
    // device-px extents as clip units drew ~7x-fullscreen quads.
    const { device, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    renderer.configure(createFakeCanvas().canvas);

    // One instance as the host emits it: clip origin, raw world angle, world
    // half-extents (7x4 px), and clip factors for a 2560x1224 backing store
    // (world→device scale ~2.125).
    const scale = 2.125;
    const clipScaleX = (2 * scale) / 2560;
    const clipScaleY = -(2 * scale) / 1224;
    const instances = new Float32Array([
      0.1,
      -0.2,
      Math.PI / 2,
      7,
      4,
      0.88,
      0.31,
      0.22,
      1,
      clipScaleX,
      clipScaleY,
    ]);
    renderer.render({ solids: [], vehicles: [{ instances }] });

    const uploaded = writes.find(
      (write) => write.data.length === VEHICLE_INSTANCE_FLOATS,
    );
    expect(uploaded).toBeDefined();
    const row = Array.from(uploaded!.data);
    // Half-extents stay world px — NOT scaled to ~15 device px.
    expect(row[3]).toBe(7);
    expect(row[4]).toBe(4);
    // Clip factors sit in trailing slots 9..10 and are ~0.0017 magnitude.
    expect(row[9]).toBeCloseTo(clipScaleX, 9);
    expect(row[10]).toBeCloseTo(clipScaleY, 9);
    // Implied clip-space quad half-extent: tiny (well under the ±1 viewport).
    const clipHalfExtent = row[3]! * Math.abs(row[9]!);
    expect(clipHalfExtent).toBeCloseTo((7 * scale * 2) / 2560, 9);
    expect(clipHalfExtent).toBeLessThan(0.02);
  });

  it("offsets the vehicle body by a fixed lane offset with the enlarged extents", () => {
    // Canvas-era parity, adapted for HPA-678: the old 2D renderer drew
    // fillRect(-7, -14, 14, 8) after translate+rotate — a body offset
    // perpendicular off the path centerline so it is not invisible inside the
    // same-colored route line (WKWebView parity bug). The offset is now the
    // fixed VEHICLE_LANE_OFFSET_PX, decoupled from the half-width so a wider
    // body does not slide into neighbouring tiles. Evaluate the real WGSL
    // local transform (captured from createShaderModule) at the quad
    // corners; rotation is rigid, so the pre-rotation frame pins the shape.
    const { device, shaders } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");
    const components = /let local = vec2f\(\s*([^;]+?)\s*\);/
      .exec(shaders[1]!)![1]
      .replace(/,\s*$/, "")
      .split(",")
      .map((expr) => expr.trim());
    expect(components).toHaveLength(2);
    const localAt = new Function(
      "corner",
      "extents",
      `return [${components[0]}, ${components[1]}];`,
    ) as (
      corner: { x: number; y: number },
      extents: { x: number; y: number },
    ) => [number, number];

    const cornersFor = (extents: { x: number; y: number }) =>
      [
        { x: -0.5, y: -0.5 },
        { x: 0.5, y: -0.5 },
        { x: -0.5, y: 0.5 },
        { x: 0.5, y: 0.5 },
      ].map((corner) => localAt(corner, extents));
    const bodyCenterY = (corners: [number, number][]) =>
      (Math.min(...corners.map(([, y]) => y)) +
        Math.max(...corners.map(([, y]) => y))) /
      2;

    const extents = { x: VEHICLE_HALF_LENGTH, y: VEHICLE_HALF_WIDTH };
    const corners = cornersFor(extents);
    expect(Math.min(...corners.map(([x]) => x))).toBe(-9);
    expect(Math.max(...corners.map(([x]) => x))).toBe(9);
    expect(Math.min(...corners.map(([, y]) => y))).toBe(-13);
    expect(Math.max(...corners.map(([, y]) => y))).toBe(-3);
    const wider = cornersFor({ x: extents.x, y: extents.y + 4 });
    expect(bodyCenterY(wider)).toBe(-VEHICLE_LANE_OFFSET_PX);
    expect(bodyCenterY(corners)).toBe(-VEHICLE_LANE_OFFSET_PX);
  });

  it("carries the white body rim inside the one instanced vehicle pass", () => {
    const { device, shaders } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");
    const shader = shaders[1]!;
    expect(shader).toContain("@location(1) quad: vec2f");
    expect(shader).toContain("output.quad = corner * extents * 2.0");
    expect(shader).toContain("vec4f(1.0, 1.0, 1.0");
  });

  it("samples the layered atlas through one array binding with y-down rotation", () => {
    // The sprite pass shares the vehicle shader's world-space rotation and
    // per-instance clip projection, samples a texture_2d_array layer per
    // instance, and maps the quad onto the layer's top-left source rect.
    const { device, shaders } = createFakeDevice();
    createWebGpuRenderer(device, "bgra8unorm");
    const shader = shaders[2]!;
    expect(shader).toContain("texture_2d_array<f32>");
    expect(shader).toContain(
      "textureSample(spriteLayers, spriteSampler, output.uv, layer)",
    );
    expect(shader).toContain(
      "output.uv = (corner + vec2f(0.5, 0.5)) * uvScale",
    );
    expect(shader).toContain("output.layer = layer");

    // Evaluate the real WGSL rotation at the quad corners: a native 3x2
    // building (half-extents 1.5x1 tiles) at 90° must span 2 tiles wide x 3
    // tall — extents stay unrotated in the instance; only the shader turns.
    const components = /let rotated = vec2f\(\s*([^;]+?)\s*\);/
      .exec(shaders[2]!)![1]
      .replace(/,\s*$/, "")
      .split(",")
      .map((expr) => expr.trim());
    expect(components).toHaveLength(2);
    const rotatedAt = new Function(
      "local",
      "angle",
      `let cos = Math.cos(angle); let sin = Math.sin(angle);
       return [${components[0]}, ${components[1]}];`,
    ) as (local: { x: number; y: number }, angle: number) => [number, number];
    const halfExtents = { x: 1.5, y: 1 };
    const corners = [
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: -0.5 },
      { x: -0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ].map((corner) =>
      rotatedAt(
        {
          x: corner.x * halfExtents.x * 2,
          y: corner.y * halfExtents.y * 2,
        },
        Math.PI / 2,
      ),
    );
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3);
    // Angle 0 keeps the native 3x2 orientation.
    const levelCorners = [
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: 0.5 },
    ].map((corner) =>
      rotatedAt(
        {
          x: corner.x * halfExtents.x * 2,
          y: corner.y * halfExtents.y * 2,
        },
        0,
      ),
    );
    expect(levelCorners[1]![0] - levelCorners[0]![0]).toBeCloseTo(3);
    expect(levelCorners[1]![1] - levelCorners[0]![1]).toBeCloseTo(2);
  });

  it("reuses one grow-only buffer per role across frames", () => {
    const { device, buffers, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const frame = (vertices: Float32Array<ArrayBuffer>): RenderFrame => ({
      solids: [{ role: "structural", vertices }],
      vehicles: [],
    });

    renderer.render(frame(solidVertices(2)));
    expect(buffers).toHaveLength(2); // static vehicle quad buffer + structural buffer
    const structuralBuffer = buffers[1];
    expect(structuralBuffer.size).toBe(2 * SOLID_VERTEX_FLOATS * 4);

    // Smaller frame: same buffer reused, no growth, no destroy.
    renderer.render(frame(solidVertices(1)));
    expect(buffers).toHaveLength(2);
    expect(structuralBuffer.destroyed).toBe(false);

    // Larger frame: grow-only means destroy old and create a bigger buffer.
    renderer.render(frame(solidVertices(4)));
    expect(buffers).toHaveLength(3);
    expect(structuralBuffer.destroyed).toBe(true);
    expect(buffers[2].size).toBe(4 * SOLID_VERTEX_FLOATS * 4);

    const sceneWrites = writes.filter((write) => write.buffer !== buffers[0]);
    expect(sceneWrites).toHaveLength(3);
    expect(sceneWrites[1].data).toHaveLength(SOLID_VERTEX_FLOATS);
  });

  it("keeps exactly one buffer per role across scene revisions and emphasis changes", () => {
    // Spec pin: GPU buffer identity is role-based, so a new scene revision
    // does NOT create a second structural buffer and an emphasis change does
    // NOT create a second route buffer — geometry is re-uploaded in place.
    const { device, buffers, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const solid = (role: "structural" | "route", n: number) => ({
      role,
      vertices: solidVertices(n),
    });
    const revisionA: RenderFrame = {
      solids: [solid("structural", 2), solid("route", 3)],
      vehicles: [],
    };
    const revisionB: RenderFrame = {
      // "New scene revision": different geometry content, same sizes/roles.
      solids: [solid("structural", 2), solid("route", 3)],
      vehicles: [],
    };

    renderer.render(revisionA);
    const bufferCount = buffers.length;
    renderer.render(revisionB);

    expect(buffers).toHaveLength(bufferCount);
    expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);

    // Each role's writes land in one stable buffer across revisions.
    const roleBuffers = (frame: RenderFrame) =>
      frame.solids.map(
        (batch) =>
          writes.find((write) => write.data === batch.vertices)!.buffer,
      );
    const [structuralA, routeA] = roleBuffers(revisionA);
    const [structuralB, routeB] = roleBuffers(revisionB);
    expect(structuralA).not.toBe(routeA);
    expect(structuralB).toBe(structuralA);
    expect(routeB).toBe(routeA);
  });

  it("shares one dynamic buffer across the ordered dynamic ranges at distinct offsets", () => {
    const { device, buffers, writes, passes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const under = solidVertices(2);
    const draft = solidVertices(3);
    renderer.render({
      solids: [
        { role: "dynamic", vertices: under },
        { role: "dynamic", vertices: draft },
      ],
      vehicles: [],
    });

    // One dynamic buffer (plus the quad), both ranges uploaded into it at
    // consecutive byte offsets, and each draw binds its own offset.
    expect(buffers).toHaveLength(2);
    const underWrite = writes.find((write) => write.data === under)!;
    const draftWrite = writes.find((write) => write.data === draft)!;
    expect(underWrite.buffer).toBe(draftWrite.buffer);
    expect(underWrite.offset).toBe(0);
    expect(draftWrite.offset).toBe(2 * SOLID_VERTEX_FLOATS * 4);
    const bindings = passes[0].ops.filter(
      (op) => op.kind === "setVertexBuffer",
    ) as Extract<FakePassOp, { kind: "setVertexBuffer" }>[];
    expect(bindings.map((binding) => binding.offset)).toEqual([
      0,
      2 * SOLID_VERTEX_FLOATS * 4,
    ]);
  });

  it("records solid draws in frame order as ordered vertex ranges", () => {
    const { device, passes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const stats = renderer.render({
      solids: [
        { role: "structural", vertices: solidVertices(12) },
        { role: "structural", vertices: solidVertices(6) },
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
      spriteInstances: 0,
      spriteDraws: 0,
      vehicleInstances: 0,
      vehicleDraws: 0,
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
      vehicles: [{ instances: routeA }, { instances: routeB }],
    });

    const vehicleDraws = draws(passes[0]).filter(
      (draw) => draw.instanceCount > 1,
    );
    expect(vehicleDraws).toEqual([{ vertexCount: 6, instanceCount: 3 }]);
    expect(stats.vehicleInstances).toBe(3);
    expect(stats.vehicleDraws).toBe(1);
    expect(stats.spriteInstances).toBe(0);
    expect(stats.spriteDraws).toBe(0);

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

  it("throws when a nonempty sprite batch has no sprite texture", async () => {
    const { device } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    renderer.configure(createFakeCanvas().canvas);

    const frame: RenderFrame = {
      solids: [],
      sprites: { instances: spriteInstances(1) },
      vehicles: [],
    };
    expect(() => renderer.render(frame)).toThrow(/sprite texture/);
    // The same guard covers the capture path (one shared encodeFrame).
    renderer.resize(2, 2);
    await expect(renderer.captureFrame(frame)).rejects.toThrow(
      /sprite texture/,
    );
    // An empty sprite batch stays legal for no-sprite callers.
    expect(renderer.render({ solids: [], vehicles: [] }).spriteDraws).toBe(0);
  });

  it("draws all sprites in one instanced call with grow-only buffers and stats", () => {
    const { device, passes, writes } = createFakeDevice();
    const texture = spriteAtlasTexture(device);
    const renderer = createWebGpuRenderer(device, "bgra8unorm", texture);
    const { canvas } = createFakeCanvas();
    renderer.configure(canvas);

    const stats = renderer.render({
      solids: [],
      sprites: { instances: spriteInstances(2) },
      vehicles: [],
    });

    expect(stats.spriteInstances).toBe(2);
    expect(stats.spriteDraws).toBe(1);
    expect(draws(passes[0])).toEqual([{ vertexCount: 6, instanceCount: 2 }]);
    // One upload of the sprite rows into the dedicated grow-only buffer.
    const spriteWrite = writes.find(
      (write) => write.data.length === 2 * SPRITE_INSTANCE_FLOATS,
    );
    expect(spriteWrite).toBeDefined();
    const spriteBuffer = spriteWrite!.buffer;
    expect(spriteBuffer.size).toBe(2 * SPRITE_INSTANCE_FLOATS * 4);
    // The quad lives in slot 0, the instance rows in slot 1.
    const bindings = passes[0].ops.filter(
      (op) => op.kind === "setVertexBuffer",
    ) as Extract<FakePassOp, { kind: "setVertexBuffer" }>[];
    expect(bindings.map((binding) => binding.slot)).toEqual([0, 1]);
    // One bind group binds the texture for the instanced draw.
    const bindGroupOps = passes[0].ops.filter(
      (op) => op.kind === "setBindGroup",
    ) as Extract<FakePassOp, { kind: "setBindGroup" }>[];
    expect(bindGroupOps).toHaveLength(1);

    // Smaller later frame: buffer reused, never shrunk or recreated.
    renderer.render({
      solids: [],
      sprites: { instances: spriteInstances(1) },
      vehicles: [],
    });
    expect(spriteBuffer.destroyed).toBe(false);
    const writeCount = writes.length;
    renderer.render({ solids: [], vehicles: [] });
    expect(writes).toHaveLength(writeCount);

    // Mutating a previously rendered array in place still reaches the GPU:
    // every nonempty sprite frame uploads its instance rows.
    const sameInstances = spriteInstances(2);
    renderer.render({
      solids: [],
      sprites: { instances: sameInstances },
      vehicles: [],
    });
    sameInstances[0] = 123;
    const writesAfterFirst = writes.length;
    renderer.render({
      solids: [],
      sprites: { instances: sameInstances },
      vehicles: [],
    });
    expect(writes.length).toBe(writesAfterFirst + 1);
    expect(writes[writes.length - 1]!.data[0]).toBe(123);

    // Larger frame: grow-only replace.
    const bigger = renderer.render({
      solids: [],
      sprites: { instances: spriteInstances(4) },
      vehicles: [],
    });
    expect(spriteBuffer.destroyed).toBe(true);
    expect(bigger.spriteInstances).toBe(4);
    expect(bigger.spriteDraws).toBe(1);
  });

  it("unconfigures the canvas context without destroying cached GPU resources", () => {
    const { device, buffers } = createFakeDevice();
    const texture = spriteAtlasTexture(device);
    const renderer = createWebGpuRenderer(device, "bgra8unorm", texture);
    const { canvas, unconfigured } = createFakeCanvas();
    renderer.configure(canvas);
    renderer.render({
      solids: [{ role: "structural", vertices: solidVertices(1) }],
      sprites: { instances: spriteInstances(1) },
      vehicles: [{ instances: vehicleInstances(1) }],
    });

    renderer.unconfigure();

    expect(unconfigured()).toBe(true);
    expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);
    expect((texture as unknown as FakeTexture).destroyed).toBe(false);
    expect(() => renderer.render({ solids: [], vehicles: [] })).toThrow(
      /not configured/,
    );
  });

  it("destroys the owned sprite atlas texture with the renderer", () => {
    const { device, buffers } = createFakeDevice();
    const texture = spriteAtlasTexture(device);
    const renderer = createWebGpuRenderer(device, "bgra8unorm", texture);
    renderer.configure(createFakeCanvas().canvas);
    renderer.render({
      solids: [{ role: "structural", vertices: solidVertices(1) }],
      sprites: { instances: spriteInstances(1) },
      vehicles: [{ instances: vehicleInstances(1) }],
    });

    renderer.destroy();

    expect((texture as unknown as FakeTexture).destroyed).toBe(true);
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
  });

  it("captures sprite frames through the same encode path as presentation", async () => {
    const harness = createFakeDevice();
    const texture = spriteAtlasTexture(harness.device);
    const renderer = createWebGpuRenderer(
      harness.device,
      "bgra8unorm",
      texture,
    );
    renderer.configure(createFakeCanvas().canvas);
    renderer.resize(2, 2);
    harness.onMapRead = () => {};

    const frame: RenderFrame = {
      solids: [{ role: "structural", vertices: solidVertices(1) }],
      sprites: { instances: spriteInstances(1) },
      vehicles: [],
    };
    const presented = renderer.render(frame);
    const shot = await renderer.captureFrame(frame);

    expect(shot).not.toBeNull();
    // Capture re-encodes the same batches: structural solid + one sprite
    // draw, identical to the presented pass.
    expect(presented.spriteDraws).toBe(1);
    expect(harness.passes).toHaveLength(2);
    for (const pass of harness.passes) {
      expect(draws(pass)).toEqual([
        { vertexCount: 1, instanceCount: 1 },
        { vertexCount: 6, instanceCount: 1 },
      ]);
    }
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

  it("reconfiguring releases the previous quad buffer", () => {
    const { device, buffers } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    renderer.configure(createFakeCanvas().canvas);
    const firstQuad = buffers.at(-1)!;

    renderer.configure(createFakeCanvas().canvas);

    expect(firstQuad.destroyed).toBe(true);
    expect(buffers.at(-1)!.destroyed).toBe(false);
  });

  it("destroys cached buffers and unconfigures the canvas", () => {
    const { device, buffers } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    const { canvas, unconfigured } = createFakeCanvas();
    renderer.configure(canvas);
    renderer.render({
      solids: [{ role: "structural", vertices: solidVertices(1) }],
      vehicles: [{ instances: vehicleInstances(1) }],
    });

    renderer.destroy();

    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(unconfigured()).toBe(true);
  });

  it("captureFrame returns row-tight RGBA8 pixels from the padded readback", async () => {
    const harness = createFakeDevice();
    const renderer = createWebGpuRenderer(harness.device, "bgra8unorm");

    // Unconfigured (no quad buffer) and configured-but-unsized both return
    // null rather than capturing an empty target.
    expect(
      await renderer.captureFrame({ solids: [], vehicles: [] }),
    ).toBeNull();
    renderer.configure(createFakeCanvas().canvas);
    expect(
      await renderer.captureFrame({ solids: [], vehicles: [] }),
    ).toBeNull();

    renderer.resize(2, 2);
    // Stage a 2x2 BGRA image at the 256-byte-aligned copy stride.
    harness.onMapRead = (buffer) => {
      buffer.backing.set([10, 20, 30, 255, 40, 50, 60, 255], 0);
      buffer.backing.set([70, 80, 90, 255, 100, 110, 120, 255], 256);
    };
    const shot = await renderer.captureFrame({ solids: [], vehicles: [] });

    expect(shot).not.toBeNull();
    expect(shot!.width).toBe(2);
    expect(shot!.height).toBe(2);
    // Padding stripped and BGRA normalized to RGBA (ImageData order).
    expect(Array.from(shot!.pixels)).toEqual([
      30, 20, 10, 255, 60, 50, 40, 255, 90, 80, 70, 255, 120, 110, 100, 255,
    ]);

    // The capture target is a RENDER_ATTACHMENT|COPY_SRC texture whose rows
    // copy out at the 256-aligned stride; both it and the readback buffer are
    // released afterwards.
    const texture = harness.textures[0]!;
    expect(texture.descriptor.usage).toBe(0x10 | 0x01);
    expect(harness.copies[0]!.bytesPerRow).toBe(256);
    expect(texture.destroyed).toBe(true);
    expect(harness.buffers.at(-1)!.destroyed).toBe(true);
  });

  it("captureFrame keeps rgba8unorm pixels in channel order", async () => {
    const harness = createFakeDevice();
    const renderer = createWebGpuRenderer(harness.device, "rgba8unorm");
    renderer.configure(createFakeCanvas().canvas);
    renderer.resize(1, 1);
    harness.onMapRead = (buffer) => {
      buffer.backing.set([30, 20, 10, 255], 0);
    };
    const shot = await renderer.captureFrame({ solids: [], vehicles: [] });
    expect(Array.from(shot!.pixels)).toEqual([30, 20, 10, 255]);
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
            initialFleetCost: null,
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
      frame: RenderFrame;
      route: ReturnType<typeof buildTransitBatch>;
      overlay: ReturnType<typeof buildOverlayRanges>;
      structural: Float32Array<ArrayBuffer>;
      sprites: Float32Array<ArrayBuffer>;
    } {
      const route = buildTransitBatch(state, ui, sceneRevision);
      const overlay = buildOverlayRanges(state, ui);
      const batch = buildMapBatch(state);
      const instances = new Float32Array(Array.from(vehicleData));
      return {
        structural: batch.vertices,
        sprites: batch.sprites,
        overlay,
        route,
        frame: {
          solids: [{ role: "structural", vertices: batch.vertices }],
          sprites: { instances: batch.sprites },
          overSprites: [
            { role: "dynamic", vertices: overlay.underRoutes },
            { role: "route", vertices: route.vertices },
            { role: "dynamic", vertices: overlay.routeDraft },
          ],
          vehicles: [{ instances }],
          overVehicles: [{ role: "dynamic", vertices: overlay.overVehicles }],
        },
      };
    }

    function drawStages(
      pass: FakePass,
      writes: FakeWrite[],
      labeled: Array<[Float32Array, string]>,
      vehiclePipeline: FakePipeline,
      spritePipeline: FakePipeline,
    ): string[] {
      // Ordered ranges of one role share a buffer, so solid stages are
      // labeled by (buffer, byte offset) write pairs, not by buffer identity.
      // The two instanced draws (sprites, vehicles) both use six quad
      // vertices, so they are classified by pipeline identity instead.
      const labelByWrite = new Map<FakeWrite, string>();
      for (const [data, label] of labeled) {
        const write = writes.find((candidate) => candidate.data === data);
        if (write !== undefined) {
          labelByWrite.set(write, label);
        }
      }
      const slots = new Map<number, { buffer: FakeBuffer; offset: number }>();
      let activePipeline: FakePipeline | null = null;
      const stages: string[] = [];
      for (const op of pass.ops) {
        if (op.kind === "setPipeline") {
          activePipeline = op.pipeline;
          continue;
        }
        if (op.kind === "setVertexBuffer") {
          slots.set(op.slot, { buffer: op.buffer, offset: op.offset });
        }
        if (op.kind === "draw") {
          if (activePipeline === vehiclePipeline) {
            stages.push("vehicles");
            continue;
          }
          if (activePipeline === spritePipeline) {
            stages.push("sprites");
            continue;
          }
          const binding = slots.get(0)!;
          const stage = [...labelByWrite.entries()].find(
            ([write]) =>
              write.buffer === binding.buffer &&
              write.offset === binding.offset,
          );
          stages.push(stage?.[1] ?? "unknown");
        }
      }
      return stages;
    }

    function bufferFor(writes: FakeWrite[], data: Float32Array): FakeBuffer {
      const write = writes.find((candidate) => candidate.data === data);
      expect(write).toBeDefined();
      return write!.buffer;
    }

    it("draws the seven gameplay stages in painter order", () => {
      const { device, pipelines, passes, writes } = createFakeDevice();
      const spriteTexture = spriteAtlasTexture(device);
      const renderer = createWebGpuRenderer(
        device,
        "bgra8unorm",
        spriteTexture,
      );
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const ui = gameplayUi(state);
      const { frame, route, overlay, structural, sprites } = gameplayFrame(
        state,
        ui,
        3,
        vehicleRow(1),
      );

      renderer.render(frame);

      expect(passes).toHaveLength(1);
      expect(
        drawStages(
          passes[0],
          writes,
          [
            [structural, "structural"],
            [sprites, "sprites"],
            [overlay.underRoutes, "underRoutes"],
            [route.vertices, "routes"],
            [overlay.routeDraft, "routeDraft"],
            [overlay.overVehicles, "overVehicles"],
          ],
          pipelineWithInstanceStride(pipelines, VEHICLE_INSTANCE_FLOATS * 4),
          pipelineWithInstanceStride(pipelines, SPRITE_INSTANCE_FLOATS * 4),
        ),
      ).toEqual([
        "structural",
        "sprites",
        "underRoutes",
        "routes",
        "routeDraft",
        "vehicles",
        "overVehicles",
      ]);
    });

    it("reuses structural, sprite and route buffers across frame-only vehicle changes", () => {
      const { device, buffers, writes } = createFakeDevice();
      const renderer = createWebGpuRenderer(
        device,
        "bgra8unorm",
        spriteAtlasTexture(device),
      );
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const ui = gameplayUi(state);
      const first = gameplayFrame(state, ui, 3, vehicleRow(1));
      const second = gameplayFrame(state, ui, 3, vehicleRow(9));

      renderer.render(first.frame);
      const bufferCount = buffers.length;
      renderer.render(second.frame);

      // Same keys: no buffers created or destroyed.
      expect(buffers).toHaveLength(bufferCount);
      expect(buffers.every((buffer) => !buffer.destroyed)).toBe(true);
      // Structural, sprite, and route geometry are re-uploaded into the
      // same buffers.
      expect(bufferFor(writes, second.structural)).toBe(
        bufferFor(writes, first.structural),
      );
      expect(bufferFor(writes, second.sprites)).toBe(
        bufferFor(writes, first.sprites),
      );
      expect(bufferFor(writes, second.route.vertices)).toBe(
        bufferFor(writes, first.route.vertices),
      );
      expect(first.route.routeStyleKey).toBe(second.route.routeStyleKey);
    });

    it("selection emphasis re-uploads route geometry into the same role buffer", () => {
      const { device, buffers, writes } = createFakeDevice();
      const renderer = createWebGpuRenderer(
        device,
        "bgra8unorm",
        spriteAtlasTexture(device),
      );
      const { canvas } = createFakeCanvas();
      renderer.configure(canvas);

      const state = gameplayState();
      const unselected = gameplayFrame(
        state,
        gameplayUi(state),
        2,
        vehicleRow(1),
      );
      const selected = gameplayFrame(
        state,
        gameplayUi(state, { selectedRouteId: "route-001" }),
        2,
        vehicleRow(1),
      );

      renderer.render(unselected.frame);
      const bufferCount = buffers.length;
      renderer.render(selected.frame);

      expect(unselected.route.routeStyleKey).toBe("routes:2:-:-");
      expect(selected.route.routeStyleKey).toBe("routes:2:route-001:-");
      // Buffer identity is role-based: the emphasis change re-tessellates the
      // route range (halo geometry is bigger, so the route buffer grows once,
      // grow-only) instead of retaining a second per-key route buffer.
      expect(buffers).toHaveLength(bufferCount + 1);
      const destroyed = buffers.filter((buffer) => buffer.destroyed);
      expect(destroyed).toHaveLength(1);
      // Structural geometry keeps its buffer across the emphasis change.
      const structuralBuffer = bufferFor(writes, unselected.structural);
      expect(bufferFor(writes, selected.structural)).toBe(structuralBuffer);
      expect(destroyed[0]).not.toBe(structuralBuffer);
    });
  });
});
