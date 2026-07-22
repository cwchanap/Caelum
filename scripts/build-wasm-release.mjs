// Build the release-profile WASM artifact, cleaning the output directory if
// the build fails. `prebuild` runs `clean:wasm` before this script so the
// release artifact is built from a clean slate; this wrapper owns the
// failure path so a partial or release-profile artifact is never left behind
// for `ensure-wasm` to reuse.
//
// Without this, a `wasm-opt` failure during `wasm:build:release` would make
// `prebuild` exit non-zero, Bun would skip `build` (and thus `build.mjs`'s
// own cleanup), and the release-profile files would keep fresh mtimes.
// `ensure-wasm` only compares mtimes, so later `dev`/`check`/`test` runs would
// treat the release artifacts as current and run against a release WASM where
// `cfg!(debug_assertions)`-gated debug intents (e.g. `SetBudget` used by e2e
// `debugSetBudget`) are no-ops, causing e2e to fail with misleading budget
// errors.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const generatedWasmDirectory = "src/generated/caelum_wasm";

function runBun(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });

    child.on("error", (error) => {
      console.error(
        `[build-wasm-release] failed to start bun ${args.join(" ")}:`,
        error,
      );
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(
          `[build-wasm-release] bun ${args.join(" ")} terminated by ${signal}`,
        );
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function removeGeneratedWasmDirectly() {
  try {
    rmSync(generatedWasmDirectory, { recursive: true, force: true });
    console.error(
      `[build-wasm-release] removed ${generatedWasmDirectory} with direct fallback`,
    );
    return true;
  } catch (error) {
    console.error(
      `[build-wasm-release] direct fallback could not remove ${generatedWasmDirectory}:`,
      error,
    );
    return false;
  }
}

const status = await runBun(["run", "wasm:build:release"]);
if (status !== 0) {
  console.error(
    "[build-wasm-release] wasm:build:release failed — removing generated WASM to prevent release-profile reuse by ensure-wasm",
  );
  const cleanupStatus = await runBun(["run", "clean:wasm"]);
  if (cleanupStatus !== 0) {
    console.error(
      `[build-wasm-release] clean:wasm failed with status ${cleanupStatus}; using direct filesystem fallback`,
    );
    removeGeneratedWasmDirectly();
  }
  process.exitCode = status;
}
