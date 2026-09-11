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
