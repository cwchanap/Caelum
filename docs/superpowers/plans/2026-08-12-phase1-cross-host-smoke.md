# HPA-349 Phase 1 Cross-Host Smoke Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Close Phase 1 by proving one representative multi-city save/restore/continue journey in the browser and in the packaged Tauri app, without introducing new persistence or desktop-test architecture.

**Architecture:** Keep the existing Svelte UI and working-save runtime as the shared workflow. Browser proof runs through the existing Playwright + WASM + IndexedDB stack. Native proof runs through the packaged Tauri app + native `GameEngine` + application-data file store. Existing focused tests remain authoritative for failed-update, invalid-load, busy, rename/delete, host-selection, IPC, and file-reopen contracts.

**Tech Stack:** Svelte 5, TypeScript, Playwright, Vitest, Rust, Tauri 2, `caelum-core`, WASM, IndexedDB.

**Design:** `docs/superpowers/specs/2026-08-12-phase1-cross-host-smoke-design.md`

---

## Scope guard before implementation

No production change is planned.

Do not add:

- `tauri-driver`, WebDriver, Appium, or another desktop automation harness;
- a new browser/native parity layer;
- test-only persistence commands or filesystem path overrides;
- telemetry or benchmark instrumentation;
- save migrations, recovery, import/export, compatibility, locks, or multi-process support.

If an acceptance smoke exposes a real defect, first pin that defect in the closest existing focused test, then make the smallest fix needed to pass HPA-349. Do not pre-build infrastructure for hypothetical failures.

---

### Task 1: Expand the existing browser persistence E2E into the Phase 1 multi-city journey

**Files:**
- Modify: `tests/e2e/cityLibrary.spec.ts`
- Reuse without planned changes: `tests/e2e/helpers.ts`

**Step 1: Run the existing browser persistence smoke as the baseline**

Run:

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: the current single-city Save Now -> reload -> Continue test passes before widening it.

**Step 2: Import the existing runtime snapshot helper**

Extend the helper import in `tests/e2e/cityLibrary.spec.ts`:

```ts
import {
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";
```

Do not add a second way to reach `window.__caelumRuntime`; the helper already owns that test seam.

**Step 3: Replace the one-city journey with one representative two-city journey**

Keep this as one Playwright test. Use Standard Crossroads for both cities; do not turn it into a preset/template matrix.

The test should follow this shape:

```ts
test("browser multi-city save journey survives reopen and continues gameplay", async ({
  page,
}) => {
  await createDefaultCity(page, "Browser Smoke A");

  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  // Preview + dispatch: three deterministic empty Crossroads tiles.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 1 });
  await expect(topbar.getByText("$119,700")).toBeVisible();

  // Tick through the shared runtime before saving.
  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).state.time)
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause" }).click();

  const savedA = (await runtimeSnapshot(page)).state;

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );

  // Second slot through the real shared New City UI.
  await cityPanel.getByRole("button", { name: "New City" }).click();
  await page.getByLabel("City name").fill("Browser Smoke B");
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  // Reopen the browser host and prove both records are discoverable.
  await page.reload();
  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
  ).toBeVisible();

  // Continue exercises the sorted first row; B is the most recent city.
  await page.getByRole("button", { name: "Continue" }).click();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  // Explicit Load proves switching back to the first slot.
  await page
    .getByRole("button", { name: "Load Browser Smoke A" })
    .click();
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke A",
  );

  const restoredA = (await runtimeSnapshot(page)).state;
  expect(restoredA.map).toEqual(savedA.map);
  expect(restoredA.budget).toBe(savedA.budget);
  expect(restoredA.time).toBe(savedA.time);

  // Continue gameplay from the restored snapshot.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 2 }, { x: 3, y: 2 });
  await expect(page.getByTestId("topbar").getByText("$119,400")).toBeVisible();

  // Exercise rename + Delete through the shared city list while A stays active.
  await openCommandDestination(page, "city");
  const bName = page.getByRole("textbox", {
    name: "Rename Browser Smoke B",
  });
  await bName.fill("Browser Smoke B Renamed");
  await bName.press("Enter");

  const renamedB = page.getByRole("textbox", {
    name: "Rename Browser Smoke B Renamed",
  });
  const bRow = page
    .getByTestId("city-list")
    .locator("article")
    .filter({ has: renamedB });
  const deleteB = bRow.locator("button").filter({ hasText: "Delete" });
  await deleteB.click();
  await deleteB.click();

  await expect(renamedB).toHaveCount(0);
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke A",
  );
});
```

