import { expect, test, type Page } from "@playwright/test";
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
} from "../../src/persistence/indexedDbCitySaveStore";

// Regression: the library screen/card must be bounded to the viewport height
// and the saved-city list must scroll inside the card. `body` has
// `overflow: hidden`, so an unbounded card makes lower saved cities
// unreachable. 12 seeded rows overflow the list at both acceptance sizes.
const SEEDED_CITIES = 12;
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

// Minimal CitySaveRecords: the library list reads only city metadata, never
// the snapshot, so stub snapshots are enough to exercise real layout.
async function seedCities(page: Page, count: number): Promise<void> {
  await page.evaluate(
    async ({ cityCount, databaseName, databaseVersion }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, databaseVersion);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("cities");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("cities", "readwrite");
        const store = transaction.objectStore("cities");
        for (let index = 1; index <= cityCount; index += 1) {
          const id = `seed-city-${String(index).padStart(2, "0")}`;
          const name = `City ${String(index).padStart(2, "0")}`;
          const savedAt = new Date(Date.UTC(2026, 0, index)).toISOString();
          store.add(
            {
              city: {
                id,
                name,
                createdAt: savedAt,
                templateId: "crossroads",
              },
              savedAt,
              snapshot: {},
            },
            id,
          );
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    },
    {
      cityCount: count,
      databaseName: DEFAULT_DATABASE_NAME,
      databaseVersion: DATABASE_VERSION,
    },
  );
}

test("library list scrolls inside a viewport-bounded card at 1024×768 and 1440×900", async ({
  page,
}) => {
  // Boot once with an empty store, seed, then reload into the library.
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await seedCities(page, SEEDED_CITIES);
  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  const list = page.getByTestId("city-list");
  await expect(
    list.locator("[data-testid^='city-row-']").first(),
  ).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);

    const screen = page.getByTestId("city-library-screen");
    const card = screen.locator(".city-library-card");

    // The screen and card stay inside the viewport at both sizes (no part of
    // the card may fall below the fold where body's overflow hides it).
    const screenBox = (await screen.boundingBox())!;
    expect(screenBox.y).toBeGreaterThanOrEqual(0);
    expect(screenBox.y + screenBox.height).toBeLessThanOrEqual(viewport.height);
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.y).toBeGreaterThanOrEqual(0);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);

    // Enough cities that the list itself must scroll, and scrolling the list
    // brings the last row into view inside the viewport.
    expect(
      await list.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const lastRow = list.locator("[data-testid^='city-row-']").last();
    await expect(lastRow).toBeVisible();
    const rowBox = (await lastRow.boundingBox())!;
    expect(rowBox.y).toBeGreaterThanOrEqual(0);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(viewport.height);
  }
});
