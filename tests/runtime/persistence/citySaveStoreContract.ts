import { describe, expect, it } from "vitest";
import {
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "../../../src/persistence/citySaveStore";

/**
 * Shared harness for running the city-save-store contract against a concrete
 * adapter. `failNext` is mandatory: every adapter must expose a deterministic
 * failure seam so the atomicity guarantees the runtime depends on (a failed
 * create commits nothing; a failed update leaves the prior record intact) are
 * exercised by the shared contract, not just by adapter-specific tests.
 */
export interface CitySaveStoreContractHarness {
  store: CitySaveStore;
  failNext: (
    operation: CitySaveStoreOperation,
    code: CitySaveStoreErrorCode,
  ) => void;
}

async function expectOk<T>(
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

function makeRecord(
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
  createHarness: () => CitySaveStoreContractHarness,
): void {
  describe(`${name} CitySaveStore contract`, () => {
    it("creates, lists, and reads a city", async () => {
      const { store } = createHarness();
      const record = makeRecord("city-1", "First");

      const summary = await expectOk(store.createCity(record));
      expect(summary).toEqual({
        id: "city-1",
        name: "First",
        createdAt: "2026-08-01T10:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      });

      const listed = await expectOk(store.listCities());
      expect(listed).toEqual([summary]);

      const read = await expectOk(store.readCity("city-1"));
      expect(read).toEqual(record);
    });

    it("rejects a duplicate city ID", async () => {
      const { store } = createHarness();
      const record = makeRecord("city-1", "First");
      await expectOk(store.createCity(record));

      await expectError(
        store.createCity(makeRecord("city-1", "Replacement")),
        "conflict",
      );

      // The original record is unchanged.
      expect(await expectOk(store.readCity("city-1"))).toEqual(record);
    });

    it("updates savedAt and snapshot", async () => {
      const { store } = createHarness();
      await expectOk(
        store.createCity(
          makeRecord("city-1", "First", {
            savedAt: "2026-08-01T10:00:00.000Z",
            snapshot: { budget: 120_000 },
          }),
        ),
      );

      const summary = await expectOk(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );
      expect(summary.savedAt).toBe("2026-08-02T11:00:00.000Z");

      const read = await expectOk(store.readCity("city-1"));
      expect(read.savedAt).toBe("2026-08-02T11:00:00.000Z");
      expect(read.snapshot).toEqual({ budget: 90_000 });
    });

    it("returns notFound when updating a missing city", async () => {
      const { store } = createHarness();
      await expectError(
        store.updateCity("missing", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 1 },
        }),
        "notFound",
      );
    });

    it("preserves identity metadata during update", async () => {
      const { store } = createHarness();
      const record = makeRecord("city-1", "First", {
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectOk(store.createCity(record));

      const summary = await expectOk(
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

      const read = await expectOk(store.readCity("city-1"));
      expect(read.city).toEqual({
        id: "city-1",
        name: "First",
        createdAt: "2026-07-01T09:00:00.000Z",
      });
    });

    it("does not revert a committed rename during update", async () => {
      const { store } = createHarness();
      const originalCreatedAt = "2026-07-01T09:00:00.000Z";
      await expectOk(
        store.createCity(
          makeRecord("city-1", "Original", {
            createdAt: originalCreatedAt,
            savedAt: "2026-08-01T10:00:00.000Z",
            snapshot: { budget: 120_000 },
          }),
        ),
      );
      await expectOk(store.renameCity("city-1", "Renamed"));
      await expectOk(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );

      const read = await expectOk(store.readCity("city-1"));
      expect(read.city.name).toBe("Renamed");
      expect(read.city.createdAt).toBe(originalCreatedAt);
    });

    // Atomicity: a failed create must commit nothing. The runtime's
    // `rollbackNewCity` restores the prior backend without reading or deleting
    // the city, so it relies on this guarantee.
    it("does not create a record after failed create", async () => {
      const { store, failNext } = createHarness();
      failNext("createCity", "failed");

      await expectError(
        store.createCity(makeRecord("city-1", "First")),
        "failed",
      );

      // No partial record was committed.
      await expectError(store.readCity("city-1"), "notFound");
      expect(await expectOk(store.listCities())).toEqual([]);
    });

    // Atomicity: a failed update must leave the complete prior record intact.
    // The runtime's `saveWorking` publishes the failure without re-reading or
    // repairing the record, so it relies on this guarantee.
    it("preserves the complete prior record after failed update", async () => {
      const { store, failNext } = createHarness();
      const record = makeRecord("city-1", "First", {
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectOk(store.createCity(record));
      failNext("updateCity", "failed");

      await expectError(
        store.updateCity("city-1", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
        "failed",
      );

      // The full prior record — identity, savedAt, and snapshot — is intact.
      expect(await expectOk(store.readCity("city-1"))).toEqual(record);
    });

    it("renames only the city name", async () => {
      const { store } = createHarness();
      const record = makeRecord("city-1", "First", {
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectOk(store.createCity(record));

      const summary = await expectOk(store.renameCity("city-1", "North Loop"));
      expect(summary).toEqual({
        id: "city-1",
        name: "North Loop",
        createdAt: "2026-07-01T09:00:00.000Z",
        savedAt: "2026-08-01T10:00:00.000Z",
      });

      const read = await expectOk(store.readCity("city-1"));
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
      const { store } = createHarness();
      await expectOk(store.createCity(makeRecord("city-1", "First")));

      await expectOk(store.deleteCity("city-1"));

      await expectError(store.readCity("city-1"), "notFound");
      // A second delete of the now-missing id is also notFound.
      await expectError(store.deleteCity("city-1"), "notFound");
      expect(await expectOk(store.listCities())).toEqual([]);
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
      const { store } = createHarness();
      const record = makeRecord("city-1", "First", {
        savedAt: "2026-08-01T10:00:00.000Z",
        snapshot: { budget: 120_000 },
      });
      await expectOk(store.createCity(record));

      // Mutating the committed input after create does not affect storage.
      record.city.name = "Mutated input name";
      record.city.id = "city-mutated";
      record.savedAt = "2026-08-09T10:00:00.000Z";
      (record.snapshot as { budget: number }).budget = 1;
      expect(await expectOk(store.readCity("city-1"))).toEqual(
        makeRecord("city-1", "First"),
      );

      // Mutating a returned summary does not affect storage.
      const listed = await expectOk(store.listCities());
      listed[0]!.name = "Mutated summary";
      listed[0]!.savedAt = "2026-08-09T10:00:00.000Z";
      expect(await expectOk(store.readCity("city-1"))).toEqual(
        makeRecord("city-1", "First"),
      );

      // Mutating a read-back record does not affect storage.
      const read = await expectOk(store.readCity("city-1"));
      read.city.name = "Mutated read";
      read.savedAt = "2026-08-09T10:00:00.000Z";
      (read.snapshot as { budget: number }).budget = 99;
      expect(await expectOk(store.readCity("city-1"))).toEqual(
        makeRecord("city-1", "First"),
      );

      // Mutating an update input after update does not affect storage.
      const update = {
        savedAt: "2026-08-02T11:00:00.000Z",
        snapshot: { budget: 90_000 },
      };
      await expectOk(store.updateCity("city-1", update));
      update.savedAt = "2026-08-09T11:00:00.000Z";
      (update.snapshot as { budget: number }).budget = -1;
      expect(await expectOk(store.readCity("city-1"))).toEqual(
        makeRecord("city-1", "First", {
          savedAt: "2026-08-02T11:00:00.000Z",
          snapshot: { budget: 90_000 },
        }),
      );
    });
  });
}
