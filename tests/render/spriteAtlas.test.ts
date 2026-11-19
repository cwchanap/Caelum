import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILDING_SPRITE_LAYERS,
  BUILDING_SPRITE_URLS,
  SPRITE_ATLAS_HEIGHT,
  SPRITE_ATLAS_WIDTH,
  SPRITE_LAYER_COUNT,
  SPRITE_MIP_LEVEL_COUNT,
  SPRITE_TEXELS_PER_TILE,
  TREE_SPRITE_URLS,
  createSpriteAtlasTexture,
  loadSpriteImages,
  type SpriteBuildingType,
} from "../../src/render/webgpu/spriteAtlas";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import { createFakeDevice } from "../helpers/fakeWebGpu";

interface FakeDraw {
  kind: "clearRect" | "drawImage";
  width: number;
  height: number;
}

interface Fake2dContext {
  canvas: HTMLCanvasElement;
  calls: FakeDraw[];
  imageSmoothingQuality: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** Asset URL → decoded native dimensions; a URL with no entry rejects
 *  decode(), mirroring a missing/failed load. */
const imageDimensions = new Map<string, { width: number; height: number }>();
const contexts: Fake2dContext[] = [];

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  private url = "";

  set src(value: string) {
    this.url = value;
  }

  get src(): string {
    return this.url;
  }

  async decode(): Promise<void> {
    const dims = [...imageDimensions.entries()].find(
      ([url]) => url.endsWith(this.url) || this.url.endsWith(url),
    )?.[1];
    if (dims === undefined) {
      // Mirrors a real decode() rejection: the DOMException carries no asset
      // identity, so only the loader can name the failing sprite.
      throw new Error("The source image could not be decoded");
    }
    this.naturalWidth = dims.width;
    this.naturalHeight = dims.height;
  }
}

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, type: string) {
      if (type !== "2d") return null;
      const context: Fake2dContext = {
        canvas: this,
        calls: [],
        imageSmoothingQuality: "low",
        clearRect(x, _y, w, h) {
          context.calls.push({
            kind: "clearRect",
            width: x + w,
            height: _y + h,
          });
        },
        drawImage(_image, _dx, _dy, dw, dh) {
          context.calls.push({ kind: "drawImage", width: dw, height: dh });
        },
      };
      contexts.push(context);
      return context as unknown as CanvasRenderingContext2D;
    } as never,
  );
});

