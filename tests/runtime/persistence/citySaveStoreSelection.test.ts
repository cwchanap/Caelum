import { describe, expect, it, vi } from "vitest";

import type { CitySaveStore } from "../../../src/persistence/citySaveStore";
import { createCitySaveStore } from "../../../src/persistence/createCitySaveStore";

describe("city save store selection", () => {
  it("uses Tauri storage when nativeTauri is true", () => {
    const tauri = {} as CitySaveStore;
    const indexedDb = {} as CitySaveStore;
    const createTauri = vi.fn(() => tauri);
    const createIndexedDb = vi.fn(() => indexedDb);

    expect(
      createCitySaveStore({
        nativeTauri: true,
        createTauri,
        createIndexedDb,
      }),
    ).toBe(tauri);
    expect(createTauri).toHaveBeenCalledTimes(1);
    expect(createIndexedDb).not.toHaveBeenCalled();
  });

  it("uses IndexedDB storage when nativeTauri is false", () => {
    const tauri = {} as CitySaveStore;
    const indexedDb = {} as CitySaveStore;
    const createTauri = vi.fn(() => tauri);
    const createIndexedDb = vi.fn(() => indexedDb);

    expect(
      createCitySaveStore({
        nativeTauri: false,
        createTauri,
        createIndexedDb,
      }),
    ).toBe(indexedDb);
    expect(createTauri).not.toHaveBeenCalled();
    expect(createIndexedDb).toHaveBeenCalledTimes(1);
  });
});
