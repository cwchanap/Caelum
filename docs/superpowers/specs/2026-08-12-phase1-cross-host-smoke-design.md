# HPA-349 Phase 1 Cross-Host Smoke Design

**Issue:** HPA-349  
**Status:** Draft for review  
**Decision date:** 2026-08-12  
**Prerequisites:** HPA-346 complete; HPA-344 merged in PR #38  
**Scope:** Phase 1 verification gate only

## 1. Decision

Close Phase 1 with one representative browser multi-city storage journey and one real packaged Tauri restart/load journey. Reuse the focused tests that already own preview, persistence-failure, invalid-load, busy-state, rename/delete, host-selection, IPC, and file-reopen semantics.

```text
browser
  Svelte UI
    -> working-save runtime
      -> WASM GameBackend / caelum-core
      -> IndexedDbCitySaveStore

packaged native
  same Svelte UI
    -> same working-save runtime
      -> Tauri GameBackend / caelum-core
      -> Tauri CitySaveStore
        -> real application-data files
```

No new host-parity layer, native UI automation framework, telemetry, failure-injection API, migration/recovery subsystem, or release-hardening matrix is justified for this ticket.

## 2. Why HPA-349 is the remaining Phase 1 gate

HPA-344 already proves the native command/disk seam through production-handler mock-runtime IPC, native error/record wires, app-data path construction, failed-update preservation, and direct reopen through a second file-store instance. HPA-346 already owns the shared multi-city UI/runtime workflow.

The remaining proof is composition:

- browser: the complete two-slot player workflow survives a real browser storage reopen;
- packaged native: production bootstrap selects native gameplay + native storage, real application-data writes succeed, and a full process restart can list/load/continue the saved city.

## 3. Approaches considered

### A. Existing Playwright + one packaged operator smoke — selected

This gives the highest-value proof with almost no new maintenance surface:

- browser automation stays in the already-stable Playwright harness;
- the packaged app is exercised only for the boundary lower-layer tests cannot prove;
- failures remain localizable through existing focused tests;
- the ticket stays a smoke gate rather than becoming a platform project.

### B. Add `tauri-driver` / WebDriver now — rejected

One packaged journey has no second current consumer for driver installation, native lifecycle orchestration, platform-specific CI, and a second selector harness.

**Revisit trigger:** reconsider native UI automation if a native-only composition defect reaches this operator gate a second time, or if a future change to the native store / working-save runtime is merged without rerunning the packaged journey because the manual gate is too costly. Either is evidence that the manual boundary is no longer sustainable.

### C. Treat HPA-344 unit/IPC coverage as sufficient — rejected

That would still leave real packaged bootstrap, real app-data permission, and full process restart unproven.

### D. Make browser manual too — rejected

Browser Playwright already exists. Replacing it with a checklist would reduce proof without reducing architecture.

## 4. Browser representative flow

Extend only `tests/e2e/cityLibrary.spec.ts`. Use Standard + Crossroads for both city slots; Creative and Blank Grid remain focused unit/characterization coverage.

### Preserve the existing unique building/zoning reload proof

The current city-library E2E is the browser suite's real storage-reopen proof for a zoned tile and placed `smallHouse`. HPA-349 must not delete that coverage while widening the test.

For City A:

1. create `Browser Smoke A` once with `createDefaultCity()`;
2. zone residential `(5,1)..(6,1)`;
3. place `smallHouse` at `(5,1)`;
4. verify `$116,000`;
5. author a Two Way Road `(1,1)..(3,1)`;
6. verify `$115,700`.

The building footprint is moved away from the road probe so both persistence contracts fit in the same journey.

### Why roads are the second fingerprint

Roads are higher-value than another scalar/tile-kind check because the runtime routing cache is not serialized: `RoadTopology` is reconstructed from authored reciprocal `roadConnections` when a snapshot is restored.

Therefore the browser restore fingerprint checks:

- three road tile kinds;
- the middle road tile has east/west authored connections;
- the residential area remains present;
- the `smallHouse` remains placed at its origin;
- budget is `$115,700`;
- saved simulation time is restored exactly.

A second adjacent road stroke `(1,2)..(3,2)` then verifies the restored road participates in fresh connectivity by checking a north/south seam edge, not merely the additional `$300` cost.

The persistence E2E still does **not** claim to prove browser preview. Existing `tests/runtime/gameRuntime.test.ts` remains authoritative for `ui.roadMutationPreview` publication/invalidation and preview-host failures.

