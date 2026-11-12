import { expect, test } from "@playwright/test";
import { HUD_INSET, tileSize } from "../../src/render/boardTransform";
import { MAP_SIZES } from "../../src/scenario/sandbox";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import {
  clickMapTile,
  createDefaultCity,
  debugSetBudget,
  dragMapTiles,
  drainGameplayQueue,
  hoverMapTile,
  mapTileViewportPoint,
  mapWorldViewportPoint,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
  settleLayout,
} from "./helpers";

const desktopViewports = [
  { name: "compact", width: 1024, height: 768 },
  { name: "primary", width: 1280, height: 800 },
  { name: "wide", width: 1440, height: 900 },
] as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

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

for (const viewport of desktopViewports) {
  test(`docks the workspace beside the fitted map at ${viewport.width}px and restores full width on close`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await createDefaultCity(page, "Dock Geometry", "blankGrid");
    const canvas = page.locator("canvas[data-runtime-canvas='true']");
    const dock = page.getByTestId("workspace-dock");
    await expect(canvas).toBeVisible();
    await expect(dock).toHaveCount(0);

    const map = MAP_SIZES.small;
    const expectMapFitsCanvas = async (label: string) => {
      const canvasBox = await canvas.boundingBox();
      expect(canvasBox, `${label}: canvas has a bounding box`).not.toBeNull();
      const topLeft = await mapWorldViewportPoint(canvas, { x: 0, y: 0 });
      const bottomRight = await mapWorldViewportPoint(canvas, {
        x: map.width * tileSize,
        y: map.height * tileSize,
      });
      expect(
        topLeft.x,
        `${label}: map left fits in canvas`,
      ).toBeGreaterThanOrEqual(canvasBox!.x - 1);
      expect(
        topLeft.y,
        `${label}: map top fits in canvas`,
      ).toBeGreaterThanOrEqual(canvasBox!.y - 1);
      expect(
        bottomRight.x,
        `${label}: map right fits in canvas`,
      ).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 1);
      expect(
        bottomRight.y,
        `${label}: map bottom fits in canvas`,
      ).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 1);
    };

    const closedCanvas = await canvas.boundingBox();
    expect(closedCanvas).not.toBeNull();
    expect(Math.abs(closedCanvas!.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(closedCanvas!.x + closedCanvas!.width - viewport.width),
    ).toBeLessThanOrEqual(1);
    await expectMapFitsCanvas("dock closed");

    // A road tool stays armed when the Build workspace opens, so a map click
    // beside the dock proves the clickable area reaches the right map column.
    await selectBuildLeaf(page, "roads", "road-twoWay");
    await openCommandDestination(page, "build");
    await expect(dock).toBeVisible();
    const dockLeft = (await dock.boundingBox())!.x;

    // The canvas follows the stage's measured width on its next frame.
    await expect
      .poll(async () => {
        const box = await canvas.boundingBox();
        return box === null ? Number.POSITIVE_INFINITY : box.x + box.width;
      })
      .toBeLessThanOrEqual(dockLeft + 1);

    const openCanvas = await canvas.boundingBox();
    const dockBox = await dock.boundingBox();
    expect(openCanvas).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(
      openCanvas!.x + openCanvas!.width,
      "canvas ends at the dock",
    ).toBeLessThanOrEqual(dockBox!.x + 1);
    expect(
      dockBox!.x + dockBox!.width,
      "dock stays inside the viewport",
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(openCanvas!.width).toBeLessThan(closedCanvas!.width - 1);
    await expectMapFitsCanvas("dock open");

    await page.getByTestId("map-zoom-in").click();
    await expect
      .poll(async () => (await runtimeSnapshot(page)).camera?.zoom ?? 1)
      .toBeGreaterThan(1);
    await page.getByTestId("map-zoom-fit").click();
    await expect
      .poll(async () => (await runtimeSnapshot(page)).camera)
      .toBeNull();
    await expectMapFitsCanvas("fit with dock open");

    const rightMostColumn = { x: map.width - 1, y: 9 };
    await hoverMapTile(canvas, rightMostColumn);
    await expect
      .poll(async () => (await runtimeSnapshot(page)).ui.hoverTile)
      .toEqual(rightMostColumn);
    await clickMapTile(canvas, rightMostColumn);
    await expect
      .poll(async () => {
        const tiles = (await runtimeSnapshot(page)).state.map.tiles;
        return tiles.find(
          (tile) =>
            tile.x === rightMostColumn.x && tile.y === rightMostColumn.y,
        )?.kind;
      })
      .toBe("road");

    await page.getByRole("button", { name: "Close Build" }).click();
    await expect(dock).toHaveCount(0);
    await expect
      .poll(async () =>
        Math.abs(((await canvas.boundingBox())?.width ?? 0) - viewport.width),
      )
      .toBeLessThanOrEqual(1);
    await expectMapFitsCanvas("dock closed again");
  });
}

