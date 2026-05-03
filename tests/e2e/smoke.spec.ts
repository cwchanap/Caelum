import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const tileSize = 32;
const mapWidth = 28;
const mapHeight = 18;

let server: ViteDevServer;
let appUrl: string;

function tileCenterOnCanvas(
  tileX: number,
  tileY: number,
  box: { width: number; height: number },
  canvasSize: { width: number; height: number }
): { x: number; y: number } {
  const canvasWidth = canvasSize.width;
  const canvasHeight = canvasSize.height;
  const scale = Math.min(canvasWidth / (mapWidth * tileSize), canvasHeight / (mapHeight * tileSize));
  const offsetX = (canvasWidth - mapWidth * tileSize * scale) / 2;
  const offsetY = (canvasHeight - mapHeight * tileSize * scale) / 2;

  return {
    x: ((offsetX + (tileX * tileSize + tileSize / 2) * scale) / canvasWidth) * box.width,
    y: ((offsetY + (tileY * tileSize + tileSize / 2) * scale) / canvasHeight) * box.height
  };
}

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
  await expect(page.getByTestId("control-tower")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();
  await expect(page.getByText("Budget $120,000")).toBeVisible();
  const topbarTowerButton = page.getByTestId("topbar").getByRole("button", { name: "Control Tower" });
  await expect(topbarTowerButton).toHaveAttribute("aria-pressed", "true");

  const towerBox = await page.getByTestId("control-tower").boundingBox();
  const shellBox = await page.getByTestId("game-shell").boundingBox();
  expect(towerBox).not.toBeNull();
  expect(shellBox).not.toBeNull();

  if (towerBox === null || shellBox === null) {
    throw new Error("Control tower or shell bounds are unavailable");
  }

  expect(towerBox.y).toBeGreaterThan(shellBox.y + shellBox.height * 0.55);

  await page.getByRole("button", { name: "Close Control Tower" }).click();
  await expect(page.getByTestId("control-tower")).toHaveAttribute("aria-hidden", "true");

  await topbarTowerButton.click();
  await expect(page.getByTestId("control-tower")).toBeVisible();

  await page.getByRole("button", { name: "Bus Stop" }).click();
  const canvas = page.getByTestId("game-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  if (box === null) {
    throw new Error("Canvas bounding box is unavailable");
  }

  const canvasSize = await canvas.evaluate((element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect();

    return {
      width: element.width,
      height: element.height,
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height)
    };
  });
  expect(canvasSize.width).toBe(canvasSize.renderedWidth);
  expect(canvasSize.height).toBe(canvasSize.renderedHeight);

  await canvas.click({
    position: tileCenterOnCanvas(7, 8, box, canvasSize)
  });
  await expect(page.getByText("Budget $118,000")).toBeVisible();

  await page.getByRole("button", { name: "Coverage" }).click();
  await page.getByRole("button", { name: "2x" }).click();

  await expect(page.getByRole("button", { name: "2x" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-panel-field='population']")).toHaveText("36");
});
