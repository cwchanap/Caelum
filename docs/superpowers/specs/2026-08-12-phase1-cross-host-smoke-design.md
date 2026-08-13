# HPA-349 Phase 1 Cross-Host Smoke Design

**Issue:** HPA-349  
**Status:** Draft for review  
**Decision date:** 2026-08-12  
**Prerequisites:** HPA-346 complete; HPA-344 merged in PR #38 on 2026-08-12  
**Scope:** Phase 1 verification gate only

## 1. Decision

Close Phase 1 with one representative multi-city player journey on each shipping host, using the test seams that already exist.

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

The implementation is verification-first:

- expand the existing browser Playwright persistence journey to cover two city slots, reload, Continue/Load, restored map/budget/time, continued gameplay, rename, and delete;
- reuse existing focused tests for failed updates, invalid loads, busy-state gating, host selection, and store contracts;
- build the real packaged macOS app and perform one short create -> mutate/preview/tick -> save -> second city -> quit -> reopen -> list/load -> continue -> rename/delete smoke;
- record only approximate save size and user-visible operation duration in the implementation PR;
- do not add production code unless the smoke exposes a concrete product defect.

Do **not** add `tauri-driver`, WebDriver, a desktop automation framework, a host-parity abstraction, telemetry, benchmarks, a persistence migration layer, or a new test-only storage API for this ticket.

## 2. Why HPA-349 is next

Linear still shows HPA-349 blocked by HPA-344, but GitHub PR #38 (`HPA-344: persist Tauri city saves`) merged on 2026-08-12. HPA-346 is already complete. That makes HPA-349 the highest-priority remaining Phase 1 gate and effectively unblocked.

HPA-344 deliberately stopped at the native command/disk seam. It already proves production command registration through Tauri's mock runtime, application-data path construction, error serialization, native file replacement semantics, and reopen through a second file-store instance. Its design explicitly leaves packaged desktop UI/permission verification to HPA-349.

HPA-349 therefore should verify the thin composition rather than rebuild lower-layer coverage.

## 3. Current evidence and the remaining gap

### Browser already has

- `tests/e2e/cityLibrary.spec.ts`: New City -> gameplay mutation -> Save Now -> browser reload -> City Library -> Continue, including restored budget;
- `tests/ui/appShell.test.ts`: New City request shape, busy-state disabling, multi-city list, Load, rename, delete, active-city behavior, and generic persistence copy;
- `tests/runtime/workingSaveRuntime.test.ts`: save/load/create ordering, dirty/busy ownership, returned invalid-snapshot loads preserving the prior active city, rename/delete semantics, and runtime race guards;
- `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`: the shared store contract, reopen through a second adapter instance, a real WASM snapshot payload, and failed IndexedDB update preserving the prior record.

The browser gap is only that the Playwright journey currently stops at one city. HPA-349 should make that one journey representative of the complete Phase 1 multi-city UX instead of adding another test matrix.

### Native already has

HPA-344 added:

- `src-tauri/src/city_store.rs` filesystem tests, including `failed_update_preserves_committed_record` and `second_store_instance_reopens_same_directory`;
- production app-data path verification through `tauri::test::mock_app()`;
- production handler IPC coverage through Tauri's mock runtime;
- `src/persistence/tauriCitySaveStore.ts` command/error mapping tests;
- tested Tauri-vs-IndexedDB store selection in `src/persistence/createCitySaveStore.ts`;
- a real packaged-app build gate.

The native gap is intentionally small: prove that the packaged app boots with the native gameplay host and native save adapter, can write its real application-data directory, and survives an actual process restart through the shared Svelte workflow.

## 4. Approaches considered

### A. Existing Playwright + one packaged desktop manual smoke — selected

Use browser automation where the repository already has stable automation, and use one explicit operator-run packaged Tauri journey for the remaining host boundary.

Why:

- directly proves the two gaps HPA-349 owns;
- reuses current helpers and contracts;
- no production architecture changes;
- no long-lived test harness to maintain during active development;
- failures still have focused lower-layer tests to localize the broken seam.

### B. Add `tauri-driver` / WebDriver automation now — rejected

