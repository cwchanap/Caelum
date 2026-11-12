import { describe, expect, it } from "vitest";
import {
  getBoardTransform,
  HUD_INSET,
  tileSize,
} from "../../src/render/boardTransform";
import type { Camera } from "../../src/render/boardTransform";
import {
  INSPECTOR_POPOVER_EDGE,
  INSPECTOR_POPOVER_GAP,
  placeInspectorPopover,
} from "../../src/render/inspectorPlacement";
import type { GameMap } from "../../src/domain/types";

const STAGE = { width: 1000, height: 800 };
const MAP = { width: 10, height: 10 };
// Wide enough to overflow the stage at zoom 2, so a panned tile can leave it.
const WIDE_MAP = { width: 28, height: 18 };
const CARD = { width: 200, height: 150 };

function placement(
  tile: { x: number; y: number },
  camera: Camera | null = null,
  map: Pick<GameMap, "width" | "height"> = MAP,
) {
  return placeInspectorPopover({
    stage: STAGE,
    card: CARD,
    tile,
    map,
    camera,
  });
}

/** Tile box in stage CSS px for the same shared transform. */
function tileBox(tile: { x: number; y: number }) {
  const transform = getBoardTransform(STAGE, MAP);
  const size = tileSize * transform.scale;
  const left = transform.offsetX + tile.x * size;
  const top = transform.offsetY + tile.y * size;
  return {
    left,
    top,
    right: left + size,
    bottom: top + size,
  };
}

const safe = {
  left: INSPECTOR_POPOVER_EDGE,
  top: HUD_INSET.top,
  right: STAGE.width - INSPECTOR_POPOVER_EDGE,
  bottom: STAGE.height - HUD_INSET.bottom,
};

describe("placeInspectorPopover", () => {
  it("places the card beside a visible tile, inside the safe stage area", () => {
    const box = tileBox({ x: 4, y: 4 });
    const result = placement({ x: 4, y: 4 });

    expect(result).not.toBeNull();
    expect(result!.left).toBeCloseTo(box.right + INSPECTOR_POPOVER_GAP);
    expect(result!.top).toBeCloseTo(box.bottom + INSPECTOR_POPOVER_GAP);
    expect(result!.left).toBeGreaterThanOrEqual(safe.left);
    expect(result!.top).toBeGreaterThanOrEqual(safe.top);
    expect(result!.left + CARD.width).toBeLessThanOrEqual(safe.right);
    expect(result!.top + CARD.height).toBeLessThanOrEqual(safe.bottom);
  });

  it("flips left of a tile against the right stage edge", () => {
    const box = tileBox({ x: 9, y: 4 });
    const result = placement({ x: 9, y: 4 });

    expect(result).not.toBeNull();
    expect(result!.left).toBeCloseTo(
      box.left - INSPECTOR_POPOVER_GAP - CARD.width,
    );
    expect(result!.left + CARD.width).toBeLessThanOrEqual(box.left);
    expect(result!.left).toBeGreaterThanOrEqual(safe.left);
    expect(result!.top).toBeCloseTo(box.bottom + INSPECTOR_POPOVER_GAP);
  });

  it("flips above a tile against the bottom HUD band", () => {
    const box = tileBox({ x: 4, y: 9 });
    const result = placement({ x: 4, y: 9 });

    expect(result).not.toBeNull();
    expect(result!.top).toBeCloseTo(
      box.top - INSPECTOR_POPOVER_GAP - CARD.height,
    );
    expect(result!.top + CARD.height).toBeLessThanOrEqual(box.top);
    expect(result!.top).toBeGreaterThanOrEqual(safe.top);
    expect(result!.left).toBeCloseTo(box.right + INSPECTOR_POPOVER_GAP);
  });

  it("nudges a too-wide card inside the safe area beside a visible edge tile", () => {
    const stage = { width: 400, height: 500 };
    const card = { width: 300, height: 100 };
    const tile = { x: 4, y: 4 };
    const transform = getBoardTransform(stage, MAP);
    const result = placeInspectorPopover({
      stage,
      card,
      tile,
      map: MAP,
      camera: null,
    });

    expect(transform.scale).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    expect(result!.left).toBe(
      stage.width - INSPECTOR_POPOVER_EDGE - card.width,
    );
    expect(result!.left).toBeGreaterThanOrEqual(INSPECTOR_POPOVER_EDGE);
    expect(result!.top).toBeGreaterThanOrEqual(HUD_INSET.top);
  });

  it("hides when camera movement carries the anchor off-stage, and reappears when it returns", () => {
    const tile = { x: 27, y: 17 };
    const offStage = { zoom: 2, center: { x: 1, y: 1 } };
    const onTile = { zoom: 2, center: { x: 27.5, y: 17.5 } };

    // The transform itself confirms the anchor is outside the safe area.
    const transform = getBoardTransform(STAGE, WIDE_MAP, offStage);
    const hiddenX =
      transform.offsetX + (tile.x + 0.5) * tileSize * transform.scale;
    const hiddenY =
      transform.offsetY + (tile.y + 0.5) * tileSize * transform.scale;
    expect(hiddenX).toBeGreaterThan(safe.right);
    expect(hiddenY).toBeGreaterThan(safe.bottom);
    expect(placement(tile, offStage, WIDE_MAP)).toBeNull();

    const returned = placement(tile, onTile, WIDE_MAP);
    expect(returned).not.toBeNull();
    expect(returned!.left + CARD.width).toBeLessThanOrEqual(safe.right);
    expect(returned!.top + CARD.height).toBeLessThanOrEqual(safe.bottom);
  });

  it("hides an anchor under the top HUD band", () => {
    const tile = { x: 4, y: 4 };
    const underTopbar = { zoom: 2, center: { x: 4.5, y: 17.5 } };
    const transform = getBoardTransform(STAGE, WIDE_MAP, underTopbar);
    const anchorY =
      transform.offsetY + (tile.y + 0.5) * tileSize * transform.scale;

    expect(anchorY).toBeLessThan(HUD_INSET.top);
    expect(placement(tile, underTopbar, WIDE_MAP)).toBeNull();
  });

  it.each([
    [{ width: 0, height: 800 }, CARD],
    [STAGE, { width: 0, height: 150 }],
    [{ width: STAGE.width, height: 0 }, CARD],
  ])("skips zero-size measurements (%j, %j)", (stage, card) => {
    expect(
      placeInspectorPopover({
        stage,
        card,
        tile: { x: 4, y: 4 },
        map: MAP,
        camera: null,
      }),
    ).toBeNull();
  });

  it("skips stages too short to contain the HUD safe bands", () => {
    expect(
      placeInspectorPopover({
        stage: { width: 1000, height: HUD_INSET.top + HUD_INSET.bottom },
        card: CARD,
        tile: { x: 4, y: 4 },
        map: MAP,
        camera: null,
      }),
    ).toBeNull();
  });
});
