# HPA-349 Phase 1 Cross-Host Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 1 by proving one representative multi-city save/restore/continue journey in the browser and in the packaged Tauri app, without introducing new persistence or desktop-test architecture.

**Architecture:** Keep the existing Svelte UI and working-save runtime as the shared workflow. Browser proof runs through Playwright + WASM + IndexedDB; packaged-native proof runs through the real Tauri app + native `GameEngine` + application-data file store. Existing focused tests remain authoritative for preview, failure, busy-state, and storage semantics.

**Tech Stack:** Svelte 5, TypeScript, Playwright, Vitest, Rust, Tauri 2, `caelum-core`, WASM, IndexedDB.

## Global Constraints

- Keep one browser journey in `tests/e2e/cityLibrary.spec.ts`; do not add a host-parity layer or template/preset matrix.
- Do not add `tauri-driver`, WebDriver/Appium, native UI automation infrastructure, test-only persistence commands, telemetry, migration/recovery infrastructure, or compatibility work.
- Do not change production code unless a representative smoke exposes a concrete product defect; pin that defect in the nearest existing seam first.
- Reuse `runtimeSnapshot()` from `tests/e2e/helpers.ts`; do not add another `window.__caelumRuntime` accessor. That hook is development-only and is not available in the packaged app.
- Browser/native byte-for-byte save parity is not a contract. Each host restores through `caelum-core` and verifies its own player-visible authored state, budget, and saved time.
- Keep coarse native size/duration observations in the implementation PR; do not add instrumentation.

**Design:** `docs/superpowers/specs/2026-08-12-phase1-cross-host-smoke-design.md`

---

### Task 1: Expand the existing browser persistence E2E into the Phase 1 multi-city journey

**Files:**
- Modify: `tests/e2e/cityLibrary.spec.ts`
- Reuse unchanged: `tests/e2e/helpers.ts`

**Interfaces:**
- Consumes: existing `createDefaultCity`, `dragMapTiles`, `openCommandDestination`, `runtimeSnapshot`, and `selectBuildLeaf` helpers.
- Produces: one browser smoke proving two-slot persistence, reload, Continue/Load, authored-road restoration, saved budget/time, continued gameplay, rename, and delete.

- [ ] **Step 1: Run the existing browser baseline**

Run:

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: the current one-city Save Now -> reload -> Continue flow passes.

- [ ] **Step 2: Reuse the existing browser runtime accessor**

Add `runtimeSnapshot` to the existing import only:

```ts
import {
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";
```

Do not add another helper or another `window.__caelumRuntime` access path.

- [ ] **Step 3: Create City A and commit one deterministic road stroke**

Create the first city once with the existing helper:

```ts
await createDefaultCity(page, "Browser Smoke A");
```

Then build three two-way road tiles:

```ts
const topbar = page.getByTestId("topbar");
const canvas = page.locator("canvas[data-runtime-canvas='true']");

await selectBuildLeaf(page, "roads", "road-twoWay");
await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 1 });
await expect(topbar.getByText("$119,700")).toBeVisible();
```

This persistence E2E proves the committed dispatch result. It does **not** independently prove road preview; preview behavior remains owned by `tests/runtime/gameRuntime.test.ts`.

- [ ] **Step 4: Advance the visible clock, pause, and capture the save fingerprint**

Reuse the visible-clock polling shape already used by `tests/e2e/smoke.spec.ts`:

```ts
const timeReadout = topbar.locator(".readout", { hasText: "Time" });
const clockValue = timeReadout.locator(".readout-value");

await page.getByRole("button", { name: "Resume" }).click();
await expect
  .poll(async () => (await clockValue.textContent())?.trim() ?? "")
  .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
await page.getByRole("button", { name: "Pause" }).click();

const beforeSave = (await runtimeSnapshot(page)).state;
const savedTime = beforeSave.time;
expect(savedTime).toBeGreaterThan(0);
expect(beforeSave.budget).toBe(119_700);
```

Do not use a one-shot `time > 0` read as the wait condition; wait for the same visible clock signal the packaged operator can observe.

- [ ] **Step 5: Save A until it is clean, then create B through the active City panel**

Open the City panel, Save Now, and wait for the clean state:

```ts
await openCommandDestination(page, "city");
let cityPanel = page.getByTestId("panel-city");
await cityPanel.getByRole("button", { name: "Save Now" }).click();
await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
  "data-dirty",
  "false",
);
```

Create B through the in-game multi-city path:

```ts
await cityPanel.getByRole("button", { name: "New City" }).click();
await page.getByLabel("City name").fill("Browser Smoke B");
await page.getByRole("button", { name: "Create City" }).click();
await expect(page.getByTestId("game-canvas-host")).toBeVisible();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke B");
```

