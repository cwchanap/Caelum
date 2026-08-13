# HPA-349 Phase 1 Cross-Host Smoke Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Close Phase 1 by proving one representative multi-city save/restore/continue journey in the browser and in the packaged Tauri app, without introducing new persistence or desktop-test architecture.

**Architecture:** Keep the existing Svelte UI and working-save runtime as the shared workflow. Browser proof runs through Playwright + WASM + IndexedDB. Native proof runs through the packaged Tauri app + native `GameEngine` + application-data file store. Existing focused tests remain authoritative for failure semantics.

**Tech Stack:** Svelte 5, TypeScript, Playwright, Vitest, Rust, Tauri 2, `caelum-core`, WASM, IndexedDB.

**Design:** `docs/superpowers/specs/2026-08-12-phase1-cross-host-smoke-design.md`

---

## Scope guard

No production change is planned.

Do not add `tauri-driver`, WebDriver/Appium, a host-parity layer, test-only persistence commands, telemetry, migration/recovery infrastructure, or compatibility work.

If a smoke exposes a real defect, pin it in the closest existing focused test first, then make the smallest fix needed for HPA-349.

---

### Task 1: Expand the existing browser persistence E2E into the Phase 1 multi-city journey

**Files:**
- Modify: `tests/e2e/cityLibrary.spec.ts`
- Reuse unchanged unless genuinely needed: `tests/e2e/helpers.ts`

**Step 1: Run the existing baseline**

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: the current one-city Save Now -> reload -> Continue flow passes.

**Step 2: Reuse `runtimeSnapshot()`**

Add it to the existing helper import:

```ts
import {
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";
```

Do not add another `window.__caelumRuntime` accessor.

**Step 3: Widen the one test; do not create a matrix**

Use Standard Crossroads for both city slots.

The test sequence is:

1. Create `Browser Smoke A`.
2. Select Two Way Road and drag `(1,1) -> (3,1)`.
   - live drag exercises preview;
   - release exercises dispatch;
   - assert budget `$119,700`.
3. Resume until `runtimeSnapshot(page).state.time > 0`, then pause.
4. Capture the canonical `state` immediately before Save Now.
5. Save Now and assert `data-dirty="false"`.
6. From the City panel create `Browser Smoke B` with the default settings.
7. Reload the page and assert both city names are in City Library.
8. Continue; open the City panel and assert `Browser Smoke B` is active.
9. Explicitly Load `Browser Smoke A`; reopen the City panel if the load reset UI state.
10. Compare restored `map`, `budget`, and `time` exactly with the state captured before Save Now.
11. Add another road `(1,2) -> (3,2)` and assert budget `$119,400` to prove restored gameplay continues.
12. Open the City panel, rename inactive `Browser Smoke B`, then delete it with the existing two-click confirmation; assert A remains active.

The core state assertions should look like:

```ts
const savedA = (await runtimeSnapshot(page)).state;
// Save A, create B, reload, Continue B, Load A...
const restoredA = (await runtimeSnapshot(page)).state;

expect(restoredA.map).toEqual(savedA.map);
expect(restoredA.budget).toBe(savedA.budget);
expect(restoredA.time).toBe(savedA.time);
```

After city creation or Load, open the City panel before reading `active-city-name`; that label belongs to the City panel rather than the always-visible shell.

For the inactive B row, locate the row from its rename textbox and use that row's Delete button. Do not add ID exposure only for E2E selectors.

**Step 4: Run the widened smoke before touching production code**

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: PASS with only the test changed.

If it fails, distinguish a selector/timing mistake from a real product defect. Do not weaken a valid state assertion just to make the test green.

**Step 5: Commit**

```bash
git add tests/e2e/cityLibrary.spec.ts
git commit -m "test: expand browser multi-city smoke"
```

---

### Task 2: Run the focused contracts that already own HPA-349's failure bullets

**Files to verify:**
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- `tests/runtime/workingSaveRuntime.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/runtime/persistence/tauriCitySaveStore.test.ts`
- `tests/runtime/persistence/citySaveStoreSelection.test.ts`
- `src-tauri/src/city_store.rs`

No file change is expected if the current coverage remains green.

**Step 1: Run focused TypeScript tests**

```bash
bunx vitest run \
  tests/runtime/persistence/indexedDbCitySaveStore.test.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/ui/appShell.test.ts \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts
```

Confirm these existing behaviors:

- failed IndexedDB update preserves the prior record;
- returned `invalidSnapshot` load leaves the prior active city installed;
- persistence actions are disabled while busy;
- rename/delete preserve correct active-city semantics;
- the Tauri adapter maps only the intended six commands;
- browser selects IndexedDB and native selects the Tauri store.

**Step 2: Run Rust tests**

```bash
cargo test --workspace
```

Confirm the native suite still passes:

- `failed_update_preserves_committed_record`;
- `second_store_instance_reopens_same_directory`;
- `from_app_uses_app_data_cities_child`;
- production-handler Tauri mock-runtime IPC coverage.

Do not replay these failure cases through brittle E2E injection.

**Step 3: Only if a listed behavior lacks proof, add one focused assertion**

Use the nearest existing test file:

```text
IndexedDB semantics       -> indexedDbCitySaveStore.test.ts
working-save state        -> workingSaveRuntime.test.ts
Svelte busy/rename/delete -> appShell.test.ts
Tauri invoke mapping      -> tauriCitySaveStore.test.ts
host selection            -> citySaveStoreSelection.test.ts
native file replacement   -> src-tauri/src/city_store.rs
```