Treat this as a shape, not a reason to invent new helpers. Adjust selectors only to current rendered semantics if necessary.

**Step 4: Run the widened browser smoke before touching production code**

Run:

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: PASS with no production change.

If it fails, identify whether the failure is test timing/selectors or a real product defect. Do not weaken a valid state assertion just to make the smoke green.

**Step 5: Commit the browser smoke change**

```bash
git add tests/e2e/cityLibrary.spec.ts
git commit -m "test: expand browser multi-city smoke"
```

---

### Task 2: Run the existing focused contracts that own HPA-349's failure bullets

**Files:**
- Verify: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Verify: `tests/runtime/workingSaveRuntime.test.ts`
- Verify: `tests/ui/appShell.test.ts`
- Verify: `tests/runtime/persistence/tauriCitySaveStore.test.ts`
- Verify: `tests/runtime/persistence/citySaveStoreSelection.test.ts`
- Verify: `src-tauri/src/city_store.rs`

No file change is expected for this task when the existing contracts remain green.

**Step 1: Run the browser/store/runtime focused tests**

Run:

```bash
bunx vitest run \
  tests/runtime/persistence/indexedDbCitySaveStore.test.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/ui/appShell.test.ts \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts
```

Verify specifically that current tests still prove:

- IndexedDB failed update leaves the prior record unchanged;
- returned `invalidSnapshot` load leaves the prior active city installed;
- persistence buttons/actions are disabled while busy;
- rename/delete preserve the correct active-city semantics;
- native adapter maps only the six intended commands;
- host selection chooses IndexedDB for browser and Tauri store for native.

**Step 2: Run the Rust workspace tests**

Run:

```bash
cargo test --workspace
```

Verify the native city-file suite includes and passes:

- `failed_update_preserves_committed_record`;
- `second_store_instance_reopens_same_directory`;
- `from_app_uses_app_data_cities_child`;
- the Tauri mock-runtime IPC story using production command registration.

Do not duplicate these failures through browser/native UI injection.

**Step 3: If a listed acceptance behavior is unexpectedly not covered, add only the missing focused assertion**

Choose the closest existing test file. Examples:

```text
IndexedDB record semantics -> indexedDbCitySaveStore.test.ts
working-save active/busy semantics -> workingSaveRuntime.test.ts
Svelte button/rename/delete semantics -> appShell.test.ts
Tauri invoke mapping -> tauriCitySaveStore.test.ts
native file replacement -> src-tauri/src/city_store.rs
```

Run only that focused test first, then the Task 2 set again.

If no coverage gap exists, make no commit for Task 2.

---

### Task 3: Build and run one real packaged Tauri multi-city restart smoke

**Files:**
- No source file changes expected.
- Record evidence in the implementation PR body, not a new permanent smoke-results document.

This is the one human/operator gate. Do not infer a pass from mock-runtime, unit, or build success.

**Step 1: Build the production app bundle**

Run:

```bash
bun run tauri:build
```

Expected on the current macOS setup:

```text
src-tauri/target/release/bundle/macos/Caelum.app
```

**Step 2: Launch the packaged app**

Run:

```bash
open src-tauri/target/release/bundle/macos/Caelum.app
```

Use unique names if existing development cities are present; do not delete unrelated cities.

**Step 3: First-process native journey**

Through the real UI:

1. Create `Native Smoke A` with Standard + Crossroads.
2. Choose Build -> Roads -> Two Way.
3. Drag `(1,1) -> (3,1)` and observe the preview before release.
4. Release to commit and verify budget is `$119,700`.
5. Resume until the clock visibly advances, then pause.
6. Save Now and verify the dirty indicator clears.
7. Create `Native Smoke B` with Standard + Crossroads.
8. Quit the application fully with Cmd+Q.

This one sequence exercises native preview, dispatch, tick, snapshot-for-save, create/update, and shared UI/runtime ownership.

**Step 4: Second-process native journey**

Relaunch:

```bash
open src-tauri/target/release/bundle/macos/Caelum.app
```

Then:

1. Verify both native smoke cities appear in City Library.
2. Use Continue and confirm a saved city opens.
3. Open the City panel and explicitly Load `Native Smoke A`.
4. Verify the saved road is still present, budget is `$119,700`, and the clock is non-zero.
5. Add a second short road `(1,2) -> (3,2)` and Save Now again.
6. Rename inactive `Native Smoke B`.
7. Delete `Native Smoke B` with the existing two-click confirmation.
8. Verify `Native Smoke A` remains active and usable.

**Step 5: Record only coarse size/latency evidence**

