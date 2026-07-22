import { describe, expect, it } from "vitest";
import { createUiState } from "../../src/ui/uiState";

describe("createUiState road UX defaults", () => {
  it("defaults roadPreset to twoWay, compact roundabout size, and drag to null", () => {
    const ui = createUiState();
    expect(ui.roadPreset).toBe("twoWay");
    expect(ui.roundaboutSize).toBe("compact2x2");
    expect(ui.drag).toBeNull();
    expect(ui.selectedArea).toBeNull();
  });
});

describe("createUiState build menu defaults", () => {
  it("defaults buildCategory to null", () => {
    const ui = createUiState();
    expect(ui.buildCategory).toBeNull();
  });
});
