import { expect, type Page } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  sampleFrameTransform,
  sampleTilePixels,
  selectBuildLeaf,
  selectTool,
  settleLayout,
  type PixelProbe,
} from "./helpers";
import { expectRoadsideStopAnchors } from "./stopAnchors";
import { grassRgb } from "./spriteFootprint";

const stops = [
  { x: 7, y: 9 },
  { x: 11, y: 9 },
] as const;
const stations = [
  { x: 7, y: 6 },
  { x: 10, y: 6 },
] as const;

function closeToColor(
  sample: [number, number, number] | null,
  color: readonly number[],
  tolerance: number,
): boolean {
  return (
    sample !== null &&
    color.every((value, index) => Math.abs(sample[index]! - value) <= tolerance)
  );
}

async function expectMetroBadge(
  page: Page,
  rim: readonly number[],
  tolerance: number,
  tile: { x: number; y: number } = stations[0],
): Promise<void> {
  const pixels = await sampleTilePixels(page, [
    { tile, dx: -3.5, dy: 0 },
    // Mask texels (96,30) and (96,162) lie beyond the horizontal 8px stroke.
    { tile, dx: 0, dy: -4.8125 },
    { tile, dx: 0, dy: 4.8125 },
  ]);
  expect(
    closeToColor(pixels[0]!, [255, 248, 238], tolerance),
    `metro face: ${pixels[0]}`,
  ).toBe(true);
  for (const [index, pixel] of pixels.slice(1).entries()) {
    expect(
      closeToColor(pixel, rim, tolerance),
      `metro rim perpendicular probe ${index}: ${pixel}`,
    ).toBe(true);
  }
}

