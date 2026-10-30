import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ActionFeedback from "../../src/components/ActionFeedback.svelte";
import type { ShellActionFeedback } from "../../src/runtime/types";

function feedback(
  overrides: Partial<ShellActionFeedback> = {},
): ShellActionFeedback {
  return {
    source: "rejection",
    tone: "error",
    message: "Gameplay rejected.",
    details: [],
    dismissible: false,
    announce: false,
    ...overrides,
  };
}

describe("ActionFeedback", () => {
  it("keeps the live-region slot and announcement node mounted but empty when feedback is null", () => {
    render(ActionFeedback, { props: { feedback: null, onDismiss: vi.fn() } });
    expect(screen.getByTestId("action-feedback-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("action-feedback")).toBeNull();
    const announce = screen.getByTestId("action-feedback-announce");
    expect(announce).toHaveAttribute("role", "status");
    expect(announce).toHaveAttribute("aria-live", "polite");
    expect(announce).toHaveTextContent("");
  });

  it("announces and dismisses gameplay rejection feedback", async () => {
    const onDismiss = vi.fn();
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          source: "rejection",
          tone: "error",
          message: "Needs $1,200; only $0 is available.",
          dismissible: true,
          announce: true,
        }),
        onDismiss,
      },
    });

    const announce = screen.getByTestId("action-feedback-announce");
    expect(announce).toHaveAttribute("role", "status");
    expect(announce).toHaveAttribute("aria-live", "polite");
    expect(announce).toHaveTextContent("Needs $1,200; only $0 is available.");
    const view = screen.getByTestId("action-feedback");
    expect(view).toHaveAttribute("data-source", "rejection");
    expect(view).toHaveAttribute("data-tone", "error");
    expect(view).toHaveTextContent("Needs $1,200; only $0 is available.");
    expect(view.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps continuous road hover feedback non-live", () => {
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          source: "roadHostError",
          tone: "warning",
          message: "Road preview unavailable: host timed out",
        }),
        onDismiss: vi.fn(),
      },
    });

    const announce = screen.getByTestId("action-feedback-announce");
    expect(announce).toHaveAttribute("role", "status");
    expect(announce).toHaveAttribute("aria-live", "polite");
    expect(announce).toHaveTextContent("");
    const view = screen.getByTestId("action-feedback");
    expect(view).toHaveAttribute("data-source", "roadHostError");
    expect(view).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("announces details alongside the message for announced feedback", () => {
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          source: "roadDirection",
          tone: "warning",
          message: "Road set to one-way North. Click again to cycle direction.",
          details: ["Shuttle A became broken after this direction change."],
          dismissible: true,
          announce: true,
        }),
        onDismiss: vi.fn(),
      },
    });

    const announce = screen.getByTestId("action-feedback-announce");
    expect(announce).toHaveTextContent(
      "Road set to one-way North. Click again to cycle direction.",
    );
    expect(announce).toHaveTextContent(
      "Shuttle A became broken after this direction change.",
    );
  });

  it("renders duplicate detail entries individually", () => {
    // Route names are not unique: two lines can share a name, so the detail
    // list must not dedupe identical strings.
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          source: "rejection",
          tone: "error",
          message: "Road removal rejected.",
          details: [
            "Downtown Loop became broken after this change.",
            "Downtown Loop became broken after this change.",
          ],
        }),
        onDismiss: vi.fn(),
      },
    });

    const view = screen.getByTestId("action-feedback");
    const items = view.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Downtown Loop became broken");
    expect(items[1]).toHaveTextContent("Downtown Loop became broken");
  });
});
