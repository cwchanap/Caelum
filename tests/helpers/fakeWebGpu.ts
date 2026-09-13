/** Minimal fake GPUDevice/canvas harness shared by WebGPU renderer tests.
 *  Records buffers, pipelines, queue writes, and draw ops for assertions. */

export interface FakeBuffer {
  size: number;
  usage: number;
  destroyed: boolean;
  /** Backing store surfaced by getMappedRange(); tests fill it via onMapRead. */
  backing: Uint8Array;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

export interface FakeTexture {
  descriptor: GPUTextureDescriptor;
  destroyed: boolean;
  createView(): object;
  destroy(): void;
}

export interface FakeTextureCopy {
  bytesPerRow: number | undefined;
  buffer: FakeBuffer;
  width: number | undefined;
  height: number | undefined;
}

export interface FakePipeline {
  descriptor: GPURenderPipelineDescriptor;
}

export type FakePassOp =
  | { kind: "setPipeline"; pipeline: FakePipeline }
  | {
      kind: "setVertexBuffer";
      slot: number;
      buffer: FakeBuffer;
      offset: number;
    }
  | { kind: "draw"; vertexCount: number; instanceCount: number };

export interface FakePass {
  ops: FakePassOp[];
}

export interface FakeWrite {
  buffer: FakeBuffer;
  /** Byte offset of the upload within the buffer. */
  offset: number;
  data: Float32Array;
}

export interface FakeHarness {
  buffers: FakeBuffer[];
  pipelines: FakePipeline[];
  /** WGSL source passed to createShaderModule, in creation order. */
  shaders: string[];
  writes: FakeWrite[];
  passes: FakePass[];
  textures: FakeTexture[];
  copies: FakeTextureCopy[];
  /** Invoked inside mapAsync so a test can stage the buffer's mapped bytes
   *  before the renderer reads them. */
  onMapRead?: (buffer: FakeBuffer) => void;
  device: GPUDevice;
  /** True once the host teardown destroyed the device it created. */
  deviceDestroyed: boolean;
  resolveLost(info: { reason?: string; message: string }): void;
}

export function createFakeDevice(): FakeHarness {
  const harness: FakeHarness = {
    buffers: [],
    pipelines: [],
    shaders: [],
    writes: [],
    passes: [],
    textures: [],
    copies: [],
    device: null as unknown as GPUDevice,
    deviceDestroyed: false,
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
      usage: descriptor.usage ?? 0,
      destroyed: false,
      backing: new Uint8Array(descriptor.size),
      destroy() {
        buffer.destroyed = true;
      },
      async mapAsync() {
        harness.onMapRead?.(buffer);
      },
      getMappedRange(): ArrayBuffer {
        return buffer.backing.buffer as ArrayBuffer;
      },
      unmap() {},
    };
    harness.buffers.push(buffer);
    return buffer;
  };
  const device = {
    lost,
    createBuffer: makeBuffer,
    destroy() {
      harness.deviceDestroyed = true;
    },
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
      const pipeline: FakePipeline = { descriptor };
      harness.pipelines.push(pipeline);
      return pipeline;
    },
    createShaderModule(descriptor: { code: string }) {
      harness.shaders.push(descriptor.code);
      return {};
    },
    createTexture(descriptor: GPUTextureDescriptor) {
      const texture: FakeTexture = {
        descriptor,
        destroyed: false,
        createView: () => ({}),
        destroy() {
          texture.destroyed = true;
        },
      };
      harness.textures.push(texture);
      return texture;
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
            setVertexBuffer(slot: number, buffer: FakeBuffer, offset = 0) {
              pass.ops.push({ kind: "setVertexBuffer", slot, buffer, offset });
            },
            draw(vertexCount: number, instanceCount = 1) {
              pass.ops.push({ kind: "draw", vertexCount, instanceCount });
            },
            end() {},
          } as unknown as GPURenderPassEncoder;
        },
        copyTextureToBuffer(
          _source: { texture: FakeTexture },
          destination: { buffer: FakeBuffer; bytesPerRow?: number },
          size: { width?: number; height?: number },
        ) {
          harness.copies.push({
            buffer: destination.buffer,
            bytesPerRow: destination.bytesPerRow,
            width: size.width,
            height: size.height,
          });
        },
        finish() {
          return { passes: encoderPasses };
        },
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: Float32Array) {
        harness.writes.push({ buffer, offset, data });
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
