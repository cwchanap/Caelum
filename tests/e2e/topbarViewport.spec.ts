import { expect, test } from "@playwright/test";
import { createDefaultCity, debugSetBudget } from "./helpers";

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
    textRight: number;
  }>;
  cityNameRight: number;
  cityNameTitle: string | null;
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
        const firstChild = value.firstChild;
        if (firstChild === null) {
          throw new Error(
            `.readout-value has no measurable text node: ${value.outerHTML}`,
          );
        }
        const box = readout.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(firstChild);
        const textBox = range.getBoundingClientRect();
        return {
          label: readout
            .querySelector<HTMLElement>(".readout-label")
            ?.textContent?.trim(),
          value: value.textContent?.trim(),
          left: box.left,
          right: box.right,
          textRight: textBox.right,
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
      cityNameRight: cityNameBox.right,
      cityNameTitle: cityName.getAttribute("title"),
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

/** The three clusters must tile left-to-right without overlapping, every
 *  stats readout must stay inside its card, and an ellipsized city name must
 *  stay inside the city card. */
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
  for (let index = 0; index < geometry.readouts.length - 1; index += 1) {
    const current = geometry.readouts[index];
    const next = geometry.readouts[index + 1];
    if (current.textRight > next.left) {
      failures.push(
        `${viewport.width}px ${current.label} overlaps ${next.label}: ${JSON.stringify(geometry)}`,
      );
    }
  }

  const lastReadout = geometry.readouts.at(-1);
  if (lastReadout === undefined) throw new Error("No visible topbar readouts");
  if (lastReadout.textRight > geometry.stats.right + 1) {
    failures.push(
      `${viewport.width}px last readout overflows the stats cluster: ${JSON.stringify(geometry)}`,
    );
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

    const geometry = await topbarGeometry(page);
    failures.push(...collectOverlapFailures(viewport, geometry));
    // An ellipsized long city name still exposes the full name via title.
    expect(geometry.cityNameTitle).toBe(LONG_CITY_NAME);

    await applyLongValueFixture(page);
    const longGeometry = await topbarGeometry(page);
    expect(longGeometry.readouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Money", value: "$-120,000" }),
        expect.objectContaining({ label: "Daily cost", value: "$20,000" }),
      ]),
    );
    failures.push(...collectOverlapFailures(viewport, longGeometry));
  }

  expect(failures).toEqual([]);
});
