# HPA-976 — Autosave cities and Crossroads first-line fix — Implementation plan

**Design:** [2026-11-16-hpa-976-autosave-crossroads-design.md](../specs/2026-11-16-hpa-976-autosave-crossroads-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-976/autosave-cities-and-unblock-the-first-crossroads-line  
**Baseline:** `main` / `ac3c7d787fc39685b25b795b0ec9fc643ac3bf6b`.  
**PR policy:** **Exactly one PR for HPA-976.** This draft has the design + plan only. Implement all code, tests, and review follow-ups on this branch; do not split this ticket into additional PRs. No artwork is needed (existing UAT mockup is a reference).

## Sequence and file ownership

| Step | Change | Primary files |
| --- | --- | --- |
| 1 | Autosave tests → scheduling and transient save state | `tests/runtime/workingSaveRuntime.test.ts`, `src/runtime/workingSaveRuntime.ts`, `src/runtime/createGameRuntime.ts` |
| 2 | Topbar status, Retry, browser/native close | `src/components/Topbar.svelte`, `src/App.svelte`, `tests/ui/appShell.test.ts`; only necessary Tauri window capability |
| 3 | Crossroads end turnarounds | `crates/caelum-core/src/sandbox.rs` and existing core route/template tests |
| 4 | Rust one-way reason and UI guidance | `crates/caelum-core/src/model.rs`, `crates/caelum-core/src/road_topology.rs`, `src/domain/types.ts`, `src/runtime/runtimeSelectors.ts`, `src/runtime/rejectionMessages.ts`, existing Rust/TS tests |
| 5 | Real host E2E, mockup screenshots, final checks | `tests/e2e/newCity.spec.ts`, `tests/e2e/routes.spec.ts` or a focused existing city persistence spec, existing `tests/e2e/helpers.ts`, Tauri MCP dev host |

Use this as ownership guidance, not a mandate to touch every file. Preserve existing store backends, gameplay host APIs, CityPanel and the right-dock layout.

### Step 1 — Establish autosave behavior with focused red→green tests

1. In `workingSaveRuntime.test.ts` reuse the existing `createRuntimeFixture` and memory store. Add **fake-timer** coverage for: no write while clean/no active city; dirty mutation followed by a single save by the 60-second tick; savedAt advanced + dirty cleared; skip while another persistence operation is busy; a rejected/throwing update leaves dirty and sets saveFailed; next interval/explicit Save retries; and `dispose()` clears its timer and blocks stale publishes.
2. Add the smallest `startAutosave()`/stop-on-dispose lifecycle to `workingSaveRuntime`, idempotent so repeated `RuntimeController.start()` calls do not create duplicate intervals. Have `createGameRuntime.start()` enable the timer; disposal always disables it. Use one `setInterval(60_000)`. At each tick check active + dirty + not busy, then call the **same** `controller.save()` without awaiting in the timer and without enqueuing a second attempt.
3. Keep existing `runExclusive` for snapshot capture and atomic update. Add only an ephemeral `saving`/`saveFailed` (or one minimal discriminant) to `RuntimePersistenceView` for exact status; set it based on the *save* operation rather than all busy mutations. Failed save does not clear dirty. New successful/manual saves clear failure. Preserve existing `error` mapping, load/create guards, six store methods and save format.
4. Update test fixtures with new view fields; avoid new injectable scheduler/service abstractions solely for tests. Use Vitest fake timers and ensure timer ownership is torn down by tests. No autosave when runtime has not started.

**Proof:** A full dirty→autosave→clean transition, one representative store failure/retry, busy skip and cleanup pass as isolated runtime tests.

### Step 2 — Show truthful status and protect browser/native exits

1. In `Topbar.svelte` replace its all-operations "Working…" label with save-specific statuses derived from the view: saving first, failed+dirty, unsaved changes, then elapsed Saved time from `CitySummary.savedAt`. Keep the existing city chip/test ID and Sunny Diorama styling. A small mounted wall-clock ticker updates age; clean it up. Add an actual, keyboard-accessible **Retry** button only on save failure, disabled while busy. Use App's existing `handleSaveCity` callback; successful Retry refreshes the city list just like Save Now.
2. In `App.svelte` pass `savedAt` + save flags + Retry handler. Keep Save Now and current city screens; don't refactor Shell/CityPanel. Attach a synchronous browser `beforeunload` listener within `onMount` only when not in Tauri, querying `runtime.getSnapshot()` (never an outdated captured `snapshot`). Dirty → `preventDefault` plus legacy `returnValue`; clean → no prompt. Remove listener on teardown.
3. For Tauri, dynamically import `@tauri-apps/api/window` only after `isTauriRuntime()`. Register `getCurrentWindow().onCloseRequested(async event => { ... })`; when dirty await one `runtime.persistence.save()`; prevent default close on failure/busy/unavailable, otherwise let Tauri close. Register/unregister once, respecting the existing App cleanup/disposal. No extra Rust command, dialog, queue, blocking UI or cross-window coordination. Confirm the real Tauri 2 window capability allows the listener/normal close; add the minimum permission only if the native test shows it is required.
4. Update `tests/ui/appShell.test.ts`: old "Working…" expectations become "Saving…"; assert Saved age, Unsaved changes, failure/Retry, Retry click through controller, and dirty-only beforeunload. Test native-close listener with a mocked module only for state transitions; do not treat a jsdom mock as native acceptance.

**Proof:** The save chip never mistakes a rename/load for Save, failed Retry is usable, a dirty browser reload prompts, a clean reload does not, and the Tauri close path is testable without new native infrastructure.

### Step 3 — Give all Crossroads arms legal turnarounds

1. Extend `sandbox.rs`'s Crossroads branch after the four current one-way `author_scenario_road_line` calls. Compute width/height from the selected `SandboxMapSize`, use existing center coords, and author four short `TwoWay` connectors joining paired lanes at x=0, x=width−1, y=0, and y=height−1. Preserve the interior arrows. Call the existing junction refresh and topology compilation **once**, as before.
2. Run `validate_crossroads_candidate` unchanged initially; strengthen its coverage only if it currently assumes a nonessential end detail. Its central 2×2 junction and routing transitions must remain correct; do not weaken checks to accommodate new caps.
3. Add a Rust route/topology test that places representative bus stops beside the east arm and proves a **Loop** is connected in both directions. Add a parameterized assertion for Small/Medium/Large and for legal directed turn/return at each end (not just a geometric road connection). Keep negative template-validator tests and Blank Grid/Small Town unchanged.
4. No schema bump: no snapshot field or wire layout changed. Existing city snapshots should not be rewritten; **do not backfill turnarounds in saved cities**.

**Proof:** A newly generated Crossroads map routes both ways where it formerly dead-ended and validates with the existing core; no arbitrary U-turn rule was added.

### Step 4 — Classify only genuine one-way dead ends

1. First add core red tests in the existing `crates/caelum-core/tests/road_topology.rs` or `route_editing.rs` for a loop service leg that fails because a one-way access lane runs to a terminal without return. Assert typed `OneWayNoReturn`; retain tests showing `NetworkDisconnected` for physically disconnected roads, `NoLegalTurnaround` for terminal reversal, and heading/no-access failures.
2. Extend `model.rs::LegFailureReason` with `OneWayNoReturn`. In the failed service-leg path search of `road_topology.rs`, use a read-only, failure-only diagnostic: positive evidence of geometric reciprocal-edge connectivity **plus** one-way/no-reachable-turnaround cause for the failed origin; otherwise keep the existing failure reason. Do not change `find_path` success cases, road mutation legality, or globally grant U-turns. Use existing deterministic state/connection helpers rather than building a separate route engine.
3. Mirror `oneWayNoReturn` in `src/domain/types.ts`, update current wire/route tests as needed, and teach `routeFailureGuidance` to use the **already derived** `fromLabel` supplied from `runtimeSelectors.ts`. Produce: "The road past Stop H is one-way and has no way back. Add a turnaround, a roundabout or a two-way road." Existing failure-row heading already displays "Stop H → Stop C". No Rust stop-name field.
4. Extend `tests/runtime/rejectionMessages.test.ts` and `runtimeSelectors.test.ts` with named-stop guidance and non-one-way fallback assertions. Verify legacy strings still apply to disconnected/loop-close/terminal reversal cases.

**Proof:** The repro has actionable text, unrelated broken legs are not reclassified, and Rust/TypeScript reason names match.

### Step 5 — Automated end-to-end acceptance, screenshot comparison and gates

**Only agent/MCP-driven acceptance; no human sign-off step.** Reuse current test helpers and CI, not a new visual runner.

1. **Browser persistence E2E (real WASM + IndexedDB):** Create Crossroads, mutate budget/road/zone using an existing helper, verify dirty; fast-forward a deterministic Playwright clock beyond 60 seconds (not game time), observe Saved age and clean state, reload, Continue and assert the exact Rust-authored change survived. Verify manual Save Now still persists and no duplicate autosaves occur while clean. Drive the browser with Playwright through MCP and record its result.
2. **Beforeunload and failed-save E2E:** After a user click (browser activation), trigger reload with dirty state, verify the browser-native dialog and cancel it, then verify data remains active. Save, reload without dialog. Simulate a single store failure via the existing test seam (or a narrowly scoped dev-only injection if unavoidable), assert "Couldn't save · Retry" and retained dirty state, click Retry and verify the saved result. Keep the seam limited to tests and avoid new production storage APIs.
3. **First Crossroads line E2E:** Using real WASM and the existing route UI helpers, New City → default Crossroads → bus stops on opposite sides of the east arm → New bus line → Loop → all legs Connected → Save & run → line is active with fleet. Keep the same scenario as the Linear UAT; inspect the gameplay snapshot and UI, not solely labels.
4. **One-way/no-return E2E:** In a newly authored dead-end one-way case (not the repaired default template), assert Stop H → Stop C cannot connect and displays the one-way explanatory text. Create a truly disconnected road case and assert the old generic message. No broader route-editor redesign; HPA-977 owns that.
5. **Mockup screenshot check via MCP/Playwright:** At 1440×900 capture city chip with Saved age, Saving, failed Retry and the failed route panel; compare visually against HPA-976 `t1-autosave-and-one-way-message.png` / annotated HTML `?screen=t1&anno=1`, checking copy, prominence, positioning and absence of overlap. At 1024×768 capture status/Retry/route warning and assert no clipping or hidden button. Store screenshots with normal Playwright artifacts and document differences in this PR.
6. **Tauri-specific E2E via existing MCP bridge:** Launch `bun run tauri:dev` with `mcp-bridge` feature already enabled by dev config. Modify city → close while dirty → relaunch → load → assert saved mutation. Force a representative failed native update through the existing Tauri store/test seam, assert close is prevented and Retry is offered. Browser checks cover all *shared* runtime/UI/core behavior; native close must be verified separately because it is platform-specific.
7. **Full gates on implementation:** Run `bun run check`, `bun run format:check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`. After the implementation is ready, mark this **same PR** ready for review so the current CI executes; confirm TS/Rust/Playwright and macOS + Windows Tauri bundle jobs. Do not count draft-PR skipped checks as passing.

## Acceptance checklist (to complete on the implementation update, not this design-only commit)

- [ ] Autosave ≤60s of dirty play; manual Save and Retry reuse one atomic update, no extra save slot/history
- [ ] Failed autosave preserves dirty and actionable Retry; busy/no-city/clean/disposed cases do not write
- [ ] Native browser prompt only for dirty unload; Tauri close saves or stays open on failure
- [ ] New Crossroads first Loop connects and Save & run creates active line; all four ends work on 3 map sizes
- [ ] One-way no-return reason/copy works with named stops, distinct from disconnected and terminal reversal
- [ ] MCP Playwright browser E2E + screenshot visual comparison to Linear mockup at 1440×900 / 1024×768
- [ ] MCP native Tauri close/relaunch smoke including failed save (platform-specific)
- [ ] Format, static analysis, Rust/unit, real-WASM E2E and required desktop CI jobs green
- [ ] All work retained in **one HPA-976 PR**; no second PR, schema migration, new art or unrelated panel redesign

## Implementation risks to verify early

- Authoring a two-tile `TwoWay` end cap overlays existing `OneWay` endpoints. Check `road.rs::merge_lane_direction` and the refreshed structure count: an unintentional extra automatic junction or lost one-way interior arrow is a failed test, not a reason to remove central validator checks.
- The route finder uses a directed tile × heading graph. A directed search failure does **not** prove why it failed; diagnose only when a one-way/no-return witness exists, especially for a service leg rather than a terminal-reversal leg.
- Tauri 2's `onCloseRequested` awaits its async handler, while browser `beforeunload` cannot wait for IndexedDB. Keep the host-specific paths separate and test the real native window capabilities.
- The existing save gate may skip a simulation tick while writing; don't silently add a second save concurrency model. Measure only if this becomes a visible gameplay issue.

## Explicitly not in this ticket

No persistence rewrite, autosave generations/checkpoints, crash recovery, save migration, generalized U-turn legalization, route-editor dock rewrite (HPA-977), UI polish bundle (HPA-978), new transit marker artwork (HPA-979), or other PR split.
