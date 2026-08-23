import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CommandShelf from "../../src/components/hud/CommandShelf.svelte";

const command = {
  activeDestination: null,
  activeModeLabel: "SELECT",
  routeDraftActive: false,
  selectActive: true,
  demolishActive: false,
  lineCount: 2,
  activeOverlayLabel: null,
} as const;

describe("CommandShelf", () => {
  it("renders exactly four destinations plus Select and Demolish", () => {
    render(CommandShelf, {
      props: {
        command,
        onSetDestination: vi.fn(),
        onSetTool: vi.fn(),
      },
    });
    expect(
      screen
        .getAllByTestId(/^command-destination-/)
        .map((node) => node.textContent?.trim()),
    ).toEqual(["Build", "Lines2", "Data", "City"]);
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Demolish" })).toBeTruthy();
  });

  it("keeps Lines operable while gating every other command during a route draft", async () => {
    const onSetDestination = vi.fn();
    const onSetTool = vi.fn();
    render(CommandShelf, {
      props: {
        command: {
          ...command,
          activeDestination: "lines",
          routeDraftActive: true,
        },
        onSetDestination,
        onSetTool,
      },
    });

    for (const label of ["Build", "Data", "City"]) {
      const destination = screen.getByRole("button", { name: label });
      expect(destination.getAttribute("aria-disabled")).toBe("true");
      await fireEvent.click(destination);
    }
    for (const label of ["Select", "Demolish"]) {
      const tool = screen.getByRole("button", { name: label });
      expect(tool.getAttribute("aria-disabled")).toBe("true");
      await fireEvent.click(tool);
    }

    const lines = screen.getByTestId("command-destination-lines");
    expect(lines.getAttribute("aria-disabled")).toBeNull();
    await fireEvent.click(lines);
    expect(onSetDestination).toHaveBeenCalledTimes(1);
    expect(onSetDestination).toHaveBeenCalledWith(null);
    expect(onSetTool).not.toHaveBeenCalled();
  });

  it("keeps destination labels accessible", () => {
    render(CommandShelf, {
      props: {
        command,
        onSetDestination: vi.fn(),
        onSetTool: vi.fn(),
      },
    });

    for (const label of ["Build", "Lines", "Data", "City"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(label) }),
      ).toHaveAccessibleName(expect.stringContaining(label));
    }
  });
});