Run the new focused assertion first, then rerun Task 2. If nothing is missing, make no Task 2 commit.

---

### Task 3: Build and run one real packaged Tauri restart smoke

**Files:** No source change expected. Record evidence in the implementation PR body.

This is a human/operator gate. Do not infer a pass from build, unit, or mock-runtime success.

**Step 1: Build the packaged app**

```bash
bun run tauri:build
```

Expected on the current macOS host:

```text
src-tauri/target/release/bundle/macos/Caelum.app
```

**Step 2: Launch it**

```bash
open src-tauri/target/release/bundle/macos/Caelum.app
```

Use unique smoke city names if unrelated development cities already exist.

**Step 3: First process**

Through the real UI:

1. Create `Native Smoke A` as Standard Crossroads.
2. Drag Two Way Road `(1,1) -> (3,1)`; observe preview and assert visible budget `$119,700` after release.
3. Resume until the clock advances, then pause.
4. Save Now and confirm the dirty indicator clears.
5. Create `Native Smoke B` as a second Standard Crossroads city.
6. Quit fully with Cmd+Q.

This covers native preview, dispatch, tick, create/update, and the shared runtime/UI path.

**Step 4: Second process**

Relaunch the same packaged app, then:

1. verify both smoke cities are listed;
2. use Continue once;
3. explicitly Load `Native Smoke A`;
4. verify the first road is still visible, budget is `$119,700`, and clock is non-zero;
5. add road `(1,2) -> (3,2)` and Save Now again;
6. rename inactive `Native Smoke B`;
7. delete B using the existing two-click confirmation;
8. verify A remains active and usable.

**Step 5: Record coarse size/latency only**

Inspect committed files under the resolved `app_data_dir()/cities` path. On the current macOS bundle, a useful read-only check is:

```bash
ls -lh "$HOME/Library/Application Support/com.caelum.app/cities"
```

If the OS resolver places the directory elsewhere, inspect the actual resolved path; do not change production path logic for the smoke.

Record in the implementation PR:

- approximate committed city JSON size;
- Save Now as effectively immediate / around 1 s / visibly slower;
- relaunch + Load as effectively immediate / around 1–2 s / visibly slower.

Do not add timers, tracing, telemetry, indexes, or optimization work without an observed problem.

**Step 6: Clean up only smoke records**

Delete the remaining smoke city through the normal UI if practical. Do not wipe unrelated application data.

---

### Task 4: Only if a smoke exposes a product defect, pin and fix that defect

**Files:** depend on the failing seam.

**Step 1: Classify the seam**

```text
Svelte flow / disabled action -> tests/ui/appShell.test.ts
working-save transition       -> tests/runtime/workingSaveRuntime.test.ts
browser store                 -> tests/runtime/persistence/indexedDbCitySaveStore.test.ts
Tauri TS adapter              -> tests/runtime/persistence/tauriCitySaveStore.test.ts
host selection                -> tests/runtime/persistence/citySaveStoreSelection.test.ts
native command/file behavior  -> src-tauri/src/city_store.rs
shared gameplay restore       -> nearest caelum-core test
```

**Step 2: Write the smallest failing regression first**

Run it alone and confirm it fails for the observed reason.

**Step 3: Make the minimum correction**

Do not introduce an abstraction unless two current callers actually need it.

**Step 4: Re-run the focused regression and the representative smoke that failed**

A native bug is not closed by a unit test alone; repeat the packaged step that demonstrated it.

**Step 5: Commit the fix separately from the browser smoke test**

Use a message naming the actual defect, for example:

```text
fix: preserve native city update across restart
```

Do not use the example if it is not the defect encountered.

---

### Task 5: Run the final Phase 1 gate and record evidence

**Files:** No further source change expected. Update the implementation PR description with results.

**Step 1: Run the complete automated gate**

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run test:e2e
bun run tauri:build
```

Do not run a duplicate standalone `bun run build`; `tauri:build` already executes the configured frontend `beforeBuildCommand`.

**Step 2: Review scope**

If the product was already correct, the implementation diff should normally be test-only (`tests/e2e/cityLibrary.spec.ts`).

If production code changed, every production line must trace to a concrete smoke failure and focused regression from Task 4.

**Step 3: Put one evidence table in the implementation PR**

```markdown
| Gate | Result | Evidence |
| --- | --- | --- |
| Browser multi-city Playwright journey | PASS | New -> road/tick -> Save -> second city -> reload -> Continue/Load -> map/budget/time -> continue -> rename/delete |
| IndexedDB failed-update preservation | PASS | focused Vitest |
| Invalid-load active-game preservation | PASS | focused Vitest |
| Busy + rename/delete shared UI/runtime | PASS | focused Vitest |
| Native failed-update + reopen + IPC | PASS | Rust/Tauri tests |
| Packaged Tauri restart journey | PASS | observed in packaged `Caelum.app` |
| Native save size | ~N KB | application-data city JSON |
| Native Save Now | ~... | coarse observation |
| Native relaunch + Load | ~... | coarse observation |
```

Do not mark the packaged row PASS until the second-process load was actually observed.

**Step 4: Close condition**

HPA-349 is complete when the automated gate is green, the packaged restart journey is recorded as passed, and any smoke-discovered blocker has a focused regression/minimal fix.

Do not add checkpoint/autosave/recovery/migration/security/multi-instance scope to close Phase 1.

---

## Expected implementation commits when no defects are found

Only one code/test commit is expected:

```text
test: expand browser multi-city smoke
```

The packaged-native smoke and measurements belong in implementation PR evidence, not in a synthetic code commit.