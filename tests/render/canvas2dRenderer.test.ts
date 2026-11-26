import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import { createCanvas2dRenderer } from "../../src/render/canvas2d/renderer";
import {
  SPRITE_INSTANCE_FLOATS,
  VEHICLE_INSTANCE_FLOATS,
  type BatchRole,
  type RenderFrame,
  type SolidBatch,
  type SpriteBatch,
  type VehicleBatch,
} from "../../src/render/gameplayRenderer";
import {
  SolidGeometry,
  shapeTriangleCountsOf,
} from "../../src/render/webgpu/primitives";
import {
  BUILDING_SPRITE_LAYERS,
  BUILDING_SPRITE_URLS,
  SPRITE_LAYER_COUNT,
  SPRITE_TEXELS_PER_TILE,
  TREE_SPRITE_URLS,
  TRANSIT_SPRITE_URLS,
  TRANSIT_SPRITE_LAYERS,
  type SpriteBuildingType,
} from "../../src/render/webgpu/spriteAtlas";

/* -- Recording 2D context ------------------------------------------------ */

/** Canvas DOMMatrix layout [a, b, c, d, e, f]; a point maps to
 *  (a·x + c·y + e, b·x + d·y + f). */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Canvas transform composition: `n` is applied to points first. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

interface PathPoint {
  x: number;
  y: number;
}

interface DrawState {
  ctm: Matrix;
  globalAlpha: number;
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
}

type RecordedOp =
  | {
      op: "fill";
      rule: string | undefined;
      subpaths: PathPoint[][];
      state: DrawState;
    }
  | {
      op: "fillRect";
      x: number;
      y: number;
      width: number;
      height: number;
      state: DrawState;
    }
  | {
      op: "drawImage";
      image: HTMLImageElement;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
      state: DrawState;
    }
  | {
      op: "getImageData";
      x: number;
      y: number;
      width: number;
      height: number;
      data: Uint8ClampedArray;
    };

/** Tracks the composed transform and full drawing state at every fill/draw,
 *  so tests assert derived geometry (rotated corners, stage resets) rather
 *  than raw call sequences. */
class Recording2dContext {
  ops: RecordedOp[] = [];
  private matrix: Matrix = [...IDENTITY] as Matrix;
  private subpaths: PathPoint[][] = [];
  private current: PathPoint[] | null = null;
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle = "#000";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";

  constructor(readonly canvas: HTMLCanvasElement) {}

  private state(): DrawState {
    return {
      ctm: [...this.matrix] as Matrix,
      globalAlpha: this.globalAlpha,
      fillStyle: this.fillStyle,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality,
    };
  }

  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.matrix = [a, b, c, d, e, f];
  }

  rotate(angle: number): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this.matrix = multiply(this.matrix, [cos, sin, -sin, cos, 0, 0]);
  }

  translate(x: number, y: number): void {
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, x, y]);
  }

  scale(x: number, y: number): void {
    this.matrix = multiply(this.matrix, [x, 0, 0, y, 0, 0]);
  }

  beginPath(): void {
    this.subpaths = [];
    this.current = null;
  }

  moveTo(x: number, y: number): void {
    this.current = [{ x, y }];
    this.subpaths.push(this.current);
  }

  lineTo(x: number, y: number): void {
    if (this.current === null) {
      this.moveTo(x, y);
      return;
    }
    this.current.push({ x, y });
  }

  closePath(): void {}

  rect(x: number, y: number, w: number, h: number): void {
    this.subpaths.push([
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ]);
    this.current = null;
  }

  fill(rule?: string): void {
    this.ops.push({
      op: "fill",
      rule,
      subpaths: this.subpaths.map((subpath) => [...subpath]),
      state: this.state(),
    });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.ops.push({ op: "fillRect", x, y, width, height, state: this.state() });
  }

  drawImage(
    image: HTMLImageElement,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    this.ops.push({
      op: "drawImage",
      image,
      sx,
      sy,
      sw,
      sh,
      dx,
      dy,
      dw,
      dh,
      state: this.state(),
    });
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    this.ops.push({ op: "getImageData", x, y, width, height, data });
    return { width, height, data } as ImageData;
  }
}

