import { expect, test } from "@playwright/test";
import { createDefaultCity } from "./helpers";

interface RequiredControl {
  /** CSS selector matching the required controls. */
  selector: string;
  /** Exact matched-element count when the composition fixes it. */
  count?: number;
}

/** The reference compositions must fit their viewport without clipping:
 *  no document overflow, and every required control's box inside the
 *  viewport and inside every clipping (overflow) ancestor. Radio counts
 *  alone do not prove visibility — each element is measured. */
async function assertCompositionFits(
  page: import("@playwright/test").Page,
  controls: RequiredControl[],
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
  const results = await page.evaluate(
    ({ size, selectors }) => {
      const clippingAncestor = (element: Element): string | null => {
        const box = element.getBoundingClientRect();
        for (
          let node = element.parentElement;
          node !== null;
          node = node.parentElement
        ) {
          const style = window.getComputedStyle(node);
          const clipsX = ["hidden", "clip", "auto", "scroll"].includes(
            style.overflowX,
          );
          const clipsY = ["hidden", "clip", "auto", "scroll"].includes(
            style.overflowY,
          );
          if (!clipsX && !clipsY) continue;
          const clipBox = node.getBoundingClientRect();
          if (
            box.left < clipBox.left - 1 ||
            box.right > clipBox.right + 1 ||
            box.top < clipBox.top - 1 ||
            box.bottom > clipBox.bottom + 1
          ) {
            const label =
              typeof node.className === "string" && node.className.length > 0
                ? node.className.split(" ")[0]
                : node.id || node.tagName.toLowerCase();
            return `${node.tagName.toLowerCase()}.${label}`;
          }
        }
        return null;
      };
      return selectors.map((selector) => {
        const elements = [...document.querySelectorAll(selector)];
        let clipped: string | null = null;
        let outsideViewport = 0;
        let zeroSized = 0;
        for (const element of elements) {
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) {
            zeroSized += 1;
            continue;
          }
          if (
            box.left < 0 ||
            box.top < 0 ||
            box.right > size.width ||
            box.bottom > size.height
          ) {
            outsideViewport += 1;
          }
          clipped ??= clippingAncestor(element);
        }
        return {
          selector,
          matched: elements.length,
          clipped,
          outsideViewport,
          zeroSized,
        };
      });
    },
    { size: viewport!, selectors: controls.map((control) => control.selector) },
  );
  for (const [index, control] of controls.entries()) {
    const result = results[index]!;
    const expected = control.count ?? 1;
    expect(result.matched, `${control.selector} matched`).toBe(expected);
    expect(result.zeroSized, `${control.selector} zero-sized controls`).toBe(0);
    expect(
      result.outsideViewport,
      `${control.selector} outside the ${viewport!.width}x${viewport!.height} viewport`,
    ).toBe(0);
    expect(
      result.clipped,
      `${control.selector} clipped by a container`,
    ).toBeNull();
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
      // Every required control, not just the first radio: all eight radios,
      // the name field and both action buttons must sit inside the viewport
      // and inside every clipping container.
      await assertCompositionFits(page, [
        { selector: "[data-testid='new-city-screen']", count: 1 },
        { selector: "[data-testid='new-city-preview']", count: 1 },
        { selector: "input[name='template']", count: 3 },
        { selector: "input[name='mapSize']", count: 3 },
        { selector: "input[name='economy']", count: 2 },
        // The radios are visually hidden; their card labels are the visible
        // controls and must also fit the composition.
        { selector: ".choice-tile--template", count: 3 },
        { selector: ".choice-tile", count: 8 },
        { selector: "input[autocomplete='off']", count: 1 },
        { selector: "button[type='submit']", count: 1 },
        // The standalone screen renders only Create; Cancel exists solely in
        // the City-panel flow.
        { selector: ".new-city-actions button", count: 1 },
      ]);
      await expect(page.getByTestId("new-city-preview")).toBeVisible();
      const previewLoaded = await page.evaluate(() => {
        const image = document.querySelector(
          "[data-testid='new-city-preview']",
        ) as HTMLImageElement | null;
        return image === null || image.complete;
      });
      expect(previewLoaded).toBe(true);
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
      // Multiple saved cities so the library list (and every row's rename,
      // Load, Delete, avatar and saved-time control) is measured, not just
      // a single-row card.
      await createDefaultCity(page, "Library Shot A");
      await createDefaultCity(page, "Library Shot B");
      await createDefaultCity(page, "Library Shot C");
      await page.goto("/");
      const library = page.getByTestId("city-library-screen");
      await expect(library).toBeVisible();
      await expect(library).toHaveCSS("background-image", /city-library\.webp/);
      await expect(library.locator("img[src*='app-icon']")).toBeVisible();
      const continueCard = library.locator(".city-library-continue");
      await expect(continueCard).toHaveText(/^\s*Continue /);
      // The Continue card names the newest saved city and its saved time.
      await expect(continueCard).toContainText("Library Shot C");
      await expect(continueCard.locator("time[datetime]")).toHaveCount(1);
      await expect(library.getByText("Your cities")).toBeVisible();
      // After a fresh reload no session is active, so every row carries a
      // Load button.
      await assertCompositionFits(page, [
        { selector: "[data-testid='city-library-screen']", count: 1 },
        { selector: ".city-library-card", count: 1 },
        { selector: "img[src*='app-icon']", count: 1 },
        { selector: ".city-library-continue", count: 1 },
        { selector: ".city-library-actions button", count: 2 },
        { selector: "[data-testid^='city-row-']", count: 3 },
        { selector: "[data-testid='city-avatar']", count: 3 },
        { selector: ".inline-name-value", count: 3 },
        { selector: ".inline-name-pencil", count: 3 },
        // One saved-time per row plus the Continue card timestamp.
        { selector: "time[datetime]", count: 4 },
        { selector: "button[aria-label^='Load ']", count: 3 },
        { selector: "[data-testid^='city-delete-']", count: 3 },
      ]);
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
