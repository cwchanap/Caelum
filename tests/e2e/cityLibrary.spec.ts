import { expect, test } from "@playwright/test";
import { fitScale } from "../../src/render/boardTransform";
import {
  armOneShotCitySaveFailure,
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  installOneShotCitySaveFailure,
  mapBoardScale,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

test("a very long unbroken city name ellipsizes inside the Continue button", async ({
  page,
}) => {
  await createDefaultCity(page, "A".repeat(80));
  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();
  const card = library.locator(".city-library-card");
  const continueButton = library.getByRole("button", { name: /Continue/ });
  await expect(continueButton).toBeVisible();

  // The button stays inside the card and clips the unbroken name instead of
  // overflowing it.
  const cardBox = await card.boundingBox();
  const buttonBox = await continueButton.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
    cardBox!.x + cardBox!.width + 1,
  );
  expect(
    await continueButton.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
});

test("Continue button keeps visible space between the label and the city name", async ({
  page,
}) => {
  await createDefaultCity(page);
  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();
  const continueButton = library.getByRole("button", { name: /Continue/ });
  await expect(continueButton).toBeVisible();

  // The flex container drops the whitespace-only text between "Continue"
  // and the name span, so the visible separation must come from the gap.
  const { computedGap, pixelGap } = await continueButton.evaluate((button) => {
    const label = Array.from(button.childNodes).find(
      (node) =>
        node.nodeType === Node.TEXT_NODE &&
        (node.textContent?.trim().length ?? 0) > 0,
    ) as Text;
    const name = button.querySelector(".city-library-continue-name")!;
    const labelRange = document.createRange();
    labelRange.selectNodeContents(label);
    const labelRect = labelRange.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    return {
      computedGap: parseFloat(getComputedStyle(button).columnGap),
      pixelGap: nameRect.left - labelRect.right,
    };
  });
  expect(computedGap).toBeGreaterThanOrEqual(4);
  expect(pixelGap).toBeGreaterThanOrEqual(2);
});

test("Save Now persists changed gameplay through reload and Continue", async ({
  page,
}) => {
  await createDefaultCity(page, "Browser Smoke A");

  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 6, y: 1 });

  await selectBuildLeaf(page, "buildings", "smallHouse");
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$116,000")).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 1 });
  await expect(topbar.getByText("$115,700")).toBeVisible();

  const timeReadout = topbar.locator(".readout", { hasText: "Time" });
  const clockValue = timeReadout.locator(".readout-value");

  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(async () => (await clockValue.textContent())?.trim() ?? "")
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  const beforeSave = (await runtimeSnapshot(page)).state;
  const savedTime = beforeSave.time;
  expect(savedTime).toBeGreaterThan(0);
  expect(beforeSave.budget).toBe(115_700);

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");

  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );

  await cityPanel.getByRole("button", { name: "New City" }).click();
  await page.getByLabel("City name").fill("Browser Smoke B");
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();

  // Illustrated key art and live brand on the library screen.
  await expect(library).toHaveCSS("background-image", /city-library\.webp/);
  await expect(library.getByText("Caelum", { exact: true })).toBeVisible();
  await expect(library.locator("img[src*='app-icon']")).toBeVisible();

  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
  ).toBeVisible();

  // Every row shows a colored initial avatar and its saved timestamp. City
  // names live only in the rename textbox's accessible name, never as row
  // text, so rows must be selected by that descendant textbox.
  const rowA = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke A",
      exact: true,
    }),
  });
  const rowB = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const rowAId = await rowA.getAttribute("data-testid");
  expect(rowAId).toMatch(/^city-row-/);
  const avatarA = page.getByTestId(rowAId!).getByTestId("city-avatar");
  await expect(avatarA).toHaveText("B");
  await expect(rowB.getByTestId("city-avatar")).toHaveText("B");
  await expect(rowA.locator("time")).toBeVisible();
  await expect(rowB.locator("time")).toBeVisible();

  // Renaming updates the initial, but the avatar color stays derived from
  // the stable city id, not the editable name.
  const colorBeforeRename = await avatarA.evaluate(
    (element) => element.style.backgroundColor,
  );
  expect(colorBeforeRename).not.toBe("");
  const renameA = page.getByRole("textbox", { name: "Rename Browser Smoke A" });
  await renameA.fill("Zephyr Smoke");
  await renameA.press("Enter");
  await expect(avatarA).toHaveText("Z");
  expect(
    await avatarA.evaluate((element) => element.style.backgroundColor),
  ).toBe(colorBeforeRename);

  // Continue names the actual newest saved city; the two saved cities keep
  // distinct names so a hard-coded label cannot pass.
  await page.getByRole("button", { name: "Continue Browser Smoke B" }).click();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  await page.getByRole("button", { name: "Load Zephyr Smoke" }).click();
  await expect
    .poll(async () => {
      const current = await runtimeSnapshot(page);
      return {
        activeCity: current.persistence.activeCity?.name ?? null,
        busy: current.persistence.busy,
        activeCommandDestination: current.ui.activeCommandDestination,
        camera: current.camera,
      };
    })
    .toEqual({
      activeCity: "Zephyr Smoke",
      busy: false,
      activeCommandDestination: null,
      camera: null,
    });
  // Loading from the open City dock closes the dock and remounts the canvas
  // so the loaded map opens at canonical Fit for the full stage.
  await expect(page.getByTestId("workspace-dock")).toHaveCount(0);
  const loadedCanvasBox = await canvas.boundingBox();
  const loadedMap = (await runtimeSnapshot(page)).state.map;
  expect(loadedCanvasBox).not.toBeNull();
  expect(await mapBoardScale(canvas)).toBeCloseTo(
    fitScale(loadedCanvasBox!, loadedMap),
    6,
  );
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText("Zephyr Smoke");

  const restoredA = (await runtimeSnapshot(page)).state;
  const tileAt = (x: number, y: number) =>
    restoredA.map.tiles.find((tile) => tile.x === x && tile.y === y);

  expect(tileAt(1, 1)?.kind).toBe("road");
  expect(tileAt(2, 1)?.kind).toBe("road");
  expect(tileAt(3, 1)?.kind).toBe("road");
  expect([...(tileAt(2, 1)?.roadConnections ?? [])].sort()).toEqual([
    "east",
    "west",
  ]);

  expect(tileAt(5, 1)?.area).toBe("residential");
  expect(
    restoredA.buildings.some(
      (building) =>
        building.type === "smallHouse" &&
        building.origin.x === 5 &&
        building.origin.y === 1,
    ),
  ).toBe(true);

  expect(restoredA.budget).toBe(115_700);
  expect(restoredA.time).toBe(savedTime);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 2 }, { x: 3, y: 2 });
  await expect(page.getByTestId("topbar").getByText("$115,400")).toBeVisible();

  const continued = (await runtimeSnapshot(page)).state;
  const continuedTileAt = (x: number, y: number) =>
    continued.map.tiles.find((tile) => tile.x === x && tile.y === y);
  expect(continuedTileAt(1, 1)?.roadConnections).toContain("south");
  expect(continuedTileAt(1, 2)?.roadConnections).toContain("north");

  // Confirmed two-click Delete removes the other saved city from the list.
  await openCommandDestination(page, "city");
  const rowBPanel = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const deleteB = rowBPanel.getByRole("button", { name: "Delete" });
  await deleteB.click();
  await expect(deleteB).toHaveText("Delete?");
  await deleteB.click();
  await expect(rowBPanel).toHaveCount(0);
});

