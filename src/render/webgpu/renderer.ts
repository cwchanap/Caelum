import { SOLID_VERTEX_FLOATS } from "./primitives";

export interface WebGpuDeviceLoss {
  reason?: string;
  message: string;
}

/** Solid (non-instanced) triangle batch: interleaved x,y,r,g,b,a vertices. */
export interface WebGpuSolidBatch {
  /** Scene cache key; each key owns one grow-only vertex buffer. */
  key: string;
  vertices: Float32Array<ArrayBuffer>;
}

/** Instanced vehicle batch. Instance layout: clip origin (x, y), world angle,
 *  world half-extents (length, width), world→clip factors, RGBA color. */
export interface WebGpuVehicleBatch {
  /** Route cache key; batches are concatenated into one instance upload in frame order. */
  key: string;
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

export interface WebGpuRenderer {
  readonly lost: Promise<WebGpuDeviceLoss>;
  configure(canvas: HTMLCanvasElement): void;
  resize(width: number, height: number): void;
  render(frame: WebGpuRenderFrame): WebGpuRenderStats;
  destroy(): void;
}

/** Interleaved vehicle instance layout (see WebGpuVehicleBatch). */
export const VEHICLE_INSTANCE_FLOATS = 11;

const CLEAR_COLOR: GPUColor = { r: 0.8431, g: 0.8863, b: 0.8745, a: 1 };

// GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST. @webgpu/types is ambient
// types only, so the numeric flags are used directly (no runtime globals in
// node/jsdom tests).
const VERTEX_COPY_DST_USAGE = 0x20 | 0x08;

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
  let local = vec2f(
    corner.x * extents.x * cos - corner.y * extents.y * sin,
    corner.x * extents.x * sin + corner.y * extents.y * cos,
  );
  var output: VertexOutput;
  output.position = vec4f(
    origin + vec2f(local.x * clipScale.x, local.y * clipScale.y),
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
  const quadCorners = [
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ];
  const quadBuffer = device.createBuffer({
    size: quadCorners.length * 4,
    usage: VERTEX_COPY_DST_USAGE,
  });
  device.queue.writeBuffer(quadBuffer, 0, new Float32Array(quadCorners));

  const buffers = new Map<string, BufferEntry>();
  let context: GPUCanvasContext | null = null;
  // Pixel size of the configured canvas, owned via resize(); consumed by later
  // cutover tasks for viewport scaling of CPU-tessellated geometry.
  let _width = 0;
  let _height = 0;

  function acquireBuffer(key: string, floatCount: number): GPUBuffer {
    const bytes = floatCount * 4;
    const entry = buffers.get(key);
    if (entry && bytes <= entry.capacityBytes) {
      return entry.buffer;
    }
    entry?.buffer.destroy();
    const capacityBytes = Math.max(bytes, entry?.capacityBytes ?? 0);
    const buffer = device.createBuffer({
      size: capacityBytes,
      usage: VERTEX_COPY_DST_USAGE,
    });
    buffers.set(key, { buffer, capacityBytes });
    return buffer;
  }

  return {
    lost,
    configure(canvas: HTMLCanvasElement): void {
      const canvasContext = canvas.getContext("webgpu");
      if (!canvasContext) {
        throw new Error("canvas does not provide a webgpu context");
      }
      canvasContext.configure({ device, format, alphaMode: "opaque" });
      context = canvasContext;
    },
    resize(nextWidth: number, nextHeight: number): void {
      _width = nextWidth;
      _height = nextHeight;
    },
    render(frame: WebGpuRenderFrame): WebGpuRenderStats {
      if (!context) {
        throw new Error("WebGPU renderer is not configured");
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: CLEAR_COLOR,
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });

      let solidBatches = 0;
      let solidVertices = 0;
      const drawSolids = (batches: readonly WebGpuSolidBatch[]): void => {
        pass.setPipeline(solidPipeline);
        for (const batch of batches) {
          if (batch.vertices.length === 0) {
            continue;
          }
          const buffer = acquireBuffer(batch.key, batch.vertices.length);
          device.queue.writeBuffer(
            buffer,
            0,
            batch.vertices,
            0,
            batch.vertices.length,
          );
          pass.setVertexBuffer(0, buffer);
          pass.draw(batch.vertices.length / SOLID_VERTEX_FLOATS);
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
        const buffer = acquireBuffer("vehicles", instanceFloats);
        device.queue.writeBuffer(buffer, 0, combined, 0, combined.length);
        vehicleInstances = instanceFloats / VEHICLE_INSTANCE_FLOATS;
        pass.setPipeline(vehiclePipeline);
        pass.setVertexBuffer(0, quadBuffer);
        pass.setVertexBuffer(1, buffer);
        pass.draw(6, vehicleInstances);
      }

      drawSolids(frame.overVehicles ?? []);

      pass.end();
      device.queue.submit([encoder.finish()]);
      return { solidBatches, solidVertices, vehicleInstances };
    },
    destroy(): void {
      for (const entry of buffers.values()) {
        entry.buffer.destroy();
      }
      buffers.clear();
      quadBuffer.destroy();
      context?.unconfigure();
      context = null;
    },
  };
}
