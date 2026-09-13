import { defineConfig, devices } from "@playwright/test";

declare const process: { platform: string };

// Headless Chromium hides the WebGPU adapter without this flag;
// proven by tests/e2e/webgpuProbe.spec.ts. Not performance evidence.
const webGpuArgs = ["--enable-unsafe-webgpu"];
if (process.platform === "linux") {
  // Linux CI runners have no GPU, and headless Linux Chromium never
  // presents WebGPU canvas frames — canvas-side readbacks (toDataURL,
  // screenshots) stay opaque black even when rendering works, which is
  // what routes.spec.ts's pixel probes measure. Route Dawn, ANGLE, and
  // the compositor through one bundled SwiftShader software-Vulkan stack
  // and run headed; CI supplies the display via xvfb-run. The host needs
  // the system Vulkan loader and a Mesa ICD (libvulkan1,
  // mesa-vulkan-drivers) for Vulkan init.
  webGpuArgs.push(
    "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE",
    "--use-angle=vulkan",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--disable-vulkan-surface",
  );
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: 2,
  use: {
    trace: "on-first-retry",
    baseURL: "http://127.0.0.1:5281",
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:5281",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: { args: webGpuArgs },
        // Headed on Linux (see webGpuArgs): WebGPU canvas presentation
        // requires a real display surface there.
        headless: process.platform !== "linux",
      },
    },
  ],
});