This would require desktop driver installation, platform-specific CI setup, app lifecycle orchestration, selectors/window management, and a second E2E harness. HPA-349 has one representative native journey and no second current consumer for that infrastructure.

If repeated packaged-native regressions later justify automation, add it in a separate ticket with evidence from this smoke or future failures.

### C. Declare existing unit/IPC tests sufficient and skip packaged Tauri UI — rejected

HPA-344 intentionally did not prove packaged app permissions, real production bootstrap selection, or the process-restart UI journey. Skipping that would leave HPA-349's only meaningful native gap untested.

### D. Make both browser and native flows manual — rejected

The browser persistence path already has Playwright. Replacing automated browser proof with a checklist would reduce coverage without simplifying the codebase.

## 5. Browser representative flow

Extend `tests/e2e/cityLibrary.spec.ts`; do not create a second browser persistence suite.

Use **Standard + Crossroads** for the full flow. The second city is also Standard + Crossroads because HPA-349 explicitly avoids an every-template/every-preset E2E matrix. Creative and Blank Grid remain covered by existing focused unit/characterization tests.

The flow is:

1. Start in Playwright's fresh browser context with an empty city library.
2. Create `Browser Smoke A` using the default Standard Crossroads choices.
3. Select the two-way road tool and drag `(1,1) -> (3,1)`.
   - This is deterministic and uses three previously empty Crossroads tiles.
   - It exercises road preview before commit and gameplay dispatch on commit.
   - Expected budget becomes `$119,700` from the `$120,000` default.
4. Resume briefly and poll until simulation time advances; pause again.
5. Capture the runtime snapshot immediately before Save Now, then save and verify the city becomes clean.
6. Open the City panel, choose New City, and create `Browser Smoke B` with the same default settings.
7. Reload the page.
8. Verify both city names appear in the City Library.
9. Use **Continue** and verify the most-recent city (`Browser Smoke B`) opens.
10. From the City panel, explicitly **Load `Browser Smoke A`**.
11. Compare the loaded snapshot's map, budget, and time to the snapshot captured before Save Now. This is stronger and less brittle than checking only one rendered tile.
12. Apply one more deterministic road mutation, proving restored gameplay continues normally.
13. Rename inactive `Browser Smoke B`, then delete it through the existing two-click confirmation. Verify `Browser Smoke A` remains active.

No debug-only persistence hooks are required. `tests/e2e/helpers.ts::runtimeSnapshot()` is already an accepted browser test seam and can compare the restored canonical runtime state.

## 6. Packaged Tauri representative flow

Use the repository's current macOS app bundle because `src-tauri/tauri.conf.json` targets an application bundle and the current development host is macOS. This is not an OS matrix.

Build with:

```bash
bun run tauri:build
```

Then launch the produced app bundle (`src-tauri/target/release/bundle/macos/Caelum.app`) and perform the same player-level proof with unique smoke names such as `Native Smoke A` and `Native Smoke B`.

### First process

1. Confirm the app opens normally with an empty/usable City Library.
2. Create `Native Smoke A` as Standard Crossroads.
3. Drag a two-way road `(1,1) -> (3,1)`.
   - the live road preview exercises the native preview path;
   - releasing the drag exercises native dispatch;
   - verify the visible budget becomes `$119,700`.
4. Resume until the visible clock advances, then pause. This exercises native tick.
5. Save Now and verify dirty state clears.
6. Create `Native Smoke B` as a second city.
7. Quit the application fully, not merely close a window.

### Second process

1. Relaunch the packaged app.
2. Verify both city records are listed.
3. Continue/load a city, then explicitly load `Native Smoke A`.
4. Verify the saved road is present, budget is `$119,700`, and the saved clock is non-zero.
5. Add one more deterministic road mutation and Save Now again.
6. Rename inactive `Native Smoke B`, then delete it.
7. Verify the active first city remains usable.

This proves the packaged UI, production host selection, native gameplay command path, native file adapter, real application-data permission, and process restart as one composition.

## 7. Failure and concurrency coverage: reuse, do not duplicate

HPA-349's shared-behavior bullets are already owned by focused automated tests. Keep them as part of the HPA-349 gate instead of re-injecting failures through browser/native E2E.

