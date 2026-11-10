import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { areaColors, colors } from "../../src/render/colors";
import { parseColor } from "../../src/render/webgpu/primitives";

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const styles = readSource("../../src/styles.css");
const main = readSource("../../src/main.ts");
const indexHtml = readSource("../../index.html");
const shelfSource = readSource("../../src/components/hud/CommandShelf.svelte");
const panelSource = readSource("../../src/components/hud/CommandPanel.svelte");
const plateGridSource = readSource(
  "../../src/components/hud/CommandPlateGrid.svelte",
);
const buildSource = readSource(
  "../../src/components/hud/panels/BuildPanel.svelte",
);

const hudSources = [
  shelfSource,
  panelSource,
  plateGridSource,
  buildSource,
].join("\n");

function rgbOf(value: string): [number, number, number] {
  const [r, g, b] = parseColor(value);
  return [r, g, b];
}

function hueOf(value: string): number {
  const [r, g, b] = rgbOf(value);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function lightnessOf(value: string): number {
  const [r, g, b] = rgbOf(value);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360;
  return distance > 180 ? 360 - distance : distance;
}

function blockFor(selector: string): string {
  const match = styles.match(
    new RegExp(`${selector.replace(/[.*]/g, "\\$&")}\\s*{([^}]*)}`),
  );
  return match?.[1] ?? "";
}

describe("sunny diorama visual foundation", () => {
  it("retires the colour-specific console tokens for role names", () => {
    const callers = `${styles}\n${hudSources}`;
    for (const legacy of [
      "--cyan",
      "--amber",
      "--magenta",
      "--lime",
      "--bg-deep",
      "--font-mono",
    ]) {
      expect(callers).not.toContain(`${legacy}:`);
      expect(callers).not.toContain(`var(${legacy}`);
    }
    for (const role of [
      "--accent:",
      "--accent-warm:",
      "--warning:",
      "--danger:",
      "--surface:",
      "--ink:",
      "--bg:",
      "--font-body:",
      "--font-display:",
    ]) {
      expect(styles).toContain(role);
    }
    expect(styles).toContain('"Inter"');
    expect(styles).not.toContain("TRANSIT OPERATIONS CONSOLE");
    expect(styles).not.toContain("Dark mode only");
  });

  it("keeps essential labels on readable ink", () => {
    for (const selector of [
      ".readout-label",
      ".brief-id",
      ".dispatch-key",
      ".platform-empty",
    ]) {
      const block = blockFor(selector);
      expect(block).not.toContain("--ink-faint");
      expect(block).toContain("--ink-mid");
    }
  });

  it("applies the display face to existing headings", () => {
    for (const selector of [
      ".new-city-card h1",
      ".city-library-card h1",
      ".build-nav h3",
    ]) {
      const block = blockFor(selector);
      expect(block).toContain("font-family: var(--font-display)");
      expect(block).toContain("font-weight: 600");
    }
  });

  it("sweeps the dark-console colour literals", () => {
    for (const literal of [
      "#050a0c",
      "#0a1013",
      "#0d171b",
      "#111d22",
      "#071013",
      "#e8eef0",
      "#e6f1f4",
      "#9aaeb6",
      "rgba(63, 224, 197",
      "rgba(255, 182, 39",
      "rgba(255, 77, 138",
      "rgba(255, 91, 91",
      "rgba(17, 24, 32",
      "rgba(5, 10, 12",
      "rgba(154, 174, 182",
    ]) {
      expect(styles).not.toContain(literal);
    }
    for (const literal of [
      "#111d22",
      "#0d161a",
      "#e6f1f4",
      "#9aaeb6",
      "#3fe0c5",
      "#ff5b5b",
      "rgba(63, 224, 197",
      "rgba(255, 255, 255, 0.",
    ]) {
      expect(hudSources).not.toContain(literal);
    }
  });

  it("bundles only the required static font weights offline", () => {
    const fontImports = (main.match(/@fontsource\/[^"']+/g) ?? []).sort();
    expect(fontImports).toEqual([
      "@fontsource/bricolage-grotesque/600.css",
      "@fontsource/inter/400.css",
      "@fontsource/inter/600.css",
    ]);
    expect(indexHtml).toContain("<title>Caelum</title>");
    expect(indexHtml).not.toContain("fonts.googleapis");
    expect(indexHtml).not.toContain("fonts.gstatic");
  });

  it("defines the four css primitives", () => {
    for (const primitive of [".btn", ".card", ".chip", ".segmented"]) {
      expect(styles).toMatch(new RegExp(`\\${primitive}[\\s,{]`));
    }
    expect(styles).not.toMatch(/\.(field|input)(?=[\s,{])/);
  });

  it("points the gpu palette at the sunny diorama direction", () => {
    const grass = hueOf(colors.empty);
    const residential = hueOf(areaColors.residential);
    const houseRoof = hueOf(colors.buildingHouse);
    const park = hueOf(areaColors.park);
    const canopy = hueOf(colors.treeCanopy);

    // Warm light grass keeps the map bright.
    expect(lightnessOf(colors.empty)).toBeGreaterThan(0.6);

    // Residential lots and house roofs lean terracotta, never grass/tree hues.
    expect(hueDistance(residential, grass)).toBeGreaterThan(50);
    expect(hueDistance(residential, canopy)).toBeGreaterThan(80);
    expect(hueDistance(houseRoof, grass)).toBeGreaterThan(50);
    expect(hueDistance(houseRoof, canopy)).toBeGreaterThan(80);

    // Park lots read as a distinct green beside the grass hue.
    expect(hueDistance(park, grass)).toBeGreaterThan(15);

    // Tree canopies stay a darker green than park lots.
    expect(lightnessOf(colors.treeCanopy)).toBeLessThan(
      lightnessOf(areaColors.park),
    );

    // Office, commercial, industrial and civic zones stay distinguishable.
    const zoneHues = [
      areaColors.office,
      areaColors.commercial,
      areaColors.industrial,
      areaColors.civic,
    ].map(hueOf);
    for (let a = 0; a < zoneHues.length; a += 1) {
      for (let b = a + 1; b < zoneHues.length; b += 1) {
        expect(hueDistance(zoneHues[a], zoneHues[b])).toBeGreaterThan(30);
      }
    }
  });

  it("lifts the transient cursor badge above the legend layer only", () => {
    const raised = styles.match(
      /\.map-text-overlay:has\(\[data-kind="cursorBadge"\]\)\s*{([^}]*)}/,
    );
    const legendZ = Number(
      blockFor(".overlay-legend").match(/z-index:\s*(\d+)/)?.[1],
    );
    const zoomZ = Number(
      blockFor(".board-zoom").match(/z-index:\s*(\d+)/)?.[1],
    );
    const badgeZ = Number(raised?.[1]?.match(/z-index:\s*(\d+)/)?.[1]);
    expect(badgeZ).toBeGreaterThan(legendZ);
    expect(badgeZ).toBeLessThan(zoomZ);
  });

  it("keeps the selected segmented option styled while hovered", () => {
    const hover = styles.match(
      /\.segmented button:hover:not\(:disabled, \.active\)\s*{([^}]*)}/,
    );
    const active = blockFor(".segmented button.active");
    expect(hover?.[1]).toContain("--surface");
    expect(active).toContain("--accent-warm");
  });
});
