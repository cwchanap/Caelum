# HPA-976 — Autosave cities and unblock the first Crossroads line — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-976/autosave-cities-and-unblock-the-first-crossroads-line  
**Baseline:** `main` @ `ac3c7d787fc39685b25b795b0ec9fc643ac3bf6b`  
**PR:** [#84](https://github.com/cwchanap/Caelum/pull/84). Implementation, tests and review follow-ups all landed in this **same PR**.  
**Reviewed against:** [design review #5932259897](https://github.com/cwchanap/Caelum/pull/84#pullrequestreview-5932259897).

## Outcome and scope

1. **Autosave:** An active, dirty city updates its *existing* working save approximately once per real-time minute whenever the runtime is safe to save. Manual Save Now stays. Failed saves keep the city dirty and can be retried; there is no queue, additional slot, history or new store method.
2. **City chip:** Match the HPA-976 mockup: **Saved N s/min ago**, **Saving…**, or **Couldn't save · Retry**. This reports the **last successful save time**, not a promise that nothing has changed since then. Do **not** display "Unsaved changes" whenever dirty: a running simulation dirties the city on almost every applied tick and would permanently hide the timestamp.
3. **Leaving:** A dirty browser tab gets the browser-native beforeunload prompt. The native Tauri **window-close** path tries one save; on failure or busy it blocks closing **once**, then allows the next explicit close (with possible loss of unsaved progress). macOS Cmd+Q / app-menu Quit may not trigger window close requests, so autosave is the fallback there, not a guaranteed quit-time save.
4. **Crossroads:** Fresh Crossroads maps contain legal end-turnarounds on all four arms, authored from existing road pieces. Bus loops between stops on the two sides of an arm can connect and Save & run.
5. **One-way failure:** When arrow restrictions, rather than physically disconnected roads, prevent a bus service leg, the route editor offers an actionable one-way warning rather than the generic disconnected message.

Keep the agreed four two-tile `TwoWay` Crossroads caps. Do not introduce universal U-turns, new art, a route-editor redesign (HPA-977), broader HUD polish (HPA-978), asset work (HPA-979), migrations or compatibility code.

**UI reference:** Linear attachment `t1-autosave-and-one-way-message.png` and `uat-fix-mockups.html?screen=t1&anno=1`. The right-dock layout and gameplay HUD already exist; match the chip states, warning placement and legibility with focused visual checks.

## Verified architecture and constraints

- `src/runtime/workingSaveRuntime.ts` owns `activeCity`, one `busy` gate, one `dirty` flag, shared `error`, and `controller.save()`. The save path is `backend.snapshotForSave()` → `CitySaveStore.updateCity()`; successful writes update `CitySummary.savedAt` and clear dirty. The six-method save contract and both IndexedDB/Tauri backends remain unchanged.
- `src/runtime/createGameRuntime.ts` owns the runtime `start()`/`dispose()` lifecycle, `ui.routeDraft`, `ui.drag`, and `activeRoadMutation`. Every applied gameplay tick marks the city dirty. **The existing busy gate drops gameplay inputs and ticks instead of deferring them**, so timer admission must avoid active edits.
- `src/components/Topbar.svelte` and `src/components/hud/panels/CityPanel.svelte` both currently render their own save-label text. They must share one formatter and display the same status, while the panel continues to provide Save Now and other city actions.
- `crates/caelum-core/src/sandbox.rs` creates the Crossroads one-way roads and checks the center 2×2 automatic junction. `road.rs::author_scenario_road_line(..., RoadPreset::TwoWay)` sets overlapping cap endpoints to `one_way = None`, producing a two-connection bend without a new automatic junction; directed-route tests still prove the result.
- `crates/caelum-core/src/network.rs::resolve_route_legs` resolves service legs through the authoritative `RoadTopology`; `road_topology.rs` supplies `find_path_between_access_tiles`. `src/runtime/runtimeSelectors.ts` already provides stop labels for failed rows.
- Tauri 2's `onCloseRequested` invokes `destroy()` after a non-prevented handler. `src-tauri/capabilities/default.json` grants `core:default` only. **`core:window:allow-destroy` is required** ([Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)); do not defer this to testing.

## A. Autosave runtime and UI

### Timer ownership and safety

Use one `setInterval(60_000)` installed in `createGameRuntime.start()`. Clear it in the **existing `stopRuntime()`**, which is already called by `stop()`, fatal teardown and `dispose()`; a later `start()` recreates it. A nullable timer handle prevents duplicate intervals. Do not add a `startAutosave()` abstraction in `WorkingSaveRuntime`, retry scheduler, input queue or new clock service.

The interval calls `workingSave.controller.save()` only when the runtime is live, the active city is dirty, and all of these hold: `!workingSave.isBusy()`, `ui.routeDraft === null`, `ui.drag === null` and `activeRoadMutation === null`. Otherwise skip until the next interval; do not pause simulation.

The existing busy gate **drops** gameplay input and ticks while a save is in flight; it does not defer them. Guarding drafts and gestures protects the most destructive interactions but does not guarantee all isolated clicks during a brief write succeed. Test a representative boundary; no new queue unless a concrete unresolved problem justifies a narrow fix.

### Exactly one transient save state and error ownership

Add `RuntimePersistenceView.save: "idle" | "saving" | "failed"`. Keep one save path, snapshot/store contract and busy gate.

Make `runExclusive` accept one internal channel selector (`"error" | "save"`) so **all** save outcomes, including a thrown `awaitGameplayIdle()` or `work()`, set `save` within the existing `try/catch/finally`, **before** the final `publishIfLive()`. Set `save="saving"` only once a save is admitted; on completion set `"idle"` or `"failed"`, keeping `dirty` on failure. On the `"save"` channel do **not** clear or overwrite generic `error` at the beginning or end. Other mutations keep the existing generic-error behavior. Reset stale save status when active city identity is replaced/cleared. A rejected busy Save does not change status.

The current App `handleSaveCity()` calls `beginPersistenceMutation()`, which clears an unrelated `cityListError` before the save executes. **Remove that call for Save/Retry only**: call `runtime.persistence.save()` directly and refresh cities on success as before; do not hide a "Could not load city list" error on a failed Save. This is separate from the runtime's generic `error`.

Write one pure `src/runtime/saveStatus.ts` helper with signature `saveStatus(view: RuntimePersistenceView, nowMs: number): { label: string; canRetry: boolean }`. The three statuses are **Saving…**, **Couldn't save**, and **Saved N ago**; the chip renders the visual combined **Couldn't save · Retry** with a real button, so the helper must **not** include the word "Retry" in its label. It derives age from `activeCity.savedAt` and does not hide age merely because ticks made the city dirty again.

Keep **one** wall-clock update (~1s) in App and pass the resulting display status to both Topbar and CityPanel, avoiding duplicate formatters. Keep `data-dirty={dirty}` for existing tests and city switch gating. Render **exactly one Retry button, in Topbar only**: retain the existing status `<span class="chip" data-testid="topbar-save-status">` as the container, put a keyboard-focusable `<button type="button">Retry</button>` inside it on failure, and disable it while busy. CityPanel renders identical status **text only** alongside its existing Save Now button; do not create a second Retry button. The Retry invokes App's existing `handleSaveCity`.

### Browser leave versus Tauri close

**Browser:** Register `beforeunload` only in the browser host, using the **current** `runtime.getSnapshot().persistence.dirty` synchronously when the event fires. On dirty, call `preventDefault()` and assign legacy `returnValue` for browser compatibility. Do not write IndexedDB during unload. Real dialogs require prior user activation; unregister on App unmount.

**Tauri:** Add mandatory `core:window:allow-destroy` in `src-tauri/capabilities/default.json`. Register native-only `getCurrentWindow().onCloseRequested(async event => ...)`; it resolves to a **Promise of the unlisten callback**, while Svelte's `onMount` cleanup is synchronous. Guard registration with a local `unmounted` flag: after the Promise resolves, immediately invoke `unlisten()` if teardown already occurred, otherwise retain it for synchronous cleanup. Avoid lingering close handlers after a shell-error teardown.

For a dirty native close, await one existing `runtime.persistence.save()` unless already busy; success/clean state permits close. On the **first** failed or already-busy close, prevent closing; a genuine failed write surfaces Retry, whereas a busy operation keeps the existing busy UI. Allow a **second explicit close** without another save attempt **only if no successful save or city switch occurred between requests**. Store the active city ID and `savedAt` seen when blocking the first close, and compare against the next request: if the active city identity or `savedAt` changed, the escape permission is invalidated and the new dirty state receives a fresh save attempt. Clean state resets it too. This prevents a completed background autosave followed by further edits from accidentally bypassing a new save. No new native command, menu listener, or failure-injection seam.

On macOS, verify Cmd+Q/app-menu Quit via the native MCP bridge and document if it bypasses window-close interception; periodic autosave remains best effort, not crash/OS quit recovery.

## B. Crossroads turnarounds

In `sandbox.rs::create_sandbox_candidate`, author the four existing one-way arterial lines **unchanged**. Before the existing junction refresh/topology compilation, author four two-point `RoadPreset::TwoWay` caps at the paired horizontal-lane ends (west/east bounds) and vertical-lane ends (north/south bounds). Compute positions from the existing `SandboxMapSize` width/height and center; preserve all interior one-way directions.

Continue enforcing the existing central-junction validator, including the single expected structure. Test **directed return connectivity**, not just adjacent road tiles, for all four ends across Small/Medium/Large and a real bus Loop with two roadside stops. Blank Grid and Small Town remain unchanged. These are *new template* changes only: no save migration or snapshot-version bump.

## C. One-way cause via the existing route resolver

Add `LegFailureReason::OneWayNoReturn` / TypeScript `oneWayNoReturn` only for failed **bus service** legs; keep terminal-reversal `NoLegalTurnaround` separate. Do not change successful directed routing or add a new host RPC, road rule, route status or persisted field.

In `network.rs::resolve_route_legs`, resolve normally first. Only if at least one bus service leg failed with `NetworkDisconnected`, clone `snapshot.map` for a **single** diagnostic topology per route-resolution call and:

1. Clear `one_way` on ordinary road tiles **in this clone only**.
2. For each `RoadStructure::Roundabout` in the clone, relax each captured `RoadPort.direction` to `Some(TwoWay)` — the direction capture produces for an unrestricted neighbor — but **only when the port's current neighbor carries an arrow**. This is essential: `RoadTopology::compile` filters ports with `roundabouts::port_matches_current_map`, and a captured inbound/outbound port direction no longer matches an adjoining road after its `one_way` was cleared. A port rejected for reasons unrelated to one-way arrows (a stale capture on a two-way neighbor) keeps its rejected direction so the leg keeps the original failure.
3. Recompile `RoadTopology` on that clone, and rerun the **same** `find_path_between_access_tiles` using the original stop access points/preferences against **the diagnostic map**. A successful relaxed path proves one-way direction rules caused the failed leg; label it `OneWayNoReturn`. A failed compile/search leaves `NetworkDisconnected`. Never apply the diagnostic map or its transitions to gameplay.

Test a simple one-way dead end, a **roundabout adjoining one-way roads**, a physical disconnection that stays disconnected, and an already-valid directed service leg. Include a **loop-closing** failure whose reason must reach the new guidance branch. Roundabout port direction must remain **unchanged in the authoritative map**.

Keep `routeFailureGuidance`'s existing signature and use honest copy: **"One-way roads block this leg. Add a turnaround, a roundabout or a two-way road."** The existing failure row already names the stop pair (e.g., Stop H → Stop C). A diagnosis of arrow causality does not prove a dead end lies specifically *past* Stop H.

## Risks and exclusions

- **Save failure separation:** `runExclusive` must update save status in the same final publication even if awaiting gameplay idle throws. `App.handleSaveCity` must not clear `cityListError` on failed Save/Retry.
- **Input:** The busy gate still drops brief inputs and ticks. Skip autosave during draft/gesture; avoid a new input queue without a reproduced issue.
- **Dirty simulation:** Applied ticks immediately dirty a saved city again. Pause before asserting clean state or no unload prompt; the chip truthfully shows time since last successful save.
- **Diagnostic:** Clearing one-way road arrows alone can disconnect captured roundabout ports; also relax port directions in the **clone**, but only where the current neighbor carries an arrow — relaxing unconditionally revives ports rejected for other reasons and mislabels their failures `OneWayNoReturn`. Never alter real road topology or call the diagnostic on successful paths.
- **Native lifecycle:** Async `onCloseRequested` registration needs teardown-race protection. A second close exits after an unsaved failed/busy close only if no new successful save invalidated that escape. Cmd+Q may bypass window close.
- **Test scope:** Reuse current Rust/unit, real-WASM city-library, route, viewport, and native MCP coverage; add no native fault-injection or screenshot framework.
- No extra save slots, persistence history, migration, general U-turns, HUD redesign, new images, or platform parity matrix.

## Automated acceptance (MCP-run; no human sign-off)

1. **Runtime node tests:** An eligible dirty city autosaves within its next ~60s interval; clean, busy, no active city, route draft, road gesture and disposed/stopped runtime do not write. Restart installs one timer. A failed/throwing save (including `awaitGameplayIdle`) retains dirty, sets `save="failed"` and preserves generic `error`. Retry/next interval works through the same store. App Save/Retry preserves an unrelated `cityListError` on failure.
2. **Real browser/WASM + IndexedDB E2E:** Extend the existing `tests/e2e/cityLibrary.spec.ts` for dirty → pause → autosave → reload → Continue, checking actual Rust-authored city state. Install Playwright clock before navigation only when compatible with the WebGPU rAF loop; if using the **real 60s interval**, call `test.setTimeout(120_000)` for that one test, not globally. After a real user gesture, verify dirty beforeunload dialog; pause and save to verify clean reload without dialog.
3. **Save/Retry UI E2E:** Use a **test-only one-shot** browser patch of `IDBObjectStore.prototype.put` (installed before the relevant save, not a new app hook) to throw for one armed `updateCity` write. Creation uses `add`; enable failure **only after city creation** and restore/de-arm immediately. Verify the real Couldn't save/Retry chip, keyboard-focusable single Topbar Retry, preserved unrelated city-list error, and recovery after Retry. Keep `CityPanel`'s Save Now without a duplicate Retry. Node/jsdom covers the remaining failure branches.
4. **Rust and browser Crossroads:** Verify four directed turnarounds across Small/Medium/Large, and real default Crossroads → roadside stops → Loop Connected → Save & run (WASM). One-way-caused service failure versus physically disconnected fallback and terminal reversal are distinct; include one-way roads adjoining a roundabout in the Rust diagnostic tests.
5. **Mockup visual check:** In the existing `tests/e2e/topbarViewport.spec.ts` (including 1024×768 and 1440×900), assert the new chip wording, dimensions, no clipped Retry button and accessible focus. Capture/compare the composition and right-dock warning with attached HPA-976 `t1-autosave-and-one-way-message.png` through Playwright/MCP; no extra screenshot system. Update the preexisting exact "Saved"/"Unsaved changes" viewport assertions **in the same Step 2 implementation change**, not after they fail.
6. **Native-only MCP smoke:** With the existing Tauri dev MCP bridge, dirty window-close → relaunch → persisted city, Cmd+Q/app-menu Quit behavior. Mocked UI tests cover asynchronous listener unmount, first-blocked close, second-close escape, and invalidation after a completed autosave followed by new dirty edits. No native fault injection.
7. **Gates:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `bun run check`, `bun run format:check`, `bun run lint`, `bun run test:unit`, `bun run test:e2e`, and existing native bundles in non-draft CI — all green on the current head.

All acceptance is automated via MCP/test tooling; no human acceptance step or second implementation PR.
