import { expect, test } from "@playwright/test";
import { HUD_INSET } from "../../src/render/boardTransform";
import {
  armOneShotCitySaveFailure,
  createDefaultCity,
  debugSetBudget,
  dragMapTiles,
  installOneShotCitySaveFailure,
  openCommandDestination,
  selectBuildLeaf,
  settleLayout,
} from "./helpers";

const viewports = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

const LONG_CITY_NAME =
  "Harbour-on-the-Long-Estuary Metropolitan Transport Authority";

interface ClusterBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RetryGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  focusable: boolean;
  tabIndex: number;
  disabled: boolean;
  clipped: boolean;
}

interface TopbarGeometry {
  city: ClusterBox;
  clock: ClusterBox;
  stats: ClusterBox;
  clockCenterX: number;
  topbarCenterX: number;
  readouts: Array<{
    label?: string;
    value?: string;
    left: number;
    right: number;
    clipped: boolean;
  }>;
  cityNameWidth: number;
  cityNameRight: number;
  cityNameTitle: string | null;
  saveStatus: string | null;
  saveChip: ClusterBox & { dirty: string | null; busy: string | null };
  retry: RetryGeometry | null;
}

async function topbarGeometry(
  page: import("@playwright/test").Page,
): Promise<TopbarGeometry> {
  return page.evaluate(() => {
    const topbar = document.querySelector<HTMLElement>(
      '[data-testid="topbar"]',
    );
    if (topbar === null) throw new Error("Topbar is missing");

    const clusterBox = (selector: string): ClusterBox => {
      const cluster = topbar.querySelector<HTMLElement>(selector);
      if (cluster === null) {
        throw new Error(`Topbar cluster ${selector} is missing`);
      }
      const box = cluster.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    };

    const readouts = Array.from(
      topbar.querySelectorAll<HTMLElement>(".topbar-cluster--stats .readout"),
    )
      .filter((readout) => getComputedStyle(readout).display !== "none")
      .map((readout) => {
        const value = readout.querySelector<HTMLElement>(".readout-value");
        if (value === null) {
          throw new Error(
            `Readout is missing a .readout-value child: ${readout.outerHTML}`,
          );
        }
        const box = readout.getBoundingClientRect();
        return {
          label: readout
            .querySelector<HTMLElement>(".readout-label")
            ?.textContent?.trim(),
          value: value.textContent?.trim(),
          left: box.left,
          right: box.right,
          clipped: value.scrollWidth > value.clientWidth + 1,
        };
      });

    const cityName = topbar.querySelector<HTMLElement>(
      '[data-testid="topbar-city-name"]',
    );
    if (cityName === null) throw new Error("City name readout is missing");
    const cityNameBox = cityName.getBoundingClientRect();

    const saveChip = topbar.querySelector<HTMLElement>(
      '[data-testid="topbar-save-status"]',
    );
    if (saveChip === null) throw new Error("Save status chip is missing");
    const saveChipBox = saveChip.getBoundingClientRect();
    const retryButton = saveChip.querySelector<HTMLButtonElement>("button");
    const retryBox = retryButton?.getBoundingClientRect() ?? null;

    const topbarBox = topbar.getBoundingClientRect();
    const clockBox = topbar
      .querySelector<HTMLElement>(".topbar-cluster--clock")
      ?.getBoundingClientRect();
    if (clockBox === undefined) throw new Error("Clock cluster is missing");

    return {
      city: clusterBox(".topbar-cluster--city"),
      clock: clusterBox(".topbar-cluster--clock"),
      stats: clusterBox(".topbar-cluster--stats"),
      clockCenterX: clockBox.left + clockBox.width / 2,
      topbarCenterX: topbarBox.left + topbarBox.width / 2,
      readouts,
      cityNameWidth: cityNameBox.width,
      cityNameRight: cityNameBox.right,
      cityNameTitle: cityName.getAttribute("title"),
      saveStatus: saveChip.textContent?.trim().replace(/\s+/g, " ") ?? null,
      saveChip: {
        left: saveChipBox.left,
        right: saveChipBox.right,
        top: saveChipBox.top,
        bottom: saveChipBox.bottom,
        dirty: saveChip.dataset.dirty ?? null,
        busy: saveChip.dataset.busy ?? null,
      },
      retry:
        retryButton === null || retryBox === null
          ? null
          : {
              left: retryBox.left,
              right: retryBox.right,
              top: retryBox.top,
              bottom: retryBox.bottom,
              width: retryBox.width,
              height: retryBox.height,
              focusable: retryButton.tabIndex >= 0 && !retryButton.disabled,
              tabIndex: retryButton.tabIndex,
              disabled: retryButton.disabled,
              clipped:
                retryButton.scrollWidth > retryButton.clientWidth + 1 ||
                retryButton.scrollHeight > retryButton.clientHeight + 1,
            },
    };
  });
}

