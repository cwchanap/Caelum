import { expect, type Page } from "@playwright/test";
import { runtimeSnapshot, sampleTilePixels, type PixelProbe } from "./helpers";

// The stop-marker white fill (radius-7 disc with a route-colored rim),
// identical batch data on the WebGPU renderer and the Canvas2D fallback.
const stopMarkerRgb = [255, 255, 255] as const;
const busMarkerRgb = [224, 79, 57] as const;

/**
 * Known-color roadside stop marker oracle extracted from routes.spec.ts so
 * the Canvas2D fallback spec can reuse it without cloning the full routes
 * flow. Waits for present stops at `positions` (empty anchor tile with a
 * road access point), then probes eight world-pixel points around each
 * passenger and road anchor tile: four inside the white fill (±2px
 * diagonals) and four on the route-colored rim (±6px cardinals) of the
 * radius-7 disc. Passenger anchors must show the fill-plus-rim signature;
 * road-access tiles must not (they only carry the thinner route-line
 * stroke).
 */
export async function expectRoadsideStopAnchors(
  page: Page,
  positions: readonly { x: number; y: number }[],
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return positions.map((position) => {
        const stop = snapshot.state.transit.stops.find(
          (candidate) =>
            candidate.status === "present" &&
            candidate.position.x === position.x &&
            candidate.position.y === position.y,
        );
        const anchorTile = snapshot.state.map.tiles.find(
          (tile) => tile.x === stop?.position.x && tile.y === stop?.position.y,
        );
        const accessTile = snapshot.state.map.tiles.find(
          (tile) =>
            tile.x === stop?.roadAccess?.roadPoint.x &&
            tile.y === stop?.roadAccess?.roadPoint.y,
        );
        return {
          position: stop?.position ?? null,
          anchorKind: anchorTile?.kind ?? null,
          accessKind: accessTile?.kind ?? null,
        };
      });
    })
    .toEqual(
      positions.map((position) => ({
        position,
        anchorKind: "empty",
        accessKind: "road",
      })),
    );

  const snapshot = await runtimeSnapshot(page);
  const anchors = positions.map((position) => {
    const stop = snapshot.state.transit.stops.find(
      (candidate) =>
        candidate.status === "present" &&
        candidate.position.x === position.x &&
        candidate.position.y === position.y,
    );
    if (stop?.roadAccess === undefined) {
      throw new Error(
        `Missing road access for stop at ${position.x},${position.y}`,
      );
    }
    return {
      passenger: stop.position,
      road: stop.roadAccess.roadPoint,
    };
  });

  const inset = 2;
  const rim = 6;
  const offsets = [
    { dx: -inset, dy: -inset },
    { dx: inset, dy: -inset },
    { dx: -inset, dy: inset },
    { dx: inset, dy: inset },
    { dx: -rim, dy: 0 },
    { dx: rim, dy: 0 },
    { dx: 0, dy: -rim },
    { dx: 0, dy: rim },
  ];
  const probes: PixelProbe[] = anchors.flatMap(({ passenger, road }) =>
    [passenger, road].flatMap((tile) =>
      offsets.map((offset) => ({ tile, ...offset })),
    ),
  );
  await expect
    .poll(async () => {
      const samples = await sampleTilePixels(page, probes);
      const near = (
        sample: [number, number, number] | null,
        rgb: readonly [number, number, number] | number[],
      ) =>
        sample !== null &&
        Math.abs(sample[0] - rgb[0]) <= 8 &&
        Math.abs(sample[1] - rgb[1]) <= 8 &&
        Math.abs(sample[2] - rgb[2]) <= 8;
      const markerBlobAt = (index: number) =>
        samples
          .slice(index, index + 4)
          .every((sample) => near(sample, stopMarkerRgb)) &&
        samples
          .slice(index + 4, index + offsets.length)
          .every((sample) => near(sample, busMarkerRgb));
      return {
        passengerMarkers: anchors.every((_, anchorIndex) =>
          markerBlobAt(anchorIndex * offsets.length * 2),
        ),
        roadMarkers: anchors.some((_, anchorIndex) =>
          markerBlobAt(anchorIndex * offsets.length * 2 + offsets.length),
        ),
      };
    })
    .toEqual({ passengerMarkers: true, roadMarkers: false });
}