### Pause must be a committed checkpoint

After the visible clock advances, clicking Pause is asynchronous because it enters the serialized gameplay queue behind already-admitted ticks.

The browser must therefore:

```text
click Pause
-> wait until the topbar button label becomes Resume
-> read runtimeSnapshot().state.time
-> Save Now
```

The `Resume` label is rendered from committed paused state and is the observable queue-drain signal. Capturing time immediately after the click creates a race: a late applied tick can change the saved time and mark the city dirty before New City.

### City B must use the City-panel path

After A is saved clean:

```text
City panel -> New City -> Browser Smoke B -> Create City
```

Do not call `createDefaultCity()` again; that helper navigates to `/` and would bypass the active-city New City dirty gate and the intended single reload boundary.

### Reopen / Continue / Load

After creating B:

1. reload once;
2. verify A and B are listed;
3. Continue B;
4. explicitly Load A;
5. verify the fingerprint above;
6. add the adjacent road and assert the restored/new seam connection.

Continue intentionally exercises the current list ordering policy: `savedAt` descending with `id` as the deterministic tie-breaker. This is an ordering-policy assertion inside the persistence journey, not an accidental assumption.

### No browser rename/delete replay

Do not add rename/delete to this Playwright flow. Those shared semantics already have direct focused coverage in `appShell.test.ts` and `workingSaveRuntime.test.ts`. Keeping the reload-only zone/building proof is more valuable than duplicating them through E2E.

## 5. Packaged Tauri representative flow

Build once:

```bash
bun run tauri:build
open src-tauri/target/release/bundle/macos/Caelum.app
```

### Existing app data is allowed

The package identifier is `com.caelum.app`, so packaged and development runs may share real application data. Do not clear Application Support to force an empty library.

Use unique smoke names and ignore unrelated rows.

### First process

1. create unique Native Smoke A as Standard Crossroads and record its city ID;
2. drag Two Way Road `(1,1)..(3,1)`;
3. before release, visually confirm the native road-preview overlay;
4. release and verify `$119,700`;
5. Resume until the visible clock leaves `Day 1 00:00`;
6. Pause and wait until the button label becomes **Resume**;
7. Save Now and verify clean state;
8. from the clean City panel create unique Native Smoke B and record its city ID;
9. quit with **Cmd+Q**, not only window close.

### Second process

1. relaunch the same packaged app;
2. verify both unique smoke names are listed among any unrelated rows;
3. Continue once;
4. explicitly Load Native Smoke A;
5. require the saved road, `$119,700`, and non-zero clock;
6. add `(1,2)..(3,2)` and verify `$119,400` to prove continued native gameplay;
7. require both the saved road/`$119,700`/non-zero clock and the adjacent road/`$119,400` before PASS.

Rename/delete do not need another manual replay. They are shared UI/runtime behavior already covered by focused automated tests; the native-only gap is production bootstrap + real app-data write + true process restart/load.

## 6. Focused acceptance ownership

These remain existing automated owners; HPA-349 does not create UI injection to duplicate them:

| Acceptance behavior | Existing owner |
| --- | --- |
| Browser road preview | `tests/runtime/gameRuntime.test.ts` |
| Browser failed update preserves prior record | `tests/runtime/persistence/indexedDbCitySaveStore.test.ts` |
| Native failed update preserves prior file | `src-tauri/src/city_store.rs` |
| Returned invalid load preserves active gameplay | `tests/runtime/workingSaveRuntime.test.ts` |
| Persistence busy gating | `tests/ui/appShell.test.ts` + working-save tests |
| Rename/Delete shared behavior | `tests/ui/appShell.test.ts` + `tests/runtime/workingSaveRuntime.test.ts` |
| Browser/native store selection | `tests/runtime/persistence/citySaveStoreSelection.test.ts` |
| Native IPC + file reopen | HPA-344 Tauri tests + `second_store_instance_reopens_same_directory` |

There is no separate implementation task to rerun this subset: the final `bun run test` and `cargo test --workspace` already contain it. The implementation plan keeps only an ownership audit, adding a focused assertion solely if an actual gap is found.

## 7. Snapshot equivalence boundary

Do not require byte-for-byte browser/native save equality or full live-map equality across save/restore.

`GameEngine::snapshot_for_save()` normalizes a clone; restore prepares/normalizes the persisted candidate and rebuilds topology before installation. The save-normalized clone is not written back into the pre-save live engine.

