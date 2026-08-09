import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import CityPanel from "../../src/components/hud/panels/CityPanel.svelte";
import type { ShellCityState } from "../../src/runtime/types";

const city = {
  title: "Standard Sandbox",
  template: "Crossroads",
  simulation: "Running",
  population: "128",
  lineCount: "3",
  networkSummary: "4 late · 2 unserved",
} satisfies ShellCityState;

describe("CityPanel", () => {
  it("renders the selected city heading and every overview field", () => {
    render(CityPanel, { props: { shell: city, cityName: "Harbour Loop" } });

    expect(screen.getByRole("heading", { name: "Harbour Loop" })).toBeVisible();
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

  it("falls back to the shell title when no city name is active", () => {
    render(CityPanel, { props: { shell: city, cityName: null } });

    expect(
      screen.getByRole("heading", { name: "Standard Sandbox" }),
    ).toBeVisible();
  });

  it("does not expose campaign or persistence controls", () => {
    render(CityPanel, { props: { shell: city, cityName: "Harbour Loop" } });

    for (const label of [
      "Objective",
      "Note",
      "Wave",
      "Win",
      "Loss",
      "Save",
      "Load",
      "Rename",
      "Delete",
    ]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
      expect(screen.queryByText(label, { exact: true })).toBeNull();
    }
  });
});
