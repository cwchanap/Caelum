import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let appUrl: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.config.ts",
    server: {
      host: "127.0.0.1",
      port: 0
    }
  });
  await server.listen();
  appUrl = server.resolvedUrls?.local[0] ?? "";
});

test.afterAll(async () => {
  await server.close();
});

test("loads minimal shell scaffold", async ({ page }) => {
  await page.goto(appUrl);

  // Verify the shell structure exists
  await expect(page.getByTestId("game-shell")).toBeVisible();
  
  // Verify topbar placeholder
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByText("Topbar Placeholder")).toBeVisible();
  
  // Verify canvas host placeholder
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.getByText("Canvas Host Placeholder")).toBeVisible();
  
  // Verify control tower placeholder
  await expect(page.getByTestId("control-tower")).toBeVisible();
  await expect(page.getByText("Panel Placeholder")).toBeVisible();
  
  // Verify basic layout structure
  const shellBox = await page.getByTestId("game-shell").boundingBox();
  const topbarBox = await page.getByTestId("topbar").boundingBox();
  const canvasBox = await page.getByTestId("game-canvas-host").boundingBox();
  const towerBox = await page.getByTestId("control-tower").boundingBox();
  
  expect(shellBox).not.toBeNull();
  expect(topbarBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(towerBox).not.toBeNull();
  
  if (shellBox === null || topbarBox === null || canvasBox === null || towerBox === null) {
    throw new Error("Shell component bounds are unavailable");
  }
  
  // Topbar should be at the top
  expect(topbarBox.y).toBeLessThan(canvasBox.y);
  
  // Canvas and tower should be side by side
  expect(canvasBox.x).toBeLessThan(towerBox.x);
});
