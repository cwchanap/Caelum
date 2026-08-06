import { createTauriBackend } from "./tauriBackend";
import type { GameBackend } from "./types";
import { createWasmBackend } from "./wasmBackend";

export { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
export type {
  AuthoredRoadTilePreview,
  DispatchResult,
  GameBackend,
  GameplayWarning,
  GameIntent,
  RoadMutation,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoadPresetIntent,
  RouteImpact,
  RouteImpactKind,
  RoutePreviewRequest,
  RoutePreviewResponse,
  RustGameSnapshot,
  RustMetrics,
  RustTripOutcome,
  SandboxCreationError,
  SandboxCreationErrorCode,
  SandboxCreationRequest,
  SandboxCreationResult,
  SandboxResetError,
  SandboxResetErrorCode,
  SandboxResetResult,
  TurnSummary,
  WarningCode,
} from "./types";
export type {
  SandboxHostError,
  SnapshotError,
  SnapshotErrorCode,
  SnapshotResult,
} from "./persistenceContract";

type TauriRuntimeSource = {
  __TAURI_INTERNALS__?: unknown;
};

export interface CreateBackendOptions {
  windowLike?: unknown;
  createTauri?: () => Promise<GameBackend>;
  createWasm?: () => Promise<GameBackend>;
}

export function isTauriRuntime(source: unknown = globalThis.window): boolean {
  return (
    typeof source === "object" &&
    source !== null &&
    "__TAURI_INTERNALS__" in (source as TauriRuntimeSource)
  );
}

export async function createBackend({
  windowLike = globalThis.window,
  createTauri = createTauriBackend,
  createWasm = createWasmBackend,
}: CreateBackendOptions = {}): Promise<GameBackend> {
  if (isTauriRuntime(windowLike)) {
    return createTauri();
  }

  return createWasm();
}
