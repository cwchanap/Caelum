import { createTauriBackend } from "./tauriBackend";
import type { GameBackend } from "./types";
import { createWasmBackend } from "./wasmBackend";

export { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
export {
  isPersistenceOperationError,
  isPersistenceValidationError,
} from "./persistence";
export type {
  PersistenceAssignmentError,
  PersistenceDerivedStateError,
  PersistenceEntityError,
  PersistenceEntityKind,
  PersistenceEntityRef,
  PersistenceHostErrorCode,
  PersistenceMapSize,
  PersistenceModeError,
  PersistenceNumericError,
  PersistenceOperation,
  PersistenceOperationError,
  PersistenceOwnershipError,
  PersistenceRoadStructureError,
  PersistenceRoadTopologyError,
  PersistenceScenarioError,
  PersistenceSerializationPhase,
  PersistenceSnapshotField,
  PersistenceSnapshotRequest,
  PersistenceSnapshotResultOf,
  PersistenceTileError,
  PersistenceValidationError,
  PersistenceValidationResult,
  PersistenceValidationSource,
} from "./persistenceContract";
export type {
  AuthoredRoadTilePreview,
  DispatchResult,
  GameBackend,
  GameplayWarning,
  GameIntent,
  PersistenceSnapshotResult,
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
  RuntimeSession,
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