The useful contract is player-facing authored state:

- browser restores its area/building and authored road connectivity, budget, and saved time;
- native restores its authored road, budget, and non-zero saved clock;
- both continue gameplay after restoration;
- host storage encoding and diagnostics may differ.

## 8. Performance sanity check

Record only coarse native observations in the implementation PR:

- each smoke city's application-data file path (located by the recorded ID, since filenames are opaque `city-<hex-id>.json`) and approximate JSON size;
- Save Now: effectively immediate / about 1 s / visibly slower;
- relaunch + Load: effectively immediate / about 1–2 s / visibly slower.

Do not add telemetry, benchmark harnesses, indexes, tracing, or optimization work without an observed problem.

Clean up only the two smoke records by ID; never wipe the cities directory.

## 9. Risks

### Manual native gate can go stale

The packaged operator smoke is intentionally not continuously reproducible CI coverage. A later change to `src-tauri` storage/bootstrap or the shared working-save/runtime path can invalidate the composition proof unless the operator journey is rerun.

This is acceptable for the current active-development stage because there is one native composition journey and no evidence yet that native UI automation pays for itself. The revisit trigger in §3B makes that tradeoff explicit rather than treating manual verification as permanently sufficient.

### Real app data can contaminate assumptions

The packaged smoke runs against the normal `com.caelum.app` application-data directory. Unique smoke names and non-destructive coexistence prevent the checklist from depending on or deleting unrelated development saves.

## 10. Defect policy

No production change is planned.

If either representative smoke fails:

1. identify the narrowest existing seam;
2. add the smallest focused regression when practical;
3. confirm it fails for the observed reason;
4. make the minimum product fix;
5. rerun the focused regression and the representative smoke;
6. do not generalize into a new platform/persistence/recovery abstraction.

If the fix touches native storage/bootstrap or the working-save/runtime composition, rebuild the packaged app and repeat the native journey. This replaces an unconditional duplicate final build.

## 11. Architecture ownership after PASS

`docs/architecture.md` currently describes HPA-349 as the owner of future packaged UI/application-data verification. Once the implementation gate passes, update that one sentence to completed-state guidance while preserving HPA-344's lower-layer ownership.

Intended meaning:

> HPA-349 closes the remaining packaged composition gate with the representative browser Playwright multi-city journey and one operator-run packaged Tauri restart/load smoke; no permanent native UI automation layer is required for the current Phase 1 architecture.

Do not make that architecture update before the packaged smoke passes.

## 12. Acceptance evidence

One implementation-PR table is enough:

```text
Browser multi-city Playwright journey        PASS / FAIL
Browser road-preview focused tests           PASS / FAIL
IndexedDB failed-update preservation         PASS / FAIL
Working-save invalid-load/busy semantics     PASS / FAIL
Rename/Delete focused tests                  PASS / FAIL
Native failed-update/reopen/IPC              PASS / FAIL
Packaged Tauri restart/load journey          PASS / FAIL
Native save size                             ~N KB
Native Save Now                              coarse observation
Native relaunch + Load                       coarse observation
```

The packaged row is PASS only after the second process explicitly loads A and visibly proves the saved road + `$119,700` + non-zero clock, then adds the adjacent road and proves `$119,400`.

When no defect is found, the expected implementation diff stays deliberately small:

```text
tests/e2e/cityLibrary.spec.ts
docs/architecture.md
```

## 13. Non-goals

- template/preset/error cross-product E2E matrix;
- Windows/Linux native matrix;
- desktop WebDriver automation now;
- browser/native byte-for-byte persistence parity;
- exact native/WASM diagnostic parity;
- browser/native save transfer;
- checkpoints, autosave, history, recovery, repair, import/export, or migration;
- released-save compatibility;
- quota, disk-full, power-loss, crash-point, hostile-input, or multi-process matrices;
- performance redesign or telemetry;
- extra security hardening for this Phase 1 gate.

## 14. Review focus

1. Does the browser journey preserve the unique zoning/building reload proof while adding the higher-value road-connectivity restore probe?
2. Does waiting for `Resume` close the gameplay-queue synchronization hole before exact saved-time assertions and New City?
3. Is the packaged operator gate narrowly focused on the composition behavior lower-layer tests cannot prove?
4. Is duplicated focused-test/build work removed without weakening the final gate?
5. Is the manual-gate risk explicit enough to know when native automation becomes justified?