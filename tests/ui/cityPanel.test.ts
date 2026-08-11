import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CityPanel from "../../src/components/hud/panels/CityPanel.svelte";
import type { CitySummary } from "../../src/persistence/citySaveStore";
import type { ShellCityState } from "../../src/runtime/types";

const shell = {
  title: "Standard Sandbox",
  template: "Crossroads",
  simulation: "Running",
  population: "128",
  lineCount: "3",
  networkSummary: "4 late · 2 unserved",
} satisfies ShellCityState;

const activeCity = {
  id: "city-1",
  name: "Harbour Loop",
  createdAt: "2026-08-10T12:00:00.000Z",
  savedAt: "2026-08-10T13:00:00.000Z",
} satisfies CitySummary;

describe("CityPanel", () => {
  it("renders the active city, save status, and every overview field", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: false,
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Harbour Loop",
    );
    expect(screen.getByTestId("city-save-status")).toHaveAttribute(
      "data-dirty",
      "false",
    );
    expect(screen.getByText("Standard Sandbox")).toBeVisible();
    expect(screen.getByText("Crossroads")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText("128")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("4 late · 2 unserved")).toBeVisible();
    for (const label of [
      "Template",
      "Simulation",
      "Population",
      "Lines",
      "Network",
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("shows a switching hint when the active city has unsaved changes", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: true,
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.getByTestId("city-switch-hint")).toHaveTextContent(
      "Pause and Save before switching cities.",
    );
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
  });

  it("hides the switching hint when the active city is clean", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: false,
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.queryByTestId("city-switch-hint")).toBeNull();
    expect(screen.getByRole("button", { name: "New City" })).toBeEnabled();
  });
});
