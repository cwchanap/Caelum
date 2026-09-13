import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import MapTextOverlay from "../../src/components/MapTextOverlay.svelte";
import { tileSize } from "../../src/render/boardTransform";
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
) {
  pinOverlayBox();
  const mergedUi = { ...createUiState(), ...ui };
  const result = render(MapTextOverlay, {
    props: { state, ui: mergedUi },
  });
  await tick();
  return result;
}

describe("MapTextOverlay", () => {
  it("renders no labels for a resting inspect state", async () => {
    await renderOverlay();
    const overlay = screen.getByTestId("map-text-overlay");
    expect(overlay.querySelectorAll(".map-text-item")).toHaveLength(0);
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
  });

  it("renders road preview feedback anchored to the preview tiles", async () => {
    const ui: Partial<UiState> = {
      activeTool: "road",
      hoverTile: { x: 1, y: 4 },
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
      '.map-text-item[data-kind="roadPreview"]',
    ) as HTMLElement;
    expect(feedback).not.toBeNull();
    expect(feedback.textContent).toContain("$96");
    expect(feedback.style.left).toBe(`${1 * tileSize + tileSize / 2}px`);
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
