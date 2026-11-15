import { expect, test } from "@playwright/test";
import { createDefaultCity, openCommandDestination } from "./helpers";

/** The reference compositions must fit their viewport without clipping:
 *  no document overflow, and every key element's box inside the viewport. */
async function assertCompositionFits(
  page: import("@playwright/test").Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      horizontal: root.scrollWidth > root.clientWidth,
      vertical: root.scrollHeight > root.clientHeight,
    };
  });
  expect(overflow.horizontal).toBe(false);
  expect(overflow.vertical).toBe(false);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const boxes = await page.evaluate((size) => {
    const within = (element: Element | null): boolean => {
      if (!(element instanceof Element)) return false;
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= size!.width &&
        box.bottom <= size!.height
      );
    };
    return {
      screen: within(
        document.querySelector(
          "[data-testid='new-city-screen'], [data-testid='city-library-screen']",
        ),
      ),
      preview: within(
        document.querySelector("[data-testid='new-city-preview']"),
      ),
      card: within(document.querySelector(".city-library-card")),
      firstRadio: within(document.querySelector("input[type='radio']")),
      previewLoaded: (() => {
        const image = document.querySelector(
          "[data-testid='new-city-preview']",
        ) as HTMLImageElement | null;
        return image === null || image.complete;
      })(),
    };
  }, viewport);
  expect(boxes.screen).toBe(true);
  // The New City composition carries the large right preview; the library
  // carries the quiet left card. Each is asserted where it exists.
  expect(boxes.preview || boxes.card).toBe(true);
  expect(boxes.firstRadio || boxes.card).toBe(true);
  if (boxes.preview) {
    expect(boxes.previewLoaded).toBe(true);
  }
}

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

test.describe("New City reference composition", () => {
  for (const viewport of VIEWPORTS) {
    test(`fits and captures at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const screen = page.getByTestId("new-city-screen");
      await expect(screen).toBeVisible();
      await expect(page.getByTestId("new-city-preview")).toBeVisible();
      const groupCounts: Record<string, number> = {
        Template: 3,
        "Map size": 3,
        Economy: 2,
      };
      for (const [group, count] of Object.entries(groupCounts)) {
        await expect(
          page
            .getByRole("group", { name: group })
            .locator("input[type='radio']"),
        ).toHaveCount(count, { timeout: 5000 });
      }
      await assertCompositionFits(page);
      await page.screenshot({
        path: testInfo.outputPath(
          `new-city-${viewport.width}x${viewport.height}.png`,
        ),
      });
    });
  }
});

test.describe("City Library reference composition", () => {
  for (const viewport of VIEWPORTS) {
    test(`fits and captures at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await createDefaultCity(page, "Library Shot A");
      await openCommandDestination(page, "city");
      await page
        .getByTestId("panel-city")
        .getByRole("button", { name: "Save Now" })
        .click();
      await expect(
        page.getByTestId("panel-city").getByTestId("city-save-status"),
      ).toHaveAttribute("data-dirty", "false");
      await page.goto("/");
      const library = page.getByTestId("city-library-screen");
      await expect(library).toBeVisible();
      await expect(library).toHaveCSS("background-image", /city-library\.webp/);
      await expect(library.locator("img[src*='app-icon']")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /Continue Library Shot A/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Rename Library Shot A" }),
      ).toBeVisible();
      await assertCompositionFits(page);
      await page.screenshot({
        path: testInfo.outputPath(
          `city-library-${viewport.width}x${viewport.height}.png`,
        ),
      });
    });
  }
});

test.describe("Map sprite screenshots", () => {
  test("captures a Large map at Fit and at max zoom", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(page.getByTestId("new-city-screen")).toBeVisible();
    await page.getByLabel("City name").fill("Map Shot");
    await page.getByRole("radio", { name: "Small Town" }).check();
    await page
      .getByRole("group", { name: "Map size" })
      .getByRole("radio", { name: "Large" })
      .check();
    await page.getByRole("button", { name: "Create City" }).click();
    const canvas = page.locator("canvas[data-runtime-canvas='true']");
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(500);

    // Large Fit: the whole 84x54 map at its strongest minification.
    const fit = await runtimeSnapshotOrNull(page);
    expect(fit?.camera ?? null).toBeNull();
    await captureFramePng(page, testInfo.outputPath("map-large-fit.png"));

    // Max zoom detail on a sprite-bearing area of the town.
    for (let step = 0; step < 24; step += 1) {
      await page.evaluate(() => {
        const runtime = (
          window as unknown as {
            __caelumRuntime?: {
              adjustCamera?: (action: { kind: "zoomIn" }) => unknown;
            };
          }
        ).__caelumRuntime;
        runtime?.adjustCamera?.({ kind: "zoomIn" });
      });
    }
    await page.evaluate(() => {
      const runtime = (
        window as unknown as {
          __caelumRuntime?: {
            adjustCamera?: (action: {
              kind: "centerOn";
              point: { x: number; y: number };
            }) => unknown;
          };
        }
      ).__caelumRuntime;
      runtime?.adjustCamera?.({ kind: "centerOn", point: { x: 49, y: 24 } });
    });
    await page.waitForTimeout(500);
    const zoomed = await runtimeSnapshotOrNull(page);
    expect(zoomed?.camera?.zoom).toBeGreaterThan(1);
    await captureFramePng(page, testInfo.outputPath("map-large-max-zoom.png"));
  });
});

/** Save the real rendered frame through the runtime capture seam. Page
 *  screenshots of the WebGPU canvas stay blank under software-rendering
 *  Chromium (the canvas never reaches the compositor), while
 *  debugCaptureFrame returns the true device output the pixel oracles use.
 *  The frame is mounted as a plain 2D canvas and screenshotted as DOM. */
async function captureFramePng(
  page: import("@playwright/test").Page,
  path: string,
): Promise<void> {
  const handle = await page.evaluateHandle(async () => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          debugCaptureFrame?: () => Promise<{
            width: number;
            height: number;
            pixels: Uint8ClampedArray;
          } | null>;
        };
      }
    ).__caelumRuntime;
    const shot = await runtime?.debugCaptureFrame?.();
    if (!shot) throw new Error("debugCaptureFrame returned no frame");
    const canvas = document.createElement("canvas");
    canvas.id = "capture-frame-view";
    canvas.width = shot.width;
    canvas.height = shot.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D context unavailable");
    const image = context.createImageData(shot.width, shot.height);
    image.data.set(shot.pixels);
    context.putImageData(image, 0, 0);
    document.body.appendChild(canvas);
    return canvas;
  });
  const canvasEl = handle.asElement();
  expect(canvasEl).not.toBeNull();
  await canvasEl!.screenshot({ path });
}

async function runtimeSnapshotOrNull(
  page: import("@playwright/test").Page,
): Promise<{ camera: { zoom: number } | null } | null> {
  return page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          getSnapshot?: () => { camera: { zoom: number } | null };
        };
      }
    ).__caelumRuntime;
    if (runtime?.getSnapshot === undefined) return null;
    return { camera: runtime.getSnapshot().camera };
  });
}
