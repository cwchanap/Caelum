import { expect, test } from "@playwright/test";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
} from "../../src/persistence/indexedDbCitySaveStore";
import {
  clickMapTile,
  createDefaultCity,
  mapTileViewportPoint,
  openCommandDestination,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  selectTool,
  settleLayout,
  type PixelProbe,
} from "./helpers";

interface StoredCityRecord {
  city: { id: string; name: string; templateId: string };
  snapshot: { budget: number; schemaVersion: number };
}

test("creates a default city through real WASM and IndexedDB", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  const before = await runtimeSnapshot(page);
  expect(before.persistence.activeCity).toBeNull();
  const rustDefaults = {
    budget: before.state.budget,
    startingCapital: before.state.rules.sandbox.startingCapital,
    demandMultiplier: before.state.rules.sandbox.demandMultiplier,
  };

  const cityName = "IndexedDB Smoke";
  await page.getByLabel("City name").fill(cityName);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const after = await runtimeSnapshot(page);
  expect(after.persistence.activeCity).toMatchObject({ name: cityName });
  expect(after.persistence.busy).toBe(false);
  expect(after.persistence.dirty).toBe(false);
  expect(after.state.paused).toBe(true);
  expect({
    budget: after.state.budget,
    startingCapital: after.state.rules.sandbox.startingCapital,
    demandMultiplier: after.state.rules.sandbox.demandMultiplier,
  }).toEqual(rustDefaults);

  const cityId = after.persistence.activeCity!.id;
  const stored = await page.evaluate(
    async ({ cityId, cityName, databaseName, databaseVersion }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, databaseVersion);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<StoredCityRecord[]>(
        (resolve, reject) => {
          const transaction = database.transaction("cities", "readonly");
          const request = transaction.objectStore("cities").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      database.close();
      return (
        records.find(
          (record) =>
            record?.city?.id === cityId && record?.city?.name === cityName,
        ) ?? null
      );
    },
    {
      cityId,
      cityName,
      databaseName: DEFAULT_DATABASE_NAME,
      databaseVersion: DATABASE_VERSION,
    },
  );

  expect(stored).not.toBeNull();
  expect(stored!).toMatchObject({
    city: { id: cityId, name: cityName, templateId: "crossroads" },
  });
  expect(stored!.snapshot.budget).toBe(after.state.budget);
  expect(stored!.snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
});

test("creates Small Town through the real WASM New City flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  await page.getByLabel("City name").fill("Small Town Smoke");
  await page.getByRole("radio", { name: "Small Town" }).check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.state.rules.sandbox.templateId).toBe("smallTown");
  expect(snapshot.state.paused).toBe(true);
  expect(snapshot.state.buildings).toHaveLength(6);
  expect(snapshot.state.populationCount).toBe(0);
  expect(snapshot.state.transit.stops).toEqual([]);
  expect(snapshot.state.transit.stations).toEqual([]);
  expect(snapshot.state.transit.routes).toEqual([]);
  expect(snapshot.state.transit.metroLines).toEqual([]);
  expect(snapshot.state.transit.vehicles).toEqual([]);

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(populationReadout.getByText("0")).toBeVisible();

  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectTool(page, "select");

  const beforeSelection = await runtimeSnapshot(page);
  // Authored slot-0 move-ins are due at t=0, but the paused host must not tick
  // implicitly during mount/selection; keep this premise explicit.
  expect(beforeSelection.state.paused).toBe(true);
  expect(beforeSelection.state.populationCount).toBe(0);

  await clickMapTile(canvas, { x: 21, y: 6 });
  const inspector = page.getByTestId("panel-inspect");
  await expect(inspector.getByText("Office Tower")).toBeVisible();
  await expect(inspector.getByText("Jobs 0 / 4")).toBeVisible();
  await expect(inspector.getByTestId("workplace-status")).toHaveText(
    "Unstaffed",
  );
  await expect(inspector).toContainText(
    "Standard · 07:00–09:00 starts, 17:00–19:00 returns",
  );

  // The anchored Inspector can cover nearby tiles; dismiss it with an empty
  // tile before selecting the next building, as a player would.
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(inspector).toHaveCount(0);
  await clickMapTile(canvas, { x: 15, y: 11 });
  await expect(inspector.getByText("Factory")).toBeVisible();
  await expect(inspector.getByText("Jobs 0 / 6")).toBeVisible();
  await expect(inspector.getByTestId("workplace-status")).toHaveText(
    "Unstaffed",
  );
  await expect(inspector).toContainText("Early / late ·");
});