**Do not call `createDefaultCity()` again after City A exists.** It navigates to `/` and would bypass the City-panel New City UX and its dirty gate.

- [ ] **Step 6: Reload, prove both slots exist, Continue B, then explicitly Load A**

```ts
await page.reload();
await expect(page.getByTestId("city-library-screen")).toBeVisible();
await expect(
  page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
).toBeVisible();
await expect(
  page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
).toBeVisible();

await page.getByRole("button", { name: "Continue" }).click();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke B");

await page.getByRole("button", { name: "Load Browser Smoke A" }).click();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke A");
```

`Continue` intentionally checks the existing newest-`savedAt` ordering; explicit Load then proves slot switching back to A.

- [ ] **Step 7: Assert authored tiles, budget, and saved time—not whole-map equality**

Read the restored state and check only the player contract that matters:

```ts
const restoredA = (await runtimeSnapshot(page)).state;
const tileKindAt = (x: number, y: number) =>
  restoredA.map.tiles.find((tile) => tile.x === x && tile.y === y)?.kind;

expect(tileKindAt(1, 1)).toBe("road");
expect(tileKindAt(2, 1)).toBe("road");
expect(tileKindAt(3, 1)).toBe("road");
expect(restoredA.budget).toBe(119_700);
expect(restoredA.time).toBe(savedTime);
```

Do **not** use `expect(restoredA.map).toEqual(beforeSave.map)`. Save capture normalizes a clone and restore normalizes the persisted candidate; whole-map live-vs-restored equality crosses that normalization boundary and produces an unhelpful 504-tile failure dump.

- [ ] **Step 8: Continue gameplay, then rename and delete B**

```ts
await selectBuildLeaf(page, "roads", "road-twoWay");
await dragMapTiles(page, canvas, { x: 1, y: 2 }, { x: 3, y: 2 });
await expect(page.getByTestId("topbar").getByText("$119,400")).toBeVisible();

await openCommandDestination(page, "city");
const bName = page.getByRole("textbox", { name: "Rename Browser Smoke B" });
await bName.fill("Browser Smoke B Renamed");
await bName.press("Enter");

const renamedB = page.getByRole("textbox", {
  name: "Rename Browser Smoke B Renamed",
});
const bRow = page.getByTestId("city-list").locator("article").filter({ has: renamedB });
const deleteB = bRow.locator("button").filter({ hasText: "Delete" });
await deleteB.click();
await deleteB.click();

await expect(renamedB).toHaveCount(0);
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke A");
```

- [ ] **Step 9: Run the widened browser smoke before touching production code**

Run:

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: PASS with only the browser test changed.

If it fails, distinguish a selector/timing mistake from a real product defect. Do not weaken a valid persistence assertion to make the smoke green.

- [ ] **Step 10: Commit the browser smoke**

```bash
git add tests/e2e/cityLibrary.spec.ts
git commit -m "test: expand browser multi-city smoke"
```

---

### Task 2: Run the focused contracts that already own HPA-349's preview and failure bullets

**Files:**
- Verify: `tests/runtime/gameRuntime.test.ts`
- Verify: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Verify: `tests/runtime/workingSaveRuntime.test.ts`
- Verify: `tests/ui/appShell.test.ts`
- Verify: `tests/runtime/persistence/tauriCitySaveStore.test.ts`
- Verify: `tests/runtime/persistence/citySaveStoreSelection.test.ts`
- Verify: `src-tauri/src/city_store.rs`

**Interfaces:**
- Consumes: existing focused tests only.
- Produces: evidence for preview, failed-update preservation, invalid-load preservation, busy gating, rename/delete, host selection, native IPC, and disk reopen without E2E failure injection.

- [ ] **Step 1: Run the focused TypeScript tests**

```bash
bunx vitest run \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/persistence/indexedDbCitySaveStore.test.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/ui/appShell.test.ts \
  tests/runtime/persistence/tauriCitySaveStore.test.ts \
  tests/runtime/persistence/citySaveStoreSelection.test.ts
```

Confirm current tests still prove:

- road mutation preview is published/invalidated correctly in `gameRuntime.test.ts`;
- a failed IndexedDB update leaves the prior record unchanged;
- returned `invalidSnapshot` load leaves the prior active city installed;
- persistence actions are disabled while busy;
- rename/delete preserve correct active-city semantics;
- the Tauri adapter maps only the intended six commands;
- browser selects IndexedDB and native selects the Tauri store.

- [ ] **Step 2: Run Rust tests**

```bash
cargo test --workspace
```