for (const viewport of desktopViewports) {
  test(`keeps the command shelf and panel inside the ${viewport.name} desktop width (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await createDefaultCity(page);

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

    // The topbar slide-in can still be unwinding a sub-pixel transform when
    // the boxes below are read; wait for it so heights report the settled
    // 44px rather than a mid-flight compositor quad.
    await page.getByTestId("topbar").evaluate(async (topbar) => {
      await Promise.all(
        topbar
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });

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
    expect(canvasBox!.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(shelfBox!.y).toBeGreaterThanOrEqual(
      viewport.height - HUD_INSET.bottom - 1,
    );
    expect(shelfBox!.y + shelfBox!.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    await openCommandDestination(page, "build");
    const panel = page.getByTestId("command-panel");
    const dock = page.getByTestId("workspace-dock");
    const panelBox = await panel.boundingBox();
    const dockBox = await dock.boundingBox();
    const topbarBox = await page.getByTestId("topbar").boundingBox();
    const openShelfBox = await shelf.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(topbarBox).not.toBeNull();
    expect(openShelfBox).not.toBeNull();
    expect(panelBox!.y).toBeGreaterThanOrEqual(
      topbarBox!.y + topbarBox!.height - 1,
    );
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );
    expect(panelBox!.x).toBeGreaterThanOrEqual(-1);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );
    expect(
      boxesIntersect(openShelfBox!, dockBox!),
      "the shelf stays in the map column, clear of the dock",
    ).toBe(false);

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
    await expect(population).toBeVisible();
    await expect(avgWait).toBeVisible();
  });

  test(`keeps the map zoom controls clickable clear of the dock at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await createDefaultCity(page);

    const zoomControls = [
      page.getByTestId("map-zoom-in"),
      page.getByTestId("map-zoom-out"),
      page.getByTestId("map-zoom-fit"),
    ] as const;
    const zoomFit = page.getByTestId("map-zoom-fit");
    const board = page.getByTestId("game-canvas-host");
    const shelf = page.getByTestId("command-shelf");
    const camera = async () => (await runtimeSnapshot(page)).camera;

    await expect(zoomFit).toBeDisabled();
    await page.getByTestId("map-zoom-in").click();
    await expect(zoomFit).toBeEnabled();
    await expect.poll(camera).not.toBeNull();

    await page.getByTestId("map-zoom-out").click();
    await expect.poll(camera).toBeNull();
    await expect(zoomFit).toBeDisabled();
    await page.getByTestId("map-zoom-in").click();
    await expect(zoomFit).toBeEnabled();

    const expectZoomControlsClear = async () => {
      const boardBox = await board.boundingBox();
      const shelfBox = await shelf.boundingBox();
      expect(boardBox).not.toBeNull();
      expect(shelfBox).not.toBeNull();
      const boardBottom = boardBox!.y + boardBox!.height;
      const safeBandTop = boardBottom - HUD_INSET.bottom;
      for (const button of zoomControls) {
        const testid = await button.getAttribute("data-testid");
        const box = await button.boundingBox();
        expect(box, `${testid} has a bounding box`).not.toBeNull();
        expect(
          box!.y,
          `${testid} stays inside the bottom safe band`,
        ).toBeGreaterThanOrEqual(safeBandTop - 1);
        expect(
          box!.y + box!.height,
          `${testid} stays inside the bottom safe band`,
        ).toBeLessThanOrEqual(boardBottom + 1);
        expect(
          boxesIntersect(box!, shelfBox!),
          `${testid} must not intersect the command shelf`,
        ).toBe(false);
        const hit = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const target = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return target === element || element.contains(target);
        });
        expect(hit, `${testid} is the hit target at its centre`).toBe(true);
      }
    };
    await expectZoomControlsClear();

    await openCommandDestination(page, "data");
    await page
      .getByTestId("panel-data")
      .getByRole("group", { name: "Overlays" })
      .getByRole("button", { name: "Traffic", exact: true })
      .click();
    await expect(
      page.getByTestId("command-destination-data").locator(".chip"),
    ).toBeVisible();
    await expectZoomControlsClear();
    await page.getByRole("button", { name: "Close Data" }).click();

    await expect(page.getByTestId("command-active-mode")).toBeVisible();
    await zoomFit.click();
    await expect.poll(camera).toBeNull();
    await expectZoomControlsClear();
  });
}