test("creates a Large city and pans and zooms the map", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByLabel("City name").fill("Large Smoke");
  await page.getByRole("radio", { name: "Small Town" }).check();
  await page
    .getByRole("group", { name: "Map size" })
    .getByRole("radio", { name: "Large" })
    .check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const created = await runtimeSnapshot(page);
  expect(created.state.rules.sandbox.mapSize).toBe("large");
  expect([created.state.map.width, created.state.map.height]).toEqual([84, 54]);
  expect(created.camera).toBeNull();

  // Small Town's office tower, centered on the larger map.
  const office = { x: 21 + 28, y: 6 + 18 };
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectTool(page, "select");

  // Wheel-zoom around the office keeps it under the cursor.
  const point = await mapTileViewportPoint(canvas, office);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -600);
  // Chrome can deliver one wheel gesture as several events; wait until the
  // zoom stops changing before measuring from it.
  await expect
    .poll(async () => {
      const first = (await runtimeSnapshot(page)).camera?.zoom ?? 1;
      await page.waitForTimeout(150);
      const second = (await runtimeSnapshot(page)).camera?.zoom ?? 1;
      return first === second ? first : 0;
    })
    .toBeGreaterThan(2);
  await clickMapTile(canvas, office);
  const inspector = page.getByTestId("panel-inspect");
  await expect(inspector.getByText("Office Tower")).toBeVisible();

  // A select-tool drag pans the view.
  const before = (await runtimeSnapshot(page)).camera!;
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 120, point.y + 60, { steps: 6 });
  await page.mouse.up();
  const after = (await runtimeSnapshot(page)).camera!;
  expect(after.zoom).toBeCloseTo(before.zoom);
  expect(after.center.x).toBeLessThan(before.center.x);
  expect(after.center.y).toBeLessThan(before.center.y);

  await page.getByRole("button", { name: "Show whole map" }).click();
  expect((await runtimeSnapshot(page)).camera).toBeNull();
});

test("radio groups default, preview and arrow keys choose on the New City screen", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  const templateGroup = page.getByRole("group", { name: "Template" });
  const sizeGroup = page.getByRole("group", { name: "Map size" });
  const economyGroup = page.getByRole("group", { name: "Economy" });

  // Defaults: Crossroads, Small, Standard.
  await expect(
    templateGroup.getByRole("radio", { name: "Crossroads" }),
  ).toBeChecked();
  await expect(sizeGroup.getByRole("radio", { name: "Small" })).toBeChecked();
  await expect(
    economyGroup.getByRole("radio", { name: "Standard" }),
  ).toBeChecked();

  // The illustrated preview and caption follow each selection immediately,
  // without invoking Rust.
  const preview = page.getByTestId("new-city-preview");
  const caption = page.getByTestId("new-city-caption");
  await expect(preview).toHaveAttribute("src", /crossroads/);
  await expect(caption).toHaveText("Crossroads · 28×18 · Standard");
  await templateGroup.getByRole("radio", { name: "Blank Grid" }).check();
  await expect(
    templateGroup.getByRole("radio", { name: "Blank Grid" }),
  ).toBeChecked();
  await expect(
    templateGroup.getByRole("radio", { name: "Crossroads" }),
  ).not.toBeChecked();
  await expect(preview).toHaveAttribute("src", /blankGrid/);
  await expect(caption).toHaveText("Blank Grid · 28×18 · Standard");

  await sizeGroup.getByRole("radio", { name: "Medium" }).check();
  await expect(sizeGroup.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(caption).toHaveText("Blank Grid · 56×36 · Standard");

  // Clicking the visible card selects its hidden native radio.
  await economyGroup.locator(".choice-tile", { hasText: "Creative" }).click();
  await expect(
    economyGroup.getByRole("radio", { name: "Creative" }),
  ).toBeChecked();
  await expect(caption).toHaveText("Blank Grid · 56×36 · Creative");

  // Native radio arrow keys move the checked choice. Template tiles are
  // ordered Blank Grid, Crossroads, Small Town.
  await templateGroup.getByRole("radio", { name: "Crossroads" }).check();
  await page.keyboard.press("ArrowDown");
  await expect(
    templateGroup.getByRole("radio", { name: "Small Town" }),
  ).toBeChecked();
  await expect(
    templateGroup.getByRole("radio", { name: "Blank Grid" }),
  ).not.toBeChecked();
  await expect(caption).toHaveText("Small Town · 56×36 · Creative");

  // The untouched prefilled name submits as Riverside with the selections.
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.persistence.activeCity).toMatchObject({
    name: "Riverside",
    templateId: "smallTown",
  });
});

