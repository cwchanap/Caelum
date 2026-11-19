import { colors } from "../colors";
import {
  SPRITE_INSTANCE_FLOATS,
  VEHICLE_INSTANCE_FLOATS,
  VEHICLE_LANE_OFFSET_PX,
  VEHICLE_RIM_PX,
  type CapturedFrame,
  type GameplayRenderer,
  type RenderFrame,
  type RenderStats,
  type SolidBatch,
} from "../gameplayRenderer";
import { parseColor } from "../webgpu/primitives";

function rgbString(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(
    b * 255,
  )})`;
}

const [EMPTY_R, EMPTY_G, EMPTY_B] = parseColor(colors.empty);
const CLEAR_COLOR = rgbString(EMPTY_R, EMPTY_G, EMPTY_B);
const VEHICLE_RIM_COLOR = rgbString(1, 1, 1);

/**
 * Limited Canvas2D fallback gameplay renderer (HPA-1144): paints the same
 * already-projected `RenderFrame` as the WebGPU renderer, in the same
 * painter order `solids → sprites → overSprites → vehicles →
 * overVehicles`. Constructed with the validated sprite images from
 * `loadSpriteImages()`; every sprite row's layer must index `images`.
 *
 * The host hands over clip-space data (solid vertices in NDC with a y-flip,
 * instance origins projected with trailing world→clip factors), so every
 * stage maps clip → device pixels as `x = (clipX + 1) * width / 2`,
 * `y = (1 - clipY) * height / 2`; the trailing clip factors become the
 * per-instance device-px-per-world-px scale (the y factor flips sign back).
 *
 * Solid triangles fill as runs of consecutive same-RGBA triangles with one
 * normalized winding, so shared edges never double-blend or cancel. Sprites
 * draw the whole validated image
 * (`drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, …)`):
 * deriving the source rect from float32 uvScale would overshoot the image
 * (192.0000057 exceeds 192 pixels). An invalid sprite layer throws instead
 * of silently omitting the object.
 *
 * A backing-store resize resets all Canvas2D context state, so every
 * render restores identity transform, `globalAlpha = 1`,
 * `imageSmoothingEnabled = true` and `imageSmoothingQuality = "high"` at
 * the top of the frame and again after the sprite and vehicle loops, whose
 * per-item transforms and alphas must not leak into later stages.
 */
export function createCanvas2dRenderer(
  images: readonly HTMLImageElement[],
): GameplayRenderer {
  // Cleared by destroy() so the validated Image elements release with the
  // renderer; drawing after destroy() throws on the missing context first.
  let activeImages = images;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;

  /** Fills each stage's solid batches as consecutive same-RGBA triangle
   *  runs (one beginPath/fill per run) with normalized winding. Returns
   *  the run count and consumed vertex floats for RenderStats. */
  const drawSolids = (
    batches: readonly SolidBatch[],
    halfWidth: number,
    halfHeight: number,
  ): { runs: number; floats: number } => {
    const ctx = context!;
    let runs = 0;
    let floats = 0;
    for (const batch of batches) {
      const vertices = batch.vertices;
      if (vertices.length === 0) continue;
      floats += vertices.length;
      let i = 0;
      while (i < vertices.length) {
        const r = vertices[i + 2]!;
        const g = vertices[i + 3]!;
        const b = vertices[i + 4]!;
        const a = vertices[i + 5]!;
        ctx.beginPath();
        while (
          i < vertices.length &&
          vertices[i + 2] === r &&
          vertices[i + 3] === g &&
          vertices[i + 4] === b &&
          vertices[i + 5] === a
        ) {
          const x1 = (vertices[i]! + 1) * halfWidth;
          const y1 = (1 - vertices[i + 1]!) * halfHeight;
          let x2 = (vertices[i + 6]! + 1) * halfWidth;
          let y2 = (1 - vertices[i + 7]!) * halfHeight;
          let x3 = (vertices[i + 12]! + 1) * halfWidth;
          let y3 = (1 - vertices[i + 13]!) * halfHeight;
          // Normalize winding so one path can union same-color triangles
          // without opposite-winding overlap cancelling under nonzero fill.
          const area = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
          if (area < 0) {
            [x2, x3] = [x3, x2];
            [y2, y3] = [y3, y2];
          }
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x3, y3);
          ctx.closePath();
          i += 18;
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = rgbString(r, g, b);
        ctx.fill();
        runs += 1;
      }
    }
    return { runs, floats };
  };

  /** Paints one frame against the configured canvas; both the presented
   *  render() and captureFrame() run through here so a captured frame is
   *  what the canvas shows. Throws while unconfigured. */
  const drawFrame = (frame: RenderFrame): RenderStats => {
    const ctx = context;
    if (ctx === null || canvas === null) {
      throw new Error("Canvas2D renderer is not configured");
    }
    // A backing-store resize resets the entire context state; restore
    // the frame defaults at the top of every render.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const width = canvas.width;
    const height = canvas.height;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    ctx.fillStyle = CLEAR_COLOR;
    ctx.fillRect(0, 0, width, height);

    const solids = drawSolids(frame.solids, halfWidth, halfHeight);

    let spriteInstances = 0;
    let spriteDraws = 0;
    const spriteFloats = frame.sprites?.instances.length ?? 0;
    if (spriteFloats > 0) {
      const instances = frame.sprites!.instances;
      spriteInstances = spriteFloats / SPRITE_INSTANCE_FLOATS;
      for (let i = 0; i < instances.length; i += SPRITE_INSTANCE_FLOATS) {
        const layer = instances[i + 7]!;
        if (
          !Number.isInteger(layer) ||
          layer < 0 ||
          layer >= activeImages.length
        ) {
          throw new Error(
            `invalid sprite layer ${layer} (expected 0..${
              activeImages.length - 1
            })`,
          );
        }
        const image = activeImages[layer]!;
        const cx = (instances[i]! + 1) * halfWidth;
        const cy = (1 - instances[i + 1]!) * halfHeight;
        const ex = instances[i + 8]! * halfWidth;
        const ey = -instances[i + 9]! * halfHeight;
        ctx.setTransform(ex, 0, 0, ey, cx, cy);
        ctx.rotate(instances[i + 2]!);
        // Source rect = the whole validated image; never reverse-project
        // the float32 uvScale (192.0000057 exceeds a 192px image).
        const hx = instances[i + 3]!;
        const hy = instances[i + 4]!;
        ctx.drawImage(
          image,
          0,
          0,
          image.naturalWidth,
          image.naturalHeight,
          -hx,
          -hy,
          hx * 2,
          hy * 2,
        );
      }
      spriteDraws = 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const overSprites = drawSolids(
      frame.overSprites ?? [],
      halfWidth,
      halfHeight,
    );

    let vehicleInstances = 0;
    let vehicleDraws = 0;
    const vehicleFloats = frame.vehicles.reduce(
      (sum, batch) => sum + batch.instances.length,
      0,
    );
    if (vehicleFloats > 0) {
      vehicleInstances = vehicleFloats / VEHICLE_INSTANCE_FLOATS;
      for (const batch of frame.vehicles) {
        const instances = batch.instances;
        for (let i = 0; i < instances.length; i += VEHICLE_INSTANCE_FLOATS) {
          const cx = (instances[i]! + 1) * halfWidth;
          const cy = (1 - instances[i + 1]!) * halfHeight;
          const ex = instances[i + 9]! * halfWidth;
          const ey = -instances[i + 10]! * halfHeight;
          ctx.setTransform(ex, 0, 0, ey, cx, cy);
          ctx.rotate(instances[i + 2]!);
          ctx.translate(0, -VEHICLE_LANE_OFFSET_PX);
          const alpha = instances[i + 8]!;
          const hx = instances[i + 3]!;
          const hy = instances[i + 4]!;
          const rim = VEHICLE_RIM_PX;
          const hasInterior = hx > rim && hy > rim;
          ctx.globalAlpha = alpha;
          // White rim as an even-odd outer-minus-inner ring, disjoint
          // from the body so dimmed vehicles never double-blend.
          ctx.beginPath();
          ctx.rect(-hx, -hy, hx * 2, hy * 2);
          if (hasInterior) {
            ctx.rect(rim - hx, rim - hy, (hx - rim) * 2, (hy - rim) * 2);
          }
          ctx.fillStyle = VEHICLE_RIM_COLOR;
          ctx.fill("evenodd");
          if (hasInterior) {
            ctx.beginPath();
            ctx.rect(rim - hx, rim - hy, (hx - rim) * 2, (hy - rim) * 2);
            ctx.fillStyle = rgbString(
              instances[i + 5]!,
              instances[i + 6]!,
              instances[i + 7]!,
            );
            ctx.fill();
          }
        }
      }
      vehicleDraws = 1;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const overVehicles = drawSolids(
      frame.overVehicles ?? [],
      halfWidth,
      halfHeight,
    );

    return {
      solidBatches: solids.runs + overSprites.runs + overVehicles.runs,
      solidVertices: solids.floats + overSprites.floats + overVehicles.floats,
      spriteInstances,
      spriteDraws,
      vehicleInstances,
      vehicleDraws,
    };
  };

  return {
    kind: "canvas2d",

    configure(target: HTMLCanvasElement): void {
      const ctx = target.getContext("2d", { alpha: false });
      if (ctx === null) {
        throw new Error("canvas does not provide a 2d context");
      }
      canvas = target;
      context = ctx;
    },

    unconfigure(): void {
      // Canvas2D has no configure/unconfigure protocol; dropping the
      // reference is the whole operation.
      canvas = null;
      context = null;
    },

    resize(): void {
      // The host sizes the backing store directly; the 2D renderer reads
      // canvas.width/height per frame, so nothing to record here.
    },

    render(frame: RenderFrame): RenderStats {
      return drawFrame(frame);
    },

    async captureFrame(frame: RenderFrame): Promise<CapturedFrame | null> {
      if (context === null || canvas === null) {
        return null;
      }
      drawFrame(frame);
      const width = canvas.width;
      const height = canvas.height;
      const data = context.getImageData(0, 0, width, height);
      return { width, height, pixels: data.data };
    },

    destroy(): void {
      canvas = null;
      context = null;
      activeImages = [];
    },
  };
}
