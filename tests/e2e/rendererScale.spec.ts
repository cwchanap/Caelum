import { expect, test } from "@playwright/test";
import type { BenchRunConfig, RendererScaleResult } from "./rendererScale";

// Playwright specs run under Node, but the repo tsconfig only includes DOM
// ambient types — declare the one environment variable this spec reads.
declare const process: { env: { CAELUM_RENDER_BENCH?: string } };

test.skip(
  process.env.CAELUM_RENDER_BENCH !== "1",
  "Renderer benchmark rows run via `bun run bench:render` (CAELUM_RENDER_BENCH=1), not in normal E2E.",
);

const RUNS: BenchRunConfig[] = [
  { renderer: "webgpu", mapSize: "small", vehicleCount: 200 },
  { renderer: "webgpu", mapSize: "small", vehicleCount: 5000 },
  { renderer: "canvas2d", mapSize: "large", vehicleCount: 200 },
];

test("records WebGPU and Canvas2D renderer scale rows", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/tests/e2e/rendererScale.html");
  await page.waitForFunction(() => "__caelumRendererScale" in window);

  const results: RendererScaleResult[] = [];
  for (const config of RUNS) {
    const result = await page.evaluate((run) => {
      return window.__caelumRendererScale.run(run);
    }, config);
    results.push(result);
    // Documentation evidence only: rows are recorded on the HPA-1144 PR;
    // there is no timing threshold.
    console.log(
      `${result.renderer}/${result.mapSize}/vehicles-${result.vehicleCount}: ` +
        `median ${result.medianCpuMs.toFixed(3)}ms p95 ${result.p95CpuMs.toFixed(3)}ms over ${result.frames} frames ` +
        `(presented ${result.presentedVehicles}, encoded ${result.encodedInstances}, upload ${result.vehicleUploadBytes}B, ` +
        `solid draws ${result.solidDraws}, sprite instances ${result.spriteInstances}, sprite draws ${result.spriteDraws}, ` +
        `vehicle draws ${result.vehicleDraws}, queue completed ${result.queueCompleted})`,
    );
  }

  expect(
    results.map(({ renderer, mapSize, vehicleCount }) => ({
      renderer,
      mapSize,
      vehicleCount,
    })),
  ).toEqual(RUNS);
  for (const result of results) {
    expect(result.frames).toBe(120);
    expect(result.presentedVehicles).toBe(result.vehicleCount);
    expect(result.encodedInstances).toBe(result.vehicleCount);
    // The real-host frames always carry scene sprites (the fixtures place a
    // bus terminal and houses), so the textured pass must have drawn once.
    expect(result.spriteInstances).toBeGreaterThan(0);
    expect(result.spriteDraws).toBe(1);
    expect(result.vehicleDraws).toBe(1);
    expect(result.medianCpuMs).toBeGreaterThan(0);
    expect(result.p95CpuMs).toBeGreaterThanOrEqual(result.medianCpuMs);
    if (result.renderer === "webgpu") {
      expect(result.mapSize).toBe("small");
      expect(result.vehicleUploadBytes).toBe(result.encodedInstances * 11 * 4);
      expect(result.queueCompleted).toBe(true);
    } else {
      // Canvas2D has no GPU queue: it must not claim queue completion or
      // nonzero GPU-upload bytes.
      expect(result.vehicleUploadBytes).toBe(0);
      expect(result.queueCompleted).toBe(false);
    }
  }
});
