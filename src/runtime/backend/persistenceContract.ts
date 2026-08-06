import type { RustGameSnapshot } from "./types";

export type SnapshotErrorCode =
  | "unsupportedSchema"
  | "invalidSnapshot"
  | "hostFailure";

export interface SnapshotError {
  code: SnapshotErrorCode;
  diagnostic?: string;
}

export type SnapshotResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SnapshotError };

export interface SandboxHostError {
  code: "hostFailure";
  diagnostic?: string;
}
