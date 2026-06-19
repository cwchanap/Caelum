import { describe, expect, it } from "vitest";
import { createUiState } from "../../src/ui/uiState";

describe("createUiState road UX defaults", () => {
  it("defaults roadPreset to twoWay and drag to null", () => {
    const ui = createUiState();
    expect(ui.roadPreset).toBe("twoWay");
    expect(ui.drag).toBeNull();
    expect(ui.selectedArea).toBeNull();
  });
});
