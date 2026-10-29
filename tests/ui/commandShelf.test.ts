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
    ).toEqual(["BuildB", "Lines2", "Data", "City"]);
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Demolish" })).toBeTruthy();
  });

  it("shows matching shortcut chips and preserves the buttons' accessible names", () => {
    render(CommandShelf, {
      props: {
        command,
        onSetDestination: vi.fn(),
        onSetTool: vi.fn(),
      },
    });

    const build = screen.getByTestId("command-destination-build");
    expect(build).toHaveAccessibleName("Build");
    expect(build).toHaveAttribute("aria-keyshortcuts", "b");
    expect(build).toHaveAttribute("title", "Build (B)");
    expect(build.querySelector(".command-shelf__shortcut")).toHaveTextContent(
      "B",
    );

    const select = screen.getByTestId("command-tool-select");
    expect(select).toHaveAccessibleName("Select");
    expect(select).toHaveAttribute("aria-keyshortcuts", "v");
    expect(select).toHaveAttribute("title", "Select (V)");
    expect(select.querySelector(".command-shelf__shortcut")).toHaveTextContent(
      "V",
    );

    const demolish = screen.getByTestId("command-tool-demolish");
    expect(demolish).toHaveAccessibleName("Demolish");
    expect(demolish).toHaveAttribute("aria-keyshortcuts", "d");
    expect(demolish).toHaveAttribute("title", "Demolish (D)");
    expect(
      demolish.querySelector(".command-shelf__shortcut"),
    ).toHaveTextContent("D");

    expect(screen.getByTestId("command-destination-lines")).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
    expect(screen.getByTestId("command-destination-data")).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
    expect(screen.getByTestId("command-destination-city")).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
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
