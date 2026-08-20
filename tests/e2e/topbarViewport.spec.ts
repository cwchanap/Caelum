import { expect, test } from "@playwright/test";
import { createDefaultCity, debugSetBudget } from "./helpers";

const viewports = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

async function topbarGeometry(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const topbar = document.querySelector<HTMLElement>(
      '[data-testid="topbar"]',
    );
    if (topbar === null) throw new Error("Topbar is missing");

    const readouts = Array.from(
      topbar.querySelectorAll<HTMLElement>(".readout"),
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
    const controls = topbar.querySelector<HTMLElement>(".controls");
    if (controls === null) throw new Error("Topbar controls are missing");
    const controlsBox = controls.getBoundingClientRect();
    return {
      readouts,
      controlsLeft: controlsBox.left,
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

function collectOverlapFailures(
  viewport: (typeof viewports)[number],
  geometry: Awaited<ReturnType<typeof topbarGeometry>>,
): string[] {
  const failures: string[] = [];
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
  if (lastReadout.textRight > geometry.controlsLeft) {
    failures.push(
      `${viewport.width}px last readout overlaps controls: ${JSON.stringify(geometry)}`,
    );
  }
  return failures;
}

test("topbar readouts and controls do not overlap at supported desktop widths", async ({
  page,
}) => {
  const failures: string[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await createDefaultCity(page);
    await expect(page.getByTestId("topbar")).toBeVisible();
    failures.push(
      ...collectOverlapFailures(viewport, await topbarGeometry(page)),
    );

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
