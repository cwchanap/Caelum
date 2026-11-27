import { colors } from "../colors";
import { SOLID_VERTEX_FLOATS, parseColor } from "./primitives";
import {
  SPRITE_INSTANCE_FLOATS,
  VEHICLE_INSTANCE_FLOATS,
  VEHICLE_RIM_PX,
  type BatchRole,
  type CapturedFrame,
  type GameplayRenderer,
  type RenderFrame,
  type RenderStats,
  type SolidBatch,
  type WebGpuDeviceLoss,
} from "../gameplayRenderer";

type BufferRole = BatchRole | "vehicle" | "sprite";

const [emptyR, emptyG, emptyB] = parseColor(colors.empty);
const CLEAR_COLOR: GPUColor = { r: emptyR, g: emptyG, b: emptyB, a: 1 };

// GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST. @webgpu/types is ambient
// types only, so the numeric flags are used directly (no runtime globals in
// node/jsdom tests).
const VERTEX_COPY_DST_USAGE = 0x20 | 0x08;
// GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC — capture target.
const CAPTURE_TEXTURE_USAGE = 0x10 | 0x01;
// GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST — readback staging buffer.
const READBACK_BUFFER_USAGE = 0x01 | 0x08;
// GPUMapMode.READ for mapAsync.
const MAP_READ_MODE = 0x0001;
// copyTextureToBuffer requires each row padded to a 256-byte multiple.
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/** Formats a shared TypeScript number as an unrounded WGSL float literal. */
function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

const SOLID_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vsMain(@location(0) position: vec2f, @location(1) color: vec4f) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn fsMain(output: VertexOutput) -> @location(0) vec4f {
  return output.color;
}
`;

const VEHICLE_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) quad: vec2f,
  @location(2) extents: vec2f,
};

@vertex
fn vsMain(
  @location(0) corner: vec2f,
  @location(1) origin: vec2f,
  @location(2) angle: f32,
  @location(3) extents: vec2f,
  @location(4) color: vec4f,
  @location(5) clipScale: vec2f,
) -> VertexOutput {
  // Rotate the body in y-down world space, then project with separate clip
  // factors (clipScale.y is negative for the y-flip). Rotating in clip space
  // would shear the quad on anisotropic viewports, and device-px extents fed
  // as clip units would draw it fullscreen.
  let cos = cos(angle);
  let sin = sin(angle);
  // The body spans double the half-extents, centered on the sampled route
  // position. Corridor lane placement is already baked into that origin.
  let local = vec2f(
    corner.x * (extents.x * 2.0),
    corner.y * (extents.y * 2.0),
  );
  let rotated = vec2f(
    local.x * cos - local.y * sin,
    local.x * sin + local.y * cos,
  );
  var output: VertexOutput;
  output.position = vec4f(
    origin + vec2f(rotated.x * clipScale.x, rotated.y * clipScale.y),
    0.0,
    1.0,
  );
  output.color = color;
  output.quad = corner * extents * 2.0;
  output.extents = extents;
  return output;
}

@fragment
fn fsMain(output: VertexOutput) -> @location(0) vec4f {
  let edge = min(
    output.extents.x - abs(output.quad.x),
    output.extents.y - abs(output.quad.y),
  );
  if (edge < ${wgslFloat(VEHICLE_RIM_PX)}) {
    return vec4f(1.0, 1.0, 1.0, output.color.a);
  }
  return output.color;
}
`;

const SPRITE_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) layer: f32,
  @location(2) @interpolate(flat) tint: vec4f,
};

@group(0) @binding(0) var spriteSampler: sampler;
@group(0) @binding(1) var spriteLayers: texture_2d_array<f32>;

@vertex
fn vsMain(
  @location(0) corner: vec2f,
  @location(1) origin: vec2f,
  @location(2) angle: f32,
  @location(3) extents: vec2f,
  @location(4) uvScale: vec2f,
  @location(5) layer: f32,
  @location(6) tint: vec4f,
  @location(7) clipScale: vec2f,
) -> VertexOutput {
  // Same y-down world rotation and per-instance world→clip scale as the
  // vehicle shader: rotate in world space, project with separate clip
  // factors (clipScale.y carries the y-flip).
  let cos = cos(angle);
  let sin = sin(angle);
  let local = corner * extents * 2.0;
  let rotated = vec2f(
    local.x * cos - local.y * sin,
    local.x * sin + local.y * cos,
  );
  var output: VertexOutput;
  output.position = vec4f(
    origin + vec2f(rotated.x * clipScale.x, rotated.y * clipScale.y),
    0.0,
    1.0,
  );
  // Each layer holds its sprite in the top-left; the quad maps exactly onto
  // that source rect. v=0 (texture top) sits at corner.y=-0.5, the screen
  // top after the clip y-flip.
  output.uv = (corner + vec2f(0.5, 0.5)) * uvScale;
  output.layer = layer;
  output.tint = tint;
  return output;
}

