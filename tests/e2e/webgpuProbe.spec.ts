import { expect, test } from "@playwright/test";

interface ProbeResult {
  ok: boolean;
  reason?: string;
  format?: string;
}

// Early proof that real Chromium can drive a real WebGPU device end to end:
// adapter, configured canvas, one clear render pass, and completed submission.
// This is a capability probe, not performance evidence.
test("Chromium exposes a working WebGPU device", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async (): Promise<ProbeResult> => {
    const gpu = navigator.gpu;
    if (!gpu) {
      return { ok: false, reason: "navigator.gpu is unavailable" };
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, reason: "requestAdapter returned null" };
    }
    const device = await adapter.requestDevice();

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("webgpu");
    if (!context) {
      return { ok: false, reason: 'getContext("webgpu") returned null' };
    }
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.84, g: 0.89, b: 0.87, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return { ok: true, format };
  });

  if (!result.ok) {
    throw new Error(`WebGPU probe failed: ${result.reason}`);
  }
  expect(result.format === "bgra8unorm" || result.format === "rgba8unorm").toBe(
    true,
  );
});

interface PresentedProbeResult {
  ok: boolean;
  reason?: string;
  center?: [number, number, number];
  rafGapMs?: number;
  visibility?: string;
  pngBytes?: number;
}

// The routes.spec.ts pixel oracles read presented frames through
// canvas.toDataURL; this probes that exact path (present → PNG encode →
// decode → getImageData) plus rAF liveness, which the software-Vulkan CI
// stack can break independently of adapter/device setup.
test("presented WebGPU canvas frames are readable via toDataURL", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(
    async (): Promise<PresentedProbeResult> => {
      const gpu = navigator.gpu;
      if (!gpu) return { ok: false, reason: "navigator.gpu is unavailable" };
      const adapter = await gpu.requestAdapter();
      if (!adapter)
        return { ok: false, reason: "requestAdapter returned null" };
      const device = await adapter.requestDevice();

      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      const context = canvas.getContext("webgpu");
      if (!context) {
        return { ok: false, reason: 'getContext("webgpu") returned null' };
      }
      context.configure({
        device,
        format: gpu.getPreferredCanvasFormat(),
        alphaMode: "opaque",
      });

      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0.84, g: 0.35, b: 0.22, a: 1 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        })
        .end();
      device.queue.submit([encoder.finish()]);

      // Present lands at the next frame boundary; two rAFs also detect a
      // stalled frame loop under the software rasterizer.
      const raf = () =>
        new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const t0 = performance.now();
      await raf();
      await raf();
      const rafGapMs = performance.now() - t0;

      const png = canvas.toDataURL();
      const image = new Image();
      const decoded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("canvas PNG decode failed"));
      });
      image.src = png;
      await decoded;
      const probe = document.createElement("canvas");
      probe.width = image.width;
      probe.height = image.height;
      const ctx = probe.getContext("2d");
      if (!ctx) return { ok: false, reason: "2D probe context is unavailable" };
      ctx.drawImage(image, 0, 0);
      const mid =
        (Math.floor(probe.height / 2) * probe.width +
          Math.floor(probe.width / 2)) *
        4;
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      device.destroy();
      return {
        ok: true,
        center: [data[mid], data[mid + 1], data[mid + 2]],
        rafGapMs,
        visibility: document.visibilityState,
        pngBytes: png.length,
      };
    },
  );

  // Diagnostics land in the job log so a CI-only failure names the broken
  // link (blank snapshot vs. stalled rAF vs. hidden page).
  console.log(`presented-probe ${JSON.stringify(result)}`);
  if (!result.ok) {
    throw new Error(`Presented-frame probe failed: ${result.reason}`);
  }
  // clear color (0.84, 0.35, 0.22) → ~(214, 89, 56)
  expect(result.center?.[0]).toBeGreaterThan(190);
  expect(result.center?.[1]).toBeGreaterThan(60);
  expect(result.center?.[1]).toBeLessThan(120);
  expect(result.center?.[2]).toBeLessThan(90);
});