test("navigates the command shelf and plate grid with the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);

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
  await createDefaultCity(page);
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
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await expect(page.getByTestId("command-tool-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("lines-list")).toBeFocused();

  const created = (await runtimeSnapshot(page)).state.transit.routes.at(-1);
  expect(created).toBeDefined();
  const routeId = created!.id;
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === routeId,
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
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

  await page
    .getByRole("button", { name: "Edit route Harbour Shuttle" })
    .click();
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
  await settleLayout(page);
  await clickMapTile(canvas, stops[0]);
  await expect(page.getByTestId("panel-inspect")).toBeVisible();
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(page.getByTestId("panel-inspect")).toHaveCount(0);
  await expect(page.getByTestId("command-panel")).toHaveCount(0);

  await openCommandDestination(page, "lines");
  await page.getByTestId(`route-toggle-${routeId}`).click();
  // Reactivating the line keeps the fleet started by Save & run.
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

test("shows road previews at the cursor and a dismissible failed commit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const tile = { x: 2, y: 10 } as const;
  const dragEnd = { x: 4, y: 10 } as const;

  await selectBuildLeaf(page, "roads", "road-twoWay");
  const overlay = page.getByTestId("map-text-overlay");
  const badge = overlay.locator('.map-text-item[data-kind="cursorBadge"]');
  const feedback = page.getByTestId("action-feedback");

  async function expectBadgeAt(currentTile: { x: number; y: number }) {
    await expect
      .poll(async () => {
        const ui = (await runtimeSnapshot(page)).ui;
        return ui.drag?.current ?? ui.hoverTile;
      })
      .toEqual(currentTile);
    await expect(badge).toHaveCount(1);
    const point = await mapTileViewportPoint(canvas, currentTile);
    const overlayBox = await overlay.boundingBox();
    expect(overlayBox).not.toBeNull();
    const anchorX = await badge.evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.left),
    );
    expect(anchorX).toBeCloseTo(point.x - overlayBox!.x, 0);
  }

  await hoverMapTile(canvas, tile);
  await expect(badge).toContainText("$100");
  await expectBadgeAt(tile);
  await expect(feedback).toHaveCount(0);
  await expect(page.getByTestId("rejection-banner")).toHaveCount(0);
  await expect(page.getByTestId("road-mutation-notice")).toHaveCount(0);

  const startPoint = await mapTileViewportPoint(canvas, tile);
  const endPoint = await mapTileViewportPoint(canvas, dragEnd);
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 });
  await expect(badge).toContainText("$300");
  await expectBadgeAt(dragEnd);
  await page.mouse.up();
  await expect(feedback).toHaveCount(0);

  const rejectedTile = { x: 8, y: 10 };
  await hoverMapTile(canvas, rejectedTile);
  await expect(badge).toContainText("$100");
  await expectBadgeAt(rejectedTile);

  // Zeroing the budget changes the world the resolved preview was computed
  // against: the runtime re-requests the armed mutation and the badge flips
  // to the rejection on the same tile, without the pointer moving again.
  await debugSetBudget(page, 0);
  await expect(badge).toHaveClass(/map-text-warning/);
  await expect(badge).toContainText("Needs $100; only $0 is available. ⊘");
  await expectBadgeAt(rejectedTile);
  await expect(feedback).toHaveCount(0);

  await clickMapTile(canvas, rejectedTile);
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