Confirm the native city-file suite still proves:

- `failed_update_preserves_committed_record`;
- `second_store_instance_reopens_same_directory`;
- `from_app_uses_app_data_cities_child`;
- the Tauri mock-runtime IPC story using production command registration.

Do not replay these failures through browser/native UI injection.

- [ ] **Step 3: Add a focused assertion only if a listed acceptance behavior is genuinely missing**

Use the nearest existing seam:

```text
road preview                -> tests/runtime/gameRuntime.test.ts
IndexedDB record semantics  -> indexedDbCitySaveStore.test.ts
working-save active/busy    -> workingSaveRuntime.test.ts
Svelte busy/rename/delete   -> appShell.test.ts
Tauri invoke mapping        -> tauriCitySaveStore.test.ts
host selection              -> citySaveStoreSelection.test.ts
native file replacement     -> src-tauri/src/city_store.rs
```

If nothing is missing, make no Task 2 commit.

---

### Task 3: Build and run one real packaged Tauri restart smoke

**Files:** No source change expected. Record evidence in the implementation PR body.

**Interfaces:**
- Consumes: packaged `Caelum.app`, existing Svelte UI, native gameplay host, and native file store.
- Produces: one operator-observed proof of production bootstrap, visual native road preview, dispatch, tick, real app-data persistence, process restart, Load, and continued gameplay.

This is a human/operator gate. Do not infer PASS from build, unit, or mock-runtime success.

- [ ] **Step 1: Build the packaged app**

```bash
bun run tauri:build
```

Expected on macOS:

```text
src-tauri/target/release/bundle/macos/Caelum.app
```

- [ ] **Step 2: Launch without requiring or clearing an empty application-data directory**

```bash
open src-tauri/target/release/bundle/macos/Caelum.app
```

Packaged and development builds share the `com.caelum.app` application-data identity. Existing development cities may legitimately be present.

Choose unique names, for example:

```text
Native Smoke A 20260812-1847
Native Smoke B 20260812-1847
```

Ignore unrelated rows. Do not wipe Application Support to manufacture an empty library.

- [ ] **Step 3: First process—create A, observe preview, dispatch/tick, save, and create B**

Through the real UI:

1. Create the uniquely named Native Smoke A as Standard Crossroads.
2. Select Two Way Road and drag `(1,1) -> (3,1)`.
3. **Before mouse release, visually confirm the live road preview overlay is visible.** This is the packaged-native preview proof.
4. Release the drag and verify budget becomes `$119,700`.
5. Resume and wait until the visible clock changes from `Day 1 00:00`; pause and note the non-zero clock.
6. Open City, Save Now, and confirm the dirty indicator clears.
7. From that clean City panel choose New City and create uniquely named Native Smoke B.
8. Quit fully with **Cmd+Q**. Do not treat closing the window as a process restart.

- [ ] **Step 4: Second process—list both smoke cities, explicitly Load A, and prove restoration**

Relaunch the same packaged app. Do not require unrelated existing cities to disappear.

1. Verify **both unique smoke names** are listed.
2. Use Continue once to exercise the shared default resume path.
3. Explicitly Load Native Smoke A.
4. Do not mark PASS until A visibly shows:
   - the road stroke across `(1,1)`, `(2,1)`, `(3,1)`;
   - budget `$119,700`;
   - a non-zero saved clock.
5. Add road `(1,2) -> (3,2)` and verify `$119,400` to prove continued native gameplay.
6. Rename inactive Native Smoke B and delete it with the existing two-click confirmation.
7. Verify A remains active and usable.

Rename/delete are included because the operator is already in the flow; the unique native gap is still production bootstrap + real app-data restart/load.

- [ ] **Step 5: Record coarse size/latency only**

Inspect committed files read-only:

```bash
ls -lh "$HOME/Library/Application Support/com.caelum.app/cities"
```

If macOS resolves the directory elsewhere, inspect the actual resolved path; do not change production path logic for this smoke.

Record in the implementation PR:

- approximate committed smoke-city JSON size;
- Save Now as effectively immediate / around 1 s / visibly slower;
- relaunch + Load as effectively immediate / around 1–2 s / visibly slower.

Do not add timers, tracing, telemetry, indexes, or optimization work without evidence.

- [ ] **Step 6: Clean up only the smoke records**

Delete the remaining smoke city through the normal UI if practical. Do not remove unrelated application data.

---

### Task 4: Only if a smoke exposes a product defect, pin and fix that defect

**Files:** Depend on the failing seam.

**Interfaces:**
- Consumes: the observed smoke failure.
- Produces: one focused regression and the smallest product correction necessary for HPA-349.

