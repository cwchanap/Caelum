# HPA-976 — Autosave cities and unblock the first Crossroads line — Design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-976/autosave-cities-and-unblock-the-first-crossroads-line  
**Baseline:** `main` @ `ac3c7d787fc39685b25b795b0ec9fc643ac3bf6b`  
**PR:** [#84](https://github.com/cwchanap/Caelum/pull/84). This draft is **documentation-only**; all implementation, tests and review follow-ups belong to this **same PR**.  
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

Use one `setInterval(60_000)` in `createGameRuntime.start()` and clear it in `dispose()` / fatal teardown. Keep a nullable timer handle to make repeated `start()` harmless; no `startAutosave()` abstraction in `WorkingSaveRuntime`, retry scheduler, queue or new clock service.

The interval calls the existing `workingSave.controller.save()` **only when** all conditions hold:

- runtime is live and has an active city with `dirty === true`;
- `workingSave.isBusy() === false`;
- `ui.routeDraft === null`, `ui.drag === null` and `activeRoadMutation === null`.

Otherwise skip and retry on the next minute. Do not change the gameplay paused flag. Because the save still uses the existing gate, ordinary clicks and ticks could be dropped **during a brief in-flight save** even after these draft/gesture guards. Do **not** claim inputs are deferred or that the game never loses a click; protect the destructive interactions above and check normal input during acceptance. Only add a narrower additional fix on this PR if a remaining input-loss scenario is reproducible; no generic input queue.

### Exactly one transient save state and error ownership

Add `RuntimePersistenceView.save: "idle" | "saving" | "failed"`. Only an **admitted** Save/Retry/autosave sets saving; completion sets idle on success or failed on error, leaving dirty on error. New active-city replacement/clearing resets the status. Unrelated busy work should not appear as saving or clear a failed save.

Reuse the existing `runExclusive` critical section but **opt save out of shared `error` publication** (including the start-time reset): manual and automatic Save must neither clear an unrelated Create/Load/Rename/Delete error nor publish the save failure as a repeated CityPanel alert. The save failure is represented by `save === "failed"` and the chip/Retry. Other persistence operations keep current error behavior. Preserve `CitySaveStore`, save format and no-overlap rules.

Write one pure `src/runtime/saveStatus.ts` helper:

```ts
saveStatus(view: RuntimePersistenceView, nowMs: number):
  { label: string; canRetry: boolean }
```

Order: **saving → failed (Retry) → Saved N ago**, using `view.activeCity.savedAt`. Hide the dirty indicator from the label, not from save gating. Keep one small wall-clock ticker in `App.svelte`, pass the same computed status to Topbar and CityPanel (no duplicated clocks/formatters; preserve existing test IDs). Provide one accessible Retry action wired to the existing `handleSaveCity()`, disabled while busy. Keep Save Now and city-list refresh.

### Browser leave versus Tauri close

**Browser:** Register `beforeunload` only when not running under Tauri, in App mount. Read `runtime.getSnapshot().persistence.dirty` synchronously at the event; when dirty, call `preventDefault()` and set `event.returnValue` for browser compatibility. Do not attempt asynchronous IndexedDB writes during unload. Browser confirmation requires prior user activation and uses browser-controlled wording. Unregister on teardown.

**Tauri:** Grant `core:window:allow-destroy` in `src-tauri/capabilities/default.json`. Register `getCurrentWindow().onCloseRequested(async event => ...)` for the native host only and clean up the listener. If currently clean, allow closure. If dirty and not already busy, await one existing `runtime.persistence.save()`, then allow closure on success. On **first** failed/busy close, `event.preventDefault()`; a real failed save shows the Retry state, while an already-busy operation leaves the normal busy UI. Track **one local escape flag**: a **second** explicit close after the failed/busy attempt proceeds even while dirty (possible data loss). Reset the flag after a successful save/clean state. Do not add a Rust command, native dialogs, multi-window logic, or a native failure-injection API.

On macOS, separately verify whether Cmd+Q and app-menu Quit bypass `onCloseRequested`; if they do, record the limitation and rely on best-effort periodic autosave rather than adding `ExitRequested`/menu interception.

## B. Crossroads turnarounds

In `sandbox.rs::create_sandbox_candidate`, author the four existing one-way arterial lines **unchanged**. Before the existing junction refresh/topology compilation, author four two-point `RoadPreset::TwoWay` caps at the paired horizontal-lane ends (west/east bounds) and vertical-lane ends (north/south bounds). Compute positions from the existing `SandboxMapSize` width/height and center; preserve all interior one-way directions.

Continue enforcing the existing central-junction validator, including the single expected structure. Test **directed return connectivity**, not just adjacent road tiles, for all four ends across Small/Medium/Large and a real bus Loop with two roadside stops. Blank Grid and Small Town remain unchanged. These are *new template* changes only: no save migration or snapshot-version bump.

## C. One-way cause via the existing route resolver

Add `LegFailureReason::OneWayNoReturn` / TypeScript `oneWayNoReturn`, only for failed **bus service** legs, not terminal-reversal `NoLegalTurnaround`. No host contract or persisted field changes.

In `network.rs::resolve_route_legs`, run the current directed service-leg resolution first. **Only if** one or more bus service legs return `NetworkDisconnected`, clone the map, clear `one_way` on ordinary road tiles, compile a **single** diagnostic `RoadTopology` for that route-resolution call, and rerun the same pathfinder between the same stop access points on those failed legs. If the relaxed path succeeds, direction restrictions are the cause and the reason becomes `OneWayNoReturn`; if the diagnostic compile or path fails, retain `NetworkDisconnected`. Normal routing still uses the original topology; do not add a separate road-shape walker or allow real U-turns.

This proves **one-way-arrow causality**, not that a dead end is specifically past the leg's origin. Keep `routeFailureGuidance`'s current signature and provide accurate generic guidance: **"One-way roads block this leg. Add a turnaround, a roundabout or a two-way road."** The current failure row already displays `Stop H → Stop C`. Ensure this new reason beats the existing generic **loop-closing** wording; physically disconnected roads and other typed failures retain their messages.

## Risks and exclusions

- Running ticks immediately dirty a newly saved city again. Pause before tests that assert clean state/no unload prompt. The chip shows **last save time**, not "everything is saved".
- The existing busy gate can still skip a brief normal click during the write. Do not describe autosave as queueing/deferred gameplay; guard road gestures and route drafts, then test the real player path.
- The arrow-relaxed map is **diagnostic only**, built once per failing route resolution; don't turn it into a new gameplay pathfinder.
- The second native close intentionally allows exit after storage failure; macOS Cmd+Q may bypass close-request entirely. No absolute crash/quit recovery guarantee.
- No save history, extra slots, migration/backcompat, generic U-turn rules, nonessential native APIs, new artwork, panel redesign, or elaborate visual testing infrastructure.

## Automated acceptance (MCP-run; no human sign-off)

1. **Runtime unit tests:** A dirty active city automatically saves by its next eligible 60s interval; clean/busy/disposed/no-city/draft/gesture states do not write. Failed writes retain dirty and set `save="failed"`; Retry or next eligible interval succeeds through the same store. Assert manual Save, unchanged unrelated `error`, accurate shared saveStatus output and no duplicated timer.
2. **Browser real-WASM + IndexedDB E2E:** Extend existing `tests/e2e/cityLibrary.spec.ts` to build and modify a city, **pause**, trigger an eligible autosave, reload/Continue and check the Rust-derived saved change. Check dirty beforeunload prompt after user activation, and clean reload after pause+Save. Use Playwright clock **installed before navigation** if it works with the WebGPU rAF loop; otherwise use a single real-time 60s run within that existing E2E (no new production timing API). Drive through MCP.
3. **Crossroads Rust + browser E2E:** Directed turnarounds for all four ends and three map sizes; default Crossroads → two roadside stops on an arm → Loop Connected → Save & run deploys the real bus route. Extend current Rust route tests and `tests/e2e/routes.spec.ts`.
4. **Failure reason and message:** In Rust, a failing directed bus leg that connects with arrows cleared receives `OneWayNoReturn`, including a loop-closing leg; physically disconnected legs remain `NetworkDisconnected`, and terminal reversals keep their reason. Assert the specific warning text through the existing UI.
5. **Visual check against the Linear mockup:** Extend existing `tests/e2e/topbarViewport.spec.ts` (1024×768 and 1440×900) to capture the three save-chip states and verify legibility, Retry clickability and no clipping/overlap. Use screenshots produced by Playwright/MCP to **compare the composition and warning placement with the attached HPA-976 mockup**, documenting meaningful deviations; no separate screenshot suite.
6. **Native-specific MCP smoke:** In the existing Tauri dev MCP bridge, exercise dirty window close → relaunch → saved changes present, and check Cmd+Q/app-menu Quit behavior. Cover failed/busy/second-close escape in the existing mocked-module UI tests; **no native fault-injection seam**.
7. **Implementation gates:** Rust fmt/clippy/tests, Bun formatting/lint/type/unit, real-browser Playwright and macOS/Windows Tauri CI once this PR is ready for review. Draft checks are skipped and are **not** claimed green. Shared behavior needs one browser platform's E2E; platform-specific close uses Tauri.
