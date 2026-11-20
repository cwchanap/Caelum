/** Renderer-neutral gameplay rendering contract. The WebGPU renderer and
 *  the limited Canvas2D fallback introduced by HPA-1144 both paint the same
 *  projected `RenderFrame` in the same painter order, so the shared host,
 *  batch builders, and pick consumers never know which concrete renderer is
 *  behind the interface. (The former full Canvas2D gameplay renderer was
 *  deleted by HPA-640; HPA-1144 adds a new, narrow fallback selected once at
 *  startup when WebGPU capability/setup is unavailable.) */

/** Payload of the WebGPU-only `lost` signal. `reason: "destroyed"` is the
 *  deliberate teardown; any other loss is unexpected and stays terminal. */
export interface WebGpuDeviceLoss {
  reason?: string;
  message: string;
}

/** GPU buffer identity by painter role, not per-batch key: the spec pins
 *  exactly five grow-only buffers — structural, route-style, one dynamic
 *  shared by the ordered dynamic ranges, the vehicle instance buffer, and
 *  the sprite instance buffer. Geometry rebuild decisions stay on the
 *  host's string cache keys. */
export type BatchRole = "structural" | "route" | "dynamic";

/** Solid (non-instanced) triangle batch: interleaved x,y,r,g,b,a vertices.
 *  Optional `shapeTriangleCounts` preserves source shape boundaries so the
 *  Canvas2D fallback merges triangles within one shape while compositing
 *  separate translucent shapes independently. */
export interface SolidBatch {
  role: BatchRole;
  vertices: Float32Array<ArrayBuffer>;
  shapeTriangleCounts?: Uint32Array<ArrayBuffer>;
}

/** Instanced vehicle batch. Instance layout: clip origin (x, y), world angle,
 *  world half-extents (length, width), RGBA color, trailing clip factors. */
export interface VehicleBatch {
  instances: Float32Array<ArrayBuffer>;
}

/** Instanced textured sprite batch (trees + buildings). Instance layout per
 *  SPRITE_INSTANCE_FLOATS below: world origin (x, y), angle, world
 *  half-extents (x, y), uv scale (x, y), texture layer, host clip factors. */
export interface SpriteBatch {
  instances: Float32Array<ArrayBuffer>;
}

export interface RenderFrame {
  /** Solid batches drawn before sprites, in painter order. */
  solids: readonly SolidBatch[];
  /** One instanced textured draw after the structural solids. */
  sprites?: SpriteBatch;
  /** Solid batches drawn after sprites (underRoutes, routes, drafts). */
  overSprites?: readonly SolidBatch[];
  /** Instanced vehicle batches, concatenated into one upload in frame order. */
  vehicles: readonly VehicleBatch[];
  /** Solid batches drawn after vehicles (route handles), in painter order. */
  overVehicles?: readonly SolidBatch[];
}

/** Draw-call counts the renderer issued for the frame: WebGPU queue
 *  submissions vs Canvas2D fill/drawImage ops. Sprite/vehicle counts are
 *  per-instance ops under Canvas2D but single instanced draws under WebGPU. */
export interface RenderStats {
  solidBatches: number;
  solidVertices: number;
  spriteInstances: number;
  spriteDraws: number;
  vehicleInstances: number;
  vehicleDraws: number;
}

/** A rendered frame read back to CPU memory: row-tight RGBA8 in device
 *  pixels, top-left origin — the same layout ImageData exposes. */
export interface CapturedFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface GameplayRenderer {
  /** Which concrete renderer drives the frame; tests and the mounted
   *  canvas's `data-renderer` attribute record it. */
  readonly kind: "webgpu" | "canvas2d";
  /** WebGPU-only unexpected-device-loss signal; renderers without a device
   *  loss signal omit it. */
  readonly lost?: Promise<WebGpuDeviceLoss>;
  configure(canvas: HTMLCanvasElement): void;
  unconfigure(): void;
  resize(width: number, height: number): void;
  render(frame: RenderFrame): RenderStats;
  /** Renders `frame` and reads the result back to CPU pixels at the canvas
   *  backing-store size: WebGPU draws into an offscreen target at the
   *  resize() pixel size; Canvas2D draws into the mounted canvas and reads
   *  it back. Returns null while unconfigured. */
  captureFrame(frame: RenderFrame): Promise<CapturedFrame | null>;
  destroy(): void;
}

/** Interleaved vehicle instance layout (see VehicleBatch). */
export const VEHICLE_INSTANCE_FLOATS = 11;

/** Interleaved sprite instance layout (see SpriteBatch, emitted by
 *  mapBatch.ts): world origin (x, y), angle, world half-extents (x, y),
 *  uv scale (x, y), texture layer, two trailing host clip-scale slots. */
export const SPRITE_INSTANCE_FLOATS = 10;

/** Perpendicular world-px offset of a vehicle body center off its path
 *  centerline; every renderer offsets the body identically. */
export const VEHICLE_LANE_OFFSET_PX = 8;

/** White outline width (world px) around each vehicle body. */
export const VEHICLE_RIM_PX = 1.5;
