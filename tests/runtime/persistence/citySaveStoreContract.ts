import { describe, expect, it } from "vitest";
import {
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreResult,
  type CitySummary,
} from "../../../src/persistence/citySaveStore";

export async function expectCitySaveStoreOk<T>(
  result: Promise<CitySaveStoreResult<T>> | CitySaveStoreResult<T>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(
      `${resolved.error.operation} failed with ${resolved.error.code}`,
    );
  }
  return resolved.value;
}

async function expectError(
  result: Promise<CitySaveStoreResult<unknown>> | CitySaveStoreResult<unknown>,
  code: CitySaveStoreErrorCode,
): Promise<void> {
  const resolved = await result;
  expect(resolved.ok).toBe(false);
  if (resolved.ok) throw new Error(`Expected ${code}`);
  expect(resolved.error.code).toBe(code);
}

export function makeCitySaveRecord(
  id: string,
  name: string,
  overrides: {
    createdAt?: string;
    savedAt?: string;
    snapshot?: unknown;
  } = {},
): CitySaveRecord {
  return {
    city: {
      id,
      name,
      createdAt: overrides.createdAt ?? "2026-08-01T10:00:00.000Z",
    },
    savedAt: overrides.savedAt ?? "2026-08-01T10:00:00.000Z",
    snapshot: overrides.snapshot ?? { budget: 120_000 },
  };
}

