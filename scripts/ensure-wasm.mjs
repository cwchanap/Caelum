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

// The full wasm-pack output set for `--out-name caelum_wasm`. The freshness
// check treats every generated artifact as a build output: previously it only
// looked at `caelum_wasm.js`, so a stale or missing `caelum_wasm_bg.wasm` (or a
// regenerated `.d.ts`) could slip through and leave `bun test` running against
// a half-rebuilt output directory.
const OUTPUTS = [
  "src/generated/caelum_wasm/caelum_wasm.js",
  "src/generated/caelum_wasm/caelum_wasm.d.ts",
  "src/generated/caelum_wasm/caelum_wasm_bg.wasm",
  "src/generated/caelum_wasm/caelum_wasm_bg.wasm.d.ts",
];

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
  // Rebuild if any generated artifact is missing, or if any source is newer
  // than the oldest output. Using the oldest output mtime as the gate means a
  // partial regeneration (e.g. only `caelum_wasm.js` rewritten) still triggers
  // a full rebuild rather than masking a stale `.wasm`/`.d.ts`.
  const outputMtimes = OUTPUTS.map((file) =>
    existsSync(file) ? statSync(file).mtimeMs : null,
  );
  if (outputMtimes.some((mtime) => mtime === null)) {
    return true;
  }
  const outMtime = Math.min(...outputMtimes);
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