async function applyLongValueFixture(
  page: import("@playwright/test").Page,
): Promise<void> {
  await debugSetBudget(page, -120_000);
  await expect(page.getByTestId("topbar").getByText("$-120,000")).toBeVisible();
  await page.evaluate(() => {
    const readout = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="topbar"] .readout'),
    ).find(
      (candidate) =>
        candidate.querySelector<HTMLElement>(".readout-label")?.textContent ===
        "Daily cost",
    );
    const value = readout?.querySelector<HTMLElement>(".readout-value");
    if (value === undefined || value === null) {
      throw new Error("Daily cost readout is missing");
    }
    value.textContent = "$20,000";
  });
  await expect(page.getByTestId("topbar").getByText("$20,000")).toBeVisible();
}

async function applyDirtyFixture(
  page: import("@playwright/test").Page,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 2, y: 14 }, { x: 5, y: 14 });
  await expect(page.getByTestId("topbar-save-status")).toHaveAttribute(
    "data-dirty",
    "true",
  );
  await expect(page.getByTestId("topbar-save-status")).toHaveText(
    /^Saved \d+ (s|min) ago$/,
  );
}

async function injectTripWarningChip(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    const stats = document.querySelector<HTMLElement>(
      '[data-testid="topbar"] .topbar-cluster--stats',
    );
    if (stats === null) throw new Error("Stats cluster is missing");
    if (stats.querySelector('[data-testid="topbar-trip-issues"]') === null) {
      const chip = document.createElement("span");
      chip.className = "chip topbar-trip-issues";
      chip.dataset.testid = "topbar-trip-issues";
      chip.title = "3000 late · 1000 unserved";
      chip.textContent = "3000 late · 1000 unserved";
      stats.appendChild(chip);
    }
  });
  await expect(page.getByTestId("topbar-trip-issues")).toBeVisible();
}

function collectOverlapFailures(
  viewport: (typeof viewports)[number],
  geometry: TopbarGeometry,
): string[] {
  const failures: string[] = [];
  if (geometry.city.right > geometry.clock.left + 1) {
    failures.push(
      `${viewport.width}px city cluster overlaps clock cluster: ${JSON.stringify(geometry)}`,
    );
  }
  if (geometry.clock.right > geometry.stats.left + 1) {
    failures.push(
      `${viewport.width}px clock cluster overlaps stats cluster: ${JSON.stringify(geometry)}`,
    );
  }
  if (geometry.cityNameRight > geometry.city.right + 1) {
    failures.push(
      `${viewport.width}px city name overflows the city cluster: ${JSON.stringify(geometry)}`,
    );
  }
  for (const readout of geometry.readouts) {
    if (readout.clipped === true) {
      failures.push(
        `${viewport.width}px ${readout.label} value ${readout.value} is clipped: ${JSON.stringify(geometry)}`,
      );
    }
  }

  const lastReadout = geometry.readouts.at(-1);
  if (lastReadout === undefined) throw new Error("No visible topbar readouts");
  if (lastReadout.right > geometry.stats.right + 1) {
    failures.push(
      `${viewport.width}px last readout overflows the stats cluster: ${JSON.stringify(geometry)}`,
    );
  }

  for (const [name, box] of [
    ["city", geometry.city],
    ["clock", geometry.clock],
    ["stats", geometry.stats],
  ] as const) {
    if (box.top < -1 || box.bottom > HUD_INSET.top + 1) {
      failures.push(
        `${viewport.width}px ${name} cluster leaves the top HUD band: ${JSON.stringify(geometry)}`,
      );
    }
  }
  return failures;
}

