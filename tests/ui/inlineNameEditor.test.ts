import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import InlineNameEditor from "../../src/components/city/InlineNameEditor.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderEditor(
  overrides: Partial<{
    value: string;
    label: string;
    disabled: boolean;
    testId: string;
    entityId: string;
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
  const { rerender, unmount } = render(InlineNameEditor, { props });
  return {
    onCommit,
    unmount,
    rerender: (next: Partial<typeof props>) => rerender({ ...props, ...next }),
  };
}

async function openEditor() {
  const { onCommit, rerender, unmount } = renderEditor();
  await fireEvent.click(
    screen.getByRole("button", { name: "Rename Harbour Bus" }),
  );
  const input = screen.getByTestId(
    "route-name-route-bus-001",
  ) as HTMLInputElement;
  return { onCommit, rerender, unmount, input };
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

  it("returns focus to the Rename pencil on Escape but not on commit", async () => {
    const { onCommit, input } = await openEditor();
    expect(document.activeElement).toBe(input);

    // Cancelling unmounts the focused input; without restoration focus
    // would drop to <body>.
    await fireEvent.keyDown(input, { key: "Escape" });
    const pencil = screen.getByRole("button", { name: "Rename Harbour Bus" });
    expect(document.activeElement).toBe(pencil);

    // Re-open and commit a changed name: the Enter/blur path must not
    // steal focus to the pencil that remounts in place of the input.
    await fireEvent.click(pencil);
    const reopened = screen.getByRole("textbox", {
      name: "Rename Harbour Bus",
    });
    await fireEvent.input(reopened, { target: { value: "Harbour Express" } });
    await fireEvent.keyDown(reopened, { key: "Enter" });
    await fireEvent.blur(reopened);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");
    expect(screen.queryByRole("textbox")).toBeNull();

    // The closing input is replaced by a freshly mounted pencil node.
    const remounted = screen.getByRole("button", {
      name: "Rename Harbour Bus",
    });
    expect(remounted).not.toBe(pencil);
    expect(document.activeElement).not.toBe(remounted);
  });

  it("disables the pencil and never opens the editor when disabled", async () => {
    const { onCommit } = renderEditor({ disabled: true });
    const pencil = screen.getByRole("button", { name: "Rename Harbour Bus" });

    expect(pencil).toBeDisabled();
    await fireEvent.click(pencil);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("refuses an open editor's Enter while busy and lands it only on retry", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    // An autosave starts while the editor is already open.
    await rerender({ disabled: true });
    expect(input).toBeDisabled();
    await fireEvent.keyDown(input, { key: "Enter" });

    // The submission is refused, not queued: the editor stays open with the
    // draft and nothing is committed while the parent is busy.
    expect(onCommit).not.toHaveBeenCalled();
    const held = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    expect(held).toBe(input);
    expect(held).toHaveValue("Harbour Express");

    // Going idle replays nothing; the draft lands only on another explicit
    // submission.
    await rerender({ disabled: false });
    expect(onCommit).not.toHaveBeenCalled();
    await fireEvent.keyDown(held, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("refuses an open editor's blur while busy and lands it only on retry", async () => {
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
    expect(onCommit).not.toHaveBeenCalled();
    await fireEvent.keyDown(held, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Renamed While Busy");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("commits the latest draft, not a busy-era keystroke, once idle", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // The user revises the name; no deferred submission fires for the draft
    // that was refused while busy.
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

  it("re-opens with the draft when a commit fails so the action can retry", async () => {
    const { onCommit, input } = await openEditor();
    onCommit.mockResolvedValue(false);

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");

    // The failed commit restores the open editor with the typed draft
    // instead of silently losing it behind the closed display.
    const restored = await screen.findByRole("textbox", {
      name: "Rename Harbour Bus",
    });
    expect(restored).toHaveValue("Harbour Express");

    // Retrying the same draft lands it and the editor closes for good.
    onCommit.mockResolvedValue(true);
    await fireEvent.keyDown(restored, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith("Harbour Express");
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("stays closed when the canonical value moves before a failed commit", async () => {
    const pending = deferred<boolean>();
    const { onCommit, rerender, input } = await openEditor();
    onCommit.mockReturnValue(pending.promise);

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");

    // An external rename (or a load) moves the canonical value under the
    // in-flight commit; the stale draft must not re-open on top of it.
    await rerender({ value: "Harbour Express" });
    pending.resolve(false);

    // The blur already closed the editor; wait out the commit's promise
    // chain so a stale re-open (editing = true) would have landed before
    // asserting the draft stayed closed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("route-name-route-bus-001")).toHaveTextContent(
      "Harbour Express",
    );
  });

  it("stays closed when the entity id moves before a failed commit", async () => {
    const pending = deferred<boolean>();
    const { onCommit, rerender } = renderEditor({ entityId: "city-1" });
    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Bus" }),
    );
    const input = screen.getByTestId(
      "route-name-route-bus-001",
    ) as HTMLInputElement;
    onCommit.mockReturnValue(pending.promise);

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("Harbour Express");

    await rerender({ entityId: "city-2" });
    pending.resolve(false);

    // Same settle: the commit's promise chain must finish before the
    // stayed-closed assertion means anything.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("ignores IME composing Enter and Escape without submitting, closing, or propagating Escape", async () => {
    const { onCommit, input } = await openEditor();
    const windowEscape = vi.fn();
    const onWindowKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") windowEscape(event);
    };
    window.addEventListener("keydown", onWindowKeydown);

    await fireEvent.input(input, { target: { value: "Tokyo" } });
    await fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeEvent);

    expect(onCommit).not.toHaveBeenCalled();
    expect(windowEscape).not.toHaveBeenCalled();
    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(screen.getByTestId("route-name-route-bus-001")).toBe(input);
    expect(document.activeElement).toBe(input);
    window.removeEventListener("keydown", onWindowKeydown);
  });

  it("lets Escape close the editor while busy, discarding the draft", async () => {
    const { onCommit, rerender, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(input);

    await fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await rerender({ disabled: false });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    // The remounted pencil was disabled while busy, so Escape could not
    // return focus to it — focus is not left on the pencil.
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Rename Harbour Bus" }),
    );
  });

  it("never applies a busy-era keystroke after the component unmounts", async () => {
    const { onCommit, rerender, unmount, input } = await openEditor();

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await rerender({ disabled: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // Unmounting while a refused submission would still be pending commits
    // nothing — there is no deferred path to land.
    unmount();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
