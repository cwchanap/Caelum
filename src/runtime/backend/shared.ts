import type { DispatchResult } from "./types";

// Both the WASM and Tauri backends round-trip `DispatchResult` through a
// serialization boundary (wasm-bindgen / Tauri IPC). A rejection that the Rust
// core emits as `None` can arrive as `undefined` on the JS side; normalize it to
// `null` so the runtime can treat `rejection` as a plain `string | null`.
export function normalizeDispatchResult(
  result: DispatchResult,
): DispatchResult {
  return { ...result, rejection: result.rejection ?? null };
}