function collectCenteringFailures(
  viewport: (typeof viewports)[number],
  geometry: TopbarGeometry,
  label: string,
): string[] {
  const offset = geometry.clockCenterX - geometry.topbarCenterX;
  if (Math.abs(offset) > 1) {
    return [
      `${viewport.width}px ${label} clock cluster is off-centre by ${offset.toFixed(2)}px: ${JSON.stringify(geometry)}`,
    ];
  }
  return [];
}

function collectRetryFailures(
  viewport: (typeof viewports)[number],
  geometry: TopbarGeometry,
): string[] {
  const failures = collectOverlapFailures(viewport, geometry);
  const chip = geometry.saveChip;
  const retry = geometry.retry;
  if (
    geometry.saveStatus === null ||
    !/^Couldn't save · Retry$/.test(geometry.saveStatus)
  ) {
    failures.push(
      `${viewport.width}px failed chip text is not the real Retry composition: ${JSON.stringify(geometry)}`,
    );
  }
  if (chip.dirty !== "true") {
    failures.push(
      `${viewport.width}px failed chip no longer reports dirty: ${JSON.stringify(geometry)}`,
    );
  }
  if (retry === null) {
    failures.push(
      `${viewport.width}px failed chip has no real Retry button: ${JSON.stringify(geometry)}`,
    );
    return failures;
  }
  if (!retry.focusable) {
    failures.push(
      `${viewport.width}px Retry is not keyboard-focusable: ${JSON.stringify(geometry)}`,
    );
  }
  if (retry.clipped || retry.width <= 0 || retry.height <= 0) {
    failures.push(
      `${viewport.width}px Retry is clipped: ${JSON.stringify(geometry)}`,
    );
  }
  if (
    chip.left < geometry.city.left - 1 ||
    chip.right > geometry.city.right + 1 ||
    chip.top < -1 ||
    chip.bottom > HUD_INSET.top + 1
  ) {
    failures.push(
      `${viewport.width}px save chip leaves the city cluster or HUD band: ${JSON.stringify(geometry)}`,
    );
  }
  if (
    retry.left < chip.left - 1 ||
    retry.right > chip.right + 1 ||
    retry.top < chip.top - 1 ||
    retry.bottom > chip.bottom + 1
  ) {
    failures.push(
      `${viewport.width}px Retry leaves the save chip: ${JSON.stringify(geometry)}`,
    );
  }
  if (
    retry.left < -1 ||
    retry.right > viewport.width + 1 ||
    retry.top < -1 ||
    retry.bottom > viewport.height + 1
  ) {
    failures.push(
      `${viewport.width}px Retry leaves the viewport: ${JSON.stringify(geometry)}`,
    );
  }
  return failures;
}

interface ShelfBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface ShelfGeometry {
  topbar: ShelfBox;
  stage: ShelfBox;
  shelf: ShelfBox;
  dock: ShelfBox;
  buttons: Array<{ id: string; box: ShelfBox; clipped: boolean }>;
  shelfClipped: boolean;
}

function boxesOverlap(a: ShelfBox, b: ShelfBox): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