Inspect the native city directory after the saves. On the current macOS bundle, the Tauri application-data root is derived from identifier `com.caelum.app`, with committed records under its `cities/` child.

A useful read-only check is:

```bash
ls -lh "$HOME/Library/Application Support/com.caelum.app/cities"
```

If the platform resolver uses a different physical path, inspect the actual `app_data_dir()/cities` path; do not change production path logic for the smoke.

Record in the implementation PR body:

- approximate size of a committed smoke city JSON file;
- whether Save Now was effectively immediate, around 1 s, or visibly slower;
- whether relaunch -> City Library and Load were effectively immediate, around 1–2 s, or visibly slower.

Do not add timers, tracing, telemetry, indexes, or performance work unless the observed result is clearly problematic.

**Step 6: Clean up only the smoke records**

Delete the remaining smoke city through the normal UI if practical. Do not wipe the whole application-data directory.

---

### Task 4: If a smoke exposes a real defect, pin and fix only that defect

**Files:** depend on the failing seam. Do this task only when Task 1 or Task 3 demonstrates a product failure.

**Step 1: Classify the seam**

Use this mapping:

```text
Svelte flow / disabled action / city row -> tests/ui/appShell.test.ts
working-save state transition -> tests/runtime/workingSaveRuntime.test.ts
browser store -> tests/runtime/persistence/indexedDbCitySaveStore.test.ts
Tauri TS adapter -> tests/runtime/persistence/tauriCitySaveStore.test.ts
host store selection -> tests/runtime/persistence/citySaveStoreSelection.test.ts
native command/file behavior -> src-tauri/src/city_store.rs
shared gameplay restore -> crates/caelum-core tests near the failing contract
```

**Step 2: Write the smallest failing regression first**

Run only that regression and confirm it fails for the observed reason.

**Step 3: Implement the minimum product correction**

Do not add a new abstraction unless the fix has at least two current callers that need it.

**Step 4: Re-run the focused regression and the affected representative smoke**

A native defect is not closed by a unit test alone; repeat the packaged Tauri step that originally failed.

**Step 5: Commit the defect fix separately from the smoke test**

Use a descriptive commit such as:

```bash
git commit -m "fix: preserve native city save across restart"
```

Use the actual defect in the message; do not use this example verbatim when it is not the defect.

---

### Task 5: Run the final Phase 1 gate and record evidence

**Files:**
- No additional source changes expected.
- Update the implementation PR description with the evidence table.

**Step 1: Run the complete automated gate**

Run:

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run test:e2e
bun run tauri:build
```

Do not run a duplicate standalone `bun run build`; `tauri:build` already invokes the configured frontend build through Tauri's `beforeBuildCommand`.

**Step 2: Confirm the diff stayed scoped**

If all smoke paths were green without a product defect, the implementation diff should be test-only (normally `tests/e2e/cityLibrary.spec.ts`).

If production code changed, every production line should point to a concrete smoke failure and a focused regression from Task 4.

**Step 3: Put the acceptance evidence in the implementation PR**

Use a compact table like:

```markdown
| Gate | Result | Evidence |
| --- | --- | --- |
| Browser multi-city Playwright journey | PASS | New -> road/tick -> Save -> second city -> reload -> Continue/Load -> exact map/budget/time -> continue -> rename/delete |
| IndexedDB failed update preservation | PASS | focused Vitest |
| Invalid-load active-game preservation | PASS | focused Vitest |
| Busy + rename/delete shared UI/runtime | PASS | focused Vitest |
| Native failed-update + reopen + IPC | PASS | Rust/Tauri tests |
| Packaged Tauri restart journey | PASS | operator run on packaged `Caelum.app` |
| Native save size | ~N KB | application-data city JSON |
| Native Save Now | ~... | coarse observation |
| Native relaunch + Load | ~... | coarse observation |
```

Do not claim the packaged Tauri row passes until the actual second-process load was observed.

**Step 4: Phase 1 close condition**

HPA-349 can be marked complete after:

- the full automated gate is green;
- the packaged Tauri restart journey is explicitly recorded as passed;
- any smoke-discovered blocker has a focused regression and minimal fix;
- no extra checkpoint/autosave/recovery/migration/security/multi-instance scope was added.

---

## Expected implementation commits when no defects are found

Only one code/test commit is expected:

```text
test: expand browser multi-city smoke
```

The packaged native smoke and acceptance measurements belong in the implementation PR evidence, not in a synthetic code commit.

If a defect is found, add one focused fix commit after its regression rather than restructuring the existing persistence architecture.