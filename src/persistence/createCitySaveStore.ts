import type { CitySaveStore } from "./citySaveStore";
import { createIndexedDbCitySaveStore } from "./indexedDbCitySaveStore";
import { createTauriCitySaveStore } from "./tauriCitySaveStore";

export interface CreateCitySaveStoreOptions {
  nativeTauri: boolean;
  createTauri?: () => CitySaveStore;
  createIndexedDb?: () => CitySaveStore;
}

export function createCitySaveStore({
  nativeTauri,
  createTauri = createTauriCitySaveStore,
  createIndexedDb = createIndexedDbCitySaveStore,
}: CreateCitySaveStoreOptions): CitySaveStore {
  return nativeTauri ? createTauri() : createIndexedDb();
}