test("renames the active city from the City dock and deletes it with two clicks", async ({
  page,
}) => {
  await createDefaultCity(page, "Dock Rename City");
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Dock Rename City",
  );

  // The header pencil is the only active-city rename control in the dock.
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "Rename Dock Rename City" })
    .click();
  const renameInput = page.getByTestId("active-city-name");
  await expect(renameInput).toBeFocused();
  await renameInput.fill("Renamed From Dock");
  await renameInput.press("Enter");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Renamed From Dock",
  );

  // The active row in Your cities is a read-only Playing row whose Delete
  // stays available: it is the only in-game path to remove the last city.
  const playingRow = page
    .locator("[data-testid^='city-row-']")
    .filter({ hasText: "Playing" });
  await expect(playingRow).toHaveCount(1);
  await expect(playingRow.locator("input")).toHaveCount(0);
  const deleteActive = playingRow.getByRole("button", { name: "Delete" });
  await deleteActive.click();
  await expect(deleteActive).toHaveText("Delete?");
  await deleteActive.click();

  // Deleting the final active city lands back on New City.
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await expect(page.getByTestId("panel-city")).toHaveCount(0);
});

test("autosaves a paused city through reload and skips a clean city", async ({
  page,
  context,
}) => {
  // Two real autosave intervals are observed in parallel: the primary page
  // saves a dirty paused city while a second paused, clean city must write
  // nothing. Fake timers are not installed, so the WebGPU rAF loop and the
  // real IndexedDB store keep their production behavior.
  test.setTimeout(120_000);

  const witness = await context.newPage();
  await createDefaultCity(witness, "Autosave Witness");
  const witnessBefore = await runtimeSnapshot(witness);
  const witnessSavedAt = witnessBefore.persistence.activeCity?.savedAt;
  expect(witnessBefore.state.paused).toBe(true);
  expect(witnessBefore.persistence.dirty).toBe(false);
  expect(witnessSavedAt).toBeTruthy();

  await createDefaultCity(page, "Autosave Crossroads");
  // The dirty primary page owns the foreground interval; the clean witness
  // still receives its 60s callback while backgrounded.
  await page.bringToFront();
  const created = await runtimeSnapshot(page);
  const createdSavedAt = created.persistence.activeCity?.savedAt;
  expect(created.state.paused).toBe(true);
  expect(createdSavedAt).toBeTruthy();

  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 2, y: 2 }, { x: 4, y: 2 });
  const status = page.getByTestId("topbar-save-status");
  await expect(status).toHaveAttribute("data-dirty", "true");

  // One eligible 60s autosave tick persists the paused change.
  await expect(status).toHaveAttribute("data-dirty", "false", {
    timeout: 70_000,
  });
  await expect(status).toHaveText(/^Saved \d+ (s|min) ago$/);
  await expect(status.getByRole("button", { name: "Retry" })).toHaveCount(0);
  const autosaved = await runtimeSnapshot(page);
  expect(autosaved.persistence.dirty).toBe(false);
  expect(autosaved.persistence.save).toBe("idle");
  expect(autosaved.persistence.activeCity?.savedAt).not.toBe(createdSavedAt);

  // Allow a hidden-tab timer clamp before reading the witness: by now its own
  // interval has fired and skipped the clean city at least once.
  await page.waitForTimeout(3_000);
  const witnessAfter = await runtimeSnapshot(witness);
  expect(witnessAfter.persistence.activeCity?.savedAt).toBe(witnessSavedAt);
  expect(witnessAfter.persistence.dirty).toBe(false);
  expect(witnessAfter.persistence.save).toBe("idle");
  await witness.close();

  await page.reload();
  await page
    .getByRole("button", { name: "Continue Autosave Crossroads" })
    .click();
  await expect(page.getByTestId("topbar-city-name")).toHaveText(
    "Autosave Crossroads",
  );
  const restored = (await runtimeSnapshot(page)).state;
  for (const x of [2, 3, 4]) {
    expect(
      restored.map.tiles.find((tile) => tile.x === x && tile.y === 2)?.kind,
    ).toBe("road");
  }

  // Manual Save still works after an autosave, and both roads survive reload.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 2, y: 4 }, { x: 4, y: 4 });
  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );

  await page.reload();
  await page
    .getByRole("button", { name: "Continue Autosave Crossroads" })
    .click();
  await expect(page.getByTestId("topbar-city-name")).toHaveText(
    "Autosave Crossroads",
  );
  const manual = (await runtimeSnapshot(page)).state;
  for (const x of [2, 3, 4]) {
    expect(
      manual.map.tiles.find((tile) => tile.x === x && tile.y === 2)?.kind,
    ).toBe("road");
    expect(
      manual.map.tiles.find((tile) => tile.x === x && tile.y === 4)?.kind,
    ).toBe("road");
  }
});

