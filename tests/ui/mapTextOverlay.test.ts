import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import MapTextOverlay from "../../src/components/MapTextOverlay.svelte";
import { tileSize, type Camera } from "../../src/render/boardTransform";
import {
  addTestBusRoute,
  addTestBusStop,
  createTestGameState,
} from "../helpers/gameState";
import { createDraft } from "../../src/ui/routeDraft";
import { createUiState, type UiState } from "../../src/ui/uiState";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// Pin the overlay's measured CSS box so the board transform is identity:
// CSS position = world pixels (DPR 1, map fills the box exactly).
function pinOverlayBox(): void {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(
    28 * tileSize,
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(
    18 * tileSize,
  );
}

async function renderOverlay(
  state = createTestGameState(),
  ui?: Partial<UiState>,
  camera: Camera | null = null,
) {
  pinOverlayBox();
  const mergedUi = { ...createUiState(), ...ui };
  const result = render(MapTextOverlay, {
    props: { state, ui: mergedUi, camera },
  });
  await tick();
  return result;
}

describe("MapTextOverlay", () => {
  it("renders no labels for a resting inspect state", async () => {
    await renderOverlay();
    const overlay = screen.getByTestId("map-text-overlay");
    expect(overlay.querySelectorAll(".map-text-item")).toHaveLength(0);
    expect(screen.queryByTestId("map-text-cursor-readout")).toBeNull();
  });

  it("renders the armed-tool cursor badge above the hover tile", async () => {
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 2, y: 3 },
    });

    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain("Road");
    // Tile center horizontally, tile top vertically (translate lifts it up).
    expect(badge.style.left).toBe(`${2 * tileSize + tileSize / 2}px`);
    expect(badge.style.top).toBe(`${3 * tileSize}px`);
    expect(badge.classList.contains("map-text-below")).toBe(false);
    // The short badge fits centered around its anchor, so neither edge
    // side-class applies; max-width is the room a centered label may take
    // (2 × distance to the nearer edge minus the 8px margin).
    expect(badge.classList.contains("map-text-side-left")).toBe(false);
    expect(badge.classList.contains("map-text-side-right")).toBe(false);
    expect(badge.style.maxWidth).toBe("144px");
  });

  it("flips the badge below the tile on the top row", async () => {
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 2, y: 0 },
    });

    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    // Below-placement anchors at the flipped-to tile bottom (row 0).
    expect(badge.style.top).toBe(`${tileSize}px`);
    expect(badge.classList.contains("map-text-below")).toBe(true);
    expect(badge.classList.contains("map-text-side-left")).toBe(false);
    expect(badge.classList.contains("map-text-side-right")).toBe(false);
  });

  it("flips a second-row badge whose tile is shorter than the badge", async () => {
    // Half-size box: 16px tiles, so a row-1 badge would rise past the top.
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(
      14 * tileSize,
    );
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(
      9 * tileSize,
    );
    render(MapTextOverlay, {
      props: {
        state: createTestGameState(),
        ui: {
          ...createUiState(),
          activeTool: "road",
          hoverTile: { x: 2, y: 1 },
        },
        camera: null,
      },
    });
    await tick();

    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.classList.contains("map-text-below")).toBe(true);
    expect(badge.style.top).toBe(`${tileSize}px`);
  });

  it("follows the camera and flips on the top visible row", async () => {
    // Zoom 2 on the pinned 28x18 box: 64px tiles, view origin at tile (0, 2).
    await renderOverlay(
      createTestGameState(),
      { activeTool: "road", hoverTile: { x: 2, y: 3 } },
      { zoom: 2, center: { x: 7, y: 6.5 } },
    );

    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.style.left).toBe(`${2.5 * 2 * tileSize}px`);
    expect(badge.style.top).toBe(`${(3 - 2) * 2 * tileSize}px`);
    expect(badge.classList.contains("map-text-below")).toBe(false);

    document.body.innerHTML = "";
    await renderOverlay(
      createTestGameState(),
      { activeTool: "road", hoverTile: { x: 2, y: 2 } },
      { zoom: 2, center: { x: 7, y: 6.5 } },
    );
    const topRow = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(topRow.classList.contains("map-text-below")).toBe(true);
  });

  it("renders Rust preview feedback in the cursor badge", async () => {
    const ui: Partial<UiState> = {
      activeTool: "road",
      hoverTile: { x: 4, y: 4 },
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [
          { x: 1, y: 4 },
          { x: 2, y: 4 },
        ],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 96,
        warnings: [],
        routeImpacts: [],
        rejection: null,
      },
    };
    await renderOverlay(createTestGameState(), ui);

    const feedback = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(feedback).not.toBeNull();
    expect(
      screen.getByTestId("map-text-overlay").querySelectorAll(".map-text-item"),
    ).toHaveLength(1);
    expect(feedback.textContent).toBe("⦿ Road · $96");
    expect(feedback.style.left).toBe(`${4 * tileSize + tileSize / 2}px`);
  });

  it("shows rejected preview details with warning styling", async () => {
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 4, y: 4 },
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 96,
        warnings: [],
        routeImpacts: [],
        rejection: { code: "blockedTile", context: {} },
      },
    });

    const feedback = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(feedback.textContent).toBe("⦿ Road · That tile is blocked. ⊘");
    expect(feedback.textContent).not.toContain("$96");
    expect(feedback.classList.contains("map-text-warning")).toBe(true);
    // The readout speaks the same preview in words, not glyphs.
    expect(screen.getByTestId("map-text-cursor-readout").textContent).toBe(
      "Road, That tile is blocked. Cannot place.",
    );
  });

  it("hugs the board edge side that leaves the most room for a long badge", async () => {
    const rejection = {
      generation: 1,
      changedTiles: [] as never[],
      skippedTiles: [] as never[],
      authoredTiles: [] as never[],
      generatedStructures: [] as never[],
      cost: 0,
      warnings: [] as never[],
      routeImpacts: [] as never[],
      rejection: { code: "blockedTile" as const, context: {} },
    };
    // Right edge: only 16px of room to the right, so the label ends at the
    // anchor and stretches left with a bounded max-width.
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 27, y: 4 },
      roadPreviewGeneration: 1,
      roadMutationPreview: rejection,
    });
    let badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.style.left).toBe(`${27.5 * tileSize}px`);
    expect(badge.classList.contains("map-text-side-right")).toBe(true);
    expect(badge.style.maxWidth).toBe(`${27.5 * tileSize - 8}px`);

    document.body.innerHTML = "";
    // Left edge: the mirror image — the label starts at the anchor.
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 0, y: 4 },
      roadPreviewGeneration: 1,
      roadMutationPreview: rejection,
    });
    badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.style.left).toBe(`${0.5 * tileSize}px`);
    expect(badge.classList.contains("map-text-side-left")).toBe(true);
    expect(badge.style.maxWidth).toBe(
      `${28 * tileSize - 0.5 * tileSize - 8}px`,
    );
  });

  it("mirrors the preview badge in a non-live accessible readout", async () => {
    await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 4, y: 4 },
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 1, y: 4 }],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 96,
        warnings: [],
        routeImpacts: [],
        rejection: null,
      },
    });

    // The visual badge sits inside the aria-hidden overlay; this readout
    // keeps the same preview details reachable for assistive tech without a
    // live region announcing every hover change — and speaks words, not the
    // decorative glyphs.
    const readout = screen.getByTestId("map-text-cursor-readout");
    expect(readout.closest('[aria-hidden="true"]')).toBeNull();
    expect(readout).not.toHaveAttribute("aria-live");
    expect(readout).not.toHaveAttribute("role", "status");
    expect(readout.textContent).toBe("Road, $96");
  });

  it("renders numbered route waypoints centered on their nodes", async () => {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 1, y: 1 });
    state = addTestBusStop(state, { x: 4, y: 1 });
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);

    await renderOverlay(state, {
      activeTool: "busRoute",
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001", "stop-002"],
        selectedIndex: null,
        interaction: "append",
        generation: 1,
        previewPending: false,
        preview: null,
      },
    });

    const numbers = [
      ...document.querySelectorAll('.map-text-item[data-kind="routeWaypoint"]'),
    ] as HTMLElement[];
    expect(numbers.map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(numbers[0]!.style.left).toBe(`${1 * tileSize + tileSize / 2}px`);
    expect(numbers[0]!.style.top).toBe(`${1 * tileSize + tileSize / 2}px`);
  });

  it("measures the shared board box reactively on resize", async () => {
    const { component } = await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 2, y: 3 },
    });
    void component;
    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.style.left).toBe(`${2 * tileSize + tileSize / 2}px`);
  });

  it("re-measures through ResizeObserver when the board box changes", async () => {
    // jsdom has no ResizeObserver; stub a minimal one and fire it after
    // shrinking the measured box so the transform re-derives from the new
    // CSS size.
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    pinOverlayBox();
    const { unmount } = render(MapTextOverlay, {
      props: {
        state: createTestGameState(),
        ui: {
          ...createUiState(),
          activeTool: "road",
          hoverTile: { x: 2, y: 3 },
        },
        camera: null,
      },
    });
    await tick();

    const badge = document.querySelector(
      '.map-text-item[data-kind="cursorBadge"]',
    ) as HTMLElement;
    expect(badge.style.left).toBe(`${2 * tileSize + tileSize / 2}px`);

    // Shrink the box to half the map: the transform letterboxes, so the same
    // anchor lands at a smaller left offset.
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(
      14 * tileSize,
    );
    for (const callback of callbacks) {
      callback([], {} as ResizeObserver);
    }
    await tick();
    // scale 0.5, no letterbox: left = (2 + 0.5) * 32 * 0.5.
    expect(badge.style.left).toBe("40px");

    unmount();
    vi.unstubAllGlobals();
  });

  it("tears down cleanly on unmount", async () => {
    const { unmount } = await renderOverlay(createTestGameState(), {
      activeTool: "road",
      hoverTile: { x: 2, y: 3 },
    });
    expect(() => unmount()).not.toThrow();
  });
});
