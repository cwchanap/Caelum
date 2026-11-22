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
  const props = {
    value: "Harbour Bus",
    label: "Rename Harbour Bus",
    disabled: false,
    testId: "route-name-route-bus-001",
    onCommit,
    ...overrides,
  };
  const { rerender } = render(InlineNameEditor, { props });
  return {
    onCommit,
    rerender: (next: Partial<typeof props>) => rerender({ ...props, ...next }),
  };
}

async function openEditor() {
  const { onCommit, rerender } = renderEditor();
  await fireEvent.click(
    screen.getByRole("button", { name: "Rename Harbour Bus" }),
  );
  const input = screen.getByTestId(
    "route-name-route-bus-001",
  ) as HTMLInputElement;
  return { onCommit, rerender, input };
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

  it("holds an open editor's Enter while busy and submits it once idle", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    // An autosave starts while the editor is already open.
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // The submission is held, not discarded: the editor stays open with the
    // draft and nothing is committed while the parent is busy.
    expect(onCommit).not.toHaveBeenCalled();
    const held = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    expect(held).toBe(input);
    expect(held).toHaveValue("Harbour Express");

    // The parent goes idle; the held submission lands.
    await rerender({ disabled: false });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("holds an open editor's blur while busy and submits it once idle", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, {
      target: { value: "  Renamed While Busy  " },
    });
    await rerender({ disabled: true });
    await fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    const held = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    expect(held).toBe(input);
    expect(held).toHaveValue("  Renamed While Busy  ");

    await rerender({ disabled: false });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Renamed While Busy");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("drops a held submission when the user edits again, and lands only a fresh explicit submission", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // The user refocuses the still-open input and revises the name; the
    // deferred submission must not fire for the abandoned draft.
    await fireEvent.input(input, { target: { value: "Harbour Express II" } });
    await rerender({ disabled: false });

    expect(onCommit).not.toHaveBeenCalled();
    const still = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    expect(still).toBe(input);
    expect(still).toHaveValue("Harbour Express II");

    // The revised name lands only through another explicit submission.
    await fireEvent.keyDown(still, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express II");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("lets Escape cancel a submission that was held while busy", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.keyDown(input, { key: "Escape" });

    await rerender({ disabled: false });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
