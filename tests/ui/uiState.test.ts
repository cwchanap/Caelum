import { describe, expect, it } from "vitest";
import { createUiState } from "../../src/ui/uiState";

describe("createUiState road UX defaults", () => {
  it("defaults roadPreset to twoWay and dragStart to null", () => {
    const ui = createUiState();
    expect(ui.roadPreset).toBe("twoWay");
    expect(ui.dragStart).toBeNull();
  });
});
