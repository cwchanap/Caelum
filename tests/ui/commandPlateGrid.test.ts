import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPlateGrid from "../../src/components/hud/CommandPlateGrid.svelte";

const plates = [
  { id: "roads", label: "Roads", image: "/roads.webp" },
  { id: "transit", label: "Transit", image: "/transit.webp" },
  { id: "zones", label: "Zones", image: "/zones.webp" },
  { id: "buildings", label: "Buildings", image: "/buildings.webp" },
] as const;

describe("CommandPlateGrid", () => {
  it("renders decorative artwork with visible command labels", () => {
    const { container } = render(CommandPlateGrid, {
      props: { plates, onSelect: vi.fn() },
    });
    expect(
      container.querySelectorAll('img[alt=""][aria-hidden="true"]'),
    ).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Roads" })).toBeTruthy();
  });

  it("moves focus in the corresponding row or column with arrow keys", async () => {
    render(CommandPlateGrid, { props: { plates, onSelect: vi.fn() } });
    const roads = screen.getByRole("button", { name: "Roads" });
    const transit = screen.getByRole("button", { name: "Transit" });
    const zones = screen.getByRole("button", { name: "Zones" });
    const buildings = screen.getByRole("button", { name: "Buildings" });

    roads.focus();
    await fireEvent.keyDown(roads, { key: "ArrowRight" });
    expect(transit).toHaveFocus();
    await fireEvent.keyDown(transit, { key: "ArrowDown" });
    expect(buildings).toHaveFocus();
    await fireEvent.keyDown(buildings, { key: "ArrowLeft" });
    expect(zones).toHaveFocus();
    await fireEvent.keyDown(zones, { key: "ArrowUp" });
    expect(roads).toHaveFocus();

    for (const button of [roads, transit, zones, buildings]) {
      expect(button).not.toHaveAttribute("tabindex");
    }
  });

  it("keeps focus in place when an arrow has no neighbor at a grid edge", async () => {
    render(CommandPlateGrid, { props: { plates, onSelect: vi.fn() } });
    const roads = screen.getByRole("button", { name: "Roads" });
    const transit = screen.getByRole("button", { name: "Transit" });
    const zones = screen.getByRole("button", { name: "Zones" });
    const buildings = screen.getByRole("button", { name: "Buildings" });

    // Left edge: ArrowLeft from column 0 must not wrap to column 1.
    roads.focus();
    await fireEvent.keyDown(roads, { key: "ArrowLeft" });
    expect(roads).toHaveFocus();

    // Right edge: ArrowRight from column 1 must not wrap to column 0.
    transit.focus();
    await fireEvent.keyDown(transit, { key: "ArrowRight" });
    expect(transit).toHaveFocus();

    // Top edge: ArrowUp from row 0 must not wrap to row 1.
    roads.focus();
    await fireEvent.keyDown(roads, { key: "ArrowUp" });
    expect(roads).toHaveFocus();

    // Bottom edge: ArrowDown from row 1 must not wrap to row 0.
    zones.focus();
    await fireEvent.keyDown(zones, { key: "ArrowDown" });
    expect(zones).toHaveFocus();
    buildings.focus();
    await fireEvent.keyDown(buildings, { key: "ArrowDown" });
    expect(buildings).toHaveFocus();
  });
});
