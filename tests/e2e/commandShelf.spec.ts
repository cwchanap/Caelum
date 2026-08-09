import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  debugSetBudget,
  dragMapTiles,
  hoverMapTile,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

const desktopViewports = [
  { name: "compact", width: 1024, height: 768 },
  { name: "primary", width: 1280, height: 800 },
  { name: "wide", width: 1440, height: 900 },
] as const;

function expectInsideViewport(
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
  label: string,
): asserts box is { x: number; y: number; width: number; height: number } {
  expect(box, `${label} has a bounding box`).not.toBeNull();
  expect(box!.height, `${label} is at least 44px high`).toBeGreaterThanOrEqual(
    44,
  );
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${label} top edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect(box!.y + box!.height, `${label} bottom edge`).toBeLessThanOrEqual(
    viewport.height + 1,
  );
}

test("keeps the command shelf and panel inside the approved desktop widths", async ({
  page,
}) => {
  for (const viewport of desktopViewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.getByTestId("game-shell")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <= window.innerWidth &&
            document.documentElement.scrollHeight <= window.innerHeight,
        ),
      )
      .toBe(true);

    await expect(page.getByTestId("command-tool-select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const destination of ["build", "lines", "data", "city"] as const) {
      await expect(
        page.getByTestId(`command-destination-${destination}`),
      ).toBeVisible();
    }
    await expect(page.getByTestId("command-panel")).toHaveCount(0);

    const shelf = page.getByTestId("command-shelf");
    for (const id of [
      "command-destination-build",
      "command-destination-lines",
      "command-destination-data",
      "command-destination-city",
      "command-tool-select",
      "command-tool-demolish",
    ]) {
      expectInsideViewport(
        await page.getByTestId(id).boundingBox(),
        viewport,
        id,
      );
    }
    expectInsideViewport(
      await page.locator('[data-action="pause"]').boundingBox(),
      viewport,
      "pause",
    );
    for (const speed of [1, 2, 4]) {
      expectInsideViewport(
        await page.locator(`[data-speed="${speed}"]`).boundingBox(),
        viewport,
        `${speed}x speed`,
      );
    }

    const canvas = page.locator("canvas[data-runtime-canvas='true']");
    const canvasBox = await canvas.boundingBox();
    const shelfBox = await shelf.boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(shelfBox).not.toBeNull();
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(
      shelfBox!.y + 1,
    );

    await openCommandDestination(page, "build");
    const panel = page.getByTestId("command-panel");
    const panelBox = await panel.boundingBox();
    const topbarBox = await page.getByTestId("topbar").boundingBox();
    const openShelfBox = await shelf.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(topbarBox).not.toBeNull();
    expect(openShelfBox).not.toBeNull();
    expect(panelBox!.y).toBeGreaterThanOrEqual(
      topbarBox!.y + topbarBox!.height - 1,
    );
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(
      openShelfBox!.y + 1,
    );
    expect(panelBox!.x).toBeGreaterThanOrEqual(-1);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );

    await expect(page.getByTestId("command-plate-grid")).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByTestId("command-plate-grid")
          .locator("img")
          .evaluateAll((images) =>
            images.map((image) => {
              const plate = image as HTMLImageElement;
              return {
                complete: plate.complete,
                naturalWidth: plate.naturalWidth,
                naturalHeight: plate.naturalHeight,
              };
            }),
          ),
      )
      .toEqual([
        { complete: true, naturalWidth: 256, naturalHeight: 256 },
        { complete: true, naturalWidth: 256, naturalHeight: 256 },
        { complete: true, naturalWidth: 256, naturalHeight: 256 },
        { complete: true, naturalWidth: 256, naturalHeight: 256 },
      ]);
    await expect(
      page.getByTestId("command-plate-grid").getByRole("button"),
    ).toHaveText(["Roads", "Transit", "Zones", "Buildings"]);

    const population = page.getByTestId("topbar").locator(".readout", {
      hasText: "Population",
    });
    const avgWait = page.getByTestId("topbar").locator(".readout", {
      hasText: "Avg Wait",
    });
    if (viewport.width === 1024) {
      await expect(population).toBeHidden();
      await expect(avgWait).toBeHidden();
    } else {
      await expect(population).toBeVisible();
      await expect(avgWait).toBeVisible();
    }
  }
});