test("keeps the Dismiss control inside the feedback band with long details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const slot = page.getByTestId("action-feedback-slot");
  const feedback = page.getByTestId("action-feedback");
  const dismiss = feedback.getByRole("button", { name: "Dismiss" });

  const expectDismissContained = async () => {
    const slotBox = await slot.boundingBox();
    const toastBox = await feedback.boundingBox();
    const dismissBox = await dismiss.boundingBox();
    expect(slotBox, "feedback band has a bounding box").not.toBeNull();
    expect(toastBox, "feedback toast has a bounding box").not.toBeNull();
    expect(dismissBox, "Dismiss has a bounding box").not.toBeNull();
    expect(
      dismissBox!.x,
      "Dismiss left inside the toast",
    ).toBeGreaterThanOrEqual(toastBox!.x);
    expect(
      dismissBox!.x + dismissBox!.width,
      "Dismiss right inside the toast",
    ).toBeLessThanOrEqual(toastBox!.x + toastBox!.width);
    expect(
      dismissBox!.y,
      "Dismiss top inside the toast",
    ).toBeGreaterThanOrEqual(toastBox!.y);
    expect(
      dismissBox!.y + dismissBox!.height,
      "Dismiss bottom inside the toast",
    ).toBeLessThanOrEqual(toastBox!.y + toastBox!.height);
    expect(toastBox!.x, "toast left inside the band").toBeGreaterThanOrEqual(
      slotBox!.x,
    );
    expect(
      toastBox!.x + toastBox!.width,
      "toast right inside the band",
    ).toBeLessThanOrEqual(slotBox!.x + slotBox!.width);
    expect(toastBox!.y, "toast top inside the band").toBeGreaterThanOrEqual(
      slotBox!.y,
    );
    expect(
      toastBox!.y + toastBox!.height,
      "toast bottom inside the band",
    ).toBeLessThanOrEqual(slotBox!.y + slotBox!.height);
    expect(
      dismissBox!.y + dismissBox!.height,
      "Dismiss inside the viewport",
    ).toBeLessThanOrEqual(800);
  };

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await debugSetBudget(page, 0);
  await clickMapTile(canvas, { x: 2, y: 10 });
  await expect(feedback).toHaveAttribute("data-source", "rejection");
  await expect(dismiss).toBeVisible();
  await expectDismissContained();

  await dismiss.focus();
  await page.keyboard.press("Enter");
  await expect(feedback).toHaveCount(0);

  await debugSetBudget(page, 120_000);
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  await clickMapTile(canvas, { x: 5, y: 3 });
  await clickMapTile(canvas, { x: 9, y: 3 });
  await page.evaluate(async () => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          setTool: (tool: string) => unknown;
          setRoutePattern: (pattern: string) => unknown;
          handleTileClick: (point: { x: number; y: number }) => unknown;
          saveRouteDraft: () => Promise<unknown>;
          getSnapshot: () => {
            shell: { routeDraft: { canSave: boolean } | null };
          };
        };
      }
    ).__caelumRuntime;
    if (!runtime) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    for (let route = 0; route < 4; route += 1) {
      runtime.setTool("busRoute");
      runtime.setRoutePattern("shuttle");
      await runtime.handleTileClick({ x: 5, y: 3 });
      await runtime.handleTileClick({ x: 9, y: 3 });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (runtime.getSnapshot().shell.routeDraft?.canSave === true) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runtime.saveRouteDraft();
    }
  });
  await expect
    .poll(async () => (await runtimeSnapshot(page)).state.transit.routes.length)
    .toBe(4);

  await selectBuildLeaf(page, "roads", "road-oneWay");
  await clickMapTile(canvas, { x: 7, y: 4 });
  await expect(feedback).toHaveAttribute("data-source", "roadDirection");
  await expect(feedback.locator("li")).toHaveCount(4);

  const body = feedback.locator(".action-feedback-body");
  await expect(body).toHaveCount(1);
  expect(
    await body.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
    "long details overflow the message body",
  ).toBe(true);
  expect(
    await feedback.evaluate(
      (element) => element.scrollHeight === element.clientHeight,
    ),
    "the toast itself does not scroll",
  ).toBe(true);
  await expectDismissContained();

  const toastBeforeScroll = await feedback.boundingBox();
  const dismissBeforeScroll = await dismiss.boundingBox();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await feedback.boundingBox()).toEqual(toastBeforeScroll);
  expect(await dismiss.boundingBox()).toEqual(dismissBeforeScroll);
  await expectDismissContained();

  await dismiss.click();
  await expect(feedback).toHaveCount(0);
});

