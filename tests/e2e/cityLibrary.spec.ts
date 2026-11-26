import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
} from "../../src/persistence/indexedDbCitySaveStore";
import {
  armOneShotCitySaveFailure,
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  hoverMapTile,
  installOneShotCitySaveFailure,
  openCommandDestination,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  settleLayout,
} from "./helpers";

const DOCK_WIDE_DATE_ROW_ID = "dock-overflow-wide";
const DOCK_LAST_ROW_ID = "dock-overflow-01";

// Minimal CitySaveRecords: the dock list reads only city metadata, never the
// snapshot, so stub snapshots are enough to exercise real overflow layout.
async function seedDockOverflowCities(page: Page): Promise<void> {
  await page.evaluate(
    async ({ databaseName, databaseVersion }) => {
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
        // Local noon keeps the wide Sep 30/12:59 label stable across timezones.
        const rows = [
          {
            id: "dock-overflow-wide",
            name: `WideDate${"w".repeat(48)}`,
            savedAt: new Date(2020, 8, 30, 12, 59).toISOString(),
          },
          ...Array.from({ length: 3 }, (_, offset) => {
            const index = offset + 1;
            const savedAt = new Date(Date.UTC(2020, 0, index)).toISOString();
            return {
              id: `dock-overflow-${String(index).padStart(2, "0")}`,
              name: `DockOverflow${"o".repeat(48)}${index}`,
              savedAt,
            };
          }),
        ];
        for (const row of rows) {
          store.put(
            {
              city: {
                id: row.id,
                name: row.name,
                createdAt: row.savedAt,
                templateId: "crossroads",
              },
              savedAt: row.savedAt,
              snapshot: {},
            },
            row.id,
          );
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    },
    {
      databaseName: DEFAULT_DATABASE_NAME,
      databaseVersion: DATABASE_VERSION,
    },
  );
}

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

  // The whitespace-only text between "Continue" and the nested name span
  // must still leave a visible separation inside the action label.
  const pixelGap = await continueButton.evaluate((button) => {
    const label = button.querySelector(".city-library-action-label")!;
    const text = Array.from(label.childNodes).find(
      (node) =>
        node.nodeType === Node.TEXT_NODE &&
        (node.textContent?.trim().length ?? 0) > 0,
    ) as Text;
    const name = button.querySelector(".city-library-continue-name")!;
    const labelRange = document.createRange();
    // Trim the trailing whitespace so the range ends at the last visible
    // glyph instead of at the space that provides the separation.
    const end = text.textContent!.search(/\s*$/);
    labelRange.setStart(text, text.textContent!.search(/\S/));
    labelRange.setEnd(text, end === -1 ? text.textContent!.length : end);
    const labelRect = labelRange.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    return nameRect.left - labelRect.right;
  });
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
  // A different template than city A's Crossroads so a defaulted or
  // misassigned templateId cannot pass the row-label checks below.
  await page.getByRole("radio", { name: "Small Town" }).check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );
  const cityBSavedAt = (await runtimeSnapshot(page)).persistence.activeCity
    ?.savedAt;
  expect(cityBSavedAt).toBeTruthy();

  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();

  // Illustrated key art and live brand on the library screen.
  await expect(library).toHaveCSS("background-image", /city-library\.webp/);
  await expect(library.getByText("Caelum", { exact: true })).toBeVisible();
  await expect(library.locator("img[src*='app-icon']")).toBeVisible();

  // Row names are visible text with a pencil-activated editor; the pencils
  // carry the unique per-city labels used to pick each row.
  await expect(
    page.getByRole("button", { name: "Rename Browser Smoke A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rename Browser Smoke B" }),
  ).toBeVisible();

  // Every row shows a colored initial avatar and its saved timestamp.
  const rowA = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("button", {
      name: "Rename Browser Smoke A",
      exact: true,
    }),
  });
  const rowB = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("button", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const rowAId = await rowA.getAttribute("data-testid");
  expect(rowAId).toMatch(/^city-row-/);
  const avatarA = page.getByTestId(rowAId!).getByTestId("city-avatar");
  await expect(avatarA).toHaveText("B");
  await expect(rowB.getByTestId("city-avatar")).toHaveText("B");
  // Each row carries its own template label: A was created on Crossroads,
  // B on Small Town, so a metadata default or wrong-row assignment fails.
  await expect(rowA.locator(".city-template")).toHaveText("Crossroads");
  await expect(rowB.locator(".city-template")).toHaveText("Small Town");
  await expect(rowA.locator("time")).toBeVisible();
  await expect(rowB.locator("time")).toBeVisible();
  // The Continue card names and timestamps the newest save — the actual
  // savedAt recorded before the reload, not just any visible time.
  const continueCard = library.getByRole("button", {
    name: /^Continue Browser Smoke B/,
  });
  await expect(continueCard.locator("time[datetime]")).toHaveAttribute(
    "datetime",
    cityBSavedAt!,
  );

  // Renaming updates the initial, but the avatar color stays derived from
  // the stable city id, not the editable name.
  const colorBeforeRename = await avatarA.evaluate(
    (element) => element.style.backgroundColor,
  );
  expect(colorBeforeRename).not.toBe("");
  await page.getByRole("button", { name: "Rename Browser Smoke A" }).click();
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
  await settleLayout(page);
  const loadedCanvasBox = await canvas.boundingBox();
  const stageBox = await page.getByTestId("game-stage").boundingBox();
  const loadedMap = (await runtimeSnapshot(page)).state.map;
  expect(loadedCanvasBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect(
    Math.abs(loadedCanvasBox!.width - stageBox!.width),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(loadedCanvasBox!.height - stageBox!.height),
  ).toBeLessThanOrEqual(1);

  // Verify the rendered frame (via debugCaptureFrame pixel sampling) and the
  // host's drawn pointer transform both reflect full-stage canonical Fit.
  await page.mouse.move(2, 2);
  const [roadPixel, grassPixel] = await sampleTilePixels(page, [
    { tile: { x: 2, y: 1 }, dx: 0, dy: 0 },
    { tile: { x: 0, y: 0 }, dx: 0, dy: 0 },
  ]);
  expect(roadPixel).not.toBeNull();
  expect(grassPixel).not.toBeNull();
  expect(roadPixel).not.toEqual(grassPixel);

  for (const corner of [
    { x: 0, y: 0 },
    { x: loadedMap.width - 1, y: loadedMap.height - 1 },
  ]) {
    await expect
      .poll(async () => {
        await hoverMapTile(canvas, corner);
        return (await runtimeSnapshot(page)).ui.hoverTile;
      })
      .toEqual(corner);
  }
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
    has: page.getByRole("button", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const deleteB = rowBPanel.getByRole("button", { name: /delete/i });
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
  const deleteActive = playingRow.getByRole("button", { name: /delete/i });
  await deleteActive.click();
  await expect(deleteActive).toHaveText("Delete?");
  await deleteActive.click();

  // Deleting the final active city lands back on New City.
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await expect(page.getByTestId("panel-city")).toHaveCount(0);
});

test("dock city rows keep long names and actions side-by-side at 1440×900 and 1280×720", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const longName = `Harbour${"x".repeat(72)}`;
  const activeRtlName = `مدينة${"م".repeat(64)}`;
  const renamedLongName = `RenamedHarbour${"y".repeat(72)}`;
  // Boot once with an empty store, seed controlled overflow rows, then let the
  // normal creation flow reopen through the library as in the overflow spec.
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await seedDockOverflowCities(page);
  await createDefaultCity(page, longName);
  // Use the dock's own New City path for the second save: it avoids a full
  // page reload while exercising the same player flow the rows live in.
  await openCommandDestination(page, "city");
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "New City" })
    .click();
  await expect(page.getByTestId("new-city-screen")).toBeVisible();
  await page.getByLabel("City name").fill(activeRtlName);
  await page.getByRole("radio", { name: "Blank Grid" }).check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await openCommandDestination(page, "city");

  const rows = page
    .getByTestId("panel-city")
    .locator("[data-testid^='city-row-']");
  const inactiveRowMatch = rows.filter({
    has: page.getByRole("button", {
      name: `Rename ${longName}`,
      exact: true,
    }),
  });
  const activeRow = rows.filter({ hasText: "Playing" });
  await expect(inactiveRowMatch).toHaveCount(1);
  await expect(activeRow).toHaveCount(1);
  const inactiveRowTestId = await inactiveRowMatch.getAttribute("data-testid");
  expect(inactiveRowTestId).toMatch(/^city-row-/);
  // The pencil disappears while its editor is open, so editor geometry uses
  // the row's stable test id rather than the rename-button-filtered locator.
  const inactiveRow = page.getByTestId(inactiveRowTestId!);
  const wideDateRow = page.getByTestId(`city-row-${DOCK_WIDE_DATE_ROW_ID}`);
  const lastRow = page.getByTestId(`city-row-${DOCK_LAST_ROW_ID}`);
  // The dock keeps active-city rename in the header: the compact Playing row
  // has no row input or rename pencil.
  await expect(activeRow.locator("input")).toHaveCount(0);
  await expect(activeRow.getByRole("button", { name: /^Rename / })).toHaveCount(
    0,
  );

  const measureRow = async (row: Locator) =>
    row.evaluate((element) => {
      const boxOf = (target: Element) => {
        const rect = target.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      const required = (selector: string): HTMLElement => {
        const found = element.querySelector<HTMLElement>(selector);
        if (found === null) {
          throw new Error(`Dock city row is missing ${selector}`);
        }
        return found;
      };
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      const textMetricsOf = (target: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(target);
        const textRects = Array.from(range.getClientRects()).filter(
          (part) => part.width > 0 && part.height > 0,
        );
        const style = getComputedStyle(target);
        return {
          ...boxOf(target),
          clientHeight: target.clientHeight,
          clientWidth: target.clientWidth,
          contentBottom:
            textRects.length === 0
              ? 0
              : Math.max(...textRects.map((part) => part.bottom)),
          contentLeft:
            textRects.length === 0
              ? 0
              : Math.min(...textRects.map((part) => part.left)),
          contentRight:
            textRects.length === 0
              ? 0
              : Math.max(...textRects.map((part) => part.right)),
          contentTop:
            textRects.length === 0
              ? 0
              : Math.min(...textRects.map((part) => part.top)),
          direction: style.direction,
          fontSize: Number.parseFloat(style.fontSize),
          lineCount: new Set(
            textRects.map((part) => Math.round(part.top * 2) / 2),
          ).size,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollHeight: target.scrollHeight,
          scrollWidth: target.scrollWidth,
          text: normalize(target.innerText),
          textOverflow: style.textOverflow,
          textRectCount: textRects.length,
          whiteSpace: style.whiteSpace,
        };
      };
      const name = element.querySelector<HTMLElement>(
        ".city-name-field .inline-name-value, .city-name-field .inline-name-input, .city-list-meta > .city-name",
      );
      if (name === null) throw new Error("Dock city row is missing its name");
      const container = element.closest(".command-panel__body");
      if (!(container instanceof HTMLElement)) {
        throw new Error("Dock city row is outside the scrolling panel body");
      }
      const actions = required(".city-list-actions");
      return {
        row: boxOf(element),
        container: boxOf(container),
        meta: boxOf(required(".city-list-meta")),
        name: textMetricsOf(name),
        template: textMetricsOf(required(".city-template")),
        saved: textMetricsOf(required(".city-list-meta > span:last-child")),
        savedTimeText: normalize(required("time").textContent ?? ""),
        actions: boxOf(actions),
        controls: Array.from(actions.children).map((control) => boxOf(control)),
      };
    });

  type RowGeometry = Awaited<ReturnType<typeof measureRow>>;
  type MetadataGeometry = RowGeometry["saved"];

  const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
  const expectMetadataFullyRendered = (
    metadata: MetadataGeometry,
    part: string,
    expectedText: string,
    where: string,
  ) => {
    expect(metadata.text, `${where} ${part} renders its complete text`).toBe(
      normalizeText(expectedText),
    );
    expect(
      metadata.fontSize,
      `${where} ${part} stays readable`,
    ).toBeGreaterThanOrEqual(11);
    expect(metadata.whiteSpace, `${where} ${part} is allowed to wrap`).toBe(
      "normal",
    );
    expect(metadata.textOverflow, `${where} ${part} does not ellipsize`).toBe(
      "clip",
    );
    expect(
      metadata.scrollWidth,
      `${where} ${part} has no horizontal overflow`,
    ).toBeLessThanOrEqual(metadata.clientWidth + 1);
    expect(
      metadata.scrollHeight,
      `${where} ${part} has no vertical overflow`,
    ).toBeLessThanOrEqual(metadata.clientHeight + 1);
    expect(
      metadata.textRectCount,
      `${where} ${part} produces rendered text boxes`,
    ).toBeGreaterThan(0);
    expect(
      metadata.contentLeft,
      `${where} ${part} text starts inside its box`,
    ).toBeGreaterThanOrEqual(metadata.left - 1);
    expect(
      metadata.contentRight,
      `${where} ${part} text ends inside its box`,
    ).toBeLessThanOrEqual(metadata.right + 1);
    expect(
      metadata.contentTop,
      `${where} ${part} text starts below its top`,
    ).toBeGreaterThanOrEqual(metadata.top - 1);
    expect(
      metadata.contentBottom,
      `${where} ${part} text ends above its bottom`,
    ).toBeLessThanOrEqual(metadata.bottom + 1);
  };

  const expectRowGeometry = async (
    label: "active" | "inactive",
    row: Locator,
    viewport: { width: number; height: number },
    state = "",
  ) => {
    await row.scrollIntoViewIfNeeded();
    const geometry = await measureRow(row);
    const where = `${label} row${state} at ${viewport.width}x${viewport.height}`;

    expect(
      geometry.row.height,
      `${where} stays compact while allowing wrapped metadata`,
    ).toBeLessThanOrEqual(88);
    expect(
      geometry.row.left,
      `${where} stays inside the panel on the left`,
    ).toBeGreaterThanOrEqual(geometry.container.left - 1);
    expect(
      geometry.row.right,
      `${where} stays inside the panel on the right`,
    ).toBeLessThanOrEqual(geometry.container.right + 1);
    expect(
      geometry.actions.right,
      `${where} actions stay inside the row`,
    ).toBeLessThanOrEqual(geometry.row.right + 1);
    expect(
      geometry.actions.top,
      `${where} actions start inside the row`,
    ).toBeGreaterThanOrEqual(geometry.row.top - 1);
    expect(
      geometry.actions.bottom,
      `${where} actions end inside the row`,
    ).toBeLessThanOrEqual(geometry.row.bottom + 1);
    expect(
      geometry.meta.right,
      `${where} metadata ends before the actions`,
    ).toBeLessThanOrEqual(geometry.actions.left + 1);

    for (const [part, box] of [
      ["name", geometry.name],
      ["template", geometry.template],
      ["saved time", geometry.saved],
    ] as const) {
      expect(box.width, `${where} ${part} remains visible`).toBeGreaterThan(0);
      expect(box.height, `${where} ${part} remains visible`).toBeGreaterThan(0);
      expect(
        box.right,
        `${where} ${part} does not overlap the actions`,
      ).toBeLessThanOrEqual(geometry.actions.left + 1);
    }

    expect(geometry.name.textOverflow, `${where} long name uses ellipsis`).toBe(
      "ellipsis",
    );
    expect(
      geometry.name.whiteSpace,
      `${where} long name stays on one line`,
    ).toBe("nowrap");
    expect(
      geometry.name.overflowX,
      `${where} long name clips its overflow`,
    ).toBe("hidden");
    expect(
      geometry.name.scrollWidth,
      `${where} long name actually overflows before ellipsizing`,
    ).toBeGreaterThan(geometry.name.clientWidth + 1);
    expect(
      geometry.name.direction,
      `${where} name uses its text direction for truncation`,
    ).toBe(label === "active" ? "rtl" : "ltr");
    if (label === "active") {
      expect(
        Math.abs(geometry.name.contentRight - geometry.name.right),
        `${where} RTL name keeps its inline start at the right edge`,
      ).toBeLessThanOrEqual(2);
      expect(
        geometry.name.contentLeft,
        `${where} RTL name truncates toward the left end`,
      ).toBeLessThan(geometry.name.left - 8);
    } else {
      expect(
        Math.abs(geometry.name.contentLeft - geometry.name.left),
        `${where} LTR name keeps its inline start at the left edge`,
      ).toBeLessThanOrEqual(2);
      expect(
        geometry.name.contentRight,
        `${where} LTR name truncates toward the right end`,
      ).toBeGreaterThan(geometry.name.right + 8);
    }

    expectMetadataFullyRendered(
      geometry.template,
      "template",
      label === "active" ? "Blank Grid" : "Crossroads",
      where,
    );
    expectMetadataFullyRendered(
      geometry.saved,
      "saved time",
      `Saved ${geometry.savedTimeText}`,
      where,
    );

    expect(
      geometry.controls.length,
      `${where} keeps Playing/Delete or Load/Delete`,
    ).toBe(2);
    const [leadingControl, trailingControl] = geometry.controls;
    expect(
      leadingControl.right,
      `${where} action controls stay side-by-side horizontally`,
    ).toBeLessThanOrEqual(trailingControl.left + 1);
    const verticalOverlap =
      Math.min(leadingControl.bottom, trailingControl.bottom) -
      Math.max(leadingControl.top, trailingControl.top);
    expect(
      verticalOverlap,
      `${where} action controls share the same row`,
    ).toBeGreaterThan(0);
    for (const control of geometry.controls) {
      expect(
        control.left,
        `${where} action controls stay horizontally reachable`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        control.right,
        `${where} action controls stay horizontally reachable`,
      ).toBeLessThanOrEqual(viewport.width + 1);
      expect(
        control.top,
        `${where} action controls stay vertically reachable`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        control.bottom,
        `${where} action controls stay vertically reachable`,
      ).toBeLessThanOrEqual(viewport.height + 1);
    }
    return geometry;
  };

  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await settleLayout(page);

    for (const [label, row] of [
      ["active", activeRow],
      ["inactive", inactiveRow],
    ] as const) {
      await expectRowGeometry(label, row, viewport);
    }

    if (viewport.width === 1280) {
      const wideGeometry = await expectRowGeometry(
        "inactive",
        wideDateRow,
        viewport,
        " with a controlled wide date",
      );
      expect(
        wideGeometry.saved.lineCount,
        "controlled wide saved date wraps instead of clipping at 1280x720",
      ).toBeGreaterThan(1);
    }

    // Opening the long inactive row's editor must not push the input under
    // Load/Delete or clip its metadata; Escape restores focus to the pencil.
    const renamePencil = inactiveRow.getByRole("button", {
      name: `Rename ${longName}`,
      exact: true,
    });
    await expect(renamePencil).toBeVisible();
    await renamePencil.focus();
    await expect(renamePencil).toBeFocused();
    await renamePencil.press("Enter");
    const editor = inactiveRow.getByRole("textbox", {
      name: `Rename ${longName}`,
      exact: true,
    });
    await expect(editor).toBeFocused();
    const editorGeometry = await measureRow(inactiveRow);
    const editorWhere = `inactive row with its rename editor open at ${viewport.width}x${viewport.height}`;
    expectMetadataFullyRendered(
      editorGeometry.template,
      "template",
      "Crossroads",
      editorWhere,
    );
    expectMetadataFullyRendered(
      editorGeometry.saved,
      "saved time",
      `Saved ${editorGeometry.savedTimeText}`,
      editorWhere,
    );
    const [editorBox, actionsBox, rowBox] = await Promise.all([
      editor.boundingBox(),
      inactiveRow.locator(".city-list-actions").boundingBox(),
      inactiveRow.boundingBox(),
    ]);
    expect(editorBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(
      editorBox!.width,
      `long-name editor at ${viewport.width}x${viewport.height} remains usable`,
    ).toBeGreaterThan(40);
    expect(
      editorBox!.x + editorBox!.width,
      `long-name editor at ${viewport.width}x${viewport.height} does not overlap the actions`,
    ).toBeLessThanOrEqual(actionsBox!.x + 1);
    expect(
      actionsBox!.x + actionsBox!.width,
      `long-name editor actions at ${viewport.width}x${viewport.height} stay inside the row`,
    ).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
    await editor.press("Escape");
    await expect(inactiveRow.locator(".inline-name-input")).toHaveCount(0);
    await expect(renamePencil).toBeFocused();
  }

  // The loop ends at 1280x720. Use real wheel input over the dock: hidden
  // overflow cannot fake a changed scroll position.
  const panelBody = page.locator(".command-panel__body");
  await expect(panelBody).toBeVisible();
  await expect(rows.last()).toHaveAttribute(
    "data-testid",
    `city-row-${DOCK_LAST_ROW_ID}`,
  );
  expect(
    await panelBody.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const panelBox = await panelBody.boundingBox();
  expect(panelBox).not.toBeNull();
  await page.mouse.move(
    panelBox!.x + panelBox!.width / 2,
    panelBox!.y + panelBox!.height / 2,
  );
  const initialScrollTop = await panelBody.evaluate(
    (element) => element.scrollTop,
  );
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 700);
      return panelBody.evaluate((element) => element.scrollTop);
    })
    .toBeGreaterThan(initialScrollTop);
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 700);
      return panelBody.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      );
    })
    .toBe(true);

  await expect(lastRow).toBeVisible();
  const actionButtons = await lastRow
    .locator(".city-list-actions button")
    .all();
  expect(actionButtons).toHaveLength(2);
  for (const button of actionButtons) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(panelBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      panelBox!.x + panelBox!.width,
    );
    expect(box!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      panelBox!.y + panelBox!.height,
    );
  }
  for (const button of actionButtons) {
    await button.focus();
    await expect(button).toBeFocused();
  }

  // A committed rename replaces the long inline value in place. Re-check both
  // rows at both sizes so metadata cannot regress only after that state.
  await inactiveRow
    .getByRole("button", { name: `Rename ${longName}`, exact: true })
    .click();
  const renameEditor = inactiveRow.getByRole("textbox", {
    name: `Rename ${longName}`,
    exact: true,
  });
  await expect(renameEditor).toBeFocused();
  await renameEditor.fill(renamedLongName);
  await renameEditor.press("Enter");
  await expect(
    inactiveRow.getByRole("button", {
      name: `Rename ${renamedLongName}`,
      exact: true,
    }),
  ).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await settleLayout(page);
    for (const [label, row] of [
      ["active", activeRow],
      ["inactive", inactiveRow],
    ] as const) {
      await expectRowGeometry(label, row, viewport, " after rename");
    }
  }
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

test("a Load click commits the typed row rename before loading the city", async ({
  page,
}) => {
  await createDefaultCity(page, "Dockside");
  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();
  await page.getByRole("button", { name: "Rename Dockside" }).click();
  const rename = page.getByRole("textbox", { name: "Rename Dockside" });
  await rename.fill("Harbour Reef");

  // The press keeps focus on the input (mousedown is suppressed), so the
  // Load click itself must commit the pending name before the city opens —
  // not drop it with the library.
  await page.getByRole("button", { name: "Load Dockside" }).click();
  await expect(page.getByTestId("topbar-city-name")).toHaveText("Harbour Reef");
});
