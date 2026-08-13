# HPA-349 Phase 1 Cross-Host Smoke Implementation Plan

> **For agentic workers:** implement this plan task-by-task using the existing test/runtime seams. Do not create a new cross-host test platform.

**Goal:** Close Phase 1 by proving one representative multi-city save/restore/continue journey in the browser and one real packaged Tauri restart/load journey.

**Design:** `docs/superpowers/specs/2026-08-12-phase1-cross-host-smoke-design.md`

## Scope guard

- Keep one browser Playwright journey in `tests/e2e/cityLibrary.spec.ts`.
- Reuse `runtimeSnapshot()` from `tests/e2e/helpers.ts`; do not add another `window.__caelumRuntime` accessor. The hook is development-only and is unavailable in the packaged bundle.
- Keep road-preview, failed-update, invalid-load, busy-state, rename/delete, host-selection, IPC, and disk-reopen semantics in their existing focused tests.
- Do not add `tauri-driver`, WebDriver/Appium, UI failure injection, telemetry, migration/recovery infrastructure, or a host-parity abstraction.
- Do not change production code unless a representative smoke first exposes a concrete product defect; pin that defect in the nearest existing seam before fixing it.
- Browser/native byte-for-byte save parity is not a contract. Each host restores through `caelum-core` and checks its own player-visible state.

---

## Task 1: Expand the existing browser persistence E2E

**Modify:** `tests/e2e/cityLibrary.spec.ts`  
**Reuse unchanged:** `tests/e2e/helpers.ts`

The existing test already provides the only browser reload proof for zoning + a placed building. Preserve that coverage while widening the journey to two city slots and adding a higher-value road-topology restore probe.

### Step 1 — baseline

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
```

Expected: current one-city Save -> reload -> Continue flow passes.

### Step 2 — imports

Keep `clickMapTile`; add `runtimeSnapshot`:

```ts
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";
```

Do not add another browser-runtime accessor.

### Step 3 — create City A and retain zoning/building round-trip coverage

```ts
await createDefaultCity(page, "Browser Smoke A");

const topbar = page.getByTestId("topbar");
const canvas = page.locator("canvas[data-runtime-canvas='true']");

await selectBuildLeaf(page, "zones", "residential");
await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 6, y: 1 });

await selectBuildLeaf(page, "buildings", "smallHouse");
await clickMapTile(canvas, { x: 5, y: 1 });
await expect(topbar.getByText("$116,000")).toBeVisible();
```

Use `(5,1)..(6,1)` for the house footprint so it does not overlap the road probe.

### Step 4 — add the road restore probe

```ts
await selectBuildLeaf(page, "roads", "road-twoWay");
await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 1 });
await expect(topbar.getByText("$115,700")).toBeVisible();
```

The drag proves committed dispatch/persistence in this E2E. It does **not** independently prove browser preview; existing `tests/runtime/gameRuntime.test.ts` remains the preview owner.

Roads are deliberately part of the persistence fingerprint because `RoadTopology` is non-serialized and is rebuilt from authored `roadConnections` during restore. Checking the authored edges therefore probes a more failure-prone restore seam than checking `kind: "road"` alone.

### Step 5 — advance time, then wait for committed pause before capturing

Reuse the visible-clock poll already used by `tests/e2e/smoke.spec.ts`:

```ts
const timeReadout = topbar.locator(".readout", { hasText: "Time" });
const clockValue = timeReadout.locator(".readout-value");

await page.getByRole("button", { name: "Resume" }).click();
await expect
  .poll(async () => (await clockValue.textContent())?.trim() ?? "")
  .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);

await page.getByRole("button", { name: "Pause" }).click();
await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

const beforeSave = (await runtimeSnapshot(page)).state;
const savedTime = beforeSave.time;
expect(savedTime).toBeGreaterThan(0);
expect(beforeSave.budget).toBe(115_700);
```

The `Resume` label is the synchronization point: it is rendered from the committed paused state after the queued pause intent has drained. Do not read `savedTime` immediately after clicking Pause.

### Step 6 — Save A clean, then create B through the active City panel

```ts
await openCommandDestination(page, "city");
let cityPanel = page.getByTestId("panel-city");
await cityPanel.getByRole("button", { name: "Save Now" }).click();
await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
  "data-dirty",
  "false",
);

await cityPanel.getByRole("button", { name: "New City" }).click();
await page.getByLabel("City name").fill("Browser Smoke B");
await page.getByRole("button", { name: "Create City" }).click();
await expect(page.getByTestId("game-canvas-host")).toBeVisible();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke B");
```

**Do not call `createDefaultCity()` a second time.** It navigates to `/` and would bypass the active-city New City dirty gate.

### Step 7 — reload, verify both slots, Continue B, then explicitly Load A

```ts
await page.reload();
await expect(page.getByTestId("city-library-screen")).toBeVisible();
await expect(
  page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
).toBeVisible();
await expect(
  page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
).toBeVisible();

// Continue intentionally checks the current city ordering policy:
// savedAt descending, then id ascending.
await page.getByRole("button", { name: "Continue" }).click();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke B");