- [ ] **Step 1: Classify the seam**

```text
Svelte flow / disabled action -> tests/ui/appShell.test.ts
working-save transition       -> tests/runtime/workingSaveRuntime.test.ts
browser store                 -> tests/runtime/persistence/indexedDbCitySaveStore.test.ts
Tauri TS adapter              -> tests/runtime/persistence/tauriCitySaveStore.test.ts
host selection                -> tests/runtime/persistence/citySaveStoreSelection.test.ts
native command/file behavior  -> src-tauri/src/city_store.rs
shared gameplay restore       -> nearest caelum-core persistence test
```

- [ ] **Step 2: Write and run the smallest failing regression first**

Run the focused test alone and confirm it fails for the observed reason.

- [ ] **Step 3: Make the minimum correction**

Do not introduce an abstraction unless two current callers actually require it.

- [ ] **Step 4: Re-run the focused regression and the representative smoke that exposed it**

A packaged-native bug is not closed by a unit test alone; repeat the packaged step that demonstrated it.

- [ ] **Step 5: Commit the defect fix separately**

Use a message naming the observed defect, not a generic HPA-349 message.

---

### Task 5: Run the final Phase 1 gate, close the architecture ownership sentence, and record evidence

**Files:**
- Modify after packaged PASS: `docs/architecture.md`
- No additional source change expected.

**Interfaces:**
- Consumes: Tasks 1–4 and the packaged operator result.
- Produces: final automated evidence, packaged PASS evidence, and architecture documentation that no longer describes HPA-349 as future work.

- [ ] **Step 1: Run the complete automated gate**

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run test:e2e
bun run tauri:build
```

Do not run a duplicate standalone `bun run build`; `tauri:build` already runs the configured frontend `beforeBuildCommand`.

- [ ] **Step 2: Update the stale architecture ownership sentence only after the packaged smoke passes**

In `docs/architecture.md`, replace the future-tense HPA-349 ownership sentence:

```text
HPA-349 owns the packaged native/browser UI journey and real-bundle application-data permission.
```

with completed-state guidance such as:

```text
HPA-349 closes the remaining packaged composition gate with the representative browser Playwright multi-city journey and one operator-run packaged Tauri restart/load smoke; no permanent native UI automation layer is required for the current Phase 1 architecture.
```

Keep the preceding HPA-344 IPC/disk ownership sentence intact.

- [ ] **Step 3: Commit the architecture cleanup**

```bash
git add docs/architecture.md
git commit -m "docs: record HPA-349 smoke ownership"
```

- [ ] **Step 4: Review implementation scope**

When no defect is found, the expected implementation diff is:

```text
tests/e2e/cityLibrary.spec.ts
docs/architecture.md
```

If production code changed, every production line must trace to a concrete smoke failure and focused regression from Task 4.

- [ ] **Step 5: Put one compact evidence table in the implementation PR**

```markdown
| Gate | Result | Evidence |
| --- | --- | --- |
| Browser multi-city Playwright journey | PASS | A -> road/tick -> Save -> City-panel B -> reload -> Continue/Load -> authored tiles/$119,700/saved time -> continue -> rename/delete |
| Browser road preview behavior | PASS | existing `gameRuntime.test.ts` focused coverage |
| IndexedDB failed-update preservation | PASS | focused Vitest |
| Invalid-load active-game preservation | PASS | focused Vitest |
| Busy + rename/delete shared UI/runtime | PASS | focused Vitest |
| Native failed-update + reopen + IPC | PASS | Rust/Tauri tests |
| Packaged Tauri restart journey | PASS | unique A/B -> visual preview -> dispatch/tick/Save -> Cmd+Q -> relaunch -> list -> explicit Load A -> road/$119,700/non-zero clock |
| Native save size | ~N KB | application-data city JSON |
| Native Save Now | ~... | coarse observation |
| Native relaunch + Load | ~... | coarse observation |
```

Do not mark the packaged row PASS until the second process explicitly loads A and verifies the saved road, budget, and non-zero clock.

- [ ] **Step 6: Close condition**

HPA-349 is complete only when:

- the automated gate is green;
- the packaged restart/load journey is observed as PASS;
- `docs/architecture.md` no longer describes HPA-349 as pending ownership;
- any smoke-discovered blocker has a focused regression and minimal fix.

Do not add checkpoint/autosave/recovery/migration/security/multi-instance scope to close Phase 1.

---

## Expected implementation commits when no defects are found

```text
test: expand browser multi-city smoke
docs: record HPA-349 smoke ownership
```

The packaged-native smoke and coarse measurements belong in implementation PR evidence, not in a synthetic results file or telemetry system.
