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

interface ReadbackProbeResult {
  ok: boolean;
  reason?: string;
  format?: string;
  center?: [number, number, number];
}

// The routes.spec.ts pixel oracles read frames through
// RuntimeTestSeam.debugCaptureFrame (offscreen render → copyTextureToBuffer →
// mapAsync), because canvas-side readbacks stay blank under software-Vulkan
// CI Chromium. This probes that exact path end to end: a clear pass into a
// COPY_SRC texture must read back the clear color.
test("offscreen WebGPU frames are readable via copyTextureToBuffer", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async (): Promise<ReadbackProbeResult> => {
    const gpu = navigator.gpu;
    if (!gpu) return { ok: false, reason: "navigator.gpu is unavailable" };
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "requestAdapter returned null" };
    const device = await adapter.requestDevice();

    const format = gpu.getPreferredCanvasFormat();
    const width = 64;
    const height = 64;
    const target = device.createTexture({
      size: { width, height },
      format,
      usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
    });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * height,
      usage: 0x01 | 0x08, // MAP_READ | COPY_DST
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          clearValue: { r: 0.84, g: 0.35, b: 0.22, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow },
      { width, height },
    );
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(0x0001); // GPUMapMode.READ
    const mapped = new Uint8Array(readback.getMappedRange());
    const mid = (Math.floor(height / 2) * bytesPerRow +
      Math.floor(width / 2) * 4) as number;
    const b0 = mapped[mid];
    const b1 = mapped[mid + 1];
    const b2 = mapped[mid + 2];
    readback.unmap();
    readback.destroy();
    target.destroy();
    device.destroy();

    // bgra8unorm readbacks arrive B,G,R,A — normalize to R,G,B.
    const center: [number, number, number] = format.startsWith("bgra")
      ? [b2, b1, b0]
      : [b0, b1, b2];
    return { ok: true, format, center };
  });

  // Diagnostics land in the job log so a CI-only failure names the broken
  // link.
  console.log(`readback-probe ${JSON.stringify(result)}`);
  if (!result.ok) {
    throw new Error(`Readback probe failed: ${result.reason}`);
  }
  // clear color (0.84, 0.35, 0.22) → ~(214, 89, 56)
  expect(result.center?.[0]).toBeGreaterThan(190);
  expect(result.center?.[1]).toBeGreaterThan(60);
  expect(result.center?.[1]).toBeLessThan(120);
  expect(result.center?.[2]).toBeLessThan(90);
});
