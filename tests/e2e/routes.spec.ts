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

test("create, manage, and delete a bus route", async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Place three bus stops on empty tiles adjacent to the y=8 road.
  await page.getByRole("button", { name: "Bus Stop" }).click();
  await clickMapTile(canvas, { x: 8, y: 7 });
  await clickMapTile(canvas, { x: 16, y: 7 });
  await clickMapTile(canvas, { x: 23, y: 7 });

  // Draft a route: add three stops, remove the middle one, then finish.
  await page.getByRole("button", { name: "Bus Route" }).click();
  await clickMapTile(canvas, { x: 8, y: 7 });
  await clickMapTile(canvas, { x: 16, y: 7 });
  await clickMapTile(canvas, { x: 23, y: 7 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByTestId("remove-draft-stop-1").click();
  await page.getByRole("button", { name: /finish route/i }).click();

  // The route now appears in the management panel.
  await expect(page.getByTestId("routes-panel")).toBeVisible();
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Toggle inactive, then delete (two clicks for confirm).
  await page.getByTestId("route-toggle-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await expect(page.getByTestId("route-name-route-001")).toHaveCount(0);
});