test("keeps visible Data labels owned while a road tool is armed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await openCommandDestination(page, "data");
  const before = await runtimeSnapshot(page);

  const lateMetric = page
    .getByTestId("panel-data")
    .getByRole("button", { name: /Late \d+.*show Traffic overlay/ });
  const lateBox = await lateMetric.boundingBox();
  expect(lateBox).not.toBeNull();
  await page.mouse.click(
    lateBox!.x + lateBox!.width / 2,
    lateBox!.y + lateBox!.height / 2,
  );

  const afterMetricClick = await runtimeSnapshot(page);
  expect(afterMetricClick.state.map.tiles).toEqual(before.state.map.tiles);
  expect(afterMetricClick.ui.activeOverlay).toBe("traffic");
  expect(afterMetricClick.ui.activeTool).toBe("road");
  const legend = page.getByRole("region", { name: "Traffic legend" });
  await expect(legend).toBeVisible();
  await expect(page.getByTestId("panel-data")).toBeVisible();

  const legendBox = await legend.boundingBox();
  expect(legendBox).not.toBeNull();
  let legendTile: (typeof afterMetricClick.state.map.tiles)[number] | undefined;
  for (const tile of afterMetricClick.state.map.tiles) {
    if (
      tile.kind !== "empty" ||
      afterMetricClick.state.buildings.some((building) =>
        building.occupiedTiles.some(
          (occupied) => occupied.x === tile.x && occupied.y === tile.y,
        ),
      )
    ) {
      continue;
    }
    const point = await mapTileViewportPoint(canvas, tile);
    if (
      point.x >= legendBox!.x &&
      point.x <= legendBox!.x + legendBox!.width &&
      point.y >= legendBox!.y &&
      point.y <= legendBox!.y + legendBox!.height
    ) {
      legendTile = tile;
      break;
    }
  }
  if (legendTile === undefined) {
    throw new Error("No empty map tile lies beneath the legend");
  }

  await clickMapTile(canvas, legendTile);
  // The road build travels through the async gameplay queue, so poll the
  // snapshot until the dispatch lands.
  await expect
    .poll(
      async () =>
        (await runtimeSnapshot(page)).state.map.tiles.find(
          (tile) => tile.id === legendTile.id,
        )?.kind,
    )
    .toBe("road");
  expect((await runtimeSnapshot(page)).ui.activeTool).toBe("road");
});

test("keeps RouteEditor labels owned while a line draft is pinned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

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
  for (const stop of stops) await clickMapTile(canvas, stop);
  await expect(page.getByTestId("route-draft")).toBeVisible();

  const shuttleLabel = page.getByTestId("route-draft").getByText("Shuttle", {
    exact: true,
  });
  const shuttleBox = await shuttleLabel.boundingBox();
  expect(shuttleBox).not.toBeNull();
  await page.mouse.click(
    shuttleBox!.x + shuttleBox!.width / 2,
    shuttleBox!.y + shuttleBox!.height / 2,
  );
  await expect(page.getByRole("radio", { name: "Shuttle" })).toBeChecked();
});

