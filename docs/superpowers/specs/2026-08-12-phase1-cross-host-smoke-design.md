# HPA-349 Phase 1 Cross-Host Smoke Design

**Issue:** HPA-349  
**Status:** Draft for review  
**Decision date:** 2026-08-12  
**Prerequisites:** HPA-346 complete; HPA-344 merged in PR #38 on 2026-08-12  
**Scope:** Phase 1 verification gate only

## 1. Decision

Close Phase 1 with one representative multi-city player journey on each current host, using existing seams rather than building a cross-host testing platform.

```text
browser smoke
  Svelte UI
    -> working-save runtime
      -> WASM GameBackend / caelum-core
      -> IndexedDbCitySaveStore

native smoke
  same Svelte UI
    -> same working-save runtime
      -> Tauri GameBackend / caelum-core
      -> Tauri CitySaveStore
        -> application-data city files
```

The implementation remains verification-first:

- expand the existing browser Playwright city-library test into one two-city Standard Crossroads journey;
- reuse existing focused tests for road preview, failed updates, invalid loads, busy-state gating, host selection, and store contracts;
- perform one operator-run packaged macOS Tauri create -> dispatch/tick -> Save -> second city -> Cmd+Q -> relaunch -> list/Continue/Load -> continue smoke;
- visually confirm the packaged native road-preview overlay before committing the first road stroke;
- record only approximate native save size and user-visible Save/Load duration in the implementation PR;
- make no production change unless a smoke first exposes a concrete defect;
- after the gate passes, update `docs/architecture.md` so it no longer describes HPA-349 as pending ownership.

Do **not** add `tauri-driver`, WebDriver/Appium, a desktop automation framework, a host-parity abstraction, telemetry, benchmarks, a persistence migration/recovery layer, or new test-only storage APIs.

## 2. Why HPA-349 is next

Linear still reflects HPA-344 as a blocker, but GitHub PR #38 (`HPA-344: persist Tauri city saves`) has merged. HPA-346 is also complete. HPA-349 is therefore the remaining High-priority Phase 1 composition gate.

HPA-344 deliberately stopped below packaged desktop UI. It already proves:

- production command registration through Tauri's mock runtime;
- application-data path construction;
- exact native storage wire/error mapping;
- failed-update preservation;
- stateless disk reopen through a second store instance;
- Tauri-vs-IndexedDB store selection;
- packaged buildability.

HPA-349 should prove the remaining composition boundary, not duplicate those lower layers.

## 3. Approaches considered

### A. Existing Playwright + one packaged desktop operator smoke — selected

Use browser automation where the repository already has it and one real packaged-native restart/load journey for the remaining host boundary.

Advantages:

- proves the actual gaps without creating new infrastructure;
- keeps failures localizable through existing focused tests;
- costs almost no ongoing maintenance during active development;
- matches HPA-349's smoke-gate purpose rather than turning it into release certification.

### B. Add `tauri-driver` / WebDriver now — rejected

The current need is one packaged journey. Driver installation, lifecycle orchestration, platform-specific CI, and a second selector harness have no second current consumer.

### C. Treat existing unit/IPC coverage as sufficient — rejected

That would leave packaged bootstrap, real application-data permission, and a real process restart unproven—the exact gap HPA-344 handed to HPA-349.

### D. Make both flows manual — rejected

Browser Playwright already exists. Replacing it with a checklist would reduce proof without simplifying the codebase.

## 4. Browser representative flow

Extend only `tests/e2e/cityLibrary.spec.ts`. Keep Standard + Crossroads for both slots; Creative and Blank Grid remain focused unit/characterization coverage.

### City A

1. Start in Playwright's fresh browser context.
2. Call `createDefaultCity(page, "Browser Smoke A")` once for the initial city.
3. Select Two Way Road and drag `(1,1) -> (3,1)`.
4. Assert the committed result through the `$119,700` budget.
5. Resume and reuse the existing visible-clock poll until the topbar is no longer `Day 1 00:00`.
6. Pause, capture the runtime `time`, and Save Now.
7. Wait until City panel `data-dirty="false"`.

The road drag in this persistence E2E proves the dispatch/persisted result only. It does **not** become a second browser-preview test. Existing `tests/runtime/gameRuntime.test.ts` road-preview coverage remains authoritative for browser preview publication/invalidation.

### City B must use the City-panel path

After A is clean:

