import { expect, test } from "@playwright/test";
import type { RendererScaleResult } from "./rendererScale";

// Playwright specs run under Node, but the repo tsconfig only includes DOM
// ambient types — declare the one environment variable this spec reads.
declare const process: { env: { CAELUM_RENDER_BENCH?: string } };

test.skip(
  process.env.CAELUM_RENDER_BENCH !== "1",
  "Canvas benchmark rows run via `bun run bench:render` (CAELUM_RENDER_BENCH=1), not in normal E2E.",
);

test("records Canvas renderer scale rows at 200 and 5,000 vehicles", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.goto("/tests/e2e/rendererScale.html");
  await page.waitForFunction(() => "__caelumRendererScale" in window);

  const results: RendererScaleResult[] = [];
  for (const vehicleCount of [200, 5000] as const) {
    const result = await page.evaluate((count) => {
      return window.__caelumRendererScale.run(count);
    }, vehicleCount);
    results.push(result);
    // Documentation evidence only: the row is recorded in
    // docs/performance/hpa-640-webgpu.md; there is no timing threshold.
    console.log(
      `vehicles-${result.vehicleCount}: median ${result.medianCpuMs.toFixed(3)}ms p95 ${result.p95CpuMs.toFixed(3)}ms over ${result.frames} frames`,
    );
  }

  expect(results.map((result) => result.vehicleCount)).toEqual([200, 5000]);
  for (const result of results) {
    expect(result.frames).toBe(120);
    expect(result.medianCpuMs).toBeGreaterThan(0);
    expect(result.p95CpuMs).toBeGreaterThanOrEqual(result.medianCpuMs);
  }
});