/** Real UI construction, with the same independent pixel probes in both renderers. */
export async function expectTransitSpriteScene(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<void> {
  await createDefaultCity(
    page,
    `Transit ${renderer}`,
    "blankGrid",
    renderer,
    "large",
  );
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toHaveAttribute("data-renderer", renderer);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 6, y: 10 }, { x: 12, y: 10 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of stops) await clickMapTile(canvas, stop);

  await selectBuildLeaf(page, "transit", "track");
  await dragMapTiles(page, canvas, { x: 7, y: 6 }, { x: 11, y: 6 });
  await dragMapTiles(page, canvas, { x: 9, y: 5 }, { x: 9, y: 6 });
  await dragMapTiles(page, canvas, { x: 11, y: 6 }, { x: 11, y: 7 });
  await selectBuildLeaf(page, "transit", "metroStation");
  for (const station of stations) await clickMapTile(canvas, station);
  await selectTool(page, "select");
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return [
        [7, 6],
        [8, 6],
        [9, 6],
        [10, 6],
        [11, 6],
        [9, 5],
        [11, 7],
      ].every(
        ([x, y]) =>
          state.map.tiles.find((tile) => tile.x === x && tile.y === y)
            ?.hasTrack === true,
      );
    })
    .toBe(true);

  // Opaque ballast at the edge of the real 192px straight/corner assets.
  const seamProbes: PixelProbe[] = [
    { tile: { x: 8, y: 6 }, dx: 15, dy: 0 },
    { tile: { x: 9, y: 6 }, dx: -15, dy: 0 },
    { tile: { x: 10, y: 6 }, dx: 15, dy: 0 },
    { tile: { x: 11, y: 6 }, dx: -15, dy: 0 },
    { tile: { x: 11, y: 6 }, dx: 0, dy: 15 },
    { tile: { x: 11, y: 7 }, dx: 0, dy: -15 },
    // The south side of the endpoint has no neighbor and no rail.
    { tile: { x: 11, y: 7 }, dx: 0, dy: 13 },
  ];
  const checkSeams = async (): Promise<void> => {
    const pixels = await sampleTilePixels(page, seamProbes);
    for (let i = 0; i < 6; i += 1) {
      expect(
        closeToColor(pixels[i]!, [222, 198, 163], 60),
        `rail edge ${i}: ${pixels[i]}`,
      ).toBe(true);
    }
    expect(
      closeToColor(pixels[6]!, grassRgb({ x: 11, y: 7 }), 12),
      `no phantom rail: ${pixels[6]}`,
    ).toBe(true);
  };
  const fit = await sampleFrameTransform(page);
  expect(fit!.scale * 32).toBeLessThan(16);
  await checkSeams();
  // At Large Fit each badge is only ~5 device pixels wide; rim and face
  // texels blend, so test their distinctive colors rather than native RGB.
  const [busRim, busFace, metroRim, metroFace] = await sampleTilePixels(page, [
    { tile: stops[0], dx: -6, dy: 0 },
    { tile: stops[0], dx: 0, dy: 0 },
    { tile: stations[0], dx: 3, dy: -6 },
    { tile: stations[0], dx: 0, dy: 0 },
  ]);
  expect(
    closeToColor(busRim!, [196, 153, 116], 22),
    `Fit bus rim: ${busRim}`,
  ).toBe(true);
  expect(
    closeToColor(busFace!, [175, 148, 132], 22),
    `Fit bus face: ${busFace}`,
  ).toBe(true);
  expect(
    closeToColor(metroRim!, [119, 140, 163], 22),
    `Fit metro rim: ${metroRim}`,
  ).toBe(true);
  expect(
    closeToColor(metroFace!, [145, 133, 125], 22),
    `Fit metro face: ${metroFace}`,
  ).toBe(true);
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime: {
          adjustCamera(
            action:
              | { kind: "zoomIn" }
              | { kind: "centerOn"; point: { x: number; y: number } },
          ): unknown;
        };
      }
    ).__caelumRuntime;
    for (let i = 0; i < 24; i += 1) runtime.adjustCamera({ kind: "zoomIn" });
    runtime.adjustCamera({ kind: "centerOn", point: { x: 9.5, y: 8 } });
  });
  await settleLayout(page);
  const transform = await sampleFrameTransform(page);
  expect(transform!.scale * 32).toBeCloseTo(96, 1);
  await checkSeams();

  // Place the join at N+0.6 device pixels so pixel N's center lies 0.1px
  // inside the straight's east edge, where linear filtering sees its gutter.
  const edgeDevice =
    (transform!.offsetX + 9 * 32 * transform!.scale) * transform!.dpr;
  const camera = (await runtimeSnapshot(page)).camera!;
  const shift =
    (edgeDevice - (Math.floor(edgeDevice) + 0.6)) /
    (32 * transform!.scale * transform!.dpr);
  await page.evaluate(
    (center) => {
      const runtime = (
        window as unknown as {
          __caelumRuntime: {
            adjustCamera(action: {
              kind: "centerOn";
              point: { x: number; y: number };
            }): unknown;
          };
        }
      ).__caelumRuntime;
      runtime.adjustCamera({ kind: "centerOn", point: center });
    },
    { x: camera.center.x + shift, y: camera.center.y },
  );
  await settleLayout(page);
  const fractional = (await sampleFrameTransform(page))!;
  const edge =
    (fractional.offsetX + 9 * 32 * fractional.scale) * fractional.dpr;
  expect(edge - Math.floor(edge)).toBeCloseTo(0.6, 2);
  const leftWorld =
    (Math.floor(edge) / fractional.dpr - fractional.offsetX) / fractional.scale;
  const joinPixels = await sampleTilePixels(
    page,
    [-1, 0, 1, 2].map((step) => ({
      tile: { x: 8, y: 6 },
      dx: leftWorld - 8.5 * 32 + step / (fractional.scale * fractional.dpr),
      dy: 0,
    })),
  );
  for (const [index, pixel] of joinPixels.entries()) {
    expect(
      closeToColor(pixel, [222, 198, 163], 4),
      `fractional join ${index}: ${pixel}`,
    ).toBe(true);
  }

  // Tile (11,7) hashes to a tree centered at approximately (+2,+1.4),
  // with a +3/+3 shadow. Track suppresses both across their old footprint.
  const obstructionPixels = await sampleTilePixels(page, [
    { tile: { x: 11, y: 7 }, dx: 2, dy: 6 },
    { tile: { x: 11, y: 7 }, dx: 5, dy: 7 },
  ]);
  for (const pixel of obstructionPixels) {
    expect(
      closeToColor(pixel, grassRgb({ x: 11, y: 7 }), 12),
      `no tree or shadow: ${pixel}`,
    ).toBe(true);
  }

  // The rotated west-half endpoint uses source texel x≈16 (brown sleeper),
  // not texel x≈32 from squeezing the full straight image into half a tile.
  const [half] = await sampleTilePixels(page, [
    { tile: { x: 11, y: 7 }, dx: 0, dy: -13.33 },
  ]);
  expect(
    closeToColor(half!, [154, 123, 94], 35),
    `half rail sleeper: ${half}`,
  ).toBe(true);
  expect(closeToColor(half!, [222, 198, 163], 30)).toBe(false);

  await expectMetroBadge(page, [40, 103, 178], 35);
  await expectRoadsideStopAnchors(page, stops);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  const [beforeHandle] = await sampleTilePixels(page, [
    { tile: stops[0], dx: 0, dy: 0 },
  ]);
  for (const stop of stops) await clickMapTile(canvas, stop);
  await expect(page.getByTestId("route-draft")).toBeVisible();
  const [activeHandle] = await sampleTilePixels(page, [
    { tile: stops[0], dx: 0, dy: 0 },
  ]);
  expect(closeToColor(beforeHandle!, [255, 252, 243], 35)).toBe(false);
  expect(
    closeToColor(activeHandle!, [255, 252, 243], 35),
    `rendered draft handle: ${activeHandle}`,
  ).toBe(true);
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-item-route-001")).toBeVisible();
  const route = (await runtimeSnapshot(page)).state.transit.routes[0]!;
  const selectRoute = page.getByRole("button", {
    name: `Select ${route.name}`,
  });
  if ((await selectRoute.getAttribute("aria-pressed")) !== "true")
    await selectRoute.click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).ui.selectedRouteId)
    .toBe(route.id);
  await expectRoadsideStopAnchors(page, stops, route.color);
  await page.getByTestId(`route-color-${route.id}-#2e9e5b`).click();
  await expect
    .poll(
      async () => (await runtimeSnapshot(page)).state.transit.routes[0]?.color,
    )
    .toBe("#2e9e5b");
  await expectRoadsideStopAnchors(page, stops, "#2e9e5b");

  await page.getByRole("button", { name: "New Metro" }).click();
  for (const station of stations) await clickMapTile(canvas, station);
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  const metro = (await runtimeSnapshot(page)).state.transit.metroLines[0]!;
  const selectMetro = page.getByRole("button", {
    name: `Select ${metro.name}`,
  });
  if ((await selectMetro.getAttribute("aria-pressed")) !== "true")
    await selectMetro.click();
  await page.getByTestId(`route-color-${metro.id}-#2e9e5b`).click();
  await expect
    .poll(
      async () =>
        (await runtimeSnapshot(page)).state.transit.metroLines[0]?.color,
    )
    .toBe("#2e9e5b");
  // The paused initial train occupies the first station.
  await expectMetroBadge(page, [46, 158, 91], 35, stations[1]);
}