1. keep/open the active City panel;
2. click **New City**;
3. fill `Browser Smoke B`;
4. click **Create City**;
5. verify B becomes active through the City panel.

Do **not** call `createDefaultCity()` for B. That helper navigates to `/`; using it a second time would reload before the intended reload and bypass the active-city New City dirty gate that this ticket is meant to exercise.

### Browser reopen and restoration

1. Reload the page once after B exists.
2. Verify both A and B are listed.
3. Use **Continue** and verify B opens as the newest saved city.
4. Explicitly **Load A** through the City panel/list.
5. Verify only the useful persistence fingerprint:
   - `(1,1)`, `(2,1)`, `(3,1)` are road tiles;
   - budget is exactly `119_700`;
   - `time` equals the paused pre-save time captured for A.
6. Add road `(1,2) -> (3,2)` and verify `$119,400`, proving restored gameplay continues.
7. Rename inactive B, two-click Delete it, and verify A remains active.

Do **not** compare the full live pre-save map to the restored map. `snapshot_for_save()` normalizes a clone for persistence and restore normalizes the candidate before installing it; the save copy is not written back into the live engine. Whole-map live-vs-restored equality therefore crosses a normalization boundary and would yield a noisy 504-tile diff for no additional player-contract value.

`runtimeSnapshot()` remains the one browser test accessor. `src/main.ts` exposes `window.__caelumRuntime` only in development, so no packaged-native step may depend on it.

## 5. Browser preview ownership

HPA-349 does not add a mid-drag Playwright helper just to prove road preview.

The existing runtime tests already assert `ui.roadMutationPreview` publication, invalidation, stale-response behavior, and host failures. HPA-349 includes `tests/runtime/gameRuntime.test.ts` in the focused gate and treats that as browser-preview proof.

The browser persistence journey therefore claims:

```text
road drag -> committed dispatch -> saved authored tiles -> restored authored tiles
```

not:

```text
road drag -> independently asserted preview
```

This avoids turning a green dispatch into a misleading preview claim.

## 6. Packaged Tauri representative flow

Use the current macOS bundle from:

```bash
bun run tauri:build
open src-tauri/target/release/bundle/macos/Caelum.app
```

### No empty-library prerequisite

The app identifier is `com.caelum.app`; packaged and development runs may share real application data. The operator must not clear or wipe Application Support just to manufacture an empty library.

Use unique names, for example:

```text
Native Smoke A 20260812-1847
Native Smoke B 20260812-1847
```

Ignore unrelated existing rows and clean up only the smoke records.

### First process

1. Create unique Native Smoke A as Standard Crossroads.
2. Select Two Way Road and drag `(1,1) -> (3,1)`.
3. Before release, visually confirm the live road-preview overlay is visible.
4. Release and verify `$119,700`.
5. Resume until the **visible** clock changes from `Day 1 00:00`, then pause and note the non-zero clock.
6. Save Now and verify the dirty indicator clears.
7. From the clean City panel create unique Native Smoke B.
8. Quit the application with **Cmd+Q**. Closing only the window is not a process-restart proof.

### Second process

1. Relaunch the same packaged app.
2. Verify both unique smoke names are listed among any unrelated rows.
3. Use Continue once.
4. Explicitly Load Native Smoke A.
5. Do not mark PASS until A shows:
   - the saved road across `(1,1)`, `(2,1)`, `(3,1)`;
   - `$119,700`;
   - a non-zero saved clock.
6. Add `(1,2) -> (3,2)` and verify `$119,400` to prove continued native gameplay.
7. Rename/delete B if practical; this is cheap shared-UI confirmation, not the unique native gap.

This one operator flow owns the packaged-native preview, production bootstrap, real app-data writes, full process restart, and player-visible Load proof. It does not create a permanent native automation subsystem.

## 7. Focused acceptance ownership

Keep HPA-349's failure/concurrency bullets in their existing tests instead of injecting corruption or failures through E2E.

| Acceptance behavior | Existing proof to run |
| --- | --- |
| Browser road-preview behavior | `tests/runtime/gameRuntime.test.ts` |
| Browser failed update preserves prior record | `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` |
| Native failed update preserves prior file | `src-tauri/src/city_store.rs` — `failed_update_preserves_committed_record` |
| Returned invalid load preserves active gameplay | `tests/runtime/workingSaveRuntime.test.ts` |
| Persistence actions disabled while busy | `tests/ui/appShell.test.ts` + working-save exclusive-operation tests |
| Rename/Delete through shared runtime/UI | `tests/ui/appShell.test.ts` + `tests/runtime/workingSaveRuntime.test.ts` |
| Browser uses IndexedDB; native uses Tauri store | `tests/runtime/persistence/citySaveStoreSelection.test.ts` |
| Native command/file contract survives reopen | HPA-344 Tauri IPC coverage + `second_store_instance_reopens_same_directory` |

