import { invoke } from "@tauri-apps/api/core";

import { describeHostRejection } from "../hostDiagnostics";
import {
  citySaveStoreError,
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "./citySaveStore";

interface NativeCityStoreError {
  code: CitySaveStoreErrorCode;
  diagnostic?: string;
}

function asNativeCityStoreError(error: unknown): NativeCityStoreError | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (code !== "notFound" && code !== "conflict" && code !== "failed") {
    return null;
  }

  const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
  return {
    code,
    ...(code === "failed" && typeof diagnostic === "string"
      ? { diagnostic }
      : {}),
  };
}

async function runCommand<T>(
  operation: CitySaveStoreOperation,
  cityId: string | undefined,
  command: () => Promise<T>,
): Promise<CitySaveStoreResult<T>> {
  try {
    return { ok: true, value: await command() };
  } catch (error: unknown) {
    const native = asNativeCityStoreError(error);
    const code = native?.code ?? "failed";

    return {
      ok: false,
      error: citySaveStoreError(operation, code, {
        cityId,
        ...(code === "failed"
          ? {
              diagnostic: native?.diagnostic ?? describeHostRejection(error),
            }
          : {}),
      }),
    };
  }
}

export function createTauriCitySaveStore(): CitySaveStore {
  return {
    async listCities() {
      const result = await runCommand<CitySummary[]>(
        "listCities",
        undefined,
        () => invoke<CitySummary[]>("city_store_list"),
      );
      return result.ok
        ? { ok: true, value: sortCitySummaries(result.value) }
        : result;
    },

    readCity(id) {
      return runCommand("readCity", id, () =>
        invoke<CitySaveRecord>("city_store_read", { id }),
      );
    },

    createCity(record) {
      return runCommand("createCity", record.city.id, () =>
        invoke<CitySummary>("city_store_create", { record }),
      );
    },

    updateCity(id, update) {
      return runCommand("updateCity", id, () =>
        invoke<CitySummary>("city_store_update", { id, update }),
      );
    },

    renameCity(id, name) {
      return runCommand("renameCity", id, () =>
        invoke<CitySummary>("city_store_rename", { id, name }),
      );
    },

    deleteCity(id) {
      return runCommand("deleteCity", id, () =>
        invoke<void>("city_store_delete", { id }),
      );
    },
  };
}
