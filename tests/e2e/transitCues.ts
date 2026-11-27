import { expect, type Locator, type Page } from "@playwright/test";
import { tileSize } from "../../src/render/boardTransform";
import {
  centerAtMaxZoom,
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  selectTool,
  settleLayout,
  type PixelProbe,
} from "./helpers";

const stops = [
  { x: 7, y: 9 },
  { x: 11, y: 9 },
] as const;
const stations = [
  { x: 7, y: 6 },
  { x: 10, y: 6 },
] as const;
const mixedStops = {
  west: { x: 7, y: 13 },
  middle: { x: 9, y: 13 },
  east: { x: 11, y: 13 },
} as const;
const cueColors = ["#ff00ff", "#00ffff", "#ffaa00", "#7f00ff"] as const;

async function createCueCity(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<Locator> {
  await createDefaultCity(
    page,
    `Transit cues ${renderer}`,
    "blankGrid",
    renderer,
    "small",
  );
  return page.locator("canvas[data-runtime-canvas='true']");
}

async function buildCueScene(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<Locator> {
  const canvas = await createCueCity(page, renderer);
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 6, y: 10 }, { x: 12, y: 10 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of stops) await clickMapTile(canvas, stop);
  await selectBuildLeaf(page, "transit", "track");
  await dragMapTiles(page, canvas, { x: 7, y: 6 }, { x: 11, y: 6 });
  await selectBuildLeaf(page, "transit", "metroStation");
  for (const station of stations) await clickMapTile(canvas, station);
  await selectTool(page, "select");
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return [
        state.transit.stops.length,
        state.transit.stations.length,
        state.map.tiles.filter((tile) => tile.hasTrack).length,
      ];
    })
    .toEqual([2, 2, 5]);
  return canvas;
}

async function buildMixedCueScene(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<Locator> {
  const canvas = await createCueCity(page, renderer);
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 6, y: 14 }, { x: 12, y: 14 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of Object.values(mixedStops)) {
    await clickMapTile(canvas, stop);
  }
  await selectTool(page, "select");
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return state.transit.stops.filter((stop) => stop.position.y === 13)
        .length;
    })
    .toBe(3);
  return canvas;
}

async function recolorLine(
  page: Page,
  mode: "bus" | "metro",
  index: number,
  color = cueColors[index]!,
): Promise<void> {
  const id = `${mode === "bus" ? "route" : "metro"}-00${index + 1}`;
  await page.evaluate(
    ({ routeId, routeColor }) => {
      const runtime = (
        window as unknown as {
          __caelumRuntime: {
            recolorRoute(id: string, color: string): unknown;
          };
        }
      ).__caelumRuntime;
      runtime.recolorRoute(routeId, routeColor);
    },
    { routeId: id, routeColor: color },
  );
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      const lines =
        mode === "bus" ? state.transit.routes : state.transit.metroLines;
      return lines[index]?.color;
    })
    .toBe(color);
}

async function createLine(
  page: Page,
  canvas: Locator,
  mode: "bus" | "metro",
  index: number,
  points: readonly { x: number; y: number }[],
): Promise<void> {
  await openCommandDestination(page, "lines");
  const fit = page.getByTestId("map-zoom-fit");
  if (await fit.isEnabled()) {
    await fit.click();
    await settleLayout(page);
  }
  await page
    .getByRole("button", { name: mode === "bus" ? "New Bus" : "New Metro" })
    .click();
  for (const point of points) {
    await clickMapTile(canvas, point);
  }
  const save = page.getByRole("button", {
    name: /^Save(?: & run| without fleet)/,
  });
  await expect(save).toBeEnabled();
  await save.click();
  const lines = mode === "bus" ? "routes" : "metroLines";
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return state.transit[lines].length;
    })
    .toBe(index + 1);
  await recolorLine(page, mode, index);
}

async function createSharedLine(
  page: Page,
  canvas: Locator,
  mode: "bus" | "metro",
  index: number,
): Promise<void> {
  await createLine(
    page,
    canvas,
    mode,
    index,
    mode === "bus" ? stops : stations,
  );
}

function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) =>
    parseInt(hex.slice(start, start + 2), 16),
  ) as [number, number, number];
}

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

async function clearRouteSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as {
        __caelumRuntime: { selectRoute(id: string | null): unknown };
      }
    ).__caelumRuntime.selectRoute(null);
  });
}

function mixedCueBandProbes(
  side: "north" | "south",
  outsideConnector = false,
): PixelProbe[] {
  const probes: PixelProbe[] = [];
  // At max zoom one third of a world px is about one capture pixel. Exclude
  // the badge's opaque radius and, on the road side, the width-5 endpoint
  // connector (plus raster margin) so a line stroke cannot masquerade as a cue.
  for (let xStep = -45; xStep <= 45; xStep += 1) {
    for (let yStep = 27; yStep <= 48; yStep += 1) {
      const dx = xStep / 3;
      const dy = (side === "north" ? -yStep : yStep) / 3;
      if (Math.hypot(dx, dy) <= 12.75) continue;
      if (outsideConnector && Math.abs(dx) <= 2.75) continue;
      probes.push({ tile: mixedStops.middle, dx, dy });
    }
  }
  return probes;
}

