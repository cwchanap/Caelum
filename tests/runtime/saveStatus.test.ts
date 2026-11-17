import { describe, expect, it } from "vitest";
import { saveStatus } from "../../src/runtime/saveStatus";
import type { RuntimePersistenceView } from "../../src/runtime/workingSaveRuntime";

const view: RuntimePersistenceView = {
  activeCity: {
    id: "1",
    name: "City",
    createdAt: "2026-01-01T00:00:00.000Z",
    savedAt: "2026-01-01T00:00:00.000Z",
  },
  busy: false,
  dirty: false,
  save: "idle",
  error: null,
};
const start = Date.parse("2026-01-01T00:00:00.000Z");

describe("saveStatus", () => {
  it("formats seconds and minutes since the last save", () => {
    expect(saveStatus(view, start + 12_000)).toEqual({
      label: "Saved 12 s ago",
      canRetry: false,
    });
    expect(saveStatus(view, start + 120_000)).toEqual({
      label: "Saved 2 min ago",
      canRetry: false,
    });
  });
  it("keeps the age when running ticks dirty the city", () => {
    expect(saveStatus({ ...view, dirty: true }, start + 5_000).label).toBe(
      "Saved 5 s ago",
    );
  });
  it("offers retry after a failure", () => {
    expect(saveStatus({ ...view, save: "failed" }, start)).toEqual({
      label: "Couldn't save",
      canRetry: true,
    });
  });
  it("prioritizes saving over other busy work", () => {
    expect(saveStatus({ ...view, save: "saving", busy: true }, start)).toEqual({
      label: "Saving…",
      canRetry: false,
    });
  });
});