async function shelfGeometry(
  page: import("@playwright/test").Page,
): Promise<ShelfGeometry> {
  return page.evaluate(() => {
    const boxOf = (element: Element): ShelfBox => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error(`${selector} is missing`);
      return element;
    };

    const shelf = required('[data-testid="command-shelf"]');
    return {
      topbar: boxOf(required('[data-testid="topbar"]')),
      stage: boxOf(required('canvas[data-runtime-canvas="true"]')),
      shelf: boxOf(shelf),
      dock: boxOf(required('[data-testid="workspace-dock"]')),
      buttons: Array.from(shelf.querySelectorAll("button")).map((button) => ({
        id:
          button.dataset.testid ?? button.textContent?.trim() ?? "shelf button",
        box: boxOf(button),
        clipped:
          button.scrollWidth > button.clientWidth + 1 ||
          button.scrollHeight > button.clientHeight + 1,
      })),
      shelfClipped:
        shelf.scrollWidth > shelf.clientWidth + 1 ||
        shelf.scrollHeight > shelf.clientHeight + 1,
    };
  });
}

test("shelf buttons stay unclipped inside the map column and clear of the open dock", async ({
  page,
}) => {
  const failures: string[] = [];

  for (const viewport of viewports.filter(
    (candidate) => candidate.width === 1024 || candidate.width === 1440,
  )) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page);
    await openCommandDestination(page, "build");
    await settleLayout(page);
    await page.getByTestId("topbar").evaluate(async (topbar) => {
      await Promise.all(
        topbar
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });

    const geometry = await shelfGeometry(page);
    const { stage, shelf, dock, topbar } = geometry;
    if (stage.right > dock.left + 1) {
      failures.push(
        `${viewport.width}px canvas overlaps the dock: ${JSON.stringify(geometry)}`,
      );
    }
    if (boxesOverlap(shelf, dock)) {
      failures.push(
        `${viewport.width}px shelf overlaps the dock: ${JSON.stringify(geometry)}`,
      );
    }
    if (boxesOverlap(shelf, topbar)) {
      failures.push(
        `${viewport.width}px shelf overlaps the topbar: ${JSON.stringify(geometry)}`,
      );
    }
    if (geometry.shelfClipped) {
      failures.push(
        `${viewport.width}px shelf clips its content: ${JSON.stringify(geometry)}`,
      );
    }
    if (geometry.buttons.length !== 6) {
      failures.push(
        `${viewport.width}px expected 6 shelf buttons, got ${geometry.buttons.length}`,
      );
    }
    for (const button of geometry.buttons) {
      const { box } = button;
      if (button.clipped) {
        failures.push(
          `${viewport.width}px ${button.id} clips its content: ${JSON.stringify(geometry)}`,
        );
      }
      if (box.width < 43.5 || box.height < 43.5) {
        failures.push(
          `${viewport.width}px ${button.id} is smaller than 44px: ${JSON.stringify(geometry)}`,
        );
      }
      if (
        box.left < stage.left - 1 ||
        box.right > stage.right + 1 ||
        box.top < stage.top - 1 ||
        box.bottom > stage.bottom + 1
      ) {
        failures.push(
          `${viewport.width}px ${button.id} leaves the map column: ${JSON.stringify(geometry)}`,
        );
      }
      if (
        box.left < -1 ||
        box.right > viewport.width + 1 ||
        box.top < -1 ||
        box.bottom > viewport.height + 1
      ) {
        failures.push(
          `${viewport.width}px ${button.id} leaves the viewport: ${JSON.stringify(geometry)}`,
        );
      }
    }
  }

  expect(failures).toEqual([]);
});

test("topbar clusters and readouts stay readable at supported desktop widths", async ({
  page,
}) => {
  const failures: string[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page, LONG_CITY_NAME);
    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.getByTestId("topbar-save-status")).toHaveText(
      /^Saved \d+ (s|min) ago$/,
    );

    const geometry = await topbarGeometry(page);
    failures.push(...collectOverlapFailures(viewport, geometry));
    failures.push(
      ...collectCenteringFailures(viewport, geometry, "long city name"),
    );
    expect(geometry.cityNameTitle).toBe(LONG_CITY_NAME);

    await applyDirtyFixture(page);
    await applyLongValueFixture(page);
    await injectTripWarningChip(page);
    const stressed = await topbarGeometry(page);
    expect(stressed.readouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Money", value: "$-120,000" }),
        expect.objectContaining({ label: "Daily cost", value: "$20,000" }),
      ]),
    );
    expect(stressed.saveStatus).toMatch(/^Saved \d+ (s|min) ago$/);
    failures.push(...collectOverlapFailures(viewport, stressed));
    failures.push(
      ...collectCenteringFailures(
        viewport,
        stressed,
        "stressed long city name",
      ),
    );
    expect(
      stressed.cityNameWidth,
      `${viewport.width}px city name keeps a usable ellipsized width: ${JSON.stringify(stressed)}`,
    ).toBeGreaterThanOrEqual(40);
  }

  expect(failures).toEqual([]);
});

