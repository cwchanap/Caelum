import type {
  UntrustedSaveValue,
  WritableSaveEnvelope,
} from "../persistence/envelope";
import type { SaveEnvelopeError } from "../persistence/envelopeInspection";
import type {
  CitySummary,
  SaveStore,
  SaveStoreError,
  SaveStoreResult,
} from "../persistence/saveStore";
import type { RuntimeSnapshot } from "./types";
import type {
  PersistenceOperationError,
  SandboxCreationRequest,
} from "./backend";

export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave"
  | "loadWorking"
  | "loadCheckpoint"
  | "loadAutosave"
  | "activateNewCity"
  | "detachActiveCity";

export type NoActiveCityOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave";

export type PersistenceCoordinatorPreconditionError =
  | { code: "noActiveCity"; operation: NoActiveCityOperation }
  | { code: "activeCityDeleteRequiresTransition"; cityId: string }
  | { code: "runtimeUnavailable"; operation: PersistenceCoordinatorOperation };

export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceOperationError }
  | {
      kind: "precondition";
      error: PersistenceCoordinatorPreconditionError;
    };

export type PersistenceOperationResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: PersistenceCoordinatorError }
  | { status: "superseded" };

export interface SaveWorkingValue {
  summary: CitySummary;
  savedAt: string;
}

export interface RenameActiveCityValue {
  summary: CitySummary;
}

export type LoadSource =
  | { kind: "working"; cityId: string }
  | { kind: "checkpoint"; cityId: string; checkpointId: string }
  | { kind: "autosave"; cityId: string; autosaveId: string };

export interface LoadSourceRead {
  coordinatorOperation: "loadWorking" | "loadCheckpoint" | "loadAutosave";
  storeOperation: "readWorkingSave" | "readCheckpoint" | "readAutosave";
  read(store: SaveStore): Promise<SaveStoreResult<UntrustedSaveValue>>;
}

export function readForLoadSource(source: LoadSource): LoadSourceRead {
  switch (source.kind) {
    case "working":
      return {
        coordinatorOperation: "loadWorking",
        storeOperation: "readWorkingSave",
        read: (store) => store.readWorkingSave(source.cityId),
      };
    case "checkpoint":
      return {
        coordinatorOperation: "loadCheckpoint",
        storeOperation: "readCheckpoint",
        read: (store) =>
          store.readCheckpoint(source.cityId, source.checkpointId),
      };
    case "autosave":
      return {
        coordinatorOperation: "loadAutosave",
        storeOperation: "readAutosave",
        read: (store) => store.readAutosave(source.cityId, source.autosaveId),
      };
  }
}

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  source: LoadSource;
}

export interface GenerationWriteValue<TSummary> {
  summary: TSummary;
}

export type GenerationWriteKind = "checkpoint" | "autosave";
export type GameplayWriteKind = "working" | GenerationWriteKind;

export interface ActiveCityIdentity {
  id: string;
  name: string;
  cityCreatedAt: string;
}

export type NewCityIdentity = ActiveCityIdentity;

export interface GameplayWriteRequest<TSummary> {
  kind: GenerationWriteKind;
  write(capture: {
    city: ActiveCityIdentity;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<TSummary>>;
}

export type RuntimeSaveStatus =
  | { state: "idle" }
  | {
      state: "queued" | "capturing" | "writing";
      kind: GameplayWriteKind;
      cityId: string;
    };

export type RuntimeLoadStatus =
  | { state: "idle" }
  | { state: "reading" | "restoring"; source: LoadSource };

export type RuntimeLifecycleStatus =
  | { state: "idle" }
  | { state: "creatingCity" | "rollingBack" };

export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lifecycleStatus: RuntimeLifecycleStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}

export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(
    name: string,
  ): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(source: LoadSource): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
  runGameplayWrite<TSummary>(
    request: GameplayWriteRequest<TSummary>,
  ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>>;
}

const cityTails = new Map<string, Promise<void>>();

export function enqueueCityPersistence<T>(
  cityId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = cityTails.get(cityId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  cityTails.set(cityId, tail);
  return run.finally(() => {
    if (cityTails.get(cityId) === tail) cityTails.delete(cityId);
  });
}

export function resolveWorkingSaveCompletion(input: {
  currentCityId: string | null;
  currentSessionToken: number;
  persistedRevision: number;
  capturedCityId: string;
  capturedSessionToken: number;
  capturedRevision: number;
}):
  | { status: "current"; persistedRevision: number }
  | { status: "superseded" } {
  const session = resolvePersistenceSessionCompletion(input);
  if (session.status === "superseded") {
    return { status: "superseded" };
  }
  return {
    status: "current",
    persistedRevision: Math.max(
      input.persistedRevision,
      input.capturedRevision,
    ),
  };
}

export function resolvePersistenceSessionCompletion(input: {
  currentCityId: string | null;
  currentSessionToken: number;
  capturedCityId: string;
  capturedSessionToken: number;
}): { status: "current" } | { status: "superseded" } {
  return input.currentCityId === input.capturedCityId &&
    input.currentSessionToken === input.capturedSessionToken
    ? { status: "current" }
    : { status: "superseded" };
}

function preconditionFailure(
  error: PersistenceCoordinatorPreconditionError,
): PersistenceOperationResult<never> {
  return { status: "failed", error: { kind: "precondition", error } };
}

export function noActiveCity(
  operation: NoActiveCityOperation,
): PersistenceOperationResult<never> {
  return preconditionFailure({ code: "noActiveCity", operation });
}

export function activeCityDeleteRequiresTransition(
  cityId: string,
): PersistenceOperationResult<never> {
  return preconditionFailure({
    code: "activeCityDeleteRequiresTransition",
    cityId,
  });
}

export function guardActiveCityDelete(
  activeCity: ActiveCityIdentity | null,
  cityId: string,
): PersistenceOperationResult<never> | null {
  return activeCity?.id === cityId
    ? activeCityDeleteRequiresTransition(cityId)
    : null;
}

export function runtimeUnavailable(
  operation: PersistenceCoordinatorOperation,
): PersistenceOperationResult<never> {
  return preconditionFailure({ code: "runtimeUnavailable", operation });
}
