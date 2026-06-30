import { invoke } from "@tauri-apps/api/core";

import { normalizeDispatchResult } from "./shared";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  return {
    async snapshot() {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    async dispatch(intent: GameIntent) {
      const result = await invoke<DispatchResult>("game_dispatch", { intent });
      return normalizeDispatchResult(result);
    },
    async tick(deltaSeconds: number) {
      const result = await invoke<DispatchResult>("game_tick", {
        deltaSeconds,
      });
      return normalizeDispatchResult(result);
    },
    async reset() {
      return invoke<RustGameSnapshot>("game_reset");
    },
  };
}
