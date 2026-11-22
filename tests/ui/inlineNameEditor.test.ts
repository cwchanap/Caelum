import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import InlineNameEditor from "../../src/components/city/InlineNameEditor.svelte";

function renderEditor(
  overrides: Partial<{
    value: string;
    label: string;
    disabled: boolean;
    testId: string;
  }> = {},
) {
  const onCommit = vi.fn();
  render(InlineNameEditor, {
    props: {
      value: "Harbour Bus",
      label: "Rename Harbour Bus",
      disabled: false,
      testId: "route-name-route-bus-001",
      onCommit,
      ...overrides,
    },
  });
  return { onCommit };
}

async function openEditor() {
  const { onCommit } = renderEditor();
  await fireEvent.click(
    screen.getByRole("button", { name: "Rename Harbour Bus" }),
  );
  const input = screen.getByTestId(
    "route-name-route-bus-001",
  ) as HTMLInputElement;
  return { onCommit, input };
}

describe("InlineNameEditor", () => {
  it("shows the value in the display with no input until the pencil activates it", () => {
    renderEditor();

    const display = screen.getByTestId("route-name-route-bus-001");
    expect(display).not.toHaveProperty("value");
    expect(display).toHaveTextContent("Harbour Bus");
    expect(
      screen.getByRole("button", { name: "Rename Harbour Bus" }),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("focuses the input pre-filled with the current value upon activation", async () => {
    const { input } = await openEditor();

    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveValue("Harbour Bus");
    expect(document.activeElement).toBe(input);
  });

  it("commits the trimmed value once when Enter is followed by blur", async () => {
    const { onCommit, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "  Harbour Express  " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits the trimmed value once on blur alone", async () => {
    const { onCommit, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Renamed" } });
    await fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Renamed");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("ignores a whitespace-only or unchanged name without committing", async () => {
    const { onCommit } = renderEditor();
    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Bus" }),
    );
    let input = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "   " } });
    await fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Bus" }),
    );
    input = screen.getByTestId("route-name-route-bus-001") as HTMLInputElement;
    await fireEvent.input(input, {
      target: { value: "  Harbour Bus  " },
    });
    await fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("restores the canonical value on Escape without propagating the key", async () => {
    const { onCommit, input } = await openEditor();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);

    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(windowEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("route-name-route-bus-001")).toHaveTextContent(
      "Harbour Bus",
    );
    window.removeEventListener("keydown", windowEscape);
  });

  it("disables the pencil and never opens the editor when disabled", async () => {
    const { onCommit } = renderEditor({ disabled: true });
    const pencil = screen.getByRole("button", { name: "Rename Harbour Bus" });

    expect(pencil).toBeDisabled();
    await fireEvent.click(pencil);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
