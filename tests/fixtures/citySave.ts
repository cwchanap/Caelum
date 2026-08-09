import type {
  CitySaveRecord,
  CitySaveStore,
  CitySummary,
} from "../../src/persistence/citySaveStore";
import type { RustGameSnapshot } from "../../src/runtime/backend/types";
import { createRustSnapshot } from "./rustSnapshot";

export function record(
  city: CitySummary,
  snapshot: RustGameSnapshot = createRustSnapshot({ paused: true }),
): CitySaveRecord {
  return {
    city: { id: city.id, name: city.name, createdAt: city.createdAt },
    savedAt: city.savedAt,
    snapshot,
  };
}

export async function seed(
  store: CitySaveStore,
  value: CitySaveRecord,
): Promise<void> {
  const result = await store.createCity(value);
  if (!result.ok) throw new Error("test fixture city record failed to seed");
}
