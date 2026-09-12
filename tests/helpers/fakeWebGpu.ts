/** Minimal fake GPUDevice/canvas harness shared by WebGPU renderer tests.
 *  Records buffers, pipelines, queue writes, and draw ops for assertions. */

export interface FakeBuffer {
  size: number;
  destroyed: boolean;
  destroy(): void;
}

export interface FakePipeline {
  descriptor: GPURenderPipelineDescriptor;
}

export type FakePassOp =
  | { kind: "setPipeline"; pipeline: FakePipeline }
  | { kind: "setVertexBuffer"; slot: number; buffer: FakeBuffer }
  | { kind: "draw"; vertexCount: number; instanceCount: number };

export interface FakePass {
  ops: FakePassOp[];
}

export interface FakeWrite {
  buffer: FakeBuffer;
  data: Float32Array;
}

export interface FakeHarness {
  buffers: FakeBuffer[];
  pipelines: FakePipeline[];
  /** WGSL source passed to createShaderModule, in creation order. */
  shaders: string[];
  writes: FakeWrite[];
  passes: FakePass[];
  device: GPUDevice;
  resolveLost(info: { reason?: string; message: string }): void;
}

export function createFakeDevice(): FakeHarness {
  const harness: FakeHarness = {
    buffers: [],
    pipelines: [],
    shaders: [],
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
    createShaderModule(descriptor: { code: string }) {
      harness.shaders.push(descriptor.code);
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

export function createFakeCanvas(): {
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
