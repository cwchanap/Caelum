// Remove the generated WASM output directory.
//
// `prebuild` cleans before `wasm:build:release` so the release artifact is
// built from a clean slate (no stale dev-only files mixed in). `build.mjs`
// always runs this cleanup after the frontend build and preserves the first
// nonzero status from either phase. Bun does not run a `postbuild` hook on
// failure, so cleanup must be orchestrated explicitly.
// `ensure-wasm.mjs` rebuilds when the directory is missing, which restores a
// dev-profile WASM. Without this, `cfg!(debug_assertions)`-gated debug intents
// (e.g. `SetBudget` used by e2e `debugSetBudget`) would be no-ops in a release
// WASM and e2e would fail silently.
import { rmSync } from "node:fs";

rmSync("src/generated/caelum_wasm", { recursive: true, force: true });
console.log("[clean-wasm] removed src/generated/caelum_wasm");