export function defineCitySaveStoreContract(
  name: string,
  createStore: () => CitySaveStore,
): void {
  describe(`${name} CitySaveStore contract`, () => {
    it("starts with an empty city list", async () => {
      const store = createStore();
      expect(await expectCitySaveStoreOk(store.listCities())).toEqual([]);
    });

    it("creates, lists, and reads a city", async () => {
      const store = createStore();
      const record = makeCitySaveRecord("city-1", "First");

      const summary = await expectCitySaveStoreOk(store.createCity(record));
      expect(summary).toEqual({
        id: "city-1",
        name: "First",
        createdAt: "2026-08-01T10:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      });

      const listed = await expectCitySaveStoreOk(store.listCities());
      expect(listed).toEqual([summary]);

      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      expect(read).toEqual(record);
    });

    it("rejects a duplicate city ID", async () => {
      const store = createStore();
      const record = makeCitySaveRecord("city-1", "First");
      await expectCitySaveStoreOk(store.createCity(record));

      await expectError(
        store.createCity(makeCitySaveRecord("city-1", "Replacement")),
        "conflict",
      );

      // The original record is unchanged.
      expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
        record,
      );
    });

    it("updates savedAt and snapshot", async () => {
      const store = createStore();
      await expectCitySaveStoreOk(
        store.createCity(
          makeCitySaveRecord("city-1", "First", {
            savedAt: "2026-08-01T10:00:00.000Z",
            snapshot: { budget: 120_000 },
          }),
        ),
      );

      const summary = await expectCitySaveStoreOk(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );
      expect(summary.savedAt).toBe("2026-08-02T11:00:00.000Z");

      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      expect(read.savedAt).toBe("2026-08-02T11:00:00.000Z");
      expect(read.snapshot).toEqual({ budget: 90_000 });
    });

    it("returns notFound when updating a missing city", async () => {
      const store = createStore();
      await expectError(
        store.updateCity("missing", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 1 },
        }),
        "notFound",
      );
    });

    it("returns notFound when renaming a missing city", async () => {
      const store = createStore();
      await expectError(store.renameCity("missing", "Renamed"), "notFound");
    });

    it("preserves identity metadata during update", async () => {
      const store = createStore();
      const record = makeCitySaveRecord("city-1", "First", {
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectCitySaveStoreOk(store.createCity(record));

      const summary = await expectCitySaveStoreOk(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );
      // update carries only savedAt/snapshot; identity metadata is preserved.
      expect(summary).toMatchObject({
        id: "city-1",
        name: "First",
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-02T11:00:00.000Z",
      });

      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      expect(read.city).toEqual({
        id: "city-1",
        name: "First",
        createdAt: "2026-07-01T09:00:00.000Z",
      });
    });

    it("does not revert a committed rename during update", async () => {
      const store = createStore();
      const originalCreatedAt = "2026-07-01T09:00:00.000Z";
      await expectCitySaveStoreOk(
        store.createCity(
          makeCitySaveRecord("city-1", "Original", {
            createdAt: originalCreatedAt,
            savedAt: "2026-08-01T10:00:00.000Z",
            snapshot: { budget: 120_000 },
          }),
        ),
      );
      await expectCitySaveStoreOk(store.renameCity("city-1", "Renamed"));
      await expectCitySaveStoreOk(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );

      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      expect(read.city.name).toBe("Renamed");
      expect(read.city.createdAt).toBe(originalCreatedAt);
    });

    it("renames only the city name", async () => {
      const store = createStore();
      const record = makeCitySaveRecord("city-1", "First", {
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectCitySaveStoreOk(store.createCity(record));

      const summary = await expectCitySaveStoreOk(
        store.renameCity("city-1", "North Loop"),
      );
      expect(summary).toEqual({
        id: "city-1",
        name: "North Loop",
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      });

      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      expect(read).toEqual({
        ...record,
        city: {
          id: "city-1",
          name: "North Loop",
          createdAt: record.city.createdAt,
        },
      });
    });

    it("deletes a city and reports notFound afterward", async () => {
      const store = createStore();
      await expectCitySaveStoreOk(
        store.createCity(makeCitySaveRecord("city-1", "First")),
      );

      await expectCitySaveStoreOk(store.deleteCity("city-1"));

      await expectError(store.readCity("city-1"), "notFound");
      // A second delete of the now-missing id is also notFound.
      await expectError(store.deleteCity("city-1"), "notFound");
      expect(await expectCitySaveStoreOk(store.listCities())).toEqual([]);
    });

    it("lists multiple cities by saved time then ID", async () => {
      const store = createStore();

      await expectCitySaveStoreOk(
        store.createCity(
          makeCitySaveRecord("city-b", "B", {
            savedAt: "2026-08-01T10:00:00.000Z",
          }),
        ),
      );
      await expectCitySaveStoreOk(
        store.createCity(
          makeCitySaveRecord("city-z", "Newest", {
            savedAt: "2026-08-01T11:00:00.000Z",
          }),
        ),
      );
      await expectCitySaveStoreOk(
        store.createCity(
          makeCitySaveRecord("city-a", "A", {
            savedAt: "2026-08-01T10:00:00.000Z",
          }),
        ),
      );

      const listed = await expectCitySaveStoreOk(store.listCities());
      expect(listed.map((city) => city.id)).toEqual([
        "city-z",
        "city-a",
        "city-b",
      ]);
    });

    it("sorts by saved time then ID without mutating inputs", () => {
      const newest: CitySummary = {
        id: "city-z",
        name: "Newest",
        createdAt: "2026-08-01T09:00:00.000Z",
        savedAt: "2026-08-01T11:00:00.000Z",
      };
      const tiedA: CitySummary = {
        id: "city-a",
        name: "A",
        createdAt: "2026-08-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      };
      const tiedB: CitySummary = {
        id: "city-b",
        name: "B",
        createdAt: "2026-08-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      };
      // Input order is deliberately not the sorted order.
      const input = [tiedB, newest, tiedA];
      const snapshot = [...input];

      const sorted = sortCitySummaries(input);

      // savedAt descending, then id ascending for ties.
      expect(sorted.map((item) => item.id)).toEqual([
        "city-z",
        "city-a",
        "city-b",
      ]);
      // The input array is not mutated.
      expect(input.map((item) => item.id)).toEqual(
        snapshot.map((item) => item.id),
      );
    });

    it("detaches committed inputs and returned values", async () => {
      const store = createStore();
      const record = makeCitySaveRecord("city-1", "First", {
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectCitySaveStoreOk(store.createCity(record));

      // Mutating the committed input after create does not affect storage.
      record.city.name = "Mutated input name";
      record.city.id = "city-mutated";
      record.savedAt = "2026-08-09T10:00:00.000Z";
      (record.snapshot as { budget: number }).budget = 1;
      expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
        makeCitySaveRecord("city-1", "First"),
      );

      // Mutating a returned summary does not affect storage.
      const listed = await expectCitySaveStoreOk(store.listCities());
      listed[0]!.name = "Mutated summary";
      listed[0]!.savedAt = "2026-08-09T10:00:00.000Z";
      expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
        makeCitySaveRecord("city-1", "First"),
      );

      // Mutating a read-back record does not affect storage.
      const read = await expectCitySaveStoreOk(store.readCity("city-1"));
      read.city.name = "Mutated read";
      read.savedAt = "2026-08-09T10:00:00.000Z";
      (read.snapshot as { budget: number }).budget = 99;
      expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
        makeCitySaveRecord("city-1", "First"),
      );

      // Mutating an update input after update does not affect storage.
      const update = {
        savedAt: "2026-08-02T11:00:00.000Z",
        snapshot: { budget: 90_000 },
      };
      await expectCitySaveStoreOk(store.updateCity("city-1", update));
      update.savedAt = "2026-08-09T11:00:00.000Z";
      (update.snapshot as { budget: number }).budget = -1;
      expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
        makeCitySaveRecord("city-1", "First", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );
    });
  });
}