await page.getByRole("button", { name: "Load Browser Smoke A" }).click();
await openCommandDestination(page, "city");
await expect(page.getByTestId("active-city-name")).toHaveText("Browser Smoke A");
```

### Step 8 — assert the useful restore fingerprint

Do not compare the entire live pre-save map to the restored map. Save capture normalizes a clone and restore normalizes the candidate, so whole-map live-vs-restored equality crosses a persistence-normalization boundary and produces an unhelpful 504-tile failure.

Instead assert the authored layers that matter:

```ts
const restoredA = (await runtimeSnapshot(page)).state;
const tileAt = (x: number, y: number) =>
  restoredA.map.tiles.find((tile) => tile.x === x && tile.y === y);

expect(tileAt(1, 1)?.kind).toBe("road");
expect(tileAt(2, 1)?.kind).toBe("road");
expect(tileAt(3, 1)?.kind).toBe("road");
expect([...(tileAt(2, 1)?.roadConnections ?? [])].sort()).toEqual([
  "east",
  "west",
]);

expect(tileAt(5, 1)?.area).toBe("residential");
expect(
  restoredA.buildings.some(
    (building) =>
      building.type === "smallHouse" &&
      building.origin.x === 5 &&
      building.origin.y === 1,
  ),
).toBe(true);

expect(restoredA.budget).toBe(115_700);
expect(restoredA.time).toBe(savedTime);
```

This keeps the existing unique zone/building storage round-trip and adds the road connectivity field from which routing topology is reconstructed.

### Step 9 — continue gameplay and prove the restored road participates in new authoring

```ts
await selectBuildLeaf(page, "roads", "road-twoWay");
await dragMapTiles(page, canvas, { x: 1, y: 2 }, { x: 3, y: 2 });
await expect(page.getByTestId("topbar").getByText("$115,400")).toBeVisible();

const continued = (await runtimeSnapshot(page)).state;
const continuedTileAt = (x: number, y: number) =>
  continued.map.tiles.find((tile) => tile.x === x && tile.y === y);
expect(continuedTileAt(1, 1)?.roadConnections).toContain("south");
expect(continuedTileAt(1, 2)?.roadConnections).toContain("north");
```

The adjacent stroke attaches to the restored road endpoint, giving a cheap post-restore connectivity/topology probe rather than only another budget arithmetic check.

Do **not** add browser rename/delete here. Those behaviors already have direct focused coverage in `appShell.test.ts` and `workingSaveRuntime.test.ts`; keeping them in this Playwright journey would duplicate coverage while making the smoke longer.

### Step 10 — run and commit

```bash
bunx playwright test tests/e2e/cityLibrary.spec.ts --project=chromium
git add tests/e2e/cityLibrary.spec.ts
git commit -m "test: expand browser multi-city smoke"
```

If the smoke exposes a real defect, stop broadening the E2E. Add a focused regression at the closest existing seam first.

### Review note — focused ownership stays unchanged

No separate implementation task is needed just to rerun selected focused files. The final `bun run test` and `cargo test --workspace` already contain them. Before implementation, confirm the ownership map remains true:

```text
browser road preview          -> tests/runtime/gameRuntime.test.ts
IndexedDB failed update       -> tests/runtime/persistence/indexedDbCitySaveStore.test.ts
invalid load / busy runtime   -> tests/runtime/workingSaveRuntime.test.ts
busy + rename/delete UI       -> tests/ui/appShell.test.ts
Tauri invoke mapping          -> tests/runtime/persistence/tauriCitySaveStore.test.ts
host store selection          -> tests/runtime/persistence/citySaveStoreSelection.test.ts
native failed update/reopen   -> src-tauri/src/city_store.rs
```

Only add a focused assertion if this audit finds a genuine gap.

---

## Task 2: Build and run one real packaged Tauri restart smoke

**Source changes expected:** none.  
**Evidence destination:** implementation PR body.

This is an operator gate. Build/unit/mock-runtime success cannot substitute for it.

### Step 1 — build once

```bash
bun run tauri:build
```

Expected macOS bundle:

```text
src-tauri/target/release/bundle/macos/Caelum.app
```

### Step 2 — launch without clearing real app data

```bash
open src-tauri/target/release/bundle/macos/Caelum.app
```

Packaged and development runs share the `com.caelum.app` application-data identity. Existing cities are allowed. Use unique smoke names and ignore unrelated rows; never wipe Application Support to manufacture an empty library.

Example:

```text
Native Smoke A 20260812-1918
Native Smoke B 20260812-1918
```

### Step 3 — first process

1. Create unique Native Smoke A as Standard Crossroads.
2. Select Two Way Road and drag `(1,1) -> (3,1)`.
3. Before release, visually confirm the live road-preview overlay is visible.
4. Release and verify `$119,700`.
5. Resume until the visible clock changes from `Day 1 00:00`.
6. Click Pause and **wait until the button label becomes `Resume`** before noting the saved clock or opening City.
7. Save Now and verify the dirty indicator clears.
8. From the clean City panel create unique Native Smoke B.
9. Quit fully with **Cmd+Q**; closing only the window is not a process-restart proof.

### Step 4 — second process

1. Relaunch the same packaged app.
2. Verify both unique smoke names are listed among any unrelated rows.
3. Use Continue once to exercise the shared default resume path.
4. Explicitly Load Native Smoke A.
5. Do not mark PASS until A visibly shows:
   - the saved road across `(1,1)..(3,1)`;
   - `$119,700`;
   - a non-zero saved clock.
6. Add road `(1,2) -> (3,2)` and verify `$119,400` to prove continued native gameplay.

Do not spend manual-gate time re-proving rename/delete; their shared UI/runtime semantics are already owned by focused automated tests. The unique native gap is production bootstrap + real app-data write + true process restart/load.

### Step 5 — record coarse size/latency only

Read the application-data files without modifying unrelated records:

```bash
ls -lh "$HOME/Library/Application Support/com.caelum.app/cities"
```

Record only:

- approximate smoke-city JSON size;
- Save Now as effectively immediate / around 1 s / visibly slower;
- relaunch + Load as effectively immediate / around 1–2 s / visibly slower.

Do not add timers, tracing, telemetry, indexes, or optimization work without an observed problem.

Clean up only the smoke records if practical.

---

## Task 3: If a smoke exposes a defect, pin and fix it narrowly

Classify the failing seam first:

```text
Svelte flow / disabled action -> tests/ui/appShell.test.ts
working-save transition       -> tests/runtime/workingSaveRuntime.test.ts
browser store                 -> tests/runtime/persistence/indexedDbCitySaveStore.test.ts
Tauri TS adapter              -> tests/runtime/persistence/tauriCitySaveStore.test.ts
host selection                -> tests/runtime/persistence/citySaveStoreSelection.test.ts
native command/file behavior  -> src-tauri/src/city_store.rs
shared gameplay restore       -> nearest caelum-core persistence/topology test
```

Then:

1. write the smallest focused failing regression;
2. confirm it fails for the observed reason;
3. make the minimum correction;
4. rerun the focused regression and the representative smoke that exposed it;
5. commit the defect separately from the browser smoke.

Do not introduce a new abstraction unless two current callers actually need it.

If a native defect changes `src-tauri`, the store, or the working-save/runtime path, rebuild the packaged app as part of repeating Task 2. There is no need for a second unconditional build later.

---

## Task 4: Final Phase 1 gate and ownership cleanup

### Step 1 — automated gate

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run test:e2e
```

