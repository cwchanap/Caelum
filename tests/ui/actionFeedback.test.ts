import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ActionFeedback from "../../src/components/ActionFeedback.svelte";
import type { ShellActionFeedback } from "../../src/runtime/types";

function feedback(
  overrides: Partial<ShellActionFeedback> = {},
): ShellActionFeedback {
  return {
    source: "roadImpact",
    tone: "info",
    message: "Preview cost $1,200",
    details: [],
    dismissible: false,
    announce: false,
    ...overrides,
  };
}

describe("ActionFeedback", () => {
  it("keeps the live-region slot mounted but empty when feedback is null", () => {
    render(ActionFeedback, { props: { feedback: null, onDismiss: vi.fn() } });
    expect(screen.getByTestId("action-feedback-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("action-feedback")).toBeNull();
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

    const slot = screen.getByTestId("action-feedback-slot");
    expect(slot).toHaveAttribute("role", "status");
    expect(slot).toHaveAttribute("aria-live", "polite");
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

    const slot = screen.getByTestId("action-feedback-slot");
    expect(slot).not.toHaveAttribute("role");
    expect(slot).not.toHaveAttribute("aria-live");
    const view = screen.getByTestId("action-feedback");
    expect(view).toHaveAttribute("data-source", "roadHostError");
    expect(view).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("renders every material-impact detail", () => {
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          details: ["Loop 1 will reroute", "Metro A will become broken"],
        }),
        onDismiss: vi.fn(),
      },
    });

    expect(screen.getByRole("list")).toHaveTextContent("Loop 1 will reroute");
    expect(screen.getByRole("list")).toHaveTextContent(
      "Metro A will become broken",
    );
  });

  it("renders duplicate material-impact detail labels without crashing", () => {
    render(ActionFeedback, {
      props: {
        feedback: feedback({
          details: ["Loop 1 will reroute", "Loop 1 will reroute"],
        }),
        onDismiss: vi.fn(),
      },
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
