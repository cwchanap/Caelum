import { SNAPSHOT_SCHEMA_VERSION } from "../../domain/types";
import { describeHostRejection } from "../../hostDiagnostics";
import type {
  PresentationUpdate,
  RestoreResult,
  RustGameSnapshot,
} from "./types";
import type {
  SnapshotError,
  SnapshotErrorCode,
  SnapshotResult,
} from "./persistenceContract";

export function snapshotError(
  code: SnapshotErrorCode,
  error?: unknown,
): SnapshotError {
  return {
    code,
    diagnostic: describeHostRejection(error),
  };
}

function isSnapshotErrorCode(value: unknown): value is SnapshotErrorCode {
  return (
    value === "unsupportedSchema" ||
    value === "invalidSnapshot" ||
    value === "hostFailure"
  );
}

function isDefinitiveRestoreErrorCode(
  value: unknown,
): value is Exclude<SnapshotErrorCode, "hostFailure"> {
  return value === "unsupportedSchema" || value === "invalidSnapshot";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function embeddedError(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotFailureCode(error: unknown): SnapshotErrorCode {
  const embedded = embeddedError(error);
  if (isSnapshotErrorCode(embedded?.code)) return embedded.code;
  // A raw error with no recognizable structured code is a host failure; the
  // contract exposes only unsupportedSchema/invalidSnapshot/hostFailure, and
  // substring matching on free-form strings would paper over real host errors.
  return "hostFailure";
}

function definitiveRestoreFailureCode(
  error: unknown,
): Exclude<SnapshotErrorCode, "hostFailure"> | undefined {
  const embedded = embeddedError(error);
  return isDefinitiveRestoreErrorCode(embedded?.code)
    ? embedded.code
    : undefined;
}

function isSnapshot(value: unknown): value is RustGameSnapshot {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === "number" &&
    Number.isFinite(value.schemaVersion)
  );
}

export async function runSnapshotOperation(
  invoke: () => Promise<unknown> | unknown,
): Promise<SnapshotResult> {
  try {
    const value = await invoke();
    if (!isSnapshot(value)) {
      return snapshotFailure(
        "hostFailure",
        "host returned an invalid snapshot",
      );
    }
    if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      return snapshotFailure("unsupportedSchema", value.schemaVersion);
    }
    return { ok: true, snapshot: value };
  } catch (error) {
    return snapshotFailure(snapshotFailureCode(error), error);
  }
}

/**
 * Restore is the one snapshot operation where a rejected host call is
 * ambiguous: the native/WASM engine may have committed before response
 * delivery failed. Only a structured domain rejection proves that candidate
 * construction stopped before commit and may be converted to `{ ok: false }`.
 * Success is the unversioned presentation update returned by the host —
 * there is deliberately no second schema validation here.
 */
export async function runRestoreOperation(
  invoke: () => Promise<unknown> | unknown,
): Promise<RestoreResult> {
  try {
    const update = (await invoke()) as PresentationUpdate;
    return { ok: true, update };
  } catch (error) {
    const code = definitiveRestoreFailureCode(error);
    if (code !== undefined) return snapshotFailure(code, error);
    throw error;
  }
}

function snapshotFailure(code: SnapshotErrorCode, error?: unknown) {
  return { ok: false, error: snapshotError(code, error) } as const;
}
