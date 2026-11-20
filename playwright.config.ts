import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The app tsconfig pins `types` to browser-oriented sets (no @types/node);
// this ambient declaration is the only Node API the config needs.
declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare const process: {
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
};

// Selection order for the arm64 Linux Vulkan ICD: an explicit
// caller-supplied ICD list wins untouched; the host lavapipe ICD is used
// only when actually provisioned; otherwise the loader's normal discovery
// (system ICDs) applies.
function resolveArm64VulkanEnv(
  env: Record<string, string | undefined>,
  icdExists: (path: string) => boolean,
): Record<string, string | undefined> | undefined {
  if (env.VK_ICD_FILENAMES || env.VK_DRIVER_FILES) return undefined;
  const hostIcd = "/opt/lavapipe24/lvp.json";
  if (!icdExists(hostIcd)) return undefined;
  return { ...env, VK_ICD_FILENAMES: hostIcd };
}

// Headless Chromium hides the WebGPU adapter without this flag;
// proven by tests/e2e/webgpuProbe.spec.ts. Not performance evidence.
const webGpuArgs = ["--enable-unsafe-webgpu"];
let webGpuEnv: Record<string, string | undefined> | undefined;
if (process.platform === "linux") {
  // Linux CI runners have no GPU, and headless Linux Chromium never
  // presents WebGPU canvas frames — canvas-side readbacks (toDataURL,
  // screenshots) stay opaque black even when rendering works, which is
  // what routes.spec.ts's pixel probes measure. Route Dawn, ANGLE, and
  // the compositor through one bundled SwiftShader software-Vulkan stack
  // and run headed; CI supplies the display via xvfb-run. The host needs
  // the system Vulkan loader and a Mesa ICD (libvulkan1,
  // mesa-vulkan-drivers) for Vulkan init.
  if (process.arch === "arm64") {
    // aarch64 hosts: Chromium's bundled SwiftShader Vulkan ICD advertises no
    // WSI surface extensions (VK_KHR_surface/VK_KHR_xcb_surface), so
    // ANGLE-Vulkan display init fails in every ozone mode, the GPU process
    // crash-loops, and any WebGPU canvas configure tears the instance down
    // mid-suite ("A valid external Instance reference no longer exists").
    // --use-vulkan=swiftshader dlopens the bundled ICD directly, so it cannot
    // be redirected; bind ANGLE and Dawn to a WSI-capable system lavapipe ICD
    // via the loader instead. resolveArm64VulkanEnv keeps an explicit
    // caller-supplied ICD (VK_ICD_FILENAMES / VK_DRIVER_FILES) untouched, adds
    // this host's lavapipe ICD only when provisioned (build mesa >= 25.3 with
    // -Dvulkan-drivers=swrast and install the resulting lvp.json at
    // /opt/lavapipe24), and otherwise leaves the loader's normal discovery (system
    // ICDs) in place. x86_64 CI keeps the bundled SwiftShader path below,
    // unchanged.
    webGpuArgs.push(
      "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE",
      "--use-angle=vulkan",
      "--disable-vulkan-surface",
    );
    webGpuEnv = resolveArm64VulkanEnv(process.env, existsSync);
  } else {
    webGpuArgs.push(
      "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE",
      "--use-angle=vulkan",
      "--use-vulkan=swiftshader",
      "--use-webgpu-adapter=swiftshader",
      "--disable-vulkan-surface",
    );
  }
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
        launchOptions: { args: webGpuArgs, env: webGpuEnv },
        // Headed on Linux (see webGpuArgs): WebGPU canvas presentation
        // requires a real display surface there.
        headless: process.platform !== "linux",
      },
    },
  ],
});
