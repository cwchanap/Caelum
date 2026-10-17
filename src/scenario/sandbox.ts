import type { SandboxMapSize } from "../domain/types";

// Read-only mirror of `SandboxMapSize::dimensions` in
// `crates/caelum-core/src/model.rs`, for New City labels and test geometry.
// Rust builds every map; runtime code reads dimensions from the snapshot.
export const MAP_SIZES: Record<
  SandboxMapSize,
  { label: string; width: number; height: number }
> = {
  small: { label: "Small", width: 28, height: 18 },
  medium: { label: "Medium", width: 56, height: 36 },
  large: { label: "Large", width: 84, height: 54 },
};
