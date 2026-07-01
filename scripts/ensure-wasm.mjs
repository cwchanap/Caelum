// Rebuild the WASM artifacts only when the Rust crate sources are newer than
// the generated output. The pretest/predev hooks previously rebuilt only when
// `caelum_wasm.js` was missing, so a local Rust change would leave `bun test`
// running against stale WASM. This compares mtimes against every `.rs` file in
// the two crates plus the manifest/lock files that gate the build.
//
// Run via `bun run ensure-wasm` (wired into the pretest/predev hooks).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUTPUT = "src/generated/caelum_wasm/caelum_wasm.js";

// Inputs whose modification invalidates the generated WASM. The two crate
// sources, their manifests, and the workspace lockfile.
const SOURCE_ROOTS = ["crates/caelum-core/src", "crates/caelum-wasm/src"];
const SOURCE_FILES = [
  "crates/caelum-core/Cargo.toml",
  "crates/caelum-wasm/Cargo.toml",
  "Cargo.lock",
];

function walk(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.isFile() && path.endsWith(".rs")) {
      out.push(path);
    }
  }
  return out;
}

function needsBuild() {
  if (!existsSync(OUTPUT)) {
    return true;
  }
  const outMtime = statSync(OUTPUT).mtimeMs;
  const sources = [
    ...SOURCE_ROOTS.flatMap((root) => walk(root)),
    ...SOURCE_FILES.filter(existsSync),
  ];
  return sources.some((file) => statSync(file).mtimeMs > outMtime);
}

if (needsBuild()) {
  console.log("[ensure-wasm] Rust sources changed — rebuilding WASM artifacts");
  const result = spawnSync("bun", ["run", "wasm:build"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} else {
  console.log("[ensure-wasm] WASM artifacts up to date");
}
