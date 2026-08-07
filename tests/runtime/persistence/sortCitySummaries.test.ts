import { describe, expect, it } from "vitest";
import {
  sortCitySummaries,
  type CitySummary,
} from "../../../src/persistence/citySaveStore";

function summary(
  id: string,
  savedAt: string,
  overrides: Partial<CitySummary> = {},
): CitySummary {
  return {
    id,
    name: overrides.name ?? id,
    createdAt: overrides.createdAt ?? "2026-08-01T09:00:00.000Z",
    savedAt,
  };
}

describe("sortCitySummaries", () => {
  it("breaks a savedAt tie by id ascending", () => {
    const tied = "2026-08-01T10:00:00.000Z";
    // Input is in reverse of the expected id order.
    const sorted = sortCitySummaries([
      summary("city-c", tied),
      summary("city-a", tied),
      summary("city-b", tied),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "city-a",
      "city-b",
      "city-c",
    ]);
  });

  it("orders by savedAt descending regardless of id order", () => {
    // The newer timestamp is on the city whose id would sort later, so a
    // correct descending-timestamp order places it first.
    const sorted = sortCitySummaries([
      summary("city-a", "2026-08-01T10:00:00.000Z"),
      summary("city-b", "2026-08-01T11:00:00.000Z"),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["city-b", "city-a"]);
  });

  it("treats equal id and equal savedAt as equivalent (stable order)", () => {
    const tied = "2026-08-01T10:00:00.000Z";
    const a = summary("city-same", tied, { name: "A" });
    const b = summary("city-same", tied, { name: "B" });

    const sorted = sortCitySummaries([b, a]);

    // Both comparators return 0, so the relative order is preserved by the
    // stable sort and the inputs are returned unchanged.
    expect(sorted.map((item) => item.name)).toEqual(["B", "A"]);
  });

  it("sorts a valid savedAt ahead of an invalid one regardless of id", () => {
    const sorted = sortCitySummaries([
      summary("city-zzz", "not-a-date"),
      summary("city-aaa", "2026-08-01T10:00:00.000Z"),
    ]);

    // The valid timestamp sorts first (descending); the invalid one is pushed
    // to the end even though its id would otherwise win the tie-break.
    expect(sorted.map((item) => item.id)).toEqual(["city-aaa", "city-zzz"]);
  });

  it("orders two invalid timestamps as equivalent (falls back to id)", () => {
    const sorted = sortCitySummaries([
      summary("city-b", "not-a-date"),
      summary("city-a", "also-not-a-date"),
    ]);

    // Both timestamps invalid -> timestamp comparator returns 0 -> id decides.
    expect(sorted.map((item) => item.id)).toEqual(["city-a", "city-b"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      summary("city-b", "2026-08-01T11:00:00.000Z"),
      summary("city-a", "2026-08-01T10:00:00.000Z"),
    ];
    const snapshot = [...input];

    sortCitySummaries(input);

    expect(input.map((item) => item.id)).toEqual(
      snapshot.map((item) => item.id),
    );
  });
});
