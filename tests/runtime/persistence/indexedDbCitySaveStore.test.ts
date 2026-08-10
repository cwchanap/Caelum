import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbCitySaveStore } from "../../../src/persistence/indexedDbCitySaveStore";
import { createWasmBackend } from "../../../src/runtime/backend/wasmBackend";
import { record as citySaveRecord } from "../../fixtures/citySave";
import {
  defineCitySaveStoreContract,
  expectCitySaveStoreOk,
  makeCitySaveRecord,
} from "./citySaveStoreContract";

let databaseSequence = 0;

function nextDatabaseName(): string {
  databaseSequence += 1;
  return `caelum-indexeddb-test-${databaseSequence}`;
}

function createStore(databaseName = nextDatabaseName()) {
  return createIndexedDbCitySaveStore({
    indexedDB: fakeIndexedDB,
    databaseName,
  });
}

const summary = {
  id: "city-1",
  name: "First",
  createdAt: "2026-08-01T10:00:00.000Z",
  savedAt: "2026-08-01T10:00:00.000Z",
};

defineCitySaveStoreContract("IndexedDbCitySaveStore", () => createStore());

describe("IndexedDbCitySaveStore persistence", () => {
  it("reopens a Rust-shaped record through a second adapter instance", async () => {
    const databaseName = nextDatabaseName();
    const saved = citySaveRecord(summary);

    const first = createStore(databaseName);
    await expectCitySaveStoreOk(first.createCity(saved));

    const second = createStore(databaseName);
    expect(await expectCitySaveStoreOk(second.readCity("city-1"))).toEqual(
      saved,
    );
  });

  it("stores and reads a real WASM snapshotForSave payload", async () => {
    const backend = await createWasmBackend();
    const captured = await backend.snapshotForSave();
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error("snapshotForSave failed");

    const store = createStore();
    const saved = citySaveRecord(summary, captured.snapshot);
    await expectCitySaveStoreOk(store.createCity(saved));

    const read = await expectCitySaveStoreOk(store.readCity("city-1"));
    expect(read).toEqual(saved);
  });

  it("aborts an uncloneable update and preserves the previous record", async () => {
    const store = createStore();
    const original = makeCitySaveRecord("city-1", "First");
    await expectCitySaveStoreOk(store.createCity(original));

    const result = await store.updateCity("city-1", {
      savedAt: "2026-08-02T11:00:00.000Z",
      snapshot: { cannotClone: () => 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { operation: "updateCity", code: "failed", cityId: "city-1" },
    });
    expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
      original,
    );
  });
});
