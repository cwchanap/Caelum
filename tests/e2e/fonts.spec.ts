import { expect, test } from "@playwright/test";
import { createDefaultCity } from "./helpers";

test("loads bundled Bricolage and Inter faces from the app origin only", async ({
  page,
}) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "font" ||
      /\.(woff2?|ttf|otf)([?#]|$)/.test(request.url())
    ) {
      fontRequests.push(request.url());
    }
  });

  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();

  const proof = await page.evaluate(async () => {
    await document.fonts.ready;
    const required = [
      {
        spec: '600 16px "Bricolage Grotesque"',
        family: "Bricolage Grotesque",
        weight: "600",
      },
      { spec: "16px Inter", family: "Inter", weight: "400" },
      { spec: "600 16px Inter", family: "Inter", weight: "600" },
    ];
    const registered = [...document.fonts];
    const faces = required.map((entry) => {
      const matches = registered.filter(
        (face) => face.family === entry.family && face.weight === entry.weight,
      );
      return {
        ...entry,
        registered: matches.length,
        loaded: matches.filter((face) => face.status === "loaded").length,
      };
    });
    const loadedFaces = await Promise.all(
      required.map((entry) => document.fonts.load(entry.spec)),
    );

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("2d canvas context unavailable for font measurement");
    }
    const sample = "Sunny Diorama 0123456789";
    const measure = (font: string): number => {
      context.font = font;
      return context.measureText(sample).width;
    };

    return {
      faces,
      matched: loadedFaces.map((list) => list.map((face) => face.status)),
      checkBricolage: document.fonts.check('600 16px "Bricolage Grotesque"'),
      checkInter: document.fonts.check("16px Inter"),
      widths: {
        bricolage: measure('600 16px "Bricolage Grotesque"'),
        inter: measure("16px Inter"),
        fallback: measure("16px monospace"),
      },
    };
  });

  for (const face of proof.faces) {
    expect(
      face.registered,
      `${face.family} ${face.weight} must be registered`,
    ).toBeGreaterThan(0);
    expect(
      face.loaded,
      `${face.family} ${face.weight} must finish loading`,
    ).toBeGreaterThan(0);
  }
  for (const [index, statuses] of proof.matched.entries()) {
    const spec = proof.faces[index]?.spec ?? `#${index}`;
    expect(
      statuses.length,
      `document.fonts.load must match a bundled face for ${spec}`,
    ).toBeGreaterThan(0);
    expect(
      statuses.every((status) => status === "loaded"),
      `matched faces for ${spec} must finish loading`,
    ).toBe(true);
  }
  expect(proof.checkBricolage).toBe(true);
  expect(proof.checkInter).toBe(true);
  expect(
    Math.abs(proof.widths.bricolage - proof.widths.fallback),
    "Bricolage must measure differently from the generic fallback",
  ).toBeGreaterThan(0.5);
  expect(
    Math.abs(proof.widths.inter - proof.widths.fallback),
    "Inter must measure differently from the generic fallback",
  ).toBeGreaterThan(0.5);

  const appOrigin = new URL(page.url()).origin;
  expect(
    fontRequests.length,
    "expected at least one bundled font request",
  ).toBeGreaterThan(0);
  for (const url of fontRequests) {
    expect(
      new URL(url).origin,
      `font request stayed on the app origin: ${url}`,
    ).toBe(appOrigin);
  }
});