test("gates Create on a trimmed name and trims it into the saved city", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  const create = page.getByRole("button", { name: "Create City" });
  // The name field is prefilled with an editable valid name.
  await expect(page.getByLabel("City name")).toHaveValue("Riverside");
  await expect(create).toBeEnabled();
  await page.getByLabel("City name").fill("   ");
  await expect(create).toBeDisabled();

  await page.getByLabel("City name").fill("  Trimmed Smoke  ");
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.persistence.activeCity?.name).toBe("Trimmed Smoke");
});

test("keeps keyboard focus distinct from the selected tile under forced colors", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.emulateMedia({ forcedColors: "active" });

  // Tab from the name field lands on the checked template radio, which is
  // the selected tile. Its focus ring must differ from the selection ring.
  await page.getByLabel("City name").focus();
  await page.keyboard.press("Tab");
  const selected = page.getByRole("radio", { name: "Crossroads" });
  await expect(selected).toBeFocused();

  const ring = await selected.evaluate((input) => {
    const tile = input.closest(".choice-tile");
    if (!(tile instanceof HTMLElement)) throw new Error("missing choice tile");
    const style = getComputedStyle(tile);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
    };
  });
  expect(ring).toEqual({
    outlineStyle: "dashed",
    outlineWidth: "3px",
    outlineOffset: "2px",
  });
});

test("creates a Medium Creative city through the real WASM New City flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  await page.getByLabel("City name").fill("Medium Creative Smoke");
  await page
    .getByRole("group", { name: "Map size" })
    .getByRole("radio", { name: "Medium" })
    .check();
  await page
    .getByRole("group", { name: "Economy" })
    .getByRole("radio", { name: "Creative" })
    .check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const created = await runtimeSnapshot(page);
  // Medium Rust dimensions (SandboxMapSize::Medium, mirrored by MAP_SIZES).
  expect(created.state.rules.sandbox.mapSize).toBe("medium");
  expect([created.state.map.width, created.state.map.height]).toEqual([56, 36]);
  expect(created.state.rules.economyPreset).toBe("creative");

  // The Creative Rust rule: building is free. The road really lands while
  // the budget never moves (Standard charges 100 per road tile).
  const target = created.state.map.tiles.find(
    (tile) => tile.kind === "empty" && tile.area === undefined,
  );
  expect(target).toBeDefined();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await clickMapTile(canvas, target!);
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return snapshot.state.map.tiles.find(
        (tile) => tile.x === target!.x && tile.y === target!.y,
      )?.kind;
    })
    .toBe("road");
  expect((await runtimeSnapshot(page)).state.budget).toBe(120_000);
});

test("cancels New City opened from the City panel", async ({ page }) => {
  await createDefaultCity(page, "Cancel Smoke");

  await openCommandDestination(page, "city");
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "New City" })
    .click();
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
});

const LIFECYCLE_PROBE: PixelProbe = { tile: { x: 1, y: 1 }, dx: 8, dy: 8 };

/** The runtime owns one WebGPU host for its whole life; the New City screen
 *  unmounts GameCanvas while the runtime stays alive, so the remounted canvas
 *  must render identically through the same device (real pixel readback). */
test("canvas keeps rendering the same scene after cancelling New City from gameplay", async ({
  page,
}) => {
  await createDefaultCity(page, "Cancel Pixels");
  await expect(
    page.locator("canvas[data-runtime-canvas='true']"),
  ).toBeVisible();

  // Park the pointer over the HUD so no hover ghost overlays the probe.
  await page.mouse.move(2, 2);
  await settleLayout(page);
  const before = await sampleTilePixels(page, [LIFECYCLE_PROBE]);
  expect(before[0]).not.toBeNull();

  await openCommandDestination(page, "city");
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "New City" })
    .click();
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.locator(".shell-error")).toHaveCount(0);

  await page.mouse.move(2, 2);
  await settleLayout(page);
  const after = await sampleTilePixels(page, [LIFECYCLE_PROBE]);
  expect(after[0]).toEqual(before[0]);
});

test("creating a second city from gameplay renders the new city", async ({
  page,
}) => {
  await createDefaultCity(page, "First Pixel City");

  await openCommandDestination(page, "city");
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "New City" })
    .click();
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  await page.getByLabel("City name").fill("Second Pixel City");
  await page.getByRole("radio", { name: "Small Town" }).check();
  await page.getByRole("button", { name: "Create City" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.locator(".shell-error")).toHaveCount(0);
  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.persistence.activeCity?.name).toBe("Second Pixel City");
  expect(snapshot.state.rules.sandbox.templateId).toBe("smallTown");

  await page.mouse.move(2, 2);
  await settleLayout(page);
  const [probe] = await sampleTilePixels(page, [LIFECYCLE_PROBE]);
  expect(probe).not.toBeNull();
});