test("clock cluster stays centred through pause, speed and dock changes", async ({
  page,
}) => {
  const failures: string[] = [];

  const measure = async (
    viewport: (typeof viewports)[number],
    label: string,
  ): Promise<void> => {
    // Cluster entrance animations run with `backwards` fill; settle them
    // before measuring centres.
    await page.getByTestId("topbar").evaluate(async (topbar) => {
      await Promise.all(
        topbar
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const geometry = await topbarGeometry(page);
    failures.push(...collectCenteringFailures(viewport, geometry, label));
  };

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page, "E2E City");
    await expect(page.getByTestId("topbar-save-status")).toHaveText(
      /^Saved \d+ (s|min) ago$/,
    );
    await measure(viewport, "short city name");

    // The sandbox starts paused, so the first click resumes.
    const pause = page.locator('[data-action="pause"]');
    await expect(pause).toHaveAccessibleName("Resume");
    await pause.click();
    await expect(pause).toHaveAccessibleName("Pause");
    await measure(viewport, "resumed");
    await pause.click();
    await expect(pause).toHaveAccessibleName("Resume");
    await measure(viewport, "paused again");

    for (const speed of ["2x", "4x", "1x"] as const) {
      await page.getByRole("button", { name: speed }).click();
      await measure(viewport, `speed ${speed}`);
    }

    await openCommandDestination(page, "build");
    await measure(viewport, "dock open");
    await page.getByRole("button", { name: "Close Build" }).click();
    await expect(page.getByTestId("workspace-dock")).toHaveCount(0);
    await measure(viewport, "dock closed");
  }

  expect(failures).toEqual([]);
});

test("real failed save keeps one focusable Retry chip at supported widths", async ({
  page,
}, testInfo) => {
  await installOneShotCitySaveFailure(page);
  const failures: string[] = [];

  for (const viewport of viewports.filter(
    (candidate) => candidate.width === 1024 || candidate.width === 1440,
  )) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page, LONG_CITY_NAME);
    await applyDirtyFixture(page);
    await openCommandDestination(page, "city");
    await armOneShotCitySaveFailure(page);
    await page.getByRole("button", { name: "Save Now" }).click();

    const status = page.getByTestId("topbar-save-status");
    await expect(status).toHaveAttribute("data-dirty", "true");
    await expect(status).toHaveText(/^Couldn't save\u00a0· Retry$/);
    await expect(
      page.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(1);

    const geometry = await topbarGeometry(page);
    failures.push(...collectRetryFailures(viewport, geometry));

    const retry = status.getByRole("button", { name: "Retry", exact: true });
    await retry.focus();
    expect(
      await retry.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(
        `retry-chip-${viewport.width}x${viewport.height}.png`,
      ),
    });

    // Recover through the real store so the next viewport starts clean.
    await retry.click();
    await expect(status).toHaveAttribute("data-dirty", "false");
  }

  expect(failures).toEqual([]);
});

test("dirty browser leave asks for confirmation after user activation", async ({
  page,
}) => {
  await createDefaultCity(page);
  await applyDirtyFixture(page);
  const dialogPromise = page.waitForEvent("dialog");
  void page.reload().catch(() => null);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const pause = page.getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();
  await openCommandDestination(page, "city");
  await page.getByRole("button", { name: "Save Now" }).click();
  await expect(page.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );
  let prompted = false;
  page.once("dialog", async (event) => {
    prompted = true;
    await event.dismiss();
  });
  await page.reload();
  expect(prompted).toBe(false);
});
