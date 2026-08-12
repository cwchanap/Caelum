import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";
import { createTauriCitySaveStore } from "../../../src/persistence/tauriCitySaveStore";
import type {
  CitySaveRecord,
  CitySaveUpdate,
  CitySummary,
} from "../../../src/persistence/citySaveStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const record: CitySaveRecord = {
  city: {
    id: "city-1",
    name: "First",
    createdAt: "2026-08-01T10:00:00.000Z",
  },
  savedAt: "2026-08-01T11:00:00.000Z",
  snapshot: { budget: 120_000 },
};

const update: CitySaveUpdate = {
  savedAt: "2026-08-02T11:00:00.000Z",
  snapshot: { budget: 90_000 },
};

const summary: CitySummary = {
  id: record.city.id,
  name: record.city.name,
  createdAt: record.city.createdAt,
  savedAt: record.savedAt,
};

describe("Tauri CitySaveStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes only the six narrow commands", async () => {
    invokeMock.mockImplementation(async (command) => {
      switch (command) {
        case "city_store_list":
          return [summary];
        case "city_store_read":
          return record;
        case "city_store_create":
        case "city_store_update":
        case "city_store_rename":
          return summary;
        case "city_store_delete":
          return undefined;
        default:
          throw new Error(`unexpected command: ${command}`);
      }
    });

    const store = createTauriCitySaveStore();
    await store.listCities();
    await store.readCity("city-1");
    await store.createCity(record);
    await store.updateCity("city-1", update);
    await store.renameCity("city-1", "Renamed");
    await store.deleteCity("city-1");

    expect(invokeMock.mock.calls).toEqual([
      ["city_store_list"],
      ["city_store_read", { id: "city-1" }],
      ["city_store_create", { record }],
      ["city_store_update", { id: "city-1", update }],
      ["city_store_rename", { id: "city-1", name: "Renamed" }],
      ["city_store_delete", { id: "city-1" }],
    ]);
  });

  it("sorts native list with shared ordering", async () => {
    const tiedAt = "2026-08-01T10:00:00.000Z";
    const newest: CitySummary = {
      id: "city-z",
      name: "Newest",
      createdAt: "2026-08-01T09:00:00.000Z",
      savedAt: "2026-08-01T11:00:00.000Z",
    };
    const tiedB: CitySummary = {
      id: "city-b",
      name: "B",
      createdAt: "2026-08-01T09:00:00.000Z",
      savedAt: tiedAt,
    };
    const tiedA: CitySummary = {
      id: "city-a",
      name: "A",
      createdAt: "2026-08-01T09:00:00.000Z",
      savedAt: tiedAt,
    };
    invokeMock.mockResolvedValue([tiedB, newest, tiedA]);

    await expect(createTauriCitySaveStore().listCities()).resolves.toEqual({
      ok: true,
      value: [newest, tiedA, tiedB],
    });
  });

  it("maps not found", async () => {
    invokeMock.mockRejectedValue({ code: "notFound" });

    await expect(
      createTauriCitySaveStore().readCity("city-1"),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: "readCity",
        code: "notFound",
        cityId: "city-1",
      },
    });
  });

  it("maps conflict", async () => {
    invokeMock.mockRejectedValue({ code: "conflict" });

    await expect(
      createTauriCitySaveStore().createCity(record),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: "createCity",
        code: "conflict",
        cityId: "city-1",
      },
    });
  });

  it("maps failed with native diagnostic", async () => {
    invokeMock.mockRejectedValue({ code: "failed", diagnostic: "disk full" });

    await expect(
      createTauriCitySaveStore().updateCity("city-1", update),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: "updateCity",
        code: "failed",
        cityId: "city-1",
        diagnostic: "disk full",
      },
    });
  });

  it("maps an unknown primitive rejection", async () => {
    invokeMock.mockRejectedValue("transport unavailable");

    await expect(
      createTauriCitySaveStore().deleteCity("city-1"),
    ).resolves.toEqual({
      ok: false,
      error: {
        operation: "deleteCity",
        code: "failed",
        cityId: "city-1",
        diagnostic: "transport unavailable",
      },
    });
  });

  it("keeps an unexpected structured rejection readable", async () => {
    invokeMock.mockRejectedValue({
      code: "transportDown",
      context: { attempt: 2 },
    });

    const result = await createTauriCitySaveStore().deleteCity("city-1");

    expect(result).toEqual({
      ok: false,
      error: {
        operation: "deleteCity",
        code: "failed",
        cityId: "city-1",
        diagnostic: '{"code":"transportDown","context":{"attempt":2}}',
      },
    });
  });
});