test("gates road clicks by preset and clears stale badge answers on retraction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const overlay = page.getByTestId("map-text-overlay");
  const badge = overlay.locator('.map-text-item[data-kind="cursorBadge"]');
  const feedback = page.getByTestId("action-feedback");
  const existingRoad = { x: 5, y: 8 } as const;
  const tileAt = async (point: { x: number; y: number }) =>
    (await runtimeSnapshot(page)).state.map.tiles.find(
      (tile) => tile.x === point.x && tile.y === point.y,
    );

  await selectBuildLeaf(page, "roads", "road-twoWay");
  const authoredRoad = await tileAt(existingRoad);
  expect(authoredRoad).toMatchObject({ kind: "road", oneWay: "west" });

  await hoverMapTile(canvas, existingRoad);
  await expect(badge).toContainText("Already road");
  await expect(badge).not.toHaveClass(/map-text-warning/);

  await clickMapTile(canvas, existingRoad);
  await drainGameplayQueue(page);
  expect(await tileAt(existingRoad)).toEqual(authoredRoad);
  expect((await runtimeSnapshot(page)).state.budget).toBe(120_000);
  await expect(feedback).toHaveCount(0);

  await clickMapTile(canvas, { x: 3, y: 13 });
  await expect
    .poll(async () => (await tileAt({ x: 3, y: 13 }))?.kind)
    .toBe("road");
  expect(await tileAt(existingRoad)).toEqual(authoredRoad);
  expect((await runtimeSnapshot(page)).state.budget).toBe(119_900);
  await expect(feedback).toHaveCount(0);

  await dragMapTiles(page, canvas, { x: 3, y: 2 }, { x: 7, y: 2 });
  await dragMapTiles(page, canvas, { x: 7, y: 2 }, { x: 7, y: 5 });
  await expect
    .poll(async () =>
      [...((await tileAt({ x: 7, y: 2 }))?.roadConnections ?? [])].sort(),
    )
    .toEqual(["south", "west"]);

  await selectBuildLeaf(page, "roads", "road-oneWay");
  await hoverMapTile(canvas, { x: 7, y: 2 });
  await expect(badge).toContainText("Only straight roads can be one-way.");
  await expect(badge).toHaveClass(/map-text-warning/);
  await expect(feedback).toHaveCount(0);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await hoverMapTile(canvas, { x: 7, y: 2 });
  await expect(badge).toContainText("Already road");
  await expect(badge).not.toHaveClass(/map-text-warning/);

  const startPoint = await mapTileViewportPoint(canvas, existingRoad);
  const extendedPoint = await mapTileViewportPoint(canvas, { x: 5, y: 6 });
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.move(extendedPoint.x, extendedPoint.y, { steps: 4 });
  await expect(badge).toContainText("$200");
  await page.mouse.move(startPoint.x, startPoint.y, { steps: 4 });
  await expect(badge).toContainText("Already road");
  await expect(badge).not.toHaveClass(/map-text-warning/);
  await page.mouse.up();
  await drainGameplayQueue(page);
  expect(await tileAt(existingRoad)).toEqual(authoredRoad);
  expect((await runtimeSnapshot(page)).state.budget).toBe(119_100);
  await expect(feedback).toHaveCount(0);

  await clickMapTile(canvas, { x: 4, y: 13 });
  await expect
    .poll(async () => (await tileAt({ x: 4, y: 13 }))?.kind)
    .toBe("road");
  expect(await tileAt(existingRoad)).toEqual(authoredRoad);
  expect((await runtimeSnapshot(page)).state.budget).toBe(119_000);
  await expect(feedback).toHaveCount(0);
});

type RoadPreviewTransition = {
  dragTool: string | null;
  cost: number | null;
  rejection: string | null;
  heldGeneration: number | null;
  generation: number;
  pending: boolean;
};

