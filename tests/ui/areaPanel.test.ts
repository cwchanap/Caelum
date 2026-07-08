import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AreaPanel from "../../src/components/hud/panels/AreaPanel.svelte";

describe("AreaPanel", () => {
  it("renders the six zones and reports selection", async () => {
    const onSetArea = vi.fn();
    render(AreaPanel, { props: { selectedArea: null, onSetArea } });

    for (const label of [
      "Residential",
      "Commercial",
      "Industrial",
      "Office",
      "Civic",
      "Park",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }

    await fireEvent.click(screen.getByRole("button", { name: "Commercial" }));
    expect(onSetArea).toHaveBeenCalledWith("commercial");
  });

  it("marks the selected zone active", () => {
    render(AreaPanel, {
      props: { selectedArea: "office", onSetArea: vi.fn() },
    });
    expect(screen.getByRole("button", { name: "Office" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