test("a real failed save keeps dirty and one keyboard Retry recovers", async ({
  page,
}) => {
  await installOneShotCitySaveFailure(page);
  await createDefaultCity(page, "Retry Crossroads");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 7, y: 2 }, { x: 9, y: 2 });

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  const status = page.getByTestId("topbar-save-status");
  await expect(status).toHaveAttribute("data-dirty", "true");

  // The first armed city-store put throws; every later write is real.
  await armOneShotCitySaveFailure(page);
  await cityPanel.getByRole("button", { name: "Save Now" }).click();

  await expect(status).toHaveText(/^Couldn't save\u00a0· Retry$/);
  await expect(status).toHaveAttribute("data-dirty", "true");
  await expect(cityPanel.getByTestId("city-save-status")).toHaveText(
    "Couldn't save",
  );
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(1);
  await expect(
    cityPanel.getByRole("button", { name: "Save Now" }),
  ).toBeVisible();
  await expect(
    cityPanel.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);

  const retry = status.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeEnabled();
  await retry.focus();
  expect(
    await retry.evaluate((element) => element === document.activeElement),
  ).toBe(true);
  expect(
    await retry.evaluate((element) => (element as HTMLButtonElement).tabIndex),
  ).toBe(0);
  await retry.press("Enter");

  await expect(status).toHaveAttribute("data-dirty", "false");
  await expect(status).toHaveText(/^Saved \d+ (s|min) ago$/);
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Continue Retry Crossroads" }).click();
  await expect(page.getByTestId("topbar-city-name")).toHaveText(
    "Retry Crossroads",
  );
  const restored = (await runtimeSnapshot(page)).state;
  for (const x of [7, 8, 9]) {
    expect(
      restored.map.tiles.find((tile) => tile.x === x && tile.y === 2)?.kind,
    ).toBe("road");
  }
});