function countClosePixels(
  pixels: Array<[number, number, number] | null>,
  color: string,
): number {
  const expected = hexRgb(color);
  return pixels.filter((pixel) => closeToColor(pixel, expected, 45)).length;
}

async function expectVisibleMixedCueColors(page: Page): Promise<void> {
  const northProbes = mixedCueBandProbes("north");
  const southProbes = mixedCueBandProbes("south", true);
  const pixels = await sampleTilePixels(page, [...northProbes, ...southProbes]);
  const northPixels = pixels.slice(0, northProbes.length);
  const southPixels = pixels.slice(northProbes.length);

  // Canonical corridor orientation is coordinate-order dependent, so the
  // oracle does not care which side each cue started on. Both bands exclude
  // the opaque badge; the road-side band also excludes the width-5 endpoint
  // connector, making any surviving line color evidence of a painted cue cap.
  for (const index of [0, 1, 2]) {
    const northCount = countClosePixels(northPixels, cueColors[index]!);
    const southCount = countClosePixels(southPixels, cueColors[index]!);
    expect(
      northCount + southCount,
      `mixed-corridor cue ${cueColors[index]}: ${northCount} north + ${southCount} south close pixels`,
    ).toBeGreaterThanOrEqual(2);
  }
}

function cueProbe(index: number, count: number): { dx: number; dy: number } {
  const edge = tileSize / 2 - 3;
  const sign = index < count / 2 ? -1 : 1;
  const centered = count !== 4;
  const x = centered
    ? 0
    : index % 2 === 0
      ? -3.3194449758734716
      : 3.3194449758734716;
  const y = sign * edge;
  const length = Math.hypot(x, y);
  return {
    dx: x + (x / length) * 1.5,
    dy: y + (y / length) * 1.5,
  };
}

async function expectVisibleCueColors(
  page: Page,
  mode: "bus" | "metro",
  count: number,
): Promise<void> {
  const tile = mode === "bus" ? stops[0] : stations[0];
  const displaced =
    count === 3 ? [0, 2] : Array.from({ length: count }, (_, index) => index);
  const probes = displaced.flatMap((index) => {
    const center = cueProbe(index, count);
    return [-0.8, 0, 0.8].flatMap((ox) =>
      [-0.8, 0, 0.8].map((oy) => ({
        tile,
        dx: center.dx + ox,
        dy: center.dy + oy,
      })),
    );
  });
  const pixels = await sampleTilePixels(page, probes);
  for (const [probeIndex, lineIndex] of displaced.entries()) {
    const expected = hexRgb(cueColors[lineIndex]!);
    const neighborhood = pixels.slice(probeIndex * 9, probeIndex * 9 + 9);
    const best = neighborhood
      .filter((pixel): pixel is [number, number, number] => pixel !== null)
      .sort(
        (left, right) =>
          Math.hypot(...left.map((v, i) => v - expected[i]!)) -
          Math.hypot(...right.map((v, i) => v - expected[i]!)),
      )[0];
    expect(
      best !== undefined && closeToColor(best, expected, 45),
      `${mode} ${count}-line cue ${lineIndex}: best ${best} expected ${expected}, neighborhood ${JSON.stringify(neighborhood)}`,
    ).toBe(true);
  }
}

/** Creates two, three, then four shared bus routes and metro lines. After
 *  each stage, max-zoom pixel probes outside the opaque rim prove every
 *  displaced route color still survives badge overpainting. */
export async function expectSharedCuePixels(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<void> {
  const canvas = await buildCueScene(page, renderer);
  for (const mode of ["bus", "metro"] as const) {
    for (let index = 0; index < 4; index += 1) {
      await createSharedLine(page, canvas, mode, index);
      const count = index + 1;
      if (count < 2) continue;
      await clearRouteSelection(page);
      await centerAtMaxZoom(page, {
        x: 7.5,
        y: mode === "bus" ? 9.5 : 6.5,
      });
      await expectVisibleCueColors(page, mode, count);
    }
  }
}

/** Builds a separate lower road with westbound and eastbound local routes
 *  leaving the middle stop in opposite directions while a third route runs
 *  through it. In this deterministic id and corridor ordering, a local cue and
 *  the through cue coincide before cross-corridor resolution. Dense
 *  painted-frame probes then prove all three route colors still survive
 *  marker-sprite overpainting. */
export async function expectMixedCorridorCuePixels(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<void> {
  const canvas = await buildMixedCueScene(page, renderer);
  await createLine(page, canvas, "bus", 0, [
    mixedStops.middle,
    mixedStops.west,
  ]);
  await createLine(page, canvas, "bus", 1, [
    mixedStops.middle,
    mixedStops.east,
  ]);
  await createLine(page, canvas, "bus", 2, [
    mixedStops.west,
    mixedStops.middle,
    mixedStops.east,
  ]);
  await clearRouteSelection(page);
  await centerAtMaxZoom(page, { x: 9.5, y: 13.5 });
  await expectVisibleMixedCueColors(page);
}