afterEach(() => {
  imageDimensions.clear();
  contexts.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registerShippedDimensions(): void {
  for (const url of TREE_SPRITE_URLS) {
    imageDimensions.set(url, { width: 192, height: 192 });
  }
  for (const [type, url] of Object.entries(BUILDING_SPRITE_URLS) as [
    SpriteBuildingType,
    string,
  ][]) {
    imageDimensions.set(url, {
      width: BUILDING_CATALOG[type].width * SPRITE_TEXELS_PER_TILE,
      height: BUILDING_CATALOG[type].height * SPRITE_TEXELS_PER_TILE,
    });
  }
}

const SPRITE_TEXTURE_USAGE = 0x04 | 0x02 | 0x10;

describe("sprite atlas table", () => {
  it("maps exactly the twelve sprite-bearing buildings and three tree variants", () => {
    expect(Object.keys(BUILDING_SPRITE_URLS).sort()).toEqual(
      [
        "busTerminal",
        "smallHouse",
        "largeHouse",
        "supermarket",
        "cinema",
        "factory",
        "warehouse",
        "officeTower",
        "businessPark",
        "clinic",
        "school",
        "parkPlaza",
      ].sort(),
    );
    expect(Object.keys(BUILDING_SPRITE_URLS)).not.toContain("busStop");
    expect(Object.keys(BUILDING_SPRITE_URLS)).not.toContain("metroStation");
    expect(TREE_SPRITE_URLS).toHaveLength(3);
    for (const variant of [1, 2, 3]) {
      expect(
        TREE_SPRITE_URLS.some((url) => url.endsWith(`tree-0${variant}.webp`)),
      ).toBe(true);
    }
    for (const [type, url] of Object.entries(BUILDING_SPRITE_URLS)) {
      expect(url.endsWith(`buildings/${type}.webp`)).toBe(true);
    }
  });

  it("lays out fifteen stable layers: trees first, then buildings in catalog order", () => {
    const buildingTypes = Object.keys(BUILDING_CATALOG).filter(
      (type) => type !== "busStop" && type !== "metroStation",
    );
    expect(SPRITE_LAYER_COUNT).toBe(15);
    for (const [index, type] of buildingTypes.entries()) {
      expect(BUILDING_SPRITE_LAYERS[type as SpriteBuildingType]).toBe(
        TREE_SPRITE_URLS.length + index,
      );
    }
  });
});

describe("loadSpriteImages", () => {
  it("decodes all fifteen sprites in stable layer order with validated dimensions", async () => {
    registerShippedDimensions();

    const images = await loadSpriteImages();

    expect(images).toHaveLength(SPRITE_LAYER_COUNT);
    for (const [index, url] of TREE_SPRITE_URLS.entries()) {
      expect(images[index]!.src).toBe(url);
      expect(images[index]!.naturalWidth).toBe(SPRITE_TEXELS_PER_TILE);
      expect(images[index]!.naturalHeight).toBe(SPRITE_TEXELS_PER_TILE);
    }
    for (const [type, layer] of Object.entries(BUILDING_SPRITE_LAYERS) as [
      SpriteBuildingType,
      number,
    ][]) {
      expect(images[layer]!.src).toBe(BUILDING_SPRITE_URLS[type]);
      expect(images[layer]!.naturalWidth).toBe(
        BUILDING_CATALOG[type].width * SPRITE_TEXELS_PER_TILE,
      );
      expect(images[layer]!.naturalHeight).toBe(
        BUILDING_CATALOG[type].height * SPRITE_TEXELS_PER_TILE,
      );
    }
  });

  it("fails clearly when a sprite decodes with unexpected dimensions", async () => {
    registerShippedDimensions();
    imageDimensions.set(BUILDING_SPRITE_URLS.smallHouse, {
      width: 128,
      height: 64,
    });

    await expect(loadSpriteImages()).rejects.toThrow(
      /smallHouse.*expected 384x192.*got 128x64/s,
    );
    // Decode validation precedes any upload: no canvas is ever created.
    expect(contexts).toHaveLength(0);
  });

  it("fails clearly when an image fails to decode, naming the sprite", async () => {
    registerShippedDimensions();
    imageDimensions.delete(TREE_SPRITE_URLS[0]!);

    await expect(loadSpriteImages()).rejects.toThrow(
      /sprite "tree-01" failed to decode.*could not be decoded/s,
    );
  });
});

describe("createSpriteAtlasTexture", () => {
  it("uploads one rgba8unorm 576x384x15 five-mip 2d-array texture", async () => {
    registerShippedDimensions();
    const { device, textures, textureUploads } = createFakeDevice();

    const texture = createSpriteAtlasTexture(device, await loadSpriteImages());

    expect(texture).toBe(textures[0]);
    expect(textures).toHaveLength(1);
    expect(textures[0]!.descriptor).toEqual({
      size: [SPRITE_ATLAS_WIDTH, SPRITE_ATLAS_HEIGHT, SPRITE_LAYER_COUNT],
      format: "rgba8unorm",
      dimension: "2d",
      textureBindingViewDimension: "2d-array",
      mipLevelCount: SPRITE_MIP_LEVEL_COUNT,
      usage: SPRITE_TEXTURE_USAGE,
    });
    // Fifteen layers, five mips each: one source-sized upload per mip.
    expect(textureUploads).toHaveLength(
      SPRITE_LAYER_COUNT * SPRITE_MIP_LEVEL_COUNT,
    );
    for (const upload of textureUploads) {
      expect(upload.premultipliedAlpha).toBe(true);
      expect(upload.colorSpace).toBe("srgb");
    }
  });

  it("uploads only the source-sized mip crop into each layer", async () => {
    registerShippedDimensions();
    const { device, textureUploads } = createFakeDevice();

    createSpriteAtlasTexture(device, await loadSpriteImages());

    const mipSizes = (
      sourceWidth: number,
      sourceHeight: number,
    ): { mipLevel: number; width: number; height: number }[] =>
      Array.from({ length: SPRITE_MIP_LEVEL_COUNT }, (_, level) => ({
        mipLevel: level,
        width: sourceWidth >> level,
        height: sourceHeight >> level,
      }));

    // Tree layers 0-2 are 192x192; a 3x2 building layer is 576x384; a 2x2
    // building layer is 384x384.
    const layer0 = textureUploads.filter((upload) => upload.originZ === 0);
    expect(
      layer0.map((u) => ({
        mipLevel: u.mipLevel,
        width: u.width,
        height: u.height,
      })),
    ).toEqual(mipSizes(192, 192));
    const smallHouseLayer = BUILDING_SPRITE_LAYERS.smallHouse;
    const smallHouseUploads = textureUploads.filter(
      (upload) => upload.originZ === smallHouseLayer,
    );
    expect(
      smallHouseUploads.map((u) => ({
        mipLevel: u.mipLevel,
        width: u.width,
        height: u.height,
      })),
    ).toEqual(mipSizes(384, 192));
    const officeTowerLayer = BUILDING_SPRITE_LAYERS.officeTower;
    expect(
      textureUploads
        .filter((upload) => upload.originZ === officeTowerLayer)
        .map((u) => ({
          mipLevel: u.mipLevel,
          width: u.width,
          height: u.height,
        })),
    ).toEqual(mipSizes(384, 384));
  });

  it("reuses one fixed-size smoothed canvas, cleared before every scaled draw", async () => {
    registerShippedDimensions();
    const { device } = createFakeDevice();

    createSpriteAtlasTexture(device, await loadSpriteImages());

    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    expect(context.imageSmoothingQuality).toBe("high");
    // Canvas keeps its fixed atlas size throughout: never resized per mip.
    expect(context.canvas.width).toBe(SPRITE_ATLAS_WIDTH);
    expect(context.canvas.height).toBe(SPRITE_ATLAS_HEIGHT);
    expect(context.calls).toHaveLength(
      SPRITE_LAYER_COUNT * SPRITE_MIP_LEVEL_COUNT * 2,
    );
    for (let i = 0; i < context.calls.length; i += 2) {
      const clear = context.calls[i]!;
      const draw = context.calls[i + 1]!;
      expect(clear.kind).toBe("clearRect");
      expect(clear.width).toBe(SPRITE_ATLAS_WIDTH);
      expect(clear.height).toBe(SPRITE_ATLAS_HEIGHT);
      expect(draw.kind).toBe("drawImage");
    }
    // Mip draw sizes shrink per level (top-left scaled crop); the first
    // layer is a 192px tree whose level-4 draw is 192>>4 px wide.
    expect(context.calls[1]!.width).toBe(192);
    expect(context.calls[SPRITE_MIP_LEVEL_COUNT * 2 - 1]!.width).toBe(
      192 >> (SPRITE_MIP_LEVEL_COUNT - 1),
    );
  });

  it("destroys the partially created texture when an upload throws", async () => {
    registerShippedDimensions();
    const { device, textures } = createFakeDevice();
    vi.spyOn(device.queue, "copyExternalImageToTexture").mockImplementation(
      () => {
        throw new Error("upload failed");
      },
    );
    const images = await loadSpriteImages();

    expect(() => createSpriteAtlasTexture(device, images)).toThrow(
      "upload failed",
    );
    expect(textures).toHaveLength(1);
    expect(textures[0]!.destroyed).toBe(true);
  });
});
