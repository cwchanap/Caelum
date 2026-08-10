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

  it("blocks every conflicting activation while a route draft pins Lines", async () => {
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
    const build = screen.getByRole("button", { name: "Build" });
    expect(build.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(build);
    await fireEvent.click(screen.getByRole("button", { name: "Demolish" }));
    expect(onSetDestination).not.toHaveBeenCalled();
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