No UI failure-injection API is justified.

## 8. Snapshot equivalence boundary

Browser/native byte-for-byte save parity is explicitly **not** a contract.

The useful contract is:

- both hosts restore current-schema data through `caelum-core`;
- each host independently restores the authored road state used by this smoke;
- each host independently restores the expected budget and saved time/clock;
- both can continue gameplay after restoration;
- host-specific storage encoding and wrapper diagnostics may differ.

No browser-to-native transfer, whole-snapshot wire equality, or exact error-serialization parity is required by HPA-349.

## 9. Performance sanity check

Do not instrument the runtime.

For the packaged smoke, record only:

- approximate committed smoke-city JSON size from the real app-data `cities` directory;
- Save Now as effectively immediate / around 1 s / visibly slower;
- relaunch + Load as effectively immediate / around 1–2 s / visibly slower.

These notes belong in the implementation PR, not a telemetry system or benchmark artifact. Optimize only if the smoke shows an obvious issue.

## 10. Defect policy

No production change is planned.

If either representative smoke fails:

1. identify the narrowest existing seam;
2. add the smallest focused regression there when practical;
3. confirm it fails for the observed reason;
4. make the minimum product fix;
5. rerun the focused regression and the representative smoke;
6. do not generalize the fix into a new platform, persistence, recovery, or compatibility abstraction.

Larger hardening work becomes a separate follow-up.

## 11. Architecture ownership after PASS

`docs/architecture.md` currently ends the persistence ownership paragraph by saying HPA-349 *owns* the packaged journey. Once the implementation gate is actually green, that future-tense sentence becomes stale.

The HPA-349 implementation PR must update it to completed-state guidance, preserving HPA-344's lower-layer ownership. The intended meaning is:

> HPA-349 closes the remaining packaged composition gate with the representative browser Playwright multi-city journey and one operator-run packaged Tauri restart/load smoke; no permanent native UI automation layer is required for the current Phase 1 architecture.

Do not update that sentence before the packaged smoke passes.

## 12. Acceptance evidence

The implementation PR should contain one compact evidence table, not a third results document:

```text
Browser multi-city Playwright journey       PASS / FAIL
Browser road preview focused tests          PASS / FAIL
IndexedDB failed-update preservation        PASS / FAIL
Working-save invalid-load preservation      PASS / FAIL
Busy + rename/delete focused tests          PASS / FAIL
Native city-file failed-update/reopen/IPC   PASS / FAIL
Packaged Tauri restart/load journey         PASS / FAIL
Native save size                            ~N KB
Native Save Now                             coarse observation
Native relaunch + Load                      coarse observation
```

The packaged row is PASS only after the **second process** lists both unique smoke names and explicit Load A visibly proves the road, `$119,700`, and non-zero clock.

When no defect is found, the expected implementation diff is intentionally small:

```text
tests/e2e/cityLibrary.spec.ts
docs/architecture.md
```

## 13. Non-goals

- every-template/every-preset/every-error E2E matrix;
- Windows/Linux native smoke in this ticket;
- desktop WebDriver automation;
- browser/native byte-for-byte persistence parity;
- exact Tauri/WASM diagnostics parity;
- browser/native save transfer;
- checkpoints, autosave, history, recovery, repair, import/export, or migration;
- released-save compatibility;
- quota, disk-full, power-loss, crash-point, hostile-input, or multi-process matrices;
- performance redesign, worker migration, or telemetry;
- security hardening beyond the already-shipped native store boundaries.

## 14. Review focus

1. Does the browser journey exercise the real City-panel second-city path without using `createDefaultCity()` twice?
2. Are authored roads + budget + time a clearer persistence fingerprint than full live-map equality across save normalization?
3. Does the native smoke coexist safely with real development app data and prove a true Cmd+Q/relaunch boundary?
4. Is browser preview correctly owned by the existing runtime tests while packaged preview remains a visual operator check?
5. If the gate is green, can Phase 1 close with one browser test change, one architecture sentence update, and PR evidence only?
