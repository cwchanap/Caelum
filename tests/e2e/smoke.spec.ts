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

test("loads board and supports basic controls", async ({ page }) => {
  await page.goto(appUrl);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  await expect(page.getByTestId("game-canvas")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();
  await expect(page.getByText("Budget $120,000")).toBeVisible();

  await page.getByRole("button", { name: "Bus Stop" }).click();
  const canvas = page.getByTestId("game-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (box === null) {
    throw new Error("Canvas bounding box is unavailable");
  }

  await canvas.click({
    position: {
      x: ((7 * 32 + 16) / 1280) * box.width,
      y: ((8 * 32 + 16) / 800) * box.height
    }
  });
  await expect(page.getByText("Budget $118,000")).toBeVisible();

  await page.getByRole("button", { name: "Coverage" }).click();
  await page.getByRole("button", { name: "2x" }).click();

  await expect(page.getByText(/Pop(?:ulation)? 36/)).toBeVisible();
});
