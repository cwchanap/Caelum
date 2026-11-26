import { expect, type Page } from "@playwright/test";
import {
  runtimeSnapshot,
  sampleFrameTransform,
  sampleTilePixels,
  type PixelProbe,
} from "./helpers";

// Opaque texels in bus-stop.webp at (96,108) and (80,80), and the white
// bus-stop-ring.webp at (30,96)/(162,96)/(96,30)/(96,162). The quad is
// 14 world px wide.
const faceDarkRgb = [76, 58, 52] as const;
const faceCreamRgb = [255, 248, 238] as const;

/**
 * Known-color roadside stop marker oracle extracted from routes.spec.ts so
 * the Canvas2D fallback spec can reuse it without cloning the full routes
 * flow. Waits for present stops at `positions` (empty anchor tile with a
 * road access point), then probes distinct face and white-mask rim texels at
 * each passenger and road anchor. Passenger anchors show face-plus-rim;
 * road-access tiles must not (they only carry the thinner route-line
 * stroke).
 */
export async function expectRoadsideStopAnchors(
  page: Page,
  positions: readonly { x: number; y: number }[],
  rimColor = "#e04f39",
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

  const inset = (16 * 14) / 192;
  const rim = (66 * 14) / 192;
  const probeCount = 4;
  const rimRgb = [1, 3, 5].map((index) =>
    parseInt(rimColor.slice(index, index + 2), 16),
  );
  await expect
    .poll(async () => {
      const transform = await sampleFrameTransform(page);
      if (transform === null) {
        return {
          passengerFaces: false,
          passengerRims: false,
          roadMarkers: false,
        };
      }
      // sampleTilePixels rounds indices; select the nearest pixel center.
      const adjust = 0.5 / (transform.scale * transform.dpr);
      const probes: PixelProbe[] = anchors.flatMap(({ passenger, road }) => {
        const dx = road.x - passenger.x;
        const dy = road.y - passenger.y;
        const distance = Math.hypot(dx, dy);
        if (distance === 0) throw new Error("Stop and road anchors coincide");
        // Probe the mask perpendicular to the access indicator and connector.
        const normal = {
          dx: (-dy / distance) * rim,
          dy: (dx / distance) * rim,
        };
        const offsets = [
          { dx: 0, dy: (12 * 14) / 192 },
          { dx: -inset, dy: -inset },
          normal,
          { dx: -normal.dx, dy: -normal.dy },
        ];
        return [passenger, road].flatMap((tile) =>
          offsets.map(({ dx, dy }) => ({
            tile,
            dx: dx - adjust,
            dy: dy - adjust,
          })),
        );
      });
      const samples = await sampleTilePixels(page, probes);
      const near = (
        sample: [number, number, number] | null,
        rgb: readonly [number, number, number] | number[],
        tolerance = 45,
      ) =>
        sample !== null &&
        Math.abs(sample[0] - rgb[0]) <= tolerance &&
        Math.abs(sample[1] - rgb[1]) <= tolerance &&
        Math.abs(sample[2] - rgb[2]) <= tolerance;
      const markerFaceAt = (index: number) =>
        near(samples[index]!, faceDarkRgb) &&
        near(samples[index + 1]!, faceCreamRgb);
      const markerRimAt = (index: number) =>
        samples
          .slice(index + 2, index + probeCount)
          .some((sample) => near(sample, rimRgb, 50));
      return {
        passengerFaces: anchors.every((_, anchorIndex) =>
          markerFaceAt(anchorIndex * probeCount * 2),
        ),
        passengerRims: anchors.every((_, anchorIndex) =>
          markerRimAt(anchorIndex * probeCount * 2),
        ),
        roadMarkers: anchors.some((_, anchorIndex) => {
          const index = anchorIndex * probeCount * 2 + probeCount;
          return markerFaceAt(index) && markerRimAt(index);
        }),
      };
    })
    .toEqual({ passengerFaces: true, passengerRims: true, roadMarkers: false });
}