test("navigates the command shelf and plate grid with the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  const destinations = ["build", "lines", "data", "city"] as const;
  await page.getByTestId("command-destination-build").focus();
  await expect(page.getByTestId("command-destination-build")).toBeFocused();
  for (const destination of destinations.slice(1)) {
    await page.keyboard.press("Tab");
    await expect(
      page.getByTestId(`command-destination-${destination}`),
    ).toBeFocused();
  }

  const build = page.getByTestId("command-destination-build");
  await build.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-panel")).toHaveAttribute(
    "data-command-panel",
    "build",
  );

  const roads = page.getByTestId("command-plate-roads");
  const transit = page.getByTestId("command-plate-transit");
  const zones = page.getByTestId("command-plate-zones");
  const buildings = page.getByTestId("command-plate-buildings");
  await roads.focus();
  await page.keyboard.press("ArrowRight");
  await expect(transit).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(buildings).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(zones).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(roads).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await expect(build).toBeFocused();
});

test("completes a Lines lifecycle while the destination stays pinned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  const stops = [
    { x: 5, y: 3 },
    { x: 9, y: 3 },
  ] as const;
  for (const stop of stops) await clickMapTile(canvas, stop);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const destination of ["build", "data", "city"] as const) {
    await expect(
      page.getByTestId(`command-destination-${destination}`),
    ).toHaveAttribute("aria-disabled", "true");
  }
  for (const tool of ["select", "demolish"] as const) {
    await expect(page.getByTestId(`command-tool-${tool}`)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }

  for (const stop of stops) await clickMapTile(canvas, stop);
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await expect(page.getByTestId("route-preview-status")).toHaveText(
    /connected/i,
  );
  await page.getByRole("button", { name: "Save route" }).click();
  await expect(page.getByTestId("lines-list")).toBeFocused();

  const created = (await runtimeSnapshot(page)).state.transit.routes.at(-1);
  expect(created).toBeDefined();
  const routeId = created!.id;
  const routeName = page.getByTestId(`route-name-${routeId}`);
  await expect(routeName).toHaveValue(created!.name);
  await routeName.fill("Harbour Shuttle");
  await page.keyboard.press("Enter");
  const differentColor = created!.color === "#2867b2" ? "#2e9e5b" : "#2867b2";
  await page.getByTestId(`route-color-${routeId}-${differentColor}`).click();
  await page.getByTestId(`route-toggle-${routeId}`).click();
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      const route = snapshot.state.transit.routes.find(
        (candidate) => candidate.id === routeId,
      );
      return {
        name: route?.name,
        color: route?.color,
        active: route?.active,
      };
    })
    .toEqual({ name: "Harbour Shuttle", color: differentColor, active: false });

  await page.getByRole("button", { name: "Edit Harbour Shuttle" }).click();
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("route-draft")).toHaveCount(0);
  await expect(page.getByTestId("lines-list")).toBeFocused();

  const renamed = page.getByTestId(`route-name-${routeId}`);
  await renamed.fill("Temporary Name");
  await renamed.press("Escape");
  await expect(renamed).toHaveValue("Harbour Shuttle");
  await expect(page.getByTestId("panel-lines")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await clickMapTile(canvas, stops[0]);
  await expect(page.getByTestId("panel-inspect")).toBeVisible();
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(page.getByTestId("panel-inspect")).toHaveCount(0);
  await expect(page.getByTestId("command-panel")).toHaveCount(0);

  await openCommandDestination(page, "lines");
  await page.getByTestId(`route-toggle-${routeId}`).click();
  await expect(page.getByTestId(`route-status-${routeId}`)).toHaveText(
    "Running",
  );
  const deleteButton = page.getByTestId(`route-delete-${routeId}`);
  await deleteButton.click();
  await deleteButton.click();
  await expect(page.getByTestId(`route-name-${routeId}`)).toHaveCount(0);
  await expect
    .poll(async () =>
      (await runtimeSnapshot(page)).state.transit.routes.some(
        (route) => route.id === routeId,
      ),
    )
    .toBe(false);
});

test("shows one road impact strip and one dismissible rejection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const tile = { x: 2, y: 10 } as const;

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await hoverMapTile(canvas, tile);
  const feedback = page.getByTestId("action-feedback");
  await expect(feedback).toHaveCount(1);
  await expect(feedback).toHaveAttribute("data-source", "roadImpact");
  await expect(feedback).toContainText("Preview cost");
  await expect(page.getByTestId("rejection-banner")).toHaveCount(0);
  await expect(page.getByTestId("road-mutation-notice")).toHaveCount(0);

  await debugSetBudget(page, 0);
  await clickMapTile(canvas, tile);
  await expect(feedback).toHaveCount(1);
  await expect(feedback).toHaveAttribute("data-source", "rejection");
  await expect(feedback).toContainText("available");
  await expect(feedback.getByRole("button", { name: "Dismiss" })).toHaveCount(
    1,
  );
  await expect(page.getByTestId("rejection-banner")).toHaveCount(0);
  await expect(page.getByTestId("road-mutation-notice")).toHaveCount(0);

  await feedback.getByRole("button", { name: "Dismiss" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-tool-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("action-feedback")).toHaveCount(0);
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
});