@fragment
fn fsMain(output: VertexOutput) -> @location(0) vec4f {
  let layer = i32(output.layer + 0.5);
  let texel = textureSample(spriteLayers, spriteSampler, output.uv, layer);
  return vec4f(texel.rgb * output.tint.rgb * output.tint.a, texel.a * output.tint.a);
}
`;

const INSTANCE_BLEND: GPUBlendState = {
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
};

// Premultiplied-alpha blending for the uploaded sprite atlas (uploads use
// premultipliedAlpha: true); keeps straight-alpha solids/vehicles unchanged.
const SPRITE_BLEND: GPUBlendState = {
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
};

interface BufferEntry {
  buffer: GPUBuffer;
  capacityBytes: number;
}

export function createWebGpuRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
  /** The pre-uploaded layered sprite atlas (spriteAtlas.ts). Production
   *  always passes it; no-sprite renderer/benchmark test callers omit it. */
  spriteTexture?: GPUTexture,
): GameplayRenderer {
  const lost: Promise<WebGpuDeviceLoss> = device.lost.then((info) => ({
    reason: info.reason,
    message: info.message,
  }));

  const solidModule = device.createShaderModule({ code: SOLID_SHADER });
  const vehicleModule = device.createShaderModule({ code: VEHICLE_SHADER });
  const spriteModule = device.createShaderModule({ code: SPRITE_SHADER });

  const solidPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: solidModule,
      entryPoint: "vsMain",
      buffers: [
        {
          arrayStride: SOLID_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: solidModule,
      entryPoint: "fsMain",
      targets: [{ format, blend: INSTANCE_BLEND }],
    },
  });

  const vehiclePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: vehicleModule,
      entryPoint: "vsMain",
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: VEHICLE_INSTANCE_FLOATS * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x2" },
            { shaderLocation: 2, offset: 8, format: "float32" },
            { shaderLocation: 3, offset: 12, format: "float32x2" },
            { shaderLocation: 4, offset: 20, format: "float32x4" },
            { shaderLocation: 5, offset: 36, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module: vehicleModule,
      entryPoint: "fsMain",
      targets: [{ format, blend: INSTANCE_BLEND }],
    },
  });

  const spritePipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: spriteModule,
      entryPoint: "vsMain",
      buffers: [
        {
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: SPRITE_INSTANCE_FLOATS * 4,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x2" },
            { shaderLocation: 2, offset: 8, format: "float32" },
            { shaderLocation: 3, offset: 12, format: "float32x2" },
            { shaderLocation: 4, offset: 20, format: "float32x2" },
            { shaderLocation: 5, offset: 28, format: "float32" },
            { shaderLocation: 6, offset: 32, format: "float32x4" },
            { shaderLocation: 7, offset: 48, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module: spriteModule,
      entryPoint: "fsMain",
      targets: [{ format, blend: SPRITE_BLEND }],
    },
  });

  // Owned by the renderer: destroyed with its other GPU resources in
  // destroy(). The textured sprite pipeline consumes it.
  let spriteAtlas: GPUTexture | null = spriteTexture ?? null;
  // Only the bind group needs the texture; the pipeline exists even for
  // no-sprite callers, and encodeFrame throws if a nonempty sprite batch
  // arrives without one.
  let spriteBindGroup: GPUBindGroup | null = null;
  if (spriteAtlas !== null) {
    const spriteSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });
    spriteBindGroup = device.createBindGroup({
      layout: spritePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: spriteSampler },
        { binding: 1, resource: spriteAtlas.createView() },
      ],
    });
  }
  // Unit quad (two triangles) covering [-0.5, 0.5]^2; vehicles and sprites
  // transform it per instance. Recreated on configure() so a host remount
  // after a canvas unmount reuses the renderer (role buffers re-acquire
  // lazily in acquireBuffer).
  const quadCorners = [
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ];
  let quadBuffer: GPUBuffer | null = null;

  const buffers = new Map<BufferRole, BufferEntry>();
  let context: GPUCanvasContext | null = null;
  // Pixel size of the configured canvas, owned via resize(); also the size of
  // the offscreen captureFrame target.
  let pixelWidth = 0;
  let pixelHeight = 0;

  function ensureQuadBuffer(): void {
    quadBuffer?.destroy();
    quadBuffer = device.createBuffer({
      size: quadCorners.length * 4,
      usage: VERTEX_COPY_DST_USAGE,
    });
    device.queue.writeBuffer(quadBuffer, 0, new Float32Array(quadCorners));
  }

  function acquireBuffer(role: BufferRole, floatCount: number): GPUBuffer {
    const bytes = floatCount * 4;
    const entry = buffers.get(role);
    if (entry && bytes <= entry.capacityBytes) {
      return entry.buffer;
    }
    entry?.buffer.destroy();
    const capacityBytes = Math.max(bytes, entry?.capacityBytes ?? 0);
    const buffer = device.createBuffer({
      size: capacityBytes,
      usage: VERTEX_COPY_DST_USAGE,
    });
    buffers.set(role, { buffer, capacityBytes });
    return buffer;
  }

  /** Encodes one frame's clear pass + all draws against `view`. Both the
   *  presented-canvas path and the offscreen capture path run through this so
   *  a captured frame is byte-identical to what the canvas pass encodes. */
  const encodeFrame = (
    frame: RenderFrame,
    view: GPUTextureView,
  ): { encoder: GPUCommandEncoder; stats: RenderStats } => {
    // Callers guard configuration (render checks context, captureFrame
    // checks quadBuffer); configure() always establishes both together.
    const quad = quadBuffer!;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: CLEAR_COLOR,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    // Grow each role buffer once per frame, before any writes, to the
    // frame's total role size — never shrinks across frames.
    const roleTotals = new Map<BufferRole, number>();
    const totalize = (batches: readonly SolidBatch[]): void => {
      for (const batch of batches) {
        if (batch.vertices.length === 0) continue;
        roleTotals.set(
          batch.role,
          (roleTotals.get(batch.role) ?? 0) + batch.vertices.length,
        );
      }
    };
    totalize(frame.solids);
    totalize(frame.overSprites ?? []);
    totalize(frame.overMarkers ?? []);
    totalize(frame.overVehicles ?? []);
    for (const [role, floats] of roleTotals) {
      acquireBuffer(role, floats);
    }

    let solidBatches = 0;
    let solidVertices = 0;
    const roleOffsets = new Map<BufferRole, number>();
    const drawSolids = (batches: readonly SolidBatch[]): void => {
      pass.setPipeline(solidPipeline);
      for (const batch of batches) {
        if (batch.vertices.length === 0) {
          continue;
        }
        // Ordered ranges of one role share its buffer at byte offsets
        // (float counts are always 4-byte aligned).
        const start = roleOffsets.get(batch.role) ?? 0;
        const buffer = buffers.get(batch.role)!.buffer;
        device.queue.writeBuffer(
          buffer,
          start * 4,
          batch.vertices,
          0,
          batch.vertices.length,
        );
        pass.setVertexBuffer(0, buffer, start * 4);
        pass.draw(batch.vertices.length / SOLID_VERTEX_FLOATS);
        roleOffsets.set(batch.role, start + batch.vertices.length);
        solidBatches += 1;
        solidVertices += batch.vertices.length;
      }
    };

    const structural = frame.sprites?.instances;
    const markers = frame.markerSprites?.instances;
    const structuralFloats = structural?.length ?? 0;
    const markerFloats = markers?.length ?? 0;
    const spriteFloats = structuralFloats + markerFloats;
    const structuralCount = structuralFloats / SPRITE_INSTANCE_FLOATS;
    const markerCount = markerFloats / SPRITE_INSTANCE_FLOATS;
    const spriteInstances = structuralCount + markerCount;
    let spriteDraws = 0;
    let spriteBuffer: GPUBuffer | null = null;
    if (spriteFloats > 0) {
      if (spriteBindGroup === null) {
        throw new Error(
          "sprite batch requires a sprite texture (createWebGpuRenderer third argument)",
        );
      }
      spriteBuffer = acquireBuffer("sprite", spriteFloats);
      if (structural !== undefined && structuralFloats > 0) {
        device.queue.writeBuffer(
          spriteBuffer,
          0,
          structural,
          0,
          structural.length,
        );
      }
      if (markers !== undefined && markerFloats > 0) {
        device.queue.writeBuffer(
          spriteBuffer,
          structuralFloats * 4,
          markers,
          0,
          markers.length,
        );
      }
    }
    const drawSprites = (count: number, firstInstance: number): void => {
      if (count === 0) return;
      pass.setPipeline(spritePipeline);
      pass.setBindGroup(0, spriteBindGroup!);
      pass.setVertexBuffer(0, quad, 0);
      pass.setVertexBuffer(1, spriteBuffer!, 0);
      pass.draw(6, count, 0, firstInstance);
      spriteDraws += 1;
    };

    drawSolids(frame.solids);
    drawSprites(structuralCount, 0);
    drawSolids(frame.overSprites ?? []);
    drawSprites(markerCount, structuralCount);
    drawSolids(frame.overMarkers ?? []);

    let vehicleInstances = 0;
    let vehicleDraws = 0;
    const instanceFloats = frame.vehicles.reduce(
      (sum, batch) => sum + batch.instances.length,
      0,
    );
    if (instanceFloats > 0) {
      const combined = new Float32Array(instanceFloats);
      let offset = 0;
      for (const batch of frame.vehicles) {
        combined.set(batch.instances, offset);
        offset += batch.instances.length;
      }
      const buffer = acquireBuffer("vehicle", instanceFloats);
      device.queue.writeBuffer(buffer, 0, combined, 0, combined.length);
      vehicleInstances = instanceFloats / VEHICLE_INSTANCE_FLOATS;
      pass.setPipeline(vehiclePipeline);
      pass.setVertexBuffer(0, quad, 0);
      pass.setVertexBuffer(1, buffer, 0);
      pass.draw(6, vehicleInstances);
      vehicleDraws += 1;
    }

    drawSolids(frame.overVehicles ?? []);

    pass.end();
    return {
      encoder,
      stats: {
        solidBatches,
        solidVertices,
        spriteInstances,
        spriteDraws,
        vehicleInstances,
        vehicleDraws,
      },
    };
  };

  return {
    kind: "webgpu",
    lost,
    configure(canvas: HTMLCanvasElement): void {
      const canvasContext = canvas.getContext("webgpu");
      if (!canvasContext) {
        throw new Error("canvas does not provide a webgpu context");
      }
      canvasContext.configure({ device, format, alphaMode: "opaque" });
      context = canvasContext;
      ensureQuadBuffer();
    },
    unconfigure(): void {
      context?.unconfigure();
      context = null;
    },
    resize(nextWidth: number, nextHeight: number): void {
      pixelWidth = nextWidth;
      pixelHeight = nextHeight;
    },
    render(frame: RenderFrame): RenderStats {
      if (!context) {
        throw new Error("WebGPU renderer is not configured");
      }
      const { encoder, stats } = encodeFrame(
        frame,
        context.getCurrentTexture().createView(),
      );
      device.queue.submit([encoder.finish()]);
      return stats;
    },
    async captureFrame(frame: RenderFrame): Promise<CapturedFrame | null> {
      if (
        context === null ||
        quadBuffer === null ||
        pixelWidth === 0 ||
        pixelHeight === 0
      ) {
        return null;
      }
      const width = pixelWidth;
      const height = pixelHeight;
      const target = device.createTexture({
        size: { width, height },
        format,
        usage: CAPTURE_TEXTURE_USAGE,
      });
      const { encoder } = encodeFrame(frame, target.createView());
      const bytesPerRow =
        Math.ceil((width * 4) / COPY_BYTES_PER_ROW_ALIGNMENT) *
        COPY_BYTES_PER_ROW_ALIGNMENT;
      const readback = device.createBuffer({
        size: bytesPerRow * height,
        usage: READBACK_BUFFER_USAGE,
      });
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readback, bytesPerRow },
        { width, height },
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(MAP_READ_MODE);
      const mapped = new Uint8Array(readback.getMappedRange());
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        pixels.set(
          mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4),
          row * width * 4,
        );
      }
      readback.unmap();
      readback.destroy();
      target.destroy();
      // bgra8unorm is the preferred canvas format on most platforms; the
      // readback arrives BGRA-ordered, so normalize to RGBA8 (ImageData
      // layout) for callers.
      if (format.startsWith("bgra")) {
        for (let i = 0; i < pixels.length; i += 4) {
          const red = pixels[i];
          pixels[i] = pixels[i + 2];
          pixels[i + 2] = red;
        }
      }
      return { width, height, pixels };
    },
    destroy(): void {
      for (const entry of buffers.values()) {
        entry.buffer.destroy();
      }
      buffers.clear();
      quadBuffer?.destroy();
      quadBuffer = null;
      spriteAtlas?.destroy();
      spriteAtlas = null;
      spriteBindGroup = null;
      context?.unconfigure();
      context = null;
    },
  };
}