test("holds the track price at pointer-down and charges only laid tiles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const overlay = page.getByTestId("map-text-overlay");
  const badge = overlay.locator('.map-text-item[data-kind="cursorBadge"]');
  const feedback = page.getByTestId("action-feedback");

  await selectBuildLeaf(page, "transit", "track");
  const strokeStart = { x: 14, y: 4 } as const;
  const strokeEnd = { x: 14, y: 11 } as const;
  await hoverMapTile(canvas, strokeStart);
  await expect(badge).toContainText("$500");

  const startPoint = await mapTileViewportPoint(canvas, strokeStart);
  const endPoint = await mapTileViewportPoint(canvas, strokeEnd);
  const hoverGeneration = (await runtimeSnapshot(page)).ui
    .roadPreviewGeneration;
  await page.evaluate(() => {
    const host = window as unknown as {
      __caelumRuntime?: {
        subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => unknown;
      };
      __roadPreviewTransitions?: RoadPreviewTransition[];
    };
    if (!host.__caelumRuntime) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    const log: RoadPreviewTransition[] = [];
    host.__roadPreviewTransitions = log;
    host.__caelumRuntime.subscribe((snapshot) => {
      const ui = snapshot.ui;
      log.push({
        dragTool: ui.drag?.tool ?? null,
        cost: ui.roadMutationPreview?.cost ?? null,
        rejection: ui.roadMutationPreview?.rejection?.code ?? null,
        heldGeneration: ui.roadMutationPreview?.generation ?? null,
        generation: ui.roadPreviewGeneration,
        pending: ui.roadMutationPreviewPending,
      });
    });
  });
  const transitions = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __roadPreviewTransitions?: RoadPreviewTransition[];
          }
        ).__roadPreviewTransitions ?? [],
    );
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await expect
    .poll(async () => {
      const log = await transitions();
      const firstDragIndex = log.findIndex((t) => t.dragTool === "track");
      return (
        firstDragIndex >= 0 &&
        log
          .slice(firstDragIndex + 1)
          .some(
            (t) =>
              t.dragTool === "track" &&
              t.heldGeneration === t.generation &&
              !t.pending,
          )
      );
    })
    .toBe(true);
  const log = await transitions();
  const firstDragIndex = log.findIndex((t) => t.dragTool === "track");
  expect(firstDragIndex).toBeGreaterThanOrEqual(0);
  expect(log[firstDragIndex]).toEqual({
    dragTool: "track",
    cost: 500,
    rejection: null,
    heldGeneration: hoverGeneration,
    generation: hoverGeneration + 1,
    pending: true,
  });
  const replacementIndex = log.findIndex(
    (t, index) =>
      index > firstDragIndex &&
      t.dragTool === "track" &&
      t.heldGeneration === t.generation &&
      !t.pending,
  );
  expect(
    log
      .slice(firstDragIndex, replacementIndex)
      .every((t) => t.heldGeneration !== null && t.cost !== null),
  ).toBe(true);
  await expect(badge).toContainText("$500");

  await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 });
  await expect(badge).toContainText("$3,000");
  await expect(badge).toContainText("2 tiles blocked");
  await expect(badge).toHaveClass(/map-text-warning/);
  await page.mouse.up();

  const laid = [
    { x: 14, y: 4 },
    { x: 14, y: 5 },
    { x: 14, y: 6 },
    { x: 14, y: 7 },
    { x: 14, y: 10 },
    { x: 14, y: 11 },
  ];
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return laid.map(
        (point) =>
          snapshot.state.map.tiles.find(
            (tile) => tile.x === point.x && tile.y === point.y,
          )?.hasTrack ?? null,
      );
    })
    .toEqual([true, true, true, true, true, true]);
  const settled = await runtimeSnapshot(page);
  for (const point of [
    { x: 14, y: 8 },
    { x: 14, y: 9 },
  ]) {
    expect(
      settled.state.map.tiles.find(
        (tile) => tile.x === point.x && tile.y === point.y,
      )?.hasTrack ?? false,
    ).toBe(false);
  }
  expect(settled.state.budget).toBe(117_000);
  await expect(feedback).toHaveCount(0);

  const secondStart = await mapTileViewportPoint(canvas, { x: 12, y: 10 });
  const secondEnd = await mapTileViewportPoint(canvas, { x: 16, y: 10 });
  await page.mouse.move(secondStart.x, secondStart.y);
  await page.mouse.down();
  await page.mouse.move(secondEnd.x, secondEnd.y, { steps: 8 });
  await expect(badge).toContainText("$2,000");
  await expect(badge).not.toHaveClass(/map-text-warning/);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return [12, 13, 14, 15, 16].map(
        (x) =>
          snapshot.state.map.tiles.find((tile) => tile.x === x && tile.y === 10)
            ?.hasTrack ?? null,
      );
    })
    .toEqual([true, true, true, true, true]);
  expect((await runtimeSnapshot(page)).state.budget).toBe(115_000);
  await expect(feedback).toHaveCount(0);
});