| Acceptance behavior | Existing proof to run |
| --- | --- |
| Browser failed update preserves prior record | `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` — uncloneable update aborts and prior record is unchanged |
| Native failed update preserves prior file | `src-tauri/src/city_store.rs` — `failed_update_preserves_committed_record` |
| Returned invalid load preserves active gameplay | `tests/runtime/workingSaveRuntime.test.ts` — returned `invalidSnapshot` keeps the active identity and installs nothing |
| Persistence actions disabled while busy | `tests/ui/appShell.test.ts` busy-state UI coverage + working-save runtime exclusive-operation tests |
| Rename/Delete through shared runtime/UI | `tests/ui/appShell.test.ts` + `tests/runtime/workingSaveRuntime.test.ts` |
| Browser host uses IndexedDB, native host uses Tauri store | `tests/runtime/persistence/citySaveStoreSelection.test.ts` |
| Native command/file contract survives reopen | HPA-344 Tauri IPC test + `second_store_instance_reopens_same_directory` |

Do not create an E2E corruption/failure injection API just to replay these cases through the UI.

## 8. Snapshot equivalence boundary

HPA-349 does not need byte-for-byte browser/native persistence parity.

The contract is:

- both hosts restore current-schema snapshots through the same `caelum-core` validation path;
- equivalent player actions produce equivalent gameplay state under `caelum-core`;
- host-specific wrapper diagnostics and storage encoding may differ;
- the representative browser and native flows each verify their own restored map/budget/time and continued gameplay.

No browser-to-native file transfer or exact error-wire parity is required.

## 9. Performance sanity check

Do not instrument the runtime or add telemetry.

For the packaged native smoke, record in the implementation PR:

- approximate committed city-file size from `<app_data_dir>/cities` (on the current macOS bundle this is under the app's `com.caelum.app` application-data directory);
- approximate user-visible Save Now completion time;
- approximate relaunch -> City Library and Load completion time.

For browser, record only obviously slow behavior if observed during Playwright/manual inspection. HPA-349 is not a benchmark ticket.

Only open optimization work if the measured result is clearly problematic.

## 10. Defect policy

No production change is planned.

If either smoke fails:

1. identify the narrowest seam that failed;
2. reproduce it in the closest focused automated test when practical;
3. make the smallest product fix required for HPA-349 acceptance;
4. rerun the focused regression and the representative smoke;
5. do not generalize the fix into a new platform, storage, recovery, or compatibility abstraction.

A larger architectural or release-hardening issue becomes a separate follow-up rather than expanding this Phase 1 gate.

## 11. Acceptance evidence

The implementation PR should contain one compact evidence table rather than a new permanent results database:

```text
Browser Playwright multi-city journey       PASS / FAIL
IndexedDB failed-update preservation        PASS / FAIL
Working-save invalid-load preservation      PASS / FAIL
Busy + rename/delete focused tests          PASS / FAIL
Native city-file failed-update/reopen tests PASS / FAIL
Packaged Tauri multi-city restart journey   PASS / FAIL
Native save size                            ~N KB
Native Save Now                             ~N ms / <1 s / obvious delay
Native relaunch + Load                      ~N s / obvious delay
```

The planning/design documents already preserve the repeatable manual procedure; no third smoke-report document is needed.

## 12. Non-goals

- every-template/every-preset/every-error E2E matrix;
- Windows/Linux native smoke in this ticket;
- desktop WebDriver automation;
- exact Tauri/WASM diagnostics parity;
- browser/native save transfer;
- checkpoints, autosave, history, recovery, repair, import/export, or migration;
- released-save compatibility;
- quota, disk-full, power-loss, crash-point, hostile-input, or multi-process matrices;
- performance redesign, worker migration, or telemetry;
- security hardening beyond the already-shipped native store boundaries.

## 13. Review focus

1. Does the plan prove the only remaining packaged-native gap without creating a desktop automation platform?
2. Is one strengthened browser Playwright journey enough for Phase 1 multi-city UX coverage?
3. Are existing focused failure tests being reused rather than duplicated through brittle E2E injection?
4. Does the native smoke exercise preview, dispatch, tick, native file persistence, restart, Load, rename, and delete through production bootstrap?
5. If the smoke is green, can HPA-349 close with test/documentation changes only?