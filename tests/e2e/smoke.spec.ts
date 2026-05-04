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
  const resolved = server.resolvedUrls?.local[0];
  if (!resolved) throw new Error("Vite dev server did not expose a local URL");
  appUrl = resolved;
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
});