Do **not** run another unconditional `tauri:build`: Task 2 built the exact bundle used for the operator smoke. If a later defect fix affected native/runtime composition, Task 3 already requires rebuilding and repeating the packaged journey.

### Step 2 — update the stale architecture sentence after packaged PASS

Only after Task 2 passes, change the current future-tense ownership sentence in `docs/architecture.md`:

```text
HPA-349 owns the packaged native/browser UI journey and real-bundle application-data permission.
```

to completed-state guidance such as:

```text
HPA-349 closes the remaining packaged composition gate with the representative browser Playwright multi-city journey and one operator-run packaged Tauri restart/load smoke; no permanent native UI automation layer is required for the current Phase 1 architecture.
```

Preserve the preceding HPA-344 IPC/disk ownership sentence.

Commit:

```bash
git add docs/architecture.md
git commit -m "docs: record HPA-349 smoke ownership"
```

### Step 3 — implementation PR evidence

Use one compact table; do not create a permanent smoke-results artifact:

```markdown
| Gate | Result | Evidence |
| --- | --- | --- |
| Browser multi-city Playwright journey | PASS | zone/house + road/tick -> committed Pause -> Save -> City-panel B -> reload -> Continue/Load A -> area/building + road edges + $115,700 + saved time -> adjacent road seam |
| Browser road preview | PASS | existing `gameRuntime.test.ts` coverage |
| IndexedDB failed update | PASS | existing focused test via `bun run test` |
| Invalid load / busy / rename-delete | PASS | existing focused tests via `bun run test` |
| Native failed update + reopen + IPC | PASS | existing Rust/Tauri tests via `cargo test --workspace` |
| Packaged Tauri restart/load | PASS | unique A/B -> visual preview -> dispatch/tick -> committed Pause -> Save -> Cmd+Q -> relaunch -> list -> explicit Load A -> road/$119,700/non-zero clock |
| Native save size | ~N KB | application-data city JSON |
| Native Save Now | ~... | coarse observation |
| Native relaunch + Load | ~... | coarse observation |
```

Do not mark the packaged row PASS until the second process explicitly loads A and proves the saved road, budget, and non-zero clock.

### Close condition

HPA-349 is complete only when:

- the automated gate is green;
- the packaged restart/load journey is observed as PASS;
- `docs/architecture.md` no longer describes HPA-349 as pending ownership;
- any smoke-discovered blocker has a focused regression and minimal fix.

Do not add checkpoint/autosave/recovery/migration/security/multi-instance scope to close Phase 1.

## Expected implementation commits when no defects are found

```text
test: expand browser multi-city smoke
docs: record HPA-349 smoke ownership
```

The packaged result and coarse measurements belong in the implementation PR evidence, not a synthetic code/results commit.