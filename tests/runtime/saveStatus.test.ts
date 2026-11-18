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
  it("formats seconds, minutes, hours, and days since the last save", () => {
    expect(saveStatus(view, start + 12_000)).toEqual({
      label: "Saved 12 s ago",
      canRetry: false,
    });
    expect(saveStatus(view, start + 120_000)).toEqual({
      label: "Saved 2 min ago",
      canRetry: false,
    });
    expect(saveStatus(view, start + 3 * 3_600_000)).toEqual({
      label: "Saved 3 h ago",
      canRetry: false,
    });
    expect(saveStatus(view, start + 2 * 86_400_000)).toEqual({
      label: "Saved 2 d ago",
      canRetry: false,
    });
  });
  it("keeps the age when running ticks dirty the city", () => {
    expect(saveStatus({ ...view, dirty: true }, start + 5_000).label).toBe(
      "Saved 5 s ago",
    );
  });
  it("reports Not saved when no city is active or savedAt cannot be parsed", () => {
    expect(saveStatus({ ...view, activeCity: null }, start)).toEqual({
      label: "Not saved",
      canRetry: false,
    });
    expect(
      saveStatus({ ...view, activeCity: null, save: "failed" }, start),
    ).toEqual({
      label: "Not saved",
      canRetry: false,
    });
    expect(
      saveStatus(
        {
          ...view,
          activeCity: { ...view.activeCity!, savedAt: "not-a-date" },
        },
        start,
      ),
    ).toEqual({
      label: "Not saved",
      canRetry: false,
    });
  });
  it("offers retry after a failure", () => {
    expect(saveStatus({ ...view, save: "failed" }, start)).toEqual({
      label: "Couldn't save",
      canRetry: true,
    });
  });
  it("prioritizes saving over other busy work and shows Working… while busy", () => {
    expect(saveStatus({ ...view, save: "saving", busy: true }, start)).toEqual({
      label: "Saving…",
      canRetry: false,
    });
    expect(saveStatus({ ...view, busy: true }, start)).toEqual({
      label: "Working…",
      canRetry: false,
    });
    expect(
      saveStatus({ ...view, activeCity: null, busy: true }, start),
    ).toEqual({
      label: "Working…",
      canRetry: false,
    });
  });
});