const contexts: Recording2dContext[] = [];

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, type: string) {
      if (type !== "2d") return null;
      const context = new Recording2dContext(this);
      contexts.push(context);
      return context as unknown as CanvasRenderingContext2D;
    } as never,
  );
});

afterEach(() => {
  contexts.length = 0;
  vi.restoreAllMocks();
});

/* -- Fixtures ------------------------------------------------------------ */

type RGBATuple = readonly [number, number, number, number];

const RED: RGBATuple = [1, 0, 0, 1];
const BLUE: RGBATuple = [0, 0, 1, 1];

function fakeImage(width: number, height: number): HTMLImageElement {
  return { naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

/** Layer-ordered images with the shipped sprites' dimensions: 192² trees,
 *  then one catalog-footprint image per sprite-bearing building. */
function makeImages(): HTMLImageElement[] {
  return [
    ...TREE_SPRITE_URLS.map(() =>
      fakeImage(SPRITE_TEXELS_PER_TILE, SPRITE_TEXELS_PER_TILE),
    ),
    ...(Object.keys(BUILDING_SPRITE_URLS) as SpriteBuildingType[]).map((type) =>
      fakeImage(
        BUILDING_CATALOG[type].width * SPRITE_TEXELS_PER_TILE,
        BUILDING_CATALOG[type].height * SPRITE_TEXELS_PER_TILE,
      ),
    ),
    ...Object.values(TRANSIT_SPRITE_URLS).map(() => fakeImage(192, 192)),
  ];
}

function solid(
  role: BatchRole,
  color: RGBATuple,
  triangles: readonly (readonly [number, number])[][],
): SolidBatch {
  const floats: number[] = [];
  for (const triangle of triangles) {
    for (const [x, y] of triangle) {
      floats.push(x, y, color[0], color[1], color[2], color[3]);
    }
  }
  return {
    role,
    vertices: new Float32Array(floats) as Float32Array<ArrayBuffer>,
  };
}

/** Sprite instance row with identity tint and projected clip factors. */
function spriteRow(
  origin: readonly [number, number],
  angle: number,
  hx: number,
  hy: number,
  uvScale: readonly [number, number],
  layer: number,
  clipScale: readonly [number, number],
): SpriteBatch {
  const values = [
    origin[0],
    origin[1],
    angle,
    hx,
    hy,
    uvScale[0],
    uvScale[1],
    layer,
    1,
    1,
    1,
    1,
    clipScale[0],
    clipScale[1],
  ];
  if (values.length !== SPRITE_INSTANCE_FLOATS) throw new Error("bad row");
  return {
    instances: new Float32Array(values) as Float32Array<ArrayBuffer>,
  };
}

/** Vehicle instance row: origin, angle, half-extents, RGBA, and trailing
 *  world→clip factors — the host's projected 11-float layout. */
function vehicleRow(
  origin: readonly [number, number],
  angle: number,
  hx: number,
  hy: number,
  color: RGBATuple,
  clipScale: readonly [number, number],
): VehicleBatch {
  const values = [
    origin[0],
    origin[1],
    angle,
    hx,
    hy,
    color[0],
    color[1],
    color[2],
    color[3],
    clipScale[0],
    clipScale[1],
  ];
  if (values.length !== VEHICLE_INSTANCE_FLOATS) throw new Error("bad row");
  return {
    instances: new Float32Array(values) as Float32Array<ArrayBuffer>,
  };
}

const EMPTY_FRAME: RenderFrame = {
  solids: [],
  vehicles: [],
};

/** Signed area of a recorded subpath; negative means the vertices run
 *  counter-clockwise in y-down device space. */
function signedArea(points: PathPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function applyCtm(m: Matrix, p: PathPoint): PathPoint {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

function fills(context: Recording2dContext[]) {
  return context
    .flatMap((c) => c.ops)
    .filter(
      (op): op is Extract<RecordedOp, { op: "fill" }> => op.op === "fill",
    );
}

/* -- 200x100 canvas mapping: clip (x, y) -> device ((x+1)*100, (1-y)*50);
       clip factors (0.5, -0.5) -> 50/25 device px per world px. ---------- */

describe("createCanvas2dRenderer", () => {
  it("exposes the canvas2d kind and no WebGPU loss signal", () => {
    const renderer = createCanvas2dRenderer(makeImages());
    expect(renderer.kind).toBe("canvas2d");
    expect(renderer.lost).toBeUndefined();
  });

  it("clears opaquely and fills same-color winding-normalized solid runs in painter order", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);

    const stats = renderer.render({
      solids: [
        // Triangle 1 arrives clockwise-flipped (negative area); triangle 2
        // is already positive — the run must normalize both to one winding.
        solid("structural", RED, [
          [
            [-1, -1],
            [1, -1],
            [-1, 1],
          ],
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
        solid("dynamic", BLUE, [
          [
            [-1, -1],
            [1, -1],
            [1, 1],
          ],
        ]),
      ],
      overSprites: [
        solid("dynamic", BLUE, [
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
      ],
      vehicles: [],
    });

    const context = contexts[0]!;
    expect(context.ops[0]).toMatchObject({
      op: "fillRect",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    const clear = context.ops[0] as Extract<RecordedOp, { op: "fillRect" }>;
    expect(clear.state.fillStyle).toBe("rgb(195,217,154)");
    expect(clear.state.globalAlpha).toBe(1);
    expect(clear.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(clear.state.imageSmoothingEnabled).toBe(true);
    expect(clear.state.imageSmoothingQuality).toBe("high");

    const solidFills = fills([context]);
    // One fill per same-color run: red (2 triangles), blue (solids), blue
    // (overSprites) — not one fill per triangle or per batch.
    expect(solidFills).toHaveLength(3);
    expect(solidFills[0]!.state.fillStyle).toBe("rgb(255,0,0)");
    expect(solidFills[0]!.state.globalAlpha).toBe(1);
    expect(solidFills[1]!.state.fillStyle).toBe("rgb(0,0,255)");
    expect(solidFills[2]!.state.fillStyle).toBe("rgb(0,0,255)");

    // Every run normalizes to a positive y-down winding regardless of input
    // order; the first run carries both triangles as separate subpaths.
    const [redRun, blueRun, overSpritesRun] = solidFills;
    expect(redRun!.subpaths).toEqual([
      [
        { x: 0, y: 100 },
        { x: 0, y: 0 },
        { x: 200, y: 100 },
      ],
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
      ],
    ]);
    expect(blueRun!.subpaths).toEqual([
      [
        { x: 0, y: 100 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
      ],
    ]);
    expect(overSpritesRun!.subpaths).toEqual([
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 100 },
      ],
    ]);
    for (const run of solidFills) {
      for (const subpath of run.subpaths) {
        expect(signedArea(subpath)).toBeGreaterThan(0);
      }
      // Solid stages always draw from the identity transform.
      expect(run.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    }

    expect(stats).toEqual({
      solidBatches: 3,
      // Four triangles across three runs (2 red + 1 blue + 1 blue).
      solidVertices: 4 * 3 * 6,
      spriteInstances: 0,
      spriteDraws: 0,
      vehicleInstances: 0,
      vehicleDraws: 0,
    });
  });

  it("draws rotated non-square sprites from the validated image and resets before overSprites", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const images = makeImages();
    const renderer = createCanvas2dRenderer(images);
    renderer.configure(canvas);

    const largeHouseLayer = BUILDING_SPRITE_LAYERS.largeHouse;
    const largeHouse = images[largeHouseLayer]!;
    expect(largeHouse.naturalWidth).toBe(576);
    expect(largeHouse.naturalHeight).toBe(384);
    // Stored through Float32Array like the host's projected frames: a
    // uvScale-derived source rect would come back as 192.0000057220459.
    const treeUvScale = Math.fround(SPRITE_TEXELS_PER_TILE / 576);

    const stats = renderer.render({
      solids: [],
      sprites: {
        instances: (() => {
          const a = spriteRow(
            [0, 0],
            Math.PI / 2,
            48,
            24,
            [1, 1],
            largeHouseLayer,
            [0.5, -0.5],
          ).instances;
          const b = spriteRow(
            [0.5, -0.5],
            0,
            12,
            12,
            [treeUvScale, Math.fround(SPRITE_TEXELS_PER_TILE / 384)],
            0,
            [0.5, -0.5],
          ).instances;
          const out = new Float32Array(a.length + b.length);
          out.set(a, 0);
          out.set(b, a.length);
          return out;
        })() as SpriteBatch["instances"],
      },
      overSprites: [
        solid("dynamic", BLUE, [
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
      ],
      vehicles: [],
    });
    const context = contexts[0]!;
    const draws = context.ops.filter(
      (op): op is Extract<RecordedOp, { op: "drawImage" }> =>
        op.op === "drawImage",
    );
    expect(draws).toHaveLength(2);

    // Rotated non-square largeHouse: source rect is the whole validated
    // image (never uvScale * atlas), destination is the full extent.
    const [house, tree] = draws;
    expect(house!.image).toBe(largeHouse);
    expect(house!.sx).toBe(0);
    expect(house!.sy).toBe(0);
    expect(house!.sw).toBe(576);
    expect(house!.sh).toBe(384);
    expect(house!.dx).toBe(-48);
    expect(house!.dy).toBe(-24);
    expect(house!.dw).toBe(96);
    expect(house!.dh).toBe(48);
    expect(house!.state.globalAlpha).toBe(1);
    expect(house!.state.imageSmoothingEnabled).toBe(true);
    expect(house!.state.imageSmoothingQuality).toBe("high");

    // The recorded transform maps the image corners through angle π/2 with
    // 50/25 device px per world px around device center (100, 50). The
    // angle rode through a Float32Array like the host's projected frames,
    // so trig expectations carry ~e-5 float32 fuzz.
    const m = house!.state.ctm;
    expect(m[0]).toBeCloseTo(0, 5);
    expect(m[1]).toBeCloseTo(25, 5);
    expect(m[2]).toBeCloseTo(-50, 5);
    expect(m[3]).toBeCloseTo(0, 5);
    expect(m[4]).toBeCloseTo(100, 5);
    expect(m[5]).toBeCloseTo(50, 5);
    const corner = applyCtm(m, { x: -48, y: -24 });
    expect(corner.x).toBeCloseTo(1300, 3);
    expect(corner.y).toBeCloseTo(-1150, 3);

    // The tree's source rect must equal the 192px image exactly — deriving
    // it from the float32 uvScale overshoots the image (192.0000057…).
    expect(tree!.image).toBe(images[0]);
    expect(tree!.sw).toBe(SPRITE_TEXELS_PER_TILE);
    expect(tree!.sh).toBe(SPRITE_TEXELS_PER_TILE);
    expect(tree!.dx).toBe(-12);
    expect(tree!.dy).toBe(-12);
    expect(tree!.dw).toBe(24);
    expect(tree!.dh).toBe(24);
    expect(tree!.state.ctm).toEqual([50, 0, 0, 25, 150, 75]);

    // The overSprites fill after the sprite loop runs from a reset identity
    // transform and full alpha, in painter order after both draws.
    const solidFills = fills([context]);
    expect(solidFills).toHaveLength(1);
    expect(solidFills[0]!.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(solidFills[0]!.state.globalAlpha).toBe(1);
    expect(context.ops.indexOf(solidFills[0]!)).toBeGreaterThan(
      context.ops.indexOf(tree!),
    );

    // One drawImage per sprite instance; the one overSprites triangle fills
    // as its own run.
    expect(stats).toEqual({
      solidBatches: 1,
      solidVertices: 18,
      spriteInstances: 2,
      spriteDraws: 2,
      vehicleInstances: 0,
      vehicleDraws: 0,
    });
  });

  it("crops a rotated west-half rail in both sprite ranges", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);
    const half = spriteRow(
      [0, 0],
      Math.PI / 2,
      8,
      16,
      [96 / 576, 192 / 384],
      0,
      [0.5, -0.5],
    );
    const stats = renderer.render({
      solids: [],
      sprites: half,
      overSprites: [
        solid("dynamic", BLUE, [
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
      ],
      markerSprites: half,
      overMarkers: [
        solid("dynamic", RED, [
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
      ],
      vehicles: [],
    });
    const context = contexts[0]!;
    // Interleaved painter order across stages, not filtered per-kind: clear,
    // sprite draw, overSprites fill, marker draw, overMarkers fill.
    expect(context.ops.map((op) => op.op)).toEqual([
      "fillRect",
      "drawImage",
      "fill",
      "drawImage",
      "fill",
    ]);
    const draws = context.ops.filter(
      (op): op is Extract<RecordedOp, { op: "drawImage" }> =>
        op.op === "drawImage",
    );
    expect(draws).toHaveLength(2);
    for (const draw of draws) {
      expect([draw.sx, draw.sy, draw.sw, draw.sh]).toEqual([0, 0, 96, 192]);
      expect([draw.dx, draw.dy, draw.dw, draw.dh]).toEqual([-8, -16, 16, 32]);
      expect(draw.state.ctm[1]).toBeCloseTo(25);
    }
    // Each over-stage solid fills from a reset identity transform at full
    // alpha — no sprite transform or tint leaks across stage boundaries.
    const stageFills = fills([context]);
    expect(stageFills).toHaveLength(2);
    expect(stageFills[0]!.state.fillStyle).toBe("rgb(0,0,255)");
    expect(stageFills[1]!.state.fillStyle).toBe("rgb(255,0,0)");
    for (const fill of stageFills) {
      expect(fill.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
      expect(fill.state.globalAlpha).toBe(1);
    }
    expect(stats.spriteInstances).toBe(2);
    expect(stats.solidVertices).toBe(36);
  });

  it("caches white-rim tint by layer and RGB while applying opacity per draw", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);
    const rim = spriteRow(
      [0, 0],
      0,
      7,
      7,
      [192 / 576, 192 / 384],
      TRANSIT_SPRITE_LAYERS.busStopRing,
      [0.5, -0.5],
    );
    rim.instances.set([0.2, 0.4, 0.6, 0.42], 8);
    const frame = { solids: [], markerSprites: rim, vehicles: [] };
    renderer.render(frame);
    renderer.render(frame);
    expect(contexts).toHaveLength(2);
    const tinted = contexts[1]!;
    expect(tinted.globalCompositeOperation).toBe("source-in");
    expect(tinted.ops.filter((op) => op.op === "drawImage")).toHaveLength(1);
    expect(tinted.ops.filter((op) => op.op === "fillRect")).toHaveLength(1);
    const draws = contexts[0]!.ops.filter(
      (op): op is Extract<RecordedOp, { op: "drawImage" }> =>
        op.op === "drawImage",
    );
    expect(draws).toHaveLength(2);
    expect(draws[0]!.image).toBe(tinted.canvas);
    expect(draws[1]!.image).toBe(tinted.canvas);
    expect(draws[0]!.state.globalAlpha).toBeCloseTo(0.42);
    expect([draws[0]!.sw, draws[0]!.sh]).toEqual([192, 192]);
    renderer.destroy();
    renderer.configure(canvas);
    expect(() => renderer.render(frame)).toThrow(/invalid sprite layer/);
  });

  it("draws sprites at full alpha after translucent solids", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);

    // The GPU sprite shader composites at full alpha: a solid stage ending
    // at alpha 0.5 must not dim sprites (alpha 0 would erase them).
    const stats = renderer.render({
      solids: [
        solid(
          "dynamic",
          [0, 1, 0, 0.5],
          [
            [
              [-1, -1],
              [1, -1],
              [1, 1],
            ],
          ],
        ),
      ],
      sprites: spriteRow([0, 0], 0, 12, 12, [1, 1], 0, [0.5, -0.5]),
      vehicles: [],
    });

    const context = contexts[0]!;
    const draws = context.ops.filter(
      (op): op is Extract<RecordedOp, { op: "drawImage" }> =>
        op.op === "drawImage",
    );
    expect(draws).toHaveLength(1);
    expect(draws[0]!.state.globalAlpha).toBe(1);
    expect(draws[0]!.state.ctm).toEqual([50, 0, 0, 25, 100, 50]);
    expect(stats).toEqual({
      solidBatches: 1,
      solidVertices: 18,
      spriteInstances: 1,
      spriteDraws: 1,
      vehicleInstances: 0,
      vehicleDraws: 0,
    });
  });

  it("throws on invalid sprite layers instead of silently omitting objects", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);

    for (const layer of [SPRITE_LAYER_COUNT, -1, 2.5]) {
      const frame: RenderFrame = {
        solids: [],
        sprites: spriteRow([0, 0], 0, 12, 12, [1, 1], layer, [0.5, -0.5]),
        vehicles: [],
      };
      expect(() => renderer.render(frame)).toThrow(/invalid sprite layer/);
    }
  });

  it("draws vehicles as a disjoint even-odd white ring plus same-alpha body and resets before overVehicles", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);

    renderer.render({
      solids: [],
      vehicles: [
        {
          // Dimmed bus: body center rides the sampled route center.
          instances: (() => {
            const a = vehicleRow(
              [0, 0],
              0,
              9,
              5,
              [0.2, 0.4, 0.8, 0.5],
              [0.5, -0.5],
            ).instances;
            const b = vehicleRow(
              [-0.5, 0],
              0,
              1,
              5,
              [1, 0, 0, 1],
              [0.5, -0.5],
            ).instances;
            const c = vehicleRow(
              [0.5, 0.5],
              Math.PI / 2,
              9,
              5,
              [0.2, 0.4, 0.8, 1],
              [0.5, -0.5],
            ).instances;
            const out = new Float32Array(a.length + b.length + c.length);
            out.set(a, 0);
            out.set(b, a.length);
            out.set(c, a.length + b.length);
            return out;
          })() as VehicleBatch["instances"],
        },
      ],
      overVehicles: [
        solid("dynamic", BLUE, [
          [
            [-1, 1],
            [1, 1],
            [1, -1],
          ],
        ]),
      ],
    });

    const context = contexts[0]!;
    const solidFills = fills([context]);
    // Ring + body for the dimmed bus, white-only tiny bus, ring + body for
    // the rotated bus, then the overVehicles run.
    expect(solidFills).toHaveLength(6);

    const [busRing, busBody, tiny, rotatedRing, rotatedBody, after] =
      solidFills;

    // White ring as an even-odd outer-minus-inner rectangle (1.5px rim).
    expect(busRing!.rule).toBe("evenodd");
    expect(busRing!.state.fillStyle).toBe("rgb(255,255,255)");
    expect(busRing!.state.globalAlpha).toBe(0.5);
    expect(busRing!.subpaths).toEqual([
      [
        { x: -9, y: -5 },
        { x: 9, y: -5 },
        { x: 9, y: 5 },
        { x: -9, y: 5 },
      ],
      [
        { x: -7.5, y: -3.5 },
        { x: 7.5, y: -3.5 },
        { x: 7.5, y: 3.5 },
        { x: -7.5, y: 3.5 },
      ],
    ]);

    // Interior body: disjoint from the ring, same per-instance alpha.
    expect(busBody!.rule).toBeUndefined();
    expect(busBody!.state.fillStyle).toBe("rgb(51,102,204)");
    expect(busBody!.state.globalAlpha).toBe(0.5);
    expect(busBody!.subpaths).toEqual([
      [
        { x: -7.5, y: -3.5 },
        { x: 7.5, y: -3.5 },
        { x: 7.5, y: 3.5 },
        { x: -7.5, y: 3.5 },
      ],
    ]);

    // Both half-extents must exceed the rim: half-width 1 <= 1.5 draws only
    // the white outline, with no inner rect and no body fill.
    expect(tiny!.rule).toBe("evenodd");
    expect(tiny!.state.fillStyle).toBe("rgb(255,255,255)");
    expect(tiny!.state.globalAlpha).toBe(1);
    expect(tiny!.subpaths).toEqual([
      [
        { x: -1, y: -5 },
        { x: 1, y: -5 },
        { x: 1, y: 5 },
        { x: -1, y: 5 },
      ],
    ]);
    expect(tiny!.state.ctm).toEqual([50, 0, 0, 25, 50, 50]);

    // No extra lane offset applies in the rotated frame: the rotated bus's
    // transform origin is exactly its sampled center (float32-stored, hence
    // the loose precision).
    const m = rotatedRing!.state.ctm;
    expect(m[4]).toBeCloseTo(150, 4);
    expect(m[5]).toBeCloseTo(25, 4);

    // The rotated bus's interior body keeps its own full alpha.
    expect(rotatedBody!.rule).toBeUndefined();
    expect(rotatedBody!.state.fillStyle).toBe("rgb(51,102,204)");
    expect(rotatedBody!.state.globalAlpha).toBe(1);

    // After the vehicle loop the overVehicles fill resets to identity/full
    // alpha — no per-instance alpha or transform leaks between stages.
    expect(after!.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(after!.state.globalAlpha).toBe(1);
    expect(after!.state.fillStyle).toBe("rgb(0,0,255)");

    const stats = renderer.render(EMPTY_FRAME);
    expect(stats).toEqual({
      solidBatches: 0,
      solidVertices: 0,
      spriteInstances: 0,
      spriteDraws: 0,
      vehicleInstances: 0,
      vehicleDraws: 0,
    });
  });

  it("restores frame defaults on every render and survives resize, remount, capture and destroy", async () => {
    const canvasA = document.createElement("canvas");
    canvasA.width = 200;
    canvasA.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    expect(renderer.kind).toBe("canvas2d");
    renderer.configure(canvasA);

    // Simulate the context damage a backing-store resize leaves behind,
    // and change the canvas size without reconfiguring: the renderer must
    // read the backing-store dims per frame, not cache them at configure().
    const damaged = contexts[0]!;
    damaged.setTransform(2, 0, 0, 3, 5, 7);
    damaged.globalAlpha = 0.5;
    damaged.imageSmoothingEnabled = false;
    damaged.imageSmoothingQuality = "low";
    canvasA.width = 240;
    canvasA.height = 120;

    const stats = renderer.render(EMPTY_FRAME);
    expect(stats).toEqual({
      solidBatches: 0,
      solidVertices: 0,
      spriteInstances: 0,
      spriteDraws: 0,
      vehicleInstances: 0,
      vehicleDraws: 0,
    });
    const clearOps = damaged.ops.filter(
      (op): op is Extract<RecordedOp, { op: "fillRect" }> =>
        op.op === "fillRect",
    );
    expect(clearOps).toHaveLength(1);
    expect(clearOps[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 240,
      height: 120,
    });
    expect(clearOps[0]!.state.ctm).toEqual([1, 0, 0, 1, 0, 0]);
    expect(clearOps[0]!.state.globalAlpha).toBe(1);
    expect(clearOps[0]!.state.imageSmoothingEnabled).toBe(true);
    expect(clearOps[0]!.state.imageSmoothingQuality).toBe("high");

    // Capture renders onto the configured game canvas and reads it back
    // row-tight, in that order — no offscreen canvas.
    const captured = await renderer.captureFrame(EMPTY_FRAME);
    expect(captured).not.toBeNull();
    expect(captured!.width).toBe(240);
    expect(captured!.height).toBe(120);
    const readOps = damaged.ops.filter(
      (op): op is Extract<RecordedOp, { op: "getImageData" }> =>
        op.op === "getImageData",
    );
    expect(readOps).toHaveLength(1);
    expect(readOps[0]).toMatchObject({ x: 0, y: 0, width: 240, height: 120 });
    expect(captured!.pixels).toBe(readOps[0]!.data);
    // Recompute the clears after capture: the capture's own render must
    // paint onto the game canvas before the readback. (Filtering before
    // capture yields one op whose [1] is undefined and vacuously passes.)
    const captureClears = damaged.ops.filter(
      (op): op is Extract<RecordedOp, { op: "fillRect" }> =>
        op.op === "fillRect",
    );
    expect(captureClears).toHaveLength(2);
    expect(damaged.ops.indexOf(captureClears[1]!)).toBeLessThan(
      damaged.ops.indexOf(readOps[0]!),
    );

    // Unconfigure drops the context: captures return null and draws throw.
    renderer.unconfigure();
    await expect(renderer.captureFrame(EMPTY_FRAME)).resolves.toBeNull();
    expect(() => renderer.render(EMPTY_FRAME)).toThrow(/not configured/);

    // Remount onto a fresh canvas (City Library round trip) works.
    const canvasB = document.createElement("canvas");
    canvasB.width = 100;
    canvasB.height = 50;
    renderer.configure(canvasB);
    const recaptured = await renderer.captureFrame(EMPTY_FRAME);
    expect(recaptured).not.toBeNull();
    expect(recaptured!.width).toBe(100);
    expect(recaptured!.height).toBe(50);

    // Destroy is idempotent and ends every draw/capture path.
    renderer.destroy();
    renderer.destroy();
    await expect(renderer.captureFrame(EMPTY_FRAME)).resolves.toBeNull();
    expect(() => renderer.render(EMPTY_FRAME)).toThrow(/not configured/);
  });

  it("rejects configuration when the canvas provides no 2d context", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const renderer = createCanvas2dRenderer(makeImages());
    expect(() => renderer.configure(canvas)).toThrow(/2d context/);
  });

  it("merges within each translucent shape while filling separate translucent shapes independently", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const renderer = createCanvas2dRenderer(makeImages());
    renderer.configure(canvas);

    // Two overlapping translucent coverage squares (2 triangles each) and two
    // consecutive opaque squares (2 triangles each): the translucent shapes
    // each keep their two triangles in one path (no diagonal seam) and fill
    // separately (so overlaps darken), while opaque shapes merge across shapes.
    const translucent = [0.16, 0.4, 0.7, 0.18] as const;
    const geometry = new SolidGeometry()
      .rect(0, 0, 64, 64, translucent)
      .rect(32, 0, 64, 64, translucent)
      .rect(0, 64, 32, 32, RED)
      .rect(32, 64, 32, 32, RED);
    const vertices = geometry.toFloat32Array();
    const shapeTriangleCounts = shapeTriangleCountsOf(vertices);
    expect(shapeTriangleCounts).toEqual(new Uint32Array([2, 2, 2, 2]));

    renderer.render({
      solids: [{ role: "dynamic", vertices, shapeTriangleCounts }],
      vehicles: [],
    });

    const solidFills = fills([contexts[0]!]);
    expect(solidFills).toHaveLength(3);
    expect(solidFills[0]!.subpaths).toHaveLength(2);
    expect(solidFills[0]!.state.globalAlpha).toBeCloseTo(0.18, 6);
    expect(solidFills[1]!.subpaths).toHaveLength(2);
    expect(solidFills[1]!.state.globalAlpha).toBeCloseTo(0.18, 6);
    expect(solidFills[2]!.subpaths).toHaveLength(4);
    expect(solidFills[2]!.state.globalAlpha).toBe(1);
  });
});
