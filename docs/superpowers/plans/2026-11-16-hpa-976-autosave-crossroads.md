# HPA-976 — Autosave cities and Crossroads first-line fix — Implementation plan

**Design:** [2026-11-16-hpa-976-autosave-crossroads-design.md](../specs/2026-11-16-hpa-976-autosave-crossroads-design.md)  
**Linear:** https://linear.app/cwchanap/issue/HPA-976/autosave-cities-and-unblock-the-first-crossroads-line  
**Base:** `main` @ `ac3c7d787fc39685b25b795b0ec9fc643ac3bf6b`  
**PR policy:** **Exactly one PR for this ticket, [#84](https://github.com/cwchanap/Caelum/pull/84)**. This remains a **planning-only draft**: add all implementation, tests, visual evidence, and review adjustments on this same branch. Do not open an implementation follow-up PR. No new art or SFX task is necessary.

**Review changes:** Responds to [design review #5932259897](https://github.com/cwchanap/Caelum/pull/84#pullrequestreview-5932259897). Seven findings are incorporated: truthful chip during running ticks, guard against destructive busy-gate input loss, preserve non-save errors, share status formatting, required Tauri destroy permission + second-close escape, arrow-relaxed routing diagnosis, and reuse of existing automated tests.

## File ownership / implementation order

| Step | Primary existing files | Goal |
| --- | --- | --- |
| 1 | `src/runtime/createGameRuntime.ts`, `src/runtime/workingSaveRuntime.ts`, `tests/runtime/citySaveRuntime.test.ts`, `tests/runtime/workingSaveRuntime.test.ts` | One timer, guarded admission, one save status, separate error channel |
| 2 | `src/runtime/saveStatus.ts` (small new pure helper), `src/App.svelte`, `src/components/Topbar.svelte`, `src/components/hud/panels/CityPanel.svelte`, `src-tauri/capabilities/default.json`, existing UI tests | Shared label/Retry, browser prompt, safe native close |
| 3 | `crates/caelum-core/src/sandbox.rs`, existing Rust template/route tests | Four Crossroads end caps with real directed return |
| 4 | `crates/caelum-core/src/network.rs`, `crates/caelum-core/src/model.rs`, `src/domain/types.ts`, `src/runtime/rejectionMessages.ts`, existing Rust/TS tests | One-way cause without a new routing system |
| 5 | Existing `tests/e2e/cityLibrary.spec.ts`, `routes.spec.ts`, `topbarViewport.spec.ts`, Tauri dev MCP bridge and CI | Automated full-player flow and mockup visual check |

Touch other files only when a required TypeScript literal or current test helper must be updated. Preserve the six-operation CitySaveStore, thin WASM/native gameplay hosts, save format, core routing success path and existing dock layout.

## Step 1 — Tests first: eligible autosave with the current busy gate

1. In `tests/runtime/citySaveRuntime.test.ts`, reuse the **real `createGameRuntime`** test fixture and existing `tests/runtime/delayedCitySaveStore.ts` for controlled in-flight writes. With Vitest fake timers, cover:
   - only the first **eligible** 60s tick writes a dirty active city and updates `savedAt`;
   - clean/no-city/busy/disposed states do not write;
   - `ui.routeDraft`, `ui.drag`, or `activeRoadMutation` present at the interval cause a **skip**, not a queued save; a later eligible interval writes;
   - repeated `start()` calls do not install duplicate intervals; `dispose()` and fatal teardown clear it;
   - an in-flight autosave still uses the single gate, with no overlapping store updates.
2. Implement a **single** `setInterval(60_000)` in `createGameRuntime.start()`, one nullable handle, and clear it in `dispose()`/fatal teardown. On each interval, check runtime live, active city, dirty, !busy, and no route draft/road gesture. Call `void workingSave.controller.save()` using existing busy protection; no extra `startAutosave()` method, generic scheduler, save queue or retry timeout.
3. In `tests/runtime/workingSaveRuntime.test.ts`, focus on save status and errors: initial `save="idle"`, admitted Save sets `"saving"`, success resets idle and dirty false, failed write sets `"failed"` without clearing dirty; next manual Retry or next timer save succeeds. **Manual/autosave must leave existing shared `error` untouched**, including the start-time clearing that `runExclusive` currently performs. Unrelated load/create/rename/delete still use the original error behavior. If Save is rejected as already busy, do not publish a false "saving" state.
4. Add exactly one `RuntimePersistenceView.save: "idle" | "saving" | "failed"` discriminant (not `saving` and `saveFailed` booleans). Make `runExclusive` preserve the generic error when invoked by `save()`—for example a focused `reportError` option—rather than duplicating its critical section. Reset stale save status when activating/deleting a city. Preserve existing write-failure semantics, id and snapshot stores.
5. **Explicit limitation:** The existing gate **drops** inputs/ticks while a save is busy. The draft/gesture guards prevent the highest-risk cases, but may not eliminate every click collision. Do not claim the input is deferred. Test a normal input around the save boundary; fix a reproduced residual loss narrowly on this PR rather than adding a new input queue.

**Proof:** Red→green runtime tests for dirty autosave, failed save and Retry, busy-skip/draft-skip/gesture-skip, single timer/dispose and independence of the generic error.

## Step 2 — One shared status, browser unload and safe Tauri close

1. Add `src/runtime/saveStatus.ts` as a **pure** `saveStatus(view, nowMs) -> { label, canRetry }` function with order **Saving… > Couldn't save · Retry > Saved N ago**. Use the existing `activeCity.savedAt`; the live tick's dirty bit affects autosave and unload, **not the chip label**. Test elapsed seconds/minutes, pending dirty after a successful save, failure, and saving under an unrelated city-operation error in a focused node Vitest unit.
2. In `App.svelte`, keep **one** small wall-time tick (~1s) and derive the status once. Pass the same result to both `Topbar.svelte` and `CityPanel.svelte`, which currently have duplicate status labels. Preserve `topbar-save-status`, `city-save-status`, manual Save Now, and CityPanel's dirty New City/Load gating. Provide a single accessible **Retry** button in the chip on failure, disabled while busy and calling the existing `handleSaveCity()`. Do not create a shared Svelte component just to render this short text.
3. Browser host: in App's mount lifecycle, register `beforeunload` only when `!isTauriRuntime()`; check the **current** `runtime.getSnapshot().persistence.dirty` synchronously, call `preventDefault()` plus legacy `returnValue` if dirty, remove listener on unmount. Do not write IndexedDB on unload. Exercise the browser-native dialog in Playwright after a real user gesture.
4. Tauri: change `src-tauri/capabilities/default.json` to include **`core:window:allow-destroy`**, needed because `onCloseRequested` destroys a window after the listener returns without prevention. Register native-only `getCurrentWindow().onCloseRequested` in App; a dirty close attempts one `runtime.persistence.save()`. Success/clean → close; first failed or already-busy attempt → prevent close and expose the existing status/Save Now; **second explicit close → exit even dirty**, using one local escape flag. Clear that flag on clean/successful save, clean up listener on unmount, and avoid native commands/dialog plugins.
5. In `tests/ui/appShell.test.ts`, update formerly expected "Working…" / "Unsaved changes" labels to shared Saved-time/Saving/failed states. Verify both Topbar and CityPanel show the same status; Retry triggers the existing controller and clears failure; dirty-only browser unload; mocked native close first-block/second-close escape and clean success. No new native store fault injection. Preserve all existing city-management, keyboard, screen switch and focus tests.

**Proof:** Real Save Now remains intact; the two status areas cannot disagree; non-save errors remain visible; browser dirty prompt and native first/second close act as designed.

## Step 3 — Rust Crossroads return paths (no general U-turn)

1. Extend the Crossroads branch in `sandbox.rs::create_sandbox_candidate` **after** the existing four one-way lines, **before** `refresh_all_automatic_junctions`. Add four two-point `author_scenario_road_line(..., RoadPreset::TwoWay)` caps at west/east x-bounds and north/south y-bounds, joining each paired lane. Calculate coordinates from existing map-size dimensions and center. Do not rewrite the arterial lines.
2. Keep the existing `validate_crossroads_candidate` center structure, ports and transitions intact. `road.rs::merge_lane_direction(None)` should turn only the four ends into ordinary two-way bends with no additional automatic structures; assert this rather than removing the validator's structure-count check. Also assert interior tiles retain their directed one-way values.
3. In existing Rust sandbox and route tests, prove directed return connectivity for four arm ends across Small/Medium/Large; for a representative east-arm pair place roadside bus stops and resolve a real **Loop** (both service legs Connected). Retain existing negative template-validator cases and Blank Grid/Small Town behavior.
4. Snapshot shape and version remain unchanged; old saved maps are neither rebuilt nor migrated.

**Proof:** A fresh default Crossroads can Save & run a first bus loop without a separately constructed ring road.

## Step 4 — One-way diagnosis in `network.rs`, not a new pathfinder

1. Write Rust tests first for a bus service leg that currently fails with `NetworkDisconnected` but succeeds with the same endpoint access **when arrow restrictions are relaxed**. Pin the **loop-closing leg**, which otherwise falls into generic loop failure wording. Include a physically disconnected negative case; keep terminal-reversal `NoLegalTurnaround`, no-access, and already-connected cases intact.
2. Add `LegFailureReason::OneWayNoReturn` in `model.rs` (serde `oneWayNoReturn`) and the existing TS union in `src/domain/types.ts`. No new route status, host API or persisted snapshot field.
3. In `network.rs::resolve_route_legs` let the existing directed `resolve_service_path` run first. **Only if** one or more **bus service** paths fail with `NetworkDisconnected`, clone the map, clear `one_way` on ordinary road tiles, compile one alternate `RoadTopology` for **that route resolution**, and rerun the **same** `find_path_between_access_tiles` using each failed leg's unchanged stop access points/preferences. Success of this diagnostic means directions caused the failure → replace that failure reason with `OneWayNoReturn`. Failure/compile error → keep `NetworkDisconnected`. Never use this topology for valid routes, gameplay or road rules.
4. In `src/runtime/rejectionMessages.ts::routeFailureGuidance`, keep its current signature and return for `oneWayNoReturn`: **"One-way roads block this leg. Add a turnaround, a roundabout or a two-way road."** The existing failure-row heading already displays the specific stops (e.g. Stop H → Stop C); a message claiming the dead end is *past Stop H* is not supported by this diagnosis. Check this case **before** the `networkDisconnected && isLoopClosing` fallback. No extra data passed through `runtimeSelectors.ts`.
5. Extend `tests/runtime/rejectionMessages.test.ts` and `runtimeSelectors.test.ts` only as needed: correct specific warning for the loop-closing leg, generic fallback for physical disconnection, existing heading/turnaround guidance intact.

**Proof:** A real one-way-caused failure has actionable text, while a missing road remains an ordinary disconnected error; unchanged successful routing.

## Step 5 — Existing E2E specs, MCP visual check and final gates

**Acceptance is agent/MCP-driven; no human approval criterion. No new E2E file/test service or native fault-injection surface.**

1. **Autosave → reload → Continue (browser, real WASM+IndexedDB):** Extend `tests/e2e/cityLibrary.spec.ts`'s existing Save Now/reload journey. Create and modify a city, **pause**, wait/advance one eligible 60s autosave, check the chip and `savedAt`, reload/Continue and assert actual saved Rust map/budget/time. To avoid WebGPU race issues, install Playwright `page.clock` **before navigation** if using the fake clock; it also affects `requestAnimationFrame` and `performance.now`. If that breaks WebGPU, use one bounded genuine ~60s E2E run rather than dropping the real autosave end-to-end acceptance or adding new production timer parameters. Assert clean/no-extra-write while paused; running ticks legitimately dirty again.
2. **Unload/Retry coverage:** In the same existing city flow, a user gesture → dirty state → reload attempt triggers browser-native beforeunload; cancel and ensure gameplay remains. Pause + Save Now → no prompt. Fail/Retry should be covered through existing memory/delayed-store runtime tests and mocked UI, not a dev-only IndexedDB injection API. Verify the real chip button is keyboard-focusable in the viewport E2E.
3. **First bus loop:** Extend `tests/e2e/routes.spec.ts`: default Crossroads → stops beside opposite directions of the east arm → Loop preview all legs Connected → Save & run → real Rust/WASM route active with fleet. No new route editor or mock state.
4. **One-way error:** In existing Rust and TS route tests prove arrows-only failure, physically disconnected fallback and loop-closing warning. If an existing browser route scenario can assert the new copy without building extra world fixture, extend it; avoid an E2E-only mega-fixture.
5. **Visual acceptance against Linear mockup:** Extend `tests/e2e/topbarViewport.spec.ts`, which already checks **1024×768 and 1440×900**, to exercise Saved-age, Saving, and Couldn't save/Retry states and assert no overlap, clipping or hidden controls. Capture screenshots with its existing Playwright/MCP artifact flow; compare the chip arrangement and the failed-leg dock warning layout to the attached HPA-976 **`t1-autosave-and-one-way-message.png`**, documenting any meaningful differences. Do not add a standalone pixel-golden screenshot suite or a separate manual visual pass.
6. **Native-only MCP smoke:** Use the existing `bun run tauri:dev` / `mcp-bridge` host: dirty city → window close → relaunch → load and confirm the saved change. Check on macOS whether Cmd+Q / app-menu Quit bypasses `onCloseRequested`; document observed behavior and the 60s best-effort limit. First-failed/busy-close and second-close escape are automated in the mocked UI tests, **not** by creating a native store injection seam.
7. **Full gates on the implemented PR:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `bun run check`, `bun run format:check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, and relevant macOS/Windows Tauri bundle CI jobs. This **draft PR skips CI**; once implementation is complete, mark **this same PR** ready so those jobs execute. Do not claim any passing checks for the planning-only commit.

## Acceptance checklist — remains incomplete until implementation

- [ ] One timer; eligible dirty city automatically saves around 60s, manual Save intact, no new save format/queue/history
- [ ] Busy, no-city, clean, disposed, draft and road-gesture guards; no overlap; known busy-gate input dropping called out and tested
- [ ] Failed Save retains dirty, shared error untouched, Retry succeeds; pure shared saveStatus shows Saved-age/Saving/failed even during live simulation
- [ ] Browser dirty beforeunload prompts after user activation; clean reload does not
- [ ] Native `core:window:allow-destroy`, dirty close saves, failure/busy blocks once then second close exits; Cmd+Q limitation recorded via MCP
- [ ] All four Crossroads turnarounds valid for three map sizes, default Loop Connected and Save & run verified
- [ ] Arrow-caused `OneWayNoReturn` vs physically disconnected and terminal-reversal reasons; accurate one-way copy shown
- [ ] Existing city/route Playwright real-WASM/IndexedDB E2E via MCP and **mockup visual screenshot check** at 1024×768 / 1440×900
- [ ] Rust, TS, Playwright and native bundle CI gates pass when ready for review
- [ ] No extra PR, new assets, generalized routing/persistence framework, or compatibility migration

## Risks and implementation guardrails

- **Do not let autosave erase a CityPanel error:** opt `save()` out of shared `runExclusive` error mutations, including before the async work begins.
- **No false "Saved" guarantee:** the label records when the working save was last written; active ticks may already have dirtied the current state again. Pause before clean-state assertions.
- **No pretend input deferral:** the current busy gate drops clicks/dispatches; the timer skips route drafts, drag and road mutation. If residual interactive loss is reproducible, resolve it narrowly without a queue.
- **TwoWay caps:** prove road connections and arrows with actual compiled topology while keeping the existing center validator.
- **OneWay diagnosis:** the relaxed map should prove only arrow restrictions, not the location of a dead end. Compile once only on failure and keep real topology authority.
- **Native close:** Tauri 2 `onCloseRequested` requires `allow-destroy`. Second-close exit is deliberate when saving fails; native quit paths may skip window close requests. Never promise more than best-effort autosave.
