import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

function createRuntimeStub() {
  return {
    getSnapshot: () => ({
      shell: {
        topbar: { budget: "$120,000", signalState: "Live" },
        controlTower: { title: "Growing Suburb", controlTowerOpen: true }
      }
    }),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn()
  };
}

describe("App shell bootstrap", () => {
  it("renders the Svelte shell and canvas host", () => {
    render(App, { props: { runtime: createRuntimeStub() } });

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  });

  it("renders error state when bootstrap fails", () => {
    render(App, { props: { runtime: createRuntimeStub(), error: "Bootstrap failed" } });

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("Bootstrap failed");

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("control-tower")).toBeNull();
  });
});
