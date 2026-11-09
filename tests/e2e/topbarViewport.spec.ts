import { expect, test } from "@playwright/test";
import { HUD_INSET } from "../../src/render/boardTransform";
import {
  createDefaultCity,
  debugSetBudget,
  dragMapTiles,
  selectBuildLeaf,
} from "./helpers";

const viewports = [
  { width: 1024, height: 768 },
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

interface TopbarGeometry {
  city: ClusterBox;
  clock: ClusterBox;
  stats: ClusterBox;
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

    return {
      city: clusterBox(".topbar-cluster--city"),
      clock: clusterBox(".topbar-cluster--clock"),
      stats: clusterBox(".topbar-cluster--stats"),
      readouts,
      cityNameWidth: cityNameBox.width,
      cityNameRight: cityNameBox.right,
      cityNameTitle: cityName.getAttribute("title"),
      saveStatus:
        topbar
          .querySelector<HTMLElement>('[data-testid="topbar-save-status"]')
          ?.textContent?.trim() ?? null,
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
  await expect(page.getByTestId("topbar-save-status")).toHaveText(
    "Unsaved changes",
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

test("topbar clusters and readouts stay readable at supported desktop widths", async ({
  page,
}) => {
  const failures: string[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page, LONG_CITY_NAME);
    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.getByTestId("topbar-save-status")).toHaveText("Saved");

    const geometry = await topbarGeometry(page);
    failures.push(...collectOverlapFailures(viewport, geometry));
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
    expect(stressed.saveStatus).toBe("Unsaved changes");
    failures.push(...collectOverlapFailures(viewport, stressed));
    expect(
      stressed.cityNameWidth,
      `${viewport.width}px city name keeps a usable ellipsized width: ${JSON.stringify(stressed)}`,
    ).toBeGreaterThanOrEqual(40);
  }

  expect(failures).toEqual([]);
});
