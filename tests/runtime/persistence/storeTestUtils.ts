import { expect } from "vitest";
import type {
  SaveStoreError,
  SaveStoreErrorCode,
  SaveStoreResult,
} from "../../../src/persistence/saveStore";

export async function expectOk<T>(
  result: Promise<SaveStoreResult<T>> | SaveStoreResult<T>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(
      `${resolved.error.operation} failed with ${resolved.error.code}: ${resolved.error.diagnostic}`,
    );
  }
  return resolved.value;
}

export async function expectError(
  result: Promise<SaveStoreResult<unknown>> | SaveStoreResult<unknown>,
  code: SaveStoreErrorCode,
): Promise<SaveStoreError> {
  const resolved = await result;
  expect(resolved.ok).toBe(false);
  if (resolved.ok) throw new Error(`Expected ${code}`);
  expect(resolved.error.code).toBe(code);
  return resolved.error;
}
