import { expect, test, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let appUrl: string;

const mapWidth = 28;
const mapHeight = 18;
const tileSize = 32;

async function clickMapTile(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }

  const scale = Math.min(
    box.width / (mapWidth * tileSize),
    box.height / (mapHeight * tileSize),
  );
  const offsetX = (box.width - mapWidth * tileSize * scale) / 2;
  const offsetY = (box.height - mapHeight * tileSize * scale) / 2;

  await canvas.click({
    position: {
      x: offsetX + (tile.x + 0.5) * tileSize * scale,
      y: offsetY + (tile.y + 0.5) * tileSize * scale,
    },
  });
}

test.beforeAll(async () => {
  server = await createServer({
    configFile: "vite.config.ts",
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  await server.listen();
  const resolved = server.resolvedUrls?.local[0];
  if (!resolved) throw new Error("Vite dev server did not expose a local URL");
  appUrl = resolved;
});

test.afterAll(async () => {
  await server.close();
});

test("loads the svelte shell and supports active building placement", async ({
  page,
}) => {
  await page.goto(appUrl);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(populationReadout.getByText("36")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await page.getByRole("button", { name: "Small House" }).click();
  await clickMapTile(canvas, { x: 0, y: 1 });

  await expect(topbar.getByText("$116,000")).toBeVisible();
  await expect(populationReadout.getByText("40")).toBeVisible();

  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.getByRole("button", { name: "Rotate" }).click();

  await expect(page.getByText("BUS TERMINAL 90")).toBeVisible();
});
