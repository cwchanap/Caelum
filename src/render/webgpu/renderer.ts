import { SOLID_VERTEX_FLOATS } from "./primitives";

export interface WebGpuDeviceLoss {
  reason?: string;
  message: string;
}

/** GPU buffer identity by painter role, not per-batch key: the spec pins
 *  exactly four grow-only buffers — structural, route-style, one dynamic
 *  shared by the ordered dynamic ranges, and the vehicle instance buffer.
 *  Geometry rebuild decisions stay on the host's string cache keys. */
export type WebGpuBatchRole = "structural" | "route" | "dynamic";
type BufferRole = WebGpuBatchRole | "vehicle";

/** Solid (non-instanced) triangle batch: interleaved x,y,r,g,b,a vertices. */
export interface WebGpuSolidBatch {
  role: WebGpuBatchRole;
  vertices: Float32Array<ArrayBuffer>;
}

/** Instanced vehicle batch. Instance layout: clip origin (x, y), world angle,
 *  world half-extents (length, width), world→clip factors, RGBA color. */
export interface WebGpuVehicleBatch {
  instances: Float32Array<ArrayBuffer>;
}

export interface WebGpuRenderFrame {
  /** Solid batches drawn before vehicles, in painter order. */
  solids: readonly WebGpuSolidBatch[];
  /** Instanced vehicle batches, concatenated into one upload in frame order. */
  vehicles: readonly WebGpuVehicleBatch[];
  /** Solid batches drawn after vehicles (route handles), in painter order. */
  overVehicles?: readonly WebGpuSolidBatch[];
}

export interface WebGpuRenderStats {
  solidBatches: number;
  solidVertices: number;
  vehicleInstances: number;
}

/** A rendered frame read back to CPU memory: row-tight RGBA8 in device
 *  pixels, top-left origin — the same layout ImageData exposes. */
export interface WebGpuCapturedFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface WebGpuRenderer {
  readonly lost: Promise<WebGpuDeviceLoss>;
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  /** Renders `frame` into an offscreen target at the resize() pixel size and
   *  reads it back via copyTextureToBuffer + mapAsync. Unlike canvas-side
   *  readbacks (toDataURL, drawImage, screenshots), this does not depend on
   *  canvas presentation reaching the compositor, which headless/software-
   *  Vulkan Chromium never completes. Returns null while unconfigured. */
  captureFrame(frame: WebGpuRenderFrame): Promise<WebGpuCapturedFrame | null>;
  destroy(): void;
}

/** Interleaved vehicle instance layout (see WebGpuVehicleBatch). */
export const VEHICLE_INSTANCE_FLOATS = 11;

const CLEAR_COLOR: GPUColor = { r: 0.8431, g: 0.8863, b: 0.8745, a: 1 };

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
};

@vertex
fn vsMain(
  @location(0) corner: vec2f,
  @location(1) origin: vec2f,
  @location(2) angle: f32,
  @location(3) extents: vec2f,
  @location(4) clipScale: vec2f,
  @location(5) color: vec4f,
) -> VertexOutput {
  // Rotate the body in y-down world space, then project with separate clip
  // factors (clipScale.y is negative for the y-flip). Rotating in clip space
  // would shear the quad on anisotropic viewports, and device-px extents fed
  // as clip units would draw it fullscreen.
  let cos = cos(angle);
  let sin = sin(angle);
  // Canvas-era parity: the old 2D renderer drew fillRect(-7, -14, 14, 8).
  // The body spans
  // double the half-extents and its center sits one width + 2px perpendicular
  // off the path centerline (local y = -(2*hw + 2) = -10 for hw = 4).
  let local = vec2f(
    corner.x * (extents.x * 2.0),
    corner.y * (extents.y * 2.0) - (extents.y * 2.0 + 2.0),
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
  return output;
}

@fragment
fn fsMain(output: VertexOutput) -> @location(0) vec4f {
  return output.color;
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

interface BufferEntry {
  buffer: GPUBuffer;
  capacityBytes: number;
}

export function createWebGpuRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
): WebGpuRenderer {
  const lost: Promise<WebGpuDeviceLoss> = device.lost.then((info) => ({
    reason: info.reason,
    message: info.message,
  }));

  const solidModule = device.createShaderModule({ code: SOLID_SHADER });
  const vehicleModule = device.createShaderModule({ code: VEHICLE_SHADER });

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
            { shaderLocation: 4, offset: 20, format: "float32x2" },
            { shaderLocation: 5, offset: 28, format: "float32x4" },
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

  // Unit quad (two triangles) covering [-0.5, 0.5]^2; vehicles transform it per instance.
  // Recreated on configure() so a host remount reuses the renderer after a
  // teardown destroy (role buffers re-acquire lazily in acquireBuffer).
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
    frame: WebGpuRenderFrame,
    view: GPUTextureView,
  ): { encoder: GPUCommandEncoder; stats: WebGpuRenderStats } => {
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
    const totalize = (batches: readonly WebGpuSolidBatch[]): void => {
      for (const batch of batches) {
        if (batch.vertices.length === 0) continue;
        roleTotals.set(
          batch.role,
          (roleTotals.get(batch.role) ?? 0) + batch.vertices.length,
        );
      }
    };
    totalize(frame.solids);
    totalize(frame.overVehicles ?? []);
    for (const [role, floats] of roleTotals) {
      acquireBuffer(role, floats);
    }

    let solidBatches = 0;
    let solidVertices = 0;
    const roleOffsets = new Map<BufferRole, number>();
    const drawSolids = (batches: readonly WebGpuSolidBatch[]): void => {
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

    drawSolids(frame.solids);

    let vehicleInstances = 0;
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
    }

    drawSolids(frame.overVehicles ?? []);

    pass.end();
    return {
      encoder,
      stats: { solidBatches, solidVertices, vehicleInstances },
    };
  };

  return {
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
    resize(nextWidth: number, nextHeight: number): void {
      pixelWidth = nextWidth;
      pixelHeight = nextHeight;
    },
    render(frame: WebGpuRenderFrame): WebGpuRenderStats {
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
    async captureFrame(
      frame: WebGpuRenderFrame,
    ): Promise<WebGpuCapturedFrame | null> {
      if (quadBuffer === null || pixelWidth === 0 || pixelHeight === 0) {
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
      context?.unconfigure();
      context = null;
    },
  };
}
